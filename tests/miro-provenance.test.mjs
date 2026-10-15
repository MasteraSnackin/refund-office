import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildCaseProvenance} from '../server/case-provenance.mjs';
import {createSponsorClients,planMiroNotes,planMiroConnectors,resolveMiroConnector} from '../server/sponsor-clients.mjs';
import {createSponsorActions} from '../server/sponsor-actions.mjs';
import {createSponsorActionLedger} from '../server/sponsor-action-ledger.mjs';

const principal={tenantId:'tenant1',userId:'reviewer1',role:'reviewer'};
const env={REFUND_OFFICE_NETWORK:'enabled',REFUND_OFFICE_ENABLED_INTEGRATIONS:'miro',MIRO_ACCESS_TOKEN:'injected-fixture',MIRO_BOARD_ID:'fixture-board'};
const packet=()=>({tenantId:'tenant1',mode:'local-postgres-rehearsal',synthetic:true,paymentSubmissionEnabled:false,policy:{version:'new-current-policy'},case:{id:'case-1',caseId:'RF-1',revision:8,title:'Missing sketchbook',complaint:'Some items are missing.',proposedAmountMinor:1000,outcome:'awaiting-approval',approval:{state:'required',amountMinor:1000},
  proposal:{source:'local',issue:'item_missing',lineId:'line1',amountMinor:1000,reason:'Saved packing and clarification support the Sketchbook.',evidenceIds:['packing:order1','clarification:saved1']},
  evidence:[{id:'packing:order1',title:'Packing record',source:'Synthetic catalogue',body:'One sketchbook was not packed.'},{id:'delivery:order1',title:'Delivery record',source:'Synthetic catalogue',body:'Delivered; no dispute.'},{id:'clarification:saved1',title:'Customer reply',kind:'customer-clarification',body:'The Sketchbook is missing.',source:'Customer clarification recorded by reviewer',sourceReference:'Synthetic customer message 123',actor:'reviewer1',at:'2026-10-14T19:00:00Z'}],
  checks:[{id:'missing-item',label:'Missing item',pass:true},{id:'limit',label:'Policy limit',pass:true}],events:[]}});

