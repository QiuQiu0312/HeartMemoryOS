export class RuntimeInvariantError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RuntimeInvariantError";
    this.code = "RUNTIME_INVARIANT_VIOLATION";
    this.details = details;
  }
}

export class TurnStateError extends Error {
  constructor(turnId, currentState, attemptedState) {
    super(`Turn ${turnId} cannot transition from ${currentState} to ${attemptedState}`);
    this.name = "TurnStateError";
    this.code = "TURN_STATE_CONFLICT";
    this.turnId = turnId;
    this.currentState = currentState;
    this.attemptedState = attemptedState;
  }
}

export class StaleLeaseError extends Error {
  constructor(kind, id, fencingToken) {
    super(`Stale ${kind} lease for ${id} (fencing token ${fencingToken})`);
    this.name = "StaleLeaseError";
    this.code = "STALE_LEASE";
    this.kind = kind;
    this.id = id;
    this.fencingToken = fencingToken;
  }
}

export class PolicyChangedError extends Error {
  constructor(scopeKey, expectedRevision, actualRevision) {
    super(
      `Proactive policy changed for ${scopeKey}: expected revision ${expectedRevision}, got ${actualRevision}`,
    );
    this.name = "PolicyChangedError";
    this.code = "POLICY_CHANGED";
    this.scopeKey = scopeKey;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class RetryableJobError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "RetryableJobError";
    this.code = "RETRYABLE_JOB_ERROR";
    this.retryable = true;
  }
}

export class DeferredJobError extends Error {
  constructor(message, dueAt) {
    super(message);
    this.name = "DeferredJobError";
    this.code = "JOB_DEFERRED";
    this.dueAt = dueAt;
    this.retryable = false;
  }
}

export class AdapterError extends Error {
  constructor(adapter, message, details = {}) {
    super(`${adapter}: ${message}`);
    this.name = "AdapterError";
    this.code = "ADAPTER_ERROR";
    this.adapter = adapter;
    this.details = details;
  }
}

export class IdempotencyConflictError extends Error {
  constructor(key) {
    super(`Idempotency key ${key} was reused with different scope or content`);
    this.name = "IdempotencyConflictError";
    this.code = "IDEMPOTENCY_CONFLICT";
    this.key = key;
  }
}

export class BudgetExceededError extends Error {
  constructor(bucket, limit, attempted) {
    super(`Cost budget ${bucket} exceeded: limit ${limit}, attempted ${attempted}`);
    this.name = "BudgetExceededError";
    this.code = "COST_BUDGET_EXCEEDED";
    this.bucket = bucket;
    this.limit = limit;
    this.attempted = attempted;
    this.retryable = false;
  }
}

export class PolicyDeniedError extends Error {
  constructor(reason, details = {}) {
    super(`Proactive delivery denied: ${reason}`);
    this.name = "PolicyDeniedError";
    this.code = "PROACTIVE_POLICY_DENIED";
    this.reason = reason;
    this.details = details;
    this.retryable = false;
  }
}
