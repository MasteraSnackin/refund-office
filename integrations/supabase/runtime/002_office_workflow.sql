-- Add recorded review and explicit failed-investigation recovery.
-- The frozen first migration and payment-disabled operation rules are unchanged.
BEGIN;
ALTER TABLE refund_runtime.cases ADD COLUMN review jsonb;
CREATE OR REPLACE FUNCTION refund_runtime.case_json(p_tenant uuid,p_case text) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_build_object('id',c.id,'caseId',c.case_label,'orderId',c.order_id,'title',c.title,'shortTitle',c.short_title,'complaint',c.complaint,'revision',c.revision,'status',c.status,'stage',c.stage,'outcome',c.outcome,'orderTotalMinor',o.total_minor,'proposedAmountMinor',c.proposed_amount_minor,'proposal',c.proposal,'checks',c.checks,'fingerprint',c.fingerprint,'fingerprintScheme','postgres-jsonb-v1','approval',c.approval,'review',c.review,'receipt',c.receipt,'operationId',c.operation_id,'evidence',refund_runtime.evidence_json(p_tenant,p_case),'intakeManaged',true,'intakeRequestId',(SELECT id FROM refund_runtime.intake_requests WHERE tenant_id=p_tenant AND case_id=p_case),'events',coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'at',e.at,'type',e.event_type,'label',e.label,'detail',e.detail,'actor',e.actor,'payload',e.payload) ORDER BY e.id) FROM refund_runtime.events e WHERE e.tenant_id=p_tenant AND e.case_id=p_case),'[]')) FROM refund_runtime.cases c JOIN refund_runtime.orders o ON o.tenant_id=c.tenant_id AND o.id=c.order_id WHERE c.tenant_id=p_tenant AND c.id=p_case
$$;

