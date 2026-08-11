import { ValidationError } from "./errors.js";

export const LATEST_SCHEMA_VERSION = 8;

/*
 * All user-owned records have the same composite scope. This is intentional:
 * a query missing any one of these four keys cannot be expressed through the
 * repository API. The application must map its verified session to this scope
 * before calling the package.
 */
const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS scope_epochs (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  deletion_epoch INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS messages (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, message_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS messages_scope_time_idx
  ON messages (tenant_id, user_id, relationship_id, companion_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS privacy_receipts (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('allow', 'redact', 'deny')),
  policy_version TEXT NOT NULL,
  reason TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, receipt_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS privacy_receipts_scope_time_idx
  ON privacy_receipts (tenant_id, user_id, relationship_id, companion_id, created_at DESC);

CREATE TABLE IF NOT EXISTS claims (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  content_normalized TEXT NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'personal',
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'deleted', 'expired')),
  source_message_id TEXT,
  current_revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  expires_at INTEGER,
  deleted_at INTEGER,
  deletion_epoch INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, claim_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS claims_scope_status_time_idx
  ON claims (tenant_id, user_id, relationship_id, companion_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS claims_scope_source_idx
  ON claims (tenant_id, user_id, relationship_id, companion_id, source_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS claims_active_dedupe_idx
  ON claims (tenant_id, user_id, relationship_id, companion_id, content_normalized)
  WHERE status = 'active' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS claim_revisions (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('created', 'corrected', 'superseded', 'deleted', 'confirmed')),
  content TEXT NOT NULL,
  reason TEXT,
  actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, claim_id, revision_no)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS claim_evidence (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  source_message_id TEXT,
  excerpt TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, claim_id, evidence_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS corrections (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  correction_id TEXT NOT NULL,
  previous_claim_id TEXT NOT NULL,
  replacement_claim_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, correction_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS corrections_previous_idx
  ON corrections (tenant_id, user_id, relationship_id, companion_id, previous_claim_id);

CREATE TABLE IF NOT EXISTS deletion_tombstones (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  tombstone_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  deletion_epoch INTEGER NOT NULL,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, tombstone_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS tombstones_claim_idx
  ON deletion_tombstones (tenant_id, user_id, relationship_id, companion_id, claim_id);

CREATE TABLE IF NOT EXISTS suppression_rules (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  suppression_id TEXT NOT NULL,
  suppress_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_from_claim_id TEXT,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, suppression_id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS suppression_active_key_idx
  ON suppression_rules (tenant_id, user_id, relationship_id, companion_id, suppress_key)
  WHERE active = 1;

CREATE TABLE IF NOT EXISTS memory_entities (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  alias_normalized TEXT NOT NULL,
  display_alias TEXT NOT NULL,
  entity_kind TEXT NOT NULL DEFAULT 'alias',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, entity_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS entities_exact_alias_idx
  ON memory_entities (tenant_id, user_id, relationship_id, companion_id, alias_normalized, claim_id);

-- Trigram is deliberately used only for >=3-character FTS candidates. The
-- repository sends 1/2-character CJK terms through exact aliases and a small,
-- scope-bound LIKE query so that FTS token boundaries cannot erase them.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  tenant_id UNINDEXED,
  user_id UNINDEXED,
  relationship_id UNINDEXED,
  companion_id UNINDEXED,
  claim_id UNINDEXED,
  content,
  tokenize = 'trigram case_sensitive 0'
);

CREATE TABLE IF NOT EXISTS segment_summaries (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  start_message_id TEXT,
  end_message_id TEXT,
  summary TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  prompt_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, segment_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS prompt_versions (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  prompt_name TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  body_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, prompt_name, version)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS prompt_versions_active_idx
  ON prompt_versions (tenant_id, user_id, relationship_id, companion_id, prompt_name, status, version DESC);

CREATE TABLE IF NOT EXISTS consent_records (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  consent_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('memory', 'proactive', 'analytics', 'sensitive_memory')),
  granted INTEGER NOT NULL CHECK (granted IN (0, 1)),
  policy_version TEXT NOT NULL,
  source TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, consent_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS consent_current_idx
  ON consent_records (tenant_id, user_id, relationship_id, companion_id, category, recorded_at DESC);

CREATE TABLE IF NOT EXISTS durable_jobs (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  run_after INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, job_id),
  UNIQUE (tenant_id, user_id, relationship_id, companion_id, idempotency_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS durable_jobs_due_idx
  ON durable_jobs (tenant_id, user_id, relationship_id, companion_id, status, run_after);

CREATE TABLE IF NOT EXISTS outbox_events (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, event_id),
  UNIQUE (tenant_id, user_id, relationship_id, companion_id, idempotency_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS outbox_pending_idx
  ON outbox_events (tenant_id, user_id, relationship_id, companion_id, delivered_at, created_at);

CREATE TABLE IF NOT EXISTS proactive_preferences (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  quiet_start_minute INTEGER,
  quiet_end_minute INTEGER,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS proactive_events (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'sent', 'cancelled', 'expired')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, event_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS proactive_due_idx
  ON proactive_events (tenant_id, user_id, relationship_id, companion_id, status, due_at);

CREATE TABLE IF NOT EXISTS task_cursors (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  task_name TEXT NOT NULL,
  cursor_json TEXT NOT NULL,
  watermark TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, task_name)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS recall_traces (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  query_fingerprint TEXT NOT NULL,
  strategies_json TEXT NOT NULL,
  selected_claim_ids_json TEXT NOT NULL,
  deletion_epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, trace_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS recall_traces_time_idx
  ON recall_traces (tenant_id, user_id, relationship_id, companion_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, audit_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS audit_events_time_idx
  ON audit_events (tenant_id, user_id, relationship_id, companion_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cost_events (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  cost_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  amount_microunits INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, cost_id)
) WITHOUT ROWID;
`;

export const MIGRATIONS = [
  { version: 1, name: "memory-core-initial", sql: INITIAL_SCHEMA },
  {
    version: 2,
    name: "consent-ordering",
    sql: `
      ALTER TABLE consent_records ADD COLUMN recorded_order INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS consent_current_ordered_idx
        ON consent_records (tenant_id, user_id, relationship_id, companion_id, category, recorded_order DESC);
    `,
  },
  {
    version: 3,
    name: "outbox-delivery-leases",
    sql: `
      ALTER TABLE outbox_events ADD COLUMN lease_owner TEXT;
      ALTER TABLE outbox_events ADD COLUMN lease_expires_at INTEGER;
      ALTER TABLE outbox_events ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS outbox_lease_idx
        ON outbox_events (tenant_id, user_id, relationship_id, companion_id, delivered_at, lease_expires_at, created_at);
    `,
  },
  {
    version: 4,
    name: "write-idempotency-and-worker-epochs",
    sql: `
      ALTER TABLE durable_jobs ADD COLUMN scope_epoch INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS idempotent_writes (
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        relationship_id TEXT NOT NULL,
        companion_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, operation, idempotency_key)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idempotent_writes_time_idx
        ON idempotent_writes (tenant_id, user_id, relationship_id, companion_id, created_at DESC);
    `,
  },
  {
    version: 5,
    name: "outbox-revocation",
    sql: `
      ALTER TABLE outbox_events ADD COLUMN cancelled_at INTEGER;
      ALTER TABLE outbox_events ADD COLUMN cancel_reason TEXT;
      CREATE INDEX IF NOT EXISTS outbox_dispatchable_idx
        ON outbox_events (tenant_id, user_id, relationship_id, companion_id, delivered_at, cancelled_at, lease_expires_at, created_at);
    `,
  },
  {
    version: 6,
    name: "domain-semantics-bitemporal-consent-v2",
    sql: `
      -- Conversation identity stays server-owned. Existing rows are explicitly
      -- marked legacy rather than being guessed into a real conversation.
      ALTER TABLE messages ADD COLUMN conversation_id TEXT NOT NULL DEFAULT 'legacy';
      ALTER TABLE messages ADD COLUMN sequence_no INTEGER;
      ALTER TABLE messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'chat_message';
      ALTER TABLE messages ADD COLUMN realm_hint TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE messages ADD COLUMN privacy_class TEXT NOT NULL DEFAULT 'personal';
      ALTER TABLE messages ADD COLUMN retention_mode TEXT NOT NULL DEFAULT 'rolling_window';
      ALTER TABLE messages ADD COLUMN storage_state TEXT NOT NULL DEFAULT 'persisted';
      CREATE UNIQUE INDEX IF NOT EXISTS messages_conversation_sequence_idx
        ON messages (tenant_id, user_id, relationship_id, companion_id, conversation_id, sequence_no)
        WHERE sequence_no IS NOT NULL;

      -- A Claim is a versioned, attributed proposition, not a bare text blob.
      ALTER TABLE claims ADD COLUMN realm TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE claims ADD COLUMN attribution TEXT NOT NULL DEFAULT 'user_self_report';
      ALTER TABLE claims ADD COLUMN epistemic_basis TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE claims ADD COLUMN modality TEXT NOT NULL DEFAULT 'asserted';
      ALTER TABLE claims ADD COLUMN confidence_band TEXT NOT NULL DEFAULT 'low';
      ALTER TABLE claims ADD COLUMN subject_ref TEXT;
      ALTER TABLE claims ADD COLUMN predicate_key TEXT;
      ALTER TABLE claims ADD COLUMN temporal_kind TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE claims ADD COLUMN temporal_precision TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE claims ADD COLUMN valid_from INTEGER;
      ALTER TABLE claims ADD COLUMN valid_to INTEGER;
      ALTER TABLE claims ADD COLUMN source_timezone TEXT;
      ALTER TABLE claims ADD COLUMN recorded_from INTEGER;
      ALTER TABLE claims ADD COLUMN recorded_to INTEGER;
      ALTER TABLE claims ADD COLUMN visibility TEXT NOT NULL DEFAULT 'relationship_only';
      ALTER TABLE claims ADD COLUMN origin_relationship_id TEXT;
      ALTER TABLE claims ADD COLUMN allowed_relationship_ids_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE claims ADD COLUMN evidence_status TEXT NOT NULL DEFAULT 'available';
      UPDATE claims SET recorded_from = created_at WHERE recorded_from IS NULL;
      UPDATE claims SET origin_relationship_id = relationship_id WHERE origin_relationship_id IS NULL;
      UPDATE claims SET allowed_relationship_ids_json = json_array(relationship_id) WHERE allowed_relationship_ids_json = '[]';
      CREATE INDEX IF NOT EXISTS claims_realm_time_idx
        ON claims (tenant_id, user_id, relationship_id, companion_id, realm, valid_from, valid_to, status);
      CREATE INDEX IF NOT EXISTS claims_subject_predicate_idx
        ON claims (tenant_id, user_id, relationship_id, companion_id, subject_ref, predicate_key, status);

      ALTER TABLE claim_revisions ADD COLUMN realm TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE claim_revisions ADD COLUMN attribution TEXT NOT NULL DEFAULT 'user_self_report';
      ALTER TABLE claim_revisions ADD COLUMN epistemic_basis TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE claim_revisions ADD COLUMN modality TEXT NOT NULL DEFAULT 'asserted';
      ALTER TABLE claim_revisions ADD COLUMN confidence_band TEXT NOT NULL DEFAULT 'low';
      ALTER TABLE claim_revisions ADD COLUMN temporal_kind TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE claim_revisions ADD COLUMN temporal_precision TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE claim_revisions ADD COLUMN valid_from INTEGER;
      ALTER TABLE claim_revisions ADD COLUMN valid_to INTEGER;
      ALTER TABLE claim_revisions ADD COLUMN recorded_from INTEGER;
      ALTER TABLE claim_revisions ADD COLUMN recorded_to INTEGER;
      UPDATE claim_revisions SET recorded_from = created_at WHERE recorded_from IS NULL;

      ALTER TABLE claim_evidence ADD COLUMN source_role TEXT;
      ALTER TABLE claim_evidence ADD COLUMN source_sequence INTEGER;
      ALTER TABLE claim_evidence ADD COLUMN span_start INTEGER;
      ALTER TABLE claim_evidence ADD COLUMN span_end INTEGER;
      ALTER TABLE claim_evidence ADD COLUMN source_fingerprint TEXT;
      ALTER TABLE claim_evidence ADD COLUMN evidence_strength TEXT NOT NULL DEFAULT 'direct';
      ALTER TABLE claim_evidence ADD COLUMN realm_snapshot TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE claim_evidence ADD COLUMN attribution_snapshot TEXT NOT NULL DEFAULT 'user_self_report';

      -- Purpose-specific consent replaces the coarse legacy categories. The
      -- old table remains readable only for migration/audit; all new decisions
      -- and gates use this append-only event table.
      CREATE TABLE IF NOT EXISTS consent_events_v2 (
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        relationship_id TEXT NOT NULL,
        companion_id TEXT NOT NULL,
        consent_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('granted', 'revoked')),
        policy_version TEXT NOT NULL,
        source TEXT NOT NULL,
        effective_at INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL,
        recorded_order INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, consent_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS consent_v2_current_idx
        ON consent_events_v2 (tenant_id, user_id, relationship_id, companion_id, purpose, recorded_order DESC);
    `,
  },
  {
    version: 7,
    name: "recurring-time-and-legacy-consent-backfill",
    sql: `
      ALTER TABLE claims ADD COLUMN valid_recurrence_rrule TEXT;
      ALTER TABLE claim_revisions ADD COLUMN valid_recurrence_rrule TEXT;

      -- Preserve explicit choices made before purpose-specific consent existed.
      -- The old table stays as immutable migration/audit input; runtime gates
      -- read consent_events_v2 exclusively after this backfill.
      INSERT OR IGNORE INTO consent_events_v2 (
        tenant_id, user_id, relationship_id, companion_id, consent_id,
        purpose, decision, policy_version, source, effective_at, recorded_at, recorded_order
      )
      SELECT tenant_id, user_id, relationship_id, companion_id, consent_id,
        CASE category
          WHEN 'memory' THEN 'memory_ordinary'
          WHEN 'sensitive_memory' THEN 'memory_sensitive'
          WHEN 'proactive' THEN 'proactive_transactional'
          ELSE category
        END,
        CASE granted WHEN 1 THEN 'granted' ELSE 'revoked' END,
        policy_version, 'legacy:' || source, recorded_at, recorded_at, recorded_order
      FROM consent_records;

      CREATE UNIQUE INDEX IF NOT EXISTS consent_v2_scope_order_uq
        ON consent_events_v2 (tenant_id, user_id, relationship_id, companion_id, recorded_order);
    `,
  },
  {
    version: 8,
    name: "one-time-action-nonces",
    sql: `
      CREATE TABLE IF NOT EXISTS consumed_action_nonces (
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        relationship_id TEXT NOT NULL,
        companion_id TEXT NOT NULL,
        nonce_fingerprint TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, user_id, relationship_id, companion_id, nonce_fingerprint)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS consumed_action_nonces_expiry_idx
        ON consumed_action_nonces (expires_at);
    `,
  },
];

export function applyMigrations(db, now = Date.now()) {
  if (!db || typeof db.exec !== "function" || typeof db.prepare !== "function") {
    throw new ValidationError("applyMigrations requires a node:sqlite DatabaseSync instance");
  }

  db.exec("PRAGMA foreign_keys = ON;");
  // WAL permits readers to continue while a short write transaction updates a
  // claim or cursor. DatabaseSync users still need a single-writer route per
  // SQLite file when deploying multiple application processes.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA trusted_schema = OFF;");
  db.exec("PRAGMA secure_delete = ON;");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );`);

  db.exec("BEGIN IMMEDIATE;");
  try {
    const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, now);
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}
