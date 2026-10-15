-- Optional durable sponsor action journal. Apply after 001. This journal has
-- no permission to change case decisions, approvals or financial operations.
BEGIN;
CREATE TABLE refund_runtime.sponsor_actions (
 tenant_id uuid NOT NULL, action_key text NOT NULL CHECK(action_key ~ '^[a-f0-9]{64}$'),
 case_id text NOT NULL, revision bigint NOT NULL CHECK(revision>0),
 action text NOT NULL CHECK(action IN ('voice','miro','modal','port') OR action ~ '^miro-card-[a-f0-9]{24}$'),
 command_id uuid NOT NULL, payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','acknowledged','succeeded','unknown','rejected')),
 result jsonb, error_code text, created_by uuid NOT NULL, updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,action_key), UNIQUE(tenant_id,command_id,action),
 FOREIGN KEY(tenant_id,case_id) REFERENCES refund_runtime.cases(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES refund_runtime.memberships(tenant_id,user_id),
 FOREIGN KEY(tenant_id,updated_by) REFERENCES refund_runtime.memberships(tenant_id,user_id)
);
ALTER TABLE refund_runtime.sponsor_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON refund_runtime.sponsor_actions FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION refund_runtime.sponsor_action_json(p_row refund_runtime.sponsor_actions) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT jsonb_build_object('key',p_row.action_key,'tenantId',p_row.tenant_id,'caseId',p_row.case_id,'revision',p_row.revision,'action',p_row.action,'commandId',p_row.command_id,'payloadHash',p_row.payload_hash,'state',p_row.state,'result',p_row.result,'errorCode',p_row.error_code,'createdAt',p_row.created_at,'updatedAt',p_row.updated_at)
$$;
CREATE FUNCTION public.refund_runtime_sponsor_action(p_tenant_id uuid,p_action text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid; saved refund_runtime.sponsor_actions; case_revision bigint; entry_key text; entry_revision bigint; entry_command uuid; next_state text; next_result jsonb; identity_field text;
BEGIN
 actor:=refund_runtime.require_member(p_tenant_id,ARRAY['reviewer','investigator']);
 IF p_action='list' THEN
  PERFORM refund_runtime.object_shape(p_input,ARRAY['caseId','revision'],ARRAY['caseId','revision']);
  PERFORM refund_runtime.identifier(p_input->'caseId'); entry_revision:=(p_input->>'revision')::bigint;
  IF entry_revision<1 OR entry_revision IS NULL THEN RAISE EXCEPTION 'Saved revision required' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM refund_runtime.cases WHERE tenant_id=p_tenant_id AND id=p_input->>'caseId') THEN RAISE EXCEPTION 'Case unavailable' USING ERRCODE='42501'; END IF;
  RETURN coalesce((SELECT jsonb_agg(refund_runtime.sponsor_action_json(a) ORDER BY a.created_at,a.action_key) FROM refund_runtime.sponsor_actions a WHERE a.tenant_id=p_tenant_id AND a.case_id=p_input->>'caseId' AND a.revision=entry_revision),'[]');
 END IF;
 IF p_action='get' THEN
  PERFORM refund_runtime.object_shape(p_input,ARRAY['key'],ARRAY['key']);
  IF coalesce((p_input->>'key') !~ '^[a-f0-9]{64}$',true) THEN RAISE EXCEPTION 'Action identity required' USING ERRCODE='22023'; END IF;
  SELECT * INTO saved FROM refund_runtime.sponsor_actions WHERE tenant_id=p_tenant_id AND action_key=p_input->>'key';
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN refund_runtime.sponsor_action_json(saved);
 END IF;
 -- Tenant lock serialises command/key reservation. A pending or unknown write
 -- cannot be released by another invocation or reset to allow a second POST.
 PERFORM 1 FROM refund_runtime.tenants WHERE id=p_tenant_id FOR UPDATE;
 IF p_action='begin' THEN
  PERFORM refund_runtime.object_shape(p_input,ARRAY['key','caseId','revision','action','commandId','payloadHash'],ARRAY['key','caseId','revision','action','commandId','payloadHash']);
  PERFORM refund_runtime.identifier(p_input->'caseId'); entry_key:=p_input->>'key'; entry_revision:=(p_input->>'revision')::bigint; entry_command:=(p_input->>'commandId')::uuid;
  IF entry_key IS NULL OR entry_key !~ '^[a-f0-9]{64}$' OR entry_revision IS NULL OR entry_revision<1 OR entry_command IS NULL OR coalesce((p_input->>'payloadHash') !~ '^[a-f0-9]{64}$',true) OR NOT coalesce((p_input->>'action') IN ('voice','miro','modal','port') OR (p_input->>'action') ~ '^miro-card-[a-f0-9]{24}$',false) THEN RAISE EXCEPTION 'Invalid sponsor command' USING ERRCODE='22023'; END IF;
  SELECT * INTO saved FROM refund_runtime.sponsor_actions WHERE tenant_id=p_tenant_id AND (action_key=entry_key OR command_id=entry_command AND action=p_input->>'action') ORDER BY (action_key=entry_key) DESC LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('created',false,'record',refund_runtime.sponsor_action_json(saved)); END IF;
  SELECT revision INTO case_revision FROM refund_runtime.cases WHERE tenant_id=p_tenant_id AND id=p_input->>'caseId';
  IF case_revision IS NULL OR case_revision<>entry_revision THEN RAISE EXCEPTION 'Case changed or unavailable' USING ERRCODE='40001'; END IF;
  INSERT INTO refund_runtime.sponsor_actions(tenant_id,action_key,case_id,revision,action,command_id,payload_hash,created_by,updated_by)
   VALUES(p_tenant_id,entry_key,p_input->>'caseId',entry_revision,p_input->>'action',entry_command,p_input->>'payloadHash',actor,actor) RETURNING * INTO saved;
  RETURN jsonb_build_object('created',true,'record',refund_runtime.sponsor_action_json(saved));
 ELSIF p_action='update' THEN
  PERFORM refund_runtime.object_shape(p_input,ARRAY['key','state','result','errorCode'],ARRAY['key','state','result','errorCode']);
  next_state:=p_input->>'state';
  IF coalesce((p_input->>'key') !~ '^[a-f0-9]{64}$',true) OR coalesce(next_state NOT IN ('acknowledged','succeeded','unknown','rejected'),true) OR
    (p_input->'result'<>'null'::jsonb AND jsonb_typeof(p_input->'result')<>'object') OR octet_length((p_input->'result')::text)>12582912 OR
    (p_input->>'errorCode' IS NOT NULL AND (p_input->>'errorCode') !~ '^[a-z][a-z0-9_]{0,79}$') THEN RAISE EXCEPTION 'Invalid sponsor result' USING ERRCODE='22023'; END IF;
  SELECT * INTO saved FROM refund_runtime.sponsor_actions WHERE tenant_id=p_tenant_id AND action_key=p_input->>'key' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sponsor action unavailable' USING ERRCODE='55000'; END IF;
  IF (saved.state='succeeded' AND next_state<>'succeeded') OR (saved.state='rejected' AND next_state<>'rejected') OR (saved.state='unknown' AND next_state NOT IN ('unknown','succeeded')) THEN RAISE EXCEPTION 'The action cannot be reset or downgraded' USING ERRCODE='55000'; END IF;
  next_result:=NULLIF(p_input->'result','null'::jsonb);
  IF saved.state IN ('succeeded','rejected') THEN
   IF saved.result IS DISTINCT FROM next_result OR saved.error_code IS DISTINCT FROM p_input->>'errorCode' THEN
    RAISE EXCEPTION 'A completed result is immutable' USING ERRCODE='55000';
   END IF;
   RETURN refund_runtime.sponsor_action_json(saved);
  END IF;
  -- An uncertain readback must not erase the acknowledged remote identity.
  IF next_state='unknown' AND next_result IS NULL AND saved.result IS NOT NULL THEN next_result:=saved.result; END IF;
  FOREACH identity_field IN ARRAY ARRAY['id','identifier','boardId','expectedContent','audioBase64','byteLength','contentType'] LOOP
   IF saved.result ? identity_field AND (saved.result->identity_field IS DISTINCT FROM next_result->identity_field) THEN
    RAISE EXCEPTION 'Acknowledged provider identity is immutable' USING ERRCODE='55000';
   END IF;
  END LOOP;
  UPDATE refund_runtime.sponsor_actions SET state=next_state,result=next_result,error_code=p_input->>'errorCode',updated_by=actor,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND action_key=saved.action_key RETURNING * INTO saved;
  RETURN refund_runtime.sponsor_action_json(saved);
 END IF;
 RAISE EXCEPTION 'Unsupported sponsor journal action' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION refund_runtime.sponsor_action_json(refund_runtime.sponsor_actions) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.refund_runtime_sponsor_action(uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.refund_runtime_sponsor_action(uuid,text,jsonb) TO authenticated;
COMMIT;
