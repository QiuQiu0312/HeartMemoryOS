import { RuntimeInvariantError } from "./errors.js";
import { normalizeHooks } from "./telemetry.js";
import { exponentialBackoffMs, isRetryableError, newId, redactError } from "./utils.js";

export class DurableJobWorker {
  constructor({
    repository,
    handlers = {},
    workerId = newId("job_worker"),
    clock = () => Date.now(),
    hooks,
    leaseMs = 30_000,
    batchSize = 10,
    types = null,
    backoff = {},
  }) {
    if (!repository) throw new RuntimeInvariantError("DurableJobWorker.repository is required");
    this.repository = repository;
    this.handlers = handlers;
    this.workerId = workerId;
    this.clock = clock;
    this.hooks = normalizeHooks(hooks);
    this.leaseMs = leaseMs;
    this.batchSize = batchSize;
    this.types = types;
    this.backoff = backoff;
  }

  async tick() {
    const rows = await this.repository.claimDueJobs({
      workerId: this.workerId,
      now: this.clock(),
      limit: this.batchSize,
      leaseMs: this.leaseMs,
      types: this.types,
    });
    for (const job of rows) await this.#process(job);
    return rows.length;
  }

  async runUntilIdle({ maxBatches = 100 } = {}) {
    let processed = 0;
    for (let index = 0; index < maxBatches; index += 1) {
      const count = await this.tick();
      processed += count;
      if (!count) return processed;
    }
    return processed;
  }

  async #process(job) {
    const handler = this.handlers[job.type];
    try {
      if (typeof handler !== "function") throw new RuntimeInvariantError(`No handler for job type ${job.type}`);
      const result = await handler({ job, workerId: this.workerId, fencingToken: job.fencingToken });
      if (result?.rescheduleAt) {
        await this.repository.rescheduleJob({
          jobId: job.id,
          workerId: this.workerId,
          fencingToken: job.fencingToken,
          dueAt: result.rescheduleAt,
          reason: result.reason,
          now: this.clock(),
        });
      } else {
        await this.repository.completeJob({
          jobId: job.id,
          workerId: this.workerId,
          fencingToken: job.fencingToken,
          result,
          now: this.clock(),
        });
      }
      await this.hooks.metric({ name: "runtime.job.success", value: 1, tags: { type: job.type } });
    } catch (error) {
      const message = redactError(error);
      if (error?.code === "STALE_LEASE") {
        await this.hooks.metric({ name: "runtime.job.stale_lease", value: 1, tags: { type: job.type } });
        return;
      } else if (error?.code === "JOB_DEFERRED" && error.dueAt) {
        await this.repository.rescheduleJob({
          jobId: job.id,
          workerId: this.workerId,
          fencingToken: job.fencingToken,
          dueAt: error.dueAt,
          reason: message,
          now: this.clock(),
        });
      } else if (isRetryableError(error)) {
        await this.repository.retryJob({
          jobId: job.id,
          workerId: this.workerId,
          fencingToken: job.fencingToken,
          dueAt: this.clock() + exponentialBackoffMs(job.attempts, this.backoff),
          error: message,
          now: this.clock(),
        });
      } else {
        await this.repository.deadLetterJob({
          jobId: job.id,
          workerId: this.workerId,
          fencingToken: job.fencingToken,
          error: message,
          now: this.clock(),
        });
      }
      await this.hooks.metric({ name: "runtime.job.failure", value: 1, tags: { type: job.type, code: error?.code ?? "unknown" } });
    }
  }
}

export class DurableOutboxWorker {
  constructor({
    repository,
    handlers = {},
    workerId = newId("outbox_worker"),
    clock = () => Date.now(),
    hooks,
    leaseMs = 30_000,
    batchSize = 10,
    backoff = {},
  }) {
    if (!repository) throw new RuntimeInvariantError("DurableOutboxWorker.repository is required");
    this.repository = repository;
    this.handlers = handlers;
    this.workerId = workerId;
    this.clock = clock;
    this.hooks = normalizeHooks(hooks);
    this.leaseMs = leaseMs;
    this.batchSize = batchSize;
    this.backoff = backoff;
  }

  async tick() {
    const rows = await this.repository.claimDueOutbox({
      workerId: this.workerId,
      now: this.clock(),
      limit: this.batchSize,
      leaseMs: this.leaseMs,
    });
    for (const row of rows) await this.#process(row);
    return rows.length;
  }

  async runUntilIdle({ maxBatches = 100 } = {}) {
    let processed = 0;
    for (let index = 0; index < maxBatches; index += 1) {
      const count = await this.tick();
      processed += count;
      if (!count) return processed;
    }
    return processed;
  }

  async #process(row) {
    const handler = this.handlers[row.kind];
    try {
      if (typeof handler !== "function") throw new RuntimeInvariantError(`No handler for outbox kind ${row.kind}`);
      const result = await handler({ row, workerId: this.workerId, fencingToken: row.fencingToken });
      if (result?.rescheduleAt) {
        await this.repository.rescheduleOutbox({ outboxId: row.id, workerId: this.workerId, fencingToken: row.fencingToken, dueAt: result.rescheduleAt, reason: result.reason, now: this.clock() });
      } else if (result?.cancelReason) {
        await this.repository.cancelOutbox({ outboxId: row.id, workerId: this.workerId, fencingToken: row.fencingToken, reason: result.cancelReason, now: this.clock() });
      } else if (!result?.completedByHandler) {
        throw new RuntimeInvariantError("Outbox handler must complete atomically or return a scheduling directive");
      }
      await this.hooks.metric({ name: "runtime.outbox.success", value: 1, tags: { kind: row.kind } });
    } catch (error) {
      const message = redactError(error);
      if (error?.code === "STALE_LEASE") {
        await this.hooks.metric({ name: "runtime.outbox.stale_lease", value: 1, tags: { kind: row.kind } });
        return;
      } else if (isRetryableError(error)) {
        await this.repository.retryOutbox({ outboxId: row.id, workerId: this.workerId, fencingToken: row.fencingToken, dueAt: this.clock() + exponentialBackoffMs(row.attempts, this.backoff), error: message, now: this.clock() });
      } else {
        await this.repository.deadLetterOutbox({ outboxId: row.id, workerId: this.workerId, fencingToken: row.fencingToken, error: message, now: this.clock() });
      }
      await this.hooks.metric({ name: "runtime.outbox.failure", value: 1, tags: { kind: row.kind, code: error?.code ?? "unknown" } });
    }
  }
}
