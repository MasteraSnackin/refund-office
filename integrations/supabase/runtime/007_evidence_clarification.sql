-- Add customer clarification to an explicitly held, unapproved case.
-- Catalogue facts and the original complaint remain unchanged. Requires001/002.
BEGIN;
CREATE TABLE refund_runtime.evidence_submissions (
 tenant_id uuid NOT NULL, id uuid NOT NULL, case_id text NOT NULL, command_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind='customer-clarification'), line_id text NOT NULL,
 body text NOT NULL, source_reference text NOT NULL, note text NOT NULL,
 expected_revision bigint NOT NULL CHECK(expected_revision>0), actor uuid NOT NULL,
 at timestamptz NOT NULL DEFAULT clock_timestamp(), prior_investigation jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,command_id),
 FOREIGN KEY(tenant_id,case_id) REFERENCES refund_runtime.cases(tenant_id,id),
 FOREIGN KEY(tenant_id,actor) REFERENCES refund_runtime.memberships(tenant_id,user_id)
);
CREATE TRIGGER immutable_evidence_submissions BEFORE UPDATE OR DELETE ON refund_runtime.evidence_submissions FOR EACH ROW EXECUTE FUNCTION refund_runtime.reject_change();
ALTER TABLE refund_runtime.evidence_submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY evidence_submission_read ON refund_runtime.evidence_submissions FOR SELECT TO authenticated USING(refund_runtime.is_member(tenant_id));
REVOKE ALL ON refund_runtime.evidence_submissions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON refund_runtime.evidence_submissions TO authenticated;
CREATE FUNCTION refund_runtime.clarification_json(p_tenant uuid,p_id uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_build_object('id',id,'commandId',command_id,'kind',kind,'lineId',line_id,'body',body,'sourceReference',source_reference,'note',note,'expectedRevision',expected_revision,'actor',actor,'at',at) FROM refund_runtime.evidence_submissions WHERE tenant_id=p_tenant AND id=p_id
$$;
CREATE OR REPLACE FUNCTION refund_runtime.record_evidence(p_tenant uuid,p_case text) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
DECLARE c refund_runtime.cases; o refund_runtime.orders; entry jsonb;
BEGIN
 SELECT * INTO STRICT c FROM refund_runtime.cases WHERE tenant_id=p_tenant AND id=p_case;
 SELECT * INTO STRICT o FROM refund_runtime.orders WHERE tenant_id=p_tenant AND id=c.order_id;
 DELETE FROM refund_runtime.evidence WHERE tenant_id=p_tenant AND case_id=p_case;
 FOR entry IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
  jsonb_build_object('id','order:'||o.id,'title','Synthetic order','source','Synthetic catalogue','body',o.data::text),
  jsonb_build_object('id','packing:'||o.id,'title','Synthetic packing record','source','Synthetic catalogue','body',(o.data->'lines')::text),
  jsonb_build_object('id','delivery:'||o.id,'title','Synthetic delivery record','source','Synthetic catalogue','body',(o.data->'delivery')::text),
  jsonb_build_object('id','complaint:'||c.id,'title','Customer complaint','source','Synthetic intake','body',c.complaint),
  jsonb_build_object('id','remedies:'||o.id,'title','Saved remedies','source','Operational database','body',coalesce((SELECT jsonb_agg(refund_runtime.operation_json(p_tenant,id) ORDER BY id)::text FROM refund_runtime.operations WHERE tenant_id=p_tenant AND order_id=o.id),'[]'))
 )) LOOP INSERT INTO refund_runtime.evidence VALUES(p_tenant,p_case,entry->>'id',entry); END LOOP;
 FOR entry IN SELECT refund_runtime.clarification_json(p_tenant,s.id)||jsonb_build_object('id','clarification:'||s.id::text,'title','Customer clarification','source','Customer clarification recorded by reviewer') FROM refund_runtime.evidence_submissions s WHERE s.tenant_id=p_tenant AND s.case_id=p_case ORDER BY s.expected_revision,s.id LOOP INSERT INTO refund_runtime.evidence VALUES(p_tenant,p_case,entry->>'id',entry); END LOOP;
