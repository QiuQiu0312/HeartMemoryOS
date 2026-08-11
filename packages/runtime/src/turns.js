import { PolicyDeniedError, RuntimeInvariantError } from "./errors.js";
import { normalizeHooks } from "./telemetry.js";
import {
  assertNonEmptyString,
  assertScope,
  contentDigest,
  hashText,
  iso,
  newId,
  redactError,
} from "./utils.js";

function normalizePrivacyDecision(decision, original) {
  const outcome = decision?.outcome ?? "allow";
  if (!["allow", "redact", "deny"].includes(outcome)) {
    throw new RuntimeInvariantError("privacyScreen returned an invalid outcome");
  }
  if (outcome === "redact" && typeof decision.storedContent !== "string") {
    throw new RuntimeInvariantError("redaction must return storedContent");
  }
  return {
    outcome,
    storedContent: outcome === "allow" ? original : outcome === "redact" ? decision.storedContent : null,
    policyVersion: String(decision?.policyVersion ?? "runtime-default-v1"),
    reason: String(decision?.reason ?? outcome),
  };
}

export class TurnCoordinator {
  constructor({
    repository,
    privacyScreen = async ({ content }) => ({ outcome: "allow", storedContent: content }),
    contextCompiler = async () => ({ messages: [], tokenEstimate: 0 }),
    signalPlanner = null,
    commitPolicyCheck = async () => ({ allowed: true }),
    hooks,
    clock = () => Date.now(),
    maxUserChars = 32_000,
    maxAssistantChars = 64_000,
  }) {
    if (!repository) throw new RuntimeInvariantError("TurnCoordinator.repository is required");
    this.repository = repository;
    this.privacyScreen = privacyScreen;
    this.contextCompiler = contextCompiler;
    this.signalPlanner = signalPlanner;
    this.commitPolicyCheck = commitPolicyCheck;
    this.hooks = normalizeHooks(hooks);
    this.clock = clock;
    this.maxUserChars = maxUserChars;
    this.maxAssistantChars = maxAssistantChars;
  }

  async prepare({ scope, requestId, userContent, metadata = {} }) {
    assertScope(scope);
    const content = assertNonEmptyString(userContent, "userContent");
    if (content.length > this.maxUserChars) throw new RuntimeInvariantError("userContent exceeds hard limit");
    const clientRequestId = assertNonEmptyString(requestId, "requestId");
    const requestKey = `${scope.tenantId}:${scope.userId}:${scope.companionId}:${clientRequestId}`;
    const requestHash = contentDigest({ scope, clientRequestId, content, metadata });
    const turnId = `turn_${hashText(requestKey).slice(0, 24)}`;
    const now = this.clock();
    const privacy = normalizePrivacyDecision(
      await this.privacyScreen({ scope, operation: "chat.user_message", content, metadata }),
      content,
    );
    const receipt = {
      id: `privacy_${hashText(`${requestHash}:${privacy.policyVersion}`).slice(0, 24)}`,
      scope,
      operation: "chat.user_message",
      outcome: privacy.outcome,
      policyVersion: privacy.policyVersion,
      reason: privacy.reason,
      contentHash: hashText(content),
      createdAt: iso(now),
    };
    const turn = {
      id: turnId,
      scope,
      requestKey,
      requestHash,
      metadata,
      privacyReceiptId: receipt.id,
      createdAt: iso(now),
      updatedAt: iso(now),
    };
    const userEvent = privacy.outcome === "deny" ? null : {
      id: `event_user_${hashText(requestHash).slice(0, 24)}`,
      scope,
      role: "user",
      type: "chat_message",
      content: privacy.storedContent,
      contentHash: hashText(privacy.storedContent),
      privacyReceiptId: receipt.id,
      metadata,
      createdAt: iso(now),
    };
    const begun = await this.repository.beginTurn({ turn, privacyReceipt: receipt, userEvent });
    if (begun.state !== "preparing") return begun;
    if (privacy.outcome === "deny") {
      const failed = await this.repository.failTurn(turnId, {
        code: "PRIVACY_DENIED",
        reason: privacy.reason,
      }, now);
      await this.hooks.audit({ action: "turn.denied", turnId, scope, reason: privacy.reason });
      return failed;
    }
    try {
      const context = await this.contextCompiler({
        scope,
        turnId,
        userEvent,
        metadata,
        repository: this.repository,
      });
      const prepared = await this.repository.finalizePreparedTurn(turnId, {
        preparedContext: context,
        contextDigest: contentDigest(context),
        contextTokenEstimate: Number(context?.tokenEstimate ?? context?.tokenAccounting?.compiledInputTokens ?? 0),
        preparedAt: iso(this.clock()),
      });
      await this.hooks.audit({ action: "turn.prepared", turnId, scope, contextDigest: prepared.contextDigest });
      return prepared;
    } catch (error) {
      await this.fail(turnId, error);
      throw error;
    }
  }

