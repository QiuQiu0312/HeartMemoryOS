-- Companion Memory Engine V2 — PostgreSQL 15+ production reference schema
-- This file is an architectural contract, not a substitute for reviewed, ordered migrations.
-- All user-scoped application transactions MUST set these verified values with SET LOCAL after token validation:
--   app.tenant_id, app.user_id, app.request_id
-- Never populate them from request JSON/query parameters.
-- A dedicated tenant dispatcher may read only payload-free worker_wakeups with app.tenant_id set;
-- it then derives app.user_id from that server-owned row before opening any user-scoped transaction.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS cmem;

REVOKE ALL ON SCHEMA cmem FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_request_id()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.request_id', true), '')
$$;

CREATE OR REPLACE FUNCTION app.current_is_tenant_admin()
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.tenant_admin', true), '')::boolean, false)
$$;

CREATE TYPE cmem.message_role AS ENUM ('user', 'assistant', 'tool');
CREATE TYPE cmem.memory_realm AS ENUM
  ('real_world', 'relationship_canon', 'roleplay', 'fictional', 'hypothetical', 'quoted', 'unknown');
CREATE TYPE cmem.attribution_kind AS ENUM
  ('user_self_report', 'user_about_other', 'companion_statement', 'system_observed', 'imported', 'inferred');
CREATE TYPE cmem.epistemic_basis_kind AS ENUM
  ('explicit_memory_request', 'explicit_statement', 'user_confirmation', 'repeated_inference', 'behavioral_signal', 'assistant_generated', 'quoted_report', 'imported_record', 'unknown');
CREATE TYPE cmem.memory_type AS ENUM
  ('identity', 'preference', 'boundary', 'relationship', 'event', 'commitment', 'routine', 'goal', 'temporary', 'communication_style');
CREATE TYPE cmem.sensitivity_level AS ENUM
  ('ordinary', 'personal', 'sensitive', 'highly_sensitive', 'prohibited');
CREATE TYPE cmem.memory_state AS ENUM
  ('pending_confirmation', 'active', 'contested', 'expired', 'rejected', 'logically_deleted');
CREATE TYPE cmem.job_state AS ENUM
  ('queued', 'leased', 'running', 'succeeded', 'retry_wait', 'dead_letter', 'cancelled');
-- A recurring event is a durable schedule; each materialized occurrence has its own delivery pipeline.
-- Keeping these states separate prevents the first completed occurrence from terminating the schedule.
CREATE TYPE cmem.proactive_event_state AS ENUM
  ('scheduled', 'paused', 'completed', 'cancelled', 'expired', 'failed');
CREATE TYPE cmem.proactive_occurrence_state AS ENUM
  ('scheduled', 'leased', 'policy_checked', 'generated', 'outbox_committed',
   'provider_accepted', 'delivered', 'opened', 'completed', 'cancelled', 'expired', 'failed');

