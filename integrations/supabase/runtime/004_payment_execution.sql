-- OPTIONAL prepared Stripe TEST execution. Never applied to the active previews.
-- Original local-disabled operations stay immutable and are never converted.
BEGIN;
ALTER TABLE refund_runtime.memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE refund_runtime.memberships ADD CONSTRAINT memberships_role_check CHECK(role IN ('reviewer','investigator','payment-executor'));
CREATE TABLE refund_runtime.payment_executions (
 tenant_id uuid NOT NULL, id uuid NOT NULL, operation_id text NOT NULL, case_id text NOT NULL,
 original_approval_id uuid NOT NULL, original_fingerprint text NOT NULL, original_facts jsonb NOT NULL,
 original_case_revision bigint NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0),
 mapping jsonb NOT NULL, payload jsonb NOT NULL, payload_digest text NOT NULL,
 idempotency_key text NOT NULL, authorised_by uuid NOT NULL, authorisation_note text NOT NULL,
 authorised_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 status text NOT NULL DEFAULT 'authorised' CHECK(status IN ('authorised','claimed','submitting','uncertain','response-saved','reconciling','pending','succeeded','failed')),
 fence bigint NOT NULL DEFAULT 0, lease_actor uuid, lease_until timestamptz, claim_attempts integer NOT NULL DEFAULT 0 CHECK(claim_attempts BETWEEN 0 AND 3),
 submitted_at timestamptz, refund_id text, provider_response jsonb, receipt jsonb, last_error text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,operation_id), UNIQUE(idempotency_key),
 FOREIGN KEY(tenant_id,operation_id) REFERENCES refund_runtime.operations(tenant_id,id),
 FOREIGN KEY(tenant_id,case_id) REFERENCES refund_runtime.cases(tenant_id,id),
 FOREIGN KEY(tenant_id,original_approval_id) REFERENCES refund_runtime.approvals(tenant_id,id),
 FOREIGN KEY(tenant_id,authorised_by) REFERENCES refund_runtime.memberships(tenant_id,user_id),
 FOREIGN KEY(tenant_id,lease_actor) REFERENCES refund_runtime.memberships(tenant_id,user_id),
 CHECK(refund_id IS NULL OR refund_id ~ '^re_[A-Za-z0-9]{1,100}$'),
 CHECK(status IN ('authorised','claimed') OR submitted_at IS NOT NULL)
);
CREATE UNIQUE INDEX payment_execution_external_remedy ON refund_runtime.payment_executions((mapping->>'accountId'),(mapping->>'paymentIntentId'),(payload->>'lineId'));
CREATE TABLE refund_runtime.payment_execution_commands (
 tenant_id uuid NOT NULL, command_id uuid NOT NULL, actor uuid NOT NULL, payload_hash text NOT NULL, execution_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,command_id), FOREIGN KEY(tenant_id,execution_id) REFERENCES refund_runtime.payment_executions(tenant_id,id),
 FOREIGN KEY(tenant_id,actor) REFERENCES refund_runtime.memberships(tenant_id,user_id)
);
CREATE TABLE refund_runtime.payment_execution_events (
 tenant_id uuid NOT NULL, execution_id uuid NOT NULL, id bigint GENERATED ALWAYS AS IDENTITY,
 at timestamptz NOT NULL DEFAULT clock_timestamp(), actor uuid NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,execution_id) REFERENCES refund_runtime.payment_executions(tenant_id,id),
 FOREIGN KEY(tenant_id,actor) REFERENCES refund_runtime.memberships(tenant_id,user_id)
);
CREATE FUNCTION refund_runtime.payment_reader(p_tenant uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT refund_runtime.is_member(p_tenant) AND EXISTS(SELECT 1 FROM refund_runtime.memberships WHERE tenant_id=p_tenant AND user_id=auth.uid() AND role IN ('reviewer','payment-executor'))
$$;
CREATE FUNCTION refund_runtime.payment_execution_json(p_tenant uuid,p_id uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_build_object('id',e.id,'tenantId',e.tenant_id,'operationId',e.operation_id,'caseId',e.case_id,'originalApproval',to_jsonb(a),'originalOperation',refund_runtime.operation_json(e.tenant_id,e.operation_id),'authorisation',jsonb_build_object('actor',e.authorised_by,'note',e.authorisation_note,'at',e.authorised_at,'caseRevision',e.original_case_revision,'originalFingerprint',e.original_fingerprint),'mapping',e.mapping,'payload',e.payload,'payloadDigest',e.payload_digest,'idempotencyKey',e.idempotency_key,'status',e.status,'fence',e.fence,'leaseActor',e.lease_actor,'leaseUntil',e.lease_until,'submittedAt',e.submitted_at,'refundId',e.refund_id,'receipt',e.receipt,'lastError',e.last_error,'liveVerified',false) FROM refund_runtime.payment_executions e JOIN refund_runtime.approvals a ON a.tenant_id=e.tenant_id AND a.id=e.original_approval_id WHERE e.tenant_id=p_tenant AND e.id=p_id
$$;
CREATE FUNCTION refund_runtime.payment_original_facts(p_tenant uuid,p_operation text) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_set(refund_runtime.context_json(p_tenant,o.case_id,true),'{operations}',coalesce((SELECT jsonb_agg(value ORDER BY value->>'id') FROM jsonb_array_elements(refund_runtime.context_json(p_tenant,o.case_id,true)->'operations') v(value) WHERE value->>'id'<>p_operation),'[]')) FROM refund_runtime.operations o WHERE o.tenant_id=p_tenant AND o.id=p_operation
$$;
CREATE FUNCTION refund_runtime.assert_execution_facts(p_tenant uuid,p_id uuid) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
DECLARE e refund_runtime.payment_executions; c refund_runtime.cases; a refund_runtime.approvals; o refund_runtime.operations;
BEGIN
 SELECT * INTO STRICT e FROM refund_runtime.payment_executions WHERE tenant_id=p_tenant AND id=p_id;
 SELECT * INTO STRICT c FROM refund_runtime.cases WHERE tenant_id=p_tenant AND id=e.case_id;
 SELECT * INTO STRICT a FROM refund_runtime.approvals WHERE tenant_id=p_tenant AND id=e.original_approval_id;
 SELECT * INTO STRICT o FROM refund_runtime.operations WHERE tenant_id=p_tenant AND id=e.operation_id;
 IF c.status IS DISTINCT FROM 'paused' OR c.stage IS DISTINCT FROM 'payments' OR c.outcome IS DISTINCT FROM 'approved-not-submitted' OR c.receipt IS NOT NULL OR c.revision<>e.original_case_revision OR c.operation_id IS DISTINCT FROM o.id OR c.approval->>'id' IS DISTINCT FROM a.id::text OR c.fingerprint IS DISTINCT FROM a.fingerprint OR c.proposed_amount_minor<>e.amount_minor OR a.fingerprint<>e.original_fingerprint OR a.amount_minor<>e.amount_minor OR o.amount_minor<>e.amount_minor OR o.status<>'reserved' OR o.seeded OR o.submission_enabled OR o.provider<>'local-disabled' OR refund_runtime.payment_original_facts(p_tenant,o.id) IS DISTINCT FROM e.original_facts OR e.original_facts IS DISTINCT FROM a.snapshot THEN RAISE EXCEPTION 'Original approval facts changed; execution is blocked' USING ERRCODE='40001'; END IF;
END $$;
CREATE FUNCTION refund_runtime.assert_execution_refund(p_tenant uuid,p_id uuid,p_refund jsonb) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
DECLARE e refund_runtime.payment_executions;
BEGIN
 SELECT * INTO STRICT e FROM refund_runtime.payment_executions WHERE tenant_id=p_tenant AND id=p_id;
 PERFORM refund_runtime.object_shape(p_refund,ARRAY['id','amount','currency','payment_intent','status','metadata'],ARRAY['id','amount','currency','payment_intent','status','metadata']);
 IF p_refund->>'id' IS NULL OR p_refund->>'id' !~ '^re_[A-Za-z0-9]{1,100}$' OR refund_runtime.whole(p_refund->'amount',1,9007199254740991)<>e.amount_minor OR p_refund->>'currency' IS DISTINCT FROM 'gbp' OR p_refund->>'payment_intent' IS DISTINCT FROM e.mapping->>'paymentIntentId' OR coalesce(p_refund->>'status' NOT IN ('succeeded','pending','failed','requires_action','canceled'),true) OR p_refund->'metadata' IS DISTINCT FROM e.payload->'metadata' OR e.refund_id IS NOT NULL AND e.refund_id IS DISTINCT FROM p_refund->>'id' THEN RAISE EXCEPTION 'Refund observation does not match saved execution' USING ERRCODE='22023'; END IF;
END $$;
CREATE FUNCTION public.refund_runtime_authorise_execution(p_tenant_id uuid,p_operation_id text,p_expected_case_revision bigint,p_original_approval_id uuid,p_original_fingerprint text,p_expected_amount_minor bigint,p_mapping jsonb,p_note text,p_command_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_op refund_runtime.operations; v_case refund_runtime.cases; v_approval refund_runtime.approvals; v_command refund_runtime.payment_execution_commands; v_hash text; v_id uuid; v_key text; v_payload jsonb; v_facts jsonb;
BEGIN
 v_actor:=refund_runtime.require_member(p_tenant_id,ARRAY['reviewer']); PERFORM 1 FROM refund_runtime.tenants WHERE id=p_tenant_id FOR UPDATE;
 PERFORM refund_runtime.plain_text(to_jsonb(p_note),10,2000);
 IF p_command_id IS NULL OR p_original_approval_id IS NULL OR p_expected_case_revision IS NULL OR p_expected_amount_minor IS NULL OR p_original_fingerprint IS NULL THEN RAISE EXCEPTION 'Exact original approval facts are required' USING ERRCODE='22023'; END IF;
 PERFORM refund_runtime.object_shape(p_mapping,ARRAY['accountId','paymentIntentId','orderId','paymentAmountMinor','currency','livemode'],ARRAY['accountId','paymentIntentId','orderId','paymentAmountMinor','currency','livemode']);
 IF p_mapping->>'accountId' IS NULL OR p_mapping->>'accountId' !~ '^acct_[A-Za-z0-9]{1,100}$' OR p_mapping->>'paymentIntentId' IS NULL OR p_mapping->>'paymentIntentId' !~ '^pi_[A-Za-z0-9]{1,100}$' OR p_mapping->>'currency' IS DISTINCT FROM 'gbp' OR p_mapping->'livemode' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'Explicit Stripe test mapping required' USING ERRCODE='22023'; END IF;
 PERFORM refund_runtime.whole(p_mapping->'paymentAmountMinor',1,9007199254740991);
 v_hash:=refund_runtime.hash_text(jsonb_build_object('operationId',p_operation_id,'caseRevision',p_expected_case_revision,'approvalId',p_original_approval_id,'fingerprint',p_original_fingerprint,'amountMinor',p_expected_amount_minor,'mapping',p_mapping,'note',p_note,'actor',v_actor)::text);
 SELECT * INTO v_command FROM refund_runtime.payment_execution_commands WHERE tenant_id=p_tenant_id AND command_id=p_command_id;
 IF FOUND THEN
  IF v_command.actor<>v_actor OR v_command.payload_hash<>v_hash THEN RAISE EXCEPTION 'Execution command binds another decision' USING ERRCODE='23505'; END IF;
  RETURN refund_runtime.payment_execution_json(p_tenant_id,v_command.execution_id);
 END IF;
 SELECT * INTO v_op FROM refund_runtime.operations WHERE tenant_id=p_tenant_id AND id=p_operation_id;
 IF NOT FOUND OR v_op.seeded OR v_op.status<>'reserved' OR v_op.provider<>'local-disabled' OR v_op.submission_enabled OR v_op.approval_id IS DISTINCT FROM p_original_approval_id THEN RAISE EXCEPTION 'A matching original disabled reservation is required' USING ERRCODE='55000'; END IF;
 SELECT * INTO STRICT v_case FROM refund_runtime.cases WHERE tenant_id=p_tenant_id AND id=v_op.case_id;
 SELECT * INTO STRICT v_approval FROM refund_runtime.approvals WHERE tenant_id=p_tenant_id AND id=v_op.approval_id;
 v_facts:=refund_runtime.payment_original_facts(p_tenant_id,v_op.id);
 IF v_case.revision<>p_expected_case_revision OR v_case.operation_id IS DISTINCT FROM v_op.id OR v_case.approval->>'id' IS DISTINCT FROM v_approval.id::text OR v_approval.fingerprint<>p_original_fingerprint OR v_op.amount_minor<>p_expected_amount_minor OR v_approval.amount_minor<>p_expected_amount_minor OR v_facts IS DISTINCT FROM v_approval.snapshot OR p_mapping->>'orderId' IS DISTINCT FROM v_op.order_id OR (p_mapping->>'paymentAmountMinor')::bigint IS DISTINCT FROM (v_approval.snapshot->'order'->>'totalMinor')::bigint THEN RAISE EXCEPTION 'Original approval, amount or mapping is stale or mismatched' USING ERRCODE='40001'; END IF;
 v_id:=gen_random_uuid(); v_key:='refund-office-stripe-test-'||v_id::text;
 v_payload:=jsonb_build_object('executionId',v_id,'operationId',v_op.id,'orderId',v_op.order_id,'lineId',v_op.line_id,'issue',v_op.issue,'amountMinor',v_op.amount_minor,'currency','gbp','accountId',p_mapping->>'accountId','paymentIntentId',p_mapping->>'paymentIntentId','paymentAmountMinor',p_mapping->'paymentAmountMinor','idempotencyKey',v_key,'metadata',jsonb_build_object('runtime_execution_id',v_id,'refund_office_operation_id',v_op.id,'refund_office_order_id',v_op.order_id,'refund_office_tenant_id',p_tenant_id));
 INSERT INTO refund_runtime.payment_executions(tenant_id,id,operation_id,case_id,original_approval_id,original_fingerprint,original_facts,original_case_revision,amount_minor,mapping,payload,payload_digest,idempotency_key,authorised_by,authorisation_note) VALUES(p_tenant_id,v_id,v_op.id,v_case.id,v_approval.id,v_approval.fingerprint,v_facts,v_case.revision,v_op.amount_minor,p_mapping,v_payload,refund_runtime.hash_text(v_payload::text),v_key,v_actor,p_note);
 PERFORM refund_runtime.assert_execution_facts(p_tenant_id,v_id);
 INSERT INTO refund_runtime.payment_execution_commands VALUES(p_tenant_id,p_command_id,v_actor,v_hash,v_id);
 INSERT INTO refund_runtime.payment_execution_events(tenant_id,execution_id,actor,event_type,payload) VALUES(p_tenant_id,v_id,v_actor,'execution.authorised',jsonb_build_object('mapping',p_mapping,'originalApprovalId',v_approval.id,'amountMinor',v_op.amount_minor,'originalOperationUnchanged',true));
 RETURN refund_runtime.payment_execution_json(p_tenant_id,v_id);
END $$;
CREATE FUNCTION public.refund_runtime_read_execution(p_tenant_id uuid,p_execution_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result jsonb;
BEGIN
 PERFORM refund_runtime.require_member(p_tenant_id,ARRAY['reviewer','payment-executor']); v_result:=refund_runtime.payment_execution_json(p_tenant_id,p_execution_id);
 IF v_result IS NULL THEN RAISE EXCEPTION 'Execution unavailable' USING ERRCODE='55000'; END IF; RETURN v_result;
END $$;
CREATE FUNCTION public.refund_runtime_claim_execution(p_tenant_id uuid,p_execution_id uuid,p_lease_seconds integer DEFAULT 30) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; e refund_runtime.payment_executions;
BEGIN
 v_actor:=refund_runtime.require_member(p_tenant_id,ARRAY['payment-executor']); PERFORM 1 FROM refund_runtime.tenants WHERE id=p_tenant_id FOR UPDATE;
 IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 120 THEN RAISE EXCEPTION 'Invalid lease' USING ERRCODE='22023'; END IF;
 SELECT * INTO e FROM refund_runtime.payment_executions WHERE tenant_id=p_tenant_id AND id=p_execution_id FOR UPDATE;
 IF NOT FOUND OR e.submitted_at IS NOT NULL OR e.claim_attempts>=3 OR NOT coalesce(e.status='authorised' OR e.status='claimed' AND e.lease_until<=clock_timestamp(),false) THEN RAISE EXCEPTION 'Execution cannot be submitted or reclaimed' USING ERRCODE='55000'; END IF;
 PERFORM refund_runtime.assert_execution_facts(p_tenant_id,p_execution_id);
 UPDATE refund_runtime.payment_executions SET status='claimed',fence=fence+1,lease_actor=v_actor,lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),claim_attempts=claim_attempts+1,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=p_execution_id;
 INSERT INTO refund_runtime.payment_execution_events(tenant_id,execution_id,actor,event_type,payload) VALUES(p_tenant_id,p_execution_id,v_actor,'execution.claimed','{}');
 RETURN refund_runtime.payment_execution_json(p_tenant_id,p_execution_id);
END $$;
CREATE FUNCTION public.refund_runtime_begin_submission(p_tenant_id uuid,p_execution_id uuid,p_fence bigint,p_payload_digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; e refund_runtime.payment_executions;
BEGIN
 v_actor:=refund_runtime.require_member(p_tenant_id,ARRAY['payment-executor']); PERFORM 1 FROM refund_runtime.tenants WHERE id=p_tenant_id FOR UPDATE;
 SELECT * INTO e FROM refund_runtime.payment_executions WHERE tenant_id=p_tenant_id AND id=p_execution_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Execution unavailable' USING ERRCODE='55000'; END IF;
 IF e.fence IS DISTINCT FROM p_fence OR e.lease_actor IS DISTINCT FROM v_actor OR e.lease_until IS NULL OR e.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'Stale execution lease' USING ERRCODE='40001'; END IF;
 IF e.status<>'claimed' OR e.submitted_at IS NOT NULL OR e.payload_digest IS DISTINCT FROM p_payload_digest THEN RAISE EXCEPTION 'Submission intent cannot be reused' USING ERRCODE='55000'; END IF;
 PERFORM refund_runtime.assert_execution_facts(p_tenant_id,p_execution_id);
 UPDATE refund_runtime.payment_executions SET status='submitting',submitted_at=clock_timestamp(),lease_until=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=p_execution_id;
 INSERT INTO refund_runtime.payment_execution_events(tenant_id,execution_id,actor,event_type,payload) VALUES(p_tenant_id,p_execution_id,v_actor,'submission.intent_saved',jsonb_build_object('payloadDigest',e.payload_digest,'idempotencyKey',e.idempotency_key,'fence',p_fence));
 RETURN refund_runtime.payment_execution_json(p_tenant_id,p_execution_id);
END $$;
CREATE FUNCTION public.refund_runtime_save_refund_reference(p_tenant_id uuid,p_execution_id uuid,p_fence bigint,p_refund jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; e refund_runtime.payment_executions;
BEGIN
 v_actor:=refund_runtime.require_member(p_tenant_id,ARRAY['payment-executor']); PERFORM 1 FROM refund_runtime.tenants WHERE id=p_tenant_id FOR UPDATE;
 SELECT * INTO e FROM refund_runtime.payment_executions WHERE tenant_id=p_tenant_id AND id=p_execution_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Execution unavailable' USING ERRCODE='55000'; END IF;
 IF e.fence IS DISTINCT FROM p_fence OR e.lease_actor IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'Stale execution actor or fence' USING ERRCODE='40001'; END IF;
 IF e.submitted_at IS NULL OR e.status NOT IN ('submitting','uncertain','response-saved') THEN RAISE EXCEPTION 'No submission intent awaits this response' USING ERRCODE='55000'; END IF;
 PERFORM refund_runtime.assert_execution_refund(p_tenant_id,p_execution_id,p_refund);
 IF e.provider_response IS NOT NULL AND e.provider_response IS DISTINCT FROM p_refund THEN RAISE EXCEPTION 'Original provider response is already saved' USING ERRCODE='23505'; END IF;
 UPDATE refund_runtime.payment_executions SET status='response-saved',refund_id=p_refund->>'id',provider_response=p_refund,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=p_execution_id;
 INSERT INTO refund_runtime.payment_execution_events(tenant_id,execution_id,actor,event_type,payload) VALUES(p_tenant_id,p_execution_id,v_actor,'submission.response_saved',jsonb_build_object('refundId',p_refund->>'id','independentlyVerified',false));
 RETURN refund_runtime.payment_execution_json(p_tenant_id,p_execution_id);
END $$;
CREATE FUNCTION public.refund_runtime_note_execution_unknown(p_tenant_id uuid,p_execution_id uuid,p_fence bigint,p_error_code text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; e refund_runtime.payment_executions;
BEGIN
 v_actor:=refund_runtime.require_member(p_tenant_id,ARRAY['payment-executor']); PERFORM 1 FROM refund_runtime.tenants WHERE id=p_tenant_id FOR UPDATE;
 IF p_error_code IS NULL OR p_error_code !~ '^[a-z][a-z0-9_]{0,79}$' THEN RAISE EXCEPTION 'Bounded error code required' USING ERRCODE='22023'; END IF;
 SELECT * INTO e FROM refund_runtime.payment_executions WHERE tenant_id=p_tenant_id AND id=p_execution_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Execution unavailable' USING ERRCODE='55000'; END IF;
 IF e.fence IS DISTINCT FROM p_fence OR e.lease_actor IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'Stale execution actor or fence' USING ERRCODE='40001'; END IF;
 IF e.submitted_at IS NULL OR e.status NOT IN ('submitting','response-saved','uncertain','reconciling','pending') THEN RAISE EXCEPTION 'Execution is not unresolved' USING ERRCODE='55000'; END IF;
 UPDATE refund_runtime.payment_executions SET status='uncertain',last_error=p_error_code,lease_until=NULL,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=p_execution_id;
 INSERT INTO refund_runtime.payment_execution_events(tenant_id,execution_id,actor,event_type,payload) VALUES(p_tenant_id,p_execution_id,v_actor,'execution.uncertain',jsonb_build_object('errorCode',p_error_code,'knownRefundId',e.refund_id,'retryPostAllowed',false));
 RETURN refund_runtime.payment_execution_json(p_tenant_id,p_execution_id);
END $$;
CREATE FUNCTION public.refund_runtime_claim_reconciliation(p_tenant_id uuid,p_execution_id uuid,p_lease_seconds integer DEFAULT 30) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; e refund_runtime.payment_executions;
BEGIN
 v_actor:=refund_runtime.require_member(p_tenant_id,ARRAY['payment-executor']); PERFORM 1 FROM refund_runtime.tenants WHERE id=p_tenant_id FOR UPDATE;
 IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 120 THEN RAISE EXCEPTION 'Invalid reconciliation lease' USING ERRCODE='22023'; END IF;
 SELECT * INTO e FROM refund_runtime.payment_executions WHERE tenant_id=p_tenant_id AND id=p_execution_id FOR UPDATE;
 IF NOT FOUND OR e.submitted_at IS NULL OR e.refund_id IS NULL OR e.status NOT IN ('response-saved','uncertain','pending','reconciling') OR coalesce(e.lease_until>clock_timestamp(),false) THEN RAISE EXCEPTION 'A saved refund identity and available lease are required; receiptless retries are forbidden' USING ERRCODE='55000'; END IF;
 UPDATE refund_runtime.payment_executions SET status='reconciling',fence=fence+1,lease_actor=v_actor,lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=p_execution_id;
 INSERT INTO refund_runtime.payment_execution_events(tenant_id,execution_id,actor,event_type,payload) VALUES(p_tenant_id,p_execution_id,v_actor,'execution.reconciliation_claimed',jsonb_build_object('refundId',e.refund_id,'providerPostAllowed',false));
 RETURN refund_runtime.payment_execution_json(p_tenant_id,p_execution_id);
END $$;
CREATE FUNCTION public.refund_runtime_record_refund_readback(p_tenant_id uuid,p_execution_id uuid,p_fence bigint,p_refund jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; e refund_runtime.payment_executions;
BEGIN
 v_actor:=refund_runtime.require_member(p_tenant_id,ARRAY['payment-executor']); PERFORM 1 FROM refund_runtime.tenants WHERE id=p_tenant_id FOR UPDATE;
 SELECT * INTO e FROM refund_runtime.payment_executions WHERE tenant_id=p_tenant_id AND id=p_execution_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Execution unavailable' USING ERRCODE='55000'; END IF;
 IF e.fence IS DISTINCT FROM p_fence OR e.lease_actor IS DISTINCT FROM v_actor OR e.lease_until IS NULL OR e.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'Stale readback lease' USING ERRCODE='40001'; END IF;
 IF e.submitted_at IS NULL OR e.refund_id IS NULL OR e.status NOT IN ('response-saved','reconciling') THEN RAISE EXCEPTION 'Independent retrieval requires a saved response identity' USING ERRCODE='55000'; END IF;
 PERFORM refund_runtime.assert_execution_refund(p_tenant_id,p_execution_id,p_refund);
 UPDATE refund_runtime.payment_executions SET status=CASE p_refund->>'status' WHEN 'succeeded' THEN 'succeeded' WHEN 'failed' THEN 'failed' WHEN 'canceled' THEN 'failed' ELSE 'pending' END,receipt=p_refund,last_error=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=p_execution_id;
 INSERT INTO refund_runtime.payment_execution_events(tenant_id,execution_id,actor,event_type,payload) VALUES(p_tenant_id,p_execution_id,v_actor,'execution.readback_recorded',jsonb_build_object('refundId',p_refund->>'id','status',p_refund->>'status','verification','trusted-executor-independent-readback'));
 RETURN refund_runtime.payment_execution_json(p_tenant_id,p_execution_id);
END $$;
CREATE FUNCTION refund_runtime.protect_execution_intent() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Execution history cannot be deleted' USING ERRCODE='55000'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','fence','lease_actor','lease_until','claim_attempts','submitted_at','refund_id','provider_response','receipt','last_error','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','fence','lease_actor','lease_until','claim_attempts','submitted_at','refund_id','provider_response','receipt','last_error','updated_at']) OR OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR OLD.refund_id IS NOT NULL AND NEW.refund_id IS DISTINCT FROM OLD.refund_id OR OLD.provider_response IS NOT NULL AND NEW.provider_response IS DISTINCT FROM OLD.provider_response OR OLD.status IN ('succeeded','failed') THEN RAISE EXCEPTION 'Original authorisation and submission intent are immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_execution_intent BEFORE UPDATE OR DELETE ON refund_runtime.payment_executions FOR EACH ROW EXECUTE FUNCTION refund_runtime.protect_execution_intent();
CREATE TRIGGER immutable_execution_commands BEFORE UPDATE OR DELETE ON refund_runtime.payment_execution_commands FOR EACH ROW EXECUTE FUNCTION refund_runtime.reject_change();
CREATE TRIGGER immutable_execution_events BEFORE UPDATE OR DELETE ON refund_runtime.payment_execution_events FOR EACH ROW EXECUTE FUNCTION refund_runtime.reject_change();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['payment_executions','payment_execution_commands','payment_execution_events'] LOOP
  EXECUTE format('ALTER TABLE refund_runtime.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY payment_tenant_read ON refund_runtime.%I FOR SELECT TO authenticated USING (refund_runtime.payment_reader(tenant_id))',t);
  EXECUTE format('REVOKE ALL ON refund_runtime.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('GRANT SELECT ON refund_runtime.%I TO authenticated',t);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION refund_runtime.payment_reader(uuid),refund_runtime.payment_execution_json(uuid,uuid),refund_runtime.payment_original_facts(uuid,text),refund_runtime.assert_execution_facts(uuid,uuid),refund_runtime.assert_execution_refund(uuid,uuid,jsonb),refund_runtime.protect_execution_intent() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION refund_runtime.payment_reader(uuid) TO authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA refund_runtime FROM PUBLIC,anon,authenticated,service_role;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('refund_runtime_authorise_execution','refund_runtime_read_execution','refund_runtime_claim_execution','refund_runtime_begin_submission','refund_runtime_save_refund_reference','refund_runtime_note_execution_unknown','refund_runtime_claim_reconciliation','refund_runtime_record_refund_readback') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f.signature);
 END LOOP;
END $$;
COMMIT;
