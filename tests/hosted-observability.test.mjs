import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedObserver, HOSTED_TRACE_SCOPE } from '../server/hosted-observability.mjs';
import { redactTraceAttributes } from '../server/observability.mjs';
test('hosted recording remains disabled despite ambient credentials',()=>{
  assert.equal(createHostedObserver({env:{ARIZE_API_KEY:'not-a-real-key',REFUND_OFFICE_NETWORK:'enabled'}}),undefined);
  assert.equal(createHostedObserver({env:{REFUND_OFFICE_HOSTED_TRACING:'true'}}),undefined);
});
test('explicit hosted recorder is bounded request memory, never a durable or uploaded result',async()=>{
  const recorder=createHostedObserver({env:{REFUND_OFFICE_HOSTED_TRACING:'enabled',ARIZE_API_KEY:'not-a-real-key'}});
  for(let i=0;i<140;i++)assert.equal(await recorder.span('refund.investigation',{synthetic:true,complaint:'private text'},async()=>i),i);
  await recorder.flush();const status=recorder.status();
  assert.equal(status.retainedSpans,128);assert.equal(status.droppedSpans,12);assert.equal(status.maxBytes,256*1024);assert.equal(status.network,false);assert.equal(status.storage,'memory');assert.equal(status.writeState,'memory-only');
  assert.equal(HOSTED_TRACE_SCOPE.durable,false);assert.equal(HOSTED_TRACE_SCOPE.uploaded,false);assert.equal(HOSTED_TRACE_SCOPE.scope,'request');
  assert.doesNotMatch(JSON.stringify(recorder.snapshot()),/private text|not-a-real-key/);
  assert.equal(createHostedObserver({env:{REFUND_OFFICE_HOSTED_TRACING:'enabled'}}).snapshot().spans.length,0);
});
test('trace provenance allows safe model metadata without arbitrary identifiers or instructions',()=>{
  assert.deepEqual(redactTraceAttributes({provider:'openai',analyser:'openai',analyserMode:'controlled-test',model:'gpt-4.1-mini',customer:'private'}),{provider:'openai',analyser:'openai',analyserMode:'controlled-test',model:'gpt-4.1-mini'});
  for(const model of ['sk-secret','Customer Alice','https://example.test','gpt-4.1\nprivate'])assert.equal(redactTraceAttributes({model}).model,undefined);
  assert.deepEqual(redactTraceAttributes({model:'local-rules-v2',analyserMode:'local-rules'}),{model:'local-rules-v2',analyserMode:'local-rules'});
});

