import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  PolicyChangedError,
  RuntimeInvariantError,
  StaleLeaseError,
  TurnStateError,
  IdempotencyConflictError,
} from "./errors.js";
import {
  assertScope,
  clone,
  contentDigest,
  conversationKey,
  epochMs,
  hashText,
  iso,
  mergeUnique,
  newId,
  scopeKey,
} from "./utils.js";

const SCHEMA_VERSION = 2;
const PORTABLE_RECENT_EVENT_LIMIT = 80;
const PORTABLE_EPHEMERAL_EVENT_LIMIT = 20;

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    turns: {},
    turnByRequestKey: {},
    privacyReceipts: {},
    events: {},
    conversationEventIds: {},
    conversationSequences: {},
    jobs: {},
    jobByIdempotencyKey: {},
    outbox: {},
    outboxByIdempotencyKey: {},
    proactiveEvents: {},
    occurrences: {},
    occurrenceByKey: {},
    proactivePolicies: {},
    memorySettings: {},
    segmentCursors: {},
    taskCursors: {},
  };
}

function normalizeState(input) {
  const base = emptyState();
  if (!input || typeof input !== "object") return base;
  if (input.schemaVersion === 1) {
    const migrated = { ...base, ...input, schemaVersion: SCHEMA_VERSION, memorySettings: {} };
    pruneLoadedConversationContent(migrated);
    return migrated;
  }
  if (input.schemaVersion !== SCHEMA_VERSION) {
    throw new RuntimeInvariantError(
      `Unsupported runtime repository schema ${input.schemaVersion}; expected ${SCHEMA_VERSION}`,
    );
  }
  const normalized = { ...base, ...input };
  pruneLoadedConversationContent(normalized);
  return normalized;
}

function pruneLoadedConversationContent(state) {
  for (const ids of Object.values(state.conversationEventIds ?? {})) {
    const scopedEvent = ids.map((id) => state.events?.[id]).find((event) => event?.scope);
    if (scopedEvent) pruneConversationContentDraft(state, scopedEvent.scope);
  }
}

function defaultMemorySettings(scope, now = Date.now()) {
  return {
    scope: clone(scope),
    // Model-backed and derived-index capabilities are opt-in. A deployment
    // must configure its provider, budget, evaluation and consent flow before
    // changing these values; a fresh repository must never spend tokens by
    // surprise.
    extractionEnabled: false,
    summarizationEnabled: false,
    semanticIndexEnabled: false,
    embeddingEnabled: false,
    externalEmbeddingEnabled: false,
    externalMemoryProviderEnabled: false,
    deepRecallEnabled: false,
    adaptiveProfileEnabled: false,
    analyticsEnabled: false,
    rawArchiveEnabled: false,
    retentionMode: "redacted_only",
    sensitiveMemoryMode: "explicit_confirmation",
    revision: 0,
    updatedAt: iso(now),
  };
}

function sameScope(left, right) {
  return (
    left?.tenantId === right?.tenantId &&
    left?.userId === right?.userId &&
    left?.relationshipId === right?.relationshipId &&
    left?.companionId === right?.companionId &&
    left?.conversationId === right?.conversationId
  );
}

function appendEventDraft(state, event) {
  assertScope(event.scope);
  const existing = state.events[event.id];
  if (existing) {
    const comparableExisting = Object.fromEntries(
      Object.keys(event).map((key) => [key, existing[key]]),
    );
    if (contentDigest(comparableExisting) !== contentDigest(event)) {
      throw new RuntimeInvariantError(`Event id ${event.id} was reused with different content`);
    }
    return existing;
  }

  const key = conversationKey(event.scope);
  const sequenceNo = (state.conversationSequences[key] ?? 0) + 1;
  state.conversationSequences[key] = sequenceNo;
  const stored = {
    ...clone(event),
    sequenceNo,
    createdAt: event.createdAt ?? iso(),
  };
  state.events[stored.id] = stored;
  state.conversationEventIds[key] ??= [];
  state.conversationEventIds[key].push(stored.id);
  pruneConversationContentDraft(state, event.scope, stored.createdAt);
  return stored;
}