test('source map separates original complaint, saved clarification and actual citations without changing any record',()=>{
  const saved=packet(),before=JSON.stringify(saved),board=buildCaseProvenance(saved),{nodes,edges}=board.provenance;
  assert.equal(JSON.stringify(saved),before);assert.equal(board.publication.published,false);assert.equal(board.importReady,false);assert.equal(board.caseRecordId,'case-1');
  assert.equal(nodes.find(n=>n.kind==='complaint').text,'Some items are missing.');
  const clarification=nodes.find(n=>n.refs.some(r=>r.id==='clarification:saved1'));assert.match(clarification.text,/Synthetic customer message 123/);assert.match(clarification.text,/reviewer1/);assert.match(clarification.text,/original complaint is unchanged/);
  const delivery=nodes.find(n=>n.refs.some(r=>r.id==='delivery:order1'));assert.equal(edges.find(e=>e.from===clarification.id).label,'Cited by the saved proposal');assert.match(edges.find(e=>e.from===delivery.id).label,/not cited/);
  assert.match(nodes.find(n=>n.kind==='investigation').text,/Local analyser/);assert.doesNotMatch(JSON.stringify(board),/OpenAI|Anthropic|agent handoff/);
  const review=nodes.find(n=>n.kind==='review');assert.equal(review.state,'waiting');assert.match(review.text,/No current refund approval or review decision/);assert.equal(review.refs.some(r=>r.type==='approval'),false);
  assert.equal(board.synthetic,true);assert.ok(board.limitations.some(s=>s.includes('fictional test identities')));
  assert.ok(nodes.filter(n=>['report','packet'].includes(n.kind)).every(n=>n.state==='available'));assert.match(nodes.find(n=>n.kind==='report').text,/does not establish.*downloaded/);
  assert.ok(nodes.flatMap(n=>n.links).every(link=>['/api/cases/case-1','/api/cases/case-1/export','/api/cases/case-1/report'].includes(link.path)));
});
test('old checks do not acquire the current policy version or a fabricated decision identity',()=>{
  const value=packet();value.case.approval={state:'approved',actor:'reviewer1',amountMinor:1000,note:'Recorded earlier.',policyVersion:'saved-old-policy'};value.case.outcome='approved-not-submitted';value.case.operationId='actual-operation-1';
  const board=buildCaseProvenance(value),checks=board.provenance.nodes.filter(n=>n.kind==='policy'),review=board.provenance.nodes.find(n=>n.kind==='review');
  assert.ok(checks.every(n=>!n.refs.some(r=>r.type==='policy-version')));assert.ok(checks.every(n=>/included in this case snapshot/.test(n.text)));assert.doesNotMatch(JSON.stringify(board),/new-current-policy|Saved check at case revision/);
  assert.equal(review.refs.some(r=>r.type==='approval'),false);assert.ok(review.refs.some(r=>r.type==='approval-policy-version'&&r.id==='saved-old-policy'));
  value.case.checks[0].policyVersion='explicit-check-policy';value.case.approval.id='actual-approval-id';const bound=buildCaseProvenance(value);assert.ok(bound.provenance.nodes.some(n=>n.refs.some(r=>r.type==='approval'&&r.id==='actual-approval-id')));assert.ok(bound.provenance.nodes.some(n=>n.refs.some(r=>r.type==='policy-version'&&r.id==='explicit-check-policy')));
});
test('hosted reservations remain unverified for separate payments and seeded remedies do not invent new approval',()=>{
  const value=packet();value.mode='hosted-supabase';value.case.operationId='reserved1';value.case.outcome='approved-not-submitted';value.case.approval={state:'approved',amountMinor:1000,actor:'reviewer1'};
  const hosted=buildCaseProvenance(value),payment=hosted.provenance.nodes.find(n=>n.kind==='payment');assert.equal(payment.state,'unverified');assert.match(payment.text,/Separate test execution records are not included/);assert.doesNotMatch(payment.text,/No money has moved|No payment was made/);
  value.mode='local-postgres-rehearsal';value.case.outcome='already-resolved';value.case.approval=null;value.case.receipt={id:'history1',status:'succeeded',seeded:true};const historical=buildCaseProvenance(value);assert.equal(historical.provenance.nodes.find(n=>n.kind==='review').state,'available');assert.match(historical.provenance.nodes.find(n=>n.kind==='payment').text,/supplied synthetic history, not a new refund/);
});
test('cleared current review retains recorded review history and operation approval is not fresh authority',()=>{
  const value=packet();value.case.review=null;value.case.approval=null;value.case.events=[{id:37,type:'review.request-evidence',actor:'reviewer1',at:'2026-10-14T19:00:00Z',label:'Evidence requested',detail:'Please identify the missing item.'}];
  value.operation={id:'prior-operation',status:'succeeded',approval:{state:'approved',actor:'reviewer1',amountMinor:1000,note:'Original saved decision.'}};
  const board=buildCaseProvenance(value),human=board.provenance.nodes.find(n=>n.kind==='review');assert.equal(human.state,'waiting');assert.match(human.text,/earlier decisions may remain in recorded history/);
  const prior=board.provenance.nodes.find(n=>n.refs.some(r=>r.type==='event'&&r.id==='37'));assert.match(prior.text,/Historical event/);assert.match(prior.text,/Please identify/);
  const original=board.provenance.nodes.find(n=>n.title==='Original operation approval');assert.match(original.text,/not fresh authority/);assert.ok(original.refs.some(r=>r.id==='prior-operation'));assert.ok(board.provenance.edges.some(e=>e.from===prior.id&&e.label.includes('history')));
  const notes=planMiroNotes(board);assert.ok(notes.every(n=>n.body.data.content.includes('Synthetic demonstration')));assert.ok(notes.every(n=>n.body.data.content.includes('fictional test identities')));
});
test('Miro preparation escapes source text, preserves references and permits only configured application links',()=>{
  const value=packet();value.case.complaint='<script>send secrets</script>';value.case.evidence[2].sourceReference='javascript:alert(1)';
  const board=buildCaseProvenance(value),notes=planMiroNotes(board),connectors=planMiroConnectors(board,notes);assert.ok(connectors.length>0);assert.ok(notes.some(n=>n.body.data.content.includes('packing:order1')));
  assert.doesNotMatch(notes.map(n=>n.body.data.content).join(''),/<script|href="javascript|href="data:/);assert.match(notes.map(n=>n.body.data.content).join(''),/public app origin needed/);
  const linked=planMiroNotes(board,{applicationOrigin:'https://refund.example.test'});assert.match(linked.map(n=>n.body.data.content).join(''),/href="https:\/\/refund.example.test\/api\/cases\/case-1\/report"/);
  for(const applicationOrigin of ['javascript:alert(1)','data:text/plain,test','https://user:secret@example.test','https://example.test/path','http://localhost:4473'])assert.throws(()=>planMiroNotes(board,{applicationOrigin}),{code:'invalid_application_origin'});
  const wrong=structuredClone(board);wrong.columns.at(-1).cards.at(-1).links[0].path='https://external.example/';assert.throws(()=>planMiroNotes(wrong),{code:'invalid_board_link'});
  const broken=structuredClone(board);broken.provenance.edges[0].to='absent';assert.throws(()=>planMiroConnectors(broken),{code:'invalid_board'});
  assert.throws(()=>resolveMiroConnector(connectors[0],notes.map(n=>({localId:n.localId,id:n.localId,verified:false}))),{code:'unverified_board_endpoints'});
});

