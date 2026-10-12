-- Apply before mounting the V4 PostgreSQL provider. Historical rows are copied
-- here before the canonical HIVE tables are atomically promoted to the current
-- format. RLS mirrors the tenant boundary on harness_sessions.
CREATE TABLE IF NOT EXISTS harness_session_format_predecessors (
  session_id varchar(180) NOT NULL,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  source_version integer NOT NULL CHECK (source_version >= 0 AND source_version < 4),
  source_header jsonb NOT NULL,
  source_inherited_event_count bigint NOT NULL,
  source_event_count bigint NOT NULL,
  source_revision bigint NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, org_id, user_id, source_version)
);

-- Keep event payloads row-sized, just like the canonical event table. A single
-- JSONB array would impose an artificial per-session archive size limit.
CREATE TABLE IF NOT EXISTS harness_session_format_predecessor_events (
  session_id varchar(180) NOT NULL,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  source_version integer NOT NULL CHECK (source_version >= 0 AND source_version < 4),
  source_id bigint NOT NULL,
  source_sequence bigint NOT NULL,
  source_event_type varchar(80) NOT NULL,
  source_payload jsonb NOT NULL,
  source_created_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, org_id, user_id, source_version, source_sequence)
);

ALTER TABLE harness_session_format_predecessors ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_session_format_predecessors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant ON harness_session_format_predecessors;
CREATE POLICY tenant ON harness_session_format_predecessors
  USING (org_id = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid);
ALTER TABLE harness_session_format_predecessor_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_session_format_predecessor_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant ON harness_session_format_predecessor_events;
CREATE POLICY tenant ON harness_session_format_predecessor_events
  USING (org_id = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION reject_session_format_predecessor_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'session format predecessors are immutable';
END;
$$;
DROP TRIGGER IF EXISTS session_format_predecessor_immutable ON harness_session_format_predecessors;
CREATE TRIGGER session_format_predecessor_immutable
  BEFORE UPDATE OR DELETE ON harness_session_format_predecessors
  FOR EACH ROW EXECUTE FUNCTION reject_session_format_predecessor_mutation();
DROP TRIGGER IF EXISTS session_format_predecessor_event_immutable ON harness_session_format_predecessor_events;
CREATE TRIGGER session_format_predecessor_event_immutable
  BEFORE UPDATE OR DELETE ON harness_session_format_predecessor_events
  FOR EACH ROW EXECUTE FUNCTION reject_session_format_predecessor_mutation();

-- Grant SELECT, INSERT on both tables to the same application role that writes
-- harness_sessions and harness_session_events. Do not grant UPDATE or DELETE.
