export class HeartMemoryApiError extends Error {
  constructor(message, { status, code, requestId, cause } = {}) {
    super(message, { cause });
    this.name = "HeartMemoryApiError";
    this.status = status ?? 0;
    this.code = code ?? "unknown_error";
    this.requestId = requestId ?? null;
  }
}

/**
 * A deliberately small transport client. The token supplier should return a
 * short-lived, scope-bound token minted by the product backend. Never ship the
 * API signing secret inside a website bundle or mobile application.
 */
export function createHeartMemoryClient({ baseUrl, getAccessToken, fetchImpl = globalThis.fetch, timeoutMs = 8_000 } = {}) {
  if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) throw new TypeError("baseUrl must be an absolute http(s) URL");
  if (typeof getAccessToken !== "function") throw new TypeError("getAccessToken must be a function");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const root = baseUrl.replace(/\/$/, "");

  async function request(path, { method = "GET", body, signal, idempotencyKey, ifMatch, contentType = "application/json", includeMeta = false } = {}) {
    const token = await getAccessToken();
    if (typeof token !== "string" || token.length < 10) throw new HeartMemoryApiError("Access token supplier returned an invalid token", { code: "invalid_local_token" });
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        signal: combined,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": contentType }),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
          ...(ifMatch ? { "if-match": ifMatch } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      throw new HeartMemoryApiError(cause?.name === "TimeoutError" ? "HeartMemory request timed out" : "HeartMemory request failed", { code: cause?.name === "TimeoutError" ? "timeout" : "network_error", cause });
    }
    if (response.status === 204) return includeMeta ? { data: null, etag: response.headers.get("etag"), status: response.status } : null;
    let payload;
    try { payload = await response.json(); }
    catch (cause) { throw new HeartMemoryApiError("HeartMemory returned non-JSON data", { status: response.status, code: "invalid_response", cause }); }
    if (!response.ok) {
      const error = payload?.error ?? payload ?? {};
      throw new HeartMemoryApiError(error.message ?? error.detail ?? `HeartMemory returned HTTP ${response.status}`, {
        status: response.status, code: error.code, requestId: error.requestId ?? error.traceId,
      });
    }
    const data = payload.data ?? payload;
    return includeMeta ? { data, etag: response.headers.get("etag"), status: response.status } : data;
  }

  return Object.freeze({
    prepareTurn: (input, options) => request("/v2/turns:prepare", { method: "POST", body: input, includeMeta: true, ...options }),
    commitTurn: (turnId, input, options) => request(`/v2/turns/${encodeURIComponent(turnId)}:commit`, { method: "POST", body: input, includeMeta: true, ...options }),
    failTurn: (turnId, input, options) => request(`/v2/turns/${encodeURIComponent(turnId)}:fail`, { method: "POST", body: input, ...options }),
    createConsentChallenge: (input, options) => request("/v2/consents/challenges", { method: "POST", body: input, ...options }),
    decideConsent: (input, options) => request("/v2/consents:decide", { method: "POST", body: input, ...options }),
    listConsents: ({ relationshipId, purpose } = {}, options) => request(`/v2/consents${queryString({ relationshipId, purpose })}`, options),
    remember: (input, options) => request("/v2/memories:remember", { method: "POST", body: input, ...options }),
    listMemories: ({ relationshipId, conversationId, memoryType, realm, status, cursor, limit = 30 } = {}, options) => request(`/v2/memories${queryString({ relationshipId, conversationId, memoryType, realm, status, cursor, limit })}`, options),
    memoryDetail: (claimId, options) => request(`/v2/memories/${encodeURIComponent(claimId)}`, options),
    correctMemory: (claimId, input, options) => request(`/v2/memories/${encodeURIComponent(claimId)}:correct`, { method: "POST", body: input, ...options }),
    forgetMemory: (claimId, input = { mode: "forget_fact" }, options) => request(`/v2/memories/${encodeURIComponent(claimId)}:forget`, { method: "POST", body: input, ...options }),
    recall: (input, options) => request("/v2/recall", { method: "POST", body: input, ...options }),
    deepRecall: (input, options) => request("/v2/recall:deep", { method: "POST", body: input, ...options }),
    compileContext: (input, options) => request("/v2/context:compile", { method: "POST", body: input, ...options }),
    memorySettings: (relationshipId, options) => request(`/v2/settings/memory${queryString({ relationshipId })}`, options),
    updateMemorySettings: (relationshipId, input, options) => request(`/v2/settings/memory${queryString({ relationshipId })}`, { method: "PATCH", body: input, contentType: "application/merge-patch+json", ...options }),
    proactivePreferences: (relationshipId, options) => request(`/v2/settings/proactive${queryString({ relationshipId })}`, options),
    setProactivePreferences: (relationshipId, input, options) => request(`/v2/settings/proactive${queryString({ relationshipId })}`, { method: "PATCH", body: input, contentType: "application/merge-patch+json", ...options }),
    listProactive: ({ relationshipId, state, cursor, limit = 30 } = {}, options) => request(`/v2/proactive/events${queryString({ relationshipId, state, cursor, limit })}`, options),
    scheduleProactive: (input, options) => request("/v2/proactive/events", { method: "POST", body: input, ...options }),
    proactiveEvent: (eventId, options) => request(`/v2/proactive/events/${encodeURIComponent(eventId)}`, options),
    updateProactiveEvent: (eventId, input, options) => request(`/v2/proactive/events/${encodeURIComponent(eventId)}`, { method: "PATCH", body: input, contentType: "application/merge-patch+json", ...options }),
    cancelProactiveEvent: (eventId, options) => request(`/v2/proactive/events/${encodeURIComponent(eventId)}`, { method: "DELETE", ...options }),
  });
}

function queryString(values) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}
