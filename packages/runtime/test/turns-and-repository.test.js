import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileRuntimeRepository,
  IdempotencyConflictError,
  InMemoryRuntimeRepository,
  StaleLeaseError,
  TurnCoordinator,
  TurnStateError,
} from "../src/index.js";

const scope = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  relationshipId: "relationship-a",
  companionId: "companion-a",
  conversationId: "conversation-a",
});

function coordinator(repository, overrides = {}) {
  return new TurnCoordinator({
    repository,
    clock: () => Date.parse("2026-08-08T08:00:00.000Z"),
    privacyScreen: async ({ content }) => ({
      outcome: "allow",
      storedContent: content,
      policyVersion: "test-v1",
      reason: "test",
    }),
    contextCompiler: async ({ scope: eventScope, repository: repo }) => {
      const events = await repo.listEvents({ scope: eventScope });
      return { messages: events.map(({ role, content }) => ({ role, content })), tokenEstimate: 8 };
    },
    ...overrides,
  });
}

test("prepare/commit is idempotent and preserves real role events", async () => {
  const repository = new InMemoryRuntimeRepository();
  const turns = coordinator(repository);
  const prepared = await turns.prepare({ scope, requestId: "request-1", userContent: "请记住我喜欢火锅" });
  assert.equal(prepared.state, "prepared");
  assert.equal(prepared.preparedContext.messages[0].role, "user");

  const committed = await turns.commit({ turnId: prepared.id, assistantContent: "记住了。" });
  const repeated = await turns.commit({ turnId: prepared.id, assistantContent: "这次内容被忽略，因为已提交" });
  assert.equal(committed.state, "committed");
  assert.equal(repeated.assistantEventId, committed.assistantEventId);
  const events = await repository.listEvents({ scope });
  assert.deepEqual(events.map(({ role }) => role), ["user", "assistant"]);
  assert.equal(events[1].content, "记住了。");
});

test("relationship is part of runtime isolation and memory settings enforce dependencies", async () => {
  const repository = new InMemoryRuntimeRepository();
  await repository.appendEvent({ id: "relationship-event", scope, role: "user", type: "chat_message", content: "A", contentHash: "a" });
  const otherRelationship = { ...scope, relationshipId: "relationship-b" };
  assert.deepEqual(await repository.listEvents({ scope: otherRelationship }), []);
  const defaults = await repository.getMemorySettings(scope);
  assert.equal(defaults.extractionEnabled, false);
  assert.equal(defaults.summarizationEnabled, false);
  assert.equal(defaults.semanticIndexEnabled, false);
  assert.equal(defaults.embeddingEnabled, false);
  await assert.rejects(() => repository.setMemorySettings(scope, { embeddingEnabled: true }), /embedding requires semantic index/);
  const settings = await repository.setMemorySettings(scope, { semanticIndexEnabled: true, embeddingEnabled: true });
  assert.equal(settings.embeddingEnabled, true);
  assert.equal((await repository.getMemorySettings(scope)).revision, 1);
  await assert.rejects(() => repository.setMemorySettings(scope, { semanticIndexEnabled: false }), /embedding requires semantic index/);
});

test("portable runtime bounds raw event content unless archive is explicitly enabled", async () => {
  const repository = new InMemoryRuntimeRepository();
  for (let index = 1; index <= 82; index += 1) {
    await repository.appendEvent({ id: `bounded-${index}`, scope, role: "user", type: "chat_message", content: `message ${index}`, contentHash: `hash-${index}` });
  }
  const bounded = await repository.listEvents({ scope });
  assert.equal(bounded.length, 82);
  assert.equal(bounded[0].content, null);
  assert.equal(bounded[0].contentHash, "hash-1");
  assert.equal(bounded[1].storageState, "content_pruned");
  assert.equal(bounded[2].content, "message 3");
  assert.equal(await repository.getTaskCursor(scope, "memory-extraction"), 2);

  await repository.setMemorySettings(scope, { rawArchiveEnabled: true });
  for (let index = 83; index <= 90; index += 1) {
    await repository.appendEvent({ id: `archived-${index}`, scope, role: "user", type: "chat_message", content: `message ${index}`, contentHash: `hash-${index}` });
  }
  assert.equal((await repository.listEvents({ scope })).at(-1).content, "message 90");

  await repository.setMemorySettings(scope, { rawArchiveEnabled: false, retentionMode: "ephemeral" });
  const repruned = await repository.listEvents({ scope });
  assert.equal(repruned.filter((event) => event.content != null).length, 20);
  assert.equal(repruned.at(-1).content, "message 90");
});

