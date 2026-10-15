import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createHostedHandler } from '../server/hosted-api.mjs';
import { createHostedAuth } from '../server/hosted-auth.mjs';
import { createSupabaseSponsorLedger } from '../server/supabase-sponsor-ledger.mjs';
import { createVercelRuntime } from '../integrations/vercel/api/runtime.mjs';

const tenantId='00000000-0000-4000-8000-000000000012';
const userId='40000000-0000-4000-8000-000000000001';
const origin='https://refund-offline-fixture.invalid';
const fingerprint='a'.repeat(64);
const token=()=>`fixture.${Buffer.from(JSON.stringify({sub:userId,role:'authenticated',exp:Math.floor(Date.now()/1000)+1800})).toString('base64url')}.not-a-signature`;
const environment=()=>({REFUND_OFFICE_NETWORK:'enabled',REFUND_OFFICE_HOSTED:'enabled',REFUND_OFFICE_WORKING_STORE:'supabase',REFUND_OFFICE_ENABLED_INTEGRATIONS:'supabase-runtime',
 REFUND_OFFICE_PUBLIC_ORIGIN:origin,REFUND_OFFICE_HOSTED_TENANT_ID:tenantId,SUPABASE_URL:'https://offline-fixture.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fake',
 REFUND_OFFICE_SESSION_SECRET:Buffer.alloc(32,7).toString('base64url'),REFUND_OFFICE_MACHINE_KEY:'fixture'.repeat(6),REFUND_OFFICE_MACHINE_USER_ID:userId});
const order={id:'SYN-O1',totalMinor:2000,lines:[{id:'SYN-L1',name:'Travel mug',ordered:1,packed:0,unitAmountMinor:2000}],delivery:{disputed:false}};
const initialCase=()=>({id:'SYN-C1',caseId:'RF-1',orderId:order.id,title:'Missing mug',complaint:'The travel mug is missing.',revision:3,status:'paused',stage:'review',outcome:'awaiting-approval',
 proposedAmountMinor:2000,fingerprint,proposal:{source:'local',issue:'item_missing',lineId:'SYN-L1',amountMinor:2000,reason:'Saved packing record.',evidenceIds:['packing:SYN-O1']},
 evidence:[{id:'packing:SYN-O1',title:'Packing',body:'One mug missing.'}],checks:[],events:[],approval:null,operationId:null,receipt:null,intakeRequestId:'request-1'});
