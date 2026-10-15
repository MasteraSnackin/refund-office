import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticatePaymentMachine, createHostedPayments } from '../server/hosted-payments.mjs';
import { executionFixture, repositoryFixture, providerFixture } from './runtime-payments/fixtures.mjs';
import { createHostedHandler } from '../server/hosted-api.mjs';

const execution = executionFixture(), now = () => 1_800_000_000_000, executorId = '60000000-0000-4000-8000-000000000004';
const token = sub => `fixture.${Buffer.from(JSON.stringify({sub, role:'authenticated',exp:now()/1000+3600})).toString('base64url')}.signature`;
const env = { REFUND_OFFICE_NETWORK:'enabled',REFUND_OFFICE_WORKING_STORE:'supabase',REFUND_OFFICE_HOSTED:'enabled',REFUND_OFFICE_PAYMENT_EXECUTION:'stripe-test',REFUND_OFFICE_ENABLED_INTEGRATIONS:'supabase-runtime,stripe-runtime',REFUND_OFFICE_PUBLIC_ORIGIN:'https://office.example.invalid',REFUND_OFFICE_HOSTED_TENANT_ID:execution.tenantId,SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',REFUND_OFFICE_PAYMENT_MACHINE_KEY:'p'.repeat(40),REFUND_OFFICE_PAYMENT_MACHINE_USER_ID:executorId,REFUND_OFFICE_MACHINE_KEY:'i'.repeat(40),REFUND_OFFICE_MACHINE_USER_ID:'60000000-0000-4000-8000-000000000005' };
const request = (user=executorId, key=env.REFUND_OFFICE_PAYMENT_MACHINE_KEY) => new Request('https://office.example.invalid/api/machine/payments/x/execute',{headers:{Authorization:'Bearer '+token(user),'x-refund-payment-key':key}});
test('all hosted payment entry points refuse disconnected mode before secrets or network',async()=>{
  const offline=new Proxy({REFUND_OFFICE_NETWORK:'offline'},{get(value,key){if(String(key).includes('KEY')||String(key).includes('SECRET'))assert.fail('Secret accessed');return value[key];}});
  const fetchImpl=()=>assert.fail('Network accessed');
  await assert.rejects(authenticatePaymentMachine(request(),{env:offline,fetchImpl,now}),{code:'payment_execution_disabled'});
  const payments=createHostedPayments({env:offline,fetchImpl,now});
  for(const action of ['authorise','read','execute','reconcile'])await assert.rejects(payments[action](execution.id),{code:'payment_execution_disabled'});
});
test('intake credentials and wrong executor identities cannot reach user verification',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;return new Response('{}');};
  await assert.rejects(authenticatePaymentMachine(request(),{env:{...env,REFUND_OFFICE_PAYMENT_MACHINE_KEY:env.REFUND_OFFICE_MACHINE_KEY},fetchImpl,now}),{code:'payment_machine_disconnected'});
  await assert.rejects(authenticatePaymentMachine(request(env.REFUND_OFFICE_MACHINE_USER_ID),{env,fetchImpl,now}),{code:'payment_machine_denied'});
  await assert.rejects(authenticatePaymentMachine(request(executorId,env.REFUND_OFFICE_MACHINE_KEY),{env,fetchImpl,now}),{code:'payment_machine_denied'});
  assert.equal(calls,0);
});
test('machine JWT parsing requires independent Supabase user verification',async()=>{
  const calls=[];const verified=await authenticatePaymentMachine(request(),{env,now,fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return new Response(JSON.stringify({id:executorId,is_anonymous:false}));}});
  assert.equal(calls.length,1);assert.match(calls[0].url,/\/auth\/v1\/user$/);assert.equal(verified.principal.role,'payment-executor');assert.equal(verified.principal.tenantId,execution.tenantId);
  await assert.rejects(authenticatePaymentMachine(request(),{env,now,fetchImpl:async()=>new Response(JSON.stringify({id:execution.authorisation.actor}))}),{code:'payment_machine_denied'});
});
test('browser reviewers cannot execute and investigators cannot authorise or read executions',async()=>{
  let calls=0;const fetchImpl=()=>{calls++;assert.fail('No RPC allowed');};
  for(const role of ['investigator','reviewer']){
    const principal={userId:execution.authorisation.actor,tenantId:execution.tenantId,role};
    const payments=createHostedPayments({env,now,fetchImpl,principal,accessToken:token(principal.userId)});
    await assert.rejects(payments.execute(execution.id),{code:'payment_role_required'});
    await assert.rejects(payments.reconcile(execution.id),{code:'payment_role_required'});
    if(role==='investigator')await assert.rejects(payments.authorise({}),{code:'payment_role_required'});
  }
  assert.equal(calls,0);
});
test('exact reviewer authorisation is independently read back without a Stripe call',async()=>{
  const calls=[],principal={userId:execution.authorisation.actor,tenantId:execution.tenantId,role:'reviewer'};
  const payments=createHostedPayments({env,now,principal,accessToken:token(principal.userId),fetchImpl:async(url,options)=>{calls.push({url:String(url),body:JSON.parse(options.body)});return new Response(JSON.stringify(execution));}});
  const body={operationId:execution.operationId,expectedCaseRevision:4,originalApprovalId:execution.originalApproval.id,originalFingerprint:execution.originalApproval.fingerprint,expectedAmountMinor:2000,mapping:execution.mapping,note:execution.authorisation.note,commandId:'60000000-0000-4000-8000-000000000099'};
  const result=await payments.authorise(body);assert.equal(result.authorisationReadbackVerified,true);assert.equal(result.submitted,false);assert.equal(calls.length,2);
  assert.match(calls[0].url,/refund_runtime_authorise_execution$/);assert.match(calls[1].url,/refund_runtime_read_execution$/);
  await assert.rejects(payments.authorise({...body,expectedAmountMinor:1000}),{code:'execution_authorisation_unconfirmed'});
});
test('lost hosted authorisation response remains unresolved with redacted details',async()=>{
  const principal={userId:execution.authorisation.actor,tenantId:execution.tenantId,role:'reviewer'};
  const payments=createHostedPayments({env,now,principal,accessToken:token(principal.userId),fetchImpl:async()=>{throw Error('private remote token');}});
  const body={operationId:execution.operationId,expectedCaseRevision:4,originalApprovalId:execution.originalApproval.id,originalFingerprint:execution.originalApproval.fingerprint,expectedAmountMinor:2000,mapping:execution.mapping,note:'Synthetic reviewer decision.',commandId:'60000000-0000-4000-8000-000000000099'};
  await assert.rejects(payments.authorise(body),error=>error.code==='execution_authorisation_unconfirmed'&&error.uncertain&&!error.message.includes('private'));
});
test('lost post-authorisation readback remains uncertain rather than inviting a new decision',async()=>{
  const principal={userId:execution.authorisation.actor,tenantId:execution.tenantId,role:'reviewer'};let calls=0;
  const payments=createHostedPayments({env,now,principal,accessToken:token(principal.userId),fetchImpl:async()=>{if(++calls===1)return Response.json(execution);throw Error('Lost saved readback');}});
  const body={operationId:execution.operationId,expectedCaseRevision:4,originalApprovalId:execution.originalApproval.id,originalFingerprint:execution.originalApproval.fingerprint,expectedAmountMinor:2000,mapping:execution.mapping,note:execution.authorisation.note,commandId:'60000000-0000-4000-8000-000000000099'};
  await assert.rejects(payments.authorise(body),error=>error.code==='execution_authorisation_unconfirmed'&&error.uncertain===true);assert.equal(calls,2);
});
test('hosted payment routes remain disabled before any authentication request',async()=>{
  let calls=0; const handler=createHostedHandler({env:{...env,REFUND_OFFICE_PAYMENT_EXECUTION:'disabled'},fetchImpl:()=>{calls++;assert.fail('External call');},now});
  for(const path of ['/api/payment-executions',`/api/machine/payments/${execution.id}/execute`]){
    const machine=path.includes('/machine/');
    const response=await handler(new Request(env.REFUND_OFFICE_PUBLIC_ORIGIN+path,{method:'POST',headers:{'content-type':'application/json',...(!machine?{origin:env.REFUND_OFFICE_PUBLIC_ORIGIN}:{})},body:'{}'}));
    assert.equal(response.status,503);assert.equal((await response.json()).error.code,'payment_execution_disabled');
  }assert.equal(calls,0);
});
test('hosted machine handler exercises saved intent, one POST and independent receipt with injected transport only',async()=>{
  const e=executionFixture(),log=[],{repository,state}=repositoryFixture(e,log,{now}),provider=providerFixture(e,log);
  const methods={claim_execution:b=>repository.claimExecution({executionId:b.p_execution_id}),read_execution:()=>repository.readExecution(),begin_submission:b=>repository.beginSubmission({fence:b.p_fence}),save_refund_reference:b=>repository.saveRefundReference({fence:b.p_fence,refund:b.p_refund}),record_refund_readback:b=>repository.recordRefundReadback({fence:b.p_fence,refund:b.p_refund}),note_execution_unknown:b=>repository.noteExecutionUnknown({fence:b.p_fence,errorCode:b.p_error_code})};
  const fetchImpl=async(url,options)=>{
    const parsed=new URL(url);let value;
    if(parsed.hostname==='fixture.supabase.co'){
      if(parsed.pathname==='/auth/v1/user')value={id:executorId,is_anonymous:false};
      else{const name=parsed.pathname.split('/').at(-1).replace('refund_runtime_','');assert.ok(methods[name],name);value=await methods[name](JSON.parse(options.body));}
    }else{
      assert.equal(parsed.hostname,'api.stripe.com');
      if(parsed.pathname==='/v1/account')value=await provider.readAccount();
      else if(parsed.pathname.startsWith('/v1/payment_intents/'))value=await provider.readPaymentIntent(e.mapping.paymentIntentId);
      else if(parsed.pathname.startsWith('/v1/charges/'))value=await provider.readCharge('ch_Synthetic1');
      else if(parsed.pathname==='/v1/refunds'){assert.equal(options.headers['Idempotency-Key'],e.idempotencyKey);assert.equal(new URLSearchParams(options.body).get('amount'),'2000');value=await provider.createRefund(e.payload);}
      else{assert.equal(parsed.pathname,'/v1/refunds/re_Synthetic1');value=await provider.readRefund('re_Synthetic1');}
    }return Response.json(value);
  };
  const handler=createHostedHandler({env:{...env,STRIPE_SECRET_KEY:'sk_test_SyntheticOnly'},fetchImpl,now});
  const response=await handler(new Request(`${env.REFUND_OFFICE_PUBLIC_ORIGIN}/api/machine/payments/${e.id}/execute`,{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+token(executorId),'x-refund-payment-key':env.REFUND_OFFICE_PAYMENT_MACHINE_KEY},body:'{}'}));
  assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).readbackVerified,true);assert.equal(state.status,'succeeded');
  assert.deepEqual(log,['claim','account:get','payment:get','charge:get','intent:save','execution:get','refund:post','reference:save','execution:get','refund:get','readback:save','execution:get']);
});