test("same request id with different content is rejected", async () => {
  const repository = new InMemoryRuntimeRepository();
  const turns = coordinator(repository);
  await turns.prepare({ scope, requestId: "same", userContent: "第一条" });
  await assert.rejects(
    turns.prepare({ scope, requestId: "same", userContent: "被替换的第二条" }),
    IdempotencyConflictError,
  );
});

test("privacy deny stores a receipt but never stores raw event text", async () => {
  const repository = new InMemoryRuntimeRepository();
  const turns = coordinator(repository, {
    privacyScreen: async () => ({ outcome: "deny", policyVersion: "dlp-v9", reason: "secret" }),
  });
  const result = await turns.prepare({ scope, requestId: "denied", userContent: "sk-super-secret-value" });
  assert.equal(result.state, "failed");
  assert.equal((await repository.listEvents({ scope })).length, 0);
  const receipt = await repository.getPrivacyReceipt(result.privacyReceiptId);
  assert.equal(receipt.outcome, "deny");
  assert.equal(JSON.stringify(repository.exportState()).includes("sk-super-secret-value"), false);
});

test("invalid state transition is rejected", async () => {
  const repository = new InMemoryRuntimeRepository();
  const turns = coordinator(repository);
  const prepared = await turns.prepare({ scope, requestId: "state", userContent: "hello" });
  await turns.commit({ turnId: prepared.id, assistantContent: "hi" });
  await assert.rejects(turns.fail(prepared.id, new Error("too late")), TurnStateError);
});

test("file repository persists scheduled jobs across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "heartmemory-runtime-"));
  const filePath = join(directory, "runtime.json");
  const first = await FileRuntimeRepository.open(filePath);
  const job = await first.enqueueJob({ type: "test.persist", payload: { safe: true }, idempotencyKey: "persist-1" });
  const second = await FileRuntimeRepository.open(filePath);
  assert.equal((await second.getJob(job.id)).state, "scheduled");
  assert.equal((await readFile(filePath, "utf8")).includes("test.persist"), true);
});

test("expired lease can be reclaimed and stale worker cannot commit", async () => {
  const repository = new InMemoryRuntimeRepository();
  const job = await repository.enqueueJob({ type: "lease", dueAt: 0 });
  const [first] = await repository.claimDueJobs({ workerId: "worker-1", now: 0, leaseMs: 100 });
  const [second] = await repository.claimDueJobs({ workerId: "worker-2", now: 101, leaseMs: 100 });
  assert.equal(second.fencingToken, first.fencingToken + 1);
  await assert.rejects(
    repository.completeJob({ jobId: job.id, workerId: "worker-1", fencingToken: first.fencingToken }),
    StaleLeaseError,
  );
  await repository.completeJob({ jobId: job.id, workerId: "worker-2", fencingToken: second.fencingToken });
  assert.equal((await repository.getJob(job.id)).state, "succeeded");
});

test("event replay is idempotent while queue keys reject changed payloads", async () => {
  const repository = new InMemoryRuntimeRepository();
  const event = { id: "event-repeat", scope, role: "user", type: "chat_message", content: "same", contentHash: "same-hash" };
  const first = await repository.appendEvent(event);
  const repeated = await repository.appendEvent(event);
  assert.equal(repeated.sequenceNo, first.sequenceNo);
  await repository.enqueueJob({ type: "strict", payload: { version: 1 }, idempotencyKey: "strict-key" });
  await assert.rejects(
    repository.enqueueJob({ type: "strict", payload: { version: 2 }, idempotencyKey: "strict-key" }),
    IdempotencyConflictError,
  );
});

test("telemetry and background planner failures cannot undo a valid assistant commit", async () => {
  const repository = new InMemoryRuntimeRepository();
  const turns = coordinator(repository, {
    hooks: { audit: async () => { throw new Error("audit sink down"); } },
    signalPlanner: { plan: async () => { throw new Error("job database down"); } },
  });
  const prepared = await turns.prepare({ scope, requestId: "degraded-commit", userContent: "你好" });
  const committed = await turns.commit({ turnId: prepared.id, assistantContent: "我在。" });
  assert.equal(committed.state, "committed");
  assert.deepEqual(committed.backgroundJobIds, []);
});

test("commit-time policy recheck can fail a prepared turn before assistant persistence", async () => {
  const repository = new InMemoryRuntimeRepository();
  const turns = coordinator(repository, {
    commitPolicyCheck: async () => ({ allowed: false, reason: "consent_revoked" }),
  });
  const prepared = await turns.prepare({ scope, requestId: "recheck", userContent: "准备中" });
  await assert.rejects(turns.commit({ turnId: prepared.id, assistantContent: "不应保存" }), /consent_revoked/u);
  assert.equal((await repository.getTurn(prepared.id)).state, "failed");
  const events = await repository.listEvents({ scope });
  assert.deepEqual(events.map(({ role }) => role), ["user"]);
});