function fixture({role='reviewer',override,env:envOverride}={}) {
 const env=envOverride||environment(),calls=[],sessions=new Map(),rows=new Map();let item=initialCase(),claimCount=0;
 const context=()=>({tenantId,userId,role,title:'Synthetic fixture',synthetic:true});
 const request=()=>({id:'request-1',eventId:'form:1',caseId:item.id,orderId:order.id,status:item.outcome||'queued'});
 const workspace=()=>({tenantId,mode:'synthetic-only',paymentsEnabled:false,cases:[structuredClone(item)],orders:[order],policy:{version:1,limitMinor:2500},intakeRequests:[request()]});
 const fetchImpl=async(url,init={})=>{
  const path=new URL(url).pathname,body=init.body?JSON.parse(init.body):null;calls.push({url:String(url),path,body,init});
  assert.equal(new URL(url).hostname,'offline-fixture.supabase.co','Tests never send a provider request');
  const custom=await override?.({url,path,body,init,calls,sessions,rows});if(custom)return custom;
  if(path==='/auth/v1/token')return Response.json({access_token:token(),refresh_token:'fixture-refresh-token'});
  if(path==='/auth/v1/user')return Response.json({id:userId,is_anonymous:false});
  if(path==='/auth/v1/logout')return new Response(null,{status:204});
  if(path.endsWith('/refund_runtime_session_context'))return Response.json(context());
  if(path.endsWith('/refund_runtime_hosted_session')){
   let row=sessions.get(body.p_session_id);
   if(body.p_action==='create'){row={...context(),sessionId:body.p_session_id,generation:1,sessionExpiresAt:new Date(Date.now()+7*86400000).toISOString(),revoked:false};sessions.set(row.sessionId,row);}
   else if(!row||(body.p_action==='revoke'?body.p_generation>row.generation:row.revoked||row.generation!==body.p_generation))return Response.json({code:'42501',message:'private session details'},{status:403});
   else if(body.p_action==='rotate')row.generation++;
   else if(body.p_action==='revoke')row.revoked=true;
   return Response.json(row);
  }
  if(path.endsWith('/refund_runtime_read_workspace'))return Response.json(workspace());
  if(path.endsWith('/refund_runtime_read_case'))return Response.json(item);
  if(path.endsWith('/refund_runtime_approve_and_reserve')){
   item={...item,revision:4,status:'paused',stage:'payments',outcome:'approved-not-submitted',operationId:'reserved-1',approval:{state:'approved',actor:userId,amountMinor:body.p_expected_amount_minor,fingerprint:body.p_expected_fingerprint,note:body.p_note}};
   return Response.json({case:item,operation:{id:'reserved-1',status:'reserved',amountMinor:2000,submissionEnabled:false},replayed:false});
  }
  if(path.endsWith('/refund_runtime_claim_intake')){
   if(claimCount++)return Response.json(null);
   item={...item,status:'running',stage:'policy',outcome:null,approval:null,operationId:null,receipt:null};
   return Response.json({requestId:'request-1',caseId:item.id,fence:1,leaseUntil:new Date(Date.now()+30000).toISOString(),case:item,order,evidence:item.evidence,policy:{version:1,limitMinor:2500}});
  }
  if(path.endsWith('/refund_runtime_finish_intake')){item={...item,revision:4,status:'paused',stage:'review',outcome:'awaiting-approval',proposal:body.p_proposal};return Response.json({case:item,request:request()});}
  if(path.endsWith('/refund_runtime_sponsor_action')){
   const p=body.p_input;let row=rows.get(p.key);
   if(body.p_action==='begin'){row=row||[...rows.values()].find(r=>r.commandId===p.commandId&&r.action===p.action);if(row)return Response.json({created:false,record:row});row={...p,tenantId,state:'pending',result:null,errorCode:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};rows.set(p.key,row);return Response.json({created:true,record:row});}
   if(body.p_action==='get')return Response.json(row||null);
   if(body.p_action==='list')return Response.json([...rows.values()].filter(r=>r.caseId===p.caseId&&r.revision===p.revision));
   if(body.p_action==='update'){Object.assign(row,{state:p.state,result:p.result,errorCode:p.errorCode});return Response.json(row);}
  }
  assert.fail(`Unexpected injected request: ${path}`);
 };
 const handler=createHostedHandler({env,fetchImpl});
 const call=(path,method='GET',body,cookie,headers={})=>handler(new Request(origin+path,{method,headers:{...(body!==undefined?{'content-type':'application/json',origin}:{}),...(cookie?{cookie}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})}));
 return {env,calls,sessions,rows,fetchImpl,handler,call,get item(){return item;},async login(){const response=await call('/api/session','POST',{email:'fixture@example.invalid',password:'fake-password'});assert.equal(response.status,200,await response.clone().text());return {cookie:response.headers.get('set-cookie').split(';')[0],body:await response.json()};}};
}

