import { ValidationError } from "./errors.js";

const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9_-]{16,}\b/g,
  /\b(?:\d[ -]?){13,19}\b/g,
  /\b\d{17}[\dXx]\b/g,
];

/**
 * The default is deliberately conservative only for credentials and strong
 * financial/identity-number patterns. A product can inject a richer policy
 * (regional regulation, age gates, consent, classifier) without changing the
 * repository. Policy results are always recorded before an accepted write.
 */
export function defaultPrivacyPolicy({ content }) {
  const original = String(content ?? "");
  let redacted = original;
  let changed = false;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      changed = true;
      return `[已隐藏敏感信息:${Math.min(match.length, 32)}]`;
    });
  }
  return changed
    ? {
        outcome: "redact",
        policyVersion: "builtin-privacy-v1",
        reason: "credential_or_identity_pattern_redacted",
        redactedContent: redacted,
      }
    : {
        outcome: "allow",
        policyVersion: "builtin-privacy-v1",
        reason: "no_builtin_sensitive_pattern",
      };
}

export function normalizePrivacyDecision(decision, originalContent) {
  if (!decision || !["allow", "redact", "deny"].includes(decision.outcome)) {
    throw new ValidationError("privacyPolicy must return allow, redact, or deny");
  }
  const policyVersion = nonEmpty(decision.policyVersion, "privacyPolicy must return policyVersion");
  const reason = nonEmpty(decision.reason, "privacyPolicy must return reason");
  if (decision.outcome === "redact") {
    if (typeof decision.redactedContent !== "string") {
      throw new ValidationError("a redact decision must include redactedContent");
    }
    return { outcome: "redact", policyVersion, reason, storedContent: decision.redactedContent };
  }
  return { outcome: decision.outcome, policyVersion, reason, storedContent: String(originalContent ?? "") };
}

function nonEmpty(value, message) {
  if (typeof value !== "string" || value.trim().length === 0) throw new ValidationError(message);
  return value.trim();
}
