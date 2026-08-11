import assert from "node:assert/strict";
import test from "node:test";

import {
  BackgroundSignalPlanner,
  DurableJobWorker,
  InMemoryRuntimeRepository,
  MockModelAdapter,
  RetryableJobError,
  createMemoryBackgroundHandlers,
} from "../src/index.js";

const scope = {
  tenantId: "tenant-s",
  userId: "user-s",
  relationshipId: "relationship-s",
  companionId: "companion-s",
  conversationId: "conversation-s",
};

async function append(repository, count, prefix = "普通消息") {
  for (let index = 1; index <= count; index += 1) {
    await repository.appendEvent({
      id: `${prefix}-${index}`,
      scope,
      role: index % 2 ? "user" : "assistant",
      type: "chat_message",
      content: `${prefix} ${index}`,
      contentHash: `hash-${prefix}-${index}`,
    });
  }
}

test("program signal gate avoids a model job for ordinary short chat", async () => {
  const repository = new InMemoryRuntimeRepository();
  await append(repository, 4);
  const planner = new BackgroundSignalPlanner({ repository, extractionMinUserMessages: 4, summaryMinEvents: 20 });
  assert.deepEqual(await planner.plan({ scope }), []);
});

test("explicit remember cue schedules exact evidence window", async () => {
  const repository = new InMemoryRuntimeRepository();
  await repository.appendEvent({
    id: "remember-1",
    scope,
    role: "user",
    type: "chat_message",
    content: "请记住我的猫叫小白",
    contentHash: "remember-hash",
  });
  const planner = new BackgroundSignalPlanner({ repository, summaryMinEvents: 20 });
  const [job] = await planner.plan({ scope });
  assert.equal(job.type, "memory.extract_candidates");
  assert.deepEqual(job.payload.eventIds, ["remember-1"]);
  assert.equal(job.payload.explicit, true);
});

test("candidate handler validates evidence and program advances cursor", async () => {
  const repository = new InMemoryRuntimeRepository();
  await repository.appendEvent({ id: "e1", scope, role: "user", type: "chat_message", content: "记住猫叫小白", contentHash: "h1" });
  const planner = new BackgroundSignalPlanner({ repository });
  const [spec] = await planner.plan({ scope });
  await repository.enqueueJob(spec);
  const stored = [];
  const model = new MockModelAdapter({ responses: [{
    schemaVersion: 2,
    candidates: [{
      schemaVersion: 2,
      candidateKind: "identity",
      realm: "real_world",
      attribution: { assertedByType: "user", epistemicBasis: "explicit_memory_request" },
      subjectRef: "user",
      predicateKey: "pet.cat.name",
      value: "小白",
      canonicalText: "用户的猫叫小白",
      polarity: "positive",
      modality: "asserted",
      temporal: { kind: "timeless", precision: "unknown", validFrom: null, validTo: null, sourceTimezone: null, recurrenceRRule: null },
      evidenceMessageIds: ["e1"],
      sensitivity: "personal",
      confidenceBand: "high",
      proposedAction: "keep_candidate",
    }],
  }] });
  const handlers = createMemoryBackgroundHandlers({ repository, model, candidateSink: async (value) => stored.push(value) });
  const worker = new DurableJobWorker({ repository, handlers, workerId: "candidate-worker" });
  await worker.runUntilIdle();
  assert.equal(stored.length, 1);
  assert.equal(await repository.getTaskCursor(scope, "memory-extraction"), 1);
  assert.equal(model.calls.length, 1);
});

