-- Optional hosted application access. Apply after 001 and 002 in a synthetic
-- project. No provider token is stored here; no payment authority is added.
BEGIN;
CREATE TABLE refund_runtime.hosted_sessions (
 tenant_id uuid NOT NULL, id uuid NOT NULL, user_id uuid NOT NULL,
 generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '7 days',
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES refund_runtime.memberships(tenant_id,user_id)
);
ALTER TABLE refund_runtime.hosted_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON refund_runtime.hosted_sessions FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.refund_runtime_session_context(p_tenant_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid;
BEGIN
 actor:=refund_runtime.require_member(p_tenant_id,ARRAY['reviewer','investigator']);
 RETURN (SELECT jsonb_build_object('tenantId',m.tenant_id,'userId',m.user_id,'role',m.role,'title',t.title,'synthetic',t.synthetic)
 FROM refund_runtime.memberships m JOIN refund_runtime.tenants t ON t.id=m.tenant_id WHERE m.tenant_id=p_tenant_id AND m.user_id=actor);
END $$;

CREATE FUNCTION public.refund_runtime_hosted_session(p_tenant_id uuid,p_session_id uuid,p_action text,p_generation bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid; saved refund_runtime.hosted_sessions;
BEGIN
 actor:=refund_runtime.require_member(p_tenant_id,ARRAY['reviewer','investigator']);
 IF p_session_id IS NULL OR p_generation IS NULL OR p_generation<1 OR coalesce(p_action NOT IN ('create','check','rotate','revoke'),true) THEN
  RAISE EXCEPTION 'Invalid session action' USING ERRCODE='22023';
 END IF;
 IF p_action='create' THEN
  IF p_generation<>1 THEN RAISE EXCEPTION 'Initial generation required' USING ERRCODE='22023'; END IF;
  INSERT INTO refund_runtime.hosted_sessions(tenant_id,id,user_id) VALUES(p_tenant_id,p_session_id,actor) RETURNING * INTO saved;
 ELSE
  SELECT * INTO saved FROM refund_runtime.hosted_sessions WHERE tenant_id=p_tenant_id AND id=p_session_id AND user_id=actor FOR UPDATE;
  IF NOT FOUND OR saved.expires_at<=clock_timestamp() OR
   (p_action='revoke' AND p_generation>saved.generation) OR
   (p_action<>'revoke' AND (saved.revoked_at IS NOT NULL OR saved.generation<>p_generation)) THEN
   RAISE EXCEPTION 'Session expired, replaced or revoked' USING ERRCODE='42501';
  END IF;
  IF p_action='rotate' THEN
   UPDATE refund_runtime.hosted_sessions SET generation=generation+1 WHERE tenant_id=p_tenant_id AND id=p_session_id RETURNING * INTO saved;
  ELSIF p_action='revoke' AND saved.revoked_at IS NULL THEN
   -- Revocation can only remove access. The same verified user may revoke an
   -- older generation after a concurrent refresh, or confirm a lost response.
   UPDATE refund_runtime.hosted_sessions SET revoked_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=p_session_id RETURNING * INTO saved;
  END IF;
 END IF;
 RETURN public.refund_runtime_session_context(p_tenant_id)||jsonb_build_object('sessionId',saved.id,'generation',saved.generation,'sessionExpiresAt',saved.expires_at,'revoked',saved.revoked_at IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION public.refund_runtime_session_context(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.refund_runtime_hosted_session(uuid,uuid,text,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.refund_runtime_session_context(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refund_runtime_hosted_session(uuid,uuid,text,bigint) TO authenticated;
COMMIT;