function pruneConversationContentDraft(state, scope, prunedAt = iso()) {
  const settings = state.memorySettings[scopeKey(scope)] ?? defaultMemorySettings(scope);
  if (settings.rawArchiveEnabled) return [];
  const key = conversationKey(scope);
  const ids = state.conversationEventIds[key] ?? [];
  const limit = settings.retentionMode === "ephemeral" ? PORTABLE_EPHEMERAL_EVENT_LIMIT : PORTABLE_RECENT_EVENT_LIMIT;
  const expiredIds = ids.slice(0, Math.max(0, ids.length - limit));
  let highestPrunedSequence = 0;
  for (const id of expiredIds) {
    const old = state.events[id];
    if (!old) continue;
    highestPrunedSequence = Math.max(highestPrunedSequence, Number(old.sequenceNo ?? 0));
    if (old.content == null) continue;
    old.content = null;
    old.storageState = "content_pruned";
    old.contentPrunedAt = prunedAt;
  }
  if (highestPrunedSequence > 0) {
    // A disabled or lagging model pipeline may not later process plaintext that
    // retention has already removed. Program-owned cursors skip that range.
    const taskKey = `${key}:memory-extraction`;
    state.taskCursors[taskKey] = Math.max(Number(state.taskCursors[taskKey] ?? 0), highestPrunedSequence);
    state.segmentCursors[key] = Math.max(Number(state.segmentCursors[key] ?? 0), highestPrunedSequence);
  }
  return expiredIds;
}

function mergeCoalescedPayload(existing, incoming) {
  const merged = { ...existing, ...incoming };
  if (existing.eventIds || incoming.eventIds) {
    merged.eventIds = mergeUnique(existing.eventIds, incoming.eventIds);
  }
  if (existing.sourceEventIds || incoming.sourceEventIds) {
    merged.sourceEventIds = mergeUnique(existing.sourceEventIds, incoming.sourceEventIds);
  }
  if (existing.fromSequence || incoming.fromSequence) {
    merged.fromSequence = Math.min(
      ...[existing.fromSequence, incoming.fromSequence].filter(Number.isFinite),
    );
  }
  if (existing.toSequence || incoming.toSequence) {
    merged.toSequence = Math.max(
      ...[existing.toSequence, incoming.toSequence].filter(Number.isFinite),
    );
  }
  return merged;
}

function enqueueJobDraft(state, spec, now = Date.now()) {
  const idempotencyKey = spec.idempotencyKey || null;
  if (idempotencyKey) {
    const existingId = state.jobByIdempotencyKey[idempotencyKey];
    const existing = existingId ? state.jobs[existingId] : null;
    if (existing) {
      if (existing.type !== spec.type || !sameScope(existing.scope, spec.scope)) {
        throw new IdempotencyConflictError(idempotencyKey);
      }
      if (
        spec.coalesce &&
        ["scheduled", "retry_wait", "pending"].includes(existing.state)
      ) {
        existing.payload = mergeCoalescedPayload(existing.payload, spec.payload ?? {});
        existing.dueAt = iso(Math.min(epochMs(existing.dueAt), epochMs(spec.dueAt ?? now)));
        existing.updatedAt = iso(now);
      } else if (contentDigest(existing.payload) !== contentDigest(spec.payload ?? {})) {
        throw new IdempotencyConflictError(idempotencyKey);
      }
      return existing;
    }
  }

  const id = spec.id ?? newId("job");
  const job = {
    id,
    type: spec.type,
    scope: spec.scope ? clone(spec.scope) : null,
    payload: clone(spec.payload ?? {}),
    state: "scheduled",
    dueAt: iso(spec.dueAt ?? now),
    attempts: 0,
    maxAttempts: Math.max(1, Number(spec.maxAttempts ?? 5)),
    idempotencyKey,
    fencingToken: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    result: null,
    createdAt: iso(now),
    updatedAt: iso(now),
  };
  state.jobs[id] = job;
  if (idempotencyKey) state.jobByIdempotencyKey[idempotencyKey] = id;
  return job;
}

function enqueueOutboxDraft(state, spec, now = Date.now()) {
  const idempotencyKey = spec.idempotencyKey;
  if (!idempotencyKey) {
    throw new RuntimeInvariantError("Outbox idempotencyKey is required");
  }
  const existingId = state.outboxByIdempotencyKey[idempotencyKey];
  if (existingId && state.outbox[existingId]) {
    const existing = state.outbox[existingId];
    if (
      existing.kind !== spec.kind ||
      !sameScope(existing.scope, spec.scope) ||
      contentDigest(existing.payload) !== contentDigest(spec.payload ?? {})
    ) {
      throw new IdempotencyConflictError(idempotencyKey);
    }
    return existing;
  }

  const id = spec.id ?? newId("outbox");
  const row = {
    id,
    kind: spec.kind,
    scope: spec.scope ? clone(spec.scope) : null,
    payload: clone(spec.payload ?? {}),
    state: "pending",
    dueAt: iso(spec.dueAt ?? now),
    attempts: 0,
    maxAttempts: Math.max(1, Number(spec.maxAttempts ?? 8)),
    idempotencyKey,
    fencingToken: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    providerReceipt: null,
    createdAt: iso(now),
    updatedAt: iso(now),
  };
  state.outbox[id] = row;
  state.outboxByIdempotencyKey[idempotencyKey] = id;
  return row;
}