test("invalid model evidence is dead-lettered without a repair call or cursor advance", async () => {
  const repository = new InMemoryRuntimeRepository();
  await repository.appendEvent({ id: "e2", scope, role: "user", type: "chat_message", content: "请记住边界", contentHash: "h2" });
  const [spec] = await new BackgroundSignalPlanner({ repository }).plan({ scope });
  const queued = await repository.enqueueJob(spec);
  const model = new MockModelAdapter({ responses: [{
    schemaVersion: 2,
    candidates: [{
      schemaVersion: 2,
      candidateKind: "identity",
      realm: "real_world",
      attribution: { assertedByType: "user", epistemicBasis: "explicit_statement" },
      subjectRef: "user",
      predicateKey: "fake.value",
      value: "伪造",
      canonicalText: "伪造",
      polarity: "positive",
      modality: "asserted",
      temporal: { kind: "unknown", precision: "unknown" },
      evidenceMessageIds: ["not-allowed"],
      sensitivity: "ordinary",
      confidenceBand: "high",
      proposedAction: "keep_candidate",
    }],
  }] });
  const worker = new DurableJobWorker({ repository, handlers: createMemoryBackgroundHandlers({ repository, model }) });
  await worker.tick();
  assert.equal((await repository.getJob(queued.id)).state, "dead_letter");
  assert.equal(await repository.getTaskCursor(scope, "memory-extraction"), 0);
  assert.equal(model.calls.length, 1);
});

test("segment model cannot choose coverage and cursor moves only after sink", async () => {
  const repository = new InMemoryRuntimeRepository();
  await append(repository, 6, "片段");
  const planner = new BackgroundSignalPlanner({
    repository,
    extractionMinUserMessages: 99,
    extractionTokenThreshold: 99_999,
    summaryMinEvents: 4,
    summarySafetyDistance: 2,
  });
  const [spec] = await planner.plan({ scope });
  assert.equal(spec.type, "memory.segment_summary");
  await repository.enqueueJob(spec);
  const model = new MockModelAdapter({ handler: ({ messages }) => {
    const input = JSON.parse(messages[1].content);
    return {
      schemaVersion: 2,
      summary: "用户与助手进行了普通对话。",
      emotionalArc: "平稳",
      openThreads: [],
      uncertainties: [],
      sourceMessageIds: input.allowedMessageIds,
    };
  } });
  let saved = false;
  const handlers = createMemoryBackgroundHandlers({ repository, model, summarySink: async () => { saved = true; } });
  await new DurableJobWorker({ repository, handlers }).runUntilIdle();
  assert.equal(saved, true);
  assert.equal(await repository.getSegmentCursor(scope), spec.payload.toSequence);
});

test("retryable worker failure uses retry_wait while programmer error dead-letters", async () => {
  const repository = new InMemoryRuntimeRepository();
  const retry = await repository.enqueueJob({ type: "retry", dueAt: 0 });
  const bad = await repository.enqueueJob({ type: "bad", dueAt: 0 });
  const worker = new DurableJobWorker({
    repository,
    clock: () => 0,
    handlers: {
      retry: async () => { throw new RetryableJobError("temporary"); },
      bad: async () => { throw new Error("invalid contract"); },
    },
    backoff: { jitter: 0 },
  });
  await worker.tick();
  assert.equal((await repository.getJob(retry.id)).state, "retry_wait");
  assert.equal((await repository.getJob(bad.id)).state, "dead_letter");
});

test("worker observes fencing: losing a lease never overwrites the new owner", async () => {
  const repository = new InMemoryRuntimeRepository();
  const queued = await repository.enqueueJob({ type: "slow", dueAt: 0 });
  let now = 0;
  let reclaimed;
  const worker = new DurableJobWorker({
    repository,
    workerId: "old-worker",
    clock: () => now,
    leaseMs: 100,
    handlers: {
      slow: async () => {
        now = 101;
        [reclaimed] = await repository.claimDueJobs({ workerId: "new-worker", now, leaseMs: 100 });
        return { oldResult: true };
      },
    },
  });
  await worker.tick();
  const stillLeased = await repository.getJob(queued.id);
  assert.equal(stillLeased.leaseOwner, "new-worker");
  assert.equal(stillLeased.state, "leased");
  await repository.completeJob({ jobId: queued.id, workerId: "new-worker", fencingToken: reclaimed.fencingToken, result: { newResult: true }, now });
  assert.deepEqual((await repository.getJob(queued.id)).result, { newResult: true });
});
