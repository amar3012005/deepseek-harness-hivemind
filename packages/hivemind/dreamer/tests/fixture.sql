      CREATE TABLE harness_sessions (
        id varchar(180) PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL, project_id uuid,
        scope_kind varchar(24) NOT NULL DEFAULT 'organization',
        profile varchar(64) NOT NULL, variation varchar(16) NOT NULL, status varchar(24) NOT NULL DEFAULT 'active',
        header jsonb NOT NULL, inherited_event_count bigint NOT NULL DEFAULT 0, event_count bigint NOT NULL DEFAULT 0,
        revision bigint NOT NULL DEFAULT 0, title varchar(500), created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
        UNIQUE (id, org_id, user_id),
        CHECK ((scope_kind IN ('organization', 'personal') AND project_id IS NULL)
          OR (scope_kind = 'project' AND project_id IS NOT NULL))
      );
      CREATE TABLE harness_session_events (
        id bigserial PRIMARY KEY, session_id varchar(180) NOT NULL, org_id uuid NOT NULL, user_id uuid NOT NULL,
        sequence bigint NOT NULL, event_type varchar(80) NOT NULL, payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(session_id, sequence),
        FOREIGN KEY(session_id, org_id, user_id) REFERENCES harness_sessions(id, org_id, user_id)
      );
      CREATE TABLE harness_session_leases (
        id uuid PRIMARY KEY, session_id varchar(180) UNIQUE NOT NULL, org_id uuid NOT NULL, user_id uuid NOT NULL,
        holder_id text NOT NULL, token_hash char(64) UNIQUE NOT NULL, fencing_token bigint NOT NULL DEFAULT 0,
        acquired_at timestamptz NOT NULL, heartbeat_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
        released_at timestamptz,
        FOREIGN KEY(session_id, org_id, user_id) REFERENCES harness_sessions(id, org_id, user_id)
      );

CREATE TABLE users(id uuid PRIMARY KEY,deleted_at timestamptz);
CREATE TABLE user_organizations(user_id uuid,org_id uuid,role text NOT NULL DEFAULT 'admin',is_active boolean DEFAULT true,deactivated_at timestamptz,PRIMARY KEY(user_id,org_id));
ALTER TABLE harness_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON harness_sessions USING(org_id=NULLIF(current_setting('app.hivemind_org_id',true),'')::uuid AND user_id=NULLIF(current_setting('app.hivemind_user_id',true),'')::uuid);
ALTER TABLE harness_session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_session_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON harness_session_events USING(org_id=NULLIF(current_setting('app.hivemind_org_id',true),'')::uuid AND user_id=NULLIF(current_setting('app.hivemind_user_id',true),'')::uuid);
ALTER TABLE harness_session_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_session_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON harness_session_leases USING(org_id=NULLIF(current_setting('app.hivemind_org_id',true),'')::uuid AND user_id=NULLIF(current_setting('app.hivemind_user_id',true),'')::uuid);

CREATE TABLE organizations(id UUID PRIMARY KEY,hosting_mode TEXT DEFAULT 'managed',memory_storage_mode TEXT DEFAULT 'hybrid');
CREATE TABLE projects(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),org_id UUID NOT NULL,name TEXT,slug TEXT,description TEXT,policy TEXT,status TEXT DEFAULT 'active',created_by UUID,self_evolve_enabled BOOLEAN DEFAULT false,updated_at TIMESTAMPTZ DEFAULT now(),UNIQUE(org_id,slug));
CREATE TABLE project_members(project_id UUID,user_id UUID,role TEXT,added_by UUID,PRIMARY KEY(project_id,user_id));
CREATE TABLE memories(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),org_id UUID,user_id UUID,title TEXT,content TEXT,scope TEXT,project_id UUID,tags TEXT[] DEFAULT '{}',created_at TIMESTAMPTZ DEFAULT now(),deleted_at TIMESTAMPTZ);
CREATE TABLE source_metadata(memory_id UUID PRIMARY KEY,metadata JSONB);
CREATE TABLE relationships(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),from_id UUID,to_id UUID,type TEXT,confidence FLOAT,created_at TIMESTAMPTZ DEFAULT now());