import { createHostedRuntime } from '../server/hosted-runtime.mjs';
function hostedFixture(observer) {
 const tenantId='40000000-0000-4000-8000-000000000012',userId='40000000-0000-4000-8000-000000000001';
 const principal={tenantId,userId,role:'investigator'};
 const accessToken=`fixture.${Buffer.from(JSON.stringify({sub:userId,role:'authenticated',exp:Math.floor(Date.now()/1000)+3000})).toString('base64url')}.unsigned-test`;
 const env={REFUND_OFFICE_NETWORK:'enabled',REFUND_OFFICE_HOSTED:'enabled',REFUND_OFFICE_WORKING_STORE:'supabase',REFUND_OFFICE_ENABLED_INTEGRATIONS:'supabase-runtime',SUPABASE_URL:'https://offline-trace-fixture.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',REFUND_OFFICE_HOSTED_TRACING:'enabled'};
 const order={id:'SYN-HOSTED-O1',totalMinor:2000,lines:[{id:'L1',name:'Travel mug',ordered:1,packed:0,unitAmountMinor:2000}],delivery:{disputed:false}};
 let item={id:'SYN-HOSTED-C1',caseId:'RF-1',orderId:order.id,title:'Missing mug',complaint:'The travel mug is missing.',revision:1,status:'ready',stage:'reception',proposedAmountMinor:0,approval:null,receipt:null,operationId:null,intakeRequestId:'intake1',checks:[],events:[],evidence:[{id:`order:${order.id}`,body:'Saved fictional order'},{id:`packing:${order.id}`,body:'Saved fictional packing record'}]};
 let claimed=false,finished=0; const calls=[];
 const fetchImpl=async(url,init)=>{
  const path=new URL(url).pathname,body=JSON.parse(init.body);calls.push(path);
  assert.equal(new URL(url).hostname,'offline-trace-fixture.supabase.co');
  if(path.endsWith('refund_runtime_claim_intake')){if(claimed)return Response.json(null);claimed=true;item={...item,status:'running',stage:'policy'};return Response.json({requestId:'intake1',caseId:item.id,fence:1,leaseUntil:new Date(Date.now()+30000).toISOString(),case:item,order,evidence:item.evidence,policy:{version:1,limitMinor:2500}});}
  if(path.endsWith('refund_runtime_finish_intake')){finished++;item={...item,revision:2,status:'paused',stage:'review',outcome:'awaiting-approval',proposedAmountMinor:2000,proposal:body.p_proposal};return Response.json({case:item,request:{id:'intake1',caseId:item.id}});}
  if(path.endsWith('refund_runtime_read_case'))return Response.json(item);
  if(path.endsWith('refund_runtime_read_workspace'))return Response.json({tenantId,mode:'synthetic-only',paymentsEnabled:false,cases:[item],orders:[order],policy:{version:1,limitMinor:2500},intakeRequests:[{id:'intake1',caseId:item.id}]});
  assert.fail('Unexpected injected hosted trace route');
 };
 return {service:createHostedRuntime({env,fetchImpl,principal,accessToken,observer,packId:'focused-12'}),principal,calls,get finished(){return finished;}};
}
test('prepared hosted path records the actual bounded investigation with controlled repository responses',async()=>{
 const observer=createHostedObserver({env:{REFUND_OFFICE_HOSTED_TRACING:'enabled'}}),f=hostedFixture(observer);
 try {
  const result=await f.service.runNext(f.principal);assert.equal(result.case.outcome,'awaiting-approval');assert.equal(result.case.proposedAmountMinor,2000);assert.equal(f.finished,1);
  const spans=observer.snapshot().spans;assert.equal(spans.length,4);assert.ok(spans.some(x=>x.name==='refund.investigation'&&x.attributes.amountMinor===2000));
  assert.ok(spans.every(x=>x.attributes.provider==='local'&&x.attributes.analyserMode==='local-rules'));
  const bootstrap=await f.service.bootstrap(f.principal);assert.equal(bootstrap.runtime.observability.storage,'memory');assert.equal(bootstrap.runtime.observability.durable,false);assert.equal(bootstrap.runtime.observability.uploaded,false);assert.equal(bootstrap.runtime.observability.scope,'request');
  assert.ok(f.calls.every(path=>path.includes('/rest/v1/rpc/refund_runtime_')));assert.doesNotMatch(JSON.stringify(spans),/travel mug|unsigned-test|Saved fictional/);
 }finally{await f.service.close();}
});
test('hosted factory uses its explicitly enabled recorder without an injected observer',async()=>{
 const f=hostedFixture();try{await f.service.runNext(f.principal);assert.equal(f.service.observabilityStatus().retainedSpans,4);assert.equal(f.service.observabilityStatus().writeState,'memory-only');}finally{await f.service.close();}
});
test('hosted observer failure cannot repeat a finish or replace the saved investigation result',async()=>{
 const f=hostedFixture({async span(_n,_a,callback){await callback();await callback();throw new Error('Sensitive collector fault');},status(){throw new Error('Sensitive collector fault');}});
 try{const result=await f.service.runNext(f.principal);assert.equal(result.case.outcome,'awaiting-approval');assert.equal(f.finished,1);assert.equal(f.service.observabilityStatus().degraded,true);assert.doesNotMatch(JSON.stringify(f.service.observabilityStatus()),/Sensitive/);}finally{await f.service.close();}
});

import { readHostedTrace } from '../server/hosted-observability.mjs';
test('hosted snapshot strips arbitrary data and cannot fail a completed operation',async()=>{
 const observer=createHostedObserver({env:{REFUND_OFFICE_HOSTED_TRACING:'enabled'}});
 await observer.span('refund.investigation',{synthetic:true,caseId:'RF-1',customerStatement:'Private'},async()=>{});
 const raw=observer.snapshot();raw.customerStatement='Private';raw.spans[0].credentials='secret';raw.spans[0].attributes.secret='secret';
 const snapshot=readHostedTrace({snapshot:()=>raw});assert.equal(snapshot.recordingAvailable,true);assert.equal(snapshot.spans.length,1);assert.doesNotMatch(JSON.stringify(snapshot),/Private|secret|credentials/);assert.equal(snapshot.durable,false);
 assert.equal(readHostedTrace({snapshot(){throw new Error('Secret');}}).recordingAvailable,false);
 assert.equal(readHostedTrace({snapshot:()=>({...raw,spans:[{...raw.spans[0],traceId:'bad'}]})}).incomplete,true);
 assert.equal(readHostedTrace(observer).incomplete,false);
 assert.equal(readHostedTrace({snapshot:()=>raw,status:()=>({...observer.status(),recordingErrors:1})}).incomplete,true);
 assert.equal(readHostedTrace({snapshot:()=>raw,status(){throw new Error('Private recorder fault');}}).incomplete,true);
});
