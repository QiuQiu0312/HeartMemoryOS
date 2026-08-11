import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { AuthorizationError, ConflictError, ValidationError } from "./errors.js";
import { defaultPrivacyPolicy, normalizePrivacyDecision } from "./privacy.js";
import { reciprocalRankFusion } from "./rrf.js";
import { applyMigrations } from "./schema.js";

const TRUSTED_SCOPE = Symbol("companion-memory.trusted-scope");
const MAX_RECALL_LIMIT = 12;
const MAX_FTS_CANDIDATES = 48;
const MAX_LIKE_CANDIDATES = 24;
const MAX_SHORT_CJK_SCAN = 1_000;
const MAX_ALIAS_COUNT = 24;
const DEFAULT_RECALL_REALMS = Object.freeze(["real_world", "relationship_canon", "unknown"]);
const SCOPE_COLUMNS = "tenant_id, user_id, relationship_id, companion_id";
const SCOPE_WHERE = "tenant_id = ? AND user_id = ? AND relationship_id = ? AND companion_id = ?";
const CJK_SEQUENCE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu;
const REALMS = new Set(["real_world", "relationship_canon", "roleplay", "fictional", "hypothetical", "quoted", "unknown"]);
const ATTRIBUTIONS = new Set(["user_self_report", "user_about_other", "companion_statement", "system_observed", "imported", "inferred"]);
const EPISTEMIC_BASES = new Set(["explicit_memory_request", "explicit_statement", "user_confirmation", "repeated_inference", "behavioral_signal", "assistant_generated", "quoted_report", "imported_record", "unknown"]);
const MODALITIES = new Set(["asserted", "preferred", "desired", "planned", "possible", "uncertain"]);
const CONFIDENCE_BANDS = new Set(["explicit", "high", "medium", "low", "disputed"]);
const TEMPORAL_KINDS = new Set(["timeless", "point", "interval", "recurring", "unknown"]);
const TEMPORAL_PRECISIONS = new Set(["exact", "day", "month", "year", "relative", "unknown"]);
const VISIBILITIES = new Set(["user_private", "relationship_only", "explicit_shared"]);
const SENSITIVITIES = new Set(["ordinary", "personal", "sensitive", "highly_sensitive", "prohibited"]);
const CONSENT_PURPOSES = new Set([
  "chat_processing", "raw_conversation_archive", "memory_ordinary", "memory_sensitive",
  "cross_relationship_memory_share", "semantic_index", "external_embedding",
  "external_memory_provider", "deep_recall", "adaptive_profile", "analytics",
  "lock_screen_content", "proactive_transactional", "proactive_onboarding",
  "proactive_relationship", "proactive_marketing",
]);
const LEGACY_CONSENT_ALIASES = new Map([
  ["memory", "memory_ordinary"],
  ["sensitive_memory", "memory_sensitive"],
  ["proactive", "proactive_transactional"],
]);

/**
 * This constructor is intentionally the only way to create an auth object the
 * repository accepts. Route handlers must call it after verifying a session;
 * client request bodies are never accepted as a source of tenant/user scope.
 */
export function createTrustedAuthContext({ tenantId, userId, relationshipId, companionId, conversationId, actorId, roles = [] }) {
  const scope = Object.freeze({
    tenantId: requireId(tenantId, "tenantId"),
    userId: requireId(userId, "userId"),
    relationshipId: requireId(relationshipId, "relationshipId"),
    companionId: requireId(companionId, "companionId"),
  });
  return Object.freeze({
    [TRUSTED_SCOPE]: scope,
    // Conversation identity is also verified by the route/session layer. It is
    // intentionally not part of long-term Claim scope because a relationship
    // may recall across several conversations.
    conversationId: requireId(conversationId ?? relationshipId, "conversationId"),
    actorId: requireId(actorId ?? userId, "actorId"),
    roles: Object.freeze([...roles].map((role) => String(role))),
  });
}

export function createMemoryRepository({
  db,
  dbPath,
  privacyPolicy = defaultPrivacyPolicy,
  now = () => Date.now(),
  idFactory = randomUUID,
  fingerprintKey = randomBytes(32),
} = {}) {
  const ownedDatabase = !db;
  const databasePath = dbPath ?? ":memory:";
  const database = db ?? new DatabaseSync(databasePath);
  if (ownedDatabase) hardenDatabaseFiles(databasePath);
  applyMigrations(database, now());
  if (ownedDatabase) hardenDatabaseFiles(databasePath);
  return new MemoryRepository({ db: database, privacyPolicy, now, idFactory, fingerprintKey, ownedDatabase });
}