function claimRows(rows, { workerId, now, limit, leaseMs, dueStates, filter = null }) {
  const nowMs = epochMs(now);
  const candidates = Object.values(rows)
    .filter((row) => {
      if (dueStates.includes(row.state)) return epochMs(row.dueAt) <= nowMs;
      return row.state === "leased" && row.leaseExpiresAt && epochMs(row.leaseExpiresAt) <= nowMs;
    })
    .filter((row) => !filter || filter(row))
    .sort((a, b) => epochMs(a.dueAt) - epochMs(b.dueAt) || a.createdAt.localeCompare(b.createdAt))
    .slice(0, Math.max(0, limit));

  for (const row of candidates) {
    row.state = "leased";
    row.fencingToken = Number(row.fencingToken || 0) + 1;
    row.leaseOwner = workerId;
    row.leaseExpiresAt = iso(nowMs + leaseMs);
    row.attempts = Number(row.attempts || 0) + 1;
    row.updatedAt = iso(nowMs);
  }
  return candidates;
}

function assertLease(row, kind, { workerId, fencingToken }) {
  if (
    !row ||
    row.state !== "leased" ||
    row.leaseOwner !== workerId ||
    row.fencingToken !== fencingToken
  ) {
    throw new StaleLeaseError(kind, row?.id ?? "missing", fencingToken);
  }
}

function defaultProactivePolicy(scope, now = Date.now()) {
  return {
    scope: clone(scope),
    revision: 0,
    masterEnabled: false,
    categorySwitches: {
      transactional_reminder: true,
      onboarding_in_app: true,
      relationship_proactive: false,
      marketing: false,
    },
    timeZone: "UTC",
    quietHours: {
      enabled: false,
      start: "22:00",
      end: "08:00",
      timeZone: "UTC",
    },
    consents: {},
    updatedAt: iso(now),
  };
}

export class InMemoryRuntimeRepository {
  constructor({ initialState } = {}) {
    this._state = normalizeState(clone(initialState));
    this._tail = Promise.resolve();
  }

  exportState() {
    return clone(this._state);
  }

  async _persist(_draft) {}