CREATE TABLE cmem.tenants (
  tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{2,62}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  data_region text NOT NULL,
  key_version integer NOT NULL DEFAULT 1 CHECK (key_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_at timestamptz
);

CREATE TABLE cmem.app_users (
  tenant_id uuid NOT NULL REFERENCES cmem.tenants(tenant_id),
  user_id uuid NOT NULL DEFAULT gen_random_uuid(),
  external_subject_hmac bytea NOT NULL,
  deletion_epoch bigint NOT NULL DEFAULT 0 CHECK (deletion_epoch >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleting', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id),
  UNIQUE (tenant_id, external_subject_hmac)
);

CREATE TABLE cmem.companions (
  tenant_id uuid NOT NULL REFERENCES cmem.tenants(tenant_id),
  companion_id uuid NOT NULL DEFAULT gen_random_uuid(),
  stable_persona_key text NOT NULL,
  active_persona_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_at timestamptz,
  PRIMARY KEY (tenant_id, companion_id),
  UNIQUE (tenant_id, stable_persona_key)
);

CREATE TABLE cmem.relationships (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  relationship_id uuid NOT NULL DEFAULT gen_random_uuid(),
  companion_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended', 'deleting')),
  relationship_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, relationship_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES cmem.app_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, companion_id) REFERENCES cmem.companions(tenant_id, companion_id)
);

CREATE UNIQUE INDEX relationships_identity_uq
  ON cmem.relationships (tenant_id, relationship_id, user_id);

CREATE TABLE cmem.conversations (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  relationship_id uuid NOT NULL,
  conversation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  title_ciphertext bytea,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleting')),
  next_sequence_no bigint NOT NULL DEFAULT 1 CHECK (next_sequence_no > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, conversation_id),
  UNIQUE (tenant_id, user_id, relationship_id, conversation_id),
  FOREIGN KEY (tenant_id, user_id, relationship_id)
    REFERENCES cmem.relationships(tenant_id, user_id, relationship_id)
);

-- This receipt is deliberately independent from messages: rejected user, assistant, or tool content leaves no raw text.
CREATE TABLE cmem.privacy_screening_receipts (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  screening_id uuid NOT NULL DEFAULT gen_random_uuid(),
  relationship_id uuid NOT NULL,
  conversation_id uuid,
  content_stage text NOT NULL CHECK (content_stage IN ('user_ingress', 'assistant_egress', 'tool_result', 'proactive_outbound')),
  content_event_hmac bytea NOT NULL,
  policy_version text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allow_plaintext', 'allow_redacted', 'ephemeral_only', 'drop')),
  allowed_destinations text[] NOT NULL DEFAULT '{}',
  classifications text[] NOT NULL DEFAULT '{}',
  redaction_count integer NOT NULL DEFAULT 0 CHECK (redaction_count >= 0),
  screened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  PRIMARY KEY (tenant_id, user_id, screening_id),
  UNIQUE (tenant_id, user_id, relationship_id, conversation_id, screening_id),
  FOREIGN KEY (tenant_id, user_id, relationship_id)
    REFERENCES cmem.relationships(tenant_id, user_id, relationship_id),
  FOREIGN KEY (tenant_id, user_id, relationship_id, conversation_id)
    REFERENCES cmem.conversations(tenant_id, user_id, relationship_id, conversation_id),
  CHECK (allowed_destinations <@ ARRAY['primary_store','main_model','memory_model','embedding','redacted_log','proactive_delivery']::text[]),
  CHECK (octet_length(content_event_hmac) = 32),
  CHECK (decision <> 'drop' OR cardinality(allowed_destinations) = 0)
);

CREATE TABLE cmem.messages (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  relationship_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL DEFAULT gen_random_uuid(),
  screening_id uuid NOT NULL,
  client_message_id text,
  sequence_no bigint NOT NULL CHECK (sequence_no > 0),
  role cmem.message_role NOT NULL,
  storage_mode text NOT NULL CHECK (storage_mode IN ('plaintext_encrypted', 'redacted_only', 'hash_only')),
  content_ciphertext bytea,
  redacted_text text CHECK (char_length(redacted_text) <= 64000),
  content_hmac bytea NOT NULL,
  realm_hint cmem.memory_realm NOT NULL DEFAULT 'unknown',
  key_version integer NOT NULL CHECK (key_version > 0),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  logically_deleted_at timestamptz,
  PRIMARY KEY (tenant_id, user_id, message_id),
  UNIQUE (tenant_id, user_id, conversation_id, sequence_no),
  UNIQUE (tenant_id, user_id, screening_id),
  FOREIGN KEY (tenant_id, user_id, relationship_id, conversation_id)
    REFERENCES cmem.conversations(tenant_id, user_id, relationship_id, conversation_id),
  FOREIGN KEY (tenant_id, user_id, relationship_id, conversation_id, screening_id)
    REFERENCES cmem.privacy_screening_receipts(tenant_id, user_id, relationship_id, conversation_id, screening_id),
  CHECK ((storage_mode = 'plaintext_encrypted' AND content_ciphertext IS NOT NULL)
      OR (storage_mode <> 'plaintext_encrypted' AND content_ciphertext IS NULL)),
  CHECK (octet_length(content_hmac) = 32)
);

CREATE INDEX messages_recent_idx
  ON cmem.messages (tenant_id, user_id, conversation_id, sequence_no DESC)
  WHERE logically_deleted_at IS NULL;

CREATE UNIQUE INDEX messages_client_message_uq
  ON cmem.messages (tenant_id, user_id, conversation_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE OR REPLACE FUNCTION cmem.enforce_message_privacy_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
DECLARE
  privacy_decision text;
  screened_stage text;
BEGIN
  SELECT decision, content_stage INTO privacy_decision, screened_stage
  FROM cmem.privacy_screening_receipts
  WHERE tenant_id = NEW.tenant_id
    AND user_id = NEW.user_id
    AND relationship_id = NEW.relationship_id
    AND conversation_id = NEW.conversation_id
    AND screening_id = NEW.screening_id
    AND content_event_hmac = NEW.content_hmac
    AND (expires_at IS NULL OR expires_at > clock_timestamp());

  IF NOT FOUND OR privacy_decision IN ('ephemeral_only', 'drop') THEN
    RAISE EXCEPTION 'message has no persistence-authorizing privacy receipt'
      USING ERRCODE = '23514';
  END IF;
  IF (NEW.role = 'user' AND screened_stage <> 'user_ingress')
     OR (NEW.role = 'assistant' AND screened_stage <> 'assistant_egress')
     OR (NEW.role = 'tool' AND screened_stage <> 'tool_result') THEN
    RAISE EXCEPTION 'privacy receipt stage does not match message role'
      USING ERRCODE = '23514';
  END IF;
  IF privacy_decision = 'allow_redacted' AND NEW.storage_mode = 'plaintext_encrypted' THEN
    RAISE EXCEPTION 'redacted-only receipt cannot authorize plaintext storage'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM cmem.privacy_screening_receipts psr
    WHERE psr.tenant_id = NEW.tenant_id
      AND psr.user_id = NEW.user_id
      AND psr.screening_id = NEW.screening_id
      AND 'primary_store' = ANY(psr.allowed_destinations)
  ) THEN
    RAISE EXCEPTION 'privacy receipt does not authorize primary storage'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER messages_privacy_before_insert
BEFORE INSERT ON cmem.messages
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_message_privacy_receipt();

-- Prepare/commit/fail is a durable state machine. The opaque turn token is returned once;
-- only a keyed digest is stored. Context ranges, revisions and ownership are server-owned.
CREATE TABLE cmem.turns (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  turn_id uuid NOT NULL DEFAULT gen_random_uuid(),
  relationship_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  user_message_id uuid NOT NULL,
  assistant_message_id uuid,
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared', 'committed', 'failed', 'expired')),
  turn_token_hmac bytea NOT NULL,
  context_revision bigint NOT NULL CHECK (context_revision > 0),
  context_digest bytea NOT NULL,
  prompt_plan_id text NOT NULL CHECK (char_length(prompt_plan_id) BETWEEN 1 AND 128),
  failure_reason text CHECK (failure_reason IN (
    'provider_timeout', 'provider_rejected', 'invalid_output', 'user_cancelled',
    'internal_error', 'turn_expired'
  )),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, user_id, turn_id),
  UNIQUE (tenant_id, user_id, turn_token_hmac),
  UNIQUE (tenant_id, user_id, user_message_id),
  FOREIGN KEY (tenant_id, user_id, relationship_id, conversation_id)
    REFERENCES cmem.conversations(tenant_id, user_id, relationship_id, conversation_id),
  FOREIGN KEY (tenant_id, user_id, user_message_id)
    REFERENCES cmem.messages(tenant_id, user_id, message_id),
  FOREIGN KEY (tenant_id, user_id, assistant_message_id)
    REFERENCES cmem.messages(tenant_id, user_id, message_id),
  CHECK (octet_length(turn_token_hmac) = 32),
  CHECK (octet_length(context_digest) = 32),
  CHECK (expires_at > prepared_at),
  CHECK ((state = 'prepared' AND assistant_message_id IS NULL AND failure_reason IS NULL AND completed_at IS NULL)
      OR (state = 'committed' AND assistant_message_id IS NOT NULL AND failure_reason IS NULL AND completed_at IS NOT NULL)
      OR (state IN ('failed', 'expired') AND assistant_message_id IS NULL AND failure_reason IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION cmem.enforce_turn_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
DECLARE
  message_role cmem.message_role;
  message_relationship_id uuid;
  message_conversation_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'prepared' OR NEW.revision <> 1 THEN
      RAISE EXCEPTION 'turn must start prepared at revision 1'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.turn_id IS DISTINCT FROM OLD.turn_id
       OR NEW.relationship_id IS DISTINCT FROM OLD.relationship_id
       OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
       OR NEW.user_message_id IS DISTINCT FROM OLD.user_message_id
       OR NEW.turn_token_hmac IS DISTINCT FROM OLD.turn_token_hmac
       OR NEW.context_revision IS DISTINCT FROM OLD.context_revision
       OR NEW.context_digest IS DISTINCT FROM OLD.context_digest
       OR NEW.prompt_plan_id IS DISTINCT FROM OLD.prompt_plan_id
       OR NEW.prepared_at IS DISTINCT FROM OLD.prepared_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION 'turn identity, scope and prepared context are immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.state <> 'prepared' OR NEW.state NOT IN ('committed', 'failed', 'expired') THEN
      RAISE EXCEPTION 'terminal turn state cannot be changed'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'turn transition must advance revision by exactly one'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'committed' AND OLD.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'expired prepared turn cannot be committed'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT role, relationship_id, conversation_id
    INTO message_role, message_relationship_id, message_conversation_id
  FROM cmem.messages
  WHERE tenant_id = NEW.tenant_id
    AND user_id = NEW.user_id
    AND message_id = NEW.user_message_id
    AND logically_deleted_at IS NULL;
  IF message_role IS DISTINCT FROM 'user'
     OR message_relationship_id IS DISTINCT FROM NEW.relationship_id
     OR message_conversation_id IS DISTINCT FROM NEW.conversation_id THEN
    RAISE EXCEPTION 'turn user message does not match its scope or role'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state = 'committed' THEN
    SELECT role, relationship_id, conversation_id
      INTO message_role, message_relationship_id, message_conversation_id
    FROM cmem.messages
    WHERE tenant_id = NEW.tenant_id
      AND user_id = NEW.user_id
      AND message_id = NEW.assistant_message_id
      AND logically_deleted_at IS NULL;
    IF message_role IS DISTINCT FROM 'assistant'
       OR message_relationship_id IS DISTINCT FROM NEW.relationship_id
       OR message_conversation_id IS DISTINCT FROM NEW.conversation_id THEN
      RAISE EXCEPTION 'committed assistant message does not match turn scope or role'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER turns_state_before_write
BEFORE INSERT OR UPDATE ON cmem.turns
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_turn_state();

CREATE TABLE cmem.conversation_states (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  last_committed_sequence bigint NOT NULL DEFAULT 0 CHECK (last_committed_sequence >= 0),
  last_summarized_sequence bigint NOT NULL DEFAULT 0 CHECK (last_summarized_sequence >= 0),
  last_extracted_sequence bigint NOT NULL DEFAULT 0 CHECK (last_extracted_sequence >= 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, conversation_id),
  FOREIGN KEY (tenant_id, user_id, conversation_id)
    REFERENCES cmem.conversations(tenant_id, user_id, conversation_id),
  CHECK (last_summarized_sequence <= last_committed_sequence),
  CHECK (last_extracted_sequence <= last_committed_sequence)
);

-- Summaries are immutable segments. Code owns sequence ranges/cursors; the model only supplies summary content.
CREATE TABLE cmem.segment_summaries (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  relationship_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  summary_id uuid NOT NULL DEFAULT gen_random_uuid(),
  start_sequence bigint NOT NULL CHECK (start_sequence > 0),
  end_sequence bigint NOT NULL CHECK (end_sequence >= start_sequence),
  coverage_hmac bytea NOT NULL,
  summary_ciphertext bytea NOT NULL,
  search_text text CHECK (char_length(search_text) <= 12000),
  sensitivity_ceiling cmem.sensitivity_level NOT NULL DEFAULT 'personal',
  realm_distribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  open_threads_ciphertext bytea NOT NULL,
  prompt_version text NOT NULL,
  privacy_policy_version text NOT NULL,
  source_digest bytea NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'logically_deleted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  logically_deleted_at timestamptz,
  PRIMARY KEY (tenant_id, user_id, summary_id),
  UNIQUE (tenant_id, user_id, conversation_id, start_sequence, end_sequence, source_digest),
  FOREIGN KEY (tenant_id, user_id, relationship_id, conversation_id)
    REFERENCES cmem.conversations(tenant_id, user_id, relationship_id, conversation_id),
  CHECK (jsonb_typeof(realm_distribution) = 'object'),
  CHECK ((realm_distribution - ARRAY[
    'real_world','relationship_canon','roleplay','fictional','hypothetical','quoted','unknown'
  ]) = '{}'::jsonb),
  CHECK (sensitivity_ceiling <> 'prohibited'),
  CHECK (sensitivity_ceiling NOT IN ('highly_sensitive', 'prohibited') OR search_text IS NULL),
  CHECK ((status = 'logically_deleted') = (logically_deleted_at IS NOT NULL))
);

CREATE INDEX segment_summaries_search_trgm_idx
  ON cmem.segment_summaries USING gin (search_text gin_trgm_ops)
  WHERE status = 'active' AND logically_deleted_at IS NULL;

CREATE TABLE cmem.memory_claims (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  relationship_id uuid NOT NULL,
  memory_id uuid NOT NULL DEFAULT gen_random_uuid(),
  memory_type cmem.memory_type NOT NULL,
  state cmem.memory_state NOT NULL,
  current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  first_recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  logically_deleted_at timestamptz,
  deletion_epoch bigint NOT NULL DEFAULT 0 CHECK (deletion_epoch >= 0),
  PRIMARY KEY (tenant_id, user_id, memory_id),
  FOREIGN KEY (tenant_id, user_id, relationship_id)
    REFERENCES cmem.relationships(tenant_id, user_id, relationship_id),
  CHECK ((state = 'logically_deleted') = (logically_deleted_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION cmem.enforce_current_user_deletion_epoch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
DECLARE
  current_epoch bigint;
  current_status text;
BEGIN
  SELECT deletion_epoch, status INTO current_epoch, current_status
  FROM cmem.app_users
  WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id;

  IF NOT FOUND OR current_status <> 'active' OR NEW.deletion_epoch <> current_epoch THEN
    RAISE EXCEPTION 'claim uses stale deletion epoch or inactive user'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER memory_claims_epoch_before_insert
BEFORE INSERT ON cmem.memory_claims
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_current_user_deletion_epoch();

CREATE OR REPLACE FUNCTION cmem.enforce_memory_claim_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.current_revision <> 1
       OR NEW.state = 'logically_deleted'
       OR NEW.logically_deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'new memory claim must start at revision 1 and cannot start deleted'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.relationship_id IS DISTINCT FROM OLD.relationship_id
     OR NEW.memory_id IS DISTINCT FROM OLD.memory_id
     OR NEW.memory_type IS DISTINCT FROM OLD.memory_type
     OR NEW.first_recorded_at IS DISTINCT FROM OLD.first_recorded_at
     OR NEW.deletion_epoch IS DISTINCT FROM OLD.deletion_epoch THEN
    RAISE EXCEPTION 'memory claim identity, provenance, type and deletion epoch are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.current_revision IS DISTINCT FROM OLD.current_revision THEN
    IF NEW.current_revision <> OLD.current_revision + 1
       OR NOT EXISTS (
         SELECT 1
         FROM cmem.claim_revisions old_r
         WHERE old_r.tenant_id = OLD.tenant_id
           AND old_r.user_id = OLD.user_id
           AND old_r.memory_id = OLD.memory_id
           AND old_r.revision = OLD.current_revision
           AND old_r.system_to IS NOT NULL
       )
       OR NOT EXISTS (
         SELECT 1
         FROM cmem.claim_revisions new_r
         WHERE new_r.tenant_id = NEW.tenant_id
           AND new_r.user_id = NEW.user_id
           AND new_r.memory_id = NEW.memory_id
           AND new_r.revision = NEW.current_revision
           AND new_r.system_to IS NULL
       ) THEN
      RAISE EXCEPTION 'claim revision advance requires the closed previous revision and exactly one new current revision'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'pending_confirmation' AND NEW.state IN ('active', 'contested', 'expired', 'rejected', 'logically_deleted'))
    OR (OLD.state = 'active' AND NEW.state IN ('contested', 'expired', 'logically_deleted'))
    OR (OLD.state = 'contested' AND NEW.state IN ('active', 'expired', 'logically_deleted'))
    OR (OLD.state = 'expired' AND NEW.state IN ('active', 'logically_deleted'))
    OR (OLD.state = 'rejected' AND NEW.state = 'logically_deleted')
  ) THEN
    RAISE EXCEPTION 'invalid memory claim state transition'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'memory claim updated_at cannot move backwards'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER memory_claims_state_revision_before_write
BEFORE INSERT OR UPDATE ON cmem.memory_claims
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_memory_claim_update();

-- memory_claims.relationship_id is the provenance/home relationship, not an implicit
-- cross-companion permission. Recall requires a current explicit relationship grant.
CREATE TABLE cmem.memory_relationship_grants (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  relationship_id uuid NOT NULL,
  grant_revision integer NOT NULL CHECK (grant_revision > 0),
  grant_source text NOT NULL CHECK (grant_source IN ('origin_relationship', 'explicit_user_share', 'import_destination')),
  consent_event_id uuid,
  import_job_id uuid,
  import_source_relationship_ref_hmac bytea,
  scope_binding_hmac bytea NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, user_id, memory_id, relationship_id, grant_revision),
  FOREIGN KEY (tenant_id, user_id, memory_id)
    REFERENCES cmem.memory_claims(tenant_id, user_id, memory_id),
  FOREIGN KEY (tenant_id, user_id, relationship_id)
    REFERENCES cmem.relationships(tenant_id, user_id, relationship_id),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
  CHECK ((grant_source = 'explicit_user_share') = (consent_event_id IS NOT NULL)),
  CHECK ((grant_source = 'import_destination') =
    (import_job_id IS NOT NULL AND import_source_relationship_ref_hmac IS NOT NULL)),
  CHECK (grant_source = 'import_destination'
    OR (import_job_id IS NULL AND import_source_relationship_ref_hmac IS NULL)),
  CHECK (import_source_relationship_ref_hmac IS NULL
    OR octet_length(import_source_relationship_ref_hmac) = 32),
  CHECK (octet_length(scope_binding_hmac) = 32)
);

CREATE UNIQUE INDEX memory_relationship_grants_one_current_uq
  ON cmem.memory_relationship_grants (tenant_id, user_id, memory_id, relationship_id)
  WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX memory_relationship_grants_consent_once_uq
  ON cmem.memory_relationship_grants (tenant_id, user_id, consent_event_id)
  WHERE consent_event_id IS NOT NULL;

CREATE TABLE cmem.claim_revisions (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  realm cmem.memory_realm NOT NULL,
  attribution cmem.attribution_kind NOT NULL,
  epistemic_basis cmem.epistemic_basis_kind NOT NULL,
  asserted_by_ref_ciphertext bytea,
  quoted_speaker_ref_ciphertext bytea,
  subject_key text NOT NULL CHECK (char_length(subject_key) BETWEEN 1 AND 256),
  predicate text NOT NULL CHECK (predicate ~ '^[a-z][a-z0-9._-]{0,127}$'),
  value_ciphertext bytea NOT NULL,
  display_text_ciphertext bytea NOT NULL,
  search_text text CHECK (char_length(search_text) <= 4000),
  fingerprint_hmac bytea NOT NULL,
  fingerprint_version text NOT NULL DEFAULT 'nfkc-casefold-ws-v1'
    CHECK (char_length(fingerprint_version) BETWEEN 1 AND 64),
  fingerprint_key_version integer NOT NULL CHECK (fingerprint_key_version > 0),
  confidence_band text NOT NULL CHECK (confidence_band IN ('explicit', 'high', 'medium', 'low', 'disputed')),
  sensitivity cmem.sensitivity_level NOT NULL,
  privacy_category text NOT NULL DEFAULT 'ordinary_other'
    CHECK (privacy_category IN ('ordinary_other', 'credentials', 'payment', 'health', 'precise_location', 'intimate_content', 'family', 'relationships', 'work')),
  valid_time_kind text NOT NULL CHECK (valid_time_kind IN ('timeless', 'point', 'interval', 'recurring', 'unknown')),
  valid_from timestamptz,
  valid_to timestamptz,
  valid_timezone text,
  valid_recurrence_rrule text,
  system_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  system_to timestamptz,
  prompt_version text NOT NULL,
  model_id text,
  created_by text NOT NULL CHECK (created_by IN ('explicit_user', 'memory_extractor', 'admin_correction', 'import')),
  PRIMARY KEY (tenant_id, user_id, memory_id, revision),
  FOREIGN KEY (tenant_id, user_id, memory_id)
    REFERENCES cmem.memory_claims(tenant_id, user_id, memory_id),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  CHECK (valid_timezone IS NULL OR char_length(valid_timezone) BETWEEN 1 AND 128),
  CHECK (valid_recurrence_rrule IS NULL OR (
    char_length(valid_recurrence_rrule) BETWEEN 1 AND 512
    AND position(chr(10) IN valid_recurrence_rrule) = 0
    AND position(chr(13) IN valid_recurrence_rrule) = 0
  )),
  CHECK (
    (valid_time_kind = 'timeless'
      AND valid_from IS NULL AND valid_to IS NULL
      AND valid_timezone IS NULL AND valid_recurrence_rrule IS NULL)
    OR (valid_time_kind = 'point'
      AND valid_from IS NOT NULL AND valid_to IS NULL
      AND valid_recurrence_rrule IS NULL)
    OR (valid_time_kind = 'interval'
      AND valid_from IS NOT NULL AND valid_to IS NOT NULL
      AND valid_recurrence_rrule IS NULL)
    OR (valid_time_kind = 'recurring'
      AND valid_timezone IS NOT NULL AND valid_recurrence_rrule IS NOT NULL)
    OR (valid_time_kind = 'unknown'
      AND valid_from IS NULL AND valid_to IS NULL
      AND valid_timezone IS NULL AND valid_recurrence_rrule IS NULL)
  ),
  CHECK (system_to IS NULL OR system_to >= system_from),
  CHECK (octet_length(fingerprint_hmac) = 32),
  CHECK (sensitivity NOT IN ('highly_sensitive', 'prohibited') OR search_text IS NULL),
  CHECK (sensitivity <> 'prohibited'),
  CHECK (privacy_category <> 'credentials'),
  CHECK (privacy_category NOT IN ('payment', 'health', 'precise_location', 'intimate_content')
      OR sensitivity IN ('sensitive', 'highly_sensitive')),
  CHECK (privacy_category NOT IN ('family', 'relationships', 'work')
      OR sensitivity IN ('personal', 'sensitive', 'highly_sensitive'))
);

CREATE UNIQUE INDEX claim_revisions_one_current_uq
  ON cmem.claim_revisions (tenant_id, user_id, memory_id)
  WHERE system_to IS NULL;

CREATE OR REPLACE FUNCTION cmem.enforce_claim_revision_limited_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.memory_id IS DISTINCT FROM OLD.memory_id
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.realm IS DISTINCT FROM OLD.realm
     OR NEW.attribution IS DISTINCT FROM OLD.attribution
     OR NEW.epistemic_basis IS DISTINCT FROM OLD.epistemic_basis
     OR NEW.asserted_by_ref_ciphertext IS DISTINCT FROM OLD.asserted_by_ref_ciphertext
     OR NEW.quoted_speaker_ref_ciphertext IS DISTINCT FROM OLD.quoted_speaker_ref_ciphertext
     OR NEW.subject_key IS DISTINCT FROM OLD.subject_key
     OR NEW.predicate IS DISTINCT FROM OLD.predicate
     OR NEW.value_ciphertext IS DISTINCT FROM OLD.value_ciphertext
     OR NEW.display_text_ciphertext IS DISTINCT FROM OLD.display_text_ciphertext
     OR NEW.fingerprint_hmac IS DISTINCT FROM OLD.fingerprint_hmac
     OR NEW.fingerprint_version IS DISTINCT FROM OLD.fingerprint_version
     OR NEW.fingerprint_key_version IS DISTINCT FROM OLD.fingerprint_key_version
     OR NEW.confidence_band IS DISTINCT FROM OLD.confidence_band
     OR NEW.sensitivity IS DISTINCT FROM OLD.sensitivity
     OR NEW.privacy_category IS DISTINCT FROM OLD.privacy_category
     OR NEW.valid_time_kind IS DISTINCT FROM OLD.valid_time_kind
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.valid_to IS DISTINCT FROM OLD.valid_to
     OR NEW.valid_timezone IS DISTINCT FROM OLD.valid_timezone
     OR NEW.valid_recurrence_rrule IS DISTINCT FROM OLD.valid_recurrence_rrule
     OR NEW.system_from IS DISTINCT FROM OLD.system_from
     OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version
     OR NEW.model_id IS DISTINCT FROM OLD.model_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'claim revisions are immutable; corrections require a new revision'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.system_to IS NOT NULL AND NEW.system_to IS DISTINCT FROM OLD.system_to THEN
    RAISE EXCEPTION 'closed claim revision cannot be reopened or reclosed'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.system_to IS NULL AND NEW.system_to IS NOT NULL
     AND NEW.system_to < NEW.system_from THEN
    RAISE EXCEPTION 'claim revision close time precedes its start'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER claim_revisions_limited_update_before_write
BEFORE UPDATE ON cmem.claim_revisions
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_claim_revision_limited_update();

ALTER TABLE cmem.memory_claims
  ADD CONSTRAINT memory_claims_current_revision_fk
  FOREIGN KEY (tenant_id, user_id, memory_id, current_revision)
  REFERENCES cmem.claim_revisions(tenant_id, user_id, memory_id, revision)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX claim_revisions_lookup_idx
  ON cmem.claim_revisions (tenant_id, user_id, predicate, realm, valid_from DESC)
  WHERE system_to IS NULL;

CREATE INDEX claim_revisions_search_trgm_idx
  ON cmem.claim_revisions USING gin (search_text gin_trgm_ops)
  WHERE system_to IS NULL AND search_text IS NOT NULL;

CREATE TABLE cmem.claim_evidence (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  evidence_id uuid NOT NULL DEFAULT gen_random_uuid(),
  memory_id uuid NOT NULL,
  revision integer NOT NULL,
  evidence_ordinal smallint NOT NULL CHECK (evidence_ordinal BETWEEN 1 AND 32),
  source_kind text NOT NULL CHECK (source_kind IN ('message', 'segment_summary', 'explicit_form', 'import_manifest')),
  message_id uuid,
  summary_id uuid,
  source_external_hmac bytea,
  source_relationship_id uuid NOT NULL,
  source_conversation_id uuid,
  source_start_sequence bigint,
  source_end_sequence bigint,
  source_fingerprint_hmac bytea NOT NULL,
  fingerprint_version text NOT NULL DEFAULT 'source-id-v1'
    CHECK (char_length(fingerprint_version) BETWEEN 1 AND 64),
  fingerprint_key_version integer NOT NULL CHECK (fingerprint_key_version > 0),
  excerpt_ciphertext bytea,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, memory_id, revision, evidence_ordinal),
  UNIQUE (tenant_id, user_id, evidence_id),
  FOREIGN KEY (tenant_id, user_id, memory_id, revision)
    REFERENCES cmem.claim_revisions(tenant_id, user_id, memory_id, revision),
  FOREIGN KEY (tenant_id, user_id, message_id)
    REFERENCES cmem.messages(tenant_id, user_id, message_id)
    ON DELETE SET NULL (message_id),
  FOREIGN KEY (tenant_id, user_id, summary_id)
    REFERENCES cmem.segment_summaries(tenant_id, user_id, summary_id)
    ON DELETE SET NULL (summary_id),
  CHECK (octet_length(source_fingerprint_hmac) = 32),
  CHECK (source_external_hmac IS NULL OR octet_length(source_external_hmac) = 32),
  CHECK (source_start_sequence IS NULL OR source_start_sequence > 0),
  CHECK (source_end_sequence IS NULL OR source_end_sequence >= source_start_sequence),
  CHECK (
    (source_kind = 'message'
      AND summary_id IS NULL AND source_external_hmac IS NULL
      AND source_conversation_id IS NOT NULL
      AND source_start_sequence IS NOT NULL
      AND source_end_sequence = source_start_sequence)
    OR (source_kind = 'segment_summary'
      AND message_id IS NULL AND source_external_hmac IS NULL
      AND source_conversation_id IS NOT NULL
      AND source_start_sequence IS NOT NULL
      AND source_end_sequence IS NOT NULL)
    OR (source_kind IN ('explicit_form', 'import_manifest')
      AND message_id IS NULL AND summary_id IS NULL
      AND source_external_hmac IS NOT NULL
      AND source_conversation_id IS NULL
      AND source_start_sequence IS NULL AND source_end_sequence IS NULL)
  )
);

CREATE OR REPLACE FUNCTION cmem.enforce_claim_evidence_limited_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.evidence_id IS DISTINCT FROM OLD.evidence_id
     OR NEW.memory_id IS DISTINCT FROM OLD.memory_id
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.evidence_ordinal IS DISTINCT FROM OLD.evidence_ordinal
     OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
     OR NEW.source_external_hmac IS DISTINCT FROM OLD.source_external_hmac
     OR NEW.source_relationship_id IS DISTINCT FROM OLD.source_relationship_id
     OR NEW.source_conversation_id IS DISTINCT FROM OLD.source_conversation_id
     OR NEW.source_start_sequence IS DISTINCT FROM OLD.source_start_sequence
     OR NEW.source_end_sequence IS DISTINCT FROM OLD.source_end_sequence
     OR NEW.source_fingerprint_hmac IS DISTINCT FROM OLD.source_fingerprint_hmac
     OR NEW.fingerprint_version IS DISTINCT FROM OLD.fingerprint_version
     OR NEW.fingerprint_key_version IS DISTINCT FROM OLD.fingerprint_key_version
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
     OR (OLD.message_id IS NULL AND NEW.message_id IS NOT NULL)
     OR (OLD.message_id IS NOT NULL AND NEW.message_id IS NOT NULL
         AND NEW.message_id IS DISTINCT FROM OLD.message_id)
     OR (OLD.summary_id IS NULL AND NEW.summary_id IS NOT NULL)
     OR (OLD.summary_id IS NOT NULL AND NEW.summary_id IS NOT NULL
         AND NEW.summary_id IS DISTINCT FROM OLD.summary_id)
     OR (OLD.excerpt_ciphertext IS NULL AND NEW.excerpt_ciphertext IS NOT NULL)
     OR (OLD.excerpt_ciphertext IS NOT NULL AND NEW.excerpt_ciphertext IS NOT NULL
         AND NEW.excerpt_ciphertext IS DISTINCT FROM OLD.excerpt_ciphertext) THEN
    RAISE EXCEPTION 'claim evidence is append-only; only source detachment or excerpt erasure is allowed'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER claim_evidence_limited_update_before_write
BEFORE UPDATE ON cmem.claim_evidence
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_claim_evidence_limited_update();

CREATE TABLE cmem.correction_events (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  correction_id uuid NOT NULL DEFAULT gen_random_uuid(),
  memory_id uuid NOT NULL,
  previous_revision integer NOT NULL,
  replacement_revision integer NOT NULL,
  reason_ciphertext bytea NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'authorized_admin', 'import')),
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, correction_id),
  FOREIGN KEY (tenant_id, user_id, memory_id, previous_revision)
    REFERENCES cmem.claim_revisions(tenant_id, user_id, memory_id, revision),
  FOREIGN KEY (tenant_id, user_id, memory_id, replacement_revision)
    REFERENCES cmem.claim_revisions(tenant_id, user_id, memory_id, revision),
  CHECK (replacement_revision > previous_revision)
);