test('hosted mode stays disconnected before request, credential or session access',async()=>{
 const env=new Proxy({},{get(_t,key){assert.equal(key,'REFUND_OFFICE_NETWORK');return 'offline';}});
 const handler=createHostedHandler({env,fetchImpl(){assert.fail('No request while offline');}});
 const response=await handler(new Proxy({},{get(){assert.fail('Request touched while offline');}}));
 assert.equal(response.status,503);assert.equal((await response.json()).error.code,'hosted_disconnected');
});
test('all hosted gates are required and public config contains no server configuration',async()=>{
 for(const change of [{REFUND_OFFICE_HOSTED:'disabled'},{REFUND_OFFICE_WORKING_STORE:'sqlite'},{REFUND_OFFICE_ENABLED_INTEGRATIONS:'supabase'}]){
  const f=fixture({env:{...environment(),...change}});assert.equal((await f.call('/api/session')).status,503);assert.equal(f.calls.length,0);
 }
 const env=new Proxy(environment(),{get(target,key){if(['SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','REFUND_OFFICE_SESSION_SECRET'].includes(key))assert.fail('Public config read a credential');return target[key];}});
 const f=fixture({env}),response=await f.call('/api/public-config');assert.equal(response.status,200);assert.deepEqual(await response.json(),{mode:'hosted-supabase',passwordSignIn:true,paymentsEnabled:false,machineScheduling:true});
});
test('sign-in verifies user and durable membership then issues only an encrypted secure cookie',async()=>{
 const f=fixture(),{cookie,body}=await f.login();assert.equal(body.mode,'hosted-supabase');assert.equal(body.session.userId,userId);assert.equal(body.session.profileId,userId);assert.equal(body.profiles,undefined);
 assert.doesNotMatch(cookie,/fixture-refresh-token|fake-password|not-a-signature|fixture@example/);assert.equal(f.calls.length,3);assert.match(f.calls[0].url,/grant_type=password/);
 const response=await f.call('/api/session','POST',{email:'fixture@example.invalid',password:'fake-password'});assert.match(response.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Strict; Path=\//);
 const session=await f.call('/api/session','GET',undefined,cookie);assert.equal((await session.json()).authenticated,true);assert.equal(f.calls.at(-1).body.p_action,'check');
});
test('origin checks and strict sign-in input stop forged roles before account calls',async()=>{
 const f=fixture();
 for(const headers of [{origin:'https://attacker.invalid'},{origin:''}])assert.equal((await f.call('/api/session','POST',{email:'fixture@example.invalid',password:'fake-password'},null,headers)).status,403);
 assert.equal((await f.call('/api/session','POST',{email:'fixture@example.invalid',password:'fake-password',role:'reviewer'})).status,400);
 assert.equal((await f.call('/api/session','POST',{profileId:'reviewer'})).status,400);assert.equal(f.calls.length,0);
 const wrong=await f.handler(new Request('https://other.invalid/api/session'));assert.equal(wrong.status,403);
});
test('tampered cookies and wrong authenticated identities never reach workspace access',async()=>{
 const f=fixture(),{cookie}=await f.login(),count=f.calls.length;
 const changed=cookie.slice(0,-1)+(cookie.at(-1)==='A'?'B':'A');
 assert.equal((await (await f.call('/api/session','GET',undefined,changed)).json()).authenticated,false);assert.equal(f.calls.length,count);
 const wrong=fixture({override:({path})=>path==='/auth/v1/user'?Response.json({id:'90000000-0000-4000-8000-000000000001'}):null});
 const response=await wrong.call('/api/session','POST',{email:'fixture@example.invalid',password:'fake-password'});assert.equal(response.status,401);assert.equal(wrong.calls.length,2);
});
test('refresh rotates durable generation and logout makes the former cookie unusable',async()=>{
 const f=fixture(),first=await f.login();
 const response=await f.call('/api/session/refresh','POST',{},first.cookie);assert.equal(response.status,200);const second=response.headers.get('set-cookie').split(';')[0];
 assert.equal((await (await f.call('/api/session','GET',undefined,first.cookie)).json()).authenticated,false);
 assert.equal((await (await f.call('/api/session','GET',undefined,second)).json()).authenticated,true);
 const logout=await f.call('/api/session','DELETE',{},second),result=await logout.json();assert.equal(result.durableRevocationConfirmed,true);assert.equal(result.providerRevocationConfirmed,true);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
 assert.equal((await (await f.call('/api/session','GET',undefined,second)).json()).authenticated,false);
});
test('unconfirmed logout is explicit while browser credentials are cleared',async()=>{
 const f=fixture({override:({path})=>path==='/auth/v1/logout'?Response.json({message:'private provider details'},{status:503}):null}),{cookie}=await f.login();
 const response=await f.call('/api/session','DELETE',{},cookie),body=await response.json();assert.equal(body.durableRevocationConfirmed,true);assert.equal(body.providerRevocationConfirmed,false);assert.match(response.headers.get('set-cookie'),/Max-Age=0/);assert.doesNotMatch(JSON.stringify(body),/private provider/);
});
test('expired access is refreshed solely to revoke the existing application session',async()=>{
 const f=fixture();let now=Date.now();const auth=createHostedAuth({env:f.env,fetchImpl:f.fetchImpl,now:()=>now});
 const logged=await auth.signIn({email:'fixture@example.invalid',password:'fake-password'}),cookie=logged.cookie.split(';')[0];
 now+=3600*1000;const future=`fixture.${Buffer.from(JSON.stringify({sub:userId,role:'authenticated',exp:Math.floor(now/1000)+1800})).toString('base64url')}.fake`;
 const calls=[];const expiredAuth=createHostedAuth({env:f.env,now:()=>now,fetchImpl:async(url,init)=>{calls.push({url:String(url),body:init.body?JSON.parse(init.body):null});return new URL(url).pathname==='/auth/v1/token'?Response.json({access_token:future,refresh_token:'refreshed-for-revocation'}):f.fetchImpl(url,init);}});
 const result=await expiredAuth.signOut(new Request(origin+'/api/session',{headers:{cookie}}));
 assert.equal(result.body.durableRevocationConfirmed,true);assert.equal(result.body.logoutPending,false);assert.match(result.cookie,/Max-Age=0/);
 assert.match(calls[0].url,/grant_type=refresh_token/);assert.deepEqual(calls.filter(c=>c.url.includes('/rpc/')).map(c=>c.body.p_action),['revoke']);
 assert.doesNotMatch(JSON.stringify(result.body),/refreshed-for-revocation|fake|accessToken/);
});
test('lost revocation acknowledgement retains only logout retry and cannot reopen the workspace',async()=>{
 let lose=true;const f=fixture({override:({body,sessions})=>{if(body?.p_action==='revoke'&&lose){lose=false;sessions.get(body.p_session_id).revoked=true;throw new Error('Lost revoke reply');}}}),{cookie}=await f.login();
 const first=await f.call('/api/session','DELETE',{},cookie),body=await first.json(),pending=first.headers.get('set-cookie').split(';')[0];
 assert.equal(body.authenticated,false);assert.equal(body.logoutPending,true);assert.equal(body.durableRevocationConfirmed,false);assert.doesNotMatch(first.headers.get('set-cookie'),/Max-Age=0/);
 const before=f.calls.length,session=await (await f.call('/api/session','GET',undefined,pending)).json();assert.equal(session.logoutPending,true);assert.equal(session.authenticated,false);
 for(const [path,input]of[['/api/session/refresh',{}],['/api/session',{email:'fixture@example.invalid',password:'fake-password'}],['/api/cases/SYN-C1/approve',{}]])assert.equal((await f.call(path,'POST',input,pending)).status,401);
 assert.equal((await f.call('/api/bootstrap','GET',undefined,pending)).status,401);assert.equal(f.calls.length,before);
 const retry=await f.call('/api/session','DELETE',{},pending),done=await retry.json();assert.equal(done.durableRevocationConfirmed,true);assert.equal(done.logoutPending,false);assert.match(retry.headers.get('set-cookie'),/Max-Age=0/);
 assert.equal((await (await f.call('/api/session','GET',undefined,cookie)).json()).authenticated,false);
});
test('Web Request bootstrap uses the actual service and repository with verified cloud labels',async()=>{
 const f=fixture(),{cookie}=await f.login();const response=await f.call('/api/bootstrap','GET',undefined,cookie),body=await response.json();
 assert.equal(response.status,200);assert.equal(body.capabilities.storage,'supabase');assert.equal(body.capabilities.authentication,'supabase-verified');assert.equal(body.capabilities.payments,'disabled');assert.equal(body.runtime.worker.enabled,false);assert.equal(body.cases[0].approval.state,'required');
 assert.ok(f.calls.some(call=>call.path.endsWith('/refund_runtime_read_workspace')));
 const report=await f.call('/api/cases/SYN-C1/report','GET',undefined,cookie);assert.doesNotMatch(await report.text(),/Local PostgreSQL rehearsal|No online account/);
});
test('configured separate execution is scoped honestly across case outputs without reading provider keys',async()=>{
 const raw={...environment(),REFUND_OFFICE_PAYMENT_EXECUTION:'stripe-test',REFUND_OFFICE_ENABLED_INTEGRATIONS:'supabase-runtime,stripe-runtime'};
 const env=new Proxy(raw,{get(target,key){if(/^(STRIPE_|OPENAI_|ANTHROPIC_)/.test(String(key)))assert.fail('Case read touched a provider credential');return target[key];}});
 const f=fixture({env}),{cookie}=await f.login();await f.call('/api/cases/SYN-C1/approve','POST',{expectedRevision:3,expectedAmountMinor:2000,fingerprint,note:'The saved packing record supports this amount.',commandId:randomUUID()},cookie);
 for(const path of ['/api/bootstrap','/api/cases/SYN-C1','/api/cases/SYN-C1/export','/api/cases/SYN-C1/report','/api/cases/SYN-C1/briefing','/api/cases/SYN-C1/board-export']){
  const response=await f.call(path,'GET',undefined,cookie);assert.equal(response.status,200,path);const text=await response.text();assert.match(text,/original case reservation|original reservation|original-reservation/);assert.doesNotMatch(text,/Not submitted, not paid; payment execution is disabled|No payment has been submitted/);
 }
 const bootstrap=await (await f.call('/api/bootstrap','GET',undefined,cookie)).json();assert.equal(bootstrap.capabilities.separateTestExecutionConfigured,true);assert.equal(bootstrap.capabilities.paymentSubmission,false);
});
test('an investigator cannot approve and a reviewer must send the exact saved decision',async()=>{
 const investigator=fixture({role:'investigator'}),access=await investigator.login();
 assert.equal((await investigator.call('/api/cases/SYN-C1/approve','POST',{},access.cookie)).status,403);assert.ok(!investigator.calls.some(call=>call.path.endsWith('/refund_runtime_approve_and_reserve')));
 const f=fixture(),{cookie}=await f.login(),commandId=randomUUID();
 const response=await f.call('/api/cases/SYN-C1/approve','POST',{expectedRevision:3,expectedAmountMinor:2000,fingerprint,note:'The saved packing evidence confirms one missing mug.',commandId},cookie);
 assert.equal(response.status,200);const saved=await response.json();assert.equal(saved.status,'reserved');assert.equal(saved.receipt,null);assert.equal(saved.paymentSubmissionEnabled,false);
 assert.equal(f.calls.find(call=>call.path.endsWith('/refund_runtime_approve_and_reserve')).body.p_command_id,commandId);
 assert.ok(f.calls.at(-1).path.endsWith('/refund_runtime_read_case'));
});
test('machine invocation requires a separate key and verified investigator and processes one bounded claim',async()=>{
 const f=fixture({role:'investigator'}),headers={origin:'',authorization:`Bearer ${token()}`,'x-refund-machine-key':f.env.REFUND_OFFICE_MACHINE_KEY};
 assert.equal((await f.call('/api/machine/investigate','POST',{},null,{...headers,'x-refund-machine-key':'bad'})).status,401);assert.equal(f.calls.length,0);
 const response=await f.call('/api/machine/investigate','POST',{},null,headers);assert.equal(response.status,200);assert.equal((await response.json()).case.outcome,'awaiting-approval');
 await new Promise(resolve=>setTimeout(resolve,180));assert.equal(f.calls.filter(call=>call.path.endsWith('/refund_runtime_claim_intake')).length,1);assert.equal(f.item.approval,null);
 const empty=await f.call('/api/machine/investigate','POST',{},null,headers);assert.deepEqual(await empty.json(),{empty:true});
 const reviewer=fixture();assert.equal((await reviewer.call('/api/machine/investigate','POST',{},null,headers)).status,403);
 assert.equal((await f.call('/api/machine/approve','POST',{},null,headers)).status,404);
});
test('hosted sponsor status uses the durable journal and advisory analysis leaves saved decisions unchanged',async()=>{
 const f=fixture(),{cookie}=await f.login();
 const status=await f.call('/api/cases/SYN-C1/sponsor-actions/status','GET',undefined,cookie),value=await status.json();assert.equal(status.status,200);assert.equal(value.actions.voice.configured,false);assert.deepEqual(value.records,[]);assert.ok(f.calls.some(call=>call.body?.p_action==='list'));
 const before=JSON.stringify(f.item),response=await f.call('/api/cases/SYN-C1/analysis','POST',{expectedRevision:3},cookie);assert.equal(response.status,200);const analysis=await response.json();assert.equal(analysis.advisoryOnly,true);assert.equal(analysis.changesSavedCase,false);assert.equal(JSON.stringify(f.item),before);
});
test('bounded authentication transport rejects malformed and oversized responses without leaking provider bodies',async()=>{
 for(const response of [()=>new Response('private non JSON'),()=>new Response('x'.repeat(128*1024+1)),()=>Response.json({message:'private account detail'},{status:500})]){
  const auth=createHostedAuth({env:environment(),fetchImpl:async()=>response()});await assert.rejects(()=>auth.signIn({email:'fixture@example.invalid',password:'fake-password'}),error=>error.status===502&&!error.message.includes('private'));
 }
 const auth=createHostedAuth({env:environment(),timeoutMs:5,fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('private timeout')),{once:true}))});await assert.rejects(()=>auth.signIn({email:'fixture@example.invalid',password:'fake-password'}),{code:'hosted_auth_unavailable'});
});
test('durable sponsor begin and update verify independent saved identities before reuse',async()=>{
 const f=fixture(),ledger=createSupabaseSponsorLedger({env:f.env,tenantId,getAccessToken:async()=>token(),fetchImpl:f.fetchImpl});
 const input={key:'b'.repeat(64),tenantId,caseId:'SYN-C1',revision:3,action:'port',commandId:randomUUID(),payloadHash:'c'.repeat(64)};
 assert.equal((await ledger.begin(input)).created,true);assert.equal(f.calls.length,2);assert.equal(f.calls[1].body.p_action,'get');
 assert.equal((await ledger.begin(input)).created,false);
 const saved=await ledger.update(input.key,{state:'succeeded',result:{verified:true,identifier:'refund-office'}});assert.equal(saved.state,'succeeded');assert.equal((await ledger.list(input)).length,1);
 await assert.rejects(()=>ledger.update(input.key,{state:'pending'}),{code:'sponsor_journal_input'});
 const off=createSupabaseSponsorLedger({env:{REFUND_OFFICE_NETWORK:'offline'},getAccessToken(){assert.fail('No session read');},fetchImpl(){assert.fail('No network');}});await assert.rejects(()=>off.begin(input),{code:'hosted_disconnected'});
});
test('sponsor journal lost acknowledgement and unrelated readback block a second provider action',async()=>{
 const f=fixture({override:({body})=>body?.p_action==='get'?Response.json(null):null}),ledger=createSupabaseSponsorLedger({env:f.env,tenantId,getAccessToken:async()=>token(),fetchImpl:f.fetchImpl});
 const input={key:'b'.repeat(64),tenantId,caseId:'SYN-C1',revision:3,action:'port',commandId:randomUUID(),payloadHash:'c'.repeat(64)};
 await assert.rejects(()=>ledger.begin(input),error=>error.code==='sponsor_journal_unverified'&&error.uncertain);assert.equal(f.calls.length,2);
 const lost=createSupabaseSponsorLedger({env:environment(),tenantId,getAccessToken:async()=>token(),fetchImpl:async()=>{throw new Error('private');}});await assert.rejects(()=>lost.begin(input),error=>error.uncertain&&!error.message.includes('private'));
});
test('unknown journal readback retains its acknowledged provider identity without reposting',async()=>{
 const f=fixture({override:({body,rows})=>{if(body?.p_action==='update'&&body.p_input.state==='unknown'&&body.p_input.result===null){const row=rows.get(body.p_input.key);Object.assign(row,{state:'unknown',errorCode:body.p_input.errorCode});return Response.json(row);}}});
 const ledger=createSupabaseSponsorLedger({env:f.env,tenantId,getAccessToken:async()=>token(),fetchImpl:f.fetchImpl}),key='d'.repeat(64);
 await ledger.begin({key,tenantId,caseId:'SYN-C1',revision:3,action:'miro-card-'+('1'.repeat(24)),commandId:randomUUID(),payloadHash:'e'.repeat(64)});
 const result={id:'fixture-note',boardId:'fixture-board',expectedContent:'Saved case'};
 await ledger.update(key,{state:'acknowledged',result});const unknown=await ledger.update(key,{state:'unknown',errorCode:'readback_unavailable'});
 assert.deepEqual(unknown.result,result);assert.equal(f.calls.at(-1).body.p_action,'get');
});
test('Vercel bridge remains gated before touching an incoming request',async()=>{
 const response={headers:{},setHeader(k,v){this.headers[k]=v;},end(value){this.body=value;}};
 await createVercelRuntime({env:{REFUND_OFFICE_NETWORK:'offline'},handler(){assert.fail('Handler while off');}})(new Proxy({},{get(){assert.fail('Request while off');}}),response);
 assert.equal(response.statusCode,503);assert.doesNotMatch(response.body,/secret/);
});
test('hosted deployment and n8n artifacts are additive, inactive and contain no approval or payment hook',()=>{
 const workflow=JSON.parse(readFileSync(new URL('../integrations/n8n/hosted-intake.workflow.json',import.meta.url)));assert.equal(workflow.active,false);assert.equal(workflow.pinData&&Object.keys(workflow.pinData).length,0);
 const requests=workflow.nodes.filter(node=>node.type==='n8n-nodes-base.httpRequest');assert.equal(requests.length,2);for(const node of requests){assert.match(node.parameters.url,/\.invalid\/api\/machine\/(intake|investigate)$/);assert.equal(node.parameters.genericAuthType,'httpCustomAuth');assert.equal(node.retryOnFail,false);assert.equal(node.credentials,undefined);}
 const legacy=JSON.parse(readFileSync(new URL('../integrations/vercel/vercel.json',import.meta.url)));assert.equal(legacy.rewrites[0].destination,'/api/offline');
 const hosted=JSON.parse(readFileSync(new URL('../integrations/vercel/hosted.vercel.json',import.meta.url)));assert.equal(hosted.rewrites[0].destination,'/api/runtime');assert.equal(hosted.buildCommand,'npm run build');
});

