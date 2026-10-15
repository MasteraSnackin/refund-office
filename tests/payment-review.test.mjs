import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedPayments } from '../server/hosted-payments.mjs';
import { createHostedHandler } from '../server/hosted-api.mjs';
import { createRuntimePaymentRepository } from '../server/runtime-payments.mjs';
import { executionFixture, ENABLED, providerFixture } from './runtime-payments/fixtures.mjs';

const e = executionFixture(), now = () => 1_800_000_000_000;
const principal = { userId: e.authorisation.actor, tenantId: e.tenantId, role: 'reviewer' };
const token = `fixture.${Buffer.from(JSON.stringify({ sub: principal.userId, role: 'authenticated', exp: now()/1000+3600 })).toString('base64url')}.signature`;
const env = { ...ENABLED, REFUND_OFFICE_WORKING_STORE:'supabase', REFUND_OFFICE_HOSTED:'enabled', REFUND_OFFICE_ENABLED_INTEGRATIONS:'supabase-runtime,stripe-runtime', REFUND_OFFICE_PUBLIC_ORIGIN:'https://office.example.invalid', REFUND_OFFICE_HOSTED_TENANT_ID:e.tenantId, SUPABASE_URL:'https://fixture.supabase.co', SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture', REFUND_OFFICE_SESSION_SECRET:Buffer.alloc(32, 7).toString('base64url') };
function context({ existing = false } = {}) {
  return { caseId:e.caseId,tenantId:e.tenantId,caseRevision:4,eligible:!existing,blockedReason:existing?'A test execution is already saved for this case.':null,
    binding:{operationId:e.operationId,expectedCaseRevision:4,originalApprovalId:e.originalApproval.id,originalFingerprint:e.originalApproval.fingerprint,expectedAmountMinor:2000,orderId:e.mapping.orderId,lineId:e.payload.lineId,paymentAmountMinor:6000,currency:'gbp',originalApprovedAt:'2026-10-14T10:00:00Z',originalApprovedBy:principal.userId},execution:existing?structuredClone(e):null };
}
const payments = (fetchImpl, overrides = {}) => createHostedPayments({ env, now, principal, accessToken:token, fetchImpl, ...overrides });

test('review context stays disconnected before credentials or transport, including the hosted route', async () => {
  const offline = new Proxy({ REFUND_OFFICE_NETWORK:'offline' }, { get(target,key) { if (/KEY|SECRET/.test(String(key))) assert.fail('Secret touched'); return target[key]; } });
  await assert.rejects(payments(() => assert.fail('Network called'), { env:offline }).context(e.caseId), { code:'payment_execution_disabled' });
  const handler = createHostedHandler({ env:{...env,REFUND_OFFICE_PAYMENT_EXECUTION:'disabled'},fetchImpl:()=>assert.fail('Auth or provider called'),now });
  const result = await handler(new Request(env.REFUND_OFFICE_PUBLIC_ORIGIN+`/api/cases/${e.caseId}/payment-authorisation`));
  assert.equal(result.status,503); assert.equal((await result.json()).error.code,'payment_execution_disabled');
});
test('only reviewers can request payment context, before a database or Stripe call', async () => {
  for (const role of ['investigator','payment-executor']) await assert.rejects(payments(() => assert.fail('Transport called'), {principal:{...principal,role}}).context(e.caseId), {code:'payment_role_required'});
  await assert.rejects(payments(() => assert.fail('Transport called')).context('../case'), {code:'invalid_payment_case'});
});
test('eligible context reads only exact tenant and case with no provider or secret access', async () => {
  const calls = [];
  const guarded = new Proxy(env,{get(target,key){if (String(key).startsWith('STRIPE_') || String(key).includes('MACHINE')) assert.fail('Payment credential touched');return target[key];}});
  const result = await payments(async(url,options) => { calls.push({url:String(url),body:JSON.parse(options.body)}); return Response.json(context()); },{env:guarded}).context(e.caseId);
  assert.deepEqual(result,context()); assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://fixture.supabase.co/rest/v1/rpc/refund_runtime_payment_authorisation_context');
  assert.deepEqual(calls[0].body,{p_tenant_id:e.tenantId,p_case_id:e.caseId});
});
test('case lookup discovers the immutable saved execution after reload even when the case revision changes', async () => {
  const saved = context({existing:true}); saved.caseRevision=7;
  const result = await payments(async()=>Response.json(saved)).context(e.caseId);
  assert.equal(result.execution.id,e.id);assert.equal(result.binding.expectedCaseRevision,4);assert.equal(result.caseRevision,7);assert.equal(result.eligible,false);
});
test('cross-tenant, wrong-case, stale eligible bindings and mismatched existing execution fail closed', async () => {
  for (const mutate of [
    v=>{v.tenantId='70000000-0000-4000-8000-000000000012';},
    v=>{v.caseId='other-case';}, v=>{v.caseRevision=5;},v=>{v.binding.expectedAmountMinor=7000;},v=>{v.binding.originalApprovedBy='invalid';},
  ]) { const value=context();mutate(value); await assert.rejects(payments(async()=>Response.json(value)).context(e.caseId),{code:'unverified_payment_context'}); }
  const value=context({existing:true});value.binding.operationId='another-operation';
  await assert.rejects(payments(async()=>Response.json(value)).context(e.caseId),{code:'unverified_payment_context'});
});
test('a lost context read remains a read failure, never a potentially committed authorisation', async () => {
  await assert.rejects(payments(async()=>{throw Error('private account details');}).context(e.caseId),error=>error.code==='payment_database_unconfirmed' && error.uncertain===false && !error.message.includes('private'));
});
test('blocked unapproved context contains no binding and cannot become eligible through malformed data', async () => {
  const value={...context(),eligible:false,blockedReason:'Approve the recommendation before authorising a test payment.',binding:null};
  assert.deepEqual(await payments(async()=>Response.json(value)).context(e.caseId),value);
  value.eligible=true;value.blockedReason=null;
  await assert.rejects(payments(async()=>Response.json(value)).context(e.caseId),{code:'unverified_payment_context'});
});
test('saved success needs a matching independently recorded receipt while uncertainty can preserve an older receipt', async () => {
  for (const mutate of [v=>{v.status='succeeded';},v=>{v.status='invented';},v=>{v.refundId='re_Unexpected';},v=>{v.submittedAt='invalid';v.status='submitting';}]) {
    const value=structuredClone(e);mutate(value);
    await assert.rejects(createRuntimePaymentRepository({env:ENABLED,tenantId:e.tenantId,rpc:async()=>value}).readExecution(e.id),{code:'unverified_execution'});
  }
  const receipt=await providerFixture(e).readRefund('re_Synthetic1');
  const value={...e,status:'succeeded',submittedAt:'2026-10-14T10:05:00Z',refundId:receipt.id,receipt};
  const repo=createRuntimePaymentRepository({env:ENABLED,tenantId:e.tenantId,rpc:async()=>value});
  assert.equal((await repo.readExecution(e.id)).status,'succeeded');
  value.status='uncertain';assert.equal((await repo.readExecution(e.id)).receipt.status,'succeeded');
  value.status='failed';await assert.rejects(repo.readExecution(e.id),{code:'unverified_execution'});
});
test('hosted reviewer lookup uses a verified session and rejects investigator and wrong method without payment lookup', async () => {
  for (const role of ['reviewer','investigator']) {
    const calls=[],sessions=new Map(),identity={...principal,role,title:'Synthetic payment review',synthetic:true};
    const handler=createHostedHandler({env,now,fetchImpl:async(url,options)=>{
      const path=new URL(url).pathname,body=options.body?JSON.parse(options.body):null;calls.push(path);
      assert.equal(new URL(url).hostname,'fixture.supabase.co');
      if(path==='/auth/v1/token')return Response.json({access_token:token,refresh_token:'fixture-refresh'});
      if(path==='/auth/v1/user')return Response.json({id:principal.userId,is_anonymous:false});
      if(path.endsWith('/refund_runtime_session_context'))return Response.json(identity);
      if(path.endsWith('/refund_runtime_hosted_session')){
        if(body.p_action==='create')sessions.set(body.p_session_id,{...identity,sessionId:body.p_session_id,generation:1,sessionExpiresAt:new Date(now()+86400000).toISOString(),revoked:false});
        return Response.json(sessions.get(body.p_session_id));
      }
      assert.ok(path.endsWith('/refund_runtime_payment_authorisation_context'));return Response.json(context());
    }});
    const login=await handler(new Request(env.REFUND_OFFICE_PUBLIC_ORIGIN+'/api/session',{method:'POST',headers:{'Content-Type':'application/json',origin:env.REFUND_OFFICE_PUBLIC_ORIGIN},body:JSON.stringify({email:'fixture@example.invalid',password:'synthetic-password'})}));
    assert.equal(login.status,200,await login.clone().text());const cookie=login.headers.get('set-cookie').split(';')[0];
    const path=env.REFUND_OFFICE_PUBLIC_ORIGIN+`/api/cases/${e.caseId}/payment-authorisation`;
    const result=await handler(new Request(path,{headers:{cookie}}));assert.equal(result.status,role==='reviewer'?200:403,await result.clone().text());
    assert.equal(calls.filter(p=>p.endsWith('/refund_runtime_payment_authorisation_context')).length,role==='reviewer'?1:0);
    const count=calls.length;
    assert.equal((await handler(new Request(path,{method:'POST',headers:{cookie,origin:env.REFUND_OFFICE_PUBLIC_ORIGIN,'Content-Type':'application/json'},body:'{}'}))).status,405);
    assert.equal(calls.length,count);
  }
});