CREATE TABLE cmem.consent_challenges (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  challenge_id uuid NOT NULL DEFAULT gen_random_uuid(),
  relationship_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN (
    'chat_processing', 'raw_conversation_archive',
    'memory_ordinary', 'memory_sensitive', 'cross_relationship_memory_share',
    'semantic_index', 'external_embedding', 'external_memory_provider', 'deep_recall',
    'adaptive_profile', 'analytics', 'lock_screen_content',
    'proactive_transactional', 'proactive_onboarding', 'proactive_relationship', 'proactive_marketing'
  )),
  policy_version text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 128),
  locale text NOT NULL CHECK (char_length(locale) BETWEEN 2 AND 35),
  disclosure_digest bytea NOT NULL,
  scope_binding_hmac bytea NOT NULL,
  -- The bearer token is returned once; only its keyed digest is persisted.
  token_hmac bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (tenant_id, user_id, challenge_id),
  UNIQUE (tenant_id, user_id, token_hmac),
  FOREIGN KEY (tenant_id, user_id, relationship_id)
    REFERENCES cmem.relationships(tenant_id, user_id, relationship_id),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '30 minutes'),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (octet_length(disclosure_digest) = 32),
  CHECK (octet_length(scope_binding_hmac) = 32),
  CHECK (octet_length(token_hmac) = 32)
);

CREATE TABLE cmem.consent_events (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  consent_event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  challenge_id uuid,
  scope_binding_hmac bytea NOT NULL,
  relationship_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN (
    'chat_processing', 'raw_conversation_archive',
    'memory_ordinary', 'memory_sensitive', 'cross_relationship_memory_share',
    'semantic_index', 'external_embedding', 'external_memory_provider', 'deep_recall',
    'adaptive_profile', 'analytics', 'lock_screen_content',
    'proactive_transactional', 'proactive_onboarding', 'proactive_relationship', 'proactive_marketing'
  )),
  decision text NOT NULL CHECK (decision IN ('grant', 'withdraw')),
  revision integer NOT NULL CHECK (revision > 0),
  policy_version text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'guardian', 'migration_default_off')),
  evidence_hmac bytea NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, consent_event_id),
  UNIQUE (tenant_id, user_id, relationship_id, purpose, revision),
  FOREIGN KEY (tenant_id, user_id, relationship_id)
    REFERENCES cmem.relationships(tenant_id, user_id, relationship_id),
  FOREIGN KEY (tenant_id, user_id, challenge_id)
    REFERENCES cmem.consent_challenges(tenant_id, user_id, challenge_id),
  CHECK ((decision = 'grant' AND challenge_id IS NOT NULL)
      OR (decision = 'withdraw' AND challenge_id IS NULL)),
  CHECK (octet_length(scope_binding_hmac) = 32),
  CHECK (octet_length(evidence_hmac) = 32)
);

CREATE OR REPLACE FUNCTION cmem.enforce_consent_challenge_one_time()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  IF OLD.consumed_at IS NULL
     AND NEW.consumed_at IS NOT NULL
     AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.challenge_id IS NOT DISTINCT FROM OLD.challenge_id
     AND NEW.relationship_id IS NOT DISTINCT FROM OLD.relationship_id
     AND NEW.purpose IS NOT DISTINCT FROM OLD.purpose
     AND NEW.policy_version IS NOT DISTINCT FROM OLD.policy_version
     AND NEW.locale IS NOT DISTINCT FROM OLD.locale
     AND NEW.disclosure_digest IS NOT DISTINCT FROM OLD.disclosure_digest
     AND NEW.scope_binding_hmac IS NOT DISTINCT FROM OLD.scope_binding_hmac
     AND NEW.token_hmac IS NOT DISTINCT FROM OLD.token_hmac
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
     AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'consent challenges are immutable except one-time consumption'
    USING ERRCODE = '55000';
END
$fn$;

CREATE TRIGGER consent_challenges_one_time_before_update
BEFORE UPDATE ON cmem.consent_challenges
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_consent_challenge_one_time();

CREATE OR REPLACE FUNCTION cmem.enforce_consent_event_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
DECLARE
  latest_revision integer;
BEGIN
  -- Serialize all purposes on the small relationship row; consent writes are rare and correctness wins.
  PERFORM 1
  FROM cmem.relationships
  WHERE tenant_id = NEW.tenant_id
    AND user_id = NEW.user_id
    AND relationship_id = NEW.relationship_id
  FOR UPDATE;

  SELECT COALESCE(MAX(revision), 0) INTO latest_revision
  FROM cmem.consent_events
  WHERE tenant_id = NEW.tenant_id
    AND user_id = NEW.user_id
    AND relationship_id = NEW.relationship_id
    AND purpose = NEW.purpose;

  IF NEW.revision <> latest_revision + 1 THEN
    RAISE EXCEPTION 'consent event revision must be exactly the next revision'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.actor_kind = 'migration_default_off' AND NEW.decision <> 'withdraw' THEN
    RAISE EXCEPTION 'migration can only initialize consent as withdrawn'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.decision = 'grant' THEN
    UPDATE cmem.consent_challenges
       SET consumed_at = clock_timestamp()
     WHERE tenant_id = NEW.tenant_id
       AND user_id = NEW.user_id
       AND challenge_id = NEW.challenge_id
       AND relationship_id = NEW.relationship_id
       AND purpose = NEW.purpose
       AND policy_version = NEW.policy_version
       AND scope_binding_hmac = NEW.scope_binding_hmac
       AND token_hmac = NEW.evidence_hmac
       AND consumed_at IS NULL
       AND expires_at > clock_timestamp();
    IF NOT FOUND THEN
      RAISE EXCEPTION 'grant lacks an unexpired, unused, matching disclosure challenge'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER consent_events_revision_before_insert
BEFORE INSERT ON cmem.consent_events
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_consent_event_revision();

CREATE OR REPLACE FUNCTION cmem.reject_immutable_row_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$fn$;

CREATE TRIGGER privacy_screening_receipts_immutable_before_update
BEFORE UPDATE ON cmem.privacy_screening_receipts
FOR EACH ROW EXECUTE FUNCTION cmem.reject_immutable_row_update();

CREATE OR REPLACE FUNCTION cmem.enforce_message_logical_delete_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  IF OLD.logically_deleted_at IS NULL
     AND NEW.logically_deleted_at IS NOT NULL
     AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.relationship_id IS NOT DISTINCT FROM OLD.relationship_id
     AND NEW.conversation_id IS NOT DISTINCT FROM OLD.conversation_id
     AND NEW.message_id IS NOT DISTINCT FROM OLD.message_id
     AND NEW.screening_id IS NOT DISTINCT FROM OLD.screening_id
     AND NEW.client_message_id IS NOT DISTINCT FROM OLD.client_message_id
     AND NEW.sequence_no IS NOT DISTINCT FROM OLD.sequence_no
     AND NEW.role IS NOT DISTINCT FROM OLD.role
     AND NEW.storage_mode IS NOT DISTINCT FROM OLD.storage_mode
     AND NEW.content_ciphertext IS NOT DISTINCT FROM OLD.content_ciphertext
     AND NEW.redacted_text IS NOT DISTINCT FROM OLD.redacted_text
     AND NEW.content_hmac IS NOT DISTINCT FROM OLD.content_hmac
     AND NEW.realm_hint IS NOT DISTINCT FROM OLD.realm_hint
     AND NEW.key_version IS NOT DISTINCT FROM OLD.key_version
     AND NEW.occurred_at IS NOT DISTINCT FROM OLD.occurred_at
     AND NEW.recorded_at IS NOT DISTINCT FROM OLD.recorded_at
     AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'messages are append-only except one-way logical deletion'
    USING ERRCODE = '55000';
END
$fn$;

CREATE TRIGGER messages_logical_delete_before_update
BEFORE UPDATE ON cmem.messages
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_message_logical_delete_only();

CREATE OR REPLACE FUNCTION cmem.enforce_segment_summary_limited_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.relationship_id IS DISTINCT FROM OLD.relationship_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.summary_id IS DISTINCT FROM OLD.summary_id
     OR NEW.start_sequence IS DISTINCT FROM OLD.start_sequence
     OR NEW.end_sequence IS DISTINCT FROM OLD.end_sequence
     OR NEW.coverage_hmac IS DISTINCT FROM OLD.coverage_hmac
     OR NEW.summary_ciphertext IS DISTINCT FROM OLD.summary_ciphertext
     OR NEW.sensitivity_ceiling IS DISTINCT FROM OLD.sensitivity_ceiling
     OR NEW.realm_distribution IS DISTINCT FROM OLD.realm_distribution
     OR NEW.open_threads_ciphertext IS DISTINCT FROM OLD.open_threads_ciphertext
     OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version
     OR NEW.privacy_policy_version IS DISTINCT FROM OLD.privacy_policy_version
     OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'summary segment content and coverage are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'active' AND NEW.status IN ('superseded', 'logically_deleted'))
    OR (OLD.status = 'superseded' AND NEW.status = 'logically_deleted')
  ) THEN
    RAISE EXCEPTION 'invalid summary state transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER segment_summaries_limited_update_before_write
BEFORE UPDATE ON cmem.segment_summaries
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_segment_summary_limited_update();

CREATE TRIGGER correction_events_immutable_before_update
BEFORE UPDATE ON cmem.correction_events
FOR EACH ROW EXECUTE FUNCTION cmem.reject_immutable_row_update();

CREATE TRIGGER consent_events_immutable_before_update
BEFORE UPDATE ON cmem.consent_events
FOR EACH ROW EXECUTE FUNCTION cmem.reject_immutable_row_update();

