import assert from "node:assert/strict";
import test from "node:test";

import {
  BudgetExceededError,
  CostBudget,
  DurableJobWorker,
  DurableOutboxWorker,
  InMemoryRuntimeRepository,
  InMemoryTelemetryHooks,
  MockDeliveryProvider,
  MockModelAdapter,
  MockMemoryProviderClient,
  OpenAICompatibleEmbeddingAdapter,
  OpenAICompatibleModelAdapter,
  ProactiveService,
  ProviderRegistry,
  ScopedMemoryProviderAdapter,
  createMeteredModelAdapter,
  createResilientContextCompiler,
} from "../src/index.js";

const scope = {
  tenantId: "tenant-p",
  userId: "user-p",
  relationshipId: "relationship-p",
  companionId: "companion-p",
  conversationId: "conversation-p",
};

async function enabledRepository(now) {
  const repository = new InMemoryRuntimeRepository();
  await repository.setProactivePolicy(scope, {
    masterEnabled: true,
    timeZone: "UTC",
    quietHours: { enabled: false, start: "22:00", end: "08:00", timeZone: "UTC" },
  }, now);
  await repository.setConsent(scope, "proactive_transactional", true, now);
  return repository;
}

test("successful proactive occurrence is delivered once and written back as assistant event", async () => {
  const now = Date.parse("2026-08-08T12:00:00.000Z");
  const repository = await enabledRepository(now);
  const provider = new MockDeliveryProvider();
  const service = new ProactiveService({
    repository,
    providerRegistry: new ProviderRegistry({ default: provider }),
    clock: () => now,
  });
  const scheduled = await service.schedule({
    scope,
    eventId: "alarm-1",
    occurrenceKey: "2026-08-08T12:00Z",
    kind: "transactional_reminder",
    scheduledFor: now,
    summary: "提醒喝水",
    templateText: "该喝水啦。",
  });
  const duplicate = await service.schedule({
    scope,
    eventId: "alarm-1",
    occurrenceKey: "2026-08-08T12:00Z",
    kind: "transactional_reminder",
    scheduledFor: now,
    summary: "提醒喝水",
    templateText: "该喝水啦。",
  });
  assert.equal(duplicate.occurrence.id, scheduled.occurrence.id);
  assert.deepEqual(scheduled.job.scope, scope);

  await new DurableJobWorker({ repository, handlers: service.jobHandlers(), clock: () => now }).runUntilIdle();
  await new DurableOutboxWorker({ repository, handlers: service.outboxHandlers(), clock: () => now }).runUntilIdle();
  assert.equal(provider.calls.length, 1);
  assert.equal((await repository.getOccurrence(scheduled.occurrence.id)).state, "delivered");
  const events = await repository.listEvents({ scope });
  assert.equal(events.length, 1);
  assert.equal(events[0].role, "assistant");
  assert.equal(events[0].type, "proactive_outbound");
  assert.equal(events[0].content, "该喝水啦。");
});

test("revoked consent wins over already queued outbound", async () => {
  const now = Date.parse("2026-08-08T12:00:00.000Z");
  const repository = await enabledRepository(now);
  const provider = new MockDeliveryProvider();
  const service = new ProactiveService({ repository, providerRegistry: new ProviderRegistry({ default: provider }), clock: () => now });
  const { occurrence } = await service.schedule({
    scope,
    eventId: "alarm-revoke",
    occurrenceKey: "once",
    kind: "transactional_reminder",
    scheduledFor: now,
    summary: "一次提醒",
  });
  await new DurableJobWorker({ repository, handlers: service.jobHandlers(), clock: () => now }).runUntilIdle();
  await repository.setConsent(scope, "proactive_transactional", false, now + 1);
  await new DurableOutboxWorker({ repository, handlers: service.outboxHandlers(), clock: () => now + 1 }).runUntilIdle();
  assert.equal(provider.calls.length, 0);
  assert.equal((await repository.getOccurrence(occurrence.id)).state, "cancelled");
});

test("expired or seriously late reminders are cancelled before generation", async () => {
  const now = Date.parse("2026-08-08T12:10:01.000Z");
  const repository = await enabledRepository(now);
  const service = new ProactiveService({ repository, clock: () => now });
  const late = await service.schedule({
    scope,
    eventId: "alarm-late",
    occurrenceKey: "late-once",
    kind: "transactional_reminder",
    scheduledFor: "2026-08-08T12:00:00.000Z",
    summary: "已经太迟的提醒",
    metadata: { schedule: { latePolicy: "skip_if_late", expiresAt: null } },
  });
  const expired = await service.schedule({
    scope,
    eventId: "alarm-expired",
    occurrenceKey: "expired-once",
    kind: "transactional_reminder",
    scheduledFor: "2026-08-08T12:09:00.000Z",
    summary: "已经过期的提醒",
    metadata: { schedule: { latePolicy: "send_until_expiry", expiresAt: "2026-08-08T12:10:00.000Z" } },
  });
  await new DurableJobWorker({ repository, handlers: service.jobHandlers(), clock: () => now }).runUntilIdle();
  assert.equal((await repository.getOccurrence(late.occurrence.id)).state, "cancelled");
  assert.equal((await repository.getOccurrence(expired.occurrence.id)).state, "cancelled");
  assert.equal((await repository.listOutbox()).length, 0);
});

