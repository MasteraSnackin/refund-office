import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepareSyntheticImport} from '../../server/supabase-import.mjs';
import {createLocalPostgresRuntime} from '../../server/local-postgres-runtime.mjs';
import {createRuntimeService} from '../../server/runtime-service.mjs';
import {createProviders} from '../../server/providers.mjs';
import {createRuntimeSessions} from '../../server/runtime-auth.mjs';
import {createRuntimeApiServer} from '../../server/runtime-api.mjs';

export async function runEvidenceLoopChecks({ROOT,sql,value,rejected,check,quote}){
  const tenantId='62000000-0000-4000-8000-000000000012',reviewer='62000000-0000-4000-8000-000000000001',investigator='62000000-0000-4000-8000-000000000002';
  const actor=userId=>({role:'authenticated',userId}),uuid=v=>`${quote(v)}::uuid`,text=v=>`${quote(v)}::text`,json=v=>`${quote(JSON.stringify(v))}::jsonb`,rpc=(name,args=[])=>`select public.refund_runtime_${name}(${[uuid(tenantId),...args].join(',')});`;
  const pack=prepareSyntheticImport(JSON.parse(readFileSync(join(ROOT,'demo-data/focused-12.json'),'utf8')));
  const reviewerSession={tenantId,userId:reviewer,role:'reviewer'},investigatorSession={tenantId,userId:investigator,role:'investigator'};
  const executeSql=async({statement,userId,role})=>{const r=await sql(statement,{userId,role,allowFailure:true});if(r.code!==0)throw Object.assign(new Error('Isolated clarification SQL rejected'),{sqlState:r.stderr.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1]});const out=r.stdout.trim();return out?JSON.parse(out):null;};
  const repositoryForSession=profile=>createLocalPostgresRuntime({executeSql,tenantId,profile});
  const repo=repositoryForSession(reviewerSession),worker=repositoryForSession(investigatorSession);
  const service=createRuntimeService({repositoryForSession,workerRepository:worker,automaticWorker:false,evidenceClarification:true});
  let workspace,originalFacts,held,body,saved,finished;
  const snapshot=()=>value(`select jsonb_build_object('orders',(select jsonb_agg(to_jsonb(o) order by id) from refund_runtime.orders o where tenant_id=${uuid(tenantId)}),'lines',(select jsonb_agg(to_jsonb(l) order by id) from refund_runtime.order_lines l where tenant_id=${uuid(tenantId)}),'policies',(select jsonb_agg(to_jsonb(p) order by version) from refund_runtime.policies p where tenant_id=${uuid(tenantId)}));`);
  const hold=async id=>{const item=await repo.readCase(id);await service.review(reviewerSession,id,{action:'request-evidence',expectedRevision:item.revision,note:'Synthetic reviewer asks which item is missing before any approval.',commandId:randomUUID()});return repo.readCase(id);};
  const inputFor=(item,lineId,statement)=>({expectedRevision:item.revision,lineId,customerStatement:statement,sourceReference:'Synthetic customer reply fixture',note:'Recorded a synthetic reply for a new investigation; no payment approved.',commandId:randomUUID()});
  try{
    await check('clarification migration supports explicit reviewer holds and forbids direct writes and cross-tenant access',async()=>{
      await sql(readFileSync(join(ROOT,'integrations/supabase/runtime/007_evidence_clarification.sql'),'utf8'));
      await sql(`insert into auth.users(id) values(${uuid(reviewer)}),(${uuid(investigator)});`);
      await value(rpc('import_dataset',[json(pack.data),text(pack.manifest.digest),json([{userId:reviewer,role:'reviewer'},{userId:investigator,role:'investigator'}])]));
      for(;;){if((await service.runNext(investigatorSession)).empty)break;}
      workspace=await repo.readWorkspace();originalFacts=await snapshot();
      const target=workspace.cases.find(c=>c.caseId==='RF-2008');assert.equal(target.outcome,'held');
      assert.equal((await service.evidenceRequest(reviewerSession,target.id)).eligible,false);
      const proposal=inputFor(target,'SYN-F12-O008-L1','The Sketchbook is missing from my order.');
      await assert.rejects(service.submitClarification(reviewerSession,target.id,proposal),{code:'runtime_conflict'});
      await assert.rejects(service.evidenceRequest(investigatorSession,target.id),{code:'runtime_role_required'});
      for(const options of [{role:'anon'},{role:'service_role'},actor(investigator)])await rejected(rpc('evidence_request',[text(target.id)]),options,/42501/);
      await rejected(`select public.refund_runtime_evidence_request('61000000-0000-4000-8000-000000000012',${text(target.id)});`,actor(reviewer),/42501/);
      assert.equal(await value(`select to_json(has_table_privilege('authenticated','refund_runtime.evidence_submissions','INSERT'));`),false);
      held=await hold(target.id);assert.equal((await service.evidenceRequest(reviewerSession,target.id)).eligible,true);
      return {requiresRecordedEvidenceRequest:true,reviewerOnly:true,crossTenantDenied:true,originalCasesInvestigated:12};
    });
    await check('clarification validates the exact revision, item, immutable source and active-claim boundary',async()=>{
      body=inputFor(held,'SYN-F12-O008-L1','The Sketchbook is missing from my order.');
      for(const change of [{expectedRevision:held.revision-1},{lineId:'SYN-F12-O001-L1'},{customerStatement:'short'},{sourceReference:'short'},{note:'short'},{kind:'packing-correction'},{amountMinor:1},{actor:investigator}])await assert.rejects(service.submitClarification(reviewerSession,held.id,{...body,...change}));
      for(const input of [{...body,amountMinor:1},{...body,kind:'customer-clarification'},{...body,customerStatement:null},{...body,lineId:'SYN-F12-O001-L1'}])await rejected(rpc('submit_clarification',[text(held.id),json(input)]),actor(reviewer),/22023/);
      const active=await sql(`begin; update refund_runtime.intake_requests set lease_until=clock_timestamp()+interval '60 seconds' where tenant_id=${uuid(tenantId)} and case_id=${text(held.id)}; set local role authenticated;set local request.jwt.claim.sub=${quote(reviewer)};set local request.jwt.claims=${quote(JSON.stringify({sub:reviewer,role:'authenticated'}))};${rpc('submit_clarification',[text(held.id),json(body)])}rollback;`,{allowFailure:true});assert.notEqual(active.code,0);assert.match(active.stderr,/55000/);
      assert.equal(await value(`select count(*)::int from refund_runtime.evidence_submissions where tenant_id=${uuid(tenantId)};`),0);
      return {staleRevisionRejected:true,noCatalogueOverrides:true,activeLeaseRejected:true,noSubmissionCreated:true};
    });
    await check('one exact clarification atomically archives the prior investigation, appends evidence and requeues once',async()=>{
      const oldRequest=workspace.intakeRequests.find(r=>r.caseId===held.id);
      saved=await service.submitClarification(reviewerSession,held.id,body);assert.equal(saved.readbackVerified,true);assert.equal(saved.case.runtimeStatus,'ready');assert.equal(saved.case.proposal,null);assert.equal(saved.case.fingerprint,null);assert.equal(saved.case.review,null);assert.equal(saved.case.approval,null);assert.equal(saved.case.operationId,null);assert.equal(saved.case.receipt,null);assert.equal(saved.request.status,'queued');assert.ok(saved.request.fence>oldRequest.fence);
      assert.equal(saved.submission.actor,reviewer);assert.equal(saved.submission.body,body.customerStatement);assert.equal(saved.context.submissions.length,1);assert.equal(saved.context.eligible,false);
      const repeats=await Promise.all([repo.submitClarification({caseId:held.id,...body}),repo.submitClarification({caseId:held.id,...body})]);assert.ok(repeats.every(r=>r.replayed&&r.submission.id===saved.submission.id));
      await assert.rejects(repo.submitClarification({caseId:held.id,...body,customerStatement:body.customerStatement+' Changed.'}),{code:'runtime_conflict'});
      await assert.rejects(repo.submitClarification({caseId:held.id,...body,commandId:randomUUID()}),{code:'runtime_conflict'});
      const raw=await repo.readCase(held.id),event=raw.events.find(e=>e.type==='evidence.clarification-recorded');assert.equal(event.payload.previousInvestigation.revision,held.revision);assert.deepEqual(event.payload.previousInvestigation.evidence,held.evidence);assert.equal(event.payload.paymentAuthorised,false);assert.equal(raw.complaint,held.complaint);
      assert.deepEqual(await snapshot(),originalFacts);
      await rejected(`update refund_runtime.evidence_submissions set body='Changed after saving' where tenant_id=${uuid(tenantId)};`,{},/55000/);await rejected(`delete from refund_runtime.evidence_submissions where tenant_id=${uuid(tenantId)};`,{},/55000/);
      return {oneImmutableSubmission:true,priorEvidencePreserved:true,catalogueUnchanged:true,commandReplaysDeduplicated:true};
    });
    await check('fresh investigation retains clarification and reaches human review with deterministic amount and no refund',async()=>{
      const result=await service.runNext(investigatorSession);finished=await repo.readCase(held.id);
      assert.equal(result.case.id,held.id);assert.equal(finished.outcome,'awaiting-approval');assert.equal(finished.proposedAmountMinor,1000);assert.equal(finished.approval,null);assert.equal(finished.operationId,null);assert.equal(finished.receipt,null);
      assert.equal(finished.complaint,held.complaint);assert.equal(finished.evidence.find(e=>e.id==='clarification:'+saved.submission.id).body,body.customerStatement);assert.ok(finished.proposal.evidenceIds.includes('clarification:'+saved.submission.id));assert.ok(finished.checks.every(c=>c.pass));
      assert.equal((await repo.submitClarification({caseId:held.id,...body})).submission.id,saved.submission.id);
      const report=await service.report(reviewerSession,held.id);assert.match(report.text,/Sketchbook is missing/);assert.match(report.text,/Customer clarification recorded/);
      const operations=await value(`select count(*)::int from refund_runtime.operations where tenant_id=${uuid(tenantId)} and not seeded;`);assert.equal(operations,0);
      assert.deepEqual(await snapshot(),originalFacts);
      return {freshAmountMinor:1000,humanApprovalStillRequired:true,originalComplaintUnchanged:true,newOperations:0,evidenceSurvivesClaim:true};
    });
    await check('contradictory later clarification stays held and database policy rejects omitted clarification references',async()=>{
      const next=await hold(held.id),conflict=inputFor(next,'SYN-F12-O008-L2','The Marker set is missing from my order.');
      await service.submitClarification(reviewerSession,next.id,conflict);
      const claim=await worker.claimIntake();assert.equal(claim.caseId,next.id);assert.equal(claim.evidence.filter(e=>e.kind==='customer-clarification').length,2);
      const local=createProviders({env:{},fetchImpl(){assert.fail('Network called');}}),proposal=await local.proposeCase({complaint:claim.case.complaint,order:claim.order,evidence:claim.evidence});assert.equal(proposal.issue,'unknown');
      // The database independently rejects dropping the clarification citations.
      const forged={amountMinor:1000,lineId:'SYN-F12-O008-L1',issue:'item_missing',reason:'Synthetic malicious investigator fixture.',evidenceIds:['packing:SYN-F12-O008'],source:'local'};
      const result=await worker.finishIntake({requestId:claim.requestId,fence:claim.fence,proposal:forged});assert.equal(result.case.outcome,'held');assert.equal(result.case.checks.find(c=>c.id==='clarification').pass,false);assert.equal(result.case.approval,null);
      const other=workspace.cases.find(c=>c.caseId==='RF-2004');if(other){const h=await hold(other.id);const order=workspace.orders.find(o=>o.id===h.orderId);await service.submitClarification(reviewerSession,h.id,inputFor(h,order.lines[0].id,`The ${order.lines[0].name} is missing from my order.`));const r=await service.runNext(investigatorSession);assert.equal(r.case.outcome,'held');}
      return {conflictingStatementsHeld:true,missingClarificationCitationsHeld:true,noApprovals:true};
    });
    await check('actual local API verifies clarification readback and denies investigators without contacting sponsors',async()=>{
      const auth=createRuntimeSessions({tenantId}),hosts=new Set(),origins=new Set();
      const server=createRuntimeApiServer({service,auth,allowedHosts:hosts,allowedOrigins:origins});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;hosts.add(new URL(origin).host);origins.add(origin);
      // API profiles use the standard local IDs; grant only this disposable tenant.
      await sql(`insert into auth.users(id) values('40000000-0000-4000-8000-000000000001'),('40000000-0000-4000-8000-000000000002') on conflict do nothing;insert into refund_runtime.memberships(tenant_id,user_id,role) values(${uuid(tenantId)},'40000000-0000-4000-8000-000000000001','reviewer'),(${uuid(tenantId)},'40000000-0000-4000-8000-000000000002','investigator');`);
      const call=(path,method='GET',body,cookie)=>fetch(origin+path,{method,headers:{...(cookie?{cookie}:{}),...(body?{origin,'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
      try{
        const login=await call('/api/session','POST',{profileId:'reviewer'}),cookie=login.headers.get('set-cookie').split(';')[0];
        const read=await call(`/api/cases/${held.id}/evidence-request`,'GET',undefined,cookie);assert.equal(read.status,200);assert.equal((await read.json()).submissions.length,2);
        const inv=await call('/api/session','POST',{profileId:'investigator'}),invCookie=inv.headers.get('set-cookie').split(';')[0];assert.equal((await call(`/api/cases/${held.id}/evidence-request`,'GET',undefined,invCookie)).status,403);
        assert.equal((await call(`/api/cases/${held.id}/evidence-request`,'POST',{...body,commandId:randomUUID()},invCookie)).status,403);
        const wrong=await fetch(origin+`/api/cases/${held.id}/evidence-request`,{headers:{cookie,origin:'https://other.invalid'}});assert.equal(wrong.status,403);
        const b=await(await call('/api/bootstrap','GET',undefined,cookie)).json();assert.equal(b.capabilities.evidenceClarification,true);assert.equal(b.capabilities.paymentSubmission,false);
      }finally{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));auth.close();}
      assert.deepEqual(await snapshot(),originalFacts);assert.equal(await value(`select count(*)::int from refund_runtime.operations where tenant_id=${uuid(tenantId)} and not seeded;`),0);
      return {actualHttpApi:true,reviewerReadback:true,investigatorDenied:true,externalCalls:0,newPayments:0};
    });
  }finally{await service.close();}
}
