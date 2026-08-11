import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMemoryRepository } from "../../../packages/memory-core/src/index.js";
import { InMemoryRuntimeRepository } from "../../../packages/runtime/src/index.js";
import { createAccessToken } from "../src/auth.js";
import { createApiServer } from "../src/http.js";
import { LocalCompanionStore } from "../src/local-companion.js";

const secret = "test-secret-that-is-longer-than-thirty-two-bytes";

function scope(userId) {
  return { tenantId: "tenant_a", userId, relationshipId: `rel_${userId}`, companionId: "companion_aria", conversationId: `conversation_${userId}` };
}

async function withServer(run, { demoMode = true, ...serverOptions } = {}) {
  const repository = createMemoryRepository({ fingerprintKey: "fingerprint-key-for-tests-32-bytes!!" });
  const runtimeRepository = new InMemoryRuntimeRepository();
  const server = createApiServer({ repository, runtimeRepository, authSecret: secret, demoMode, logger: { error() {}, warn() {} }, ...serverOptions });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`, { repository, runtimeRepository }); }
  finally { await new Promise((resolve) => server.close(resolve)); repository.close(); }
}

async function api(base, path, { token, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, headers: response.headers };
}

async function patchCurrent(base, path, { token, body, idempotencyKey }) {
  const current = await api(base, path, { token });
  assert.equal(current.status, 200);
  const etag = current.headers.get("etag");
  assert.ok(etag, `${path} must expose an ETag before mutation`);
  return api(base, path, {
    token,
    method: "PATCH",
    headers: { "idempotency-key": idempotencyKey, "if-match": etag },
    body,
  });
}

test("health is public but memory routes require a verified token", async () => {
  await withServer(async (base) => {
    assert.equal((await api(base, "/healthz")).status, 200);
    const denied = await api(base, "/v2/memories");
    assert.equal(denied.status, 401);
    assert.equal(denied.json.code, "MISSING_TOKEN");
  });
});

test("CORS accepts the configured loopback origins and rejects other sites", async () => {
  await withServer(async (base) => {
    for (const origin of ["http://127.0.0.1:3000", "http://localhost:3000"]) {
      const accepted = await api(base, "/health/ready", { method: "OPTIONS", headers: { origin } });
      assert.equal(accepted.status, 204);
      assert.equal(accepted.headers.get("access-control-allow-origin"), origin);
    }
    const rejected = await api(base, "/health/ready", { method: "OPTIONS", headers: { origin: "https://example.invalid" } });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.json.code, "ORIGIN_FORBIDDEN");
  }, { allowedOrigin: "http://127.0.0.1:3000,http://localhost:3000" });
});

test("local companion routes are disabled unless the loopback-only mode is explicit", async () => {
  await withServer(async (base) => {
    const token = createAccessToken(scope("alice"), secret, { roles: ["end_user", "memory_admin"] });
    assert.equal((await api(base, "/local/v2/config", { token })).status, 404);
  });
});

test("local companion keeps provider secrets server-side and runs chat through real memory orchestration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "heartmemory-local-api-"));
  const store = new LocalCompanionStore({
    configPath: join(directory, "config.json"),
    secretsPath: join(directory, "secrets.json"),
    statePath: join(directory, "state.json"),
  });
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "chat-small" }, { id: "chat-main" }] });
    const payload = JSON.parse(init.body ?? "{}");
    const system = String(payload.messages?.[0]?.content ?? "");
    if (system.includes("extract conservative memory candidates")) {
      const evidence = JSON.parse(payload.messages[1].content);
      return Response.json({
        id: "extract-1", model: payload.model,
        choices: [{ message: { content: JSON.stringify({ schemaVersion: 2, candidates: [{
          schemaVersion: 2, candidateKind: "relationship", realm: "real_world",
          attribution: { assertedByType: "user", assertedByRef: null, epistemicBasis: "explicit_memory_request", quotedSpeakerRef: null },
          subjectRef: "user", predicateKey: "pet.name", value: "小白", canonicalText: "用户的猫叫小白",
          polarity: "positive", modality: "asserted", temporal: { kind: "timeless", precision: "unknown", validFrom: null, validTo: null, sourceTimezone: null, recurrenceRRule: null },
          evidenceMessageIds: [evidence.allowedMessageIds[0]], sensitivity: "ordinary", confidenceBand: "high", proposedAction: "keep_candidate",
        }] }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 80, completion_tokens: 45, total_tokens: 125 },
      });
    }
    return Response.json({ id: "chat-1", model: payload.model, choices: [{ message: { content: "记住啦，小白已经在我的长期记忆里占好座位了。" }, finish_reason: "stop" }], usage: { prompt_tokens: 42, completion_tokens: 18, total_tokens: 60 } });
  };
  try {
    await withServer(async (base) => {
      const identity = scope("alice");
      const token = createAccessToken(identity, secret, { roles: ["end_user", "memory_admin"] });
      const configured = await api(base, "/local/v2/config", { token, method: "PATCH", body: {
        firstRunComplete: true,
        providers: { main: { baseUrl: "https://provider.example/v1", model: "chat-main", apiKey: "secret-local-key" } },
      } });
      assert.equal(configured.status, 200);
      assert.equal(configured.json.providers.main.apiKeySet, true);
      assert.equal(JSON.stringify(configured.json).includes("secret-local-key"), false);
      const prompts = await api(base, "/local/v2/prompts", { token });
      assert.equal(prompts.status, 200);
      assert.equal(prompts.json.items.length, 8);
      assert.match(prompts.json.items.find((item) => item.promptId === "core-persona").content, /永久边界/);

      const discovery = await api(base, "/local/v2/providers:discover", { token, method: "POST", body: { slot: "main" } });
      assert.deepEqual(discovery.json.models, ["chat-main", "chat-small"]);
      const started = await api(base, "/local/v2/session:start", { token, method: "POST", body: {} });
      assert.equal(started.status, 200);
      assert.equal(started.json.items[0].role, "assistant");
      assert.match(started.json.items[0].content, /心忆/);

      const chatted = await api(base, "/local/v2/chat", { token, method: "POST", body: { content: "请记住，我的猫叫小白", clientMessageId: "local-chat-message-0001" } });
      assert.equal(chatted.status, 200);
      assert.match(chatted.json.assistantMessage.content, /小白/);
      assert.equal(chatted.json.recall.usage.totalTokens, 60);

      for (let attempt = 0; attempt < 40; attempt += 1) {
        const listed = await api(base, "/v2/memories?limit=20", { token });
        if (listed.json.items.some((item) => item.text.includes("小白"))) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const memories = await api(base, "/v2/memories?limit=20", { token });
      assert.equal(memories.json.items.some((item) => item.text === "我的猫叫小白"), true);
      await api(base, "/local/v2/chat", { token, method: "POST", body: { content: "以后回复短一点", clientMessageId: "local-chat-message-0002" } });
      const profile = await store.listAdaptiveProfile(identity);
      assert.equal(profile.some((item) => item.dimension === "response_length" && item.value === "short"), true);
      await api(base, "/local/v2/chat", { token, method: "POST", body: { content: "今天怎么样", clientMessageId: "local-chat-message-0003" } });
      const chatPayloads = calls.filter((call) => call.url.endsWith("/chat/completions")).map((call) => JSON.parse(call.init.body));
      assert.equal(chatPayloads.some((payload) => JSON.stringify(payload.messages).includes("adaptive_expression_profile")), true);
      assert.equal(calls.some((call) => call.url.endsWith("/chat/completions")), true);

      const directClaim = memories.json.items.find((item) => item.text === "我的猫叫小白");
      assert.ok(directClaim?.memoryId);
      const forgotten = await api(base, `/v2/memories/${directClaim.memoryId}`, { token, method: "DELETE" });
      assert.equal(forgotten.status, 202);
      const cannotPretend = await api(base, "/local/v2/chat", { token, method: "POST", body: { content: "请记住，我的猫叫小白", clientMessageId: "local-chat-message-0004" } });
      assert.equal(cannotPretend.status, 409);
      assert.equal(calls.filter((call) => call.url.endsWith("/chat/completions")).length, chatPayloads.length);
    }, { localCompanionMode: true, localCompanionStore: store, fetchImpl });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("server refuses short or example secrets before opening a listener", () => {
  const repository = createMemoryRepository({ fingerprintKey: "fingerprint-key-for-tests-32-bytes!!" });
  try {
    assert.throws(() => createApiServer({ repository, runtimeRepository: new InMemoryRuntimeRepository(), authSecret: "too-short" }), /at least 32 bytes/);
    assert.throws(() => createApiServer({
      repository,
      runtimeRepository: new InMemoryRuntimeRepository(),
      authSecret: "replace-with-at-least-32-random-bytes",
    }), /non-placeholder/);
  } finally {
    repository.close();
  }
});

test("production mode hides demo token minting and legacy compatibility writes", async () => {
  await withServer(async (base) => {
    const identity = scope("alice");
    const token = createAccessToken(identity, secret);
    const demoToken = await api(base, "/v2/auth/demo-token", {
      method: "POST",
      body: identity,
    });
    assert.equal(demoToken.status, 404);
    const legacyConsent = await api(base, "/v2/consents", {
      token,
      method: "POST",
      body: { purpose: "memory_ordinary", granted: true, policyVersion: "v2" },
    });
    assert.equal(legacyConsent.status, 404);
    const legacyMemory = await api(base, "/v2/memories", {
      token,
      method: "POST",
      body: { content: "不应通过旧接口写入" },
    });
    assert.equal(legacyMemory.status, 404);
  }, { demoMode: false });
});

test("verified token scope isolates two users and body cannot override it", async () => {
  await withServer(async (base) => {
    const tokenA = createAccessToken(scope("alice"), secret, { roles: ["end_user", "memory_admin"] });
    const tokenB = createAccessToken(scope("bob"), secret, { roles: ["end_user", "memory_admin"] });
    for (const token of [tokenA, tokenB]) {
      const consent = await api(base, "/v2/consents", { token, method: "POST", body: { category: "memory", granted: true, policyVersion: "test-v1" } });
      assert.equal(consent.status, 201);
    }
    const saved = await api(base, "/v2/memories", { token: tokenA, method: "POST", body: { content: "小林喜欢吃火锅", kind: "preference", aliases: ["小林", "火锅"] } });
    assert.equal(saved.status, 201);
    const alice = await api(base, "/v2/recall", { token: tokenA, method: "POST", body: { query: "火锅", trace: true } });
    const bob = await api(base, "/v2/recall", { token: tokenB, method: "POST", body: { query: "火锅", trace: true } });
    assert.equal(alice.json.data.items.length, 1);
    assert.equal(bob.json.data.items.length, 0);
    const spoof = await api(base, "/v2/memories", { token: tokenB, method: "POST", body: { content: "越权", tenantId: "tenant_a", userId: "alice" } });
    assert.equal(spoof.status, 400);
    assert.equal(spoof.json.code, "CLIENT_SCOPE_FORBIDDEN");
  });
});

test("deletion is immediately hidden and suppressed from relearning", async () => {
  await withServer(async (base) => {
    const token = createAccessToken(scope("alice"), secret, { roles: ["end_user", "memory_admin"] });
    await api(base, "/v2/consents", { token, method: "POST", body: { category: "memory", granted: true, policyVersion: "test-v1" } });
    const saved = await api(base, "/v2/memories", { token, method: "POST", body: { content: "最喜欢紫色风铃", aliases: ["风铃"] } });
    const id = saved.json.data.claimId;
    const removed = await api(base, `/v2/memories/${id}`, { token, method: "DELETE" });
    assert.equal(removed.status, 202);
    const recall = await api(base, "/v2/recall", { token, method: "POST", body: { query: "风铃" } });
    assert.equal(recall.json.data.items.length, 0);
    const resurrect = await api(base, "/v2/memories", { token, method: "POST", body: { content: "最喜欢紫色风铃", aliases: ["风铃"] } });
    assert.equal(resurrect.status, 409);
  });
});

test("context compiler enforces its hard token budget", async () => {
  await withServer(async (base) => {
    const token = createAccessToken(scope("alice"), secret);
    await api(base, "/v2/consents", { token, method: "POST", body: { category: "memory", granted: true, policyVersion: "test-v1" } });
    await api(base, "/v2/memories", { token, method: "POST", body: { content: "用户非常喜欢在下雨天听安静的钢琴曲，也喜欢窗边的雨声。", aliases: ["下雨天", "钢琴曲"] } });
    const compiled = await api(base, "/v2/context:compile", { token, method: "POST", body: { query: "下雨天", maxTokens: 96, perMemoryTokens: 40 } });
    assert.equal(compiled.status, 200);
    assert.ok(compiled.json.data.envelope.usedTokens <= 96);
  });
});

test("contract turn flow binds scope, ETag, action token, and commit idempotency", async () => {
  await withServer(async (base) => {
    const identity = scope("alice");
    const token = createAccessToken(identity, secret);
    const prepare = await api(base, "/v2/turns:prepare", {
      token, method: "POST", headers: { "idempotency-key": "turn-prepare-000001" },
      body: {
        scope: { relationshipId: identity.relationshipId, conversationId: identity.conversationId },
        message: { clientMessageId: "client-message-1", content: "今晚想安静地听雨", sentAt: "2026-08-08T12:00:00.000Z" },
        client: { platform: "web", locale: "zh-CN", timezone: "Asia/Shanghai" },
      },
    });
    assert.equal(prepare.status, 201);
    assert.equal(prepare.json.context.schemaVersion, 2);
    assert.equal(prepare.json.context.tokenAccounting.hardLimitSatisfied, true);
    const etag = prepare.headers.get("etag");
    const commitBody = {
      turnToken: prepare.json.turnToken,
      assistant: { content: "好，我们就安静听一会儿雨。" },
      invocation: { provider: "mock", model: "mock-chat", promptVersion: "v2", inputTokens: 32, outputTokens: 12 },
    };
    const commit = await api(base, `/v2/turns/${prepare.json.turnId}:commit`, {
      token, method: "POST", headers: { "idempotency-key": "turn-commit-000001", "if-match": etag }, body: commitBody,
    });
    assert.equal(commit.status, 200);
    assert.equal(commit.json.state, "committed");
    const replay = await api(base, `/v2/turns/${prepare.json.turnId}:commit`, {
      token, method: "POST", headers: { "idempotency-key": "turn-commit-000001", "if-match": etag }, body: commitBody,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.assistantMessageId, commit.json.assistantMessageId);
    const conflict = await api(base, `/v2/turns/${prepare.json.turnId}:commit`, {
      token, method: "POST", headers: { "idempotency-key": "turn-commit-000002", "if-match": etag }, body: { ...commitBody, assistant: { content: "different" } },
    });
    assert.equal(conflict.status, 409);
  });
});

test("mutable settings, memories, and proactive events reject missing or stale ETags", async () => {
  await withServer(async (base) => {
    const identity = scope("alice");
    const token = createAccessToken(identity, secret);

    const initialSettings = await api(base, `/v2/settings/memory?relationshipId=${identity.relationshipId}`, { token });
    const initialSettingsEtag = initialSettings.headers.get("etag");
    const missingSettingsEtag = await api(base, `/v2/settings/memory?relationshipId=${identity.relationshipId}`, {
      token, method: "PATCH", headers: { "idempotency-key": "missing-settings-etag-01" }, body: { extractionEnabled: false },
    });
    assert.equal(missingSettingsEtag.status, 412);
    await api(base, "/v2/consents", { token, method: "POST", body: { purpose: "memory_ordinary", granted: true, policyVersion: "v2" } });
    const changedSettings = await api(base, `/v2/settings/memory?relationshipId=${identity.relationshipId}`, {
      token, method: "PATCH", headers: { "idempotency-key": "valid-settings-etag-0001", "if-match": initialSettingsEtag }, body: { extractionEnabled: true },
    });
    assert.equal(changedSettings.status, 200);
    const staleSettings = await api(base, `/v2/settings/memory?relationshipId=${identity.relationshipId}`, {
      token, method: "PATCH", headers: { "idempotency-key": "stale-settings-etag-0001", "if-match": initialSettingsEtag }, body: { extractionEnabled: false },
    });
    assert.equal(staleSettings.status, 412);

    const saved = await api(base, "/v2/memories:remember", {
      token, method: "POST", headers: { "idempotency-key": "etag-memory-remember-001" },
      body: { scope: { relationshipId: identity.relationshipId, conversationId: identity.conversationId }, content: "用户喜欢蓝色杯子", realm: "real_world", memoryType: "preference" },
    });
    const memoryId = saved.json.memory.memoryId;
    const detail = await api(base, `/v2/memories/${memoryId}`, { token });
    const missingMemoryEtag = await api(base, `/v2/memories/${memoryId}:correct`, {
      token, method: "POST", headers: { "idempotency-key": "missing-memory-etag-001" },
      body: { scope: { relationshipId: identity.relationshipId }, replacement: "用户喜欢绿色杯子", realm: "real_world" },
    });
    assert.equal(missingMemoryEtag.status, 412);
    const corrected = await api(base, `/v2/memories/${memoryId}:correct`, {
      token, method: "POST", headers: { "idempotency-key": "valid-memory-etag-00001", "if-match": detail.headers.get("etag") },
      body: { scope: { relationshipId: identity.relationshipId }, replacement: "用户喜欢绿色杯子", realm: "real_world" },
    });
    assert.equal(corrected.status, 200);

    await api(base, "/v2/consents", { token, method: "POST", body: { purpose: "proactive_transactional", granted: true, policyVersion: "v2" } });
    await patchCurrent(base, `/v2/settings/proactive?relationshipId=${identity.relationshipId}`, {
      token, idempotencyKey: "etag-proactive-setting-01", body: { transactionalEnabled: true },
    });
    const created = await api(base, "/v2/proactive/events", {
      token, method: "POST", headers: { "idempotency-key": "etag-proactive-create-001" },
      body: {
        scope: { relationshipId: identity.relationshipId, conversationId: identity.conversationId }, summary: "提醒喝水", channel: "in_app",
        schedule: { localDateTime: "2030-08-08T08:00", timezone: "Asia/Shanghai", dstPolicy: "reject_ambiguous", quietHoursPolicy: "deliver_at_requested_time", latePolicy: "skip_if_late" },
      },
    });
    const eventPath = `/v2/proactive/events/${created.json.eventId}`;
    assert.ok(created.headers.get("etag"));
    const event = await api(base, eventPath, { token });
    const missingEventEtag = await api(base, eventPath, {
      token, method: "PATCH", headers: { "idempotency-key": "missing-event-etag-001" }, body: { summary: "提醒喝温水" },
    });
    assert.equal(missingEventEtag.status, 412);
    const changedEvent = await api(base, eventPath, {
      token, method: "PATCH", headers: { "idempotency-key": "valid-event-etag-00001", "if-match": event.headers.get("etag") }, body: { summary: "提醒喝温水" },
    });
    assert.equal(changedEvent.status, 200);
    assert.ok(changedEvent.headers.get("etag"));
    const staleEvent = await api(base, eventPath, {
      token, method: "PATCH", headers: { "idempotency-key": "stale-event-etag-00001", "if-match": event.headers.get("etag") }, body: { summary: "提醒喝水" },
    });
    assert.equal(staleEvent.status, 412);
  });
});

test("enabled background automation queues only scoped, program-selected work", async () => {
  await withServer(async (base, { runtimeRepository }) => {
    const identity = scope("alice");
    const token = createAccessToken(identity, secret);
    await api(base, "/v2/consents", { token, method: "POST", body: { purpose: "memory_ordinary", granted: true, policyVersion: "v2" } });
    const settings = await patchCurrent(base, `/v2/settings/memory?relationshipId=${identity.relationshipId}`, {
      token,
      idempotencyKey: "memory-settings-enable-0001",
      body: { extractionEnabled: true },
    });
    assert.equal(settings.status, 200);
    const prepare = await api(base, "/v2/turns:prepare", {
      token,
      method: "POST",
      headers: { "idempotency-key": "turn-background-prepare-01" },
      body: {
        scope: { relationshipId: identity.relationshipId, conversationId: identity.conversationId },
        message: { clientMessageId: "background-message-1", content: "请记住，我更喜欢简短回复。", sentAt: "2026-08-08T12:00:00.000Z" },
        client: { platform: "web", locale: "zh-CN", timezone: "Asia/Shanghai" },
      },
    });
    const committed = await api(base, `/v2/turns/${prepare.json.turnId}:commit`, {
      token,
      method: "POST",
      headers: { "idempotency-key": "turn-background-commit-01", "if-match": prepare.headers.get("etag") },
      body: {
        turnToken: prepare.json.turnToken,
        assistant: { content: "好，我会记得你喜欢简短回复。" },
        invocation: { provider: "mock", model: "mock-chat", promptVersion: "v2", inputTokens: 20, outputTokens: 10 },
      },
    });
    assert.deepEqual(committed.json.backgroundWorkQueued, ["memory_extraction"]);
    const jobs = await runtimeRepository.listJobs({ type: "memory.extract_candidates" });
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0].scope, identity);
    assert.equal(jobs[0].payload.explicit, true);
  });
});

test("derived features require separate consent and withdrawal forces settings off", async () => {
  await withServer(async (base) => {
    const identity = scope("alice");
    const token = createAccessToken(identity, secret);
    await api(base, "/v2/consents", { token, method: "POST", body: { purpose: "memory_ordinary", granted: true, policyVersion: "v2" } });
    const extraction = await patchCurrent(base, `/v2/settings/memory?relationshipId=${identity.relationshipId}`, {
      token, idempotencyKey: "memory-extraction-enabled-01", body: { extractionEnabled: true, summarizationEnabled: true },
    });
    assert.equal(extraction.status, 200);
    await api(base, "/v2/consents", { token, method: "POST", body: { purpose: "memory_ordinary", granted: false, policyVersion: "v3" } });
    const afterMemoryWithdrawal = await api(base, `/v2/settings/memory?relationshipId=${identity.relationshipId}`, { token });
    assert.equal(afterMemoryWithdrawal.json.extractionEnabled, false);
    assert.equal(afterMemoryWithdrawal.json.summarizationEnabled, false);

    const deniedArchive = await patchCurrent(base, `/v2/settings/memory?relationshipId=${identity.relationshipId}`, {
      token, idempotencyKey: "raw-archive-denied-0001", body: { rawArchiveEnabled: true },
    });
    assert.equal(deniedArchive.status, 403);
    const malformed = await patchCurrent(base, `/v2/settings/memory?relationshipId=${identity.relationshipId}`, {
      token, idempotencyKey: "memory-settings-bad-0001", body: { extractionEnabled: "yes", hiddenOverride: true },
    });
    assert.equal(malformed.status, 400);

    await api(base, "/v2/consents", { token, method: "POST", body: { purpose: "raw_conversation_archive", granted: true, policyVersion: "v2" } });
    const enabledArchive = await patchCurrent(base, `/v2/settings/memory?relationshipId=${identity.relationshipId}`, {
      token, idempotencyKey: "raw-archive-enabled-001", body: { rawArchiveEnabled: true, retentionMode: "standard" },
    });
    assert.equal(enabledArchive.status, 200);
    assert.equal(enabledArchive.json.rawArchiveEnabled, true);
    await api(base, "/v2/consents", { token, method: "POST", body: { purpose: "raw_conversation_archive", granted: false, policyVersion: "v3" } });
    const afterWithdrawal = await api(base, `/v2/settings/memory?relationshipId=${identity.relationshipId}`, { token });
    assert.equal(afterWithdrawal.json.rawArchiveEnabled, false);

    const malformedProactive = await patchCurrent(base, `/v2/settings/proactive?relationshipId=${identity.relationshipId}`, {
      token, idempotencyKey: "proactive-settings-bad-01", body: { transactionalEnabled: "false" },
    });
    assert.equal(malformedProactive.status, 400);

    await api(base, "/v2/consents", { token, method: "POST", body: { purpose: "lock_screen_content", granted: true, policyVersion: "v2" } });
    const fullLockScreen = await patchCurrent(base, `/v2/settings/proactive?relationshipId=${identity.relationshipId}`, {
      token, idempotencyKey: "lock-screen-content-full-01", body: { lockScreenContentMode: "full" },
    });
    assert.equal(fullLockScreen.json.lockScreenContentMode, "full");
    await api(base, "/v2/consents", { token, method: "POST", body: { purpose: "lock_screen_content", granted: false, policyVersion: "v3" } });
    const afterLockWithdrawal = await api(base, `/v2/settings/proactive?relationshipId=${identity.relationshipId}`, { token });
    assert.equal(afterLockWithdrawal.json.lockScreenContentMode, "hidden");
  });
});

test("consent challenge is purpose-bound, one-time, and query scope cannot be spoofed", async () => {
  await withServer(async (base) => {
    const identity = scope("alice");
    const token = createAccessToken(identity, secret);
    const unsupported = await api(base, "/v2/consents/challenges", {
      token, method: "POST", headers: { "idempotency-key": "consent-unsupported-001" },
      body: { relationshipId: identity.relationshipId, purpose: "remember_everything", locale: "zh-CN" },
    });
    assert.equal(unsupported.status, 400);
    const unboundShare = await api(base, "/v2/consents/challenges", {
      token, method: "POST", headers: { "idempotency-key": "consent-share-unbound-01" },
      body: { relationshipId: identity.relationshipId, purpose: "cross_relationship_memory_share", locale: "zh-CN" },
    });
    assert.equal(unboundShare.status, 400);
    const challenge = await api(base, "/v2/consents/challenges", {
      token, method: "POST", headers: { "idempotency-key": "consent-challenge-001" },
      body: { relationshipId: identity.relationshipId, purpose: "memory_ordinary", locale: "zh-CN" },
    });
    assert.equal(challenge.status, 201);
    const decisionBody = { relationshipId: identity.relationshipId, purpose: "memory_ordinary", decision: "grant",
      policyVersion: challenge.json.policyVersion, challengeToken: challenge.json.challengeToken };
    const decided = await api(base, "/v2/consents:decide", {
      token, method: "POST", headers: { "idempotency-key": "consent-decision-0001" }, body: decisionBody,
    });
    assert.equal(decided.status, 200);
    assert.ok(decided.headers.get("etag"));
    assert.equal(decided.json.granted, true);
    const replay = await api(base, "/v2/consents:decide", {
      token, method: "POST", headers: { "idempotency-key": "consent-decision-0002" }, body: decisionBody,
    });
    assert.equal(replay.status, 409);
    const listed = await api(base, `/v2/consents?relationshipId=${identity.relationshipId}`, { token });
    assert.equal(listed.json.items[0].purpose, "memory_ordinary");
    const spoof = await api(base, "/v2/consents?relationshipId=someone-else", { token });
    assert.equal(spoof.status, 403);
  });
});

test("contract memory paths preserve realms and deep recall has separate consent", async () => {
  await withServer(async (base) => {
    const identity = scope("alice");
    const token = createAccessToken(identity, secret);
    await api(base, "/v2/consents", { token, method: "POST", body: { purpose: "memory_ordinary", granted: true, policyVersion: "v2" } });
    await api(base, "/v2/consents", { token, method: "POST", body: { purpose: "semantic_index", granted: true, policyVersion: "v2" } });
    const saved = await api(base, "/v2/memories:remember", {
      token, method: "POST", headers: { "idempotency-key": "remember-roleplay-01" },
      body: { scope: { relationshipId: identity.relationshipId, conversationId: identity.conversationId }, content: "角色扮演里用户是月球女王", realm: "roleplay", memoryType: "identity" },
    });
    assert.equal(saved.status, 201);
    assert.equal(saved.json.memory.realm, "roleplay");
    const ordinary = await api(base, "/v2/recall", { token, method: "POST", body: { query: "月球女王" } });
    assert.equal(ordinary.json.data.items.length, 0);
    const roleplay = await api(base, "/v2/recall", { token, method: "POST", body: { query: "月球女王", allowedRealms: ["roleplay"] } });
    assert.equal(roleplay.json.data.items[0].realm, "roleplay");
    const denied = await api(base, "/v2/recall:deep", { token, method: "POST", headers: { "idempotency-key": "deep-recall-denied1" },
      body: { scope: { relationshipId: identity.relationshipId }, query: "月球女王", trigger: "explicit_user_request", allowedRealms: ["roleplay"] } });
    assert.equal(denied.status, 403);
    await api(base, "/v2/consents", { token, method: "POST", body: { purpose: "deep_recall", granted: true, policyVersion: "v2" } });
    await patchCurrent(base, `/v2/settings/memory?relationshipId=${identity.relationshipId}`, {
      token, idempotencyKey: "deep-recall-setting-0001", body: { deepRecallEnabled: true },
    });
    const deep = await api(base, "/v2/recall:deep", { token, method: "POST", headers: { "idempotency-key": "deep-recall-allowed1" },
      body: { scope: { relationshipId: identity.relationshipId }, query: "月球女王", trigger: "explicit_user_request", allowedRealms: ["roleplay"] } });
    assert.equal(deep.status, 200);
    assert.equal(deep.json.status, "found");
  });
});

test("deep recall can retrieve retained message evidence without a model call", async () => {
  await withServer(async (base) => {
    const identity = scope("alice");
    const token = createAccessToken(identity, secret);
    for (const purpose of ["memory_ordinary", "deep_recall", "raw_conversation_archive"]) {
      await api(base, "/v2/consents", { token, method: "POST", body: { purpose, granted: true, policyVersion: "v2" } });
    }
    await patchCurrent(base, `/v2/settings/memory?relationshipId=${identity.relationshipId}`, {
      token, idempotencyKey: "archive-deep-settings-01",
      body: { deepRecallEnabled: true, rawArchiveEnabled: true, retentionMode: "standard" },
    });
    const prepare = await api(base, "/v2/turns:prepare", {
      token, method: "POST", headers: { "idempotency-key": "archive-turn-prepare-001" },
      body: {
        scope: { relationshipId: identity.relationshipId, conversationId: identity.conversationId },
        message: { clientMessageId: "archive-message-1", content: "我把毕业纪念册放在书房书架第二层。", sentAt: "2026-08-08T12:00:00.000Z" },
        client: { platform: "web", locale: "zh-CN", timezone: "Asia/Shanghai" },
      },
    });
    await api(base, `/v2/turns/${prepare.json.turnId}:commit`, {
      token, method: "POST", headers: { "idempotency-key": "archive-turn-commit-001", "if-match": prepare.headers.get("etag") },
      body: { turnToken: prepare.json.turnToken, assistant: { content: "好。" }, invocation: { provider: "mock", model: "mock", promptVersion: "v2", inputTokens: 10, outputTokens: 2 } },
    });
    const deep = await api(base, "/v2/recall:deep", {
      token, method: "POST", headers: { "idempotency-key": "archive-deep-recall-001" },
      body: { scope: { relationshipId: identity.relationshipId }, query: "毕业纪念册", trigger: "explicit_user_request", allowedRealms: ["unknown"] },
    });
    assert.equal(deep.status, 200);
    assert.equal(deep.json.status, "found");
    assert.equal(deep.json.evidence[0].sourceKind, "message_archive");
    assert.match(deep.json.evidence[0].excerpt, /书架第二层/);
  });
});

test("transactional reminders require both purpose consent and user setting", async () => {
  await withServer(async (base, { runtimeRepository }) => {
    const identity = scope("alice");
    const token = createAccessToken(identity, secret);
    const defaults = await api(base, `/v2/settings/proactive?relationshipId=${identity.relationshipId}`, { token });
    assert.equal(defaults.json.transactionalEnabled, false);
    assert.equal(defaults.json.onboardingEnabled, false);
    await api(base, "/v2/consents", { token, method: "POST", body: { purpose: "proactive_transactional", granted: true, policyVersion: "v2" } });
    const requestBody = { scope: { relationshipId: identity.relationshipId, conversationId: identity.conversationId }, summary: "起来喝水",
      schedule: { localDateTime: "2030-08-08T08:00", timezone: "Asia/Shanghai", dstPolicy: "reject_ambiguous", quietHoursPolicy: "deliver_at_requested_time", latePolicy: "skip_if_late" }, channel: "in_app" };
    const disabled = await api(base, "/v2/proactive/events", { token, method: "POST", headers: { "idempotency-key": "reminder-disabled-01" }, body: requestBody });
    assert.equal(disabled.status, 403);
    const malformed = await api(base, "/v2/proactive/events", {
      token, method: "POST", headers: { "idempotency-key": "reminder-malformed-001" }, body: { ...requestBody, hiddenOverride: true },
    });
    assert.equal(malformed.status, 400);
    const setting = await patchCurrent(base, `/v2/settings/proactive?relationshipId=${identity.relationshipId}`, {
      token, idempotencyKey: "setting-proactive-01", body: { transactionalEnabled: true },
    });
    assert.equal(setting.status, 200);
    assert.equal(setting.json.transactionalEnabled, true);
    assert.equal(setting.json.onboardingEnabled, false);
    const recurrence = await api(base, "/v2/proactive/events", {
      token, method: "POST", headers: { "idempotency-key": "reminder-recurring-001" },
      body: { ...requestBody, schedule: { ...requestBody.schedule, recurrenceRRule: "FREQ=DAILY;COUNT=2" } },
    });
    assert.equal(recurrence.status, 501);
    assert.equal(recurrence.json.code, "PORTABLE_FEATURE_UNAVAILABLE");
    const interactiveLatePolicy = await api(base, "/v2/proactive/events", {
      token, method: "POST", headers: { "idempotency-key": "reminder-ask-001" },
      body: { ...requestBody, schedule: { ...requestBody.schedule, latePolicy: "ask_on_create" } },
    });
    assert.equal(interactiveLatePolicy.status, 501);
    const created = await api(base, "/v2/proactive/events", { token, method: "POST", headers: { "idempotency-key": "reminder-created-001" }, body: requestBody });
    assert.equal(created.status, 201);
    assert.equal(created.json.kind, "transactional_reminder");
    assert.match(created.json.schedule.dueAtUtc, /T00:00:00\.000Z$/);
    const listed = await api(base, `/v2/proactive/events?relationshipId=${identity.relationshipId}`, { token });
    assert.equal(listed.json.items.length, 1);

    const secretReminder = await api(base, "/v2/proactive/events", {
      token, method: "POST", headers: { "idempotency-key": "reminder-private-redact-01" },
      body: { ...requestBody, summary: "提醒我使用 sk-abcdefghijklmnop" },
    });
    assert.equal(secretReminder.status, 201);
    assert.doesNotMatch(secretReminder.json.summary, /sk-abcdefghijklmnop/);
    assert.match(secretReminder.json.summary, /已隐藏敏感信息/);

    const otherIdentity = scope("bob");
    const otherToken = createAccessToken(otherIdentity, secret);
    await api(base, "/v2/consents", { token: otherToken, method: "POST", body: { purpose: "proactive_transactional", granted: true, policyVersion: "v2" } });
    await patchCurrent(base, `/v2/settings/proactive?relationshipId=${otherIdentity.relationshipId}`, {
      token: otherToken, idempotencyKey: "setting-proactive-bob-01", body: { transactionalEnabled: true },
    });
    const otherBody = { ...requestBody, scope: { relationshipId: otherIdentity.relationshipId, conversationId: otherIdentity.conversationId } };
    const otherCreated = await api(base, "/v2/proactive/events", {
      token: otherToken, method: "POST", headers: { "idempotency-key": "reminder-created-001" }, body: otherBody,
    });
    assert.equal(otherCreated.status, 201);
    assert.notEqual(otherCreated.json.eventId, created.json.eventId);
    const otherListed = await api(base, `/v2/proactive/events?relationshipId=${otherIdentity.relationshipId}`, { token: otherToken });
    assert.deepEqual(otherListed.json.items.map((event) => event.eventId), [otherCreated.json.eventId]);

    const occurrences = await runtimeRepository.listOccurrences({ eventId: created.json.eventId, scope: identity });
    await runtimeRepository.updateOccurrence(occurrences[0].id, { state: "outbox_committed" });
    const submittedEvent = await api(base, `/v2/proactive/events/${created.json.eventId}`, { token });
    const falseCancellation = await api(base, `/v2/proactive/events/${created.json.eventId}`, {
      token, method: "DELETE", headers: { "idempotency-key": "submitted-event-delete-01", "if-match": submittedEvent.headers.get("etag") },
    });
    assert.equal(falseCancellation.status, 409);
  });
});
