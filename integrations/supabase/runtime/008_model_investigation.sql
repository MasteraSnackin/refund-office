-- Apply after 001 through 007 in a new authorised workspace.
-- No data updates, payment grants, provider requests or approval changes.
BEGIN;
CREATE OR REPLACE FUNCTION public.refund_runtime_finish_intake(p_tenant_id uuid,p_request_id text,p_fence bigint,p_proposal jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid; r refund_runtime.intake_requests; c refund_runtime.cases; amount bigint; digest text; evaluation jsonb; v_result jsonb; v_outcome text; previous refund_runtime.operations; v_provenance jsonb; v_line refund_runtime.order_lines; v_statement text; v_named_line text; v_named_count bigint;
BEGIN
 actor:=refund_runtime.require_member(p_tenant_id,ARRAY['investigator']);
 PERFORM 1 FROM refund_runtime.tenants WHERE id=p_tenant_id FOR UPDATE;
 PERFORM refund_runtime.object_shape(p_proposal,ARRAY['amountMinor','lineId','issue','reason','evidenceIds','source','provenance'],ARRAY['amountMinor','lineId','issue','reason','evidenceIds','source']);
 amount:=refund_runtime.whole(p_proposal->'amountMinor',0,9007199254740991);
 PERFORM refund_runtime.plain_text(p_proposal->'reason',1,4000);
 IF coalesce(p_proposal->>'source' NOT IN ('local','openai','anthropic'),true) OR coalesce(p_proposal->>'issue' NOT IN ('item_missing','delivery_dispute','unknown'),true) OR jsonb_typeof(p_proposal->'lineId') NOT IN ('string','null') OR jsonb_typeof(p_proposal->'evidenceIds') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid investigation proposal' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p_proposal->'lineId')='string' THEN PERFORM refund_runtime.identifier(p_proposal->'lineId'); END IF;
 IF jsonb_array_length(p_proposal->'evidenceIds')>20 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_proposal->'evidenceIds') e WHERE jsonb_typeof(e)<>'string' OR length(e#>>'{}')>200) THEN RAISE EXCEPTION 'Invalid evidence references' USING ERRCODE='22023'; END IF;
 IF p_proposal->>'issue' IN ('unknown','delivery_dispute') AND (amount<>0 OR p_proposal->'lineId'<>'null'::jsonb) THEN RAISE EXCEPTION 'Unsupported claims cannot propose money' USING ERRCODE='22023'; END IF;
 v_provenance:=p_proposal->'provenance';
 IF p_proposal->>'source'<>'local' OR p_proposal ? 'provenance' THEN
  PERFORM refund_runtime.object_shape(v_provenance,ARRAY['provider','model','mode'],ARRAY['provider','model','mode']);
  IF v_provenance->>'provider' IS DISTINCT FROM p_proposal->>'source' OR jsonb_typeof(v_provenance->'model') IS DISTINCT FROM 'string' OR v_provenance->>'model' !~ '^[A-Za-z0-9._:/-]{1,160}$'
    OR (p_proposal->>'source'='local' AND (v_provenance->>'mode' IS DISTINCT FROM 'local-rules' OR v_provenance->>'model' IS DISTINCT FROM 'local-rules-v2'))
    OR (p_proposal->>'source'<>'local' AND coalesce(v_provenance->>'mode' NOT IN ('controlled-test','provider-response'),true)) THEN
   RAISE EXCEPTION 'Invalid bounded analyser provenance' USING ERRCODE='22023';
  END IF;
 END IF;
 digest:=refund_runtime.hash_text(p_proposal::text);
 SELECT * INTO r FROM refund_runtime.intake_requests WHERE tenant_id=p_tenant_id AND id=p_request_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Request unavailable' USING ERRCODE='55000'; END IF;
 IF r.lease_actor IS DISTINCT FROM actor OR r.fence IS DISTINCT FROM p_fence THEN RAISE EXCEPTION 'Stale claim fence or actor' USING ERRCODE='40001'; END IF;
 IF r.finished_fence=p_fence THEN
  IF r.proposal_digest<>digest THEN RAISE EXCEPTION 'Finished claim has another proposal' USING ERRCODE='23505'; END IF;
  RETURN r.result;
 END IF;
 SELECT * INTO STRICT c FROM refund_runtime.cases WHERE tenant_id=p_tenant_id AND id=r.case_id FOR UPDATE;
 IF r.status<>'running' OR r.lease_until IS NULL OR r.lease_until<=clock_timestamp() OR c.revision<>r.claimed_revision OR c.status<>'running' OR c.stage<>'policy' OR c.approval IS NOT NULL OR c.operation_id IS NOT NULL OR c.receipt IS NOT NULL OR r.facts_digest IS DISTINCT FROM refund_runtime.hash_text(refund_runtime.context_json(p_tenant_id,r.case_id)::text) THEN RAISE EXCEPTION 'Claim expired or investigation context changed' USING ERRCODE='40001'; END IF;
 -- Provider identity never weakens checks. Enforce exact facts and known
 -- citations independently of JavaScript before saving a model recommendation.
 IF p_proposal->>'source'<>'local' THEN
  IF jsonb_array_length(p_proposal->'evidenceIds')<>(SELECT count(DISTINCT e) FROM jsonb_array_elements_text(p_proposal->'evidenceIds') e)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_proposal->'evidenceIds') cited(id) WHERE NOT EXISTS(SELECT 1 FROM refund_runtime.evidence saved WHERE saved.tenant_id=p_tenant_id AND saved.case_id=c.id AND saved.id=cited.id)) THEN
   RAISE EXCEPTION 'Model citations do not match saved evidence' USING ERRCODE='22023';
  END IF;
  IF p_proposal->>'issue'='item_missing' THEN
   -- A model cannot pick an arbitrary omission from a generic complaint.
   -- Read the actual stored statements, not a client-provided support flag.
   IF (SELECT count(*) FROM refund_runtime.order_lines WHERE tenant_id=p_tenant_id AND order_id=c.order_id AND ordered>packed)>1 THEN
    SELECT ' '||btrim(regexp_replace(lower(c.complaint||' '||coalesce(string_agg(s.body,' ' ORDER BY s.expected_revision,s.id),'')), '[^a-z0-9]+',' ','g'))||' '
      INTO v_statement FROM refund_runtime.evidence_submissions s WHERE s.tenant_id=p_tenant_id AND s.case_id=c.id;
    SELECT count(*),min(l.id) INTO v_named_count,v_named_line FROM refund_runtime.order_lines l WHERE l.tenant_id=p_tenant_id AND l.order_id=c.order_id
      AND (strpos(v_statement,' '||btrim(regexp_replace(lower(l.name),'[^a-z0-9]+',' ','g'))||' ')>0 OR strpos(v_statement,' '||btrim(regexp_replace(lower(l.id),'[^a-z0-9]+',' ','g'))||' ')>0);
    IF v_named_count<>1 OR v_named_line IS DISTINCT FROM p_proposal->>'lineId' THEN
     RAISE EXCEPTION 'Multiple omissions require one explicitly identified catalogue item' USING ERRCODE='22023';
    END IF;
   END IF;
   SELECT * INTO v_line FROM refund_runtime.order_lines WHERE tenant_id=p_tenant_id AND order_id=c.order_id AND id=p_proposal->>'lineId';
   IF v_line.id IS NULL OR amount<=0 OR amount<>(v_line.ordered-v_line.packed)::bigint*v_line.unit_amount_minor
     OR NOT (p_proposal->'evidenceIds' ? ('order:'||c.order_id)) OR NOT (p_proposal->'evidenceIds' ? ('packing:'||c.order_id))
     OR EXISTS(SELECT 1 FROM refund_runtime.evidence_submissions s WHERE s.tenant_id=p_tenant_id AND s.case_id=c.id AND (s.line_id IS DISTINCT FROM p_proposal->>'lineId' OR NOT coalesce(p_proposal->'evidenceIds' ? ('clarification:'||s.id::text),false))) THEN
    RAISE EXCEPTION 'Model proposal conflicts with saved catalogue or clarification' USING ERRCODE='22023';
   END IF;
  END IF;
 END IF;
 UPDATE refund_runtime.cases SET proposal=p_proposal,proposed_amount_minor=amount WHERE tenant_id=p_tenant_id AND id=c.id;
 evaluation:=refund_runtime.evaluate(p_tenant_id,c.id);
 IF evaluation->>'previousStatus'='succeeded' AND evaluation->>'previousSeeded'='true' AND p_proposal->>'issue'='item_missing' AND (evaluation->'checks'->2->>'pass')='true' AND (evaluation->'checks'->1->>'pass')='true' THEN
  v_outcome:='already-resolved'; SELECT * INTO previous FROM refund_runtime.operations WHERE tenant_id=p_tenant_id AND id=evaluation->>'previousOperationId';
 ELSE v_outcome:=CASE WHEN evaluation->>'eligible'='true' THEN 'awaiting-approval' ELSE 'held' END;
 END IF;
 UPDATE refund_runtime.cases SET status=CASE WHEN v_outcome='already-resolved' THEN 'complete' ELSE 'paused' END,stage=CASE WHEN v_outcome='already-resolved' THEN 'archive' ELSE 'review' END,outcome=v_outcome,checks=evaluation->'checks',fingerprint=refund_runtime.hash_text(refund_runtime.context_json(p_tenant_id,c.id,true)::text),receipt=previous.receipt,operation_id=previous.id,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=c.id;
 UPDATE refund_runtime.intake_requests SET status=v_outcome,finished_fence=p_fence,proposal_digest=digest,lease_until=NULL,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=r.id;
 INSERT INTO refund_runtime.events(tenant_id,case_id,event_type,label,detail,actor,payload) VALUES(p_tenant_id,c.id,'investigation.finished',CASE WHEN p_proposal->>'source'='local' THEN 'Local investigation finished' WHEN v_provenance->>'mode'='controlled-test' THEN 'Controlled model test finished' ELSE 'Model-assisted investigation finished' END,CASE WHEN v_outcome='already-resolved' THEN 'Existing seeded remedy found; no new refund.' ELSE 'Saved recommendation and deterministic checks; human review required.' END,actor,jsonb_build_object('outcome',v_outcome,'source',p_proposal->>'source')||CASE WHEN v_provenance IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('provenance',v_provenance) END);
 v_result:=jsonb_build_object('request',refund_runtime.request_json(p_tenant_id,r.id),'case',refund_runtime.case_json(p_tenant_id,c.id));
 UPDATE refund_runtime.intake_requests SET result=v_result WHERE tenant_id=p_tenant_id AND id=r.id;
 RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.refund_runtime_finish_intake(uuid,text,bigint,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.refund_runtime_finish_intake(uuid,text,bigint,jsonb) TO authenticated;
COMMIT;
