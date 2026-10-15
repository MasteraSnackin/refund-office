import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSponsorActionLedger } from '../server/sponsor-action-ledger.mjs';
import { createSponsorActions } from '../server/sponsor-actions.mjs';
import { createSponsorClients } from '../server/sponsor-clients.mjs';
const principal={tenantId:'tenant-1',userId:'user-1',role:'reviewer'};
const fixture=()=>({tenantId:'tenant-1',case:{id:'case-1',caseId:'RF-1',revision:3,evidence:[{id:'evidence-1',body:'Saved packing record.'}]}});
const enabled={REFUND_OFFICE_NETWORK:'enabled',REFUND_OFFICE_ENABLED_INTEGRATIONS:'elevenlabs,miro,modal,port',ELEVENLABS_API_KEY:'injected-test-value',ELEVENLABS_VOICE_ID:'test-voice',MIRO_ACCESS_TOKEN:'test',MIRO_BOARD_ID:'test-board',MODAL_EVIDENCE_URL:'https://test.modal.run/',MODAL_EVIDENCE_TOKEN:'test',PORT_API_URL:'https://api.port.io',PORT_BLUEPRINT_ID:'service',PORT_ACCESS_TOKEN:'test'};
function setup(t,overrides={}) {
 const dir=mkdtempSync(join(tmpdir(),'refund-sponsor-test-')),dbPath=join(dir,'actions.sqlite');
 let ledger=createSponsorActionLedger({dbPath});
 const packet=fixture();
 const options={env:enabled,ledger,getPacket:async()=>packet,getBriefing:async()=>({revision:3,text:'Saved summary. Human decision required. No payment sent.'}),getBoard:async()=>({format:'refund-office-case-board',caseId:'RF-1',revision:3,columns:[{id:'one',title:'Saved case',cards:[{id:'one',title:'Summary',text:'Human approval required.'}]}]}),...overrides};
 t.after(()=>{ledger.close();rmSync(dir,{recursive:true,force:true});});
 return {packet,options,actions:createSponsorActions(options),reopen(){ledger.close();ledger=createSponsorActionLedger({dbPath});options.ledger=ledger;return createSponsorActions(options);},ledger};
}
const command=()=>({expectedRevision:3,commandId:randomUUID()});
test('offline status and every action make zero calls and do not read credentials',async t=>{
 let calls=0;const env={REFUND_OFFICE_NETWORK:'offline'};
 for(const key of Object.keys(enabled).filter(key=>!key.startsWith('REFUND')))Object.defineProperty(env,key,{get(){throw Error('credential read');}});
 const {actions}=setup(t,{env,clients:new Proxy({},{get(){calls++;throw Error('client');}}),voice:{synthesise(){calls++;}}});
 const status=await actions.status(principal,'case-1');assert.equal(status.mode,'offline');assert.ok(Object.values(status.actions).every(x=>!x.configured));
 for(const method of ['generateVoice','publishMiro','processEvidence','publishPort','readMiro','readPort'])await assert.rejects(actions[method](principal,'case-1',command()),{code:'integration_disconnected'});
 assert.equal(calls,0);
});
test('credentials and global opt-in without per-provider opt-in do not enable actions',async t=>{
 const {actions}=setup(t,{env:{...enabled,REFUND_OFFICE_ENABLED_INTEGRATIONS:''}});assert.ok(Object.values((await actions.status(principal,'case-1')).actions).every(x=>!x.configured));
});
test('no durable ledger means no external action',async t=>{
 const {actions}=setup(t,{ledger:null});await assert.rejects(actions.generateVoice(principal,'case-1',command()),{code:'integration_disconnected'});
 assert.throws(()=>createSponsorActionLedger({dbPath:':memory:'}),/absolute/);
});
test('access, exact revision and stable command are checked before effects',async t=>{
 let calls=0;const {actions}=setup(t,{clients:{upsertPortService(){calls++;}}});
 await assert.rejects(actions.status({...principal,tenantId:'other'},'case-1'),{code:'case_access_denied'});
 await assert.rejects(actions.publishPort(principal,'case-1',{...command(),expectedRevision:2}),{code:'stale_case'});
 await assert.rejects(actions.publishPort(principal,'case-1',{expectedRevision:3}),{code:'command_required'});assert.equal(calls,0);
});
test('voice returns validated bytes and replays saved bytes after ledger restart',async t=>{
 let calls=0;const bytes=Buffer.from([73,68,51,4,0,0,0,0,0,0,1,2]);
 const state=setup(t,{voice:{synthesise:async input=>{calls++;assert.match(input.text,/Human decision/);return {available:true,contentType:'audio/mpeg',bytes};}}});
 const body=command();assert.deepEqual((await state.actions.generateVoice(principal,'case-1',body)).bytes,bytes);
 assert.equal((await state.reopen().generateVoice(principal,'case-1',body)).replayed,true);assert.equal(calls,1);
});
test('invalid audio never appears as generated speech and uncertain attempt cannot repost',async t=>{
 let calls=0;const {actions}=setup(t,{voice:{synthesise:async()=>{calls++;return {available:true,contentType:'audio/mpeg',bytes:Buffer.from('not audio')};}}});
 await assert.rejects(actions.generateVoice(principal,'case-1',command()),{code:'invalid_audio'});
 await assert.rejects(actions.generateVoice(principal,'case-1',command()),{code:'action_unconfirmed'});assert.equal(calls,1);
});
test('Miro saves per-card receipts, verifies independent content and replays without a duplicate',async t=>{
 let writes=0,reads=0,content;
 const state=setup(t,{clients:{createMiroNote:async(boardId,note)=>{writes++;content=note.body.data.content;return {id:'note-1',boardId};},getMiroNote:async()=>{reads++;return {id:'note-1',content};}}});
 const body=command();assert.equal((await state.actions.publishMiro(principal,'case-1',body)).verified,true);
 const restarted=state.reopen();assert.equal((await restarted.publishMiro(principal,'case-1',body)).replayed,true);assert.equal(writes,1);assert.equal(reads,1);
 assert.equal((await restarted.status(principal,'case-1')).records.length,2);
});
test('Miro lost write response remains blocked after restart, even with a new command ID',async t=>{
 let writes=0;const state=setup(t,{clients:{createMiroNote:async()=>{writes++;throw Error('Lost response');}}});
 await assert.rejects(state.actions.publishMiro(principal,'case-1',command()),{uncertain:true});
 const restarted=state.reopen();await assert.rejects(restarted.publishMiro(principal,'case-1',command()),{code:'action_unconfirmed'});
 const result=await restarted.readMiro(principal,'case-1',{expectedRevision:3});assert.ok(result.records.every(x=>x.state==='unknown'));assert.equal(writes,1);
});
test('Miro acknowledged card can recover by GET after failed readback, with no POST',async t=>{
 let reads=0,writes=0,content;
 const {actions}=setup(t,{clients:{createMiroNote:async(boardId,note)=>{writes++;content=note.body.data.content;return {id:'note-1',boardId};},getMiroNote:async()=>{reads++;if(reads===1)throw Error('read unavailable');return {id:'note-1',content};}}});
 await assert.rejects(actions.publishMiro(principal,'case-1',command()));
 const result=await actions.readMiro(principal,'case-1',{expectedRevision:3});assert.equal(result.records.find(x=>x.action.startsWith('miro-card-')).verified,true);assert.equal(writes,1);
});
test('Modal processes saved raw evidence and never changes case evidence or approvals',async t=>{
 const {actions,packet}=setup(t,{clients:{extractWithModal:async document=>{assert.equal(document.text,'Saved packing record.');return {documentId:document.id,authoritative:false,lines:[{line:1,text:document.text}]};}}});const before=JSON.stringify(packet);
 const result=await actions.processEvidence(principal,'case-1',{...command(),evidenceId:'evidence-1'});assert.equal(result.authoritative,false);assert.equal(JSON.stringify(packet),before);
 await assert.rejects(actions.processEvidence(principal,'case-1',{...command(),evidenceId:'other'}),{code:'evidence_required'});
});
test('Port sends only service metadata and confirms exact independent readback',async t=>{
 let calls=0;const state=setup(t,{clients:{upsertPortService:async service=>{calls++;assert.deepEqual(service,{identifier:'refund-office',title:'Refund Office',status:'configured-unverified'});},getPortService:async()=>({identifier:'refund-office',title:'Refund Office',properties:{readiness:'configured-unverified',humanApprovalRequired:true,liveVerified:false}})}});
 const result=await state.actions.publishPort(principal,'case-1',command());assert.equal(result.verified,true);assert.equal(calls,1);
});
test('provider GET clients validate requested IDs and use documented read-only paths',async()=>{
 const paths=[];const client=createSponsorClients({env:enabled,fetchImpl:async(url,options)=>{paths.push(url);assert.equal(options.method,'GET');return Response.json(url.includes('miro')?{id:'note-1',data:{content:'saved'}}:{entity:{identifier:'refund-office',title:'Refund Office',properties:{liveVerified:false}}});}});
 assert.equal((await client.getMiroNote('test-board','note-1')).content,'saved');assert.equal((await client.getPortService('refund-office')).identifier,'refund-office');
 assert.equal(paths[0],'https://api.miro.com/v2/boards/test-board/sticky_notes/note-1');assert.match(paths[1],/\/blueprints\/service\/entities\/refund-office$/);
});
test('sponsor actions reject missing tenant evidence and extra caller-supplied fields',async t=>{
 const {actions,packet}=setup(t);delete packet.tenantId;
 await assert.rejects(actions.status(principal,'case-1'),{code:'case_access_denied'});
 packet.tenantId=principal.tenantId;
 await assert.rejects(actions.publishPort(principal,'case-1',{...command(),amountMinor:1}),{code:'invalid_action'});
 await assert.rejects(actions.publishPort(principal,'case-1',{...command(),expectedRevision:0}),{code:'revision_required'});
});
test('concurrent identical commands make one external write while the pending record blocks another',async t=>{
 let writes=0,release,started;const entered=new Promise(resolve=>{started=resolve;}),wait=new Promise(resolve=>{release=resolve;});
 const {actions}=setup(t,{clients:{upsertPortService:async()=>{writes++;started();await wait;},getPortService:async()=>({identifier:'refund-office',title:'Refund Office',properties:{readiness:'configured-unverified',humanApprovalRequired:true,liveVerified:false}})}});
 const body=command(),first=actions.publishPort(principal,'case-1',body);await entered;
 await assert.rejects(actions.publishPort(principal,'case-1',body),{code:'action_unconfirmed'});release();await first;assert.equal(writes,1);
});
test('unknown native error text and codes are redacted while the command stays blocked',async t=>{
 const {actions}=setup(t,{clients:{upsertPortService:async()=>{throw Object.assign(new Error('secret=privatevalue'),{code:'secret=privatevalue'});}}});
 await assert.rejects(actions.publishPort(principal,'case-1',command()),error=>error.uncertain && !error.message.includes('privatevalue') && !error.code.includes('privatevalue'));
 assert.ok(!JSON.stringify(await actions.status(principal,'case-1')).includes('privatevalue'));
});
test('independent readback completes the parent Miro receipt only when every planned card is verified',async t=>{
 let content,fail=true;
 const {actions}=setup(t,{clients:{createMiroNote:async(boardId,note)=>{content=note.body.data.content;return {id:'note-1',boardId};},getMiroNote:async()=>{if(fail)throw Error('lost read');return {id:'note-1',content};}}});
 await assert.rejects(actions.publishMiro(principal,'case-1',command()));fail=false;
 const result=await actions.readMiro(principal,'case-1',{expectedRevision:3});assert.equal(result.records.find(row=>row.action==='miro').state,'succeeded');assert.equal(result.records.find(row=>row.action==='miro').verified,true);
});
test('Port can refresh independent readback without rewriting a successful receipt',async t=>{
 let reads=0;const {actions,ledger}=setup(t,{clients:{upsertPortService:async()=>({identifier:'refund-office'}),getPortService:async()=>{reads++;return {identifier:'refund-office',title:'Refund Office',properties:{readiness:'configured-unverified',humanApprovalRequired:true,liveVerified:false}};}}});
 await actions.publishPort(principal,'case-1',command());const before=ledger.list({tenantId:principal.tenantId,caseId:'case-1',revision:3});
 const refreshed=await actions.readPort(principal,'case-1',{expectedRevision:3});assert.equal(refreshed.readbackRefreshed,true);assert.equal(reads,2);assert.deepEqual(ledger.list({tenantId:principal.tenantId,caseId:'case-1',revision:3}),before);
});
test('recovered Miro parent is not rewritten by subsequent checks',async t=>{
 let content,fail=true;const {actions,ledger}=setup(t,{clients:{createMiroNote:async(boardId,note)=>{content=note.body.data.content;return {id:'note-1',boardId};},getMiroNote:async()=>{if(fail)throw Error('lost read');return {id:'note-1',content};}}});
 await assert.rejects(actions.publishMiro(principal,'case-1',command()));fail=false;
 await actions.readMiro(principal,'case-1',{expectedRevision:3});const before=ledger.list({tenantId:principal.tenantId,caseId:'case-1',revision:3});
 await actions.readMiro(principal,'case-1',{expectedRevision:3});assert.deepEqual(ledger.list({tenantId:principal.tenantId,caseId:'case-1',revision:3}),before);
});
test('terminal local journal receipts accept only exact idempotent updates',t=>{
 const {ledger}=setup(t);for(const state of ['succeeded','rejected']){
 const input={key:state,tenantId:principal.tenantId,caseId:'case-1',revision:3,action:state,commandId:randomUUID(),payloadHash:'bound'};ledger.begin(input);
 const row=ledger.update(input.key,{state,result:{id:'saved',verified:true}});
 assert.deepEqual(ledger.update(input.key,{state,result:{verified:true,id:'saved'}}),row);
 for(const change of [{state:'unknown',result:row.result},{state,result:{id:'changed'}},{state,result:row.result,errorCode:'changed'}])assert.throws(()=>ledger.update(input.key,change),/immutable/);
 assert.deepEqual(ledger.get(input.key),row);
 }
});
test('facade rejects generated or previously stored audio over 3 MiB',async t=>{
 const bytes=Buffer.alloc(3*1024*1024+1);Buffer.from([73,68,51,4,0,0,0,0,0,0]).copy(bytes);
 const {actions}=setup(t,{voice:{synthesise:async()=>({available:true,contentType:'audio/mpeg',bytes})}});
 await assert.rejects(actions.generateVoice(principal,'case-1',command()),{code:'invalid_audio'});
 let calls=0;const cached=setup(t,{ledger:{durable:true,begin:async input=>({created:false,record:{...input,state:'succeeded',result:{audioBase64:bytes.toString('base64')}}})},voice:{synthesise:async()=>{calls++;}}});
 await assert.rejects(cached.actions.generateVoice(principal,'case-1',command()),{code:'invalid_audio'});assert.equal(calls,0);
});