CREATE TABLE cmem.consent_projection (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  relationship_id uuid NOT NULL,
  purpose text NOT NULL,
  granted boolean NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  granted_at timestamptz,
  withdrawn_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, relationship_id, purpose),
  FOREIGN KEY (tenant_id, user_id, relationship_id, purpose, revision)
    REFERENCES cmem.consent_events(tenant_id, user_id, relationship_id, purpose, revision),
  CHECK ((granted AND granted_at IS NOT NULL AND withdrawn_at IS NULL) OR (NOT granted AND withdrawn_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION cmem.enforce_consent_projection_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
DECLARE
  source_decision text;
  source_occurred_at timestamptz;
BEGIN
  SELECT decision, occurred_at INTO source_decision, source_occurred_at
  FROM cmem.consent_events
  WHERE tenant_id = NEW.tenant_id
    AND user_id = NEW.user_id
    AND relationship_id = NEW.relationship_id
    AND purpose = NEW.purpose
    AND revision = NEW.revision;

  IF TG_OP = 'UPDATE' AND NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'consent projection revision must advance'
      USING ERRCODE = '23514';
  END IF;

  IF NOT FOUND
     OR (NEW.granted AND source_decision <> 'grant')
     OR (NOT NEW.granted AND source_decision <> 'withdraw')
     OR (NEW.granted AND NEW.granted_at IS DISTINCT FROM source_occurred_at)
     OR (NOT NEW.granted AND NEW.withdrawn_at IS DISTINCT FROM source_occurred_at)
     OR EXISTS (
       SELECT 1
       FROM cmem.consent_events newer
       WHERE newer.tenant_id = NEW.tenant_id
         AND newer.user_id = NEW.user_id
         AND newer.relationship_id = NEW.relationship_id
         AND newer.purpose = NEW.purpose
         AND newer.revision > NEW.revision
     ) THEN
    RAISE EXCEPTION 'consent projection does not match its source event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER consent_projection_source_before_write
BEFORE INSERT OR UPDATE ON cmem.consent_projection
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_consent_projection_source();

ALTER TABLE cmem.memory_relationship_grants
  ADD CONSTRAINT memory_relationship_grants_consent_fk
  FOREIGN KEY (tenant_id, user_id, consent_event_id)
  REFERENCES cmem.consent_events(tenant_id, user_id, consent_event_id);

CREATE OR REPLACE FUNCTION cmem.enforce_grant_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  IF OLD.revoked_at IS NULL
     AND NEW.revoked_at IS NOT NULL
     AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.memory_id IS NOT DISTINCT FROM OLD.memory_id
     AND NEW.relationship_id IS NOT DISTINCT FROM OLD.relationship_id
     AND NEW.grant_revision IS NOT DISTINCT FROM OLD.grant_revision
     AND NEW.grant_source IS NOT DISTINCT FROM OLD.grant_source
     AND NEW.consent_event_id IS NOT DISTINCT FROM OLD.consent_event_id
     AND NEW.import_job_id IS NOT DISTINCT FROM OLD.import_job_id
     AND NEW.import_source_relationship_ref_hmac IS NOT DISTINCT FROM OLD.import_source_relationship_ref_hmac
     AND NEW.scope_binding_hmac IS NOT DISTINCT FROM OLD.scope_binding_hmac
     AND NEW.granted_at IS NOT DISTINCT FROM OLD.granted_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'relationship grants are append-only except one-way revocation'
    USING ERRCODE = '55000';
END
$fn$;

CREATE TRIGGER memory_relationship_grants_append_only_before_update
BEFORE UPDATE ON cmem.memory_relationship_grants
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_grant_append_only();

CREATE OR REPLACE FUNCTION cmem.enforce_cross_relationship_grant_consent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  IF NEW.grant_source = 'origin_relationship' THEN
    PERFORM 1
    FROM cmem.memory_claims c
    WHERE c.tenant_id = NEW.tenant_id
      AND c.user_id = NEW.user_id
      AND c.memory_id = NEW.memory_id
      AND c.relationship_id = NEW.relationship_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'origin grant must target the claim origin relationship'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.grant_source = 'import_destination' THEN
    PERFORM 1
    FROM cmem.import_relationship_mappings irm
    WHERE irm.tenant_id = NEW.tenant_id
      AND irm.user_id = NEW.user_id
      AND irm.import_job_id = NEW.import_job_id
      AND irm.source_relationship_ref_hmac = NEW.import_source_relationship_ref_hmac
      AND irm.destination_relationship_id = NEW.relationship_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'import grant lacks a confirmed destination mapping'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM cmem.consent_events ce
  WHERE ce.tenant_id = NEW.tenant_id
    AND ce.user_id = NEW.user_id
    AND ce.consent_event_id = NEW.consent_event_id
    AND ce.relationship_id = NEW.relationship_id
    AND ce.purpose = 'cross_relationship_memory_share'
    AND ce.decision = 'grant'
    AND ce.scope_binding_hmac = NEW.scope_binding_hmac;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cross-relationship grant lacks matching explicit consent event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER memory_relationship_grants_consent_before_write
BEFORE INSERT OR UPDATE OF relationship_id, grant_source, consent_event_id,
                           import_job_id, import_source_relationship_ref_hmac, scope_binding_hmac
ON cmem.memory_relationship_grants
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_cross_relationship_grant_consent();

-- Suppression survives logical/physical deletion and import. It stores keyed fingerprints, never deleted text.
CREATE TABLE cmem.suppression_rules (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  suppression_id uuid NOT NULL DEFAULT gen_random_uuid(),
  scope_level text NOT NULL CHECK (scope_level IN ('relationship', 'all_user_data')),
  relationship_id uuid,
  scope_kind text NOT NULL CHECK (scope_kind IN ('claim_fingerprint', 'predicate', 'evidence', 'conversation_range', 'user_epoch')),
  fingerprint_hmac bytea NOT NULL,
  fingerprint_version text NOT NULL DEFAULT 'nfkc-casefold-ws-v1'
    CHECK (char_length(fingerprint_version) BETWEEN 1 AND 64),
  fingerprint_key_version integer NOT NULL CHECK (fingerprint_key_version > 0),
  predicate text,
  category_code text CHECK (category_code IN ('credentials', 'payment', 'health', 'precise_location', 'intimate_content', 'family', 'relationships', 'work')),
  display_label_ciphertext bytea,
  realm cmem.memory_realm,
  source_conversation_id uuid,
  source_start_sequence bigint,
  source_end_sequence bigint,
  deletion_epoch bigint NOT NULL CHECK (deletion_epoch >= 0),
  starts_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  released_at timestamptz,
  reason_code text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (tenant_id, user_id, suppression_id),
  FOREIGN KEY (tenant_id, user_id, relationship_id)
    REFERENCES cmem.relationships(tenant_id, user_id, relationship_id),
  CHECK ((scope_level = 'relationship' AND relationship_id IS NOT NULL)
      OR (scope_level = 'all_user_data' AND relationship_id IS NULL)),
  CHECK (category_code IS NULL OR scope_kind = 'predicate'),
  CHECK (
    (scope_kind = 'conversation_range'
      AND source_conversation_id IS NOT NULL
      AND source_start_sequence IS NOT NULL
      AND source_start_sequence > 0
      AND source_end_sequence IS NOT NULL
      AND source_end_sequence >= source_start_sequence)
    OR (scope_kind <> 'conversation_range'
      AND source_conversation_id IS NULL
      AND source_start_sequence IS NULL
      AND source_end_sequence IS NULL)
  ),
  CHECK (scope_kind = 'predicate' OR (predicate IS NULL AND category_code IS NULL)),
  CHECK (scope_kind <> 'predicate' OR predicate IS NOT NULL OR category_code IS NOT NULL),
  CHECK (predicate IS NULL OR predicate ~ '^[a-z][a-z0-9._-]{0,127}$'),
  CHECK (reason_code ~ '^[a-z][a-z0-9._-]{0,127}$'),
  CHECK (octet_length(fingerprint_hmac) = 32),
  CHECK (expires_at IS NULL OR expires_at >= starts_at),
  CHECK (released_at IS NULL OR released_at >= starts_at)
);

CREATE UNIQUE INDEX suppression_one_current_relationship_uq
  ON cmem.suppression_rules
    (tenant_id, user_id, relationship_id, scope_kind, fingerprint_version, fingerprint_key_version, fingerprint_hmac, deletion_epoch)
  WHERE released_at IS NULL AND relationship_id IS NOT NULL;

CREATE UNIQUE INDEX suppression_one_current_user_uq
  ON cmem.suppression_rules
    (tenant_id, user_id, scope_kind, fingerprint_version, fingerprint_key_version, fingerprint_hmac, deletion_epoch)
  WHERE released_at IS NULL AND relationship_id IS NULL;

CREATE INDEX suppression_fast_check_idx
  ON cmem.suppression_rules
    (tenant_id, user_id, relationship_id, fingerprint_version, fingerprint_key_version, fingerprint_hmac, deletion_epoch);

CREATE OR REPLACE FUNCTION cmem.enforce_suppression_release_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 OR NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'new suppression must start active at revision 1'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.released_at IS NULL
     AND NEW.released_at IS NOT NULL
     AND NEW.revision = OLD.revision + 1
     AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.suppression_id IS NOT DISTINCT FROM OLD.suppression_id
     AND NEW.scope_level IS NOT DISTINCT FROM OLD.scope_level
     AND NEW.relationship_id IS NOT DISTINCT FROM OLD.relationship_id
     AND NEW.scope_kind IS NOT DISTINCT FROM OLD.scope_kind
     AND NEW.fingerprint_hmac IS NOT DISTINCT FROM OLD.fingerprint_hmac
     AND NEW.fingerprint_version IS NOT DISTINCT FROM OLD.fingerprint_version
     AND NEW.fingerprint_key_version IS NOT DISTINCT FROM OLD.fingerprint_key_version
     AND NEW.predicate IS NOT DISTINCT FROM OLD.predicate
     AND NEW.category_code IS NOT DISTINCT FROM OLD.category_code
     AND NEW.display_label_ciphertext IS NOT DISTINCT FROM OLD.display_label_ciphertext
     AND NEW.realm IS NOT DISTINCT FROM OLD.realm
     AND NEW.source_conversation_id IS NOT DISTINCT FROM OLD.source_conversation_id
     AND NEW.source_start_sequence IS NOT DISTINCT FROM OLD.source_start_sequence
     AND NEW.source_end_sequence IS NOT DISTINCT FROM OLD.source_end_sequence
     AND NEW.deletion_epoch IS NOT DISTINCT FROM OLD.deletion_epoch
     AND NEW.starts_at IS NOT DISTINCT FROM OLD.starts_at
     AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at
     AND NEW.reason_code IS NOT DISTINCT FROM OLD.reason_code THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'suppression rules are immutable except explicit one-way release'
    USING ERRCODE = '55000';
END
$fn$;

CREATE TRIGGER suppression_rules_release_before_write
BEFORE INSERT OR UPDATE ON cmem.suppression_rules
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_suppression_release_only();

CREATE OR REPLACE FUNCTION cmem.enforce_claim_suppression()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
DECLARE
  origin_relationship_id uuid;
  claim_deletion_epoch bigint;
BEGIN
  SELECT relationship_id, deletion_epoch
    INTO origin_relationship_id, claim_deletion_epoch
  FROM cmem.memory_claims
  WHERE tenant_id = NEW.tenant_id
    AND user_id = NEW.user_id
    AND memory_id = NEW.memory_id;

  IF EXISTS (
    SELECT 1
    FROM cmem.suppression_rules s
    WHERE s.tenant_id = NEW.tenant_id
      AND s.user_id = NEW.user_id
      AND (s.relationship_id IS NULL OR s.relationship_id = origin_relationship_id)
      AND s.released_at IS NULL
      AND s.starts_at <= clock_timestamp()
      AND (s.expires_at IS NULL OR s.expires_at > clock_timestamp())
      AND (
        (s.scope_kind = 'claim_fingerprint'
          AND s.fingerprint_version = NEW.fingerprint_version
          AND s.fingerprint_key_version = NEW.fingerprint_key_version
          AND s.fingerprint_hmac = NEW.fingerprint_hmac)
        OR (s.scope_kind = 'predicate' AND (
          (s.predicate IS NOT NULL AND s.predicate = NEW.predicate)
          OR (s.category_code IS NOT NULL AND s.category_code = NEW.privacy_category)
        ))
        OR (s.scope_kind = 'user_epoch' AND s.deletion_epoch >= claim_deletion_epoch)
      )
  ) THEN
    RAISE EXCEPTION 'claim revision is blocked by an active suppression rule'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER claim_revisions_suppression_before_insert
BEFORE INSERT ON cmem.claim_revisions
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_claim_suppression();

CREATE OR REPLACE FUNCTION cmem.enforce_evidence_source_and_suppression()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
DECLARE
  origin_relationship_id uuid;
  claim_deletion_epoch bigint;
  actual_relationship_id uuid;
  actual_conversation_id uuid;
  actual_start_sequence bigint;
  actual_end_sequence bigint;
BEGIN
  SELECT c.relationship_id, c.deletion_epoch
    INTO origin_relationship_id, claim_deletion_epoch
  FROM cmem.memory_claims c
  WHERE c.tenant_id = NEW.tenant_id
    AND c.user_id = NEW.user_id
    AND c.memory_id = NEW.memory_id;

  IF NOT FOUND OR NEW.source_relationship_id IS DISTINCT FROM origin_relationship_id THEN
    RAISE EXCEPTION 'evidence source must belong to the claim origin relationship'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.source_kind = 'message' AND NEW.message_id IS NOT NULL THEN
    SELECT m.relationship_id, m.conversation_id, m.sequence_no, m.sequence_no
      INTO actual_relationship_id, actual_conversation_id, actual_start_sequence, actual_end_sequence
    FROM cmem.messages m
    WHERE m.tenant_id = NEW.tenant_id
      AND m.user_id = NEW.user_id
      AND m.message_id = NEW.message_id;
  ELSIF NEW.source_kind = 'segment_summary' AND NEW.summary_id IS NOT NULL THEN
    SELECT s.relationship_id, s.conversation_id, s.start_sequence, s.end_sequence
      INTO actual_relationship_id, actual_conversation_id, actual_start_sequence, actual_end_sequence
    FROM cmem.segment_summaries s
    WHERE s.tenant_id = NEW.tenant_id
      AND s.user_id = NEW.user_id
      AND s.summary_id = NEW.summary_id;
  ELSIF NEW.source_kind IN ('explicit_form', 'import_manifest') THEN
    actual_relationship_id := origin_relationship_id;
  ELSE
    RAISE EXCEPTION 'new message or summary evidence must reference an available source'
      USING ERRCODE = '23514';
  END IF;

  IF actual_relationship_id IS DISTINCT FROM NEW.source_relationship_id
     OR actual_conversation_id IS DISTINCT FROM NEW.source_conversation_id
     OR actual_start_sequence IS DISTINCT FROM NEW.source_start_sequence
     OR actual_end_sequence IS DISTINCT FROM NEW.source_end_sequence
     OR (NEW.source_kind IN ('explicit_form', 'import_manifest')
         AND NEW.source_external_hmac IS DISTINCT FROM NEW.source_fingerprint_hmac) THEN
    RAISE EXCEPTION 'evidence source metadata does not match the authoritative source'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM cmem.suppression_rules s
    WHERE s.tenant_id = NEW.tenant_id
      AND s.user_id = NEW.user_id
      AND (s.relationship_id IS NULL OR s.relationship_id = origin_relationship_id)
      AND s.released_at IS NULL
      AND s.starts_at <= clock_timestamp()
      AND (s.expires_at IS NULL OR s.expires_at > clock_timestamp())
      AND (
        (s.scope_kind = 'evidence'
          AND s.fingerprint_version = NEW.fingerprint_version
          AND s.fingerprint_key_version = NEW.fingerprint_key_version
          AND s.fingerprint_hmac = NEW.source_fingerprint_hmac)
        OR (s.scope_kind = 'conversation_range'
          AND s.source_conversation_id = NEW.source_conversation_id
          AND s.source_start_sequence <= NEW.source_end_sequence
          AND s.source_end_sequence >= NEW.source_start_sequence)
        OR (s.scope_kind = 'user_epoch' AND s.deletion_epoch >= claim_deletion_epoch)
      )
  ) THEN
    RAISE EXCEPTION 'evidence is blocked by an active suppression rule'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER claim_evidence_source_suppression_before_insert
BEFORE INSERT ON cmem.claim_evidence
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_evidence_source_and_suppression();

-- Portable base representation. For pgvector, migrate per embedding model/dimension into dedicated vector tables.
CREATE TABLE cmem.embedding_records (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  embedding_id uuid NOT NULL DEFAULT gen_random_uuid(),
  relationship_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('memory_claim', 'segment_summary')),
  source_id uuid NOT NULL,
  source_revision integer,
  provider_kind text NOT NULL CHECK (provider_kind IN ('local', 'external_api')),
  provider_id text NOT NULL CHECK (char_length(provider_id) BETWEEN 1 AND 128),
  embedding_model text NOT NULL CHECK (char_length(embedding_model) BETWEEN 1 AND 128),
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 8 AND 8192),
  embedding real[] NOT NULL,
  source_hmac bytea NOT NULL,
  realm cmem.memory_realm NOT NULL,
  sensitivity cmem.sensitivity_level NOT NULL,
  policy_version text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  logically_deleted_at timestamptz,
  PRIMARY KEY (tenant_id, user_id, embedding_id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, user_id, relationship_id, source_kind, source_id, source_revision, provider_id, embedding_model),
  FOREIGN KEY (tenant_id, user_id, relationship_id)
    REFERENCES cmem.relationships(tenant_id, user_id, relationship_id),
  CHECK (cardinality(embedding) = dimensions),
  CHECK (octet_length(source_hmac) = 32),
  CHECK ((source_kind = 'memory_claim' AND source_revision IS NOT NULL)
      OR (source_kind = 'segment_summary' AND source_revision IS NULL)),
  CHECK (sensitivity NOT IN ('highly_sensitive', 'prohibited'))
);

CREATE INDEX embedding_scope_idx
  ON cmem.embedding_records (tenant_id, user_id, relationship_id, realm, provider_id, embedding_model)
  WHERE logically_deleted_at IS NULL;

CREATE OR REPLACE FUNCTION cmem.enforce_embedding_immutable_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
DECLARE
  coordinate real;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOREACH coordinate IN ARRAY NEW.embedding LOOP
      IF coordinate IS NULL
         OR coordinate = 'NaN'::real
         OR coordinate = 'Infinity'::real
         OR coordinate = '-Infinity'::real THEN
        RAISE EXCEPTION 'embedding contains a null or non-finite coordinate'
          USING ERRCODE = '22003';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;
  IF OLD.logically_deleted_at IS NULL
     AND NEW.logically_deleted_at IS NOT NULL
     AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.embedding_id IS NOT DISTINCT FROM OLD.embedding_id
     AND NEW.relationship_id IS NOT DISTINCT FROM OLD.relationship_id
     AND NEW.source_kind IS NOT DISTINCT FROM OLD.source_kind
     AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id
     AND NEW.source_revision IS NOT DISTINCT FROM OLD.source_revision
     AND NEW.provider_kind IS NOT DISTINCT FROM OLD.provider_kind
     AND NEW.provider_id IS NOT DISTINCT FROM OLD.provider_id
     AND NEW.embedding_model IS NOT DISTINCT FROM OLD.embedding_model
     AND NEW.dimensions IS NOT DISTINCT FROM OLD.dimensions
     AND NEW.embedding IS NOT DISTINCT FROM OLD.embedding
     AND NEW.source_hmac IS NOT DISTINCT FROM OLD.source_hmac
     AND NEW.realm IS NOT DISTINCT FROM OLD.realm
     AND NEW.sensitivity IS NOT DISTINCT FROM OLD.sensitivity
     AND NEW.policy_version IS NOT DISTINCT FROM OLD.policy_version
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'embedding records are immutable except one-way logical deletion'
    USING ERRCODE = '55000';
END
$fn$;

CREATE TRIGGER embedding_records_immutable_before_write
BEFORE INSERT OR UPDATE ON cmem.embedding_records
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_embedding_immutable_delete();

CREATE TABLE cmem.recall_traces (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  trace_id uuid NOT NULL DEFAULT gen_random_uuid(),
  relationship_id uuid NOT NULL,
  conversation_id uuid,
  turn_id uuid,
  mode text NOT NULL CHECK (mode IN ('none', 'exact', 'hybrid', 'deep')),
  query_hmac bytea NOT NULL,
  query_redacted text CHECK (char_length(query_redacted) <= 1000),
  trace_json jsonb NOT NULL,
  policy_version text NOT NULL,
  retrieval_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, user_id, trace_id),
  FOREIGN KEY (tenant_id, user_id, relationship_id)
    REFERENCES cmem.relationships(tenant_id, user_id, relationship_id),
  FOREIGN KEY (tenant_id, user_id, relationship_id, conversation_id)
    REFERENCES cmem.conversations(tenant_id, user_id, relationship_id, conversation_id),
  CHECK (octet_length(query_hmac) = 32),
  CHECK (expires_at > created_at),
  CHECK (jsonb_typeof(trace_json) = 'object'),
  CHECK ((trace_json - ARRAY[
    'schemaVersion','routerReasons','candidates','finalMemoryIds','tokenUsage',
    'embeddingUsage','modelUsage','degraded','degradationReasons','versions'
  ]) = '{}'::jsonb)
);

CREATE TABLE cmem.idempotency_records (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  operation text NOT NULL,
  idempotency_key_hmac bytea NOT NULL,
  request_hmac bytea NOT NULL,
  response_status integer,
  response_receipt jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL CHECK (state IN ('started', 'completed', 'failed_retryable', 'failed_final')),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, user_id, operation, idempotency_key_hmac),
  CHECK (jsonb_typeof(response_receipt) = 'object'),
  CHECK ((response_receipt - ARRAY[
    'resource_kind','resource_id','resource_revision','state','etag','error_code','retry_after_seconds'
  ]) = '{}'::jsonb)
);

-- Transactional Outbox: domain mutation and event creation commit together.
CREATE TABLE cmem.outbox_events (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  outbox_id uuid NOT NULL DEFAULT gen_random_uuid(),
  aggregate_kind text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_kind text NOT NULL,
  event_version integer NOT NULL CHECK (event_version > 0),
  payload_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_hmac bytea NOT NULL,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  leased_until timestamptz,
  lease_owner text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, outbox_id),
  UNIQUE (tenant_id, user_id, aggregate_kind, aggregate_id, event_kind, event_version),
  CHECK (jsonb_typeof(payload_refs) = 'object'),
  CHECK ((payload_refs - ARRAY[
    'relationship_id','conversation_id','source_id','source_revision','deletion_epoch',
    'prompt_id','prompt_version','occurrence_id','export_job_id','import_job_id'
  ]) = '{}'::jsonb)
);

CREATE INDEX outbox_available_idx
  ON cmem.outbox_events (available_at, outbox_id)
  WHERE published_at IS NULL;

CREATE TABLE cmem.background_jobs (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  job_id uuid NOT NULL DEFAULT gen_random_uuid(),
  relationship_id uuid NOT NULL,
  conversation_id uuid,
  kind text NOT NULL CHECK (kind IN ('memory_extraction', 'embedding', 'segment_summary', 'adaptive_profile', 'deletion_step', 'export', 'import')),
  dedupe_hmac bytea NOT NULL,
  payload_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  state cmem.job_state NOT NULL DEFAULT 'queued',
  priority smallint NOT NULL DEFAULT 100,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  leased_until timestamptz,
  lease_owner text,
  last_error_code text CHECK (last_error_code ~ '^[a-z][a-z0-9._-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, job_id),
  UNIQUE (tenant_id, user_id, kind, dedupe_hmac),
  FOREIGN KEY (tenant_id, user_id, relationship_id)
    REFERENCES cmem.relationships(tenant_id, user_id, relationship_id),
  FOREIGN KEY (tenant_id, user_id, relationship_id, conversation_id)
    REFERENCES cmem.conversations(tenant_id, user_id, relationship_id, conversation_id),
  CHECK (jsonb_typeof(payload_refs) = 'object'),
  CHECK ((payload_refs - ARRAY[
    'source_id','source_revision','start_sequence','end_sequence','deletion_epoch',
    'prompt_id','prompt_version','export_job_id','import_job_id'
  ]) = '{}'::jsonb)
);

CREATE INDEX background_jobs_lease_idx
  ON cmem.background_jobs (priority, available_at, job_id)
  WHERE state IN ('queued', 'retry_wait');

-- Contains no message/job payload. A tenant dispatcher leases one row, then sets app.user_id from
-- this server-owned row before opening the user-scoped job transaction. API roles receive no grants.
CREATE TABLE cmem.worker_wakeups (
  tenant_id uuid NOT NULL REFERENCES cmem.tenants(tenant_id),
  wakeup_id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('outbox', 'background_job', 'proactive_event')),
  target_id uuid NOT NULL,
  dedupe_hmac bytea NOT NULL,
  available_at timestamptz NOT NULL,
  leased_until timestamptz,
  lease_owner text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, wakeup_id),
  UNIQUE (tenant_id, target_kind, target_id, dedupe_hmac),
  FOREIGN KEY (tenant_id, user_id) REFERENCES cmem.app_users(tenant_id, user_id)
);