  async commit({ turnId, assistantContent, metadata = {} }) {
    const content = assertNonEmptyString(assistantContent, "assistantContent");
    if (content.length > this.maxAssistantChars) throw new RuntimeInvariantError("assistantContent exceeds hard limit");
    const turn = await this.repository.getTurn(turnId);
    if (!turn) throw new RuntimeInvariantError(`Unknown turn ${turnId}`);
    if (turn.state === "committed") return turn;
    const commitPolicy = await this.commitPolicyCheck({ turn, assistantContent: content, metadata });
    if (commitPolicy?.allowed === false) {
      await this.repository.failTurn(turnId, {
        code: "COMMIT_POLICY_DENIED",
        reason: String(commitPolicy.reason ?? "policy_changed").slice(0, 500),
      }, this.clock());
      throw new PolicyDeniedError(commitPolicy.reason ?? "commit_policy_denied");
    }
    let jobs = [];
    if (this.signalPlanner) {
      try {
        jobs = await this.signalPlanner.plan({ scope: turn.scope, turn });
      } catch (error) {
        // Candidate extraction and old-chat summarization are optimizations;
        // their control plane must never prevent the assistant reply commit.
        await this.hooks.audit({
          action: "background_signals.degraded",
          turnId,
          scope: turn.scope,
          errorCode: error?.code ?? "SIGNAL_PLANNER_FAILED",
          error: redactError(error),
        });
      }
    }
    const now = this.clock();
    const assistantEvent = {
      id: `event_assistant_${hashText(`${turn.id}:${contentDigest(content)}`).slice(0, 24)}`,
      scope: turn.scope,
      role: "assistant",
      type: "chat_message",
      content,
      contentHash: hashText(content),
      turnId: turn.id,
      metadata,
      createdAt: iso(now),
    };
    const committed = await this.repository.commitTurn({ turnId, assistantEvent, jobs, committedAt: now });
    await this.hooks.audit({
      action: "turn.committed",
      turnId,
      scope: turn.scope,
      assistantEventId: committed.assistantEventId,
      backgroundJobIds: committed.backgroundJobIds,
    });
    return committed;
  }

  async fail(turnId, error) {
    const turn = await this.repository.getTurn(turnId);
    if (!turn) throw new RuntimeInvariantError(`Unknown turn ${turnId}`);
    const failure = { code: error?.code ?? "TURN_FAILED", message: redactError(error) };
    const failed = await this.repository.failTurn(turnId, failure, this.clock());
    await this.hooks.audit({ action: "turn.failed", turnId, scope: turn.scope, ...failure });
    return failed;
  }

  async run({ model, scope, requestId, userContent, metadata = {}, modelRequest = {} }) {
    if (!model || typeof model.complete !== "function") throw new RuntimeInvariantError("model.complete is required");
    const prepared = await this.prepare({ scope, requestId, userContent, metadata });
    if (prepared.state === "committed" || prepared.state === "failed") return prepared;
    try {
      const response = await model.complete({
        ...modelRequest,
        scope,
        operation: "main_chat",
        messages: prepared.preparedContext?.messages ?? [],
      });
      return await this.commit({ turnId: prepared.id, assistantContent: response.text, metadata: {
        model: response.model,
        finishReason: response.finishReason,
        providerRequestId: response.providerRequestId,
      } });
    } catch (error) {
      await this.fail(prepared.id, error);
      throw error;
    }
  }
}

export function assertPreparedTurn(turn) {
  if (turn?.state !== "prepared") throw new PolicyDeniedError("turn_not_prepared", { state: turn?.state });
  return turn;
}
