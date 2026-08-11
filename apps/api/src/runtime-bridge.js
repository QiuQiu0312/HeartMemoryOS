import { createTrustedAuthContext } from "../../../packages/memory-core/src/index.js";

const PROACTIVE_PURPOSES = ["proactive_transactional", "proactive_onboarding", "proactive_relationship", "proactive_marketing"];

export function createRuntimeBridge({ repository, memory, logger = console }) {
  const bridge = {
    async beginTurn(input) {
      const result = await repository.beginTurn(input);
      if (input.userEvent) await projectIfEnabled(input.userEvent);
      return result;
    },
    async commitTurn(input) {
      const result = await repository.commitTurn(input);
      if (input.assistantEvent) await projectIfEnabled(input.assistantEvent);
      return result;
    },
    async appendEvent(event) {
      const result = await repository.appendEvent(event);
      await projectIfEnabled(event);
      return result;
    },
    async getProactivePolicy(scope) {
      const policy = await repository.getProactivePolicy(scope);
      const auth = trusted(scope);
      const consents = { ...policy.consents };
      for (const purpose of PROACTIVE_PURPOSES) {
        const current = memory.getCurrentConsent(auth, { purpose });
        consents[purpose] = current ? { purpose, granted: current.granted, revision: current.consentId, effectiveAt: new Date(current.effectiveAt).toISOString() } : { purpose, granted: false, revision: 0, effectiveAt: null };
      }
      return { ...policy, consents };
    },
  };
  async function projectIfEnabled(event) {
    try {
      const settings = await repository.getMemorySettings(event.scope);
      if (!settings.rawArchiveEnabled || !event.content) return;
      memory.appendMessage(trusted(event.scope), {
        messageId: event.id,
        role: event.role,
        content: event.content,
        occurredAt: Date.parse(event.createdAt),
        messageType: event.type === "proactive_outbound" ? "proactive_outbound" : "chat_message",
        realmHint: event.metadata?.realmHint ?? "unknown",
        retentionMode: "until_deleted",
        idempotencyKey: `runtime-projection:${event.id}`,
      });
    } catch (error) {
      logger.warn?.({ event: "runtime_projection_degraded", eventId: event.id, error: error?.message });
    }
  }
  return new Proxy(bridge, {
    get(target, property) {
      if (property in target) return target[property];
      const value = repository[property];
      return typeof value === "function" ? value.bind(repository) : value;
    },
  });
}

function trusted(scope) {
  return createTrustedAuthContext({ ...scope, actorId: scope.userId });
}
