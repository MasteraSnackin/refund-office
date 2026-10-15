-- Synthetic operational runtime. Run as the administrative migration owner.
-- This intentionally exposes no payment submission or settlement function.
BEGIN;
CREATE SCHEMA refund_runtime;
REVOKE ALL ON SCHEMA refund_runtime FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA refund_runtime TO authenticated;

CREATE TABLE refund_runtime.tenants (
 id uuid PRIMARY KEY, title text NOT NULL, synthetic boolean NOT NULL DEFAULT true CHECK(synthetic),
 dataset_id text NOT NULL CHECK(dataset_id IN ('focused-12','busy-50')),
 dataset_digest text NOT NULL CHECK(dataset_digest ~ '^[a-f0-9]{64}$'), dataset jsonb NOT NULL,
 current_policy_version bigint NOT NULL DEFAULT 1, next_case_number bigint NOT NULL DEFAULT 10000,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE refund_runtime.memberships (
 tenant_id uuid NOT NULL REFERENCES refund_runtime.tenants(id), user_id uuid NOT NULL REFERENCES auth.users(id),
 role text NOT NULL CHECK(role IN ('investigator','reviewer')), PRIMARY KEY(tenant_id,user_id)
);
CREATE TABLE refund_runtime.orders (
 tenant_id uuid NOT NULL REFERENCES refund_runtime.tenants(id), id text NOT NULL,
 total_minor bigint NOT NULL CHECK(total_minor BETWEEN 1 AND 9007199254740991),
 currency text NOT NULL CHECK(currency='gbp'), synthetic boolean NOT NULL CHECK(synthetic),
 data jsonb NOT NULL, revision bigint NOT NULL DEFAULT 1, PRIMARY KEY(tenant_id,id)
);
CREATE TABLE refund_runtime.order_lines (
 tenant_id uuid NOT NULL, order_id text NOT NULL, id text NOT NULL, name text NOT NULL,
 unit_amount_minor bigint NOT NULL CHECK(unit_amount_minor BETWEEN 1 AND 9007199254740991),
 ordered integer NOT NULL CHECK(ordered BETWEEN 1 AND 100), packed integer NOT NULL CHECK(packed BETWEEN 0 AND ordered),
 PRIMARY KEY(tenant_id,order_id,id), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES refund_runtime.orders(tenant_id,id)
);
CREATE TABLE refund_runtime.policies (
 tenant_id uuid NOT NULL REFERENCES refund_runtime.tenants(id), version bigint NOT NULL CHECK(version>0),
 limit_minor bigint NOT NULL CHECK(limit_minor BETWEEN 0 AND 100000), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,version)
);
ALTER TABLE refund_runtime.tenants ADD FOREIGN KEY(id,current_policy_version) REFERENCES refund_runtime.policies(tenant_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE refund_runtime.cases (
 tenant_id uuid NOT NULL, id text NOT NULL, case_label text NOT NULL, order_id text NOT NULL,
 title text NOT NULL, short_title text NOT NULL, complaint text NOT NULL CHECK(length(complaint) BETWEEN 8 AND 4000),
 status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','running','paused','complete')),
 stage text NOT NULL DEFAULT 'reception' CHECK(stage IN ('reception','evidence','policy','review','payments','archive')),
 outcome text, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), proposed_amount_minor bigint NOT NULL DEFAULT 0 CHECK(proposed_amount_minor BETWEEN 0 AND 9007199254740991),
 proposal jsonb, checks jsonb NOT NULL DEFAULT '[]', fingerprint text, approval jsonb, receipt jsonb, operation_id text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,case_label), FOREIGN KEY(tenant_id,order_id) REFERENCES refund_runtime.orders(tenant_id,id)
);
CREATE TABLE refund_runtime.evidence (
 tenant_id uuid NOT NULL, case_id text NOT NULL, id text NOT NULL, data jsonb NOT NULL,
 PRIMARY KEY(tenant_id,case_id,id), FOREIGN KEY(tenant_id,case_id) REFERENCES refund_runtime.cases(tenant_id,id)
);
CREATE TABLE refund_runtime.events (
 tenant_id uuid NOT NULL, case_id text NOT NULL, id bigint GENERATED ALWAYS AS IDENTITY,
 at timestamptz NOT NULL DEFAULT clock_timestamp(), event_type text NOT NULL, label text NOT NULL,
 detail text NOT NULL, actor uuid, payload jsonb NOT NULL DEFAULT '{}',
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,case_id) REFERENCES refund_runtime.cases(tenant_id,id),
 FOREIGN KEY(tenant_id,actor) REFERENCES refund_runtime.memberships(tenant_id,user_id)
);
CREATE TABLE refund_runtime.intake_requests (
 tenant_id uuid NOT NULL, id text NOT NULL, event_id text NOT NULL, case_id text NOT NULL,
 payload_hash text NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','awaiting-approval','held','already-resolved','error','handoff-complete')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_until timestamptz, lease_actor uuid, fence bigint NOT NULL DEFAULT 0, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
 claimed_revision bigint, facts_digest text, finished_fence bigint, proposal_digest text, result jsonb, last_error text,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,event_id), UNIQUE(tenant_id,case_id),
 FOREIGN KEY(tenant_id,case_id) REFERENCES refund_runtime.cases(tenant_id,id),
 FOREIGN KEY(tenant_id,lease_actor) REFERENCES refund_runtime.memberships(tenant_id,user_id)
);
CREATE TABLE refund_runtime.approvals (
 tenant_id uuid NOT NULL, id uuid NOT NULL, case_id text NOT NULL, actor uuid NOT NULL,
 note text NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0), fingerprint text NOT NULL,
 fingerprint_scheme text NOT NULL DEFAULT 'postgres-jsonb-v1' CHECK(fingerprint_scheme='postgres-jsonb-v1'),
 snapshot jsonb NOT NULL, operation_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,operation_id),
 FOREIGN KEY(tenant_id,case_id) REFERENCES refund_runtime.cases(tenant_id,id),
 FOREIGN KEY(tenant_id,actor) REFERENCES refund_runtime.memberships(tenant_id,user_id)
);
CREATE TABLE refund_runtime.operations (
 tenant_id uuid NOT NULL, id text NOT NULL, order_id text NOT NULL, line_id text NOT NULL,
 case_id text, issue text NOT NULL CHECK(issue='item_missing'), amount_minor bigint NOT NULL CHECK(amount_minor>0),
 status text NOT NULL CHECK(status IN ('reserved','succeeded')), seeded boolean NOT NULL DEFAULT false,
 provider text NOT NULL CHECK(provider IN ('local','local-disabled')), payload jsonb NOT NULL, idempotency_key text NOT NULL,
 receipt jsonb, approval_id uuid, submission_enabled boolean NOT NULL DEFAULT false CHECK(NOT submission_enabled),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(((seeded AND status='succeeded' AND provider='local' AND approval_id IS NULL AND case_id IS NULL AND receipt IS NOT NULL AND receipt->>'seeded'='true' AND receipt->>'id' LIKE 'DEMO-%') OR
       (NOT seeded AND status='reserved' AND provider='local-disabled' AND approval_id IS NOT NULL AND case_id IS NOT NULL AND receipt IS NULL)) IS TRUE),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,order_id,line_id,issue), UNIQUE(tenant_id,idempotency_key),
 FOREIGN KEY(tenant_id,order_id,line_id) REFERENCES refund_runtime.order_lines(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,case_id) REFERENCES refund_runtime.cases(tenant_id,id),
 FOREIGN KEY(tenant_id,approval_id) REFERENCES refund_runtime.approvals(tenant_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE refund_runtime.approvals ADD FOREIGN KEY(tenant_id,operation_id) REFERENCES refund_runtime.operations(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE refund_runtime.cases ADD FOREIGN KEY(tenant_id,operation_id) REFERENCES refund_runtime.operations(tenant_id,id);
CREATE TABLE refund_runtime.commands (
 tenant_id uuid NOT NULL REFERENCES refund_runtime.tenants(id), command_id uuid NOT NULL, actor uuid NOT NULL,
 payload_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,command_id), FOREIGN KEY(tenant_id,actor) REFERENCES refund_runtime.memberships(tenant_id,user_id)
);

CREATE FUNCTION refund_runtime.hash_text(p_text text) RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
 SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_text,'UTF8')),'hex')
