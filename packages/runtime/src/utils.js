import { createHash, randomUUID } from "node:crypto";
import { RuntimeInvariantError } from "./errors.js";

export const PROACTIVE_KINDS = Object.freeze([
  "transactional_reminder",
  "onboarding_in_app",
  "relationship_proactive",
  "marketing",
]);

export const PROACTIVE_PURPOSE_BY_KIND = Object.freeze({
  transactional_reminder: "proactive_transactional",
  onboarding_in_app: "proactive_onboarding",
  relationship_proactive: "proactive_relationship",
  marketing: "proactive_marketing",
});

export const TERMINAL_JOB_STATES = Object.freeze(["succeeded", "dead_letter", "cancelled"]);

export function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function newId(prefix = "id") {
  return `${prefix}_${randomUUID()}`;
}

export function iso(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RuntimeInvariantError("Invalid timestamp", { value });
  }
  return date.toISOString();
}

export function epochMs(value = Date.now()) {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(ms)) {
    throw new RuntimeInvariantError("Invalid timestamp", { value });
  }
  return ms;
}

export function hashText(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

export function scopeKey(scope) {
  assertScope(scope);
  return [scope.tenantId, scope.userId, scope.relationshipId, scope.companionId].join(":");
}

export function conversationKey(scope) {
  assertScope(scope);
  return [scope.tenantId, scope.userId, scope.relationshipId, scope.companionId, scope.conversationId].join(":");
}

export function assertScope(scope) {
  if (!scope || typeof scope !== "object") {
    throw new RuntimeInvariantError("A server-derived scope is required");
  }
  for (const field of ["tenantId", "userId", "relationshipId", "companionId", "conversationId"]) {
    if (typeof scope[field] !== "string" || !scope[field].trim()) {
      throw new RuntimeInvariantError(`scope.${field} is required`);
    }
  }
  return scope;
}

export function assertProactiveKind(kind) {
  if (!PROACTIVE_KINDS.includes(kind)) {
    throw new RuntimeInvariantError(`Unsupported proactive kind: ${kind}`);
  }
  return kind;
}

export function assertRepository(repository, contract) {
  if (!repository || typeof repository !== "object") {
    throw new RuntimeInvariantError("A repository implementation is required");
  }
  for (const method of Object.values(contract).flat()) {
    if (typeof repository[method] !== "function") {
      throw new RuntimeInvariantError(`Repository is missing method ${method}`);
    }
  }
  return repository;
}

export function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new RuntimeInvariantError(`${name} must be a non-empty string`);
  }
  return value;
}

export function estimateTokens(text) {
  const value = String(text ?? "");
  if (!value) return 0;
  const cjk = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/gu) ?? []).length;
  const remaining = Math.max(0, value.length - cjk);
  return Math.max(1, Math.ceil(cjk / 1.5 + remaining / 4));
}

export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

export function contentDigest(value) {
  return hashText(stableJson(value));
}

export function redactError(error) {
  const raw = error instanceof Error ? error.message : String(error ?? "unknown error");
  return raw
    .replace(/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{8,}\b/giu, "[REDACTED]")
    .replace(/bearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [REDACTED]")
    .slice(0, 500);
}

export function mergeUnique(left = [], right = []) {
  return [...new Set([...(left ?? []), ...(right ?? [])])];
}

export function exponentialBackoffMs(attempt, {
  baseMs = 1_000,
  maxMs = 5 * 60_000,
  jitter = 0,
  random = Math.random,
} = {}) {
  const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, Number(attempt || 1) - 1));
  if (!jitter) return raw;
  const span = raw * Math.min(1, Math.max(0, jitter));
  return Math.max(0, Math.round(raw - span + random() * span * 2));
}

export function parseJsonObject(text) {
  const source = String(text ?? "").trim();
  const unfenced = source
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  const value = JSON.parse(unfenced);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeInvariantError("Expected a JSON object from model adapter");
  }
  return value;
}

export function isRetryableError(error) {
  if (error?.retryable === true) return true;
  const status = Number(error?.status ?? error?.details?.status);
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}
