import { clone, iso } from "./utils.js";

export function createNoopHooks() {
  return Object.freeze({
    audit: async () => {},
    cost: async () => {},
    metric: async () => {},
  });
}

export function normalizeHooks(hooks = {}) {
  const noop = createNoopHooks();
  const safe = (candidate, fallback) => {
    if (typeof candidate !== "function") return fallback;
    const bound = candidate.bind(hooks);
    return async (...args) => {
      try {
        await bound(...args);
      } catch {
        // Telemetry is deliberately failure-isolated. Production deployments
        // should make the sink durable, but a broken sink must not roll back a
        // committed chat turn or cause a duplicate proactive delivery.
      }
    };
  };
  return {
    audit: safe(hooks.audit, noop.audit),
    cost: safe(hooks.cost, noop.cost),
    metric: safe(hooks.metric, noop.metric),
  };
}

export class InMemoryTelemetryHooks {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.auditEvents = [];
    this.costEvents = [];
    this.metrics = [];
  }

  async audit(event) {
    this.auditEvents.push(clone({ ...event, at: event.at ?? iso(this.clock()) }));
  }

  async cost(event) {
    this.costEvents.push(clone({ ...event, at: event.at ?? iso(this.clock()) }));
  }

  async metric(event) {
    this.metrics.push(clone({ ...event, at: event.at ?? iso(this.clock()) }));
  }
}