CREATE INDEX worker_wakeups_available_idx
  ON cmem.worker_wakeups (tenant_id, available_at, wakeup_id)
  WHERE completed_at IS NULL;

-- Product switches can only narrow a user's purpose-specific consent; they never grant it.
CREATE TABLE cmem.memory_settings (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  relationship_id uuid NOT NULL,
  extraction_enabled boolean NOT NULL DEFAULT false,
  summarization_enabled boolean NOT NULL DEFAULT false,
  semantic_index_enabled boolean NOT NULL DEFAULT false,
  embedding_enabled boolean NOT NULL DEFAULT false,
  external_embedding_enabled boolean NOT NULL DEFAULT false,
  external_memory_provider_enabled boolean NOT NULL DEFAULT false,
  deep_recall_enabled boolean NOT NULL DEFAULT false,
  adaptive_profile_enabled boolean NOT NULL DEFAULT false,
  analytics_enabled boolean NOT NULL DEFAULT false,
  raw_archive_enabled boolean NOT NULL DEFAULT false,
  retention_mode text NOT NULL DEFAULT 'redacted_only'
    CHECK (retention_mode IN ('ephemeral', 'redacted_only', 'standard', 'extended')),
  sensitive_memory_mode text NOT NULL DEFAULT 'never'
    CHECK (sensitive_memory_mode IN ('never', 'explicit_confirmation', 'explicit_only')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, relationship_id),
  FOREIGN KEY (tenant_id, user_id, relationship_id)
    REFERENCES cmem.relationships(tenant_id, user_id, relationship_id),
  CHECK (NOT embedding_enabled OR semantic_index_enabled),
  CHECK (NOT external_embedding_enabled OR embedding_enabled)
);

CREATE OR REPLACE FUNCTION cmem.enforce_memory_settings_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 THEN
      RAISE EXCEPTION 'new memory settings must start at revision 1'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.relationship_id IS DISTINCT FROM OLD.relationship_id
     OR NEW.revision <> OLD.revision + 1
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'memory settings scope is immutable and revision must advance by exactly one'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER memory_settings_revision_before_write
BEFORE INSERT OR UPDATE ON cmem.memory_settings
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_memory_settings_revision();

CREATE OR REPLACE FUNCTION cmem.enforce_semantic_index_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
DECLARE
  target_relationship_id uuid;
  semantic_consent boolean;
  semantic_setting boolean;
BEGIN
  IF NEW.search_text IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'segment_summaries' THEN
    target_relationship_id := NEW.relationship_id;
  ELSIF TG_TABLE_NAME = 'claim_revisions' THEN
    SELECT relationship_id INTO target_relationship_id
    FROM cmem.memory_claims
    WHERE tenant_id = NEW.tenant_id
      AND user_id = NEW.user_id
      AND memory_id = NEW.memory_id;
  ELSE
    RAISE EXCEPTION 'semantic index trigger attached to unsupported table';
  END IF;

  SELECT cp.granted, ms.semantic_index_enabled
    INTO semantic_consent, semantic_setting
  FROM cmem.memory_settings ms
  LEFT JOIN cmem.consent_projection cp
    ON cp.tenant_id = ms.tenant_id
   AND cp.user_id = ms.user_id
   AND cp.relationship_id = ms.relationship_id
   AND cp.purpose = 'semantic_index'
  WHERE ms.tenant_id = NEW.tenant_id
    AND ms.user_id = NEW.user_id
    AND ms.relationship_id = target_relationship_id;

  IF target_relationship_id IS NULL
     OR semantic_consent IS DISTINCT FROM true
     OR semantic_setting IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'search index material requires current semantic-index consent and setting'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER segment_summaries_semantic_before_write
BEFORE INSERT OR UPDATE OF search_text ON cmem.segment_summaries
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_semantic_index_write();

CREATE TRIGGER claim_revisions_semantic_before_write
BEFORE INSERT OR UPDATE OF search_text ON cmem.claim_revisions
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_semantic_index_write();

CREATE OR REPLACE FUNCTION cmem.enforce_embedding_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
DECLARE
  semantic_consent boolean;
  external_consent boolean;
  semantic_setting boolean;
  embedding_setting boolean;
  external_setting boolean;
BEGIN
  SELECT
    semantic_cp.granted,
    external_cp.granted,
    ms.semantic_index_enabled,
    ms.embedding_enabled,
    ms.external_embedding_enabled
    INTO semantic_consent, external_consent, semantic_setting, embedding_setting, external_setting
  FROM cmem.memory_settings ms
  LEFT JOIN cmem.consent_projection semantic_cp
    ON semantic_cp.tenant_id = ms.tenant_id
   AND semantic_cp.user_id = ms.user_id
   AND semantic_cp.relationship_id = ms.relationship_id
   AND semantic_cp.purpose = 'semantic_index'
  LEFT JOIN cmem.consent_projection external_cp
    ON external_cp.tenant_id = ms.tenant_id
   AND external_cp.user_id = ms.user_id
   AND external_cp.relationship_id = ms.relationship_id
   AND external_cp.purpose = 'external_embedding'
  WHERE ms.tenant_id = NEW.tenant_id
    AND ms.user_id = NEW.user_id
    AND ms.relationship_id = NEW.relationship_id;

  IF semantic_consent IS DISTINCT FROM true
     OR semantic_setting IS DISTINCT FROM true
     OR embedding_setting IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'embedding requires current semantic-index consent and enabled settings'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.provider_kind = 'external_api'
     AND (external_consent IS DISTINCT FROM true OR external_setting IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'external embedding requires separate current consent and setting'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.source_kind = 'memory_claim' THEN
    PERFORM 1
    FROM cmem.memory_claims c
    JOIN cmem.claim_revisions cr
      ON cr.tenant_id = c.tenant_id
     AND cr.user_id = c.user_id
     AND cr.memory_id = c.memory_id
     AND cr.revision = NEW.source_revision
    JOIN cmem.memory_relationship_grants g
      ON g.tenant_id = c.tenant_id
     AND g.user_id = c.user_id
     AND g.memory_id = c.memory_id
     AND g.relationship_id = NEW.relationship_id
     AND g.revoked_at IS NULL
    WHERE c.tenant_id = NEW.tenant_id
      AND c.user_id = NEW.user_id
      AND c.memory_id = NEW.source_id
      AND c.state = 'active'
      AND c.logically_deleted_at IS NULL
      AND c.current_revision = NEW.source_revision
      AND cr.realm = NEW.realm
      AND cr.sensitivity = NEW.sensitivity;
  ELSE
    PERFORM 1
    FROM cmem.segment_summaries s
    WHERE s.tenant_id = NEW.tenant_id
      AND s.user_id = NEW.user_id
      AND s.relationship_id = NEW.relationship_id
      AND s.summary_id = NEW.source_id
      AND s.status = 'active'
      AND s.logically_deleted_at IS NULL
      AND s.sensitivity_ceiling = NEW.sensitivity;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'embedding source is stale, deleted, mismatched, or not granted to relationship'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER embedding_records_policy_before_insert
BEFORE INSERT ON cmem.embedding_records
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_embedding_write();

CREATE OR REPLACE FUNCTION cmem.cleanup_derived_indexes_after_consent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  IF NEW.granted THEN
    RETURN NEW;
  END IF;

  IF NEW.purpose = 'semantic_index' THEN
    -- Privacy withdrawal is the only allowed mutation of otherwise immutable summary search material.
    UPDATE cmem.segment_summaries
       SET search_text = NULL
     WHERE tenant_id = NEW.tenant_id
       AND user_id = NEW.user_id
       AND relationship_id = NEW.relationship_id
       AND search_text IS NOT NULL;

    UPDATE cmem.claim_revisions cr
       SET search_text = NULL
      FROM cmem.memory_claims c
     WHERE c.tenant_id = NEW.tenant_id
       AND c.user_id = NEW.user_id
       AND c.relationship_id = NEW.relationship_id
       AND cr.tenant_id = c.tenant_id
       AND cr.user_id = c.user_id
       AND cr.memory_id = c.memory_id
       AND cr.search_text IS NOT NULL;

    UPDATE cmem.embedding_records
       SET logically_deleted_at = COALESCE(logically_deleted_at, clock_timestamp())
     WHERE tenant_id = NEW.tenant_id
       AND user_id = NEW.user_id
       AND relationship_id = NEW.relationship_id
       AND logically_deleted_at IS NULL;
  ELSIF NEW.purpose = 'external_embedding' THEN
    UPDATE cmem.embedding_records
       SET logically_deleted_at = COALESCE(logically_deleted_at, clock_timestamp())
     WHERE tenant_id = NEW.tenant_id
       AND user_id = NEW.user_id
       AND relationship_id = NEW.relationship_id
       AND provider_kind = 'external_api'
       AND logically_deleted_at IS NULL;
  ELSIF NEW.purpose = 'cross_relationship_memory_share' THEN
    -- Re-enabling sharing later must not silently resurrect previously shared claims.
    UPDATE cmem.memory_relationship_grants
       SET revoked_at = COALESCE(revoked_at, clock_timestamp())
     WHERE tenant_id = NEW.tenant_id
       AND user_id = NEW.user_id
       AND relationship_id = NEW.relationship_id
       AND grant_source = 'explicit_user_share'
       AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER consent_projection_cleanup_after_write
AFTER INSERT OR UPDATE OF granted ON cmem.consent_projection
FOR EACH ROW EXECUTE FUNCTION cmem.cleanup_derived_indexes_after_consent();

CREATE OR REPLACE FUNCTION cmem.cleanup_derived_indexes_after_setting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  IF OLD.semantic_index_enabled AND NOT NEW.semantic_index_enabled THEN
    UPDATE cmem.segment_summaries
       SET search_text = NULL
     WHERE tenant_id = NEW.tenant_id
       AND user_id = NEW.user_id
       AND relationship_id = NEW.relationship_id
       AND search_text IS NOT NULL;
    UPDATE cmem.claim_revisions cr
       SET search_text = NULL
      FROM cmem.memory_claims c
     WHERE c.tenant_id = NEW.tenant_id
       AND c.user_id = NEW.user_id
       AND c.relationship_id = NEW.relationship_id
       AND cr.tenant_id = c.tenant_id
       AND cr.user_id = c.user_id
       AND cr.memory_id = c.memory_id
       AND cr.search_text IS NOT NULL;
    UPDATE cmem.embedding_records
       SET logically_deleted_at = COALESCE(logically_deleted_at, clock_timestamp())
     WHERE tenant_id = NEW.tenant_id
       AND user_id = NEW.user_id
       AND relationship_id = NEW.relationship_id
       AND logically_deleted_at IS NULL;
  ELSIF OLD.embedding_enabled AND NOT NEW.embedding_enabled THEN
    UPDATE cmem.embedding_records
       SET logically_deleted_at = COALESCE(logically_deleted_at, clock_timestamp())
     WHERE tenant_id = NEW.tenant_id
       AND user_id = NEW.user_id
       AND relationship_id = NEW.relationship_id
       AND logically_deleted_at IS NULL;
  ELSIF OLD.external_embedding_enabled AND NOT NEW.external_embedding_enabled THEN
    UPDATE cmem.embedding_records
       SET logically_deleted_at = COALESCE(logically_deleted_at, clock_timestamp())
     WHERE tenant_id = NEW.tenant_id
       AND user_id = NEW.user_id
       AND relationship_id = NEW.relationship_id
       AND provider_kind = 'external_api'
       AND logically_deleted_at IS NULL;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER memory_settings_cleanup_after_update
AFTER UPDATE OF semantic_index_enabled, embedding_enabled, external_embedding_enabled
ON cmem.memory_settings
FOR EACH ROW EXECUTE FUNCTION cmem.cleanup_derived_indexes_after_setting();

CREATE TABLE cmem.proactive_settings (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  relationship_id uuid NOT NULL,
  transactional_enabled boolean NOT NULL DEFAULT true,
  onboarding_enabled boolean NOT NULL DEFAULT false,
  relationship_enabled boolean NOT NULL DEFAULT false,
  marketing_enabled boolean NOT NULL DEFAULT false,
  lock_screen_content_mode text NOT NULL DEFAULT 'hidden'
    CHECK (lock_screen_content_mode IN ('hidden', 'generic', 'full')),
  quiet_hours_enabled boolean NOT NULL DEFAULT true,
  quiet_start time NOT NULL DEFAULT '22:00',
  quiet_end time NOT NULL DEFAULT '08:00',
  timezone text NOT NULL,
  allowed_channels text[] NOT NULL DEFAULT ARRAY['in_app']::text[],
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, relationship_id),
  FOREIGN KEY (tenant_id, user_id, relationship_id)
    REFERENCES cmem.relationships(tenant_id, user_id, relationship_id),
  CHECK (allowed_channels <@ ARRAY['in_app','device_local','app_push','web_push','email','sms','bot']::text[])
);

CREATE OR REPLACE FUNCTION cmem.enforce_proactive_settings_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 THEN
      RAISE EXCEPTION 'new proactive settings must start at revision 1'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.relationship_id IS DISTINCT FROM OLD.relationship_id
     OR NEW.revision <> OLD.revision + 1
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'proactive settings scope is immutable and revision must advance by exactly one'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER proactive_settings_revision_before_write
BEFORE INSERT OR UPDATE ON cmem.proactive_settings
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_proactive_settings_revision();

CREATE TABLE cmem.proactive_events (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  relationship_id uuid NOT NULL,
  conversation_id uuid,
  kind text NOT NULL CHECK (kind IN ('transactional_reminder', 'onboarding_in_app', 'relationship_proactive', 'anniversary', 'scheduled_greeting', 'story_event', 'marketing')),
  origin text NOT NULL CHECK (origin IN ('explicit_user_request', 'onboarding', 'approved_product_rule', 'approved_relationship_rule', 'migration')),
  summary_ciphertext bytea NOT NULL,
  due_at_utc timestamptz NOT NULL,
  local_datetime timestamp NOT NULL,
  timezone text NOT NULL,
  dst_policy text NOT NULL CHECK (dst_policy IN ('reject_ambiguous', 'earlier_offset', 'later_offset', 'shift_forward')),
  quiet_hours_policy text NOT NULL CHECK (quiet_hours_policy IN ('deliver_at_requested_time', 'move_to_next_allowed_time', 'skip_if_quiet', 'reject_on_create_if_quiet')),
  late_policy text NOT NULL CHECK (late_policy IN ('send_until_expiry', 'skip_if_late', 'ask_on_create')),
  expires_at timestamptz,
  recurrence_rrule text,
  generation_mode text NOT NULL CHECK (generation_mode IN ('template_only', 'template_or_model', 'model_or_skip')),
  template_id text,
  channel text NOT NULL CHECK (channel IN ('in_app', 'device_local', 'app_push', 'web_push', 'email', 'sms', 'bot')),
  consent_purpose text NOT NULL,
  consent_revision integer NOT NULL,
  consent_checked_at timestamptz NOT NULL,
  settings_revision_at_create bigint NOT NULL CHECK (settings_revision_at_create > 0),
  state cmem.proactive_event_state NOT NULL DEFAULT 'scheduled',
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  idempotency_hmac bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancelled_at timestamptz,
  PRIMARY KEY (tenant_id, user_id, event_id),
  UNIQUE (tenant_id, user_id, idempotency_hmac),
  FOREIGN KEY (tenant_id, user_id, relationship_id)
    REFERENCES cmem.relationships(tenant_id, user_id, relationship_id),
  FOREIGN KEY (tenant_id, user_id, relationship_id, conversation_id)
    REFERENCES cmem.conversations(tenant_id, user_id, relationship_id, conversation_id),
  FOREIGN KEY (tenant_id, user_id, relationship_id, consent_purpose)
    REFERENCES cmem.consent_projection(tenant_id, user_id, relationship_id, purpose),
  FOREIGN KEY (tenant_id, user_id, relationship_id, consent_purpose, consent_revision)
    REFERENCES cmem.consent_events(tenant_id, user_id, relationship_id, purpose, revision),
  CHECK (expires_at IS NULL OR expires_at >= due_at_utc),
  CHECK (recurrence_rrule IS NULL OR (
    char_length(recurrence_rrule) BETWEEN 1 AND 512
    AND position(chr(10) IN recurrence_rrule) = 0
    AND position(chr(13) IN recurrence_rrule) = 0
  )),
  CHECK ((kind = 'transactional_reminder' AND origin = 'explicit_user_request' AND consent_purpose = 'proactive_transactional')
      OR (kind = 'onboarding_in_app' AND consent_purpose = 'proactive_onboarding')
      OR (kind IN ('relationship_proactive','anniversary','scheduled_greeting','story_event') AND consent_purpose = 'proactive_relationship')
      OR (kind = 'marketing' AND consent_purpose = 'proactive_marketing'))
);

CREATE INDEX proactive_due_idx
  ON cmem.proactive_events (due_at_utc, event_id)
  WHERE state = 'scheduled';

CREATE OR REPLACE FUNCTION cmem.enforce_proactive_consent_on_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
DECLARE
  current_granted boolean;
  current_revision integer;
  current_settings_revision bigint;
  current_settings_permit boolean;
BEGIN
  SELECT granted, revision
    INTO current_granted, current_revision
  FROM cmem.consent_projection
  WHERE tenant_id = NEW.tenant_id
    AND user_id = NEW.user_id
    AND relationship_id = NEW.relationship_id
    AND purpose = NEW.consent_purpose;

  SELECT
    revision,
    CASE NEW.consent_purpose
      WHEN 'proactive_transactional' THEN transactional_enabled
      WHEN 'proactive_onboarding' THEN onboarding_enabled
      WHEN 'proactive_relationship' THEN relationship_enabled
      WHEN 'proactive_marketing' THEN marketing_enabled
      ELSE false
    END
    AND NEW.channel = ANY(allowed_channels)
    INTO current_settings_revision, current_settings_permit
  FROM cmem.proactive_settings
  WHERE tenant_id = NEW.tenant_id
    AND user_id = NEW.user_id
    AND relationship_id = NEW.relationship_id;

  IF current_granted IS DISTINCT FROM true
     OR current_revision <> NEW.consent_revision
     OR current_settings_revision IS DISTINCT FROM NEW.settings_revision_at_create
     OR current_settings_permit IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'proactive consent is absent, withdrawn, or stale'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER proactive_events_consent_before_write
