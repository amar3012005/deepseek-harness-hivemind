-- Schedule records remain bound to the same tenant identity as native Harness sessions.
BEGIN;
CREATE TABLE IF NOT EXISTS "harness_scheduled_tasks" (
  "id" VARCHAR(180) NOT NULL PRIMARY KEY,
  "session_id" VARCHAR(180) NOT NULL,
  "org_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "actor_user_id" UUID,
  "audience" VARCHAR(16),
  "record" JSONB NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'active',
  "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
  "last_delivery" JSONB,
  "delivery_history" JSONB,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "harness_scheduled_tasks_status_check" CHECK ("status" IN ('active', 'inactive')),
  CONSTRAINT "harness_scheduled_tasks_audience_check" CHECK ("audience" IS NULL OR "audience" IN ('personal', 'team')),
  CONSTRAINT "harness_scheduled_tasks_tenant_session_fkey"
    FOREIGN KEY ("session_id", "org_id", "user_id")
    REFERENCES "harness_sessions"("id", "org_id", "user_id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

ALTER TABLE "harness_scheduled_tasks" ADD COLUMN IF NOT EXISTS "actor_user_id" UUID;
ALTER TABLE "harness_scheduled_tasks" ADD COLUMN IF NOT EXISTS "audience" VARCHAR(16);
ALTER TABLE "harness_scheduled_tasks" ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "harness_scheduled_tasks" DISABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS "harness_scheduled_tasks_tenant_identity_key"
  ON "harness_scheduled_tasks"("id", "org_id", "user_id");
CREATE INDEX IF NOT EXISTS "harness_scheduled_tasks_tenant_due_idx"
  ON "harness_scheduled_tasks"("org_id", "user_id", "status", "scheduled_at");
CREATE INDEX IF NOT EXISTS "harness_scheduled_tasks_session_idx"
  ON "harness_scheduled_tasks"("session_id", "org_id", "user_id");

-- Compatibility due index retained for atomic target changes. Native Schedule
-- selects deadlines from the domain and opens full task rows under the trusted
-- host-read setting; management writes remain tenant-scoped below.
CREATE TABLE IF NOT EXISTS "harness_scheduled_due" (
  "task_id" VARCHAR(180) NOT NULL PRIMARY KEY,
  "org_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "actor_user_id" UUID,
  "due_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "harness_scheduled_due_task_fkey"
    FOREIGN KEY ("task_id", "org_id", "user_id")
    REFERENCES "harness_scheduled_tasks"("id", "org_id", "user_id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);
ALTER TABLE "harness_scheduled_due" ADD COLUMN IF NOT EXISTS "actor_user_id" UUID;
ALTER TABLE "harness_scheduled_due" DISABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX IF NOT EXISTS "harness_scheduled_due_tenant_identity_key"
  ON "harness_scheduled_due"("task_id", "org_id", "user_id");
CREATE INDEX IF NOT EXISTS "harness_scheduled_due_claim_idx"
  ON "harness_scheduled_due"("due_at");

-- Existing personal rows have an unambiguous actor. Shared-team actors are
-- recovered only from the old due ownership index; unresolved rows abort the
-- migration instead of silently reassigning ownership.
UPDATE "harness_scheduled_tasks" t
SET "audience" = CASE WHEN COALESCE((SELECT e.payload->'data'->>'agentPreset'
  FROM harness_session_events e WHERE e.session_id=s.id AND e.org_id=s.org_id AND e.user_id=s.user_id
    AND e.event_type='agent-preset/selected' ORDER BY e.sequence DESC LIMIT 1), s.header->>'agentPreset')='hivemind-chat'
  THEN 'personal' ELSE 'team' END,
  "actor_user_id" = CASE WHEN COALESCE((SELECT e.payload->'data'->>'agentPreset'
  FROM harness_session_events e WHERE e.session_id=s.id AND e.org_id=s.org_id AND e.user_id=s.user_id
    AND e.event_type='agent-preset/selected' ORDER BY e.sequence DESC LIMIT 1), s.header->>'agentPreset')='hivemind-chat'
  THEN t.user_id ELSE COALESCE((SELECT d.actor_user_id FROM harness_scheduled_due d
    WHERE d.task_id=t.id AND d.org_id=t.org_id AND d.user_id=t.user_id), t.actor_user_id) END
FROM harness_sessions s
WHERE s.id=t.session_id AND s.org_id=t.org_id AND s.user_id=t.user_id
  AND (t.actor_user_id IS NULL OR t.audience IS NULL);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM harness_scheduled_tasks WHERE actor_user_id IS NULL OR audience IS NULL) THEN
    RAISE EXCEPTION 'Schedule ownership backfill incomplete; reconcile actor/audience for existing rows before enabling native Schedule';
  END IF;
END $$;

ALTER TABLE "harness_scheduled_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "harness_scheduled_tasks" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "harness_scheduled_tasks_tenant_isolation" ON "harness_scheduled_tasks";
CREATE POLICY "harness_scheduled_tasks_tenant_isolation" ON "harness_scheduled_tasks"
  USING ("org_id" = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid
     AND "user_id" = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid
          AND "user_id" = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid);
DROP POLICY IF EXISTS "harness_scheduled_tasks_host_read" ON "harness_scheduled_tasks";
CREATE POLICY "harness_scheduled_tasks_host_read" ON "harness_scheduled_tasks"
  FOR SELECT USING (current_setting('app.hivemind_scheduler', true) = 'on');

ALTER TABLE "harness_scheduled_due" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "harness_scheduled_due" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "harness_scheduled_due_tenant_isolation" ON "harness_scheduled_due";
CREATE POLICY "harness_scheduled_due_tenant_isolation" ON "harness_scheduled_due"
  USING (("org_id" = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid
      AND "user_id" = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid)
    OR current_setting('app.hivemind_scheduler', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid
          AND "user_id" = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS "harness_storage_units" (
  "name" VARCHAR(63) NOT NULL PRIMARY KEY,
  "version" INTEGER NOT NULL CHECK ("version" >= 0)
);
COMMIT;