CREATE FUNCTION public.refund_runtime_review_case(p_tenant_id uuid,p_case_id text,p_expected_revision bigint,p_action text,p_note text,p_command_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_case refund_runtime.cases; v_command refund_runtime.commands; v_hash text; v_review jsonb; v_result jsonb;
BEGIN
 v_actor:=refund_runtime.require_member(p_tenant_id,ARRAY['reviewer']);
 PERFORM 1 FROM refund_runtime.tenants WHERE id=p_tenant_id FOR UPDATE;
 PERFORM refund_runtime.plain_text(to_jsonb(p_note),10,2000);
 IF p_command_id IS NULL OR p_expected_revision IS NULL OR coalesce(p_action NOT IN ('request-evidence','close-no-refund','reopen'),true) THEN RAISE EXCEPTION 'Invalid review action' USING ERRCODE='22023'; END IF;
 v_hash:=refund_runtime.hash_text(jsonb_build_object('kind','review','actor',v_actor,'caseId',p_case_id,'revision',p_expected_revision,'action',p_action,'note',p_note)::text);
 SELECT * INTO v_command FROM refund_runtime.commands WHERE tenant_id=p_tenant_id AND command_id=p_command_id;
 IF FOUND THEN
  IF v_command.actor<>v_actor OR v_command.payload_hash<>v_hash THEN RAISE EXCEPTION 'Command identity already binds another decision' USING ERRCODE='23505'; END IF;
  RETURN v_command.result;
 END IF;
 SELECT * INTO v_case FROM refund_runtime.cases WHERE tenant_id=p_tenant_id AND id=p_case_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Case unavailable' USING ERRCODE='55000'; END IF;
 IF v_case.revision<>p_expected_revision THEN RAISE EXCEPTION 'Case revision changed' USING ERRCODE='40001'; END IF;
 IF v_case.approval IS NOT NULL OR v_case.operation_id IS NOT NULL OR v_case.receipt IS NOT NULL THEN RAISE EXCEPTION 'Review cannot change a reserved or historical operation' USING ERRCODE='55000'; END IF;
 IF (p_action='reopen' AND NOT coalesce(((v_case.status='complete' AND v_case.outcome='closed-no-refund') OR (v_case.status='paused' AND v_case.stage='review' AND v_case.review->>'state'='awaiting-evidence')),false)) OR (p_action<>'reopen' AND (v_case.status<>'paused' OR v_case.stage<>'review' OR v_case.outcome NOT IN ('held','awaiting-approval'))) THEN RAISE EXCEPTION 'Case is not at the required review stage' USING ERRCODE='55000'; END IF;
 v_review:=jsonb_build_object('state',CASE p_action WHEN 'request-evidence' THEN 'awaiting-evidence' WHEN 'close-no-refund' THEN 'closed' ELSE 'reopened' END,'action',p_action,'note',p_note,'actor',v_actor,'decidedAt',clock_timestamp());
 UPDATE refund_runtime.cases SET status=CASE WHEN p_action='close-no-refund' THEN 'complete' ELSE 'paused' END,stage=CASE WHEN p_action='close-no-refund' THEN 'archive' ELSE 'review' END,outcome=CASE WHEN p_action='close-no-refund' THEN 'closed-no-refund' ELSE 'held' END,review=v_review,fingerprint=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=p_case_id;
 UPDATE refund_runtime.intake_requests SET status='held',lease_until=NULL,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND case_id=p_case_id;
 INSERT INTO refund_runtime.events(tenant_id,case_id,event_type,label,detail,actor,payload) VALUES(p_tenant_id,p_case_id,'review.'||p_action,CASE p_action WHEN 'request-evidence' THEN 'Evidence request recorded' WHEN 'close-no-refund' THEN 'Closed without refund' ELSE 'Review reopened' END,p_note,v_actor,jsonb_build_object('action',p_action,'previousRevision',v_case.revision,'previousFingerprint',v_case.fingerprint,'messageSent',false,'paymentAuthorised',false));
 v_result:=refund_runtime.case_json(p_tenant_id,p_case_id);
 INSERT INTO refund_runtime.commands(tenant_id,command_id,actor,payload_hash,result) VALUES(p_tenant_id,p_command_id,v_actor,v_hash,v_result);
 RETURN v_result;
END $$;
CREATE FUNCTION public.refund_runtime_recover_intake(p_tenant_id uuid,p_request_id text,p_expected_revision bigint,p_note text,p_command_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_request refund_runtime.intake_requests; v_case refund_runtime.cases; v_command refund_runtime.commands; v_hash text; v_result jsonb; v_previous jsonb;
BEGIN
 v_actor:=refund_runtime.require_member(p_tenant_id,ARRAY['investigator']);
 PERFORM 1 FROM refund_runtime.tenants WHERE id=p_tenant_id FOR UPDATE;
 PERFORM refund_runtime.plain_text(to_jsonb(p_note),10,2000);
 IF p_command_id IS NULL OR p_expected_revision IS NULL THEN RAISE EXCEPTION 'Recovery requires exact saved facts and identity' USING ERRCODE='22023'; END IF;
 v_hash:=refund_runtime.hash_text(jsonb_build_object('kind','recover','actor',v_actor,'requestId',p_request_id,'revision',p_expected_revision,'note',p_note)::text);
 SELECT * INTO v_command FROM refund_runtime.commands WHERE tenant_id=p_tenant_id AND command_id=p_command_id;
 IF FOUND THEN
  IF v_command.actor<>v_actor OR v_command.payload_hash<>v_hash THEN RAISE EXCEPTION 'Command identity already binds another recovery' USING ERRCODE='23505'; END IF;
  RETURN v_command.result||jsonb_build_object('replayed',true);
 END IF;
 SELECT * INTO v_request FROM refund_runtime.intake_requests WHERE tenant_id=p_tenant_id AND id=p_request_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Request unavailable' USING ERRCODE='55000'; END IF;
 SELECT * INTO STRICT v_case FROM refund_runtime.cases WHERE tenant_id=p_tenant_id AND id=v_request.case_id FOR UPDATE;
 IF v_case.revision<>p_expected_revision THEN RAISE EXCEPTION 'Case revision changed' USING ERRCODE='40001'; END IF;
 IF v_case.review->>'state'='awaiting-evidence' THEN RAISE EXCEPTION 'A reviewer must explicitly reopen the evidence hold first' USING ERRCODE='55000'; END IF;
 IF v_request.status NOT IN ('held','error') OR v_case.status<>'paused' OR v_case.stage<>'review' OR v_case.outcome IS DISTINCT FROM 'held' OR v_case.approval IS NOT NULL OR v_case.operation_id IS NOT NULL OR v_case.receipt IS NOT NULL OR v_request.lease_until>clock_timestamp() THEN RAISE EXCEPTION 'Only a stopped unapproved investigation can be recovered' USING ERRCODE='55000'; END IF;
 v_previous:=jsonb_build_object('revision',v_case.revision,'proposal',v_case.proposal,'checks',v_case.checks,'fingerprint',v_case.fingerprint,'review',v_case.review,'evidence',refund_runtime.evidence_json(p_tenant_id,v_case.id),'previousFence',v_request.fence,'previousAttempts',v_request.attempts);
 UPDATE refund_runtime.cases SET status='ready',stage='reception',outcome=NULL,review=NULL,proposal=NULL,proposed_amount_minor=0,checks='[]',fingerprint=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=v_case.id;
 UPDATE refund_runtime.intake_requests SET status='queued',lease_until=NULL,lease_actor=NULL,fence=fence+1,attempts=0,claimed_revision=NULL,facts_digest=NULL,finished_fence=NULL,proposal_digest=NULL,result=NULL,last_error=NULL,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=p_request_id;
 INSERT INTO refund_runtime.events(tenant_id,case_id,event_type,label,detail,actor,payload) VALUES(p_tenant_id,v_case.id,'intake.recovered','Investigation requeued',p_note,v_actor,jsonb_build_object('previousInvestigation',v_previous,'paymentAuthorised',false));
 v_result:=jsonb_build_object('request',refund_runtime.request_json(p_tenant_id,p_request_id),'case',refund_runtime.case_json(p_tenant_id,v_case.id),'replayed',false);
 INSERT INTO refund_runtime.commands(tenant_id,command_id,actor,payload_hash,result) VALUES(p_tenant_id,p_command_id,v_actor,v_hash,v_result);
 RETURN v_result;
END $$;
CREATE FUNCTION public.refund_runtime_fail_intake(p_tenant_id uuid,p_request_id text,p_fence bigint,p_error_code text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_request refund_runtime.intake_requests; v_case refund_runtime.cases;
BEGIN
 v_actor:=refund_runtime.require_member(p_tenant_id,ARRAY['investigator']);
 PERFORM 1 FROM refund_runtime.tenants WHERE id=p_tenant_id FOR UPDATE;
 IF p_error_code IS NULL OR p_error_code !~ '^[a-z][a-z0-9_]{0,79}$' THEN RAISE EXCEPTION 'Bounded error code required' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_request FROM refund_runtime.intake_requests WHERE tenant_id=p_tenant_id AND id=p_request_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Request unavailable' USING ERRCODE='55000'; END IF;
 IF v_request.lease_actor IS DISTINCT FROM v_actor OR v_request.fence IS DISTINCT FROM p_fence THEN RAISE EXCEPTION 'Claim actor or fence changed' USING ERRCODE='40001'; END IF;
 IF v_request.status='error' AND v_request.last_error=p_error_code THEN RETURN jsonb_build_object('request',refund_runtime.request_json(p_tenant_id,p_request_id),'case',refund_runtime.case_json(p_tenant_id,v_request.case_id)); END IF;
 SELECT * INTO STRICT v_case FROM refund_runtime.cases WHERE tenant_id=p_tenant_id AND id=v_request.case_id FOR UPDATE;
 IF v_request.status<>'running' OR v_request.lease_until IS NULL OR v_request.lease_until<=clock_timestamp() OR v_case.revision<>v_request.claimed_revision OR v_case.status<>'running' OR v_case.stage<>'policy' OR v_case.approval IS NOT NULL OR v_case.operation_id IS NOT NULL OR v_case.receipt IS NOT NULL THEN RAISE EXCEPTION 'Active claim is no longer owned' USING ERRCODE='40001'; END IF;
 UPDATE refund_runtime.cases SET status='paused',stage='review',outcome='held',fingerprint=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=v_case.id;
 UPDATE refund_runtime.intake_requests SET status='error',last_error=p_error_code,lease_until=NULL,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=p_request_id;
 INSERT INTO refund_runtime.events(tenant_id,case_id,event_type,label,detail,actor,payload) VALUES(p_tenant_id,v_case.id,'intake.failed','Investigation stopped','A local investigation failed. An investigator must inspect and explicitly recover this case.',v_actor,jsonb_build_object('errorCode',p_error_code,'fence',p_fence));
 RETURN jsonb_build_object('request',refund_runtime.request_json(p_tenant_id,p_request_id),'case',refund_runtime.case_json(p_tenant_id,v_case.id));
END $$;
REVOKE ALL ON FUNCTION public.refund_runtime_review_case(uuid,text,bigint,text,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.refund_runtime_recover_intake(uuid,text,bigint,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.refund_runtime_fail_intake(uuid,text,bigint,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.refund_runtime_review_case(uuid,text,bigint,text,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refund_runtime_recover_intake(uuid,text,bigint,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refund_runtime_fail_intake(uuid,text,bigint,text) TO authenticated;
COMMIT;