BEFORE INSERT OR UPDATE OF relationship_id, kind, origin, channel, consent_purpose,
                           consent_revision, settings_revision_at_create
ON cmem.proactive_events
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_proactive_consent_on_write();

CREATE OR REPLACE FUNCTION cmem.enforce_proactive_event_revision_and_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('scheduled', 'paused') OR NEW.revision <> 1 THEN
      RAISE EXCEPTION 'new proactive event must start scheduled or paused at revision 1'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.event_id IS DISTINCT FROM OLD.event_id
       OR NEW.relationship_id IS DISTINCT FROM OLD.relationship_id THEN
      RAISE EXCEPTION 'proactive event identity and owner scope are immutable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'proactive event update must advance revision by exactly one'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
         (OLD.state = 'scheduled' AND NEW.state IN ('paused', 'completed', 'cancelled', 'expired', 'failed'))
      OR (OLD.state = 'paused' AND NEW.state IN ('scheduled', 'completed', 'cancelled', 'expired', 'failed'))
    ) THEN
      RAISE EXCEPTION 'invalid proactive event state transition'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF (NEW.state = 'cancelled') <> (NEW.cancelled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'cancelled proactive event must carry cancelled_at, and only cancelled events may carry it'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER proactive_events_revision_state_before_write
BEFORE INSERT OR UPDATE ON cmem.proactive_events
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_proactive_event_revision_and_state();

CREATE TABLE cmem.proactive_occurrences (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  occurrence_id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  logical_occurrence_key text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  state cmem.proactive_occurrence_state NOT NULL DEFAULT 'scheduled',
  lease_fencing_token bigint NOT NULL DEFAULT 0 CHECK (lease_fencing_token >= 0),
  lease_owner_hmac bytea,
  lease_expires_at timestamptz,
  policy_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, occurrence_id),
  UNIQUE (tenant_id, user_id, event_id, logical_occurrence_key),
  FOREIGN KEY (tenant_id, user_id, event_id)
    REFERENCES cmem.proactive_events(tenant_id, user_id, event_id),
  CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  CHECK ((policy_snapshot - ARRAY[
    'consent_revision','settings_revision','policy_version','quiet_hours_decision',
    'rate_limit_bucket','generation_prompt_version','safety_prompt_version'
  ]) = '{}'::jsonb),
  CHECK ((lease_owner_hmac IS NULL) = (lease_expires_at IS NULL)),
  CHECK (lease_owner_hmac IS NULL OR octet_length(lease_owner_hmac) = 32)
);

CREATE OR REPLACE FUNCTION cmem.enforce_proactive_occurrence_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'scheduled'
       OR NEW.lease_fencing_token <> 0
       OR NEW.lease_owner_hmac IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'new proactive occurrence must start unleased and scheduled'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.occurrence_id IS DISTINCT FROM OLD.occurrence_id
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.logical_occurrence_key IS DISTINCT FROM OLD.logical_occurrence_key
     OR NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for THEN
    RAISE EXCEPTION 'proactive occurrence identity and schedule are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    IF NEW.lease_fencing_token IS DISTINCT FROM OLD.lease_fencing_token
       OR NEW.lease_owner_hmac IS DISTINCT FROM OLD.lease_owner_hmac
       OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at THEN
      RAISE EXCEPTION 'lease fields may change only during an allowed state transition'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT (
       (OLD.state = 'scheduled' AND NEW.state IN ('leased', 'cancelled', 'expired'))
    OR (OLD.state = 'leased' AND NEW.state IN ('scheduled', 'policy_checked', 'cancelled', 'expired', 'failed'))
    OR (OLD.state = 'policy_checked' AND NEW.state IN ('generated', 'cancelled', 'expired', 'failed'))
    OR (OLD.state = 'generated' AND NEW.state IN ('outbox_committed', 'cancelled', 'expired', 'failed'))
    OR (OLD.state = 'outbox_committed' AND NEW.state IN ('provider_accepted', 'cancelled', 'expired', 'failed'))
    OR (OLD.state = 'provider_accepted' AND NEW.state IN ('delivered', 'failed'))
    OR (OLD.state = 'delivered' AND NEW.state IN ('opened', 'completed'))
    OR (OLD.state = 'opened' AND NEW.state = 'completed')
  ) THEN
    RAISE EXCEPTION 'invalid proactive occurrence state transition'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.state = 'scheduled' AND NEW.state = 'leased' THEN
    IF NEW.lease_fencing_token <= OLD.lease_fencing_token
       OR NEW.lease_owner_hmac IS NULL
       OR NEW.lease_expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'occurrence lease requires a fresh fencing token, owner and future expiry'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.state = 'leased' AND NEW.state = 'scheduled' THEN
    IF OLD.lease_expires_at > clock_timestamp()
       OR NEW.lease_fencing_token IS DISTINCT FROM OLD.lease_fencing_token
       OR NEW.lease_owner_hmac IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'only an expired lease may return to scheduled without resetting its fencing counter'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.lease_fencing_token IS DISTINCT FROM OLD.lease_fencing_token
       OR NEW.lease_owner_hmac IS DISTINCT FROM OLD.lease_owner_hmac
       OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at THEN
      RAISE EXCEPTION 'lease evidence is immutable after claim'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER proactive_occurrences_state_before_write
BEFORE INSERT OR UPDATE OF state, lease_fencing_token, lease_owner_hmac, lease_expires_at
ON cmem.proactive_occurrences
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_proactive_occurrence_state();

CREATE OR REPLACE FUNCTION cmem.enforce_occurrence_policy_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
DECLARE
  event_relationship_id uuid;
  event_consent_purpose text;
  event_consent_revision integer;
  event_state cmem.proactive_event_state;
  event_channel text;
  current_consent_granted boolean;
  current_consent_revision integer;
  current_settings_revision bigint;
  current_settings_permit boolean;
BEGIN
  IF NEW.state <> 'policy_checked' THEN
    RETURN NEW;
  END IF;
  IF OLD.state <> 'leased' THEN
    RAISE EXCEPTION 'occurrence must be leased before policy check'
      USING ERRCODE = '23514';
  END IF;

  SELECT relationship_id, consent_purpose, consent_revision, channel, state
    INTO event_relationship_id, event_consent_purpose, event_consent_revision, event_channel, event_state
  FROM cmem.proactive_events
  WHERE tenant_id = NEW.tenant_id
    AND user_id = NEW.user_id
    AND event_id = NEW.event_id;

  SELECT granted, revision INTO current_consent_granted, current_consent_revision
  FROM cmem.consent_projection
  WHERE tenant_id = NEW.tenant_id
    AND user_id = NEW.user_id
    AND relationship_id = event_relationship_id
    AND purpose = event_consent_purpose;

  SELECT
    revision,
    CASE event_consent_purpose
      WHEN 'proactive_transactional' THEN transactional_enabled
      WHEN 'proactive_onboarding' THEN onboarding_enabled
      WHEN 'proactive_relationship' THEN relationship_enabled
      WHEN 'proactive_marketing' THEN marketing_enabled
      ELSE false
    END
    AND event_channel = ANY(allowed_channels)
    INTO current_settings_revision, current_settings_permit
  FROM cmem.proactive_settings
  WHERE tenant_id = NEW.tenant_id
    AND user_id = NEW.user_id
    AND relationship_id = event_relationship_id;

  IF event_state IS DISTINCT FROM 'scheduled'
     OR OLD.lease_expires_at <= clock_timestamp()
     OR current_consent_granted IS DISTINCT FROM true
     OR current_consent_revision IS DISTINCT FROM event_consent_revision
     OR current_settings_permit IS DISTINCT FROM true
     OR (NEW.policy_snapshot->>'consent_revision')::integer IS DISTINCT FROM current_consent_revision
     OR (NEW.policy_snapshot->>'settings_revision')::bigint IS DISTINCT FROM current_settings_revision THEN
    RAISE EXCEPTION 'occurrence policy snapshot is absent, stale, or unauthorized'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER proactive_occurrences_policy_before_update
BEFORE UPDATE OF state ON cmem.proactive_occurrences
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_occurrence_policy_check();

CREATE TABLE cmem.outbound_messages (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  outbound_id uuid NOT NULL DEFAULT gen_random_uuid(),
  occurrence_id uuid NOT NULL,
  screening_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('in_app', 'device_local', 'app_push', 'web_push', 'email', 'sms', 'bot')),
  notification_preview_mode text NOT NULL DEFAULT 'hidden'
    CHECK (notification_preview_mode IN ('hidden', 'generic', 'full')),
  storage_mode text NOT NULL CHECK (storage_mode IN ('plaintext_encrypted', 'redacted_encrypted')),
  content_ciphertext bytea NOT NULL,
  content_hmac bytea NOT NULL,
  generation_receipt jsonb NOT NULL,
  outbox_committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancelled_at timestamptz,
  PRIMARY KEY (tenant_id, user_id, outbound_id),
  UNIQUE (tenant_id, user_id, occurrence_id, channel),
  UNIQUE (tenant_id, user_id, screening_id),
  FOREIGN KEY (tenant_id, user_id, occurrence_id)
    REFERENCES cmem.proactive_occurrences(tenant_id, user_id, occurrence_id),
  FOREIGN KEY (tenant_id, user_id, screening_id)
    REFERENCES cmem.privacy_screening_receipts(tenant_id, user_id, screening_id),
  CHECK (jsonb_typeof(generation_receipt) = 'object'),
  CHECK ((generation_receipt - ARRAY[
    'mode','template_id','prompt_id','prompt_version','model_id','provider_request_hmac',
    'input_tokens','output_tokens','estimated_cost_micros','safety_decision'
  ]) = '{}'::jsonb)
);

CREATE OR REPLACE FUNCTION cmem.enforce_outbound_privacy_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
DECLARE
  event_relationship_id uuid;
  event_consent_purpose text;
  event_consent_revision integer;
  event_state cmem.proactive_event_state;
  occurrence_state cmem.proactive_occurrence_state;
  event_channel text;
  current_consent_granted boolean;
  current_consent_revision integer;
  current_settings_permit boolean;
  current_lock_screen_mode text;
  lock_screen_consent boolean;
  receipt_relationship_id uuid;
  receipt_stage text;
  receipt_decision text;
  receipt_destinations text[];
  receipt_content_hmac bytea;
BEGIN
  SELECT pe.relationship_id, pe.consent_purpose, pe.consent_revision, pe.state, pe.channel, po.state
    INTO event_relationship_id, event_consent_purpose, event_consent_revision, event_state, event_channel, occurrence_state
  FROM cmem.proactive_occurrences po
  JOIN cmem.proactive_events pe
    ON pe.tenant_id = po.tenant_id
   AND pe.user_id = po.user_id
   AND pe.event_id = po.event_id
  WHERE po.tenant_id = NEW.tenant_id
    AND po.user_id = NEW.user_id
    AND po.occurrence_id = NEW.occurrence_id;

  SELECT granted, revision INTO current_consent_granted, current_consent_revision
  FROM cmem.consent_projection
  WHERE tenant_id = NEW.tenant_id
    AND user_id = NEW.user_id
    AND relationship_id = event_relationship_id
    AND purpose = event_consent_purpose;

  SELECT
    CASE event_consent_purpose
      WHEN 'proactive_transactional' THEN transactional_enabled
      WHEN 'proactive_onboarding' THEN onboarding_enabled
      WHEN 'proactive_relationship' THEN relationship_enabled
      WHEN 'proactive_marketing' THEN marketing_enabled
      ELSE false
    END
    AND NEW.channel = ANY(allowed_channels),
    lock_screen_content_mode
    INTO current_settings_permit, current_lock_screen_mode
  FROM cmem.proactive_settings
  WHERE tenant_id = NEW.tenant_id
    AND user_id = NEW.user_id
    AND relationship_id = event_relationship_id;

  SELECT granted INTO lock_screen_consent
  FROM cmem.consent_projection
  WHERE tenant_id = NEW.tenant_id
    AND user_id = NEW.user_id
    AND relationship_id = event_relationship_id
    AND purpose = 'lock_screen_content';

  SELECT relationship_id, content_stage, decision, allowed_destinations, content_event_hmac
    INTO receipt_relationship_id, receipt_stage, receipt_decision, receipt_destinations, receipt_content_hmac
  FROM cmem.privacy_screening_receipts
  WHERE tenant_id = NEW.tenant_id
    AND user_id = NEW.user_id
    AND screening_id = NEW.screening_id
    AND (expires_at IS NULL OR expires_at > clock_timestamp());

  IF event_relationship_id IS NULL
     OR event_state <> 'scheduled'
     OR occurrence_state <> 'generated'
     OR current_consent_granted IS DISTINCT FROM true
     OR current_consent_revision IS DISTINCT FROM event_consent_revision
     OR current_settings_permit IS DISTINCT FROM true
     OR NEW.channel IS DISTINCT FROM event_channel
     OR receipt_relationship_id IS DISTINCT FROM event_relationship_id
     OR receipt_content_hmac IS DISTINCT FROM NEW.content_hmac
     OR receipt_stage <> 'proactive_outbound'
     OR receipt_decision IN ('ephemeral_only', 'drop')
     OR NOT ('primary_store' = ANY(receipt_destinations))
     OR NOT ('proactive_delivery' = ANY(receipt_destinations))
     OR (NEW.channel <> 'in_app' AND NEW.notification_preview_mode = 'generic'
         AND current_lock_screen_mode = 'hidden')
     OR (NEW.channel <> 'in_app' AND NEW.notification_preview_mode = 'full'
         AND (current_lock_screen_mode <> 'full' OR lock_screen_consent IS DISTINCT FROM true)) THEN
    RAISE EXCEPTION 'outbound message lacks matching storage and delivery privacy authorization'
      USING ERRCODE = '23514';
  END IF;
  IF receipt_decision = 'allow_redacted' AND NEW.storage_mode <> 'redacted_encrypted' THEN
    RAISE EXCEPTION 'redacted outbound receipt requires redacted_encrypted storage mode'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER outbound_messages_privacy_before_insert
BEFORE INSERT ON cmem.outbound_messages
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_outbound_privacy_receipt();

CREATE OR REPLACE FUNCTION cmem.enforce_outbound_message_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.outbound_id IS DISTINCT FROM OLD.outbound_id
     OR NEW.occurrence_id IS DISTINCT FROM OLD.occurrence_id
     OR NEW.screening_id IS DISTINCT FROM OLD.screening_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.storage_mode IS DISTINCT FROM OLD.storage_mode
     OR NEW.content_ciphertext IS DISTINCT FROM OLD.content_ciphertext
     OR NEW.content_hmac IS DISTINCT FROM OLD.content_hmac
     OR NEW.generation_receipt IS DISTINCT FROM OLD.generation_receipt
     OR NEW.outbox_committed_at IS DISTINCT FROM OLD.outbox_committed_at THEN
    RAISE EXCEPTION 'outbound message identity, authorization and content are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at THEN
    IF OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL
       OR NEW.notification_preview_mode IS DISTINCT FROM OLD.notification_preview_mode THEN
      RAISE EXCEPTION 'outbound message may only transition once from active to cancelled'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.notification_preview_mode IS DISTINCT FROM OLD.notification_preview_mode THEN
    IF NOT (
         (OLD.notification_preview_mode = 'full' AND NEW.notification_preview_mode IN ('generic', 'hidden'))
      OR (OLD.notification_preview_mode = 'generic' AND NEW.notification_preview_mode = 'hidden')
    ) THEN
      RAISE EXCEPTION 'notification preview may only be downgraded before delivery'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'outbound message update has no permitted state change'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER outbound_messages_cancel_only_before_update
BEFORE UPDATE ON cmem.outbound_messages
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_outbound_message_update();

CREATE TABLE cmem.delivery_attempts (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  delivery_id uuid NOT NULL DEFAULT gen_random_uuid(),
  outbound_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  provider text NOT NULL,
  provider_id_hmac bytea,
  state text NOT NULL CHECK (state IN ('authorized', 'submitted', 'accepted', 'delivered', 'opened', 'temporary_failure', 'permanent_failure', 'unknown')),
  consent_purpose text NOT NULL,
  consent_revision integer NOT NULL CHECK (consent_revision > 0),
  settings_revision bigint NOT NULL CHECK (settings_revision > 0),
  authorization_expires_at timestamptz NOT NULL,
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9._-]{0,127}$'),
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, delivery_id),
  UNIQUE (tenant_id, user_id, outbound_id, attempt),
  FOREIGN KEY (tenant_id, user_id, outbound_id)
    REFERENCES cmem.outbound_messages(tenant_id, user_id, outbound_id),
  CHECK (authorization_expires_at > attempted_at),
  CHECK (authorization_expires_at <= attempted_at + interval '2 minutes'),
  CHECK (state IN ('authorized', 'temporary_failure', 'permanent_failure') OR provider_id_hmac IS NOT NULL)
);

