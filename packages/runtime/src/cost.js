import { BudgetExceededError, RuntimeInvariantError } from "./errors.js";
import { estimateTokens, iso, scopeKey } from "./utils.js";
import { normalizeHooks } from "./telemetry.js";

function utcDay(now) {
  return iso(now).slice(0, 10);
}

export class CostBudget {
  constructor({
    clock = () => Date.now(),
    dailyTokenLimit = 250_000,
    perCallInputLimit = 24_000,
    perCallOutputLimit = 4_000,
  } = {}) {
    this.clock = clock;
    this.dailyTokenLimit = dailyTokenLimit;
    this.perCallInputLimit = perCallInputLimit;
    this.perCallOutputLimit = perCallOutputLimit;
    this.buckets = new Map();
  }

  assertCall({ scope, inputTokens, maxOutputTokens = 0, operation = "model" }) {
    if (inputTokens > this.perCallInputLimit) {
      throw new BudgetExceededError(`${operation}:input`, this.perCallInputLimit, inputTokens);
    }
    if (maxOutputTokens > this.perCallOutputLimit) {
      throw new BudgetExceededError(`${operation}:output`, this.perCallOutputLimit, maxOutputTokens);
    }
    const key = `${scope ? scopeKey(scope) : "global"}:${utcDay(this.clock())}`;
    const current = this.buckets.get(key) ?? 0;
    const attempted = current + inputTokens + maxOutputTokens;
    if (attempted > this.dailyTokenLimit) {
      throw new BudgetExceededError(key, this.dailyTokenLimit, attempted);
    }
    // Reserve synchronously so concurrent calls cannot all pass against the
    // same stale counter. Failed provider calls keep the conservative reserve.
    this.buckets.set(key, attempted);
    return { key, reserved: inputTokens + maxOutputTokens };
  }

  commit(reservation, actualTokens) {
    if (!reservation) return;
    const current = this.buckets.get(reservation.key) ?? 0;
    this.buckets.set(
      reservation.key,
      Math.max(0, current - reservation.reserved + Math.max(0, Number(actualTokens ?? reservation.reserved))),
    );
  }
}

export function estimateMessageTokens(messages) {
  if (!Array.isArray(messages)) throw new RuntimeInvariantError("messages must be an array");
  return messages.reduce((sum, message) => sum + 4 + estimateTokens(message?.content), 2);
}

export function createMeteredModelAdapter({ adapter, hooks, budget = new CostBudget(), pricing = {} }) {
  if (!adapter || typeof adapter.complete !== "function") {
    throw new RuntimeInvariantError("model adapter.complete is required");
  }
  const telemetry = normalizeHooks(hooks);
  return {
    async complete(request) {
      const inputTokens = request.inputTokens ?? estimateMessageTokens(request.messages ?? []);
      const maxOutputTokens = Number(request.maxOutputTokens ?? 1_000);
      const reservation = budget.assertCall({
        scope: request.scope,
        inputTokens,
        maxOutputTokens,
        operation: request.operation,
      });
      const startedAt = Date.now();
      try {
        const response = await adapter.complete(request);
        const usage = {
          inputTokens: Number(response.usage?.inputTokens ?? inputTokens),
          outputTokens: Number(response.usage?.outputTokens ?? estimateTokens(response.text)),
        };
        usage.totalTokens = Number(response.usage?.totalTokens ?? usage.inputTokens + usage.outputTokens);
        budget.commit(reservation, usage.totalTokens);
        const inputUsd = Number(pricing.inputPerMillion ?? 0) * usage.inputTokens / 1_000_000;
        const outputUsd = Number(pricing.outputPerMillion ?? 0) * usage.outputTokens / 1_000_000;
        await telemetry.cost({
          scope: request.scope ?? null,
          operation: request.operation ?? "model.complete",
          adapter: adapter.name ?? adapter.constructor?.name ?? "model",
          model: response.model ?? adapter.model ?? null,
          ...usage,
          estimatedUsd: inputUsd + outputUsd,
          latencyMs: Date.now() - startedAt,
          success: true,
        });
        return { ...response, usage };
      } catch (error) {
        await telemetry.cost({
          scope: request.scope ?? null,
          operation: request.operation ?? "model.complete",
          adapter: adapter.name ?? adapter.constructor?.name ?? "model",
          inputTokens,
          maxOutputTokens,
          latencyMs: Date.now() - startedAt,
          success: false,
          errorCode: error?.code ?? "MODEL_CALL_FAILED",
        });
        throw error;
      }
    },
  };
}

export function createMeteredEmbeddingAdapter({ adapter, hooks, pricingPerMillion = 0 }) {
  if (!adapter || typeof adapter.embed !== "function") {
    throw new RuntimeInvariantError("embedding adapter.embed is required");
  }
  const telemetry = normalizeHooks(hooks);
  return {
    async embed(request) {
      const inputTokens = Array.isArray(request.input)
        ? request.input.reduce((sum, item) => sum + estimateTokens(item), 0)
        : estimateTokens(request.input);
      const startedAt = Date.now();
      const response = await adapter.embed(request);
      await telemetry.cost({
        scope: request.scope ?? null,
        operation: request.operation ?? "embedding",
        adapter: adapter.name ?? adapter.constructor?.name ?? "embedding",
        model: response.model ?? adapter.model ?? null,
        inputTokens: Number(response.usage?.inputTokens ?? inputTokens),
        outputTokens: 0,
        estimatedUsd: pricingPerMillion * inputTokens / 1_000_000,
        latencyMs: Date.now() - startedAt,
        success: true,
      });
      return response;
    },
  };
}
