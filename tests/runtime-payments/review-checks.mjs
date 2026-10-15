import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareSyntheticImport } from '../../server/supabase-import.mjs';
import { createProviders } from '../../server/providers.mjs';
import { createHostedPayments } from '../../server/hosted-payments.mjs';
import { createRuntimePaymentRepository, createRuntimePaymentExecutor } from '../../server/runtime-payments.mjs';
import { ENABLED, providerFixture } from './fixtures.mjs';

// Runs only in the existing disposable, network-none verification harness.
export async function runPaymentReviewChecks({ROOT,sql,value,rejected,check,quote}) {
  const tenantId='61000000-0000-4000-8000-000000000012',reviewer='61000000-0000-4000-8000-000000000001',investigator='61000000-0000-4000-8000-000000000002',executor='61000000-0000-4000-8000-000000000003';
  const actor=userId=>({role:'authenticated',userId}),uuid=v=>`${quote(v)}::uuid`,text=v=>`${quote(v)}::text`,json=v=>`${quote(JSON.stringify(v))}::jsonb`;
  const rpc=(name,args=[])=>`select public.refund_runtime_${name}(${[uuid(tenantId),...args].join(',')});`;
  const pack=prepareSyntheticImport(JSON.parse(readFileSync(join(ROOT,'demo-data/focused-12.json'),'utf8')));
  const local=createProviders({env:{},fetchImpl(){assert.fail('External provider access');}});
  const transport=userId=>async(name,params)=>{
    assert.match(name,/^refund_runtime_(payment_authorisation_context|authorise_execution|read_execution|claim_execution|begin_submission|save_refund_reference|note_execution_unknown|claim_reconciliation|record_refund_readback)$/);
    const uuidKeys=new Set(['p_tenant_id','p_execution_id','p_original_approval_id','p_command_id']);
    const args=Object.entries(params).map(([key,v])=>`${key} => ${v===null?'NULL':typeof v==='number'?String(v):typeof v==='object'?json(v):uuidKeys.has(key)?uuid(v):text(v)}`);
    const result=await sql(`select public.${name}(${args.join(',')});`,{...actor(userId),allowFailure:true});
    if(result.code!==0)throw Object.assign(new Error('The isolated payment review RPC rejected the action.'),{sqlState:result.stderr.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1]});
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  };
  const repository=userId=>createRuntimePaymentRepository({env:ENABLED,tenantId,rpc:transport(userId)});
  let originalWorkspace,approved,context,execution,command;
  const environment={...ENABLED,REFUND_OFFICE_ENABLED_INTEGRATIONS:'supabase-runtime,stripe-runtime',REFUND_OFFICE_HOSTED:'enabled',REFUND_OFFICE_WORKING_STORE:'supabase',REFUND_OFFICE_PUBLIC_ORIGIN:'https://review-fixture.invalid',REFUND_OFFICE_HOSTED_TENANT_ID:tenantId,SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture'};
  const token=`fixture.${Buffer.from(JSON.stringify({sub:reviewer,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.signature`;
  const calls=[];
  const hosted=createHostedPayments({env:environment,principal:{userId:reviewer,tenantId,role:'reviewer'},accessToken:token,fetchImpl:async(url,options)=>{
    assert.equal(new URL(url).hostname,'fixture.supabase.co');const name=new URL(url).pathname.split('/').at(-1);calls.push(name);
    return Response.json(await transport(reviewer)(name,JSON.parse(options.body)));
  }});

  await check('payment-review migration is read-only and denies unauthorised roles before exposing case context',async()=>{
    await sql(readFileSync(join(ROOT,'integrations/supabase/runtime/006_payment_review.sql'),'utf8'));
    await sql(`insert into auth.users(id) values ${[reviewer,investigator,executor].map(v=>`(${uuid(v)})`).join(',')};`);
    await value(rpc('import_dataset',[json(pack.data),text(pack.manifest.digest),json([{userId:reviewer,role:'reviewer'},{userId:investigator,role:'investigator'}])]));
    await sql(`insert into refund_runtime.memberships(tenant_id,user_id,role) values(${uuid(tenantId)},${uuid(executor)},'payment-executor');`);
    for(;;){const claim=await value(rpc('claim_intake'),actor(investigator));if(!claim)break;const proposal=await local.proposeCase({complaint:claim.case.complaint,order:claim.order,evidence:claim.evidence});await value(rpc('finish_intake',[text(claim.requestId),String(claim.fence),json(proposal)]),actor(investigator));}
    originalWorkspace=await value(rpc('read_workspace'),actor(reviewer));
    for(const item of originalWorkspace.cases){const c=await repository(reviewer).paymentAuthorisationContext(item.id);assert.equal(c.eligible,false);assert.equal(c.binding,null);assert.equal(c.execution,null);}
    const statement=rpc('payment_authorisation_context',[text(originalWorkspace.cases[0].id)]);
    for(const options of [{role:'anon'},{role:'service_role'},actor(investigator),actor(executor)])await rejected(statement,options,/42501/);
    assert.deepEqual(await value(rpc('read_workspace'),actor(reviewer)),originalWorkspace);
    assert.equal(await value(`select count(*)::int from refund_runtime.payment_executions where tenant_id=${uuid(tenantId)};`),0);
    return {unapprovedCasesInspected:12,investigatorAndExecutorDenied:true,readOnly:true};
  });
  await check('exact approved reservation produces a complete eligible binding without adding execution records',async()=>{
    const item=originalWorkspace.cases.find(c=>c.outcome==='awaiting-approval');
    approved=await value(rpc('approve_and_reserve',[text(item.id),String(item.revision),text(item.fingerprint),String(item.proposedAmountMinor),text('Synthetic isolated review fixture: missing item evidence supports this exact reservation.'),uuid(randomUUID())]),actor(reviewer));
    context=await hosted.context(item.id);const b=context.binding;
    assert.equal(context.eligible,true);assert.equal(context.execution,null);assert.equal(b.operationId,approved.operation.id);assert.equal(b.expectedCaseRevision,approved.case.revision);assert.equal(b.expectedAmountMinor,approved.operation.amountMinor);assert.equal(b.originalApprovalId,approved.case.approval.id);assert.equal(b.originalFingerprint,approved.case.approval.fingerprint);assert.equal(b.originalApprovedBy,reviewer);assert.equal(b.paymentAmountMinor,approved.case.approval.snapshot.order.totalMinor);
    assert.equal(await value(`select count(*)::int from refund_runtime.payment_executions where tenant_id=${uuid(tenantId)};`),0);
    await rejected(`select public.refund_runtime_payment_authorisation_context('60000000-0000-4000-8000-000000000012',${text(item.id)});`,actor(reviewer),/42501/);
    await rejected(rpc('payment_authorisation_context',[text('missing-case')]),actor(reviewer),/55000/);
    await rejected(rpc('payment_authorisation_context',[text('../case')]),actor(reviewer),/22023/);
    return {completeOriginalBinding:true,crossTenantDenied:true,noExecutionCreated:true};
  });
  await check('changed evidence, policy or case state makes the review context ineligible without modifying saved decisions',async()=>{
    for(const change of [
      `update refund_runtime.evidence set data=jsonb_set(data,'{body}',to_jsonb('Changed synthetic evidence'::text)) where tenant_id=${uuid(tenantId)} and case_id=${text(approved.case.id)};`,
      `update refund_runtime.policies set limit_minor=limit_minor+1 where tenant_id=${uuid(tenantId)};`,
      `update refund_runtime.cases set status='complete' where tenant_id=${uuid(tenantId)} and id=${text(approved.case.id)};`,
    ]){
      const read=await value(`begin; ${change} set local role authenticated; set local request.jwt.claim.sub=${quote(reviewer)}; set local request.jwt.claims=${quote(JSON.stringify({sub:reviewer,role:'authenticated',is_anonymous:false}))}; ${rpc('payment_authorisation_context',[text(approved.case.id)])} rollback;`);
      assert.equal(read.eligible,false);assert.equal(read.execution,null);assert.match(read.blockedReason,/facts changed/);
    }
    assert.deepEqual(await hosted.context(approved.case.id),context);
    assert.deepEqual(await value(rpc('read_case',[text(approved.case.id)]),actor(reviewer)),approved.case);
    return {staleEvidenceBlocked:true,stalePolicyBlocked:true,changedStateBlocked:true,rollbackPreservedCase:true};
  });
  await check('saved authorisation is discovered through case lookup and exact lost-response retries retain one decision',async()=>{
    const b=context.binding;
    command={operationId:b.operationId,expectedCaseRevision:b.expectedCaseRevision,originalApprovalId:b.originalApprovalId,originalFingerprint:b.originalFingerprint,expectedAmountMinor:b.expectedAmountMinor,mapping:{accountId:'acct_ReviewFixture',paymentIntentId:'pi_ReviewFixture',orderId:b.orderId,paymentAmountMinor:b.paymentAmountMinor,currency:'gbp',livemode:false},note:'Synthetic isolated test decision: authorise only the exact saved reservation and test payment mapping.',commandId:randomUUID()};
    const result=await hosted.authorise(command);execution=result.execution;assert.equal(result.authorisationReadbackVerified,true);assert.equal(result.submitted,false);
    const found=await hosted.context(approved.case.id);assert.equal(found.eligible,false);assert.equal(found.execution.id,execution.id);assert.deepEqual(found.binding,context.binding);assert.match(found.blockedReason,/already saved/);
    assert.equal((await hosted.authorise(command)).execution.id,execution.id);
    await assert.rejects(hosted.authorise({...command,commandId:randomUUID()}),error=>error.uncertain===true);
    assert.equal(await value(`select count(*)::int from refund_runtime.payment_executions where tenant_id=${uuid(tenantId)};`),1);
    assert.equal(calls.some(name=>!name.startsWith('refund_runtime_')),false);
    return {independentAuthorisationReadback:true,reloadDiscovery:true,exactRetrySameExecution:true,additionalAuthorisationBlocked:true,providerCalls:0};
  });
  await check('an uncertain provider result stays visible through case lookup without a retry or fabricated receipt',async()=>{
    const log=[],provider=providerFixture(execution,log);provider.createRefund=async()=>{log.push('refund:post');throw new Error('Injected lost response');};
    const executorClient=createRuntimePaymentExecutor({env:ENABLED,repository:repository(executor),provider});
    await assert.rejects(executorClient.execute(execution.id),{code:'payment_execution_uncertain'});
    const first=await hosted.context(approved.case.id);assert.equal(first.eligible,false);assert.equal(first.execution.status,'uncertain');assert.equal(first.execution.receipt,null);assert.equal(first.execution.refundId,null);assert.ok(first.execution.submittedAt);
    const repeated=await hosted.context(approved.case.id);assert.deepEqual(repeated,first);assert.equal(log.filter(v=>v==='refund:post').length,1);
    await assert.rejects(executorClient.execute(execution.id));await assert.rejects(executorClient.reconcile(execution.id));
    assert.equal(log.filter(v=>v==='refund:post').length,1);
    return {uncertaintyVisible:true,receiptInvented:false,lookupCreatedNoRetry:true,injectedProviderOnly:true};
  });
  await check('review lookups preserve original cases, approvals, reservations and audit history after recovery',async()=>{
    const before=await value(rpc('read_workspace'),actor(reviewer));
    const audit=await value(`select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from refund_runtime.payment_execution_events e where tenant_id=${uuid(tenantId)};`);
    for(const item of before.cases)await hosted.context(item.id);
    assert.deepEqual(await value(rpc('read_workspace'),actor(reviewer)),before);
    assert.deepEqual(await value(`select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from refund_runtime.payment_execution_events e where tenant_id=${uuid(tenantId)};`),audit);
    assert.deepEqual(await value(rpc('read_case',[text(approved.case.id)]),actor(reviewer)),approved.case);
    assert.deepEqual(await value(`select refund_runtime.operation_json(${uuid(tenantId)},${text(approved.operation.id)});`),approved.operation);
    for(const item of originalWorkspace.cases.filter(c=>c.id!==approved.case.id))assert.deepEqual(before.cases.find(c=>c.id===item.id),item);
    return {originalReservationUnchanged:true,otherCasesUnchanged:11,lookupsAddedAuditEvents:false,existingPreviewAccessed:false};
  });
}
