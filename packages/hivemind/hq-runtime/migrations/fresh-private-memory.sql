-- Human Start fresh owns private operating history; the runner retains no table DELETE grant.
CREATE OR REPLACE FUNCTION hivemind.reset_agent_operating_memory(p_org uuid,p_actor uuid,p_root text,p_shared boolean)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE storage_owner uuid; removed bigint;
BEGIN
  IF current_setting('app.hivemind_org_id',true) IS DISTINCT FROM p_org::text
    OR current_setting('app.hivemind_user_id',true) IS DISTINCT FROM p_actor::text THEN
    RAISE EXCEPTION 'fresh_reset_authenticated_scope_required';
  END IF;
  SELECT h.user_id INTO storage_owner FROM hivemind.harness_company_hq h
    JOIN hivemind.user_organizations m ON m.org_id=h.org_id AND m.user_id=p_actor
    JOIN hivemind.users u ON u.id=m.user_id AND u.deleted_at IS NULL
    WHERE h.org_id=p_org AND h.session_id=p_root AND m.is_active AND m.deactivated_at IS NULL
      AND m.role::text IN ('owner','admin');
  IF storage_owner IS NULL OR (NOT p_shared AND storage_owner<>p_actor) THEN
    RAISE EXCEPTION 'fresh_reset_owned_runtime_required';
  END IF;
  DELETE FROM hivemind.hyper_agent_operating_memories WHERE org_id=p_org AND project_slug='hyper-agents'
    AND (p_shared OR author_user_id=p_actor);
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END;
$$;
REVOKE ALL ON FUNCTION hivemind.reset_agent_operating_memory(uuid,uuid,text,boolean) FROM PUBLIC;
-- Deployment grants EXECUTE to its existing restricted runner role explicitly.