  async _transaction(mutator) {
    const previous = this._tail;
    let release;
    this._tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const draft = clone(this._state);
      const result = await mutator(draft);
      await this._persist(draft);
      this._state = draft;
      return clone(result);
    } finally {
      release();
    }
  }

  async _read(reader) {
    const barrier = this._tail;
    await barrier;
    return clone(await reader(this._state));
  }

  async beginTurn({ turn, privacyReceipt, userEvent }) {
    return this._transaction((state) => {
      if (state.turns[turn.id]) {
        const existing = state.turns[turn.id];
        if (!sameScope(existing.scope, turn.scope) || existing.requestHash !== turn.requestHash) {
          throw new IdempotencyConflictError(turn.requestKey ?? turn.id);
        }
        return existing;
      }
      if (turn.requestKey && state.turnByRequestKey[turn.requestKey]) {
        const existing = state.turns[state.turnByRequestKey[turn.requestKey]];
        if (!sameScope(existing.scope, turn.scope) || existing.requestHash !== turn.requestHash) {
          throw new IdempotencyConflictError(turn.requestKey);
        }
        return existing;
      }
      state.privacyReceipts[privacyReceipt.id] = clone(privacyReceipt);
      const storedEvent = userEvent ? appendEventDraft(state, userEvent) : null;
      const storedTurn = {
        ...clone(turn),
        state: "preparing",
        userEventId: storedEvent?.id ?? null,
        createdAt: turn.createdAt ?? iso(),
        updatedAt: turn.updatedAt ?? iso(),
      };
      state.turns[turn.id] = storedTurn;
      if (turn.requestKey) state.turnByRequestKey[turn.requestKey] = turn.id;
      return storedTurn;
    });
  }

  async finalizePreparedTurn(turnId, patch) {
    return this._transaction((state) => {
      const turn = state.turns[turnId];
      if (!turn) throw new RuntimeInvariantError(`Unknown turn ${turnId}`);
      if (turn.state === "prepared") return turn;
      if (turn.state !== "preparing") throw new TurnStateError(turnId, turn.state, "prepared");
      Object.assign(turn, clone(patch), { state: "prepared", updatedAt: iso() });
      return turn;
    });
  }

  async commitTurn({ turnId, assistantEvent, jobs = [], committedAt = Date.now() }) {
    return this._transaction((state) => {
      const turn = state.turns[turnId];
      if (!turn) throw new RuntimeInvariantError(`Unknown turn ${turnId}`);
      if (turn.state === "committed") return turn;
      if (turn.state !== "prepared") throw new TurnStateError(turnId, turn.state, "committed");
      const storedEvent = appendEventDraft(state, assistantEvent);
      const storedJobs = jobs.map((job) => enqueueJobDraft(state, job, committedAt));
      Object.assign(turn, {
        state: "committed",
        assistantEventId: storedEvent.id,
        committedAt: iso(committedAt),
        updatedAt: iso(committedAt),
        preparedContext: null,
        backgroundJobIds: storedJobs.map((job) => job.id),
        backgroundJobTypes: storedJobs.map((job) => job.type),
      });
      return turn;
    });
  }

  async failTurn(turnId, failure, failedAt = Date.now()) {
    return this._transaction((state) => {
      const turn = state.turns[turnId];
      if (!turn) throw new RuntimeInvariantError(`Unknown turn ${turnId}`);
    if (turn.state === "failed") return turn;
      if (!new Set(["preparing", "prepared"]).has(turn.state)) {
        throw new TurnStateError(turnId, turn.state, "failed");
      }
      Object.assign(turn, {
        state: "failed",
        failure: clone(failure),
        failedAt: iso(failedAt),
        updatedAt: iso(failedAt),
        preparedContext: null,
      });
      return turn;
    });
  }

  async getTurn(turnId) {
    return this._read((state) => state.turns[turnId] ?? null);
  }

  async getPrivacyReceipt(receiptId) {
    return this._read((state) => state.privacyReceipts[receiptId] ?? null);
  }

  async appendEvent(event) {
    return this._transaction((state) => appendEventDraft(state, event));
  }

  async getEvent(eventId) {
    return this._read((state) => state.events[eventId] ?? null);
  }

  async listEvents({ scope, eventIds, fromSequence = 1, toSequence = Infinity, roles, types } = {}) {
    assertScope(scope);
    return this._read((state) => {
      const ids = eventIds ?? state.conversationEventIds[conversationKey(scope)] ?? [];
      const roleSet = roles ? new Set(roles) : null;
      const typeSet = types ? new Set(types) : null;
      return ids
        .map((id) => state.events[id])
        .filter(Boolean)
        .filter((event) => sameScope(event.scope, scope))
        .filter((event) => event.sequenceNo >= fromSequence && event.sequenceNo <= toSequence)
        .filter((event) => !roleSet || roleSet.has(event.role))
        .filter((event) => !typeSet || typeSet.has(event.type))
        .sort((a, b) => a.sequenceNo - b.sequenceNo);
    });
  }

  async enqueueJob(spec) {
    return this._transaction((state) => enqueueJobDraft(state, spec));
  }

  async getJob(jobId) {
    return this._read((state) => state.jobs[jobId] ?? null);
  }

  async listJobs({ states, type } = {}) {
    return this._read((state) =>
      Object.values(state.jobs)
        .filter((job) => !states || states.includes(job.state))
        .filter((job) => !type || job.type === type)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
  }

  async claimDueJobs({ workerId, now = Date.now(), limit = 10, leaseMs = 30_000, types = null }) {
    return this._transaction((state) =>
      claimRows(state.jobs, {
        workerId,
        now,
        limit,
        leaseMs,
        dueStates: ["scheduled", "retry_wait", "pending"],
        filter: types?.length ? (job) => types.includes(job.type) : null,
      }),
    );
  }

  async completeJob({ jobId, workerId, fencingToken, result, now = Date.now() }) {
    return this._transaction((state) => {
      const job = state.jobs[jobId];
      assertLease(job, "job", { workerId, fencingToken });
      Object.assign(job, {
        state: "succeeded",
        result: clone(result ?? null),
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: iso(now),
      });
      return job;
    });
  }

  async retryJob({ jobId, workerId, fencingToken, dueAt, error, now = Date.now() }) {
    return this._transaction((state) => {
      const job = state.jobs[jobId];
      assertLease(job, "job", { workerId, fencingToken });
      const exhausted = job.attempts >= job.maxAttempts;
      Object.assign(job, {
        state: exhausted ? "dead_letter" : "retry_wait",
        dueAt: exhausted ? job.dueAt : iso(dueAt),
        lastError: String(error ?? "unknown error").slice(0, 500),
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: iso(now),
      });
      return job;
    });
  }

  async deadLetterJob({ jobId, workerId, fencingToken, error, now = Date.now() }) {
    return this._transaction((state) => {
      const job = state.jobs[jobId];
      assertLease(job, "job", { workerId, fencingToken });
      Object.assign(job, {
        state: "dead_letter",
        lastError: String(error ?? "non-retryable failure").slice(0, 500),
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: iso(now),
      });
      return job;
    });
  }

  async rescheduleJob({ jobId, workerId, fencingToken, dueAt, reason, now = Date.now() }) {
    return this._transaction((state) => {
      const job = state.jobs[jobId];
      assertLease(job, "job", { workerId, fencingToken });
      Object.assign(job, {
        state: "scheduled",
        dueAt: iso(dueAt),
        lastError: reason ? String(reason).slice(0, 500) : null,
        attempts: Math.max(0, job.attempts - 1),
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: iso(now),
      });
      return job;
    });
  }

  async enqueueOutbox(spec) {
    return this._transaction((state) => enqueueOutboxDraft(state, spec));
  }

  async getOutbox(outboxId) {
    return this._read((state) => state.outbox[outboxId] ?? null);
  }

  async listOutbox({ states, kind } = {}) {
    return this._read((state) =>
      Object.values(state.outbox)
        .filter((row) => !states || states.includes(row.state))
        .filter((row) => !kind || row.kind === kind)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
  }

  async claimDueOutbox({ workerId, now = Date.now(), limit = 10, leaseMs = 30_000 }) {
    return this._transaction((state) =>
      claimRows(state.outbox, {
        workerId,
        now,
        limit,
        leaseMs,
        dueStates: ["pending", "retry_wait"],
      }),
    );
  }

  async retryOutbox({ outboxId, workerId, fencingToken, dueAt, error, now = Date.now() }) {
    return this._transaction((state) => {
      const row = state.outbox[outboxId];
      assertLease(row, "outbox", { workerId, fencingToken });
      const exhausted = row.attempts >= row.maxAttempts;
      Object.assign(row, {
        state: exhausted ? "dead_letter" : "retry_wait",
        dueAt: exhausted ? row.dueAt : iso(dueAt),
        lastError: String(error ?? "unknown error").slice(0, 500),
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: iso(now),
      });
      return row;
    });
  }

  async deadLetterOutbox({ outboxId, workerId, fencingToken, error, now = Date.now() }) {
    return this._transaction((state) => {
      const row = state.outbox[outboxId];
      assertLease(row, "outbox", { workerId, fencingToken });
      Object.assign(row, {
        state: "dead_letter",
        lastError: String(error ?? "non-retryable failure").slice(0, 500),
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: iso(now),
      });
      return row;
    });
  }

  async rescheduleOutbox({ outboxId, workerId, fencingToken, dueAt, reason, now = Date.now() }) {
    return this._transaction((state) => {
      const row = state.outbox[outboxId];
      assertLease(row, "outbox", { workerId, fencingToken });
      Object.assign(row, {
        state: "pending",
        dueAt: iso(dueAt),
        lastError: reason ? String(reason).slice(0, 500) : null,
        attempts: Math.max(0, row.attempts - 1),
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: iso(now),
      });
      return row;
    });
  }

  async cancelOutbox({ outboxId, workerId, fencingToken, reason, now = Date.now() }) {
    return this._transaction((state) => {
      const row = state.outbox[outboxId];
      assertLease(row, "outbox", { workerId, fencingToken });
      Object.assign(row, {
        state: "cancelled",
        lastError: String(reason ?? "policy denied").slice(0, 500),
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: iso(now),
      });
      const occurrenceId = row.payload?.occurrenceId;
      if (occurrenceId && state.occurrences[occurrenceId]) {
        Object.assign(state.occurrences[occurrenceId], {
          state: "cancelled",
          cancelReason: row.lastError,
          updatedAt: iso(now),
        });
      }
      return row;
    });
  }

  async setProactivePolicy(scope, patch, now = Date.now()) {
    assertScope(scope);
    return this._transaction((state) => {
      const key = scopeKey(scope);
      const current = state.proactivePolicies[key] ?? defaultProactivePolicy(scope, now);
      const next = {
        ...current,
        ...clone(patch),
        categorySwitches: {
          ...current.categorySwitches,
          ...(patch.categorySwitches ?? {}),
        },
        quietHours: { ...current.quietHours, ...(patch.quietHours ?? {}) },
        consents: { ...current.consents },
        revision: current.revision + 1,
        updatedAt: iso(now),
      };
      state.proactivePolicies[key] = next;
      return next;
    });
  }

  async setConsent(scope, purpose, granted, now = Date.now()) {
    assertScope(scope);
    return this._transaction((state) => {
      const key = scopeKey(scope);
      const current = state.proactivePolicies[key] ?? defaultProactivePolicy(scope, now);
      const revision = current.revision + 1;
      current.consents[purpose] = {
        purpose,
        granted: Boolean(granted),
        revision,
        effectiveAt: iso(now),
      };
      current.revision = revision;
      current.updatedAt = iso(now);
      state.proactivePolicies[key] = current;
      return current;
    });
  }

  async getProactivePolicy(scope) {
    assertScope(scope);
    return this._read((state) =>
      state.proactivePolicies[scopeKey(scope)] ?? defaultProactivePolicy(scope),
    );
  }

  async getMemorySettings(scope) {
    assertScope(scope);
    return this._read((state) => state.memorySettings[scopeKey(scope)] ?? defaultMemorySettings(scope));
  }

  async setMemorySettings(scope, patch, now = Date.now()) {
    assertScope(scope);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new RuntimeInvariantError("memory settings patch is required");
    return this._transaction((state) => {
      const key = scopeKey(scope);
      const current = state.memorySettings[key] ?? defaultMemorySettings(scope, now);
      const next = { ...current, ...clone(patch), scope: clone(scope), revision: current.revision + 1, updatedAt: iso(now) };
      if (next.embeddingEnabled && !next.semanticIndexEnabled) throw new RuntimeInvariantError("embedding requires semantic index");
      if (next.externalEmbeddingEnabled && (!next.embeddingEnabled || !next.semanticIndexEnabled)) {
        throw new RuntimeInvariantError("external embedding requires embedding and semantic index");
      }
      state.memorySettings[key] = next;
      if (!next.rawArchiveEnabled) pruneConversationContentDraft(state, scope, iso(now));
      return next;
    });
  }

  async scheduleProactive({ event, occurrenceKey, scheduledFor, job, now = Date.now() }) {
    assertScope(event.scope);
    return this._transaction((state) => {
      const existingEvent = state.proactiveEvents[event.id];
      if (existingEvent) {
        const comparableExisting = Object.fromEntries(
          Object.keys(event)
            .filter((key) => key !== "policyRevisionAtCreate")
            .map((key) => [key, existingEvent[key]]),
        );
        const comparableIncoming = Object.fromEntries(
          Object.entries(event).filter(([key]) => key !== "policyRevisionAtCreate"),
        );
        if (contentDigest(comparableExisting) !== contentDigest(comparableIncoming)) {
          throw new RuntimeInvariantError(`Proactive event id ${event.id} was reused`);
        }
      }
      state.proactiveEvents[event.id] ??= {
        ...clone(event),
        enabled: event.enabled !== false,
        state: event.state ?? "scheduled",
        revision: Number(event.revision ?? 1),
        createdAt: event.createdAt ?? iso(now),
        updatedAt: event.updatedAt ?? iso(now),
      };

      const occurrenceMapKey = `${event.id}:${occurrenceKey}`;
      let occurrence = state.occurrences[state.occurrenceByKey[occurrenceMapKey]];
      if (!occurrence) {
        occurrence = {
          id: newId("occ"),
          eventId: event.id,
          occurrenceKey,
          scope: clone(event.scope),
          scheduledFor: iso(scheduledFor),
          state: "scheduled",
          outboxId: null,
          deliveryEventId: null,
          createdAt: iso(now),
          updatedAt: iso(now),
        };
        state.occurrences[occurrence.id] = occurrence;
        state.occurrenceByKey[occurrenceMapKey] = occurrence.id;
      } else if (occurrence.scheduledFor !== iso(scheduledFor)) {
        throw new IdempotencyConflictError(occurrenceMapKey);
      }

      const storedJob = enqueueJobDraft(
        state,
        {
          ...job,
          // Jobs are globally claimable by workers, but every job still
          // carries its immutable verified scope for cancellation, fairness,
          // telemetry and defense-in-depth policy checks.
          scope: clone(event.scope),
          payload: { ...(job.payload ?? {}), eventId: event.id, occurrenceId: occurrence.id },
          dueAt: scheduledFor,
          idempotencyKey: job.idempotencyKey ?? `proactive.generate:${occurrenceMapKey}`,
        },
        now,
      );
      return { event: state.proactiveEvents[event.id], occurrence, job: storedJob };
    });
  }

  async getProactiveEvent(eventId) {
    return this._read((state) => state.proactiveEvents[eventId] ?? null);
  }

  async listProactiveEvents({ scope, states } = {}) {
    assertScope(scope);
    return this._read((state) => Object.values(state.proactiveEvents)
      .filter((event) => sameScope(event.scope, scope))
      .filter((event) => !states || states.includes(event.state ?? (event.enabled ? "scheduled" : "cancelled")))
      .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""))));
  }

  async updateProactiveEvent(eventId, patch, now = Date.now()) {
    return this._transaction((state) => {
      const event = state.proactiveEvents[eventId];
      if (!event) throw new RuntimeInvariantError(`Unknown proactive event ${eventId}`);
      Object.assign(event, clone(patch), { revision: Number(event.revision ?? 0) + 1, updatedAt: iso(now) });
      return event;
    });
  }

  async getOccurrence(occurrenceId) {
    return this._read((state) => state.occurrences[occurrenceId] ?? null);
  }

  async listOccurrences({ eventId, scope } = {}) {
    if (!eventId && !scope) throw new RuntimeInvariantError("listOccurrences requires eventId or scope");
    if (scope) assertScope(scope);
    return this._read((state) => Object.values(state.occurrences)
      .filter((occurrence) => !eventId || occurrence.eventId === eventId)
      .filter((occurrence) => !scope || sameScope(occurrence.scope, scope))
      .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? ""))));
  }

  async cancelOccurrence(occurrenceId, reason, now = Date.now()) {
    return this._transaction((state) => {
      const occurrence = state.occurrences[occurrenceId];
      if (!occurrence) throw new RuntimeInvariantError(`Unknown occurrence ${occurrenceId}`);
      if (occurrence.state === "delivered") return occurrence;
      Object.assign(occurrence, {
        state: "cancelled",
        cancelReason: String(reason ?? "cancelled").slice(0, 500),
        updatedAt: iso(now),
      });
      return occurrence;
    });
  }

  async updateOccurrence(occurrenceId, patch, now = Date.now()) {
    return this._transaction((state) => {
      const occurrence = state.occurrences[occurrenceId];
      if (!occurrence) throw new RuntimeInvariantError(`Unknown occurrence ${occurrenceId}`);
      Object.assign(occurrence, clone(patch), { updatedAt: iso(now) });
      return occurrence;
    });
  }

  async enqueueProactiveOutbox({
    eventId,
    occurrenceId,
    expectedPolicyRevision,
    channel,
    content,
    provider,
    now = Date.now(),
  }) {
    return this._transaction((state) => {
      const event = state.proactiveEvents[eventId];
      const occurrence = state.occurrences[occurrenceId];
      if (!event || !occurrence || occurrence.eventId !== eventId) {
        throw new RuntimeInvariantError("Proactive event/occurrence mismatch");
      }
      const policy = state.proactivePolicies[scopeKey(event.scope)] ?? defaultProactivePolicy(event.scope);
      if (policy.revision !== expectedPolicyRevision) {
        throw new PolicyChangedError(scopeKey(event.scope), expectedPolicyRevision, policy.revision);
      }
      if (!event.enabled || occurrence.state === "cancelled") {
        throw new RuntimeInvariantError("Proactive event is no longer eligible");
      }
      const row = enqueueOutboxDraft(
        state,
        {
          kind: "proactive.delivery",
          scope: event.scope,
          idempotencyKey: `proactive.delivery:${occurrence.id}:${channel}`,
          payload: {
            eventId,
            occurrenceId,
            channel,
            content,
            provider,
            purpose: event.purpose,
            proactiveKind: event.kind,
            policyRevision: expectedPolicyRevision,
          },
          dueAt: now,
        },
        now,
      );
      occurrence.state = "outbox_committed";
      occurrence.outboxId = row.id;
      occurrence.updatedAt = iso(now);
      return row;
    });
  }

  async completeProactiveDelivery({
    outboxId,
    workerId,
    fencingToken,
    providerReceipt,
    now = Date.now(),
  }) {
    return this._transaction((state) => {
      const row = state.outbox[outboxId];
      assertLease(row, "outbox", { workerId, fencingToken });
      if (row.kind !== "proactive.delivery") {
        throw new RuntimeInvariantError(`Outbox ${outboxId} is not proactive delivery`);
      }
      const occurrence = state.occurrences[row.payload.occurrenceId];
      const event = state.proactiveEvents[row.payload.eventId];
      if (!occurrence || !event) throw new RuntimeInvariantError("Missing proactive occurrence/event");

      const deliveryEventId = `event_proactive_${hashText(
        `${occurrence.id}:${row.payload.channel}`,
      ).slice(0, 24)}`;
      const deliveryEvent = appendEventDraft(state, {
        id: deliveryEventId,
        scope: event.scope,
        role: "assistant",
        type: "proactive_outbound",
        content: row.payload.content,
        contentHash: hashText(row.payload.content),
        occurrenceId: occurrence.id,
        proactiveEventId: event.id,
        deliveryId: row.id,
        channel: row.payload.channel,
        providerReceipt: clone(providerReceipt ?? null),
        createdAt: iso(now),
      });

      Object.assign(row, {
        state: "sent",
        providerReceipt: clone(providerReceipt ?? null),
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: iso(now),
      });
      Object.assign(occurrence, {
        state: "delivered",
        deliveredAt: iso(now),
        deliveryEventId: deliveryEvent.id,
        updatedAt: iso(now),
      });
      return { outbox: row, occurrence, deliveryEvent };
    });
  }

  async getSegmentCursor(scope) {
    assertScope(scope);
    return this._read((state) => state.segmentCursors[conversationKey(scope)] ?? 0);
  }

  async advanceSegmentCursor(scope, toSequence, now = Date.now()) {
    assertScope(scope);
    return this._transaction((state) => {
      const key = conversationKey(scope);
      state.segmentCursors[key] = Math.max(state.segmentCursors[key] ?? 0, Number(toSequence));
      return { conversationKey: key, toSequence: state.segmentCursors[key], updatedAt: iso(now) };
    });
  }

  async getTaskCursor(scope, task) {
    assertScope(scope);
    if (!task) throw new RuntimeInvariantError("task cursor name is required");
    return this._read((state) => state.taskCursors[`${conversationKey(scope)}:${task}`] ?? 0);
  }

  async advanceTaskCursor(scope, task, toSequence, { expectedFrom, now = Date.now() } = {}) {
    assertScope(scope);
    if (!task) throw new RuntimeInvariantError("task cursor name is required");
    return this._transaction((state) => {
      const key = `${conversationKey(scope)}:${task}`;
      const current = Number(state.taskCursors[key] ?? 0);
      const target = Number(toSequence);
      if (!Number.isSafeInteger(target) || target < 0) {
        throw new RuntimeInvariantError("toSequence must be a non-negative safe integer");
      }
      if (current >= target) return { task, fromSequence: current, toSequence: current, idempotent: true };
      if (expectedFrom !== undefined && current !== Number(expectedFrom)) {
        throw new RuntimeInvariantError("Task cursor compare-and-swap failed", {
          task,
          expectedFrom,
          actual: current,
        });
      }
      state.taskCursors[key] = target;
      return { task, fromSequence: current, toSequence: target, idempotent: false, updatedAt: iso(now) };
    });
  }
}

