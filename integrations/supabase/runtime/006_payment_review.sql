-- Read-only reviewer context for the prepared Stripe test authorisation screen.
-- Requires 001, 002 and 004. Does not grant submission rights or alter a case.
BEGIN;
CREATE FUNCTION public.refund_runtime_payment_authorisation_context(p_tenant_id uuid,p_case_id text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE c refund_runtime.cases; o refund_runtime.operations; a refund_runtime.approvals; e refund_runtime.payment_executions;
 v_binding jsonb:=NULL; v_execution jsonb:=NULL; v_eligible boolean:=false; v_reason text:='Approve the recommendation before authorising a test payment.'; v_facts jsonb;
BEGIN
 PERFORM refund_runtime.require_member(p_tenant_id,ARRAY['reviewer']);
 IF p_case_id IS NULL OR p_case_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$' THEN RAISE EXCEPTION 'Invalid case identity' USING ERRCODE='22023'; END IF;
 SELECT * INTO c FROM refund_runtime.cases WHERE tenant_id=p_tenant_id AND id=p_case_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Case unavailable' USING ERRCODE='55000'; END IF;
 IF (SELECT count(*) FROM refund_runtime.payment_executions WHERE tenant_id=p_tenant_id AND case_id=p_case_id)>1 THEN RAISE EXCEPTION 'Ambiguous saved execution requires inspection' USING ERRCODE='55000'; END IF;
 SELECT * INTO e FROM refund_runtime.payment_executions WHERE tenant_id=p_tenant_id AND case_id=p_case_id;
 IF FOUND THEN
  SELECT * INTO STRICT o FROM refund_runtime.operations WHERE tenant_id=p_tenant_id AND id=e.operation_id;
  SELECT * INTO STRICT a FROM refund_runtime.approvals WHERE tenant_id=p_tenant_id AND id=e.original_approval_id;
  v_execution:=refund_runtime.payment_execution_json(p_tenant_id,e.id);
  v_reason:='A test execution is already saved for this case.';
 ELSE
  SELECT * INTO o FROM refund_runtime.operations WHERE tenant_id=p_tenant_id AND id=c.operation_id AND case_id=c.id AND NOT seeded AND status='reserved' AND provider='local-disabled' AND NOT submission_enabled AND receipt IS NULL;
  IF FOUND THEN
   SELECT * INTO STRICT a FROM refund_runtime.approvals WHERE tenant_id=p_tenant_id AND id=o.approval_id;
   v_facts:=refund_runtime.payment_original_facts(p_tenant_id,o.id);
   v_eligible:=coalesce(c.status='paused' AND c.stage='payments' AND c.outcome='approved-not-submitted' AND c.receipt IS NULL AND c.operation_id=o.id AND c.approval->>'id'=a.id::text AND c.fingerprint=a.fingerprint AND c.proposed_amount_minor=o.amount_minor AND a.amount_minor=o.amount_minor AND a.case_id=c.id AND a.operation_id=o.id AND v_facts=a.snapshot,false);
   v_reason:=CASE WHEN v_eligible THEN NULL ELSE 'The original approval facts changed. Review the case again.' END;
  END IF;
 END IF;
 IF a.id IS NOT NULL THEN
  v_binding:=jsonb_build_object('operationId',o.id,'expectedCaseRevision',coalesce(e.original_case_revision,c.revision),'originalApprovalId',a.id,'originalFingerprint',a.fingerprint,'expectedAmountMinor',o.amount_minor,'orderId',o.order_id,'lineId',o.line_id,'paymentAmountMinor',a.snapshot->'order'->'totalMinor','currency','gbp','originalApprovedAt',a.created_at,'originalApprovedBy',a.actor);
 END IF;
 RETURN jsonb_build_object('tenantId',p_tenant_id,'caseId',c.id,'caseRevision',c.revision,'eligible',v_eligible,'blockedReason',v_reason,'binding',v_binding,'execution',v_execution);
END $$;
REVOKE ALL ON FUNCTION public.refund_runtime_payment_authorisation_context(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.refund_runtime_payment_authorisation_context(uuid,text) TO authenticated;
COMMIT;