function hardenDatabaseFiles(databasePath) {
  if (databasePath === ":memory:" || String(databasePath).startsWith("file::memory:")) return;
  for (const path of [String(databasePath), `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(path)) chmodSync(path, 0o600);
  }
}

export class MemoryRepository {
  #db;
  #privacyPolicy;
  #now;
  #idFactory;
  #fingerprintKey;
  #ownedDatabase;

  constructor({ db, privacyPolicy, now, idFactory, fingerprintKey, ownedDatabase = false }) {
    if (!db || typeof db.prepare !== "function") throw new ValidationError("A node:sqlite DatabaseSync instance is required");
    if (typeof privacyPolicy !== "function") throw new ValidationError("privacyPolicy must be a function");
    this.#db = db;
    this.#privacyPolicy = privacyPolicy;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#fingerprintKey = normalizeFingerprintKey(fingerprintKey);
    this.#ownedDatabase = ownedDatabase;
    this.#upgradeLegacySuppressions();
  }

  close() {
    if (this.#ownedDatabase) this.#db.close();
  }

  /** Messages may be retained independently from memory claims. */
  appendMessage(auth, {
    messageId = null,
    role,
    content,
    occurredAt = null,
    messageType = "chat_message",
    realmHint = "unknown",
    privacyClass = "personal",
    retentionMode = "rolling_window",
    idempotencyKey = null,
  }) {
    const scope = scopeFrom(auth);
    const conversationId = requireId(auth.conversationId, "conversationId");
    const suppliedId = messageId == null ? null : requireId(messageId, "messageId");
    if (!new Set(["user", "assistant", "system", "tool"]).has(role)) {
      throw new ValidationError("role must be user, assistant, system, or tool");
    }
    const original = requireText(content, "content");
    const normalizedType = requireEnum(messageType, "messageType", new Set(["chat_message", "proactive_outbound", "system_event", "tool_result"]));
    const normalizedRealm = requireEnum(realmHint, "realmHint", REALMS);
    const normalizedPrivacy = requireEnum(privacyClass, "privacyClass", new Set(["ordinary", "personal", "sensitive", "highly_sensitive"]));
    const normalizedRetention = requireEnum(retentionMode, "retentionMode", new Set(["transient", "rolling_window", "until_deleted"]));
    const idem = nullableIdempotencyKey(idempotencyKey);
    const requestFingerprint = idem ? this.#requestFingerprint({
      messageId: suppliedId, conversationId, role, messageType: normalizedType, content: original,
      occurredAt, realmHint: normalizedRealm, privacyClass: normalizedPrivacy, retentionMode: normalizedRetention,
    }) : null;
    const replay = this.#readIdempotentWrite(scope, "message.append", idem, requestFingerprint);
    if (replay) return replay;
    const id = suppliedId ?? this.#idFactory();
    const privacy = this.#decidePrivacy(auth, "message.append", original, { role });
    const createdAt = occurredAt == null ? this.#now() : integerTime(occurredAt, "occurredAt");

    return this.#transaction(() => {
      const racedReplay = this.#readIdempotentWrite(scope, "message.append", idem, requestFingerprint);
      if (racedReplay) return racedReplay;
      const receiptId = this.#writePrivacyReceipt(scope, "message.append", original, privacy);
      if (privacy.outcome === "deny") {
        this.#audit(scope, auth.actorId, "message.denied", "message", id, { receiptId, reason: privacy.reason });
        return this.#storeIdempotentWrite(scope, "message.append", idem, requestFingerprint,
          { accepted: false, receiptId, reason: privacy.reason });
      }
      const sequenceNo = Number(this.#db.prepare(`SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence FROM messages
        WHERE ${SCOPE_WHERE} AND conversation_id = ?`).get(...scopeValues(scope), conversationId).next_sequence);
      this.#db.prepare(`INSERT INTO messages (${SCOPE_COLUMNS}, message_id, conversation_id, sequence_no, role, message_type,
        content, content_fingerprint, occurred_at, created_at, realm_hint, privacy_class, retention_mode, storage_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        ...scopeValues(scope), id, conversationId, sequenceNo, role, normalizedType, privacy.storedContent,
        this.#fingerprint(privacy.storedContent), createdAt, this.#now(), normalizedRealm, normalizedPrivacy,
        normalizedRetention, "persisted",
      );
      this.#audit(scope, auth.actorId, "message.appended", "message", id, {
        receiptId, conversationId, sequenceNo, role, messageType: normalizedType, redacted: privacy.outcome === "redact",
      });
      return this.#storeIdempotentWrite(scope, "message.append", idem, requestFingerprint,
        { accepted: true, messageId: id, conversationId, sequenceNo, receiptId, redacted: privacy.outcome === "redact" });
    });
  }

  listMessages(auth, { limit = 50, beforeSequence = null } = {}) {
    const scope = scopeFrom(auth);
    const conversationId = requireId(auth.conversationId, "conversationId");
    const max = boundedInteger(limit, "limit", 1, 250);
    const before = beforeSequence == null ? Number.MAX_SAFE_INTEGER : boundedInteger(beforeSequence, "beforeSequence", 1, Number.MAX_SAFE_INTEGER);
    return this.#db.prepare(`SELECT message_id, conversation_id, sequence_no, role, message_type, content, occurred_at,
      realm_hint, privacy_class, retention_mode, storage_state FROM messages
      WHERE ${SCOPE_WHERE} AND conversation_id = ? AND sequence_no < ? AND deleted_at IS NULL
      ORDER BY sequence_no DESC LIMIT ?`).all(...scopeValues(scope), conversationId, before, max).reverse().map((row) => ({
        messageId: row.message_id,
        conversationId: row.conversation_id,
        sequenceNo: row.sequence_no,
        role: row.role,
        messageType: row.message_type,
        content: row.content,
        occurredAt: row.occurred_at,
        realmHint: row.realm_hint,
        privacyClass: row.privacy_class,
        retentionMode: row.retention_mode,
        storageState: row.storage_state,
      }));
  }

  /** Records an explicit, consented memory. It never accepts scope fields. */
  remember(auth, input) {
    return this.#remember(auth, input, null);
  }

  /**
   * The only safe commit path for extraction/index workers. A worker captures
   * the epoch when it reads source data and must present it at commit time;
   * corrections/deletions make any older result stale before it can resurrect
   * forgotten state.
   */
  rememberFromWorker(auth, input, { expectedDeletionEpoch, idempotencyKey } = {}) {
    const expected = boundedInteger(expectedDeletionEpoch, "expectedDeletionEpoch", 0, Number.MAX_SAFE_INTEGER);
    const key = requireText(idempotencyKey, "idempotencyKey", 240);
    return this.#remember(auth, { ...input, idempotencyKey: key }, expected);
  }

  #remember(auth, input, expectedDeletionEpoch) {
    const scope = scopeFrom(auth);
    this.#requireConsent(scope, "memory_ordinary");
    const requestedSensitivity = requireEnum(input?.sensitivity ?? "personal", "sensitivity", SENSITIVITIES);
    if (requestedSensitivity === "prohibited") throw new ValidationError("prohibited content cannot become a memory claim");
    if (["sensitive", "highly_sensitive"].includes(requestedSensitivity)) this.#requireConsent(scope, "memory_sensitive");
    const original = requireText(input?.content, "content");
    const idem = nullableIdempotencyKey(input?.idempotencyKey);
    const requestFingerprint = idem ? this.#requestFingerprint({
      content: original,
      kind: input?.kind ?? "fact",
      aliases: input?.aliases ?? [],
      sourceMessageId: input?.sourceMessageId ?? null,
      sensitivity: requestedSensitivity,
      expiresAt: input?.expiresAt ?? null,
      claimId: input?.claimId ?? null,
      realm: input?.realm ?? "unknown",
      attribution: input?.attribution ?? "user_self_report",
      epistemicBasis: input?.epistemicBasis ?? "explicit_memory_request",
      modality: input?.modality ?? "asserted",
      confidenceBand: input?.confidenceBand ?? "explicit",
      subjectRef: input?.subjectRef ?? null,
      predicateKey: input?.predicateKey ?? input?.kind ?? "fact",
      temporal: input?.temporal ?? null,
      visibility: input?.visibility ?? "relationship_only",
      expectedDeletionEpoch,
    }) : null;
    const replay = this.#readIdempotentWrite(scope, "claim.create", idem, requestFingerprint);
    if (replay) return replay;
    if (expectedDeletionEpoch != null) this.#assertDeletionEpoch(scope, expectedDeletionEpoch);
    const privacy = this.#decidePrivacy(auth, "claim.create", original, { kind: input?.kind ?? "fact" });
    const prepared = this.#prepareClaimInput(input, privacy.storedContent, scope);
    if (prepared.visibility === "explicit_shared") this.#requireConsent(scope, "cross_relationship_memory_share");

    return this.#transaction(() => {
      const racedReplay = this.#readIdempotentWrite(scope, "claim.create", idem, requestFingerprint);
      if (racedReplay) return racedReplay;
      if (expectedDeletionEpoch != null) this.#assertDeletionEpoch(scope, expectedDeletionEpoch);
      const receiptId = this.#writePrivacyReceipt(scope, "claim.create", original, privacy);
      if (privacy.outcome === "deny") {
        this.#audit(scope, auth.actorId, "claim.denied", "claim", null, { receiptId, reason: privacy.reason });
        return this.#storeIdempotentWrite(scope, "claim.create", idem, requestFingerprint,
          { accepted: false, receiptId, reason: privacy.reason });
      }
      this.#assertNotSuppressed(scope, prepared);
      const result = this.#insertClaim(scope, auth, prepared, receiptId, "created");
      return this.#storeIdempotentWrite(scope, "claim.create", idem, requestFingerprint,
        { accepted: true, receiptId, redacted: privacy.outcome === "redact", ...result });
    });
  }

  /**
   * Corrections preserve the prior claim and its evidence. The old claim is
   * marked superseded; it is not silently overwritten.
   */
  correct(auth, input) {
    const scope = scopeFrom(auth);
    this.#requireConsent(scope, "memory_ordinary");
    const previousId = requireId(input?.claimId, "claimId");
    const original = requireText(input?.content, "content");
    const idem = nullableIdempotencyKey(input?.idempotencyKey);
    const requestFingerprint = idem ? this.#requestFingerprint({ previousId, ...input, content: original, idempotencyKey: null }) : null;
    const replay = this.#readIdempotentWrite(scope, "claim.correct", idem, requestFingerprint);
    if (replay) return replay;
    const privacy = this.#decidePrivacy(auth, "claim.correct", original, { previousClaimId: previousId, kind: input?.kind });

    return this.#transaction(() => {
      const racedReplay = this.#readIdempotentWrite(scope, "claim.correct", idem, requestFingerprint);
      if (racedReplay) return racedReplay;
      const previous = this.#activeClaim(scope, previousId);
      if (!previous) throw new ValidationError("The claim is missing, deleted, or no longer active");
      const prepared = this.#prepareClaimInput({
        kind: previous.kind,
        sensitivity: previous.sensitivity,
        realm: previous.realm,
        attribution: previous.attribution,
        epistemicBasis: "user_confirmation",
        modality: previous.modality,
        confidenceBand: "explicit",
        subjectRef: previous.subject_ref,
        predicateKey: previous.predicate_key,
        temporal: {
          kind: previous.temporal_kind,
          precision: previous.temporal_precision,
          validFrom: previous.valid_from,
          validTo: previous.valid_to,
          sourceTimezone: previous.source_timezone,
          recurrenceRrule: previous.valid_recurrence_rrule,
        },
        visibility: previous.visibility,
        allowedRelationshipIds: JSON.parse(previous.allowed_relationship_ids_json),
        aliases: [],
        ...input,
        claimId: undefined,
        idempotencyKey: undefined,
      }, privacy.storedContent, scope);
      if (prepared.sensitivity === "prohibited") throw new ValidationError("prohibited content cannot become a memory claim");
      if (["sensitive", "highly_sensitive"].includes(prepared.sensitivity)) this.#requireConsent(scope, "memory_sensitive");
      if (prepared.visibility === "explicit_shared") this.#requireConsent(scope, "cross_relationship_memory_share");
      const receiptId = this.#writePrivacyReceipt(scope, "claim.correct", original, privacy);
      if (privacy.outcome === "deny") {
        this.#audit(scope, auth.actorId, "claim.correction_denied", "claim", previousId, { receiptId, reason: privacy.reason });
        return this.#storeIdempotentWrite(scope, "claim.correct", idem, requestFingerprint,
          { accepted: false, receiptId, reason: privacy.reason });
      }
      this.#assertNotSuppressed(scope, prepared);
      const previousAliases = this.#db.prepare(`SELECT alias_normalized FROM memory_entities WHERE ${SCOPE_WHERE} AND claim_id = ?`)
        .all(...scopeValues(scope), previousId).map((row) => row.alias_normalized);
      const epoch = this.#advanceDeletionEpoch(scope);
      const now = this.#now();
      const nextRevision = previous.current_revision + 1;
      this.#db.prepare(`UPDATE claims SET status = 'superseded', current_revision = ?, updated_at = ?, recorded_to = ? WHERE ${SCOPE_WHERE} AND claim_id = ?`)
        .run(nextRevision, now, now, ...scopeValues(scope), previousId);
      this.#db.prepare(`UPDATE claim_revisions SET recorded_to = ? WHERE ${SCOPE_WHERE} AND claim_id = ? AND recorded_to IS NULL`)
        .run(now, ...scopeValues(scope), previousId);
      this.#db.prepare(`INSERT INTO claim_revisions (${SCOPE_COLUMNS}, claim_id, revision_no, operation, content, reason, actor_id, created_at,
        realm, attribution, epistemic_basis, modality, confidence_band, temporal_kind, temporal_precision, valid_from, valid_to,
        valid_recurrence_rrule, recorded_from, recorded_to)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        ...scopeValues(scope), previousId, nextRevision, "superseded", previous.content, "replaced_by_correction", auth.actorId, now,
        previous.realm, previous.attribution, previous.epistemic_basis, previous.modality, previous.confidence_band,
        previous.temporal_kind, previous.temporal_precision, previous.valid_from, previous.valid_to,
        previous.valid_recurrence_rrule, previous.recorded_from, now,
      );
      this.#removeFromSearch(scope, previousId);
      const replacement = this.#insertClaim(scope, auth, prepared, receiptId, "corrected");
      this.#addSuppressionRules(scope, previous.content_normalized, previousAliases, "superseded_by_correction", previousId, now);
      const correctionId = this.#idFactory();
      this.#db.prepare(`INSERT INTO corrections (${SCOPE_COLUMNS}, correction_id, previous_claim_id, replacement_claim_id, reason, actor_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        ...scopeValues(scope), correctionId, previousId, replacement.claimId, "user_or_system_correction", auth.actorId, now,
      );
      this.#enqueueOutbox(scope, "claim.corrected", "claim", replacement.claimId, {
        previousClaimId: previousId,
        replacementClaimId: replacement.claimId,
        deletionEpoch: epoch,
      }, `claim.corrected:${previousId}:${replacement.claimId}`);
      return this.#storeIdempotentWrite(scope, "claim.correct", idem, requestFingerprint,
        { accepted: true, receiptId, correctionId, previousClaimId: previousId, deletionEpoch: epoch, ...replacement });
    });
  }

  /**
   * Delete is immediate and atomic: claim visibility is removed, the derived
   * FTS/alias records are removed, a tombstone and suppression rules are added,
   * and the scope deletion epoch advances for asynchronous workers.
   */
  forget(auth, { claimId, reasonCode = "user_requested" }) {
    const scope = scopeFrom(auth);
    const id = requireId(claimId, "claimId");
    const reason = requireReasonCode(reasonCode);
    return this.#transaction(() => {
      const existing = this.#claim(scope, id);
      if (!existing) throw new ValidationError("The claim does not exist in this trusted scope");
      if (existing.status === "deleted") {
        return { deleted: true, claimId: id, deletionEpoch: existing.deletion_epoch, idempotent: true };
      }
      const lineage = this.#claimLineage(scope, id);
      const epoch = this.#advanceDeletionEpoch(scope);
      const now = this.#now();
      let tombstoneId = null;
      const deletedClaimIds = [];
      for (const member of lineage) {
        if (member.status === "deleted") continue;
        const aliases = this.#db.prepare(`SELECT alias_normalized FROM memory_entities WHERE ${SCOPE_WHERE} AND claim_id = ?`)
          .all(...scopeValues(scope), member.claim_id).map((row) => row.alias_normalized);
        this.#addSuppressionRules(scope, member.content_normalized, aliases, reason, member.claim_id, now);
        const nextRevision = member.current_revision + 1;
        this.#db.prepare(`UPDATE claims
          SET status = 'deleted', content = '[deleted]', content_normalized = '', sensitivity = 'deleted', deleted_at = ?,
            deletion_epoch = ?, updated_at = ?, current_revision = ?, recorded_to = ?
          WHERE ${SCOPE_WHERE} AND claim_id = ?`).run(now, epoch, now, nextRevision, now, ...scopeValues(scope), member.claim_id);
        this.#db.prepare(`UPDATE claim_revisions SET recorded_to = ? WHERE ${SCOPE_WHERE} AND claim_id = ? AND recorded_to IS NULL`)
          .run(now, ...scopeValues(scope), member.claim_id);
        this.#db.prepare(`INSERT INTO claim_revisions (${SCOPE_COLUMNS}, claim_id, revision_no, operation, content, reason, actor_id, created_at,
          realm, attribution, epistemic_basis, modality, confidence_band, temporal_kind, temporal_precision, valid_from, valid_to,
          valid_recurrence_rrule, recorded_from, recorded_to)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          ...scopeValues(scope), member.claim_id, nextRevision, "deleted", "[deleted]", reason, auth.actorId, now,
          member.realm, member.attribution, member.epistemic_basis, member.modality, "disputed", member.temporal_kind,
          member.temporal_precision, member.valid_from, member.valid_to, member.valid_recurrence_rrule, now, now,
        );
        // The tombstone and suppression fingerprint preserve control-plane
        // semantics; plaintext history is removed from every canonical table.
        this.#db.prepare(`UPDATE claim_revisions SET content = '[deleted]' WHERE ${SCOPE_WHERE} AND claim_id = ?`)
          .run(...scopeValues(scope), member.claim_id);
        this.#db.prepare(`UPDATE claim_evidence SET excerpt = '[deleted]' WHERE ${SCOPE_WHERE} AND claim_id = ?`)
          .run(...scopeValues(scope), member.claim_id);
        const memberTombstoneId = this.#idFactory();
        if (member.claim_id === id) tombstoneId = memberTombstoneId;
        this.#db.prepare(`INSERT INTO deletion_tombstones (${SCOPE_COLUMNS}, tombstone_id, claim_id, deletion_epoch, reason, actor_id, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          ...scopeValues(scope), memberTombstoneId, member.claim_id, epoch, reason, auth.actorId, now,
        );
        this.#removeFromSearch(scope, member.claim_id);
        deletedClaimIds.push(member.claim_id);
      }
      this.#enqueueOutbox(scope, "claim.deleted", "claim", id,
        { claimId: id, deletedClaimIds, deletionEpoch: epoch }, `claim.deleted:${id}:${epoch}`);
      this.#enqueueDurableJob(scope, {
        jobType: "memory.index.purge",
        payload: { claimId: id, deletedClaimIds, deletionEpoch: epoch },
        idempotencyKey: `memory.index.purge:${id}:${epoch}`,
      });
      this.#audit(scope, auth.actorId, "claim.deleted", "claim", id,
        { deletionEpoch: epoch, tombstoneId, reason, deletedClaimCount: deletedClaimIds.length });
      return { deleted: true, claimId: id, deletedClaimIds, deletionEpoch: epoch, tombstoneId, idempotent: false };
    });
  }

  /** Scope-safe hybrid lexical recall: exact aliases + trigram FTS + bounded LIKE. */
  recall(auth, { query, limit = 6, trace = false, allowedRealms = DEFAULT_RECALL_REALMS } = {}) {
    const scope = scopeFrom(auth);
    this.#requireConsent(scope, "memory_ordinary");
    const normalized = normalizeText(requireText(query, "query"));
    const requestedLimit = boundedInteger(limit, "limit", 1, MAX_RECALL_LIMIT);
    const realms = normalizeRealmFilter(allowedRealms);
    const now = this.#now();
    const lists = [];
    const strategies = [];
    const semanticIndexAllowed = this.#hasConsent(scope, "semantic_index");

    const aliases = this.#exactAliasCandidates(scope, normalized, requestedLimit, now, realms);
    if (aliases.length) {
      lists.push(aliases.map((item) => ({ ...item, source: "entity" })));
      strategies.push("entity");
    }
    const embeddedAliases = this.#embeddedShortAliasCandidates(scope, normalized, requestedLimit, now, realms);
    if (embeddedAliases.length) {
      lists.push(embeddedAliases.map((item) => ({ ...item, source: "entity_short_embedded" })));
      strategies.push("entity_short_embedded");
    }
    const match = semanticIndexAllowed ? ftsMatchQuery(normalized) : null;
    if (match) {
      const fts = this.#ftsCandidates(scope, match, Math.min(MAX_FTS_CANDIDATES, requestedLimit * 6), now, realms);
      if (fts.length) {
        lists.push(fts.map((item) => ({ ...item, source: "fts" })));
        strategies.push("fts");
      }
    }
    if (semanticIndexAllowed && isShortCjkTerm(normalized)) {
      const like = this.#boundedLikeCandidates(scope, normalized, Math.min(MAX_LIKE_CANDIDATES, requestedLimit * 4), now, realms);
      if (like.length) {
        lists.push(like.map((item) => ({ ...item, source: "short_cjk_like" })));
        strategies.push("short_cjk_like");
      }
    }
    const items = reciprocalRankFusion(lists, { limit: requestedLimit });
    const deletionEpoch = this.#deletionEpoch(scope);
    const result = { queryFingerprint: this.#fingerprint(normalized), strategies, allowedRealms: realms, deletionEpoch, items };
    if (trace) this.#writeRecallTrace(scope, result);
    return result;
  }

  listClaims(auth, { includeInactive = false, limit = 100 } = {}) {
    const scope = scopeFrom(auth);
    const max = boundedInteger(limit, "limit", 1, 250);
    const status = includeInactive ? "" : " AND status = 'active' AND deleted_at IS NULL";
    return this.#db.prepare(`SELECT claim_id, kind, content, sensitivity, status, source_message_id, current_revision,
      created_at, updated_at, confirmed_at, expires_at, deleted_at, deletion_epoch, realm, attribution,
      epistemic_basis, modality, confidence_band, subject_ref, predicate_key, temporal_kind, temporal_precision,
      valid_from, valid_to, source_timezone, valid_recurrence_rrule, recorded_from, recorded_to, visibility,
      origin_relationship_id, allowed_relationship_ids_json, evidence_status
      FROM claims WHERE ${SCOPE_WHERE}${status} ORDER BY updated_at DESC LIMIT ?`)
      .all(...scopeValues(scope), max)
      .map(toClaim);
  }

  getClaim(auth, { claimId }) {
    const scope = scopeFrom(auth);
    const row = this.#claim(scope, requireId(claimId, "claimId"));
    return row ? toClaim(row) : null;
  }

  /** Detail view for an owner-facing memory console; all evidence is scoped. */
  getClaimDetail(auth, { claimId }) {
    const scope = scopeFrom(auth);
    const id = requireId(claimId, "claimId");
    const claim = this.#claim(scope, id);
    if (!claim) return null;
    const revisions = this.#db.prepare(`SELECT revision_no, operation, content, reason, actor_id, created_at, realm, attribution,
      epistemic_basis, modality, confidence_band, temporal_kind, temporal_precision, valid_from, valid_to,
      valid_recurrence_rrule, recorded_from, recorded_to FROM claim_revisions
      WHERE ${SCOPE_WHERE} AND claim_id = ? ORDER BY revision_no`).all(...scopeValues(scope), id)
      .map(toRevision);
    const evidence = this.#db.prepare(`SELECT evidence_id, source_message_id, excerpt, evidence_kind, created_at, source_role,
      source_sequence, span_start, span_end, source_fingerprint, evidence_strength, realm_snapshot, attribution_snapshot FROM claim_evidence
      WHERE ${SCOPE_WHERE} AND claim_id = ? ORDER BY created_at`).all(...scopeValues(scope), id)
      .map(toEvidence);
    const corrections = this.#db.prepare(`SELECT correction_id, previous_claim_id, replacement_claim_id, reason, actor_id, created_at FROM corrections
      WHERE ${SCOPE_WHERE} AND (previous_claim_id = ? OR replacement_claim_id = ?) ORDER BY created_at`)
      .all(...scopeValues(scope), id, id)
      .map((row) => ({ correctionId: row.correction_id, previousClaimId: row.previous_claim_id, replacementClaimId: row.replacement_claim_id, reason: row.reason, actorId: row.actor_id, createdAt: row.created_at }));
    return { claim: toClaim(claim), revisions, evidence, corrections };
  }

  listPrivacyReceipts(auth, { limit = 100 } = {}) {
    const scope = scopeFrom(auth);
    const max = boundedInteger(limit, "limit", 1, 250);
    return this.#db.prepare(`SELECT receipt_id, operation, outcome, policy_version, reason, content_fingerprint, created_at
      FROM privacy_receipts WHERE ${SCOPE_WHERE} ORDER BY created_at DESC LIMIT ?`)
      .all(...scopeValues(scope), max)
      .map((row) => ({ receiptId: row.receipt_id, operation: row.operation, outcome: row.outcome, policyVersion: row.policy_version, reason: row.reason, contentFingerprint: row.content_fingerprint, createdAt: row.created_at }));
  }

  listRecallTraces(auth, { limit = 100 } = {}) {
    const scope = scopeFrom(auth);
    const max = boundedInteger(limit, "limit", 1, 250);
    return this.#db.prepare(`SELECT trace_id, query_fingerprint, strategies_json, selected_claim_ids_json, deletion_epoch, created_at
      FROM recall_traces WHERE ${SCOPE_WHERE} ORDER BY created_at DESC LIMIT ?`)
      .all(...scopeValues(scope), max)
      .map((row) => ({ traceId: row.trace_id, queryFingerprint: row.query_fingerprint, strategies: JSON.parse(row.strategies_json), selectedClaimIds: JSON.parse(row.selected_claim_ids_json), deletionEpoch: row.deletion_epoch, createdAt: row.created_at }));
  }

  recordConsent(auth, { purpose = null, category = null, granted, policyVersion, source = "user_settings", effectiveAt = null }) {
    const scope = scopeFrom(auth);
    const normalizedPurpose = canonicalConsentPurpose(purpose ?? category);
    if (typeof granted !== "boolean") throw new ValidationError("granted must be a boolean");
    const version = requireText(policyVersion, "policyVersion", 160);
    const consentSource = requireText(source, "source", 160);
    const effective = effectiveAt == null ? this.#now() : integerTime(effectiveAt, "effectiveAt");
    return this.#transaction(() => {
      const consentId = this.#idFactory();
      // Date.now() can repeat within a millisecond. The per-scope order is
      // allocated while holding BEGIN IMMEDIATE, so a later revoke cannot be
      // hidden behind a timestamp tie.
      const nextOrder = Number(this.#db.prepare(`SELECT COALESCE(MAX(recorded_order), 0) + 1 AS next_order FROM consent_events_v2
        WHERE ${SCOPE_WHERE}`).get(...scopeValues(scope)).next_order);
      const recordedAt = this.#now();
      this.#db.prepare(`INSERT INTO consent_events_v2 (${SCOPE_COLUMNS}, consent_id, purpose, decision, policy_version, source,
        effective_at, recorded_at, recorded_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        ...scopeValues(scope), consentId, normalizedPurpose, granted ? "granted" : "revoked", version, consentSource,
        effective, recordedAt, nextOrder,
      );
      let revocationEpoch = null;
      if (!granted && normalizedPurpose === "memory_ordinary") {
        revocationEpoch = this.#advanceDeletionEpoch(scope);
        this.#db.prepare(`UPDATE durable_jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE ${SCOPE_WHERE} AND job_type LIKE 'memory.%' AND status IN ('queued', 'running')`)
          .run(this.#now(), ...scopeValues(scope));
        this.#db.prepare(`UPDATE outbox_events SET cancelled_at = ?, cancel_reason = 'memory_consent_revoked', lease_owner = NULL, lease_expires_at = NULL
          WHERE ${SCOPE_WHERE} AND event_type IN ('claim.created', 'claim.corrected') AND delivered_at IS NULL AND cancelled_at IS NULL`)
          .run(this.#now(), ...scopeValues(scope));
      }
      if (!granted && normalizedPurpose.startsWith("proactive_")) {
        this.#db.prepare(`UPDATE proactive_preferences SET enabled = 0, updated_at = ? WHERE ${SCOPE_WHERE}`)
          .run(this.#now(), ...scopeValues(scope));
        this.#db.prepare(`UPDATE proactive_events SET status = 'cancelled', updated_at = ? WHERE ${SCOPE_WHERE} AND status = 'scheduled'`)
          .run(this.#now(), ...scopeValues(scope));
        this.#db.prepare(`UPDATE durable_jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE ${SCOPE_WHERE} AND job_type = 'proactive.deliver' AND status IN ('queued', 'running')`)
          .run(this.#now(), ...scopeValues(scope));
      }
      if (normalizedPurpose === "semantic_index") {
        // Consent is part of the index itself, not merely a read-time UI
        // toggle. Revoke synchronously removes reversible lexical features;
        // grant deterministically rebuilds only low-risk active claims.
        this.#db.prepare(`DELETE FROM memory_fts
          WHERE tenant_id = ? AND user_id = ? AND relationship_id = ? AND companion_id = ?`)
          .run(...scopeValues(scope));
        if (granted && effective <= this.#now()) {
          this.#db.prepare(`INSERT INTO memory_fts (tenant_id, user_id, relationship_id, companion_id, claim_id, content)
            SELECT tenant_id, user_id, relationship_id, companion_id, claim_id, content FROM claims
            WHERE ${SCOPE_WHERE} AND status = 'active' AND deleted_at IS NULL
              AND visibility <> 'user_private' AND sensitivity IN ('ordinary', 'personal')`)
            .run(...scopeValues(scope));
        }
      }
      this.#audit(scope, auth.actorId, "consent.recorded", "consent", consentId,
        { purpose: normalizedPurpose, granted, policyVersion: version, effectiveAt: effective });
      return { consentId, purpose: normalizedPurpose, category: category ?? normalizedPurpose, granted,
        policyVersion: version, source: consentSource, effectiveAt: effective, recordedAt, revision: nextOrder, revocationEpoch };
    });
  }

  getCurrentConsent(auth, { purpose = null, category = null }) {
    const scope = scopeFrom(auth);
    const normalizedPurpose = canonicalConsentPurpose(purpose ?? category);
    const row = this.#db.prepare(`SELECT consent_id, decision, policy_version, source, effective_at, recorded_at
      FROM consent_events_v2 WHERE ${SCOPE_WHERE} AND purpose = ? ORDER BY recorded_order DESC LIMIT 1`)
      .get(...scopeValues(scope), normalizedPurpose);
    return row ? { consentId: row.consent_id, purpose: normalizedPurpose, granted: row.decision === "granted",
      policyVersion: row.policy_version, source: row.source, effectiveAt: row.effective_at, recordedAt: row.recorded_at } : null;
  }

  listCurrentConsents(auth, { purposes = null } = {}) {
    const scope = scopeFrom(auth);
    const selected = purposes == null ? null : normalizeConsentPurposeList(purposes);
    const markers = selected ? ` AND current.purpose IN (${selected.map(() => "?").join(", ")})` : "";
    return this.#db.prepare(`SELECT current.consent_id, current.purpose, current.decision, current.policy_version,
      current.source, current.effective_at, current.recorded_at, current.recorded_order
      FROM consent_events_v2 current
      WHERE ${scopedWhere("current")}${markers}
        AND current.recorded_order = (
          SELECT MAX(latest.recorded_order) FROM consent_events_v2 latest
          WHERE latest.tenant_id = current.tenant_id AND latest.user_id = current.user_id
            AND latest.relationship_id = current.relationship_id AND latest.companion_id = current.companion_id
            AND latest.purpose = current.purpose
        )
      ORDER BY current.purpose`).all(...scopeValues(scope), ...(selected ?? [])).map((row) => ({
        consentId: row.consent_id,
        purpose: row.purpose,
        granted: row.decision === "granted",
        policyVersion: row.policy_version,
        source: row.source,
        effectiveAt: row.effective_at,
        recordedAt: row.recorded_at,
        revision: row.recorded_order,
      }));
  }

  consumeActionNonce(auth, { nonce, actionKind, expiresAt }) {
    const scope = scopeFrom(auth);
    const expiration = integerTime(expiresAt, "expiresAt");
    const now = this.#now();
    if (expiration <= now) throw new ValidationError("action nonce has expired");
    const fingerprint = this.#fingerprint(requireId(nonce, "nonce"));
    return this.#transaction(() => {
      try {
        this.#db.prepare(`INSERT INTO consumed_action_nonces (${SCOPE_COLUMNS}, nonce_fingerprint, action_kind, expires_at, consumed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          ...scopeValues(scope), fingerprint, requireMachineKey(actionKind, "actionKind"), expiration, now,
        );
      } catch (error) {
        if (String(error?.code ?? "").startsWith("ERR_SQLITE_CONSTRAINT") || String(error?.message ?? "").includes("UNIQUE")) {
          throw new ConflictError("The one-time action token was already consumed");
        }
        throw error;
      }
      this.#db.prepare("DELETE FROM consumed_action_nonces WHERE expires_at < ?").run(now - 86_400_000);
      return { consumed: true, actionKind, expiresAt: expiration };
    });
  }

  saveSegmentSummary(auth, { segmentId, startMessageId = null, endMessageId = null, summary, sourceHash, promptVersion = null }) {
    const scope = scopeFrom(auth);
    this.#requireConsent(scope, "memory_ordinary");
    const original = requireText(summary, "summary");
    const privacy = this.#decidePrivacy(auth, "segment.summary", original, { segmentId });
    const id = requireId(segmentId, "segmentId");
    return this.#transaction(() => {
      const receiptId = this.#writePrivacyReceipt(scope, "segment.summary", original, privacy);
      if (privacy.outcome === "deny") return { accepted: false, receiptId, reason: privacy.reason };
      const now = this.#now();
      this.#db.prepare(`INSERT INTO segment_summaries (${SCOPE_COLUMNS}, segment_id, start_message_id, end_message_id, summary, source_hash, prompt_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (${SCOPE_COLUMNS}, segment_id) DO UPDATE SET
          start_message_id = excluded.start_message_id, end_message_id = excluded.end_message_id, summary = excluded.summary,
          source_hash = excluded.source_hash, prompt_version = excluded.prompt_version, updated_at = excluded.updated_at`)
        .run(...scopeValues(scope), id, nullableId(startMessageId), nullableId(endMessageId), privacy.storedContent,
          requireText(sourceHash, "sourceHash", 160), nullableText(promptVersion), now, now);
      this.#audit(scope, auth.actorId, "segment_summary.saved", "segment_summary", id, { receiptId, redacted: privacy.outcome === "redact" });
      return { accepted: true, segmentId: id, receiptId };
    });
  }

  savePromptVersion(auth, { promptName, body, activate = false }) {
    const scope = scopeFrom(auth);
    const name = requireText(promptName, "promptName", 100);
    const original = requireText(body, "body");
    const privacy = this.#decidePrivacy(auth, "prompt.version", original, { promptName: name });
    return this.#transaction(() => {
      const receiptId = this.#writePrivacyReceipt(scope, "prompt.version", original, privacy);
      if (privacy.outcome === "deny") return { accepted: false, receiptId, reason: privacy.reason };
      const maxVersion = this.#db.prepare(`SELECT COALESCE(MAX(version), 0) AS max_version FROM prompt_versions
        WHERE ${SCOPE_WHERE} AND prompt_name = ?`).get(...scopeValues(scope), name).max_version;
      const version = Number(maxVersion) + 1;
      if (activate) this.#db.prepare(`UPDATE prompt_versions SET status = 'retired' WHERE ${SCOPE_WHERE} AND prompt_name = ? AND status = 'active'`)
        .run(...scopeValues(scope), name);
      this.#db.prepare(`INSERT INTO prompt_versions (${SCOPE_COLUMNS}, prompt_name, version, body, body_fingerprint, status, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        ...scopeValues(scope), name, version, privacy.storedContent, this.#fingerprint(privacy.storedContent), activate ? "active" : "draft", auth.actorId, this.#now(),
      );
      this.#audit(scope, auth.actorId, "prompt_version.saved", "prompt", `${name}:${version}`, { receiptId, activate });
      return { accepted: true, promptName: name, version, status: activate ? "active" : "draft", receiptId };
    });
  }

  getActivePrompt(auth, { promptName }) {
    const scope = scopeFrom(auth);
    const row = this.#db.prepare(`SELECT version, body, body_fingerprint, created_by, created_at FROM prompt_versions
      WHERE ${SCOPE_WHERE} AND prompt_name = ? AND status = 'active' ORDER BY version DESC LIMIT 1`)
      .get(...scopeValues(scope), requireText(promptName, "promptName", 100));
    return row ? { version: row.version, body: row.body, bodyFingerprint: row.body_fingerprint, createdBy: row.created_by, createdAt: row.created_at } : null;
  }

  enqueueJob(auth, { jobType, payload = {}, idempotencyKey, runAfter = this.#now(), maxAttempts = 8 }) {
    const scope = scopeFrom(auth);
    const payloadJson = safeJson(payload, "payload");
    const privacy = this.#decidePrivacy(auth, "job.enqueue", payloadJson, { jobType });
    return this.#transaction(() => {
      const receiptId = this.#writePrivacyReceipt(scope, "job.enqueue", payloadJson, privacy);
      if (privacy.outcome !== "allow") return { accepted: false, receiptId, reason: privacy.reason };
      const job = this.#enqueueDurableJob(scope, {
        jobType: requireText(jobType, "jobType", 160),
        payload,
        idempotencyKey: requireText(idempotencyKey, "idempotencyKey", 240),
        runAfter: integerTime(runAfter, "runAfter"),
        maxAttempts: boundedInteger(maxAttempts, "maxAttempts", 1, 50),
      });
      this.#audit(scope, auth.actorId, "job.enqueued", "job", job.jobId, { receiptId, jobType });
      return { accepted: true, receiptId, ...job };
    });
  }

  claimDueJobs(auth, { workerId, limit = 10, leaseMs = 30_000, now = this.#now() }) {
    const scope = scopeFrom(auth);
    const worker = requireText(workerId, "workerId", 120);
    const max = boundedInteger(limit, "limit", 1, 50);
    const lease = boundedInteger(leaseMs, "leaseMs", 1_000, 15 * 60_000);
    const current = integerTime(now, "now");
    return this.#transaction(() => {
      const currentEpoch = this.#deletionEpoch(scope);
      // Memory projections from an older epoch are obsolete. Cancel them
      // before leasing; purge jobs are enqueued at the new epoch and survive.
      this.#db.prepare(`UPDATE durable_jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE ${SCOPE_WHERE} AND job_type LIKE 'memory.%' AND status IN ('queued', 'running') AND scope_epoch < ?`)
        .run(current, ...scopeValues(scope), currentEpoch);
      const candidates = this.#db.prepare(`SELECT job_id FROM durable_jobs WHERE ${SCOPE_WHERE}
        AND ((status = 'queued' AND run_after <= ?) OR (status = 'running' AND lease_expires_at < ?))
        AND attempts < max_attempts ORDER BY run_after, created_at LIMIT ?`)
        .all(...scopeValues(scope), current, current, max);
      const jobs = [];
      for (const candidate of candidates) {
        const changed = this.#db.prepare(`UPDATE durable_jobs SET status = 'running', lease_owner = ?, lease_expires_at = ?,
          attempts = attempts + 1, updated_at = ? WHERE ${SCOPE_WHERE} AND job_id = ?
          AND ((status = 'queued' AND run_after <= ?) OR (status = 'running' AND lease_expires_at < ?))`)
          .run(worker, current + lease, current, ...scopeValues(scope), candidate.job_id, current, current).changes;
        if (!changed) continue;
        const row = this.#db.prepare(`SELECT job_id, job_type, payload_json, attempts, max_attempts, lease_expires_at, scope_epoch FROM durable_jobs
          WHERE ${SCOPE_WHERE} AND job_id = ?`).get(...scopeValues(scope), candidate.job_id);
        jobs.push({ jobId: row.job_id, jobType: row.job_type, payload: JSON.parse(row.payload_json), attempts: row.attempts,
          maxAttempts: row.max_attempts, leaseExpiresAt: row.lease_expires_at, deletionEpoch: row.scope_epoch });
      }
      return jobs;
    });
  }

  finishJob(auth, { jobId, workerId, success, error = null, retryAfter = this.#now() }) {
    const scope = scopeFrom(auth);
    const id = requireId(jobId, "jobId");
    const worker = requireText(workerId, "workerId", 120);
    if (typeof success !== "boolean") throw new ValidationError("success must be a boolean");
    const current = this.#now();
    return this.#transaction(() => {
      const row = this.#db.prepare(`SELECT attempts, max_attempts, job_type, scope_epoch FROM durable_jobs WHERE ${SCOPE_WHERE} AND job_id = ? AND status = 'running' AND lease_owner = ?`)
        .get(...scopeValues(scope), id, worker);
      if (!row) throw new ConflictError("Job lease is absent or belongs to another worker");
      if (row.job_type.startsWith("memory.") && row.scope_epoch < this.#deletionEpoch(scope)) {
        this.#db.prepare(`UPDATE durable_jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE ${SCOPE_WHERE} AND job_id = ? AND lease_owner = ?`)
          .run(current, ...scopeValues(scope), id, worker);
        this.#audit(scope, auth.actorId, "job.cancelled_stale_epoch", "job", id, { jobEpoch: row.scope_epoch });
        return { jobId: id, status: "cancelled", staleEpoch: true };
      }
      const exhausted = !success && row.attempts >= row.max_attempts;
      const status = success ? "succeeded" : exhausted ? "failed" : "queued";
      this.#db.prepare(`UPDATE durable_jobs SET status = ?, run_after = ?, last_error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE ${SCOPE_WHERE} AND job_id = ? AND lease_owner = ?`).run(
        status, integerTime(retryAfter, "retryAfter"), nullableText(error, 800), current, ...scopeValues(scope), id, worker,
      );
      this.#audit(scope, auth.actorId, "job.finished", "job", id, { success, status });
      return { jobId: id, status };
    });
  }

  /**
   * Transactional outbox consumer. Leases allow at-least-once delivery across
   * multiple workers; consumers must make their external handler idempotent by
   * eventId, then call markOutboxDelivered.
   */
  claimOutboxEvents(auth, { dispatcherId, limit = 25, leaseMs = 30_000, now = this.#now() }) {
    const scope = scopeFrom(auth);
    const dispatcher = requireText(dispatcherId, "dispatcherId", 120);
    const max = boundedInteger(limit, "limit", 1, 100);
    const lease = boundedInteger(leaseMs, "leaseMs", 1_000, 15 * 60_000);
    const current = integerTime(now, "now");
    return this.#transaction(() => {
      const candidates = this.#db.prepare(`SELECT event_id FROM outbox_events WHERE ${SCOPE_WHERE} AND delivered_at IS NULL AND cancelled_at IS NULL
        AND (lease_expires_at IS NULL OR lease_expires_at < ?) ORDER BY created_at LIMIT ?`)
        .all(...scopeValues(scope), current, max);
      const events = [];
      for (const candidate of candidates) {
        const changed = this.#db.prepare(`UPDATE outbox_events SET lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1
          WHERE ${SCOPE_WHERE} AND event_id = ? AND delivered_at IS NULL AND cancelled_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at < ?)`)
          .run(dispatcher, current + lease, ...scopeValues(scope), candidate.event_id, current).changes;
        if (!changed) continue;
        const row = this.#db.prepare(`SELECT event_id, event_type, aggregate_type, aggregate_id, payload_json, attempts, lease_expires_at
          FROM outbox_events WHERE ${SCOPE_WHERE} AND event_id = ?`)
          .get(...scopeValues(scope), candidate.event_id);
        events.push({
          eventId: row.event_id,
          eventType: row.event_type,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          payload: JSON.parse(row.payload_json),
          attempts: row.attempts,
          leaseExpiresAt: row.lease_expires_at,
        });
      }
      return events;
    });
  }

  markOutboxDelivered(auth, { eventId, dispatcherId }) {
    const scope = scopeFrom(auth);
    const id = requireId(eventId, "eventId");
    const dispatcher = requireText(dispatcherId, "dispatcherId", 120);
    return this.#transaction(() => {
      const changed = this.#db.prepare(`UPDATE outbox_events SET delivered_at = ?, lease_owner = NULL, lease_expires_at = NULL
        WHERE ${SCOPE_WHERE} AND event_id = ? AND delivered_at IS NULL AND cancelled_at IS NULL AND lease_owner = ?`)
        .run(this.#now(), ...scopeValues(scope), id, dispatcher).changes;
      if (!changed) throw new ConflictError("Outbox event lease is absent, expired, or belongs to another dispatcher");
      return { eventId: id, delivered: true };
    });
  }

  /** Compare-and-swap cursor prevents two workers from advancing a task twice. */
  advanceTaskCursor(auth, { taskName, expectedVersion, cursor, watermark = null }) {
    const scope = scopeFrom(auth);
    const name = requireText(taskName, "taskName", 160);
    const expected = boundedInteger(expectedVersion, "expectedVersion", 0, Number.MAX_SAFE_INTEGER);
    const cursorJson = safeJson(cursor, "cursor");
    const now = this.#now();
    return this.#transaction(() => {
      this.#db.prepare(`INSERT OR IGNORE INTO task_cursors (${SCOPE_COLUMNS}, task_name, cursor_json, watermark, version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...scopeValues(scope), name, "{}", null, 0, now);
      const changed = this.#db.prepare(`UPDATE task_cursors SET cursor_json = ?, watermark = ?, version = version + 1, updated_at = ?
        WHERE ${SCOPE_WHERE} AND task_name = ? AND version = ?`)
        .run(cursorJson, nullableText(watermark, 320), now, ...scopeValues(scope), name, expected).changes;
      const state = this.#db.prepare(`SELECT cursor_json, watermark, version, updated_at FROM task_cursors WHERE ${SCOPE_WHERE} AND task_name = ?`)
        .get(...scopeValues(scope), name);
      return { applied: Boolean(changed), cursor: JSON.parse(state.cursor_json), watermark: state.watermark, version: state.version, updatedAt: state.updated_at };
    });
  }

  getTaskCursor(auth, { taskName }) {
    const scope = scopeFrom(auth);
    const row = this.#db.prepare(`SELECT cursor_json, watermark, version, updated_at FROM task_cursors WHERE ${SCOPE_WHERE} AND task_name = ?`)
      .get(...scopeValues(scope), requireText(taskName, "taskName", 160));
    return row ? { cursor: JSON.parse(row.cursor_json), watermark: row.watermark, version: row.version, updatedAt: row.updated_at } : { cursor: {}, watermark: null, version: 0, updatedAt: null };
  }

  getScopeEpoch(auth) {
    const scope = scopeFrom(auth);
    return Object.freeze({ deletionEpoch: this.#deletionEpoch(scope) });
  }

  setProactivePreference(auth, { enabled, timezone = "UTC", quietStartMinute = null, quietEndMinute = null }) {
    const scope = scopeFrom(auth);
    if (typeof enabled !== "boolean") throw new ValidationError("enabled must be a boolean");
    if (enabled) this.#requireConsent(scope, "proactive_transactional");
    const start = nullableMinute(quietStartMinute, "quietStartMinute");
    const end = nullableMinute(quietEndMinute, "quietEndMinute");
    return this.#transaction(() => {
      this.#db.prepare(`INSERT INTO proactive_preferences (${SCOPE_COLUMNS}, enabled, quiet_start_minute, quiet_end_minute, timezone, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (${SCOPE_COLUMNS}) DO UPDATE SET enabled = excluded.enabled, quiet_start_minute = excluded.quiet_start_minute,
          quiet_end_minute = excluded.quiet_end_minute, timezone = excluded.timezone, updated_at = excluded.updated_at`)
        .run(...scopeValues(scope), Number(enabled), start, end, requireText(timezone, "timezone", 80), this.#now());
      this.#audit(scope, auth.actorId, "proactive.preference_updated", "proactive_preference", null, { enabled });
      return { enabled, timezone, quietStartMinute: start, quietEndMinute: end };
    });
  }

  getProactivePreference(auth) {
    const scope = scopeFrom(auth);
    const row = this.#db.prepare(`SELECT enabled, quiet_start_minute, quiet_end_minute, timezone, updated_at FROM proactive_preferences
      WHERE ${SCOPE_WHERE}`).get(...scopeValues(scope));
    return row ? {
      enabled: Boolean(row.enabled),
      quietStartMinute: row.quiet_start_minute,
      quietEndMinute: row.quiet_end_minute,
      timezone: row.timezone,
      updatedAt: row.updated_at,
    } : null;
  }

  scheduleProactiveEvent(auth, { eventType, dueAt, payload = {} }) {
    const scope = scopeFrom(auth);
    this.#requireConsent(scope, "proactive_transactional");
    const preference = this.#db.prepare(`SELECT enabled FROM proactive_preferences WHERE ${SCOPE_WHERE}`).get(...scopeValues(scope));
    if (!preference?.enabled) throw new ConflictError("The user has not enabled proactive messages");
    const payloadJson = safeJson(payload, "payload");
    const privacy = this.#decidePrivacy(auth, "proactive.schedule", payloadJson, { eventType });
    return this.#transaction(() => {
      const receiptId = this.#writePrivacyReceipt(scope, "proactive.schedule", payloadJson, privacy);
      if (privacy.outcome !== "allow") return { accepted: false, receiptId, reason: privacy.reason };
      const eventId = this.#idFactory();
      const due = integerTime(dueAt, "dueAt");
      const now = this.#now();
      this.#db.prepare(`INSERT INTO proactive_events (${SCOPE_COLUMNS}, event_id, event_type, due_at, payload_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        ...scopeValues(scope), eventId, requireText(eventType, "eventType", 160), due, payloadJson, "scheduled", now, now,
      );
      this.#enqueueDurableJob(scope, { jobType: "proactive.deliver", payload: { eventId }, idempotencyKey: `proactive.deliver:${eventId}`, runAfter: due });
      this.#audit(scope, auth.actorId, "proactive.scheduled", "proactive_event", eventId, { receiptId, dueAt: due });
      return { accepted: true, eventId, receiptId };
    });
  }

  recordCost(auth, { operation, provider = null, model = null, inputTokens = 0, outputTokens = 0, amountMicrounits = 0 }) {
    const scope = scopeFrom(auth);
    return this.#transaction(() => {
      const costId = this.#idFactory();
      this.#db.prepare(`INSERT INTO cost_events (${SCOPE_COLUMNS}, cost_id, operation, provider, model, input_tokens, output_tokens, amount_microunits, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        ...scopeValues(scope), costId, requireText(operation, "operation", 160), nullableText(provider, 160), nullableText(model, 160),
        nonNegativeInteger(inputTokens, "inputTokens"), nonNegativeInteger(outputTokens, "outputTokens"), nonNegativeInteger(amountMicrounits, "amountMicrounits"), this.#now(),
      );
      return { costId };
    });
  }

  #prepareClaimInput(input, storedContent, scope) {
    const content = requireText(storedContent, "content");
    const aliases = uniqueAliases(input?.aliases ?? []);
    const kind = requireText(input?.kind ?? "fact", "kind", 80);
    const temporal = normalizeTemporal(input?.temporal);
    const visibility = requireEnum(input?.visibility ?? "relationship_only", "visibility", VISIBILITIES);
    const allowedRelationshipIds = normalizeAllowedRelationships(
      input?.allowedRelationshipIds,
      visibility,
      scope.relationshipId,
    );
    return {
      claimId: input?.claimId ? requireId(input.claimId, "claimId") : this.#idFactory(),
      kind,
      content,
      normalized: normalizeText(content),
      aliases,
      sourceMessageId: nullableId(input?.sourceMessageId),
      sensitivity: requireEnum(input?.sensitivity ?? "personal", "sensitivity", SENSITIVITIES),
      expiresAt: input?.expiresAt == null ? null : integerTime(input.expiresAt, "expiresAt"),
      realm: requireEnum(input?.realm ?? "unknown", "realm", REALMS),
      attribution: requireEnum(input?.attribution ?? "user_self_report", "attribution", ATTRIBUTIONS),
      epistemicBasis: requireEnum(input?.epistemicBasis ?? "explicit_memory_request", "epistemicBasis", EPISTEMIC_BASES),
      modality: requireEnum(input?.modality ?? "asserted", "modality", MODALITIES),
      confidenceBand: requireEnum(input?.confidenceBand ?? "explicit", "confidenceBand", CONFIDENCE_BANDS),
      subjectRef: nullableText(input?.subjectRef, 256),
      predicateKey: requireMachineKey(input?.predicateKey ?? defaultPredicateForKind(kind), "predicateKey"),
      temporal,
      visibility,
      originRelationshipId: scope.relationshipId,
      allowedRelationshipIds,
    };
  }

  #insertClaim(scope, auth, prepared, receiptId, operation) {
    const sourceMessage = prepared.sourceMessageId ? this.#message(scope, prepared.sourceMessageId) : null;
    if (prepared.sourceMessageId && !sourceMessage) {
      throw new ValidationError("sourceMessageId is not a message in this trusted scope");
    }
    const now = this.#now();
    this.#db.prepare(`INSERT INTO claims (${SCOPE_COLUMNS}, claim_id, kind, content, content_normalized, sensitivity, status, source_message_id,
      current_revision, created_at, updated_at, expires_at, realm, attribution, epistemic_basis, modality, confidence_band,
      subject_ref, predicate_key, temporal_kind, temporal_precision, valid_from, valid_to, source_timezone, valid_recurrence_rrule,
      recorded_from, recorded_to, visibility, origin_relationship_id, allowed_relationship_ids_json, evidence_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      ...scopeValues(scope), prepared.claimId, prepared.kind, prepared.content, prepared.normalized, prepared.sensitivity, "active", prepared.sourceMessageId,
      1, now, now, prepared.expiresAt, prepared.realm, prepared.attribution, prepared.epistemicBasis, prepared.modality,
      prepared.confidenceBand, prepared.subjectRef, prepared.predicateKey, prepared.temporal.kind, prepared.temporal.precision,
      prepared.temporal.validFrom, prepared.temporal.validTo, prepared.temporal.sourceTimezone, prepared.temporal.recurrenceRrule,
      now, null, prepared.visibility, prepared.originRelationshipId, JSON.stringify(prepared.allowedRelationshipIds), "available",
    );
    this.#db.prepare(`INSERT INTO claim_revisions (${SCOPE_COLUMNS}, claim_id, revision_no, operation, content, reason, actor_id, created_at,
      realm, attribution, epistemic_basis, modality, confidence_band, temporal_kind, temporal_precision, valid_from, valid_to,
      valid_recurrence_rrule, recorded_from, recorded_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      ...scopeValues(scope), prepared.claimId, 1, operation, prepared.content, null, auth.actorId, now, prepared.realm,
      prepared.attribution, prepared.epistemicBasis, prepared.modality, prepared.confidenceBand, prepared.temporal.kind,
      prepared.temporal.precision, prepared.temporal.validFrom, prepared.temporal.validTo, prepared.temporal.recurrenceRrule,
      now, null,
    );
    this.#db.prepare(`INSERT INTO claim_evidence (${SCOPE_COLUMNS}, claim_id, evidence_id, source_message_id, excerpt, evidence_kind, created_at,
      source_role, source_sequence, span_start, span_end, source_fingerprint, evidence_strength, realm_snapshot, attribution_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      ...scopeValues(scope), prepared.claimId, this.#idFactory(), prepared.sourceMessageId, prepared.content,
      prepared.sourceMessageId ? "source_message" : "explicit_memory", now, sourceMessage?.role ?? null,
      sourceMessage?.sequence_no ?? null, null, null, sourceMessage?.content_fingerprint ?? this.#fingerprint(prepared.content),
      prepared.epistemicBasis === "explicit_memory_request" ? "direct" : "supporting", prepared.realm, prepared.attribution,
    );
    for (const alias of prepared.aliases) {
      this.#db.prepare(`INSERT INTO memory_entities (${SCOPE_COLUMNS}, entity_id, claim_id, alias_normalized, display_alias, entity_kind, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        ...scopeValues(scope), this.#idFactory(), prepared.claimId, normalizeText(alias), alias, "alias", now,
      );
    }
    if (prepared.visibility !== "user_private" && this.#hasConsent(scope, "semantic_index") && ["ordinary", "personal"].includes(prepared.sensitivity)) {
      this.#db.prepare(`INSERT INTO memory_fts (tenant_id, user_id, relationship_id, companion_id, claim_id, content)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(...scopeValues(scope), prepared.claimId, prepared.content);
    }
    this.#enqueueOutbox(scope, "claim.created", "claim", prepared.claimId, { claimId: prepared.claimId }, `claim.created:${prepared.claimId}`);
    this.#audit(scope, auth.actorId, "claim.created", "claim", prepared.claimId, {
      receiptId, kind: prepared.kind, sourceMessageId: prepared.sourceMessageId, realm: prepared.realm,
      attribution: prepared.attribution, epistemicBasis: prepared.epistemicBasis,
    });
    return { claimId: prepared.claimId, kind: prepared.kind, realm: prepared.realm, attribution: prepared.attribution };
  }

  #decidePrivacy(auth, operation, content, metadata) {
    const decision = this.#privacyPolicy({ auth, operation, content, metadata: Object.freeze({ ...metadata }) });
    return normalizePrivacyDecision(decision, content);
  }

  #writePrivacyReceipt(scope, operation, originalContent, privacy) {
    const receiptId = this.#idFactory();
    this.#db.prepare(`INSERT INTO privacy_receipts (${SCOPE_COLUMNS}, receipt_id, operation, outcome, policy_version, reason, content_fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      ...scopeValues(scope), receiptId, operation, privacy.outcome, privacy.policyVersion, privacy.reason, this.#fingerprint(originalContent), this.#now(),
    );
    return receiptId;
  }

  #fingerprint(value) {
    return createHmac("sha256", this.#fingerprintKey).update(String(value)).digest("hex");
  }

  #requireConsent(scope, purpose) {
    const normalizedPurpose = canonicalConsentPurpose(purpose);
    if (!this.#hasConsent(scope, normalizedPurpose)) {
      throw new AuthorizationError(`An active ${normalizedPurpose} consent is required.`);
    }
  }

  #hasConsent(scope, purpose) {
    const normalizedPurpose = canonicalConsentPurpose(purpose);
    const row = this.#db.prepare(`SELECT decision, effective_at FROM consent_events_v2
      WHERE ${SCOPE_WHERE} AND purpose = ? ORDER BY recorded_order DESC LIMIT 1`)
      .get(...scopeValues(scope), normalizedPurpose);
    return row?.decision === "granted" && row.effective_at <= this.#now();
  }

  #assertNotSuppressed(scope, prepared) {
    const keys = suppressionLabels(prepared.normalized, prepared.aliases.map(normalizeText)).map((label) => this.#suppressionKey(label));
    if (!keys.length) return;
    const markers = keys.map(() => "?").join(", ");
    const row = this.#db.prepare(`SELECT suppress_key FROM suppression_rules WHERE ${SCOPE_WHERE} AND active = 1 AND suppress_key IN (${markers}) LIMIT 1`)
      .get(...scopeValues(scope), ...keys);
    if (row) throw new ConflictError("This memory was previously forgotten and is suppressed.", { suppressKey: row.suppress_key });
  }

  #assertDeletionEpoch(scope, expected) {
    const current = this.#deletionEpoch(scope);
    if (current !== expected) {
      throw new ConflictError("The worker result is stale because the memory scope changed.", {
        expectedDeletionEpoch: expected,
        currentDeletionEpoch: current,
      });
    }
  }

  #suppressionKey(label) {
    return `hmac:v1:${this.#fingerprint(label)}`;
  }

  #addSuppressionRules(scope, contentNormalized, aliases, reason, claimId, now) {
    // Alias-only rules such as "address" or "cat" block legitimate future
    // corrections. Bind aliases to the forgotten content instead; the exact
    // content rule remains the deterministic resurrection barrier.
    for (const label of suppressionLabels(contentNormalized, aliases)) {
      this.#db.prepare(`INSERT OR IGNORE INTO suppression_rules (${SCOPE_COLUMNS}, suppression_id, suppress_key, reason, created_from_claim_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        ...scopeValues(scope), this.#idFactory(), this.#suppressionKey(label), reason, claimId, now,
      );
    }
  }

  #upgradeLegacySuppressions() {
    const legacy = this.#db.prepare("SELECT tenant_id, user_id, relationship_id, companion_id, suppression_id, suppress_key FROM suppression_rules WHERE suppress_key NOT LIKE 'hmac:v1:%'").all();
    if (!legacy.length) return;
    this.#transaction(() => {
      for (const row of legacy) {
        if (row.suppress_key.startsWith("alias:")) {
          this.#db.prepare(`DELETE FROM suppression_rules WHERE ${SCOPE_WHERE} AND suppression_id = ?`)
            .run(row.tenant_id, row.user_id, row.relationship_id, row.companion_id, row.suppression_id);
          continue;
        }
        this.#db.prepare(`UPDATE suppression_rules SET suppress_key = ? WHERE ${SCOPE_WHERE} AND suppression_id = ?`)
          .run(this.#suppressionKey(row.suppress_key), row.tenant_id, row.user_id, row.relationship_id, row.companion_id, row.suppression_id);
      }
    });
  }

  #advanceDeletionEpoch(scope) {
    const now = this.#now();
    this.#db.prepare(`INSERT OR IGNORE INTO scope_epochs (${SCOPE_COLUMNS}, deletion_epoch, updated_at) VALUES (?, ?, ?, ?, 0, ?)`)
      .run(...scopeValues(scope), now);
    this.#db.prepare(`UPDATE scope_epochs SET deletion_epoch = deletion_epoch + 1, updated_at = ? WHERE ${SCOPE_WHERE}`)
      .run(now, ...scopeValues(scope));
    return this.#deletionEpoch(scope);
  }

  #deletionEpoch(scope) {
    const row = this.#db.prepare(`SELECT deletion_epoch FROM scope_epochs WHERE ${SCOPE_WHERE}`).get(...scopeValues(scope));
    return Number(row?.deletion_epoch ?? 0);
  }

  #removeFromSearch(scope, claimId) {
    this.#db.prepare(`DELETE FROM memory_fts WHERE tenant_id = ? AND user_id = ? AND relationship_id = ? AND companion_id = ? AND claim_id = ?`)
      .run(...scopeValues(scope), claimId);
    this.#db.prepare(`DELETE FROM memory_entities WHERE ${SCOPE_WHERE} AND claim_id = ?`).run(...scopeValues(scope), claimId);
  }

  #exactAliasCandidates(scope, normalized, limit, now, realms) {
    const realmMarkers = realms.map(() => "?").join(", ");
    return this.#db.prepare(`SELECT c.claim_id, c.kind, c.content, c.updated_at, c.expires_at, c.realm, c.attribution,
        c.epistemic_basis, c.modality, c.confidence_band, c.sensitivity, c.temporal_kind, c.temporal_precision,
        c.valid_from, c.valid_to, c.recorded_from, c.recorded_to, c.evidence_status
      FROM memory_entities e JOIN claims c ON c.tenant_id = e.tenant_id AND c.user_id = e.user_id
        AND c.relationship_id = e.relationship_id AND c.companion_id = e.companion_id AND c.claim_id = e.claim_id
      WHERE ${scopedWhere("e")} AND e.alias_normalized = ? AND c.status = 'active' AND c.deleted_at IS NULL
        AND c.visibility <> 'user_private' AND c.realm IN (${realmMarkers})
        AND (c.expires_at IS NULL OR c.expires_at > ?) ORDER BY c.updated_at DESC LIMIT ?`)
      .all(...scopeValues(scope), normalized, ...realms, now, limit)
      .map(candidateFromRow);
  }

  #embeddedShortAliasCandidates(scope, normalized, limit, now, realms) {
    if ([...normalized].length < 2) return [];
    const realmMarkers = realms.map(() => "?").join(", ");
    return this.#db.prepare(`SELECT c.claim_id, c.kind, c.content, c.updated_at, c.expires_at, c.realm, c.attribution,
        c.epistemic_basis, c.modality, c.confidence_band, c.sensitivity, c.temporal_kind, c.temporal_precision,
        c.valid_from, c.valid_to, c.recorded_from, c.recorded_to, c.evidence_status
      FROM memory_entities e JOIN claims c ON c.tenant_id = e.tenant_id AND c.user_id = e.user_id
        AND c.relationship_id = e.relationship_id AND c.companion_id = e.companion_id AND c.claim_id = e.claim_id
      WHERE ${scopedWhere("e")} AND length(e.alias_normalized) BETWEEN 1 AND 2
        AND instr(?, e.alias_normalized) > 0 AND c.status = 'active' AND c.deleted_at IS NULL
        AND c.visibility <> 'user_private' AND c.realm IN (${realmMarkers}) AND (c.expires_at IS NULL OR c.expires_at > ?)
      ORDER BY length(e.alias_normalized) DESC, c.updated_at DESC LIMIT ?`)
      .all(...scopeValues(scope), normalized, ...realms, now, limit)
      .map(candidateFromRow);
  }

  #ftsCandidates(scope, match, limit, now, realms) {
    const realmMarkers = realms.map(() => "?").join(", ");
    return this.#db.prepare(`SELECT c.claim_id, c.kind, c.content, c.updated_at, c.expires_at, c.realm, c.attribution,
        c.epistemic_basis, c.modality, c.confidence_band, c.sensitivity, c.temporal_kind, c.temporal_precision,
        c.valid_from, c.valid_to, c.recorded_from, c.recorded_to, c.evidence_status, bm25(memory_fts) AS lexical_score
      FROM memory_fts JOIN claims c ON c.tenant_id = memory_fts.tenant_id AND c.user_id = memory_fts.user_id
        AND c.relationship_id = memory_fts.relationship_id AND c.companion_id = memory_fts.companion_id AND c.claim_id = memory_fts.claim_id
      WHERE memory_fts.tenant_id = ? AND memory_fts.user_id = ? AND memory_fts.relationship_id = ? AND memory_fts.companion_id = ?
        AND memory_fts MATCH ? AND c.status = 'active' AND c.deleted_at IS NULL
        AND c.visibility <> 'user_private' AND c.realm IN (${realmMarkers})
        AND (c.expires_at IS NULL OR c.expires_at > ?)
      ORDER BY bm25(memory_fts) LIMIT ?`)
      .all(...scopeValues(scope), match, ...realms, now, limit)
      .map(candidateFromRow);
  }

  #boundedLikeCandidates(scope, shortTerm, limit, now, realms) {
    const escaped = escapeLike(shortTerm);
    const realmMarkers = realms.map(() => "?").join(", ");
    // LIKE cannot use the trigram index for 1/2-character terms. Limit the
    // rows entering that scan, not merely the rows returned from it. Important
    // short facts should also have an entity alias and bypass this fallback.
    return this.#db.prepare(`SELECT claim_id, kind, content, updated_at, expires_at, realm, attribution, epistemic_basis,
        modality, confidence_band, sensitivity, temporal_kind, temporal_precision, valid_from, valid_to,
        recorded_from, recorded_to, evidence_status FROM (
        SELECT claim_id, kind, content, content_normalized, updated_at, expires_at, realm, attribution, epistemic_basis,
          modality, confidence_band, sensitivity, temporal_kind, temporal_precision, valid_from, valid_to,
          recorded_from, recorded_to, evidence_status FROM claims
        WHERE ${SCOPE_WHERE} AND status = 'active' AND deleted_at IS NULL AND visibility <> 'user_private'
          AND realm IN (${realmMarkers}) AND (expires_at IS NULL OR expires_at > ?) ORDER BY updated_at DESC LIMIT ?
      ) AS recent_claims WHERE content_normalized LIKE ? ESCAPE '\\'
      ORDER BY updated_at DESC LIMIT ?`)
      .all(...scopeValues(scope), ...realms, now, MAX_SHORT_CJK_SCAN, `%${escaped}%`, Math.min(limit, MAX_LIKE_CANDIDATES))
      .map(candidateFromRow);
  }

  #writeRecallTrace(scope, result) {
    this.#transaction(() => {
      this.#db.prepare(`INSERT INTO recall_traces (${SCOPE_COLUMNS}, trace_id, query_fingerprint, strategies_json, selected_claim_ids_json, deletion_epoch, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        ...scopeValues(scope), this.#idFactory(), result.queryFingerprint, JSON.stringify(result.strategies),
        JSON.stringify(result.items.map((item) => item.id)), result.deletionEpoch, this.#now(),
      );
    });
  }

  #enqueueDurableJob(scope, { jobType, payload, idempotencyKey, runAfter = this.#now(), maxAttempts = 8 }) {
    const existing = this.#db.prepare(`SELECT job_id, status FROM durable_jobs WHERE ${SCOPE_WHERE} AND idempotency_key = ?`)
      .get(...scopeValues(scope), idempotencyKey);
    if (existing) return { jobId: existing.job_id, status: existing.status, deduplicated: true };
    const jobId = this.#idFactory();
    const now = this.#now();
    this.#db.prepare(`INSERT INTO durable_jobs (${SCOPE_COLUMNS}, job_id, job_type, payload_json, idempotency_key, status, run_after,
      attempts, max_attempts, created_at, updated_at, scope_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      ...scopeValues(scope), jobId, jobType, safeJson(payload, "payload"), idempotencyKey, "queued", runAfter, 0, maxAttempts, now, now,
      this.#deletionEpoch(scope),
    );
    return { jobId, status: "queued", deduplicated: false };
  }

  #enqueueOutbox(scope, eventType, aggregateType, aggregateId, payload, idempotencyKey) {
    const existing = this.#db.prepare(`SELECT event_id FROM outbox_events WHERE ${SCOPE_WHERE} AND idempotency_key = ?`)
      .get(...scopeValues(scope), idempotencyKey);
    if (existing) return existing.event_id;
    const eventId = this.#idFactory();
    this.#db.prepare(`INSERT INTO outbox_events (${SCOPE_COLUMNS}, event_id, event_type, aggregate_type, aggregate_id, payload_json,
      idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      ...scopeValues(scope), eventId, eventType, aggregateType, aggregateId, safeJson(payload, "payload"), idempotencyKey, this.#now(),
    );
    return eventId;
  }

  #audit(scope, actorId, action, targetType, targetId, metadata) {
    this.#db.prepare(`INSERT INTO audit_events (${SCOPE_COLUMNS}, audit_id, actor_id, action, target_type, target_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      ...scopeValues(scope), this.#idFactory(), actorId, action, targetType, targetId, safeJson(metadata, "metadata"), this.#now(),
    );
  }

  #requestFingerprint(value) {
    return this.#fingerprint(stableJson(value));
  }

  #readIdempotentWrite(scope, operation, key, requestFingerprint) {
    if (!key) return null;
    const row = this.#db.prepare(`SELECT request_fingerprint, response_json FROM idempotent_writes
      WHERE ${SCOPE_WHERE} AND operation = ? AND idempotency_key = ?`)
      .get(...scopeValues(scope), operation, key);
    if (!row) return null;
    if (row.request_fingerprint !== requestFingerprint) {
      throw new ConflictError("The idempotency key was reused with a different request.", { operation, idempotencyKey: key });
    }
    return { ...JSON.parse(row.response_json), idempotent: true };
  }

  #storeIdempotentWrite(scope, operation, key, requestFingerprint, response) {
    if (!key) return response;
    this.#db.prepare(`INSERT INTO idempotent_writes (${SCOPE_COLUMNS}, operation, idempotency_key, request_fingerprint, response_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...scopeValues(scope), operation, key, requestFingerprint, safeJson(response, "response"), this.#now());
    return response;
  }

  #claim(scope, claimId) {
    return this.#db.prepare(`SELECT * FROM claims WHERE ${SCOPE_WHERE} AND claim_id = ?`).get(...scopeValues(scope), claimId);
  }

  #claimLineage(scope, claimId) {
    const edges = this.#db.prepare(`SELECT previous_claim_id, replacement_claim_id FROM corrections
      WHERE ${SCOPE_WHERE} LIMIT 10001`).all(...scopeValues(scope));
    if (edges.length > 10_000) throw new ConflictError("The correction lineage is too large for one deletion transaction");
    const adjacent = new Map();
    for (const edge of edges) {
      if (!adjacent.has(edge.previous_claim_id)) adjacent.set(edge.previous_claim_id, []);
      if (!adjacent.has(edge.replacement_claim_id)) adjacent.set(edge.replacement_claim_id, []);
      adjacent.get(edge.previous_claim_id).push(edge.replacement_claim_id);
      adjacent.get(edge.replacement_claim_id).push(edge.previous_claim_id);
    }
    const queue = [claimId];
    const visited = new Set();
    const claims = [];
    while (queue.length) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      const claim = this.#claim(scope, current);
      if (claim) claims.push(claim);
      for (const next of adjacent.get(current) ?? []) if (!visited.has(next)) queue.push(next);
    }
    return claims;
  }

  #activeClaim(scope, claimId) {
    return this.#db.prepare(`SELECT * FROM claims WHERE ${SCOPE_WHERE} AND claim_id = ? AND status = 'active' AND deleted_at IS NULL`)
      .get(...scopeValues(scope), claimId);
  }

  #message(scope, messageId) {
    return this.#db.prepare(`SELECT message_id, role, sequence_no, content_fingerprint, realm_hint FROM messages
      WHERE ${SCOPE_WHERE} AND message_id = ? AND deleted_at IS NULL`)
      .get(...scopeValues(scope), messageId);
  }

  #transaction(fn) {
    this.#db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.#db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK;");
      throw error;
    }
  }
}

function scopeFrom(auth) {
  if (!auth || !auth[TRUSTED_SCOPE]) throw new AuthorizationError();
  return auth[TRUSTED_SCOPE];
}

function scopeValues(scope) {
  return [scope.tenantId, scope.userId, scope.relationshipId, scope.companionId];
}

function scopedWhere(tableAlias) {
  return `${tableAlias}.tenant_id = ? AND ${tableAlias}.user_id = ? AND ${tableAlias}.relationship_id = ? AND ${tableAlias}.companion_id = ?`;
}

function requireId(value, field) {
  return requireText(value, field, 200);
}

function requireText(value, field, maximum = 12_000) {
  if (typeof value !== "string" || value.trim().length === 0) throw new ValidationError(`${field} must be a non-empty string`);
  const result = value.trim();
  if (result.length > maximum) throw new ValidationError(`${field} exceeds ${maximum} characters`);
  return result;
}

function nullableText(value, maximum = 12_000) {
  if (value == null) return null;
  return requireText(value, "value", maximum);
}

function requireEnum(value, field, allowed) {
  const normalized = requireText(value, field, 160);
  if (!allowed.has(normalized)) {
    throw new ValidationError(`${field} must be one of: ${[...allowed].join(", ")}`);
  }
  return normalized;
}

function requireMachineKey(value, field) {
  const normalized = requireText(value, field, 128);
  if (!/^[a-z][a-z0-9._-]{0,127}$/.test(normalized)) {
    throw new ValidationError(`${field} must be a lowercase machine key`);
  }
  return normalized;
}

function defaultPredicateForKind(kind) {
  return /^[a-z][a-z0-9._-]{0,127}$/.test(kind) ? kind : "memory.fact";
}

function canonicalConsentPurpose(value) {
  const requested = requireText(value, "purpose", 80);
  const normalized = LEGACY_CONSENT_ALIASES.get(requested) ?? requested;
  if (!CONSENT_PURPOSES.has(normalized)) throw new ValidationError("unsupported consent purpose");
  return normalized;
}

function normalizeConsentPurposeList(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > CONSENT_PURPOSES.size) {
    throw new ValidationError("purposes must be a non-empty bounded array");
  }
  return [...new Set(value.map(canonicalConsentPurpose))];
}

function normalizeRealmFilter(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > REALMS.size) {
    throw new ValidationError(`allowedRealms must contain between 1 and ${REALMS.size} realms`);
  }
  const result = [...new Set(value.map((realm) => requireEnum(realm, "allowedRealms", REALMS)))];
  if (!result.length) throw new ValidationError("allowedRealms must not be empty");
  return result;
}

function normalizeAllowedRelationships(value, visibility, originRelationshipId) {
  const supplied = value == null ? null : value;
  if (supplied != null && !Array.isArray(supplied)) throw new ValidationError("allowedRelationshipIds must be an array");
  const unique = supplied == null ? [] : [...new Set(supplied.map((id) => requireId(id, "allowedRelationshipId")))];
  if (unique.length > 32) throw new ValidationError("allowedRelationshipIds may contain at most 32 entries");
  if (visibility === "user_private") {
    if (unique.length) throw new ValidationError("user_private memory cannot name relationship grants");
    return [];
  }
  if (visibility === "relationship_only") {
    if (unique.length && (unique.length !== 1 || unique[0] !== originRelationshipId)) {
      throw new ValidationError("relationship_only memory must be limited to its origin relationship");
    }
    return [originRelationshipId];
  }
  if (unique.length < 2 || !unique.includes(originRelationshipId)) {
    throw new ValidationError("explicit_shared memory requires the origin and at least one additional relationship");
  }
  return unique;
}

function normalizeTemporal(value) {
  if (value != null && (typeof value !== "object" || Array.isArray(value))) {
    throw new ValidationError("temporal must be an object");
  }
  const source = value ?? {};
  const kind = requireEnum(source.kind ?? "unknown", "temporal.kind", TEMPORAL_KINDS);
  const precision = requireEnum(source.precision ?? "unknown", "temporal.precision", TEMPORAL_PRECISIONS);
  const validFrom = source.validFrom == null ? null : integerTime(source.validFrom, "temporal.validFrom");
  const validTo = source.validTo == null ? null : integerTime(source.validTo, "temporal.validTo");
  const sourceTimezone = source.sourceTimezone == null ? null : requireTimezone(source.sourceTimezone);
  const recurrenceRrule = source.recurrenceRrule == null ? null : requireRrule(source.recurrenceRrule);
  if (validFrom != null && validTo != null && validTo < validFrom) {
    throw new ValidationError("temporal.validTo must not precede temporal.validFrom");
  }
  if (["timeless", "unknown"].includes(kind) && [validFrom, validTo, sourceTimezone, recurrenceRrule].some((item) => item != null)) {
    throw new ValidationError(`${kind} temporal values cannot include bounds, timezone, or recurrence`);
  }
  if (kind === "point" && (validFrom == null || validTo != null || recurrenceRrule != null)) {
    throw new ValidationError("point temporal values require validFrom and forbid validTo/recurrence");
  }
  if (kind === "interval" && (validFrom == null || validTo == null || recurrenceRrule != null)) {
    throw new ValidationError("interval temporal values require validFrom and validTo and forbid recurrence");
  }
  if (kind === "recurring" && (sourceTimezone == null || recurrenceRrule == null)) {
    throw new ValidationError("recurring temporal values require sourceTimezone and recurrenceRrule");
  }
  return Object.freeze({ kind, precision, validFrom, validTo, sourceTimezone, recurrenceRrule });
}

function requireTimezone(value) {
  const timezone = requireText(value, "temporal.sourceTimezone", 128);
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
  } catch {
    throw new ValidationError("temporal.sourceTimezone must be a valid IANA timezone");
  }
  return timezone;
}

function requireRrule(value) {
  const rrule = requireText(value, "temporal.recurrenceRrule", 512);
  if (/[\r\n]/.test(rrule) || !/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+-]+)*$/.test(rrule)) {
    throw new ValidationError("temporal.recurrenceRrule must be a bounded RFC 5545 recurrence rule");
  }
  return rrule;
}

function nullableId(value) {
  return value == null ? null : requireId(value, "id");
}

function nullableIdempotencyKey(value) {
  return value == null ? null : requireText(value, "idempotencyKey", 240);
}

function integerTime(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new ValidationError(`${field} must be a non-negative millisecond timestamp`);
  return value;
}

function boundedInteger(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new ValidationError(`${field} must be an integer between ${min} and ${max}`);
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new ValidationError(`${field} must be a non-negative safe integer`);
  return value;
}

function nullableMinute(value, field) {
  return value == null ? null : boundedInteger(value, field, 0, 1439);
}

function requireReasonCode(value) {
  const code = requireText(value, "reasonCode", 80);
  if (!/^[a-z][a-z0-9_]*$/.test(code)) throw new ValidationError("reasonCode must be a stable machine-readable code");
  return code;
}

function normalizeText(value) {
  return String(value).normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/g, " ").trim();
}

function normalizeFingerprintKey(value) {
  if (typeof value === "string" && value.length >= 16) return value;
  if (value instanceof Uint8Array && value.byteLength >= 16) return value;
  throw new ValidationError("fingerprintKey must contain at least 16 bytes");
}

function uniqueAliases(aliases) {
  if (!Array.isArray(aliases)) throw new ValidationError("aliases must be an array");
  if (aliases.length > MAX_ALIAS_COUNT) throw new ValidationError(`aliases may contain at most ${MAX_ALIAS_COUNT} entries`);
  const seen = new Set();
  const result = [];
  for (const alias of aliases) {
    const clean = requireText(alias, "alias", 120);
    const normalized = normalizeText(clean);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(clean);
    }
  }
  return result;
}

function suppressionLabels(contentNormalized, aliases) {
  const labels = new Set();
  if (!contentNormalized) return [];
  labels.add(`content:${contentNormalized}`);
  for (const alias of aliases) {
    const normalizedAlias = normalizeText(alias);
    if (normalizedAlias) labels.add(`alias-content:${normalizedAlias}:${contentNormalized}`);
  }
  return [...labels];
}

function candidateFromRow(row) {
  return {
    id: row.claim_id,
    kind: row.kind,
    content: row.content,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    realm: row.realm,
    attribution: row.attribution,
    epistemicBasis: row.epistemic_basis,
    modality: row.modality,
    confidenceBand: row.confidence_band,
    sensitivity: row.sensitivity,
    temporal: {
      kind: row.temporal_kind,
      precision: row.temporal_precision,
      validFrom: row.valid_from,
      validTo: row.valid_to,
    },
    recordedAt: row.recorded_from,
    recordedUntil: row.recorded_to,
    evidenceState: row.evidence_status,
  };
}

function toClaim(row) {
  return {
    claimId: row.claim_id,
    kind: row.kind,
    content: row.content,
    sensitivity: row.sensitivity,
    status: row.status,
    sourceMessageId: row.source_message_id,
    currentRevision: row.current_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
    expiresAt: row.expires_at,
    deletedAt: row.deleted_at,
    deletionEpoch: row.deletion_epoch,
    realm: row.realm,
    attribution: row.attribution,
    epistemicBasis: row.epistemic_basis,
    modality: row.modality,
    confidenceBand: row.confidence_band,
    subjectRef: row.subject_ref,
    predicateKey: row.predicate_key,
    temporal: {
      kind: row.temporal_kind,
      precision: row.temporal_precision,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      sourceTimezone: row.source_timezone,
      recurrenceRrule: row.valid_recurrence_rrule,
    },
    recordedAt: row.recorded_from,
    recordedUntil: row.recorded_to,
    visibility: row.visibility,
    originRelationshipId: row.origin_relationship_id,
    allowedRelationshipIds: parseJsonArray(row.allowed_relationship_ids_json),
    evidenceState: row.evidence_status,
  };
}

function toRevision(row) {
  return {
    revision: row.revision_no,
    operation: row.operation,
    content: row.content,
    reason: row.reason,
    actorId: row.actor_id,
    createdAt: row.created_at,
    realm: row.realm,
    attribution: row.attribution,
    epistemicBasis: row.epistemic_basis,
    modality: row.modality,
    confidenceBand: row.confidence_band,
    temporal: {
      kind: row.temporal_kind,
      precision: row.temporal_precision,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      recurrenceRrule: row.valid_recurrence_rrule,
    },
    recordedAt: row.recorded_from,
    recordedUntil: row.recorded_to,
  };
}

function toEvidence(row) {
  return {
    evidenceId: row.evidence_id,
    sourceMessageId: row.source_message_id,
    excerpt: row.excerpt,
    kind: row.evidence_kind,
    sourceRole: row.source_role,
    sourceSequence: row.source_sequence,
    spanStart: row.span_start,
    spanEnd: row.span_end,
    sourceFingerprint: row.source_fingerprint,
    strength: row.evidence_strength,
    realm: row.realm_snapshot,
    attribution: row.attribution_snapshot,
    createdAt: row.created_at,
  };
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isShortCjkTerm(query) {
  const parts = query.match(CJK_SEQUENCE) ?? [];
  return parts.length === 1 && [...parts[0]].length >= 1 && [...parts[0]].length <= 2 && query === parts[0];
}

function ftsMatchQuery(query) {
  const cjkTerms = query.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]{3,}/gu) ?? [];
  const wordTerms = query.match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
  const terms = [...new Set([...cjkTerms, ...wordTerms].map((term) => term.slice(0, 64)))].slice(0, 6);
  return terms.length ? terms.map((term) => `"${term.replaceAll('"', '')}"`).join(" OR ") : null;
}

function escapeLike(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function safeJson(value, field) {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") throw new Error("not serializable");
    if (encoded.length > 100_000) throw new Error("too large");
    return encoded;
  } catch {
    throw new ValidationError(`${field} must be JSON serializable and at most 100KB`);
  }
}

function stableJson(value) {
  const seen = new Set();
  const normalize = (item) => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new ValidationError("idempotent request values must be finite");
      return item;
    }
    if (typeof item === "undefined") return null;
    if (typeof item !== "object") throw new ValidationError("idempotent request values must be JSON serializable");
    if (seen.has(item)) throw new ValidationError("idempotent request values must not be circular");
    seen.add(item);
    let result;
    if (Array.isArray(item)) result = item.map(normalize);
    else {
      result = {};
      for (const key of Object.keys(item).sort()) result[key] = normalize(item[key]);
    }
    seen.delete(item);
    return result;
  };
  return JSON.stringify(normalize(value));
}