test("proactive content must pass the final egress policy before outbox persistence", async () => {
  const now = Date.parse("2026-08-08T12:00:00.000Z");
  const repository = await enabledRepository(now);
  const service = new ProactiveService({
    repository,
    clock: () => now,
    egressPolicyCheck: async () => ({ allowed: false, reason: "relationship_safety_denied" }),
  });
  const { occurrence } = await service.schedule({
    scope,
    eventId: "alarm-egress-denied",
    occurrenceKey: "egress-once",
    kind: "transactional_reminder",
    scheduledFor: now,
    summary: "不应发出的提醒",
  });
  await new DurableJobWorker({ repository, handlers: service.jobHandlers(), clock: () => now }).runUntilIdle();
  assert.equal((await repository.getOccurrence(occurrence.id)).state, "cancelled");
  assert.equal((await repository.listOutbox()).length, 0);
});

test("quiet hours defer relationship-safe scheduling and only exact reminder may bypass", async () => {
  const now = Date.parse("2026-08-08T12:00:00.000Z");
  const repository = await enabledRepository(now);
  await repository.setProactivePolicy(scope, {
    quietHours: { enabled: true, start: "11:00", end: "13:00", timeZone: "UTC" },
  }, now);
  const service = new ProactiveService({ repository, providerRegistry: new ProviderRegistry({ default: new MockDeliveryProvider() }), clock: () => now });
  const scheduled = await service.schedule({
    scope,
    eventId: "quiet",
    occurrenceKey: "quiet-once",
    kind: "transactional_reminder",
    scheduledFor: now,
    summary: "稍后提醒",
  });
  await new DurableJobWorker({ repository, handlers: service.jobHandlers(), clock: () => now }).tick();
  const job = await repository.getJob(scheduled.job.id);
  assert.equal(job.state, "scheduled");
  assert.equal(job.dueAt, "2026-08-08T13:00:00.000Z");
  await assert.rejects(
    service.schedule({ scope, occurrenceKey: "illegal", kind: "marketing", scheduledFor: now, summary: "广告", quietHoursPolicy: "deliver_at_requested_time" }),
    /Only an explicit transactional reminder/u,
  );
});

test("OpenAI-compatible adapters are testable with injected fetch and never need network", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), authorization: init.headers.authorization });
    if (url.endsWith("/embeddings")) {
      return new Response(JSON.stringify({ model: "embed-test", data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 2 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ model: "chat-test", choices: [{ message: { content: "你好" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }), { status: 200, headers: { "x-request-id": "req-test" } });
  };
  const model = new OpenAICompatibleModelAdapter({ baseUrl: "https://unit.invalid/v1", apiKey: "secret", model: "chat-test", fetchImpl });
  const response = await model.complete({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.text, "你好");
  const embedding = new OpenAICompatibleEmbeddingAdapter({ baseUrl: "https://unit.invalid/v1", apiKey: "secret", model: "embed-test", fetchImpl });
  assert.deepEqual((await embedding.embed({ input: "猫" })).vectors, [[0.1, 0.2]]);
  assert.deepEqual(requests.map(({ url }) => url), ["https://unit.invalid/v1/chat/completions", "https://unit.invalid/v1/embeddings"]);
});

test("metered model records cost and enforces hard per-call budget", async () => {
  const telemetry = new InMemoryTelemetryHooks();
  const adapter = createMeteredModelAdapter({
    adapter: new MockModelAdapter({ responses: ["ok"] }),
    hooks: telemetry,
    budget: new CostBudget({ perCallInputLimit: 50, perCallOutputLimit: 10, dailyTokenLimit: 100 }),
    pricing: { inputPerMillion: 1, outputPerMillion: 2 },
  });
  await adapter.complete({ scope, operation: "small", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 5 });
  assert.equal(telemetry.costEvents.length, 1);
  assert.equal(telemetry.costEvents[0].success, true);
  await assert.rejects(
    adapter.complete({ scope, operation: "too-large", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 11 }),
    BudgetExceededError,
  );
});

test("context compiler degrades to recent real-role window without another model call", async () => {
  const repository = new InMemoryRuntimeRepository();
  await repository.appendEvent({ id: "recent", scope, role: "user", type: "chat_message", content: "最近的话", contentHash: "recent-hash" });
  const telemetry = new InMemoryTelemetryHooks();
  const compiler = createResilientContextCompiler({
    repository,
    hooks: telemetry,
    primary: async () => { throw new Error("vector store unavailable"); },
  });
  const context = await compiler({ scope, turnId: "turn-degraded" });
  assert.equal(context.degraded, true);
  assert.deepEqual(context.messages, [{ role: "user", content: "最近的话" }]);
  assert.equal(telemetry.auditEvents[0].action, "context.degraded_to_recent_window");
});

test("external memory provider adapter never shares a default namespace across users", async () => {
  const client = new MockMemoryProviderClient();
  const provider = new ScopedMemoryProviderAdapter({ client, namespaceKey: "unit-secret" });
  const otherScope = { ...scope, userId: "another-user", conversationId: "other-conversation" };
  await provider.upsert({ scope, record: { id: "claim-1", text: "喜欢火锅" }, idempotencyKey: "upsert-1" });
  assert.equal((await provider.search({ scope, query: "火锅" })).length, 1);
  assert.equal((await provider.search({ scope: otherScope, query: "火锅" })).length, 0);
  assert.notEqual(provider.namespace(scope), provider.namespace(otherScope));
});
