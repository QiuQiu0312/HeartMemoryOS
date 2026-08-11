import { AdapterError, RuntimeInvariantError } from "./errors.js";
import { assertScope, clone, contentDigest, estimateTokens, hashText, newId, scopeKey } from "./utils.js";

function withTimeout(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("adapter timeout")), timeoutMs);
  const abort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abort);
    },
  };
}

async function responseJson(response, adapter) {
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new AdapterError(adapter, "provider returned non-JSON", { status: response.status });
  }
  if (!response.ok) {
    const error = new AdapterError(adapter, data?.error?.message ?? `HTTP ${response.status}`, {
      status: response.status,
      type: data?.error?.type,
    });
    error.status = response.status;
    error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw error;
  }
  return data;
}

export class OpenAICompatibleModelAdapter {
  constructor({ baseUrl, apiKey, model, fetchImpl = globalThis.fetch, timeoutMs = 30_000, headers = {} }) {
    if (!baseUrl || !model || typeof fetchImpl !== "function") {
      throw new RuntimeInvariantError("OpenAI-compatible model requires baseUrl, model, and fetch");
    }
    this.name = "openai-compatible-model";
    this.baseUrl = String(baseUrl).replace(/\/$/u, "");
    this.apiKey = apiKey;
    this.model = model;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.headers = headers;
  }

  async complete({ messages, temperature = 0, maxOutputTokens = 1_000, responseFormat, signal }) {
    const timeout = withTimeout(this.timeoutMs, signal);
    try {
      const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          ...this.headers,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature,
          max_tokens: maxOutputTokens,
          ...(responseFormat ? { response_format: responseFormat } : {}),
        }),
        signal: timeout.signal,
      });
      const data = await responseJson(response, this.name);
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new AdapterError(this.name, "missing assistant content");
      return {
        text,
        model: data.model ?? this.model,
        finishReason: data.choices?.[0]?.finish_reason ?? null,
        usage: {
          inputTokens: data.usage?.prompt_tokens,
          outputTokens: data.usage?.completion_tokens,
          totalTokens: data.usage?.total_tokens,
        },
        providerRequestId: response.headers.get("x-request-id") ?? data.id ?? null,
      };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      const wrapped = new AdapterError(this.name, error?.name === "AbortError" ? "request timed out" : error?.message);
      wrapped.retryable = true;
      throw wrapped;
    } finally {
      timeout.dispose();
    }
  }
}

export class OpenAICompatibleEmbeddingAdapter {
  constructor({ baseUrl, apiKey, model, dimensions, fetchImpl = globalThis.fetch, timeoutMs = 20_000, headers = {} }) {
    if (!baseUrl || !model || typeof fetchImpl !== "function") {
      throw new RuntimeInvariantError("OpenAI-compatible embedding requires baseUrl, model, and fetch");
    }
    this.name = "openai-compatible-embedding";
    this.baseUrl = String(baseUrl).replace(/\/$/u, "");
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.headers = headers;
  }

  async embed({ input, signal }) {
    const timeout = withTimeout(this.timeoutMs, signal);
    try {
      const response = await this.fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          ...this.headers,
        },
        body: JSON.stringify({
          model: this.model,
          input,
          ...(this.dimensions ? { dimensions: this.dimensions } : {}),
        }),
        signal: timeout.signal,
      });
      const data = await responseJson(response, this.name);
      return {
        vectors: (data.data ?? []).sort((a, b) => a.index - b.index).map((item) => item.embedding),
        model: data.model ?? this.model,
        usage: { inputTokens: data.usage?.prompt_tokens ?? data.usage?.total_tokens },
      };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      const wrapped = new AdapterError(this.name, error?.name === "AbortError" ? "request timed out" : error?.message);
      wrapped.retryable = true;
      throw wrapped;
    } finally {
      timeout.dispose();
    }
  }
}

export class MockModelAdapter {
  constructor({ responses = [], handler, model = "mock-model" } = {}) {
    this.name = "mock-model";
    this.model = model;
    this.responses = [...responses];
    this.handler = handler;
    this.calls = [];
  }

  async complete(request) {
    this.calls.push(clone(request));
    const value = this.handler ? await this.handler(request, this.calls.length) : this.responses.shift();
    if (value instanceof Error) throw value;
    const text = typeof value === "string" ? value : JSON.stringify(value ?? { schemaVersion: 2 });
    return {
      text,
      model: this.model,
      usage: {
        inputTokens: (request.messages ?? []).reduce((sum, item) => sum + estimateTokens(item.content), 0),
        outputTokens: estimateTokens(text),
      },
    };
  }
}