$$;
-- JSON.stringify's sorted-object-key form, kept distinct from approval JSONB fingerprints.
CREATE FUNCTION refund_runtime.canonical_json(p_value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path='' AS $$
DECLARE result text;
BEGIN
 CASE jsonb_typeof(p_value)
 WHEN 'object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||refund_runtime.canonical_json(value),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(p_value);
 WHEN 'array' THEN SELECT '['||coalesce(string_agg(refund_runtime.canonical_json(value),',' ORDER BY ordinal),'')||']' INTO result FROM jsonb_array_elements(p_value) WITH ORDINALITY a(value,ordinal);
 ELSE result:=p_value::text;
 END CASE;
 RETURN result;
END $$;
CREATE FUNCTION refund_runtime.object_shape(p_value jsonb,p_allowed text[],p_required text[]) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
BEGIN
 IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Expected an object' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_value) k WHERE NOT k=ANY(p_allowed)) OR NOT p_value ?& p_required THEN RAISE EXCEPTION 'Unsupported or missing object fields' USING ERRCODE='22023'; END IF;
END $$;
CREATE FUNCTION refund_runtime.whole(p_value jsonb,p_min bigint,p_max bigint) RETURNS bigint LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE n numeric;
BEGIN
 IF jsonb_typeof(p_value) IS DISTINCT FROM 'number' OR p_value::text !~ '^[0-9]+$' THEN RAISE EXCEPTION 'Expected a bounded whole number' USING ERRCODE='22023'; END IF;
 n:=p_value::text::numeric;
 IF n<p_min OR n>p_max THEN RAISE EXCEPTION 'Number outside permitted bounds' USING ERRCODE='22023'; END IF;
 RETURN n::bigint;
END $$;
CREATE FUNCTION refund_runtime.plain_text(p_value jsonb,p_min integer,p_max integer) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE t text;
BEGIN
 IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Expected plain text' USING ERRCODE='22023'; END IF;
 t:=p_value#>>'{}';
 IF length(btrim(t))<p_min OR length(t)>p_max OR t ~ '[\x01-\x08\x0b\x0c\x0e-\x1f]' THEN RAISE EXCEPTION 'Text outside permitted bounds' USING ERRCODE='22023'; END IF;
 RETURN t;
END $$;
CREATE FUNCTION refund_runtime.identifier(p_value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE t text;
BEGIN
 t:=refund_runtime.plain_text(p_value,1,80);
 IF t !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$' THEN RAISE EXCEPTION 'Invalid local identifier' USING ERRCODE='22023'; END IF;
 RETURN t;
END $$;
CREATE FUNCTION refund_runtime.is_member(p_tenant uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT auth.uid() IS NOT NULL AND coalesce(auth.jwt()->>'is_anonymous','false')='false' AND EXISTS(SELECT 1 FROM refund_runtime.memberships WHERE tenant_id=p_tenant AND user_id=auth.uid())
$$;
CREATE FUNCTION refund_runtime.require_member(p_tenant uuid,p_roles text[]) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=auth.uid();
BEGIN
 IF actor IS NULL OR coalesce(auth.jwt()->>'is_anonymous','false')<>'false' OR NOT EXISTS(SELECT 1 FROM refund_runtime.memberships WHERE tenant_id=p_tenant AND user_id=actor AND role=ANY(p_roles)) THEN RAISE EXCEPTION 'Tenant role required' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION refund_runtime.policy_json(p_tenant uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_build_object('version',p.version,'limitMinor',p.limit_minor,'humanApprovalRequired',true) FROM refund_runtime.policies p JOIN refund_runtime.tenants t ON t.id=p.tenant_id AND t.current_policy_version=p.version WHERE t.id=p_tenant
$$;
CREATE FUNCTION refund_runtime.operation_json(p_tenant uuid,p_id text) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_build_object('id',id,'orderId',order_id,'lineId',line_id,'issue',issue,'amountMinor',amount_minor,'status',status,'seeded',seeded,'provider',provider,'payload',payload,'idempotencyKey',idempotency_key,'receipt',receipt,'approvalId',approval_id,'createdAt',created_at,'submissionEnabled',false) FROM refund_runtime.operations WHERE tenant_id=p_tenant AND id=p_id
$$;
CREATE FUNCTION refund_runtime.request_json(p_tenant uuid,p_id text) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_strip_nulls(jsonb_build_object('id',r.id,'eventId',r.event_id,'caseId',r.case_id,'caseLabel',c.case_label,'orderId',c.order_id,'status',r.status,'createdAt',r.created_at,'updatedAt',r.updated_at,'lastError',r.last_error,'fence',r.fence,'attempts',r.attempts,'leaseUntil',r.lease_until)) FROM refund_runtime.intake_requests r JOIN refund_runtime.cases c ON c.tenant_id=r.tenant_id AND c.id=r.case_id WHERE r.tenant_id=p_tenant AND r.id=p_id
$$;
CREATE FUNCTION refund_runtime.evidence_json(p_tenant uuid,p_case text) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(data ORDER BY id),'[]') FROM refund_runtime.evidence WHERE tenant_id=p_tenant AND case_id=p_case
$$;
CREATE FUNCTION refund_runtime.case_json(p_tenant uuid,p_case text) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_build_object('id',c.id,'caseId',c.case_label,'orderId',c.order_id,'title',c.title,'shortTitle',c.short_title,'complaint',c.complaint,'revision',c.revision,'status',c.status,'stage',c.stage,'outcome',c.outcome,'orderTotalMinor',o.total_minor,'proposedAmountMinor',c.proposed_amount_minor,'proposal',c.proposal,'checks',c.checks,'fingerprint',c.fingerprint,'fingerprintScheme','postgres-jsonb-v1','approval',c.approval,'receipt',c.receipt,'operationId',c.operation_id,'evidence',refund_runtime.evidence_json(p_tenant,p_case),'intakeManaged',true,'intakeRequestId',(SELECT id FROM refund_runtime.intake_requests WHERE tenant_id=p_tenant AND case_id=p_case),'events',coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'at',e.at,'type',e.event_type,'label',e.label,'detail',e.detail,'actor',e.actor,'payload',e.payload) ORDER BY e.id) FROM refund_runtime.events e WHERE e.tenant_id=p_tenant AND e.case_id=p_case),'[]')) FROM refund_runtime.cases c JOIN refund_runtime.orders o ON o.tenant_id=c.tenant_id AND o.id=c.order_id WHERE c.tenant_id=p_tenant AND c.id=p_case
$$;
CREATE FUNCTION refund_runtime.context_json(p_tenant uuid,p_case text,p_proposal boolean DEFAULT false) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_build_object('scheme','postgres-jsonb-v1','tenantId',p_tenant,'caseId',c.id,'order',o.data,'orderRevision',o.revision,'orderTotalMinor',o.total_minor,'lines',coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM refund_runtime.order_lines l WHERE l.tenant_id=p_tenant AND l.order_id=c.order_id),'[]'),'complaint',c.complaint,'evidence',refund_runtime.evidence_json(p_tenant,p_case),'policy',refund_runtime.policy_json(p_tenant),'proposal',CASE WHEN p_proposal THEN c.proposal ELSE NULL END,'operations',coalesce((SELECT jsonb_agg(refund_runtime.operation_json(p_tenant,x.id) ORDER BY x.id) FROM refund_runtime.operations x WHERE x.tenant_id=p_tenant AND x.order_id=c.order_id),'[]'),'paymentsEnabled',false) FROM refund_runtime.cases c JOIN refund_runtime.orders o ON o.tenant_id=c.tenant_id AND o.id=c.order_id WHERE c.tenant_id=p_tenant AND c.id=p_case
$$;
CREATE FUNCTION refund_runtime.record_evidence(p_tenant uuid,p_case text) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
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
END $$;
CREATE FUNCTION refund_runtime.evaluate(p_tenant uuid,p_case text) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE c refund_runtime.cases; o refund_runtime.orders; l refund_runtime.order_lines; previous refund_runtime.operations; exact_amount bigint; available bigint; permitted bigint; known boolean; checks jsonb;
BEGIN
 SELECT * INTO STRICT c FROM refund_runtime.cases WHERE tenant_id=p_tenant AND id=p_case;
 SELECT * INTO STRICT o FROM refund_runtime.orders WHERE tenant_id=p_tenant AND id=c.order_id;
 SELECT * INTO l FROM refund_runtime.order_lines WHERE tenant_id=p_tenant AND order_id=c.order_id AND id=c.proposal->>'lineId';
 SELECT * INTO previous FROM refund_runtime.operations WHERE tenant_id=p_tenant AND order_id=c.order_id AND line_id=c.proposal->>'lineId' AND issue=c.proposal->>'issue';
 exact_amount:=coalesce((l.ordered-l.packed)::bigint*l.unit_amount_minor,0);
 available:=o.total_minor-coalesce((SELECT sum(amount_minor) FROM refund_runtime.operations WHERE tenant_id=p_tenant AND order_id=c.order_id),0);
 permitted:=(refund_runtime.policy_json(p_tenant)->>'limitMinor')::bigint;
 known:=c.proposal->'evidenceIds' ? ('packing:'||o.id) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(c.proposal->'evidenceIds') r(id) WHERE NOT EXISTS(SELECT 1 FROM refund_runtime.evidence e WHERE e.tenant_id=p_tenant AND e.case_id=p_case AND e.id=r.id));
 checks:=jsonb_build_array(
 jsonb_build_object('id','missing-item','label','One supported missing item','pass',c.proposal->>'issue'='item_missing' AND l.id IS NOT NULL AND exact_amount>0),
 jsonb_build_object('id','evidence','label','Packing evidence cited','pass',coalesce(known,false)),
 jsonb_build_object('id','amount','label','Exact missing-item value','pass',exact_amount>0 AND c.proposed_amount_minor=exact_amount),
 jsonb_build_object('id','delivery','label','Delivery undisputed','pass',o.data->'delivery'->>'disputed'='false'),
 jsonb_build_object('id','limit','label','Within policy limit','pass',c.proposed_amount_minor<=permitted),
 jsonb_build_object('id','duplicate','label','No existing remedy','pass',previous.id IS NULL),
 jsonb_build_object('id','balance','label','Within remaining order balance','pass',c.proposed_amount_minor<=available));
 RETURN jsonb_build_object('eligible',NOT EXISTS(SELECT 1 FROM jsonb_array_elements(checks) x WHERE x->>'pass' IS DISTINCT FROM 'true'),'checks',checks,'previousOperationId',previous.id,'previousSeeded',previous.seeded,'previousStatus',previous.status,'remainingMinor',available);