export class FileRuntimeRepository extends InMemoryRuntimeRepository {
  constructor({ filePath, initialState }) {
    super({ initialState });
    if (!filePath) throw new RuntimeInvariantError("FileRuntimeRepository.filePath is required");
    this.filePath = filePath;
  }

  static async open(filePath) {
    let state;
    try {
      state = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      state = emptyState();
    }
    const repository = new FileRuntimeRepository({ filePath, initialState: state });
    if (!state.schemaVersion) await repository._persist(repository._state);
    return repository;
  }

  async _persist(draft) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(draft, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.filePath);
  }
}

export const runtimeRepositoryContract = Object.freeze({
  turn: ["beginTurn", "finalizePreparedTurn", "commitTurn", "failTurn", "getTurn", "getPrivacyReceipt"],
  event: ["appendEvent", "getEvent", "listEvents"],
  job: ["enqueueJob", "getJob", "listJobs", "claimDueJobs", "completeJob", "retryJob", "rescheduleJob", "deadLetterJob"],
  outbox: [
    "enqueueOutbox",
    "getOutbox",
    "listOutbox",
    "claimDueOutbox",
    "retryOutbox",
    "deadLetterOutbox",
    "rescheduleOutbox",
    "cancelOutbox",
    "completeProactiveDelivery",
  ],
  proactive: [
    "setProactivePolicy",
    "setConsent",
    "getProactivePolicy",
    "scheduleProactive",
    "getProactiveEvent",
    "updateProactiveEvent",
    "getOccurrence",
    "listOccurrences",
    "updateOccurrence",
    "cancelOccurrence",
    "enqueueProactiveOutbox",
  ],
  cursor: ["getSegmentCursor", "advanceSegmentCursor", "getTaskCursor", "advanceTaskCursor"],
});