test('explicit hosted tracing returns bounded current-request spans on authenticated investigation only',async()=>{
 const f=fixture({role:'investigator',env:{...environment(),REFUND_OFFICE_HOSTED_TRACING:'enabled'}});
 const headers={origin:'',authorization:`Bearer ${token()}`,'x-refund-machine-key':f.env.REFUND_OFFICE_MACHINE_KEY};
 const denied=await f.call('/api/machine/investigate','POST',{},null,{...headers,'x-refund-machine-key':'wrong'});assert.equal(denied.status,401);assert.equal(f.calls.length,0);
 const response=await f.call('/api/machine/investigate','POST',{},null,headers),body=await response.json();assert.equal(response.status,200);
 assert.equal(body.recordedTrace.recordingAvailable,true);assert.equal(body.recordedTrace.spans.length,4);assert.equal(body.recordedTrace.durable,false);assert.equal(body.recordedTrace.uploaded,false);assert.equal(body.recordedTrace.scope,'request');
 const span=body.recordedTrace.spans.find(x=>x.name==='refund.investigation');assert.equal(span.attributes.caseId,body.case.caseId);assert.equal(span.attributes['case.revision'],body.case.revision);assert.equal(span.attributes.amountMinor,body.case.proposedAmountMinor);
 assert.doesNotMatch(JSON.stringify(body.recordedTrace),/travel mug|fixture-refresh|not-a-signature|Bearer|Saved packing|fixture@example/);
 const empty=await (await f.call('/api/machine/investigate','POST',{},null,headers)).json();assert.equal(empty.empty,true);assert.equal(empty.recordedTrace.spans.length,0);
 const off=fixture({role:'investigator'}),without=await (await off.call('/api/machine/investigate','POST',{},null,{origin:'',authorization:`Bearer ${token()}`,'x-refund-machine-key':off.env.REFUND_OFFICE_MACHINE_KEY})).json();assert.equal(Object.hasOwn(without,'recordedTrace'),false);
});