CREATE OR REPLACE FUNCTION cmem.enforce_delivery_authorization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
DECLARE
  event_relationship_id uuid;
  event_consent_purpose text;
  event_consent_revision integer;
  event_state cmem.proactive_event_state;
  occurrence_state cmem.proactive_occurrence_state;
  event_channel text;
  outbound_channel text;
  outbound_cancelled_at timestamptz;
  current_consent_granted boolean;
  current_consent_revision integer;
  current_settings_revision bigint;
  current_settings_permit boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
       OR NEW.outbound_id IS DISTINCT FROM OLD.outbound_id
       OR NEW.attempt IS DISTINCT FROM OLD.attempt
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.consent_purpose IS DISTINCT FROM OLD.consent_purpose
       OR NEW.consent_revision IS DISTINCT FROM OLD.consent_revision
       OR NEW.settings_revision IS DISTINCT FROM OLD.settings_revision
       OR NEW.authorization_expires_at IS DISTINCT FROM OLD.authorization_expires_at
       OR NEW.attempted_at IS DISTINCT FROM OLD.attempted_at THEN
      RAISE EXCEPTION 'delivery attempt identity and authorization snapshot are immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.provider_id_hmac IS NOT NULL
       AND NEW.provider_id_hmac IS DISTINCT FROM OLD.provider_id_hmac THEN
      RAISE EXCEPTION 'provider receipt identity is immutable once assigned'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
      RAISE EXCEPTION 'delivery attempt updates require a valid state transition'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.state <> 'authorized' THEN
    RAISE EXCEPTION 'delivery attempt must begin in authorized state'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT (
       (OLD.state = 'authorized' AND NEW.state IN ('submitted', 'temporary_failure', 'permanent_failure'))
    OR (OLD.state = 'submitted' AND NEW.state IN ('accepted', 'delivered', 'temporary_failure', 'permanent_failure', 'unknown'))
    OR (OLD.state = 'accepted' AND NEW.state IN ('delivered', 'opened', 'temporary_failure', 'permanent_failure', 'unknown'))
    OR (OLD.state = 'delivered' AND NEW.state = 'opened')
    OR (OLD.state = 'unknown' AND NEW.state IN ('accepted', 'delivered', 'opened', 'permanent_failure'))
  ) THEN
    RAISE EXCEPTION 'invalid delivery-attempt state transition'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.state = 'submitted'
     AND (OLD.state <> 'authorized' OR OLD.authorization_expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'provider submission requires a live authorization lease'
      USING ERRCODE = '23514';
  END IF;

  IF (TG_OP = 'INSERT' AND NEW.state = 'authorized')
     OR (TG_OP = 'UPDATE' AND NEW.state = 'submitted') THEN
    SELECT
      pe.relationship_id,
      pe.consent_purpose,
      pe.consent_revision,
      pe.state,
      po.state,
      pe.channel,
      ob.channel,
      ob.cancelled_at
      INTO event_relationship_id, event_consent_purpose, event_consent_revision,
           event_state, occurrence_state, event_channel, outbound_channel, outbound_cancelled_at
    FROM cmem.outbound_messages ob
    JOIN cmem.proactive_occurrences po
      ON po.tenant_id = ob.tenant_id
     AND po.user_id = ob.user_id
     AND po.occurrence_id = ob.occurrence_id
    JOIN cmem.proactive_events pe
      ON pe.tenant_id = po.tenant_id
     AND pe.user_id = po.user_id
     AND pe.event_id = po.event_id
    WHERE ob.tenant_id = NEW.tenant_id
      AND ob.user_id = NEW.user_id
      AND ob.outbound_id = NEW.outbound_id;

    SELECT granted, revision INTO current_consent_granted, current_consent_revision
    FROM cmem.consent_projection
    WHERE tenant_id = NEW.tenant_id
      AND user_id = NEW.user_id
      AND relationship_id = event_relationship_id
      AND purpose = event_consent_purpose;

    SELECT
      revision,
      CASE event_consent_purpose
        WHEN 'proactive_transactional' THEN transactional_enabled
        WHEN 'proactive_onboarding' THEN onboarding_enabled
        WHEN 'proactive_relationship' THEN relationship_enabled
        WHEN 'proactive_marketing' THEN marketing_enabled
        ELSE false
      END
      AND outbound_channel = ANY(allowed_channels)
      INTO current_settings_revision, current_settings_permit
    FROM cmem.proactive_settings
    WHERE tenant_id = NEW.tenant_id
      AND user_id = NEW.user_id
      AND relationship_id = event_relationship_id;

    IF event_relationship_id IS NULL
       OR event_state <> 'scheduled'
       OR occurrence_state <> 'outbox_committed'
       OR outbound_cancelled_at IS NOT NULL
       OR event_channel IS DISTINCT FROM outbound_channel
       OR event_consent_purpose IS DISTINCT FROM NEW.consent_purpose
       OR event_consent_revision IS DISTINCT FROM NEW.consent_revision
       OR current_consent_granted IS DISTINCT FROM true
       OR current_consent_revision IS DISTINCT FROM NEW.consent_revision
       OR current_settings_revision IS DISTINCT FROM NEW.settings_revision
       OR current_settings_permit IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'latest consent or settings prohibit provider handoff'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER delivery_attempts_authorization_before_write
BEFORE INSERT OR UPDATE ON cmem.delivery_attempts
FOR EACH ROW EXECUTE FUNCTION cmem.enforce_delivery_authorization();

CREATE OR REPLACE FUNCTION cmem.prevent_event_cancel_after_submission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  IF NEW.state = 'cancelled' AND OLD.state <> 'cancelled' AND EXISTS (
    SELECT 1
    FROM cmem.proactive_occurrences po
    JOIN cmem.outbound_messages ob
      ON ob.tenant_id = po.tenant_id
     AND ob.user_id = po.user_id
     AND ob.occurrence_id = po.occurrence_id
    JOIN cmem.delivery_attempts da
      ON da.tenant_id = ob.tenant_id
     AND da.user_id = ob.user_id
     AND da.outbound_id = ob.outbound_id
    WHERE po.tenant_id = NEW.tenant_id
      AND po.user_id = NEW.user_id
      AND po.event_id = NEW.event_id
      AND da.state IN ('submitted', 'accepted', 'delivered', 'opened', 'unknown')
  ) THEN
    RAISE EXCEPTION 'provider submission has started; event cannot claim full cancellation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER proactive_events_no_false_cancel_before_update
BEFORE UPDATE OF state ON cmem.proactive_events
FOR EACH ROW EXECUTE FUNCTION cmem.prevent_event_cancel_after_submission();

CREATE OR REPLACE FUNCTION cmem.cancel_pending_proactive_after_consent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  IF NEW.granted OR NEW.purpose NOT IN (
    'proactive_transactional', 'proactive_onboarding', 'proactive_relationship', 'proactive_marketing'
  ) THEN
    RETURN NEW;
  END IF;

  UPDATE cmem.outbound_messages ob
     SET cancelled_at = COALESCE(ob.cancelled_at, clock_timestamp())
    FROM cmem.proactive_occurrences po, cmem.proactive_events pe
   WHERE ob.tenant_id = NEW.tenant_id
     AND ob.user_id = NEW.user_id
     AND po.tenant_id = ob.tenant_id
     AND po.user_id = ob.user_id
     AND po.occurrence_id = ob.occurrence_id
     AND pe.tenant_id = po.tenant_id
     AND pe.user_id = po.user_id
     AND pe.event_id = po.event_id
     AND pe.relationship_id = NEW.relationship_id
     AND pe.consent_purpose = NEW.purpose
     AND ob.cancelled_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM cmem.delivery_attempts da
       WHERE da.tenant_id = ob.tenant_id
         AND da.user_id = ob.user_id
         AND da.outbound_id = ob.outbound_id
         AND da.state IN ('submitted', 'accepted', 'delivered', 'opened')
     );

  UPDATE cmem.proactive_events pe
     SET state = 'cancelled', cancelled_at = COALESCE(cancelled_at, clock_timestamp()),
         updated_at = clock_timestamp(), revision = revision + 1
   WHERE pe.tenant_id = NEW.tenant_id
     AND pe.user_id = NEW.user_id
     AND pe.relationship_id = NEW.relationship_id
     AND pe.consent_purpose = NEW.purpose
     AND pe.state NOT IN ('completed', 'cancelled', 'expired', 'failed')
     AND NOT EXISTS (
       SELECT 1
       FROM cmem.proactive_occurrences po
       JOIN cmem.outbound_messages ob
         ON ob.tenant_id = po.tenant_id
        AND ob.user_id = po.user_id
        AND ob.occurrence_id = po.occurrence_id
       JOIN cmem.delivery_attempts da
         ON da.tenant_id = ob.tenant_id
        AND da.user_id = ob.user_id
        AND da.outbound_id = ob.outbound_id
        AND da.state IN ('submitted', 'accepted', 'delivered', 'opened')
       WHERE po.tenant_id = pe.tenant_id
         AND po.user_id = pe.user_id
         AND po.event_id = pe.event_id
     );

  UPDATE cmem.proactive_occurrences po
     SET state = 'cancelled', updated_at = clock_timestamp()
    FROM cmem.proactive_events pe
   WHERE pe.tenant_id = po.tenant_id
     AND pe.user_id = po.user_id
     AND pe.event_id = po.event_id
     AND pe.tenant_id = NEW.tenant_id
     AND pe.user_id = NEW.user_id
     AND pe.relationship_id = NEW.relationship_id
     AND pe.consent_purpose = NEW.purpose
     AND pe.state = 'cancelled'
     AND po.state NOT IN ('provider_accepted', 'delivered', 'opened', 'completed', 'cancelled', 'expired', 'failed');
  RETURN NEW;
END
$fn$;

CREATE TRIGGER consent_projection_proactive_cancel_after_write
AFTER INSERT OR UPDATE OF granted ON cmem.consent_projection
FOR EACH ROW EXECUTE FUNCTION cmem.cancel_pending_proactive_after_consent();

CREATE OR REPLACE FUNCTION cmem.cancel_pending_proactive_after_settings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, cmem, app
AS $fn$
BEGIN
  -- Pending previews are safely downgraded; full content is never promoted by this trigger.
  IF NEW.lock_screen_content_mode IS DISTINCT FROM OLD.lock_screen_content_mode THEN
    UPDATE cmem.outbound_messages ob
       SET notification_preview_mode = CASE NEW.lock_screen_content_mode
         WHEN 'hidden' THEN 'hidden'
         WHEN 'generic' THEN CASE WHEN ob.notification_preview_mode = 'full' THEN 'generic' ELSE ob.notification_preview_mode END
         ELSE ob.notification_preview_mode
       END
      FROM cmem.proactive_occurrences po, cmem.proactive_events pe
     WHERE ob.tenant_id = NEW.tenant_id
       AND ob.user_id = NEW.user_id
       AND ob.cancelled_at IS NULL
       AND po.tenant_id = ob.tenant_id
       AND po.user_id = ob.user_id
       AND po.occurrence_id = ob.occurrence_id
       AND pe.tenant_id = po.tenant_id
       AND pe.user_id = po.user_id
       AND pe.event_id = po.event_id
       AND pe.relationship_id = NEW.relationship_id
       AND (
         (NEW.lock_screen_content_mode = 'hidden' AND ob.notification_preview_mode <> 'hidden')
         OR (NEW.lock_screen_content_mode = 'generic' AND ob.notification_preview_mode = 'full')
       )
       AND NOT EXISTS (
         SELECT 1 FROM cmem.delivery_attempts da
         WHERE da.tenant_id = ob.tenant_id
           AND da.user_id = ob.user_id
           AND da.outbound_id = ob.outbound_id
           AND da.state IN ('submitted', 'accepted', 'delivered', 'opened')
       );
  END IF;

  UPDATE cmem.proactive_events pe
     SET state = 'cancelled', cancelled_at = COALESCE(cancelled_at, clock_timestamp()),
         updated_at = clock_timestamp(), revision = revision + 1
   WHERE pe.tenant_id = NEW.tenant_id
     AND pe.user_id = NEW.user_id
     AND pe.relationship_id = NEW.relationship_id
     AND pe.state NOT IN ('completed', 'cancelled', 'expired', 'failed')
     AND (
       pe.channel <> ALL(NEW.allowed_channels)
       OR (pe.consent_purpose = 'proactive_transactional' AND NOT NEW.transactional_enabled)
       OR (pe.consent_purpose = 'proactive_onboarding' AND NOT NEW.onboarding_enabled)
       OR (pe.consent_purpose = 'proactive_relationship' AND NOT NEW.relationship_enabled)
       OR (pe.consent_purpose = 'proactive_marketing' AND NOT NEW.marketing_enabled)
     )
     AND NOT EXISTS (
       SELECT 1
       FROM cmem.proactive_occurrences po
       JOIN cmem.outbound_messages ob
         ON ob.tenant_id = po.tenant_id
        AND ob.user_id = po.user_id
        AND ob.occurrence_id = po.occurrence_id
       JOIN cmem.delivery_attempts da
         ON da.tenant_id = ob.tenant_id
        AND da.user_id = ob.user_id
        AND da.outbound_id = ob.outbound_id
        AND da.state IN ('submitted', 'accepted', 'delivered', 'opened')
       WHERE po.tenant_id = pe.tenant_id
         AND po.user_id = pe.user_id
         AND po.event_id = pe.event_id
     );
  UPDATE cmem.proactive_occurrences po
     SET state = 'cancelled', updated_at = clock_timestamp()
    FROM cmem.proactive_events pe
   WHERE pe.tenant_id = po.tenant_id
     AND pe.user_id = po.user_id
     AND pe.event_id = po.event_id
     AND pe.tenant_id = NEW.tenant_id
     AND pe.user_id = NEW.user_id
     AND pe.relationship_id = NEW.relationship_id
     AND pe.state = 'cancelled'
     AND po.state NOT IN ('provider_accepted', 'delivered', 'opened', 'completed', 'cancelled', 'expired', 'failed');
  RETURN NEW;
END
$fn$;

CREATE TRIGGER proactive_settings_cancel_after_update
AFTER UPDATE OF transactional_enabled, onboarding_enabled, relationship_enabled,
                marketing_enabled, allowed_channels, lock_screen_content_mode
ON cmem.proactive_settings
FOR EACH ROW EXECUTE FUNCTION cmem.cancel_pending_proactive_after_settings();

CREATE TABLE cmem.deletion_jobs (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  deletion_job_id uuid NOT NULL DEFAULT gen_random_uuid(),
  relationship_id uuid,
  target_kind text NOT NULL CHECK (target_kind IN ('memory', 'evidence', 'conversation_range', 'relationship', 'user')),
  target_hmac bytea NOT NULL,
  mode text NOT NULL,
  deletion_epoch bigint NOT NULL CHECK (deletion_epoch >= 0),
  read_path_hidden_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'waiting_provider', 'completed', 'completed_with_retention_exception', 'failed')),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  request_id text NOT NULL,
  PRIMARY KEY (tenant_id, user_id, deletion_job_id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, user_id, target_kind, target_hmac, deletion_epoch),
  FOREIGN KEY (tenant_id, user_id, relationship_id)
    REFERENCES cmem.relationships(tenant_id, user_id, relationship_id),
  CHECK ((target_kind = 'user' AND relationship_id IS NULL)
      OR (target_kind <> 'user' AND relationship_id IS NOT NULL))
);

CREATE TABLE cmem.deletion_steps (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  deletion_job_id uuid NOT NULL,
  target text NOT NULL CHECK (target IN ('primary', 'search_index', 'vector_index', 'summaries', 'cache', 'queue', 'export', 'provider')),
  state text NOT NULL CHECK (state IN ('pending', 'complete', 'not_applicable', 'retention_exception', 'failed')),
  detail_redacted text,
  provider_receipt_hmac bytea,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, deletion_job_id, target),
  FOREIGN KEY (tenant_id, user_id, deletion_job_id)
    REFERENCES cmem.deletion_jobs(tenant_id, user_id, deletion_job_id)
);

CREATE TABLE cmem.export_jobs (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  export_job_id uuid NOT NULL DEFAULT gen_random_uuid(),
  scope_kind text NOT NULL CHECK (scope_kind IN ('relationship', 'all_user_data')),
  relationship_id uuid,
  include_conversations boolean NOT NULL DEFAULT false,
  encryption_mode text NOT NULL CHECK (encryption_mode IN ('recipient_public_key', 'one_time_passphrase')),
  key_secret_handle uuid NOT NULL,
  key_reference_hmac bytea NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'expired')),
  manifest_hmac bytea,
  encrypted_object_ref text CHECK (char_length(encrypted_object_ref) <= 2048),
  object_expires_at timestamptz,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, user_id, export_job_id),
  FOREIGN KEY (tenant_id, user_id, relationship_id)
    REFERENCES cmem.relationships(tenant_id, user_id, relationship_id),
  CHECK ((scope_kind = 'relationship' AND relationship_id IS NOT NULL)
      OR (scope_kind = 'all_user_data' AND relationship_id IS NULL))
);

CREATE TABLE cmem.import_jobs (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  import_job_id uuid NOT NULL DEFAULT gen_random_uuid(),
  upload_ref_hmac bytea NOT NULL,
  decryption_secret_handle uuid NOT NULL,
  decryption_key_reference_hmac bytea NOT NULL,
  manifest_hmac bytea NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'validating', 'running', 'awaiting_review', 'completed', 'failed')),
  conflict_policy text NOT NULL CHECK (conflict_policy IN ('require_review', 'keep_destination', 'import_as_contested')),
  tombstones_applied_at timestamptz,
  facts_applied_at timestamptz,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, user_id, import_job_id),
  UNIQUE (tenant_id, user_id, manifest_hmac),
  CHECK (facts_applied_at IS NULL OR tombstones_applied_at IS NOT NULL),
  CHECK (facts_applied_at IS NULL OR facts_applied_at >= tombstones_applied_at)
);

CREATE TABLE cmem.import_relationship_mappings (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  import_job_id uuid NOT NULL,
  source_relationship_ref_hmac bytea NOT NULL,
  destination_relationship_id uuid NOT NULL,
  confirmed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, user_id, import_job_id, source_relationship_ref_hmac),
  FOREIGN KEY (tenant_id, user_id, import_job_id)
    REFERENCES cmem.import_jobs(tenant_id, user_id, import_job_id),
  FOREIGN KEY (tenant_id, user_id, destination_relationship_id)
    REFERENCES cmem.relationships(tenant_id, user_id, relationship_id)
);

