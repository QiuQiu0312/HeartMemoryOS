import { AdapterError, PolicyChangedError, RuntimeInvariantError } from "./errors.js";
import { evaluateQuietHours } from "./time.js";
import {
  PROACTIVE_PURPOSE_BY_KIND,
  assertProactiveKind,
  assertScope,
  clone,
  newId,
} from "./utils.js";

const PORTABLE_LATE_GRACE_MS = 5 * 60_000;

function evaluatePolicy({ event, occurrence, policy, now }) {
  if (!event?.enabled) return { allowed: false, reason: "event_disabled" };
  if (occurrence?.state === "cancelled") return { allowed: false, reason: "occurrence_cancelled" };
  const schedule = event.metadata?.schedule;
  const nowMs = Number(now);
  const expiresAtMs = schedule?.expiresAt ? Date.parse(schedule.expiresAt) : Number.NaN;
  if (Number.isFinite(expiresAtMs) && nowMs > expiresAtMs) return { allowed: false, reason: "reminder_expired" };
  const scheduledForMs = occurrence?.scheduledFor ? Date.parse(occurrence.scheduledFor) : Number.NaN;
  if (schedule?.latePolicy === "skip_if_late" && Number.isFinite(scheduledForMs) && nowMs > scheduledForMs + PORTABLE_LATE_GRACE_MS) {
    return { allowed: false, reason: "reminder_too_late" };
  }
  if (!policy.masterEnabled) return { allowed: false, reason: "master_switch_off" };
  if (!policy.categorySwitches?.[event.kind]) return { allowed: false, reason: "category_switch_off" };
  const purpose = PROACTIVE_PURPOSE_BY_KIND[event.kind];
  if (event.purpose !== purpose) return { allowed: false, reason: "purpose_mismatch" };
  if (!policy.consents?.[purpose]?.granted) return { allowed: false, reason: "consent_missing" };
  const quiet = evaluateQuietHours(now, policy.quietHours, policy.timeZone);
  if (!quiet.quiet) return { allowed: true, policyRevision: policy.revision };
  const quietPolicy = event.quietHoursPolicy ?? "move_to_next_allowed_time";
  if (quietPolicy === "deliver_at_requested_time" && event.kind === "transactional_reminder") {
    return { allowed: true, policyRevision: policy.revision, quietHoursException: true };
  }
  if (quietPolicy === "move_to_next_allowed_time") {
    return { allowed: false, deferUntil: quiet.nextAllowedAt, reason: "quiet_hours" };
  }
  return { allowed: false, reason: "quiet_hours" };
}

export class ProactiveService {
  constructor({ repository, model = null, templateRenderer, providerRegistry, egressPolicyCheck = async () => ({ allowed: true }), hooks, clock = () => Date.now() }) {
    if (!repository) throw new RuntimeInvariantError("ProactiveService.repository is required");
    this.repository = repository;
    this.model = model;
    this.templateRenderer = templateRenderer ?? ((event) => event.templateText ?? event.summary);
    this.providerRegistry = providerRegistry;
    if (typeof egressPolicyCheck !== "function") throw new RuntimeInvariantError("egressPolicyCheck must be a function");
    this.egressPolicyCheck = egressPolicyCheck;
    this.hooks = hooks;
    this.clock = clock;
  }

  async schedule({
    scope,
    eventId = newId("proactive"),
    occurrenceKey,
    kind,
    scheduledFor,
    summary,
    channel = "in_app",
    provider = "default",
    generationMode = "template_only",
    quietHoursPolicy = "move_to_next_allowed_time",
    templateText,
    metadata = {},
  }) {
    assertScope(scope);
    assertProactiveKind(kind);
    if (!occurrenceKey) throw new RuntimeInvariantError("occurrenceKey is required");
    if (typeof summary !== "string" || !summary.trim()) throw new RuntimeInvariantError("summary is required");
    if (!["template_only", "template_or_model", "model_or_skip"].includes(generationMode)) {
      throw new RuntimeInvariantError("Unsupported generationMode");
    }
    if (quietHoursPolicy === "deliver_at_requested_time" && kind !== "transactional_reminder") {
      throw new RuntimeInvariantError("Only an explicit transactional reminder may bypass quiet hours");
    }
    const policy = await this.repository.getProactivePolicy(scope);
    const event = {
      id: eventId,
      scope: clone(scope),
      kind,
      purpose: PROACTIVE_PURPOSE_BY_KIND[kind],
      summary: String(summary ?? "").slice(0, 1_000),
      channel,
      provider,
      generationMode,
      quietHoursPolicy,
      templateText: templateText ? String(templateText).slice(0, 4_000) : null,
      policyRevisionAtCreate: policy.revision,
      metadata: clone(metadata),
      enabled: true,
    };
    return this.repository.scheduleProactive({
      event,
      occurrenceKey,
      scheduledFor,
      job: { type: "proactive.generate", maxAttempts: 5 },
      now: this.clock(),
    });
  }