const smallBoard=()=>({format:'refund-office-case-board',caseId:'RF-1',caseRecordId:'case-1',revision:8,columns:[{id:'source',title:'Sources',cards:[{id:'a',title:'Complaint',text:'Saved customer complaint.'},{id:'b',title:'Evidence',text:'Saved evidence.'}]}],provenance:{schemaVersion:1,nodes:[{id:'a'},{id:'b'}],edges:[{id:'edge1',from:'a',to:'b',label:'Recorded source relationship'}]}});
function publishingFixture(t,{board=smallBoard(),failConnectorWrite=false,failConnectorRead=false,wrongConnector=false,failNoteRead=false}={}){
  const dir=mkdtempSync(join(tmpdir(),'refund-miro-map-')),dbPath=join(dir,'actions.sqlite');let ledger=createSponsorActionLedger({dbPath});
  const notes=new Map(),connections=new Map(),calls=[];let connectionReadsFail=failConnectorRead,noteReadsFail=failNoteRead;
  const clients=createSponsorClients({env,fetchImpl:async(url,options)=>{calls.push({url,method:options.method||'GET'});assert.equal(new URL(url).origin,'https://api.miro.com');const connector=url.includes('/connectors');
    if(options.method==='POST'){const body=JSON.parse(options.body),id=(connector?'connector-':'note-')+(connector?connections.size:notes.size);(connector?connections:notes).set(id,body);if(connector&&failConnectorWrite)throw Error('Injected lost connector response');return Response.json({id});}
    const id=url.split('/').at(-1);if(connector){if(connectionReadsFail)throw Error('Injected lost connector read');const body=connections.get(id);return Response.json({id,...body,...(wrongConnector?{endItem:{id:'foreign-note'}}:{})});}
    if(noteReadsFail)throw Error('Injected note read unavailable');return Response.json({id,data:notes.get(id).data});
  }});
  const options={env,ledger,clients,getPacket:async()=>packet(),getBoard:async()=>board};let actions=createSponsorActions(options);
  t.after(()=>{ledger.close();rmSync(dir,{recursive:true,force:true});});
  return {calls,notes,connections,get ledger(){return ledger;},get actions(){return actions;},recoverReads(){connectionReadsFail=false;noteReadsFail=false;},reopen(){ledger.close();ledger=createSponsorActionLedger({dbPath});actions=createSponsorActions({...options,ledger});},body:{expectedRevision:8,commandId:randomUUID()}};
}
test('Miro map writes real connector bodies and verifies every note and endpoint before parent completion',async t=>{
  const f=publishingFixture(t),result=await f.actions.publishMiro(principal,'case-1',f.body);assert.equal(result.verified,true);assert.deepEqual(result.counts,{notes:2,connectors:1});assert.equal(result.items.length,3);assert.ok(result.items.every(i=>i.verified));
  const connector=[...f.connections.values()][0];assert.equal(connector.startItem.id,'note-0');assert.equal(connector.endItem.id,'note-1');assert.equal(connector.captions[0].content,'Recorded source relationship');assert.equal(connector.shape,'elbowed');
  assert.equal(f.calls.filter(c=>c.method==='POST').length,3);assert.equal(f.calls.filter(c=>c.method==='GET').length,3);f.reopen();assert.equal((await f.actions.publishMiro(principal,'case-1',f.body)).replayed,true);assert.equal(f.calls.length,6);
  const status=await f.actions.status(principal,'case-1');assert.deepEqual(status.records.find(r=>r.action==='miro').counts,{notes:2,connectors:1});assert.equal(status.records.filter(r=>r.itemKind==='connector').length,1);
});
test('complete saved-case map publishes all prepared nodes and relationships through injected Miro responses',async t=>{
  const board=buildCaseProvenance(packet()),f=publishingFixture(t,{board});const result=await f.actions.publishMiro(principal,'case-1',f.body);
  assert.deepEqual(result.counts,{notes:board.provenance.nodes.length,connectors:board.provenance.edges.length});assert.equal(result.verified,true);assert.equal(f.notes.size,board.provenance.nodes.length);assert.equal(f.connections.size,board.provenance.edges.length);
  assert.ok([...f.connections.values()].every(c=>f.notes.has(c.startItem.id)&&f.notes.has(c.endItem.id)));assert.equal(f.calls.length,2*(f.notes.size+f.connections.size));
});
test('lost connector response blocks a second write across restart and cannot make a partial board successful',async t=>{
  const f=publishingFixture(t,{failConnectorWrite:true});await assert.rejects(f.actions.publishMiro(principal,'case-1',f.body),{uncertain:true});f.reopen();await assert.rejects(f.actions.publishMiro(principal,'case-1',{...f.body,commandId:randomUUID()}),{code:'action_unconfirmed'});
  const read=await f.actions.readMiro(principal,'case-1',{expectedRevision:8});assert.equal(read.records.find(r=>r.action==='miro').verified,false);assert.equal(read.records.find(r=>r.action==='miro').state,'unknown');assert.equal(f.connections.size,1);assert.equal(f.calls.filter(c=>c.method==='POST').length,3);
});
test('acknowledged final connector recovers by GET and keeps every successful receipt immutable',async t=>{
  const f=publishingFixture(t,{failConnectorRead:true});await assert.rejects(f.actions.publishMiro(principal,'case-1',f.body));f.reopen();f.recoverReads();
  const recovered=await f.actions.readMiro(principal,'case-1',{expectedRevision:8});assert.equal(recovered.records.find(r=>r.action==='miro').verified,true);assert.equal(f.calls.filter(c=>c.method==='POST').length,3);
  const saved=f.ledger.list({tenantId:'tenant1',caseId:'case-1',revision:8});await f.actions.readMiro(principal,'case-1',{expectedRevision:8});assert.deepEqual(f.ledger.list({tenantId:'tenant1',caseId:'case-1',revision:8}),saved);
});
test('wrong connector endpoint never verifies the map and readback cannot silently accept it',async t=>{
  const f=publishingFixture(t,{wrongConnector:true});await assert.rejects(f.actions.publishMiro(principal,'case-1',f.body),{code:'board_readback_mismatch'});await assert.rejects(f.actions.readMiro(principal,'case-1',{expectedRevision:8}),{code:'board_readback_mismatch'});assert.equal((await f.actions.status(principal,'case-1')).records.find(r=>r.action==='miro').verified,false);
});
test('recovering one card does not mark a map complete while planned cards or connectors were never created',async t=>{
  const f=publishingFixture(t,{failNoteRead:true});await assert.rejects(f.actions.publishMiro(principal,'case-1',f.body));f.reopen();f.recoverReads();const read=await f.actions.readMiro(principal,'case-1',{expectedRevision:8});assert.equal(read.records.find(r=>r.action==='miro').verified,false);assert.equal(f.notes.size,1);assert.equal(f.connections.size,0);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('connector create and read refuse offline before touching credentials or transport',async()=>{
  const env=new Proxy({REFUND_OFFICE_NETWORK:'offline',REFUND_OFFICE_ENABLED_INTEGRATIONS:''},{get(target,key){assert.ok(['REFUND_OFFICE_NETWORK','REFUND_OFFICE_ENABLED_INTEGRATIONS'].includes(key));return target[key];}});
  const clients=createSponsorClients({env,fetchImpl:()=>assert.fail('No outbound request authorised')});for(const call of [()=>clients.createMiroConnector('board',{}),()=>clients.getMiroConnector('board','id')])await assert.rejects(call,{code:'integration_disconnected'});
});