END $$;
-- Preserve the original catalogue checks and add a binding for appended claims.
ALTER FUNCTION refund_runtime.evaluate(uuid,text) RENAME TO evaluate_catalogue;
CREATE FUNCTION refund_runtime.evaluate(p_tenant uuid,p_case text) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE result jsonb; c refund_runtime.cases; checks jsonb; known boolean;
BEGIN
 result:=refund_runtime.evaluate_catalogue(p_tenant,p_case);
 SELECT * INTO STRICT c FROM refund_runtime.cases WHERE tenant_id=p_tenant AND id=p_case;
 IF EXISTS(SELECT 1 FROM refund_runtime.evidence_submissions WHERE tenant_id=p_tenant AND case_id=p_case) THEN
  known:=NOT EXISTS(SELECT 1 FROM refund_runtime.evidence_submissions s WHERE s.tenant_id=p_tenant AND s.case_id=p_case AND (s.line_id IS DISTINCT FROM c.proposal->>'lineId' OR NOT coalesce(c.proposal->'evidenceIds' ? ('clarification:'||s.id::text),false)));
  checks:=(result->'checks')||jsonb_build_array(jsonb_build_object('id','clarification','label','Recorded clarification matches the selected item','pass',known));
  result:=result||jsonb_build_object('checks',checks,'eligible',NOT EXISTS(SELECT 1 FROM jsonb_array_elements(checks) x WHERE x->>'pass' IS DISTINCT FROM 'true'));
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION refund_runtime.evaluate(uuid,text),refund_runtime.evaluate_catalogue(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.refund_runtime_evidence_request(p_tenant_id uuid,p_case_id text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE c refund_runtime.cases; r refund_runtime.intake_requests; eligible boolean;
BEGIN
 PERFORM refund_runtime.require_member(p_tenant_id,ARRAY['reviewer']);
 SELECT * INTO c FROM refund_runtime.cases WHERE tenant_id=p_tenant_id AND id=p_case_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Case unavailable' USING ERRCODE='55000'; END IF;
 SELECT * INTO r FROM refund_runtime.intake_requests WHERE tenant_id=p_tenant_id AND case_id=p_case_id;
 eligible:=coalesce(c.status='paused' AND c.stage='review' AND c.outcome='held' AND c.review->>'state'='awaiting-evidence' AND c.approval IS NULL AND c.operation_id IS NULL AND c.receipt IS NULL AND r.status='held' AND (r.lease_until IS NULL OR r.lease_until<=clock_timestamp()) AND (SELECT count(*) FROM refund_runtime.evidence_submissions WHERE tenant_id=p_tenant_id AND case_id=p_case_id)<10,false);
 RETURN jsonb_build_object('tenantId',p_tenant_id,'caseId',c.id,'revision',c.revision,'eligible',eligible,'blockedReason',CASE WHEN eligible THEN NULL ELSE 'Record a request for evidence on an unapproved case before adding a clarification. A case may hold up to ten clarifications.' END,'originalComplaint',c.complaint,'requestNote',c.review->>'note','lines',(SELECT data->'lines' FROM refund_runtime.orders WHERE tenant_id=p_tenant_id AND id=c.order_id),'submissions',coalesce((SELECT jsonb_agg(refund_runtime.clarification_json(p_tenant_id,id) ORDER BY expected_revision,id) FROM refund_runtime.evidence_submissions WHERE tenant_id=p_tenant_id AND case_id=p_case_id),'[]'),'paymentSubmission',false);
END $$;
CREATE FUNCTION public.refund_runtime_submit_clarification(p_tenant_id uuid,p_case_id text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; c refund_runtime.cases; r refund_runtime.intake_requests; cmd refund_runtime.commands; v_command_id uuid; v_payload_hash text; v_revision bigint; v_submission_id uuid; v_previous jsonb; v_result jsonb;
BEGIN
 v_actor:=refund_runtime.require_member(p_tenant_id,ARRAY['reviewer']);
 PERFORM 1 FROM refund_runtime.tenants WHERE id=p_tenant_id FOR UPDATE;
 PERFORM refund_runtime.object_shape(p_input,ARRAY['lineId','customerStatement','sourceReference','note','expectedRevision','commandId'],ARRAY['lineId','customerStatement','sourceReference','note','expectedRevision','commandId']);
 IF coalesce(p_input->>'commandId' !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$',true) THEN RAISE EXCEPTION 'Use a customer clarification with a stable command' USING ERRCODE='22023'; END IF;
 PERFORM refund_runtime.identifier(p_input->'lineId'); PERFORM refund_runtime.plain_text(p_input->'customerStatement',10,4000); PERFORM refund_runtime.plain_text(p_input->'sourceReference',10,200); PERFORM refund_runtime.plain_text(p_input->'note',10,2000);
 v_revision:=refund_runtime.whole(p_input->'expectedRevision',1,9007199254740991); v_command_id:=(p_input->>'commandId')::uuid;
 v_payload_hash:=refund_runtime.hash_text(jsonb_build_object('action','submit-clarification','actor',v_actor,'caseId',p_case_id,'input',p_input)::text);
 SELECT * INTO cmd FROM refund_runtime.commands WHERE tenant_id=p_tenant_id AND refund_runtime.commands.command_id=v_command_id;
 IF FOUND THEN
  IF cmd.actor<>v_actor OR cmd.payload_hash<>v_payload_hash THEN RAISE EXCEPTION 'Command belongs to another decision' USING ERRCODE='23505'; END IF;
  RETURN cmd.result||jsonb_build_object('replayed',true);
 END IF;
 SELECT * INTO c FROM refund_runtime.cases WHERE tenant_id=p_tenant_id AND id=p_case_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Case unavailable' USING ERRCODE='55000'; END IF;
 SELECT * INTO STRICT r FROM refund_runtime.intake_requests WHERE tenant_id=p_tenant_id AND case_id=p_case_id FOR UPDATE;
 IF c.revision<>v_revision THEN RAISE EXCEPTION 'Case revision changed' USING ERRCODE='40001'; END IF;
 IF NOT coalesce(c.status='paused' AND c.stage='review' AND c.outcome='held' AND c.review->>'state'='awaiting-evidence' AND c.approval IS NULL AND c.operation_id IS NULL AND c.receipt IS NULL AND r.status='held' AND (r.lease_until IS NULL OR r.lease_until<=clock_timestamp()),false) THEN RAISE EXCEPTION 'A stopped unapproved evidence hold is required' USING ERRCODE='55000'; END IF;
 IF (SELECT count(*) FROM refund_runtime.evidence_submissions WHERE tenant_id=p_tenant_id AND case_id=p_case_id)>=10 THEN RAISE EXCEPTION 'Clarification limit reached' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM refund_runtime.order_lines WHERE tenant_id=p_tenant_id AND order_id=c.order_id AND id=p_input->>'lineId') THEN RAISE EXCEPTION 'Choose an existing item on this case order' USING ERRCODE='22023'; END IF;
 v_previous:=jsonb_build_object('revision',c.revision,'proposal',c.proposal,'checks',c.checks,'fingerprint',c.fingerprint,'review',c.review,'evidence',refund_runtime.evidence_json(p_tenant_id,c.id),'previousFence',r.fence,'previousAttempts',r.attempts);
 v_submission_id:=gen_random_uuid();
 INSERT INTO refund_runtime.evidence_submissions VALUES(p_tenant_id,v_submission_id,c.id,v_command_id,'customer-clarification',p_input->>'lineId',p_input->>'customerStatement',p_input->>'sourceReference',p_input->>'note',v_revision,v_actor,clock_timestamp(),v_previous);
 UPDATE refund_runtime.cases SET status='ready',stage='reception',outcome=NULL,review=NULL,proposal=NULL,proposed_amount_minor=0,checks='[]',fingerprint=NULL,revision=refund_runtime.cases.revision+1,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=c.id;
 UPDATE refund_runtime.intake_requests SET status='queued',lease_until=NULL,lease_actor=NULL,fence=fence+1,attempts=0,claimed_revision=NULL,facts_digest=NULL,finished_fence=NULL,proposal_digest=NULL,result=NULL,last_error=NULL,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=r.id;
 PERFORM refund_runtime.record_evidence(p_tenant_id,c.id);
 INSERT INTO refund_runtime.events(tenant_id,case_id,event_type,label,detail,actor,payload) VALUES(p_tenant_id,c.id,'evidence.clarification-recorded','Customer clarification recorded',p_input->>'note',v_actor,jsonb_build_object('submission',refund_runtime.clarification_json(p_tenant_id,v_submission_id),'previousInvestigation',v_previous,'catalogueChanged',false,'originalComplaintChanged',false,'paymentAuthorised',false,'messageSent',false));
 v_result:=jsonb_build_object('submission',refund_runtime.clarification_json(p_tenant_id,v_submission_id),'case',refund_runtime.case_json(p_tenant_id,c.id),'request',refund_runtime.request_json(p_tenant_id,r.id),'replayed',false);
 INSERT INTO refund_runtime.commands VALUES(p_tenant_id,v_command_id,v_actor,v_payload_hash,v_result,clock_timestamp());
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION refund_runtime.clarification_json(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.refund_runtime_evidence_request(uuid,text),public.refund_runtime_submit_clarification(uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.refund_runtime_evidence_request(uuid,text),public.refund_runtime_submit_clarification(uuid,text,jsonb) TO authenticated;
COMMIT;
