import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const TOKEN_AUDIENCE = "heartmemory-api";
const TOKEN_ISSUER = "heartmemory-host";
const REQUIRED_SCOPE_FIELDS = ["tenantId", "userId", "relationshipId", "companionId", "conversationId"];

function encode(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

function signature(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function createAccessToken(scope, secret, { ttlSeconds = 3600, now = Date.now(), roles = ["end_user"] } = {}) {
  assertSecret(secret);
  for (const field of REQUIRED_SCOPE_FIELDS) requireIdentifier(scope?.[field], field);
  const ttl = Number(ttlSeconds);
  if (!Number.isInteger(ttl) || ttl < 30 || ttl > 86_400) throw authError("invalid_ttl", "ttlSeconds must be an integer from 30 to 86400", 400);
  if (!Array.isArray(roles) || roles.length > 32) throw authError("invalid_roles", "roles must be an array with at most 32 entries", 400);
  const payload = {
    iss: TOKEN_ISSUER,
    aud: TOKEN_AUDIENCE,
    sub: scope.userId,
    tenantId: scope.tenantId,
    userId: scope.userId,
    relationshipId: scope.relationshipId,
    companionId: scope.companionId,
    conversationId: scope.conversationId,
    roles: Array.from(new Set(roles.map(String))),
    jti: randomUUID(),
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + ttl,
  };
  const header = encode({ alg: "HS256", typ: "JWT", kid: "local-v1" });
  const body = encode(payload);
  const signed = `${header}.${body}`;
  return `${signed}.${signature(signed, secret)}`;
}

export function verifyAccessToken(token, secret, { now = Date.now() } = {}) {
  assertSecret(secret);
  if (typeof token !== "string" || token.length > 8192) throw authError("invalid_token", "Token is missing or malformed");
  const parts = token.split(".");
  if (parts.length !== 3) throw authError("invalid_token", "Token is malformed");
  const signed = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(signature(signed, secret));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw authError("invalid_token", "Token signature is invalid");
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw authError("invalid_token", "Token payload is not valid JSON");
  }
  if (header.alg !== "HS256" || header.typ !== "JWT") throw authError("invalid_token", "Token algorithm is not accepted");
  if (payload.iss !== TOKEN_ISSUER || payload.aud !== TOKEN_AUDIENCE) throw authError("invalid_token", "Token audience or issuer is invalid");
  if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(now / 1000)) throw authError("token_expired", "Token has expired");
  requireIdentifier(payload.jti, "jti");
  for (const field of REQUIRED_SCOPE_FIELDS) requireIdentifier(payload[field], field);
  return Object.freeze({
    tenantId: payload.tenantId,
    userId: payload.userId,
    relationshipId: payload.relationshipId,
    companionId: payload.companionId,
    conversationId: payload.conversationId,
    actorId: payload.sub ?? payload.userId,
    roles: Object.freeze(Array.isArray(payload.roles) ? payload.roles.map(String) : []),
  });
}

export function createBoundActionToken({ kind, subjectId, scope, metadata = {} }, secret, { ttlSeconds = 300, now = Date.now() } = {}) {
  assertSecret(secret);
  if (!["turn", "consent_challenge"].includes(kind)) throw authError("invalid_action_kind", "Unsupported action token kind", 400);
  requireIdentifier(subjectId, "subjectId");
  for (const field of REQUIRED_SCOPE_FIELDS) requireIdentifier(scope?.[field], field);
  const ttl = Number(ttlSeconds);
  if (!Number.isInteger(ttl) || ttl < 30 || ttl > 3600) throw authError("invalid_ttl", "Action token ttlSeconds is invalid", 400);
  const issuedAt = Math.floor(now / 1000);
  const payload = { iss: TOKEN_ISSUER, aud: TOKEN_AUDIENCE, typ: kind, sub: subjectId, scope, metadata, jti: randomUUID(), iat: issuedAt, exp: issuedAt + ttl };
  const header = encode({ alg: "HS256", typ: "JWT", kid: "local-v1" });
  const body = encode(payload);
  const signed = `${header}.${body}`;
  return `${signed}.${signature(signed, secret)}`;
}

export function verifyBoundActionToken(token, secret, { kind, subjectId, scope, now = Date.now() }) {
  const payload = verifySignedPayload(token, secret, now);
  if (payload.typ !== kind || payload.sub !== subjectId) throw authError("invalid_action_token", "Action token is bound to another operation");
  for (const field of REQUIRED_SCOPE_FIELDS) {
    if (payload.scope?.[field] !== scope?.[field]) throw authError("invalid_action_token", "Action token scope does not match the verified session");
  }
  return Object.freeze(payload);
}

export function bearerToken(request) {
  const value = request.headers.authorization;
  const match = typeof value === "string" ? /^Bearer\s+(.+)$/i.exec(value) : null;
  if (!match) throw authError("missing_token", "Authorization: Bearer token is required");
  return match[1];
}

export function requireRole(identity, allowed) {
  if (!allowed.some((role) => identity.roles.includes(role))) throw authError("forbidden", "This token does not have the required role", 403);
}

export function authError(code, message, status = 401) {
  const error = new Error(message);
  error.name = "AuthenticationError";
  error.code = code;
  error.status = status;
  return error;
}

function assertSecret(secret) {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) throw new Error("MEMORYOS_AUTH_SECRET must contain at least 32 bytes");
}

function verifySignedPayload(token, secret, now) {
  assertSecret(secret);
  if (typeof token !== "string" || token.length > 8192) throw authError("invalid_action_token", "Action token is missing or malformed");
  const parts = token.split(".");
  if (parts.length !== 3) throw authError("invalid_action_token", "Action token is malformed");
  const signed = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(signature(signed, secret));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw authError("invalid_action_token", "Action token signature is invalid");
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); }
  catch { throw authError("invalid_action_token", "Action token payload is invalid"); }
  if (payload.iss !== TOKEN_ISSUER || payload.aud !== TOKEN_AUDIENCE || !Number.isFinite(payload.exp)) {
    throw authError("invalid_action_token", "Action token claims are invalid");
  }
  if (payload.exp <= Math.floor(now / 1000)) throw authError("action_token_expired", "Action token has expired");
  requireIdentifier(payload.jti, "jti");
  return payload;
}

function requireIdentifier(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw authError("invalid_scope", `${name} is invalid`);
}
