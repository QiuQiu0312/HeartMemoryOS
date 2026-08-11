import assert from "node:assert/strict";
import test from "node:test";
import { HeartMemoryApiError, createHeartMemoryClient } from "../src/index.js";

test("uses a scoped bearer token without putting identity in the body", async () => {
  const calls = [];
  const client = createHeartMemoryClient({
    baseUrl: "https://memory.example.test/",
    getAccessToken: async () => "short-lived-scope-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: { claimId: "claim_1" } }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });
  const result = await client.remember({ content: "喜欢火锅" }, { idempotencyKey: "remember-00000001" });
  assert.equal(result.claimId, "claim_1");
  assert.equal(calls[0].url, "https://memory.example.test/v2/memories:remember");
  assert.equal(calls[0].init.headers.authorization, "Bearer short-lived-scope-token");
  assert.equal(calls[0].init.headers["idempotency-key"], "remember-00000001");
  assert.deepEqual(JSON.parse(calls[0].init.body), { content: "喜欢火锅" });
});

test("supports turn ETags, merge patch, query encoding, and empty 204 responses", async () => {
  const calls = [];
  const client = createHeartMemoryClient({
    baseUrl: "https://memory.example.test",
    getAccessToken: () => "short-lived-scope-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.includes(":fail")) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ data: { turnId: "turn_1" } }), { status: 201, headers: { "content-type": "application/json", etag: '"turn-etag"' } });
    },
  });
  const prepared = await client.prepareTurn({ scope: {}, message: {}, client: {} }, { idempotencyKey: "turn-prepare-0001" });
  assert.equal(prepared.etag, '"turn-etag"');
  await client.updateMemorySettings("relationship a", { embeddingEnabled: false }, { idempotencyKey: "settings-update-01", ifMatch: '"settings"' });
  assert.match(calls[1].url, /relationshipId=relationship\+a/);
  assert.equal(calls[1].init.headers["content-type"], "application/merge-patch+json");
  assert.equal(calls[1].init.headers["if-match"], '"settings"');
  assert.equal(await client.failTurn("turn_1", { turnToken: "x", reasonCode: "user_cancelled" }, { idempotencyKey: "turn-failure-0001", ifMatch: '"turn"' }), null);
});

test("turns structured server failures into stable client errors", async () => {
  const client = createHeartMemoryClient({
    baseUrl: "https://memory.example.test",
    getAccessToken: () => "short-lived-scope-token",
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: "client_scope_forbidden", message: "scope is trusted", requestId: "request_123" } }), { status: 400, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(() => client.remember({ content: "x" }), (error) => {
    assert.ok(error instanceof HeartMemoryApiError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "client_scope_forbidden");
    assert.equal(error.requestId, "request_123");
    return true;
  });
});