END $$;

CREATE FUNCTION public.refund_runtime_read_workspace(p_tenant_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM refund_runtime.require_member(p_tenant_id,ARRAY['investigator','reviewer']);
 RETURN jsonb_build_object('tenantId',p_tenant_id,'mode','synthetic-only','paymentsEnabled',false,'orders',coalesce((SELECT jsonb_agg(data ORDER BY id) FROM refund_runtime.orders WHERE tenant_id=p_tenant_id),'[]'),'policy',refund_runtime.policy_json(p_tenant_id),'cases',coalesce((SELECT jsonb_agg(refund_runtime.case_json(p_tenant_id,id) ORDER BY case_label) FROM refund_runtime.cases WHERE tenant_id=p_tenant_id),'[]'),'intakeRequests',coalesce((SELECT jsonb_agg(refund_runtime.request_json(p_tenant_id,id) ORDER BY created_at,id) FROM refund_runtime.intake_requests WHERE tenant_id=p_tenant_id),'[]'));
END $$;
CREATE FUNCTION public.refund_runtime_read_case(p_tenant_id uuid,p_case_id text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM refund_runtime.require_member(p_tenant_id,ARRAY['investigator','reviewer']);
 result:=refund_runtime.case_json(p_tenant_id,p_case_id);
 IF result IS NULL THEN RAISE EXCEPTION 'Case unavailable' USING ERRCODE='55000'; END IF;
 RETURN result;
END $$;
CREATE FUNCTION public.refund_runtime_enqueue_intake(p_tenant_id uuid,p_event_id text,p_order_id text,p_complaint text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid; existing refund_runtime.intake_requests; payload_hash text; new_case text; request_id text; case_number bigint;
BEGIN
 actor:=refund_runtime.require_member(p_tenant_id,ARRAY['investigator','reviewer']);
 PERFORM 1 FROM refund_runtime.tenants WHERE id=p_tenant_id FOR UPDATE;
 IF p_event_id IS NULL OR p_event_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$' THEN RAISE EXCEPTION 'Invalid event ID' USING ERRCODE='22023'; END IF;
 p_complaint:=btrim(p_complaint);
 PERFORM refund_runtime.plain_text(to_jsonb(p_complaint),8,4000);
 IF NOT EXISTS(SELECT 1 FROM refund_runtime.orders WHERE tenant_id=p_tenant_id AND id=p_order_id) THEN RAISE EXCEPTION 'Unknown synthetic order' USING ERRCODE='22023'; END IF;
 payload_hash:=refund_runtime.hash_text(jsonb_build_object('orderId',p_order_id,'complaint',p_complaint)::text);
 SELECT * INTO existing FROM refund_runtime.intake_requests WHERE tenant_id=p_tenant_id AND event_id=p_event_id;
 IF FOUND THEN
  IF existing.payload_hash<>payload_hash THEN RAISE EXCEPTION 'Event ID already has another payload' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('request',refund_runtime.request_json(p_tenant_id,existing.id),'case',refund_runtime.case_json(p_tenant_id,existing.case_id),'replayed',true);
 END IF;
 UPDATE refund_runtime.tenants SET next_case_number=next_case_number+1 WHERE id=p_tenant_id RETURNING next_case_number INTO case_number;
 new_case:='SYN-'||gen_random_uuid()::text; request_id:='intake-'||gen_random_uuid()::text;
 INSERT INTO refund_runtime.cases(tenant_id,id,case_label,order_id,title,short_title,complaint) VALUES(p_tenant_id,new_case,'RF-'||case_number,p_order_id,'New synthetic refund request','New intake',p_complaint);
 INSERT INTO refund_runtime.intake_requests(tenant_id,id,event_id,case_id,payload_hash) VALUES(p_tenant_id,request_id,p_event_id,new_case,payload_hash);
 INSERT INTO refund_runtime.events(tenant_id,case_id,event_type,label,detail,actor,payload) VALUES(p_tenant_id,new_case,'intake.received','Intake received','Saved before investigation.',actor,jsonb_build_object('eventId',p_event_id));
 RETURN jsonb_build_object('request',refund_runtime.request_json(p_tenant_id,request_id),'case',refund_runtime.case_json(p_tenant_id,new_case),'replayed',false);
END $$;
CREATE FUNCTION public.refund_runtime_claim_intake(p_tenant_id uuid,p_lease_seconds integer DEFAULT 30) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid; r refund_runtime.intake_requests; c refund_runtime.cases;
BEGIN
 actor:=refund_runtime.require_member(p_tenant_id,ARRAY['investigator']);
 IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Lease must be between one and 300 seconds' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM refund_runtime.tenants WHERE id=p_tenant_id FOR UPDATE;
 -- Expired exhausted claims stop visibly. Other tenants and active claims are untouched.
 FOR r IN SELECT * FROM refund_runtime.intake_requests WHERE tenant_id=p_tenant_id AND status='running' AND lease_until<=clock_timestamp() AND attempts>=8 FOR UPDATE LOOP
  UPDATE refund_runtime.intake_requests SET status='error',last_error='Eight investigation attempts exhausted',updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=r.id;
  UPDATE refund_runtime.cases SET status='paused',stage='review',outcome='held',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=r.case_id AND status='running' AND stage IN ('reception','evidence','policy') AND approval IS NULL AND operation_id IS NULL;
  INSERT INTO refund_runtime.events(tenant_id,case_id,event_type,label,detail,actor) VALUES(p_tenant_id,r.case_id,'intake.exhausted','Investigation stopped','Eight expired claims; a person must inspect this case.',actor);
 END LOOP;
 SELECT r0.* INTO r FROM refund_runtime.intake_requests r0 JOIN refund_runtime.cases c0 ON c0.tenant_id=r0.tenant_id AND c0.id=r0.case_id WHERE r0.tenant_id=p_tenant_id AND r0.attempts<8 AND (r0.status='queued' OR r0.status='running' AND r0.lease_until<=clock_timestamp()) AND c0.status IN ('ready','running') AND c0.stage IN ('reception','evidence','policy') AND c0.approval IS NULL AND c0.operation_id IS NULL AND c0.receipt IS NULL ORDER BY r0.created_at,r0.id LIMIT 1 FOR UPDATE OF r0 SKIP LOCKED;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM refund_runtime.record_evidence(p_tenant_id,r.case_id);
 UPDATE refund_runtime.cases SET status='running',stage='policy',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=r.case_id RETURNING * INTO c;
 UPDATE refund_runtime.intake_requests SET status='running',lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),lease_actor=actor,fence=fence+1,attempts=attempts+1,claimed_revision=c.revision,facts_digest=refund_runtime.hash_text(refund_runtime.context_json(p_tenant_id,r.case_id)::text),updated_at=clock_timestamp(),last_error=NULL WHERE tenant_id=p_tenant_id AND id=r.id RETURNING * INTO r;
 INSERT INTO refund_runtime.events(tenant_id,case_id,event_type,label,detail,actor,payload) VALUES(p_tenant_id,r.case_id,'intake.claimed','Investigation claimed','Saved catalogue evidence; no approval or payment.',actor,jsonb_build_object('fence',r.fence,'attempt',r.attempts));
 RETURN jsonb_build_object('requestId',r.id,'caseId',r.case_id,'fence',r.fence,'leaseUntil',r.lease_until,'case',refund_runtime.case_json(p_tenant_id,r.case_id),'order',(SELECT data FROM refund_runtime.orders WHERE tenant_id=p_tenant_id AND id=c.order_id),'evidence',refund_runtime.evidence_json(p_tenant_id,r.case_id),'policy',refund_runtime.policy_json(p_tenant_id));
END $$;
CREATE FUNCTION public.refund_runtime_finish_intake(p_tenant_id uuid,p_request_id text,p_fence bigint,p_proposal jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid; r refund_runtime.intake_requests; c refund_runtime.cases; amount bigint; digest text; evaluation jsonb; v_result jsonb; v_outcome text; previous refund_runtime.operations;
BEGIN
 actor:=refund_runtime.require_member(p_tenant_id,ARRAY['investigator']);
 PERFORM 1 FROM refund_runtime.tenants WHERE id=p_tenant_id FOR UPDATE;
 PERFORM refund_runtime.object_shape(p_proposal,ARRAY['amountMinor','lineId','issue','reason','evidenceIds','source'],ARRAY['amountMinor','lineId','issue','reason','evidenceIds','source']);
 amount:=refund_runtime.whole(p_proposal->'amountMinor',0,9007199254740991);
 PERFORM refund_runtime.plain_text(p_proposal->'reason',1,4000);
 IF p_proposal->>'source' IS DISTINCT FROM 'local' OR coalesce(p_proposal->>'issue' NOT IN ('item_missing','delivery_dispute','unknown'),true) OR jsonb_typeof(p_proposal->'lineId') NOT IN ('string','null') OR jsonb_typeof(p_proposal->'evidenceIds') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid local proposal' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p_proposal->'lineId')='string' THEN PERFORM refund_runtime.identifier(p_proposal->'lineId'); END IF;
 IF jsonb_array_length(p_proposal->'evidenceIds')>20 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_proposal->'evidenceIds') e WHERE jsonb_typeof(e)<>'string' OR length(e#>>'{}')>200) THEN RAISE EXCEPTION 'Invalid evidence references' USING ERRCODE='22023'; END IF;
 IF p_proposal->>'issue' IN ('unknown','delivery_dispute') AND (amount<>0 OR p_proposal->'lineId'<>'null'::jsonb) THEN RAISE EXCEPTION 'Unsupported claims cannot propose money' USING ERRCODE='22023'; END IF;
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
 UPDATE refund_runtime.cases SET proposal=p_proposal,proposed_amount_minor=amount WHERE tenant_id=p_tenant_id AND id=c.id;
 evaluation:=refund_runtime.evaluate(p_tenant_id,c.id);
 IF evaluation->>'previousStatus'='succeeded' AND evaluation->>'previousSeeded'='true' AND p_proposal->>'issue'='item_missing' AND (evaluation->'checks'->2->>'pass')='true' AND (evaluation->'checks'->1->>'pass')='true' THEN
  v_outcome:='already-resolved'; SELECT * INTO previous FROM refund_runtime.operations WHERE tenant_id=p_tenant_id AND id=evaluation->>'previousOperationId';
 ELSE v_outcome:=CASE WHEN evaluation->>'eligible'='true' THEN 'awaiting-approval' ELSE 'held' END;
 END IF;
 UPDATE refund_runtime.cases SET status=CASE WHEN v_outcome='already-resolved' THEN 'complete' ELSE 'paused' END,stage=CASE WHEN v_outcome='already-resolved' THEN 'archive' ELSE 'review' END,outcome=v_outcome,checks=evaluation->'checks',fingerprint=refund_runtime.hash_text(refund_runtime.context_json(p_tenant_id,c.id,true)::text),receipt=previous.receipt,operation_id=previous.id,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=c.id;
 UPDATE refund_runtime.intake_requests SET status=v_outcome,finished_fence=p_fence,proposal_digest=digest,lease_until=NULL,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=r.id;
 INSERT INTO refund_runtime.events(tenant_id,case_id,event_type,label,detail,actor,payload) VALUES(p_tenant_id,c.id,'investigation.finished','Local investigation finished',CASE WHEN v_outcome='already-resolved' THEN 'Existing seeded remedy found; no new refund.' ELSE 'Saved recommendation and deterministic checks; human review required.' END,actor,jsonb_build_object('outcome',v_outcome,'source','local'));
 v_result:=jsonb_build_object('request',refund_runtime.request_json(p_tenant_id,r.id),'case',refund_runtime.case_json(p_tenant_id,c.id));
 UPDATE refund_runtime.intake_requests SET result=v_result WHERE tenant_id=p_tenant_id AND id=r.id;
 RETURN v_result;
END $$;
CREATE FUNCTION public.refund_runtime_approve_and_reserve(p_tenant_id uuid,p_case_id text,p_expected_revision bigint,p_expected_fingerprint text,p_expected_amount_minor bigint,p_note text,p_command_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid; c refund_runtime.cases; cmd refund_runtime.commands; command_hash text; v_snapshot jsonb; v_fingerprint text; evaluation jsonb; v_approval_id uuid; v_operation_id text; retry_key text; v_approval jsonb; v_result jsonb;
BEGIN
 actor:=refund_runtime.require_member(p_tenant_id,ARRAY['reviewer']);
 PERFORM 1 FROM refund_runtime.tenants WHERE id=p_tenant_id FOR UPDATE;
 PERFORM refund_runtime.plain_text(to_jsonb(p_note),10,2000);
 IF p_command_id IS NULL OR p_expected_revision IS NULL OR p_expected_amount_minor IS NULL OR p_expected_amount_minor<=0 OR p_expected_fingerprint IS NULL OR p_expected_fingerprint !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Approval facts are incomplete' USING ERRCODE='22023'; END IF;
 command_hash:=refund_runtime.hash_text(jsonb_build_object('caseId',p_case_id,'revision',p_expected_revision,'fingerprint',p_expected_fingerprint,'amountMinor',p_expected_amount_minor,'note',p_note,'actor',actor)::text);
 SELECT * INTO cmd FROM refund_runtime.commands WHERE tenant_id=p_tenant_id AND command_id=p_command_id;
 IF FOUND THEN
  IF cmd.actor<>actor OR cmd.payload_hash<>command_hash THEN RAISE EXCEPTION 'Command ID already binds another approval' USING ERRCODE='23505'; END IF;
  RETURN cmd.result||jsonb_build_object('replayed',true);
 END IF;
 SELECT * INTO c FROM refund_runtime.cases WHERE tenant_id=p_tenant_id AND id=p_case_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Case unavailable' USING ERRCODE='55000'; END IF;
 IF c.revision<>p_expected_revision THEN RAISE EXCEPTION 'Case revision changed' USING ERRCODE='40001'; END IF;
 IF c.status<>'paused' OR c.stage<>'review' OR c.outcome<>'awaiting-approval' OR c.approval IS NOT NULL OR c.operation_id IS NOT NULL OR c.receipt IS NOT NULL THEN RAISE EXCEPTION 'Case is not awaiting approval' USING ERRCODE='55000'; END IF;
 v_snapshot:=refund_runtime.context_json(p_tenant_id,p_case_id,true); v_fingerprint:=refund_runtime.hash_text(v_snapshot::text);
 IF v_fingerprint<>p_expected_fingerprint OR c.fingerprint<>p_expected_fingerprint OR c.proposed_amount_minor<>p_expected_amount_minor THEN RAISE EXCEPTION 'Approval evidence, policy, amount or balance changed' USING ERRCODE='40001'; END IF;
 evaluation:=refund_runtime.evaluate(p_tenant_id,p_case_id);
 IF evaluation->>'eligible' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Current facts do not permit this reservation' USING ERRCODE='55000'; END IF;
 v_approval_id:=gen_random_uuid(); v_operation_id:='reserved-'||gen_random_uuid()::text; retry_key:='refund-runtime-'||v_operation_id;
 INSERT INTO refund_runtime.approvals(tenant_id,id,case_id,actor,note,amount_minor,fingerprint,snapshot,operation_id) VALUES(p_tenant_id,v_approval_id,p_case_id,actor,p_note,p_expected_amount_minor,v_fingerprint,v_snapshot,v_operation_id);
 INSERT INTO refund_runtime.operations(tenant_id,id,order_id,line_id,case_id,issue,amount_minor,status,seeded,provider,payload,idempotency_key,approval_id) VALUES(p_tenant_id,v_operation_id,c.order_id,c.proposal->>'lineId',p_case_id,'item_missing',p_expected_amount_minor,'reserved',false,'local-disabled',jsonb_build_object('operationId',v_operation_id,'idempotencyKey',retry_key,'order',v_snapshot->'order','amountMinor',p_expected_amount_minor,'lineId',c.proposal->>'lineId','issue','item_missing','submissionEnabled',false),retry_key,v_approval_id);
 v_approval:=jsonb_build_object('id',v_approval_id,'state','approved','actor',actor,'note',p_note,'amountMinor',p_expected_amount_minor,'fingerprint',v_fingerprint,'fingerprintScheme','postgres-jsonb-v1','snapshot',v_snapshot,'operationId',v_operation_id,'at',clock_timestamp());
 UPDATE refund_runtime.cases SET approval=v_approval,operation_id=v_operation_id,status='paused',stage='payments',outcome='approved-not-submitted',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=p_case_id;
 UPDATE refund_runtime.intake_requests SET status='handoff-complete',updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND case_id=p_case_id;
 INSERT INTO refund_runtime.events(tenant_id,case_id,event_type,label,detail,actor,payload) VALUES(p_tenant_id,p_case_id,'approval.reserved','Human approval recorded','Reserved locally in PostgreSQL. Payment submission is disabled.',actor,jsonb_build_object('approvalId',v_approval_id,'operationId',v_operation_id));
 v_result:=jsonb_build_object('case',refund_runtime.case_json(p_tenant_id,p_case_id),'operation',refund_runtime.operation_json(p_tenant_id,v_operation_id),'replayed',false);
 INSERT INTO refund_runtime.commands(tenant_id,command_id,actor,payload_hash,result) VALUES(p_tenant_id,p_command_id,actor,command_hash,v_result);
 RETURN v_result;
END $$;

CREATE FUNCTION public.refund_runtime_import_dataset(p_tenant_id uuid,p_dataset jsonb,p_digest text,p_members jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_existing refund_runtime.tenants; v_order jsonb; v_line jsonb; v_case jsonb; v_op jsonb; v_member jsonb; v_scenario jsonb; v_order_id text; v_line_id text; v_case_id text; v_total bigint; v_calculated numeric; v_price bigint; v_ordered bigint; v_packed bigint; v_amount bigint; v_count integer; v_expected jsonb; v_event text; v_request text;
BEGIN
 -- Import is intentionally an administrative RPC. It has no authenticated grant.
 IF p_tenant_id IS NULL OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid dataset identity' USING ERRCODE='22023'; END IF;
 PERFORM refund_runtime.object_shape(p_dataset,ARRAY['schemaVersion','id','synthetic','title','merchant','policy','orders','cases','seedOperations','scenarios'],ARRAY['schemaVersion','id','synthetic','title','merchant','policy','orders','cases','scenarios']);
 IF p_dataset->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR p_dataset->'synthetic' IS DISTINCT FROM 'true'::jsonb OR coalesce(p_dataset->>'id' NOT IN ('focused-12','busy-50'),true) THEN RAISE EXCEPTION 'Only supported synthetic datasets can be imported' USING ERRCODE='22023'; END IF;
 p_dataset:=p_dataset||jsonb_build_object('seedOperations',coalesce(p_dataset->'seedOperations','[]'));
 IF refund_runtime.hash_text(refund_runtime.canonical_json(p_dataset))<>p_digest THEN RAISE EXCEPTION 'Canonical dataset digest does not match' USING ERRCODE='22023'; END IF;
 PERFORM refund_runtime.plain_text(p_dataset->'title',1,160);
 PERFORM refund_runtime.object_shape(p_dataset->'merchant',ARRAY['id','name','currency','synthetic'],ARRAY['id','name','currency','synthetic']);
 PERFORM refund_runtime.identifier(p_dataset->'merchant'->'id'); PERFORM refund_runtime.plain_text(p_dataset->'merchant'->'name',1,160);
 IF p_dataset->'merchant'->>'currency' IS DISTINCT FROM 'gbp' OR p_dataset->'merchant'->'synthetic' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Synthetic GBP merchant required' USING ERRCODE='22023'; END IF;
 PERFORM refund_runtime.object_shape(p_dataset->'policy',ARRAY['version','limitMinor'],ARRAY['version','limitMinor']);
 PERFORM refund_runtime.whole(p_dataset->'policy'->'limitMinor',0,100000);
 IF p_dataset->'policy'->'version' IS DISTINCT FROM '1'::jsonb THEN RAISE EXCEPTION 'Fresh policy version one required' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p_dataset->'orders') IS DISTINCT FROM 'array' OR jsonb_typeof(p_dataset->'cases') IS DISTINCT FROM 'array' OR jsonb_typeof(p_dataset->'seedOperations') IS DISTINCT FROM 'array' OR jsonb_typeof(p_dataset->'scenarios') IS DISTINCT FROM 'array' OR jsonb_typeof(p_members) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Dataset collections must be arrays' USING ERRCODE='22023'; END IF;
 v_count:=CASE p_dataset->>'id' WHEN 'focused-12' THEN 12 ELSE 50 END;
 IF jsonb_array_length(p_dataset->'orders') NOT BETWEEN 1 AND 500 OR jsonb_array_length(p_dataset->'cases')<>v_count OR jsonb_array_length(p_dataset->'seedOperations')>500 OR jsonb_array_length(p_dataset->'scenarios')<>v_count OR jsonb_array_length(p_members)>100 THEN RAISE EXCEPTION 'Invalid dataset collection size' USING ERRCODE='22023'; END IF;
 -- Serialise concurrent import of the same tenant, including its first insertion.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text,1307));
 SELECT * INTO v_existing FROM refund_runtime.tenants WHERE id=p_tenant_id FOR UPDATE;
 IF FOUND THEN
  IF v_existing.dataset_digest<>p_digest OR v_existing.dataset<>p_dataset THEN RAISE EXCEPTION 'Tenant already has a different catalogue' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('tenantId',p_tenant_id,'datasetId',v_existing.dataset_id,'digest',p_digest,'caseCount',v_count,'orderCount',jsonb_array_length(p_dataset->'orders'),'replayed',true);
 END IF;
 INSERT INTO refund_runtime.tenants(id,title,dataset_id,dataset_digest,dataset) VALUES(p_tenant_id,p_dataset->>'title',p_dataset->>'id',p_digest,p_dataset);
 INSERT INTO refund_runtime.policies(tenant_id,version,limit_minor) VALUES(p_tenant_id,1,(p_dataset->'policy'->>'limitMinor')::bigint);
 FOR v_member IN SELECT value FROM jsonb_array_elements(p_members) LOOP
  PERFORM refund_runtime.object_shape(v_member,ARRAY['userId','role'],ARRAY['userId','role']);
  IF coalesce(v_member->>'role' NOT IN ('reviewer','investigator'),true) OR v_member->>'userId' IS NULL THEN RAISE EXCEPTION 'Invalid member role' USING ERRCODE='22023'; END IF;
  INSERT INTO refund_runtime.memberships(tenant_id,user_id,role) VALUES(p_tenant_id,(v_member->>'userId')::uuid,v_member->>'role');
 END LOOP;
 FOR v_order IN SELECT value FROM jsonb_array_elements(p_dataset->'orders') LOOP
  PERFORM refund_runtime.object_shape(v_order,ARRAY['id','label','totalMinor','currency','synthetic','delivery','lines','sampleComplaint'],ARRAY['id','label','totalMinor','currency','synthetic','delivery','lines']);
  v_order_id:=refund_runtime.identifier(v_order->'id'); PERFORM refund_runtime.plain_text(v_order->'label',1,200);
  v_total:=refund_runtime.whole(v_order->'totalMinor',1,9007199254740991);
  IF v_order->>'currency' IS DISTINCT FROM 'gbp' OR v_order->'synthetic' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Synthetic GBP order required' USING ERRCODE='22023'; END IF;
  IF v_order ? 'sampleComplaint' THEN PERFORM refund_runtime.plain_text(v_order->'sampleComplaint',8,4000); END IF;
  PERFORM refund_runtime.object_shape(v_order->'delivery',ARRAY['status','disputed','detail'],ARRAY['status','disputed','detail']);
  PERFORM refund_runtime.plain_text(v_order->'delivery'->'status',1,80); PERFORM refund_runtime.plain_text(v_order->'delivery'->'detail',1,2000);
  IF jsonb_typeof(v_order->'delivery'->'disputed') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v_order->'lines') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid delivery or order lines' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(v_order->'lines') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid line count' USING ERRCODE='22023'; END IF;
  INSERT INTO refund_runtime.orders(tenant_id,id,total_minor,currency,synthetic,data) VALUES(p_tenant_id,v_order_id,v_total,'gbp',true,v_order);
  v_calculated:=0;
  FOR v_line IN SELECT value FROM jsonb_array_elements(v_order->'lines') LOOP
   PERFORM refund_runtime.object_shape(v_line,ARRAY['id','name','unitAmountMinor','ordered','packed'],ARRAY['id','name','unitAmountMinor','ordered','packed']);
   v_line_id:=refund_runtime.identifier(v_line->'id'); PERFORM refund_runtime.plain_text(v_line->'name',1,160);
   v_price:=refund_runtime.whole(v_line->'unitAmountMinor',1,9007199254740991); v_ordered:=refund_runtime.whole(v_line->'ordered',1,100); v_packed:=refund_runtime.whole(v_line->'packed',0,v_ordered);
   v_calculated:=v_calculated+v_price::numeric*v_ordered;
   IF v_calculated>9007199254740991 THEN RAISE EXCEPTION 'Order arithmetic exceeds safe integer range' USING ERRCODE='22023'; END IF;
   INSERT INTO refund_runtime.order_lines(tenant_id,order_id,id,name,unit_amount_minor,ordered,packed) VALUES(p_tenant_id,v_order_id,v_line_id,v_line->>'name',v_price,v_ordered::integer,v_packed::integer);
  END LOOP;
  IF v_calculated<>v_total THEN RAISE EXCEPTION 'Order total does not match its lines' USING ERRCODE='22023'; END IF;
 END LOOP;
 FOR v_case IN SELECT value FROM jsonb_array_elements(p_dataset->'cases') LOOP
  PERFORM refund_runtime.object_shape(v_case,ARRAY['id','caseId','title','shortTitle','orderId','complaint'],ARRAY['id','caseId','title','shortTitle','orderId','complaint']);
  v_case_id:=refund_runtime.identifier(v_case->'id'); PERFORM refund_runtime.identifier(v_case->'orderId');
  PERFORM refund_runtime.plain_text(v_case->'title',1,200); PERFORM refund_runtime.plain_text(v_case->'shortTitle',1,80); PERFORM refund_runtime.plain_text(v_case->'complaint',8,4000);
  IF v_case->>'caseId' IS NULL OR v_case->>'caseId' !~ '^RF-[0-9]{1,12}$' OR v_case->>'complaint'<>btrim(v_case->>'complaint') THEN RAISE EXCEPTION 'Invalid seed case label or complaint' USING ERRCODE='22023'; END IF;
  INSERT INTO refund_runtime.cases(tenant_id,id,case_label,order_id,title,short_title,complaint) VALUES(p_tenant_id,v_case_id,v_case->>'caseId',v_case->>'orderId',v_case->>'title',v_case->>'shortTitle',v_case->>'complaint');
  v_event:='demo-'||(p_dataset->>'id')||'-'||v_case_id; v_request:='dataset-intake-'||(p_dataset->>'id')||'-'||v_case_id;
  INSERT INTO refund_runtime.intake_requests(tenant_id,id,event_id,case_id,payload_hash) VALUES(p_tenant_id,v_request,v_event,v_case_id,refund_runtime.hash_text(jsonb_build_object('orderId',v_case->>'orderId','complaint',v_case->>'complaint')::text));
  INSERT INTO refund_runtime.events(tenant_id,case_id,event_type,label,detail,payload) VALUES(p_tenant_id,v_case_id,'intake.received','Synthetic intake imported','Fresh case saved; no human decision or payment imported.',jsonb_build_object('eventId',v_event,'datasetId',p_dataset->>'id','synthetic',true));
 END LOOP;
 UPDATE refund_runtime.tenants SET next_case_number=greatest(10000,(SELECT max(substring(case_label from 4)::bigint) FROM refund_runtime.cases WHERE tenant_id=p_tenant_id)) WHERE id=p_tenant_id;
 FOR v_op IN SELECT value FROM jsonb_array_elements(p_dataset->'seedOperations') LOOP
  PERFORM refund_runtime.object_shape(v_op,ARRAY['id','orderId','lineId','issue','amountMinor','status','seeded','provider','idempotencyKey','createdAt','payload','receipt'],ARRAY['id','orderId','lineId','issue','amountMinor','status','seeded','provider','idempotencyKey','createdAt','payload','receipt']);
  PERFORM refund_runtime.identifier(v_op->'id'); PERFORM refund_runtime.identifier(v_op->'orderId'); PERFORM refund_runtime.identifier(v_op->'lineId');
  v_amount:=refund_runtime.whole(v_op->'amountMinor',1,9007199254740991);
  IF v_op->>'issue' IS DISTINCT FROM 'item_missing' OR v_op->>'status' IS DISTINCT FROM 'succeeded' OR v_op->'seeded' IS DISTINCT FROM 'true'::jsonb OR v_op->>'provider' IS DISTINCT FROM 'local' OR v_op->>'idempotencyKey' IS NULL OR v_op->>'idempotencyKey' !~ '^refund-office-seed-[A-Za-z0-9_-]{1,120}$' OR v_op->>'createdAt' IS NULL OR v_op->>'createdAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RAISE EXCEPTION 'Only explicit local seeded history is accepted' USING ERRCODE='22023'; END IF;
  SELECT data INTO v_order FROM refund_runtime.orders WHERE tenant_id=p_tenant_id AND id=v_op->>'orderId';
  SELECT (ordered-packed)::bigint*unit_amount_minor INTO v_total FROM refund_runtime.order_lines WHERE tenant_id=p_tenant_id AND order_id=v_op->>'orderId' AND id=v_op->>'lineId';
  IF v_total IS NULL OR v_total<>v_amount THEN RAISE EXCEPTION 'Seed amount does not match missing-item evidence' USING ERRCODE='22023'; END IF;
  v_expected:=jsonb_build_object('operationId',v_op->>'id','idempotencyKey',v_op->>'idempotencyKey','order',v_order,'amountMinor',v_amount,'lineId',v_op->>'lineId','issue','item_missing');
  IF v_op->'payload'<>v_expected THEN RAISE EXCEPTION 'Seed payload does not match its order' USING ERRCODE='22023'; END IF;
  PERFORM refund_runtime.object_shape(v_op->'receipt',ARRAY['id','provider','amountMinor','currency','status','createdAt','operationId','seeded'],ARRAY['id','provider','amountMinor','currency','status','createdAt','operationId','seeded']);
  v_expected:=jsonb_build_object('id',v_op->'receipt'->>'id','provider','local','amountMinor',v_amount,'currency','gbp','status','succeeded','createdAt',v_op->>'createdAt','operationId',v_op->>'id','seeded',true);
  IF v_op->'receipt'<>v_expected OR v_op->'receipt'->>'id' IS NULL OR v_op->'receipt'->>'id' !~ '^DEMO-[A-Za-z0-9_-]{1,120}$' THEN RAISE EXCEPTION 'Seed receipt must match explicit synthetic history' USING ERRCODE='22023'; END IF;
  INSERT INTO refund_runtime.operations(tenant_id,id,order_id,line_id,issue,amount_minor,status,seeded,provider,payload,idempotency_key,receipt,created_at) VALUES(p_tenant_id,v_op->>'id',v_op->>'orderId',v_op->>'lineId','item_missing',v_amount,'succeeded',true,'local',v_op->'payload',v_op->>'idempotencyKey',v_op->'receipt',(v_op->>'createdAt')::timestamptz);
 END LOOP;
 IF EXISTS(SELECT 1 FROM refund_runtime.operations x JOIN refund_runtime.orders o ON o.tenant_id=x.tenant_id AND o.id=x.order_id WHERE x.tenant_id=p_tenant_id GROUP BY x.order_id,o.total_minor HAVING sum(x.amount_minor)>o.total_minor) THEN RAISE EXCEPTION 'Historical remedies exceed the order balance' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM refund_runtime.operations WHERE tenant_id=p_tenant_id GROUP BY receipt->>'id' HAVING count(*)>1) THEN RAISE EXCEPTION 'Repeated synthetic receipt' USING ERRCODE='22023'; END IF;
 FOR v_scenario IN SELECT value FROM jsonb_array_elements(p_dataset->'scenarios') LOOP
  PERFORM refund_runtime.object_shape(v_scenario,ARRAY['caseId','category','expectedOutcome','expectedAmountMinor','dependsOn'],ARRAY['caseId','category','expectedOutcome']);
  PERFORM refund_runtime.plain_text(v_scenario->'category',1,80);
  IF coalesce(v_scenario->>'expectedOutcome' NOT IN ('awaiting-approval','held','already-resolved'),true) OR NOT EXISTS(SELECT 1 FROM refund_runtime.cases WHERE tenant_id=p_tenant_id AND id=v_scenario->>'caseId') THEN RAISE EXCEPTION 'Invalid scenario expectation' USING ERRCODE='22023'; END IF;
  IF v_scenario ? 'expectedAmountMinor' THEN
   SELECT o.total_minor INTO v_total FROM refund_runtime.cases c JOIN refund_runtime.orders o ON o.tenant_id=c.tenant_id AND o.id=c.order_id WHERE c.tenant_id=p_tenant_id AND c.id=v_scenario->>'caseId';
   PERFORM refund_runtime.whole(v_scenario->'expectedAmountMinor',0,v_total);
  END IF;
  IF v_scenario ? 'dependsOn' AND (v_scenario->>'dependsOn'=v_scenario->>'caseId' OR NOT EXISTS(SELECT 1 FROM refund_runtime.cases WHERE tenant_id=p_tenant_id AND id=v_scenario->>'dependsOn')) THEN RAISE EXCEPTION 'Invalid scenario dependency' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_dataset->'scenarios') s GROUP BY s->>'caseId' HAVING count(*)>1) THEN RAISE EXCEPTION 'Repeated scenario' USING ERRCODE='22023'; END IF;
 IF EXISTS(WITH RECURSIVE links AS (SELECT s->>'caseId' AS id,s->>'dependsOn' AS next,ARRAY[s->>'caseId'] AS path,false AS cycle FROM jsonb_array_elements(p_dataset->'scenarios') s UNION ALL SELECT l.id,s->>'dependsOn',l.path||(s->>'caseId'),(s->>'caseId')=ANY(l.path) FROM links l JOIN jsonb_array_elements(p_dataset->'scenarios') s ON s->>'caseId'=l.next WHERE NOT l.cycle) SELECT 1 FROM links WHERE cycle) THEN RAISE EXCEPTION 'Cyclic scenario dependencies' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('tenantId',p_tenant_id,'datasetId',p_dataset->>'id','digest',p_digest,'caseCount',v_count,'orderCount',jsonb_array_length(p_dataset->'orders'),'replayed',false);