ALTER TABLE cmem.memory_relationship_grants
  ADD CONSTRAINT memory_relationship_grants_import_mapping_fk
  FOREIGN KEY (tenant_id, user_id, import_job_id, import_source_relationship_ref_hmac)
  REFERENCES cmem.import_relationship_mappings(
    tenant_id, user_id, import_job_id, source_relationship_ref_hmac
  );

CREATE TABLE cmem.prompt_versions (
  tenant_id uuid NOT NULL,
  prompt_id text NOT NULL CHECK (prompt_id ~ '^[a-z][a-z0-9._-]{2,127}$'),
  version text NOT NULL,
  digest_sha256 bytea NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'testing', 'staged', 'active', 'retired', 'rolled_back')),
  body_ciphertext bytea NOT NULL,
  owner_key text NOT NULL,
  model_class text NOT NULL CHECK (model_class IN ('main', 'small', 'small_or_main')),
  change_reason text NOT NULL,
  input_contract jsonb,
  output_contract jsonb,
  output_schema_digest bytea,
  rollout_percent integer NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
  created_by_subject_hmac bytea NOT NULL,
  approval_ticket text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  PRIMARY KEY (tenant_id, prompt_id, version),
  UNIQUE (tenant_id, prompt_id, digest_sha256),
  CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$'),
  CHECK (octet_length(digest_sha256) = 32),
  CHECK (output_schema_digest IS NULL OR octet_length(output_schema_digest) = 32),
  CHECK (char_length(owner_key) BETWEEN 1 AND 128),
  CHECK (char_length(change_reason) BETWEEN 3 AND 1000),
  CHECK (status NOT IN ('active', 'rolled_back') OR (approval_ticket IS NOT NULL AND published_at IS NOT NULL))
);

CREATE UNIQUE INDEX prompt_one_fully_active_uq
  ON cmem.prompt_versions (tenant_id, prompt_id)
  WHERE status = 'active' AND rollout_percent = 100;

CREATE TABLE cmem.kill_switches (
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (name IN (
    'deep_recall', 'memory_extraction', 'segment_summary', 'embedding_generation',
    'external_memory_sync', 'adaptive_profile', 'proactive_generation', 'proactive_delivery'
  )),
  enabled boolean NOT NULL,
  reason text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  expires_at timestamptz,
  updated_by_subject_hmac bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE cmem.audit_events (
  tenant_id uuid NOT NULL,
  audit_id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  actor_subject_hmac bytea NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'service', 'tenant_admin', 'system')),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9._-]{0,127}$'),
  resource_kind text NOT NULL CHECK (resource_kind ~ '^[a-z][a-z0-9._-]{0,127}$'),
  resource_hmac bytea NOT NULL,
  request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 256),
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied', 'succeeded', 'failed')),
  metadata_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, audit_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES cmem.app_users(tenant_id, user_id),
  CHECK (jsonb_typeof(metadata_redacted) = 'object'),
  CHECK ((metadata_redacted - ARRAY[
    'resource_revision','policy_version','prompt_version','model_id','provider_id',
    'result_count','purpose_code','approval_ticket_hmac','network_origin_hmac',
    'user_agent_family','duration_ms','error_code'
  ]) = '{}'::jsonb)
);

CREATE TRIGGER audit_events_immutable_before_update
BEFORE UPDATE ON cmem.audit_events
FOR EACH ROW EXECUTE FUNCTION cmem.reject_immutable_row_update();

-- PostgreSQL 15+: invoker views preserve underlying RLS.
CREATE VIEW cmem.memory_center_claims
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
  c.tenant_id,
  c.user_id,
  c.relationship_id AS origin_relationship_id,
  c.memory_id,
  c.memory_type,
  c.state,
  c.expires_at,
  c.logically_deleted_at,
  c.current_revision,
  r.realm,
  r.attribution,
  r.epistemic_basis,
  r.subject_key,
  r.predicate,
  r.value_ciphertext,
  r.display_text_ciphertext,
  r.confidence_band,
  r.sensitivity,
  r.privacy_category,
  r.valid_time_kind,
  r.valid_from,
  r.valid_to,
  r.valid_timezone,
  r.valid_recurrence_rrule,
  r.system_from,
  CASE
    WHEN grant_scope.grant_count = 0 THEN 'user_private'
    WHEN grant_scope.grant_count = 1 THEN 'relationship_only'
    ELSE 'explicit_shared'
  END AS visibility,
  grant_scope.allowed_relationship_ids
FROM cmem.memory_claims c
JOIN cmem.claim_revisions r
  ON r.tenant_id = c.tenant_id
 AND r.user_id = c.user_id
 AND r.memory_id = c.memory_id
 AND r.revision = c.current_revision
CROSS JOIN LATERAL (
  SELECT
    COUNT(*)::integer AS grant_count,
    COALESCE(array_agg(g.relationship_id ORDER BY g.relationship_id), ARRAY[]::uuid[]) AS allowed_relationship_ids
  FROM cmem.memory_relationship_grants g
  WHERE g.tenant_id = c.tenant_id
    AND g.user_id = c.user_id
    AND g.memory_id = c.memory_id
    AND g.revoked_at IS NULL
) grant_scope;

-- Chat retrieval code should query eligible views, not base tables or the broader memory-center view.
CREATE VIEW cmem.recall_eligible_claims
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
  c.tenant_id,
  c.user_id,
  g.relationship_id,
  c.relationship_id AS origin_relationship_id,
  c.memory_id,
  c.memory_type,
  c.state,
  r.revision,
  r.realm,
  r.attribution,
  r.epistemic_basis,
  r.asserted_by_ref_ciphertext,
  r.quoted_speaker_ref_ciphertext,
  r.subject_key,
  r.predicate,
  r.value_ciphertext,
  r.display_text_ciphertext,
  CASE WHEN EXISTS (
    SELECT 1
    FROM cmem.consent_projection semantic_cp
    JOIN cmem.memory_settings semantic_ms
      ON semantic_ms.tenant_id = semantic_cp.tenant_id
     AND semantic_ms.user_id = semantic_cp.user_id
     AND semantic_ms.relationship_id = semantic_cp.relationship_id
     AND semantic_ms.semantic_index_enabled = true
    WHERE semantic_cp.tenant_id = c.tenant_id
      AND semantic_cp.user_id = c.user_id
      AND semantic_cp.relationship_id = g.relationship_id
      AND semantic_cp.purpose = 'semantic_index'
      AND semantic_cp.granted = true
  ) THEN r.search_text ELSE NULL END AS search_text,
  r.fingerprint_hmac,
  r.fingerprint_version,
  r.fingerprint_key_version,
  r.confidence_band,
  r.sensitivity,
  r.privacy_category,
  r.valid_time_kind,
  r.valid_from,
  r.valid_to,
  r.valid_timezone,
  r.valid_recurrence_rrule,
  r.system_from
FROM cmem.memory_claims c
JOIN cmem.app_users u
  ON u.tenant_id = c.tenant_id
 AND u.user_id = c.user_id
JOIN cmem.claim_revisions r
  ON r.tenant_id = c.tenant_id
 AND r.user_id = c.user_id
 AND r.memory_id = c.memory_id
 AND r.revision = c.current_revision
JOIN cmem.memory_relationship_grants g
  ON g.tenant_id = c.tenant_id
 AND g.user_id = c.user_id
 AND g.memory_id = c.memory_id
 AND g.revoked_at IS NULL
JOIN cmem.relationships target_relationship
  ON target_relationship.tenant_id = g.tenant_id
 AND target_relationship.user_id = g.user_id
 AND target_relationship.relationship_id = g.relationship_id
WHERE c.state = 'active'
  AND u.status = 'active'
  AND c.deletion_epoch = u.deletion_epoch
  AND target_relationship.status = 'active'
  AND c.logically_deleted_at IS NULL
  AND (c.expires_at IS NULL OR c.expires_at > clock_timestamp())
  AND r.system_to IS NULL
  AND r.sensitivity <> 'prohibited'
  AND EXISTS (
    SELECT 1
    FROM cmem.consent_projection cp
    WHERE cp.tenant_id = c.tenant_id
      AND cp.user_id = c.user_id
      AND cp.relationship_id = g.relationship_id
      AND cp.purpose = CASE
        WHEN r.sensitivity IN ('sensitive', 'highly_sensitive') THEN 'memory_sensitive'
        ELSE 'memory_ordinary'
      END
      AND cp.granted = true
  )
  AND (
    g.grant_source <> 'explicit_user_share'
    OR EXISTS (
      SELECT 1
      FROM cmem.consent_projection share_cp
      WHERE share_cp.tenant_id = c.tenant_id
        AND share_cp.user_id = c.user_id
        AND share_cp.relationship_id = g.relationship_id
        AND share_cp.purpose = 'cross_relationship_memory_share'
        AND share_cp.granted = true
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM cmem.suppression_rules s
    WHERE s.tenant_id = c.tenant_id
      AND s.user_id = c.user_id
      AND (s.relationship_id IS NULL OR s.relationship_id = g.relationship_id)
      AND s.released_at IS NULL
      AND s.starts_at <= clock_timestamp()
      AND (s.expires_at IS NULL OR s.expires_at > clock_timestamp())
      AND (s.realm IS NULL OR s.realm = r.realm)
      AND (
        (s.scope_kind = 'claim_fingerprint'
          AND s.fingerprint_version = r.fingerprint_version
          AND s.fingerprint_key_version = r.fingerprint_key_version
          AND s.fingerprint_hmac = r.fingerprint_hmac
          AND (s.predicate IS NULL OR s.predicate = r.predicate))
        OR (s.scope_kind = 'predicate' AND (
          (s.predicate IS NOT NULL AND s.predicate = r.predicate)
          OR (s.category_code IS NOT NULL AND s.category_code = r.privacy_category)
        ))
        OR (s.scope_kind = 'user_epoch' AND s.deletion_epoch >= c.deletion_epoch)
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM cmem.claim_evidence e
    JOIN cmem.suppression_rules s
      ON s.tenant_id = e.tenant_id
     AND s.user_id = e.user_id
     AND (s.relationship_id IS NULL OR s.relationship_id = g.relationship_id)
     AND s.released_at IS NULL
     AND s.starts_at <= clock_timestamp()
     AND (s.expires_at IS NULL OR s.expires_at > clock_timestamp())
     AND (s.realm IS NULL OR s.realm = r.realm)
     AND (
       (s.scope_kind = 'evidence'
         AND s.fingerprint_version = e.fingerprint_version
         AND s.fingerprint_key_version = e.fingerprint_key_version
         AND s.fingerprint_hmac = e.source_fingerprint_hmac)
       OR (s.scope_kind = 'conversation_range'
         AND s.source_conversation_id = e.source_conversation_id
         AND s.source_start_sequence <= e.source_end_sequence
         AND s.source_end_sequence >= e.source_start_sequence)
     )
    WHERE e.tenant_id = c.tenant_id
      AND e.user_id = c.user_id
      AND e.memory_id = c.memory_id
      AND e.revision = r.revision
  );

CREATE VIEW cmem.recall_eligible_summaries
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
  s.tenant_id,
  s.user_id,
  s.relationship_id,
  s.conversation_id,
  s.summary_id,
  s.start_sequence,
  s.end_sequence,
  s.summary_ciphertext,
  CASE WHEN semantic_cp.granted = true AND ms.semantic_index_enabled = true
    THEN s.search_text ELSE NULL END AS search_text,
  s.sensitivity_ceiling,
  s.realm_distribution,
  s.open_threads_ciphertext,
  s.prompt_version,
  s.privacy_policy_version,
  s.source_digest,
  s.created_at
FROM cmem.segment_summaries s
JOIN cmem.app_users u
  ON u.tenant_id = s.tenant_id
 AND u.user_id = s.user_id
 AND u.status = 'active'
JOIN cmem.relationships rel
  ON rel.tenant_id = s.tenant_id
 AND rel.user_id = s.user_id
 AND rel.relationship_id = s.relationship_id
 AND rel.status = 'active'
JOIN cmem.memory_settings ms
  ON ms.tenant_id = s.tenant_id
 AND ms.user_id = s.user_id
 AND ms.relationship_id = s.relationship_id
JOIN cmem.consent_projection memory_cp
  ON memory_cp.tenant_id = s.tenant_id
 AND memory_cp.user_id = s.user_id
 AND memory_cp.relationship_id = s.relationship_id
 AND memory_cp.purpose = CASE
   WHEN s.sensitivity_ceiling IN ('sensitive', 'highly_sensitive') THEN 'memory_sensitive'
   ELSE 'memory_ordinary'
 END
 AND memory_cp.granted = true
LEFT JOIN cmem.consent_projection semantic_cp
  ON semantic_cp.tenant_id = s.tenant_id
 AND semantic_cp.user_id = s.user_id
 AND semantic_cp.relationship_id = s.relationship_id
 AND semantic_cp.purpose = 'semantic_index'
WHERE s.status = 'active'
  AND s.logically_deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM cmem.suppression_rules sr
    WHERE sr.tenant_id = s.tenant_id
      AND sr.user_id = s.user_id
      AND (sr.relationship_id IS NULL OR sr.relationship_id = s.relationship_id)
      AND sr.released_at IS NULL
      AND sr.starts_at <= clock_timestamp()
      AND (sr.expires_at IS NULL OR sr.expires_at > clock_timestamp())
      AND (
        (sr.scope_kind = 'evidence' AND sr.fingerprint_hmac = s.coverage_hmac)
        OR (sr.scope_kind = 'conversation_range'
          AND sr.source_conversation_id = s.conversation_id
          AND sr.source_start_sequence <= s.end_sequence
          AND sr.source_end_sequence >= s.start_sequence)
      )
  );

-- User-scoped RLS. FORCE prevents table owners from accidentally bypassing policies.
DO $rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'app_users', 'relationships', 'conversations', 'privacy_screening_receipts', 'messages', 'turns',
    'conversation_states', 'segment_summaries', 'memory_claims', 'memory_relationship_grants', 'claim_revisions',
    'claim_evidence', 'correction_events', 'consent_challenges', 'consent_events', 'consent_projection',
    'suppression_rules', 'embedding_records', 'recall_traces', 'idempotency_records',
    'outbox_events', 'background_jobs', 'memory_settings', 'proactive_settings', 'proactive_events',
    'proactive_occurrences', 'outbound_messages', 'delivery_attempts', 'deletion_jobs',
    'deletion_steps', 'export_jobs', 'import_jobs', 'import_relationship_mappings'
  ]
  LOOP
    EXECUTE format('ALTER TABLE cmem.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE cmem.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY user_isolation ON cmem.%I USING (
         tenant_id = app.current_tenant_id() AND user_id = app.current_user_id()
       ) WITH CHECK (
         tenant_id = app.current_tenant_id() AND user_id = app.current_user_id()
       )',
      table_name
    );
  END LOOP;
END
$rls$;

-- Tenant-scoped control data. SQL grants must additionally restrict writes to privileged service roles.
DO $rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['tenants', 'companions', 'worker_wakeups', 'prompt_versions', 'kill_switches', 'audit_events']
  LOOP
    EXECUTE format('ALTER TABLE cmem.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE cmem.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON cmem.%I USING (
         tenant_id = app.current_tenant_id()
       ) WITH CHECK (
         tenant_id = app.current_tenant_id()
       )',
      table_name
    );
  END LOOP;
END
$rls$;

-- Suggested separate migration when pgvector is installed and a model dimension is frozen:
--   CREATE EXTENSION vector;
--   CREATE TABLE cmem.embedding_1536 (... embedding vector(1536) NOT NULL ...);
--   CREATE INDEX ... USING hnsw (embedding vector_cosine_ops);
-- Always pre-filter tenant_id, user_id, relationship_id, realm, consent, deletion and sensitivity.
-- Approximate-vector search is never an authorization filter.

-- Operational requirements not expressible as static DDL:
-- 1. allocate message sequence numbers by locking conversation_states/conversations in one transaction;
--    prepare inserts the screened user message and prepared turn together; commit inserts the screened
--    assistant message, transitions that exact turn and writes TurnCommitted outbox in one transaction;
-- 2. insert mutation + outbox event atomically; lease jobs with FOR UPDATE SKIP LOCKED;
-- 3. validate model JSON before any insert; the model cannot choose tenant/user/scope/cursors/consent;
-- 4. correct claims by closing system_to and inserting the next revision in one SERIALIZABLE transaction;
-- 5. create a relationship-visible claim and its first grant atomically; user-private claims intentionally have no grant;
-- 6. write each consent event and its latest projection atomically; never acknowledge a half-applied withdrawal;
-- 7. compute summary sensitivity from screened sources and re-screen model output before persistence;
-- 8. forget by hiding read paths + writing suppression + deletion job in the same transaction;
-- 9. import suppression/tombstones before claims and reset all imported consent to off;
-- 10. a delivery worker must transition authorized -> submitted immediately before provider handoff;
--     withdrawal before submitted blocks, while provider-accepted traffic is only cancellable on a best-effort basis;
-- 11. consent/setting cleanup marks vectors deleted synchronously; workers physically purge external/local indexes;
-- 12. enforce per-tenant encryption keys in KMS; never put plaintext or provider keys in jobs/audit logs;
-- 13. materialize each recurrence as a distinct occurrence; claim it with UPDATE ... WHERE state='scheduled'
--     and a strictly increasing lease_fencing_token, then include the expected token in every worker UPDATE;
-- 14. evidence and range deletion must write suppression in the same transaction that hides affected read paths;
-- 15. grant table privileges to narrowly separated API, dispatcher, worker, scheduler, and migration roles.

COMMIT;