export class MockEmbeddingAdapter {
  constructor({ dimensions = 8 } = {}) {
    this.name = "mock-embedding";
    this.model = "mock-embedding";
    this.dimensions = dimensions;
    this.calls = [];
  }

  async embed({ input }) {
    const values = Array.isArray(input) ? input : [input];
    this.calls.push(clone(values));
    const vectors = values.map((value) => {
      const digest = Buffer.from(contentDigest(value), "hex");
      const vector = Array.from({ length: this.dimensions }, (_, index) => (digest[index] - 127.5) / 127.5);
      const norm = Math.hypot(...vector) || 1;
      return vector.map((item) => item / norm);
    });
    return { vectors, model: this.model, usage: { inputTokens: values.reduce((s, v) => s + estimateTokens(v), 0) } };
  }
}

export class MockDeliveryProvider {
  constructor({ handler } = {}) {
    this.name = "mock-delivery";
    this.calls = [];
    this.handler = handler;
  }

  async send(request) {
    this.calls.push(clone(request));
    if (this.handler) return this.handler(request, this.calls.length);
    return { accepted: true, providerMessageId: newId("mock_message"), status: "accepted" };
  }
}

export class ProviderRegistry {
  constructor(providers = {}) {
    this.providers = new Map(Object.entries(providers));
  }

  register(name, provider) {
    if (!name || typeof provider?.send !== "function") throw new RuntimeInvariantError("provider.send is required");
    this.providers.set(name, provider);
    return this;
  }

  get(name) {
    const provider = this.providers.get(name);
    if (!provider) throw new AdapterError("delivery", `unknown provider ${name}`);
    return provider;
  }
}

/**
 * Optional external-memory mirror. It never becomes the authority: callers
 * must revalidate returned ids against their canonical repository. A unique,
 * scope-derived namespace prevents the shared-default-container bugs common in
 * third-party memory SDK examples.
 */
export class ScopedMemoryProviderAdapter {
  constructor({ client, namespacePrefix = "heartmemory-v2", namespaceKey = "local-development-key" }) {
    if (!client || !["upsert", "search", "remove"].every((method) => typeof client[method] === "function")) {
      throw new RuntimeInvariantError("external memory client requires upsert, search, and remove");
    }
    this.client = client;
    this.namespacePrefix = namespacePrefix;
    this.namespaceKey = namespaceKey;
  }

  namespace(scope) {
    assertScope(scope);
    return `${this.namespacePrefix}:${hashText(`${this.namespaceKey}:${scopeKey(scope)}`).slice(0, 32)}`;
  }

  upsert({ scope, record, idempotencyKey }) {
    assertScope(scope);
    if (!record?.id || !idempotencyKey) throw new RuntimeInvariantError("record.id and idempotencyKey are required");
    return this.client.upsert({ namespace: this.namespace(scope), record: clone(record), idempotencyKey });
  }

  search({ scope, query, limit = 8 }) {
    assertScope(scope);
    return this.client.search({ namespace: this.namespace(scope), query: String(query ?? ""), limit: Math.min(20, Math.max(1, Number(limit))) });
  }

  remove({ scope, recordId, idempotencyKey }) {
    assertScope(scope);
    if (!recordId || !idempotencyKey) throw new RuntimeInvariantError("recordId and idempotencyKey are required");
    return this.client.remove({ namespace: this.namespace(scope), recordId, idempotencyKey });
  }
}

export class MockMemoryProviderClient {
  constructor() {
    this.namespaces = new Map();
    this.calls = [];
  }

  async upsert(request) {
    this.calls.push(clone({ operation: "upsert", ...request }));
    const records = this.namespaces.get(request.namespace) ?? new Map();
    records.set(request.record.id, clone(request.record));
    this.namespaces.set(request.namespace, records);
    return { accepted: true, externalId: request.record.id };
  }

  async search(request) {
    this.calls.push(clone({ operation: "search", ...request }));
    const records = [...(this.namespaces.get(request.namespace)?.values() ?? [])];
    const needle = request.query.toLocaleLowerCase();
    return records
      .filter((record) => JSON.stringify(record).toLocaleLowerCase().includes(needle))
      .slice(0, request.limit)
      .map((record) => clone(record));
  }

  async remove(request) {
    this.calls.push(clone({ operation: "remove", ...request }));
    return { removed: this.namespaces.get(request.namespace)?.delete(request.recordId) ?? false };
  }
}