  jobHandlers() {
    return {
      "proactive.generate": async ({ job }) => {
        const event = await this.repository.getProactiveEvent(job.payload.eventId);
        const occurrence = await this.repository.getOccurrence(job.payload.occurrenceId);
        if (!event || !occurrence) throw new RuntimeInvariantError("Missing proactive event or occurrence");
        if (occurrence.outboxId) {
          const existingOutbox = await this.repository.getOutbox(occurrence.outboxId);
          if (existingOutbox) return { outboxId: existingOutbox.id, idempotent: true };
        }
        const policy = await this.repository.getProactivePolicy(event.scope);
        const decision = evaluatePolicy({ event, occurrence, policy, now: this.clock() });
        if (decision.deferUntil) return { rescheduleAt: decision.deferUntil, reason: decision.reason };
        if (!decision.allowed) {
          await this.repository.cancelOccurrence(occurrence.id, decision.reason, this.clock());
          return { cancelled: true, reason: decision.reason };
        }
        await this.repository.updateOccurrence(occurrence.id, { state: "policy_checked", policyRevision: policy.revision }, this.clock());
        const content = await this.#generate(event);
        if (!content) {
          await this.repository.cancelOccurrence(occurrence.id, "generation_skipped", this.clock());
          return { cancelled: true, reason: "generation_skipped" };
        }
        const egress = await this.egressPolicyCheck({ event, occurrence, content });
        if (egress?.allowed === false) {
          const reason = String(egress.reason ?? "egress_policy_denied").slice(0, 200);
          await this.repository.cancelOccurrence(occurrence.id, reason, this.clock());
          return { cancelled: true, reason };
        }
        const approvedContent = typeof egress?.content === "string" ? egress.content.trim() : content;
        if (!approvedContent) {
          await this.repository.cancelOccurrence(occurrence.id, "egress_policy_empty", this.clock());
          return { cancelled: true, reason: "egress_policy_empty" };
        }
        await this.repository.updateOccurrence(occurrence.id, { state: "generated" }, this.clock());
        let outbox;
        try {
          outbox = await this.repository.enqueueProactiveOutbox({
            eventId: event.id,
            occurrenceId: occurrence.id,
            expectedPolicyRevision: policy.revision,
            channel: event.channel,
            content: approvedContent.slice(0, 4_000),
            provider: event.provider,
            now: this.clock(),
          });
        } catch (error) {
          if (error instanceof PolicyChangedError) {
            return { rescheduleAt: this.clock() + 1_000, reason: "policy_changed_during_generation" };
          }
          throw error;
        }
        return { outboxId: outbox.id, policyRevision: policy.revision };
      },
    };
  }

  outboxHandlers() {
    return {
      "proactive.delivery": async ({ row, workerId, fencingToken }) => {
        const event = await this.repository.getProactiveEvent(row.payload.eventId);
        const occurrence = await this.repository.getOccurrence(row.payload.occurrenceId);
        if (!event || !occurrence) return { cancelReason: "event_or_occurrence_missing" };
        const policy = await this.repository.getProactivePolicy(event.scope);
        const decision = evaluatePolicy({ event, occurrence, policy, now: this.clock() });
        if (decision.deferUntil) return { rescheduleAt: decision.deferUntil, reason: decision.reason };
        if (!decision.allowed) return { cancelReason: decision.reason };
        const provider = this.providerRegistry?.get(row.payload.provider);
        if (!provider) throw new AdapterError("delivery", "provider registry is not configured");
        // This is deliberately the last read before the irreversible provider call.
        const latestPolicy = await this.repository.getProactivePolicy(event.scope);
        const latestDecision = evaluatePolicy({ event, occurrence, policy: latestPolicy, now: this.clock() });
        if (!latestDecision.allowed) {
          if (latestDecision.deferUntil) return { rescheduleAt: latestDecision.deferUntil, reason: latestDecision.reason };
          return { cancelReason: latestDecision.reason };
        }
        const receipt = await provider.send({
          scope: event.scope,
          channel: row.payload.channel,
          content: row.payload.content,
          idempotencyKey: `${occurrence.id}:${row.payload.channel}`,
          metadata: { occurrenceId: occurrence.id, proactiveEventId: event.id, kind: event.kind },
        });
        if (receipt?.accepted === false) {
          const error = new AdapterError(provider.name ?? "delivery", "provider rejected message", { receipt });
          error.retryable = receipt.retryable === true;
          throw error;
        }
        await this.repository.completeProactiveDelivery({
          outboxId: row.id,
          workerId,
          fencingToken,
          providerReceipt: receipt,
          now: this.clock(),
        });
        return { completedByHandler: true };
      },
    };
  }

  async #generate(event) {
    const template = String(await this.templateRenderer(event) ?? "").trim();
    if (event.generationMode === "template_only") return template;
    if (!this.model?.complete) return event.generationMode === "template_or_model" ? template : null;
    try {
      const response = await this.model.complete({
        scope: event.scope,
        operation: "proactive_generation",
        maxOutputTokens: 300,
        messages: [
          { role: "system", content: "Write one concise, warm proactive companion message. Do not claim the user asked for anything not present in the event." },
          { role: "user", content: JSON.stringify({ kind: event.kind, summary: event.summary, template }) },
        ],
      });
      return String(response.text ?? "").trim().slice(0, 4_000) || (event.generationMode === "template_or_model" ? template : null);
    } catch (error) {
      if (event.generationMode === "template_or_model" && template) return template;
      if (error?.code === "COST_BUDGET_EXCEEDED") return null;
      throw error;
    }
  }
}

export { evaluatePolicy as evaluateProactivePolicy };