END $$;

-- Recorded decisions, operations and events are append-only, even for accidental
-- administrative updates. A future migration must explicitly design any change.
CREATE FUNCTION refund_runtime.reject_change() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Recorded audit facts are immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER immutable_approvals BEFORE UPDATE OR DELETE ON refund_runtime.approvals FOR EACH ROW EXECUTE FUNCTION refund_runtime.reject_change();
CREATE TRIGGER immutable_operations BEFORE UPDATE OR DELETE ON refund_runtime.operations FOR EACH ROW EXECUTE FUNCTION refund_runtime.reject_change();
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON refund_runtime.events FOR EACH ROW EXECUTE FUNCTION refund_runtime.reject_change();
CREATE TRIGGER immutable_commands BEFORE UPDATE OR DELETE ON refund_runtime.commands FOR EACH ROW EXECUTE FUNCTION refund_runtime.reject_change();

DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['tenants','memberships','orders','order_lines','policies','cases','evidence','events','intake_requests','approvals','operations','commands'] LOOP
  EXECUTE format('ALTER TABLE refund_runtime.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_read ON refund_runtime.%I FOR SELECT TO authenticated USING (refund_runtime.is_member(%I))',t,CASE WHEN t='tenants' THEN 'id' ELSE 'tenant_id' END);
 END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA refund_runtime FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA refund_runtime FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA refund_runtime TO authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA refund_runtime FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION refund_runtime.is_member(uuid) TO authenticated;
DO $$
DECLARE f record;
BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'refund_runtime_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
  IF f.proname='refund_runtime_import_dataset' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
  ELSE EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f.signature); END IF;
 END LOOP;
END $$;
COMMIT;
