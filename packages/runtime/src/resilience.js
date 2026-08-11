import { RuntimeInvariantError } from "./errors.js";
import { normalizeHooks } from "./telemetry.js";
import { estimateTokens, redactError } from "./utils.js";

export class CircuitBreaker {
  constructor({ failureThreshold = 5, resetAfterMs = 30_000, clock = () => Date.now() } = {}) {
    this.failureThreshold = failureThreshold;
    this.resetAfterMs = resetAfterMs;
    this.clock = clock;
    this.failures = 0;
    this.openedAt = null;
    this.halfOpenInFlight = false;
  }

  get state() {
    if (this.openedAt === null) return "closed";
    if (this.clock() - this.openedAt >= this.resetAfterMs) return "half_open";
    return "open";
  }

  async execute(operation) {
    const state = this.state;
    if (state === "open" || (state === "half_open" && this.halfOpenInFlight)) {
      const error = new RuntimeInvariantError("Circuit breaker is open");
      error.code = "CIRCUIT_OPEN";
      throw error;
    }
    if (state === "half_open") this.halfOpenInFlight = true;
    try {
      const result = await operation();
      this.failures = 0;
      this.openedAt = null;
      return result;
    } catch (error) {
      this.failures += 1;
      if (this.failures >= this.failureThreshold) this.openedAt = this.clock();
      throw error;
    } finally {
      this.halfOpenInFlight = false;
    }
  }
}

export function withCircuitBreaker(adapter, breaker = new CircuitBreaker()) {
  if (!adapter?.complete) throw new RuntimeInvariantError("adapter.complete is required");
  return {
    complete: (request) => breaker.execute(() => adapter.complete(request)),
    breaker,
  };
}

export function createResilientContextCompiler({ primary, repository, hooks, recentEventLimit = 12 }) {
  if (typeof primary !== "function" || !repository) {
    throw new RuntimeInvariantError("primary compiler and repository are required");
  }
  const telemetry = normalizeHooks(hooks);
  return async (input) => {
    try {
      return await primary(input);
    } catch (error) {
      const events = await repository.listEvents({ scope: input.scope });
      const recent = events.slice(-recentEventLimit).map((event) => ({
        role: event.role,
        content: event.content,
      }));
      await telemetry.audit({
        action: "context.degraded_to_recent_window",
        scope: input.scope,
        turnId: input.turnId,
        errorCode: error?.code ?? "CONTEXT_COMPILER_FAILED",
        error: redactError(error),
      });
      await telemetry.metric({ name: "runtime.context.degraded", value: 1 });
      return {
        messages: recent,
        tokenEstimate: recent.reduce((sum, message) => sum + estimateTokens(message.content), 0),
        degraded: true,
        degradationReason: error?.code ?? "CONTEXT_COMPILER_FAILED",
      };
    }
  };
}
