-- Runner-owned extension. Existing native sessions retain their ownership and leases.
CREATE TABLE harness_company_hq (
  org_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  session_id varchar(180) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id,org_id,user_id) REFERENCES harness_sessions(id,org_id,user_id)
);
ALTER TABLE harness_company_hq ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_company_hq FORCE ROW LEVEL SECURITY;
-- Company members can observe ownership metadata; only its human can insert it.
CREATE POLICY company_hq_read ON harness_company_hq FOR SELECT
  USING (org_id=NULLIF(current_setting('app.hivemind_org_id',true),'')::uuid);
CREATE POLICY company_hq_create ON harness_company_hq FOR INSERT
  WITH CHECK (org_id=NULLIF(current_setting('app.hivemind_org_id',true),'')::uuid
    AND user_id=NULLIF(current_setting('app.hivemind_user_id',true),'')::uuid);
-- No implicit update/delete/takeover. A future explicit human transfer requires its own reviewed policy.
