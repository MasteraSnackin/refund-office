import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,readdirSync,existsSync,statSync,rmSync} from 'node:fs';
import {join,resolve,dirname,relative} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const write=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
function sources(){
  const files=new Map();function visit(path){const absolute=resolve(ROOT,path),key=relative(ROOT,absolute);assert.ok(absolute.startsWith(ROOT));if(files.has(key))return;const bytes=readFileSync(absolute);files.set(key,{path:key,bytes:bytes.length,sha256:sha256(bytes)});if(!/\.[cm]?js$/.test(path))return;for(const match of bytes.toString().matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.{1,2}\/[^'"]+)['"]/g))visit(relative(ROOT,resolve(dirname(absolute),match[1])));}
  for(const path of ['scripts/test-demo-reset.mjs','scripts/run-evidence-demo.mjs','tests/supabase-runtime/bootstrap.sql','demo-data/focused-12.json','integrations/supabase/runtime/001_runtime.sql','integrations/supabase/runtime/002_office_workflow.sql','integrations/supabase/runtime/007_evidence_clarification.sql'])visit(path);
  const list=[...files.values()].sort((a,b)=>a.path.localeCompare(b.path));return {digest:sha256(JSON.stringify(list)),files:list};
}

export async function testDemoReset(){
  const outputBase=join(ROOT,'work/demo-reset/lifecycle');mkdirSync(outputBase,{recursive:true});
  const output=mkdtempSync(join(outputBase,new Date().toISOString().replace(/[:.]/g,'-')+'-'));
  const baseDirectory=join(output,'runs'),ports={ui:4873,api:4874},origin='http://127.0.0.1:'+ports.ui,base='http://127.0.0.1:'+ports.api;
  const checks=[],before=sources();write(join(output,'sources-before.json'),before);
  const {runEvidenceDemo}=await import('./run-evidence-demo.mjs');
  const {validateOwnedVolume,runtimeRehearsalEnvironment}=await import('./run-evidence-rehearsal.mjs');
  let handle=null,sourceId,targetId,sourceCheckpoint,sourceCases,savedClarification,sourceTenant,digest,receipt,failed=null,cleaned=false;
  const nativeFetch=globalThis.fetch;
  globalThis.fetch=(url,options)=>{assert.equal(new URL(url).origin,base,'Only the fresh local lifecycle API can be contacted.');return nativeFetch(url,options);};
  let run,cookie;
  async function request(path,{method='GET',body,runId=run,sessionCookie=cookie}={}){
    const response=await fetch(base+path,{method,headers:{Origin:origin,...(runId?{'x-refund-demo-run':runId}:{}),...(sessionCookie?{Cookie:sessionCookie}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const text=await response.text();return {status:response.status,headers:response.headers,body:JSON.parse(text)};
  }
  async function login(){const result=await request('/api/session',{method:'POST',body:{profileId:'reviewer'},sessionCookie:null});assert.equal(result.status,200);cookie=result.headers.get('set-cookie').split(';')[0];return result.body;}
  async function settled(){const deadline=Date.now()+60000;for(;;){const result=await request('/api/bootstrap');assert.equal(result.status,200);if(result.body.cases.length===12&&result.body.intakeRequests.every(r=>!['queued','investigating'].includes(r.status))&&!result.body.runtime.worker.active)return result.body;if(Date.now()>deadline)throw Error('The isolated synthetic queue did not settle.');await delay(150);}}
  async function check(name,action){await action();checks.push(name);console.log('PASS '+name);}
  async function cleanupOwnedVolumes(){
    let endpoint;for(const socket of [join(homedir(),'.docker/run/docker.sock'),'/var/run/docker.sock']){try{if(statSync(socket).isSocket()){endpoint='unix://'+socket;break;}}catch{}}
    assert.ok(endpoint);const config=join(output,'empty-docker-config');mkdirSync(config,{mode:0o700});
    async function docker(args,allowFailure=false){const value=await new Promise((resolve,reject)=>{const child=spawn('docker',['--host',endpoint,'--config',config,...args],{cwd:ROOT,env:runtimeRehearsalEnvironment(),stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',c=>{stdout+=c;});child.stderr.on('data',c=>{stderr+=c;});child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));});if(!allowFailure)assert.equal(value.code,0,'Owned lifecycle Docker action failed.');return value;}
    for(const id of readdirSync(baseDirectory).filter(id=>/^[a-f0-9-]{36}$/.test(id))){const path=join(baseDirectory,id,'rehearsal.json');if(!existsSync(path))continue;const marker=JSON.parse(readFileSync(path));assert.equal(marker.id,id);assert.equal(existsSync(join(baseDirectory,id,'active.json')),false,'Test run must stop before cleanup.');const found=await docker(['volume','inspect',marker.volumeName],true);if(found.code!==0)continue;validateOwnedVolume(JSON.parse(found.stdout)[0],marker);const active=await docker(['ps','--all','--filter','volume='+marker.volumeName,'--format','{{.ID}}']);assert.equal(active.stdout.trim(),'','Only unused lifecycle volumes may be removed.');await docker(['volume','rm',marker.volumeName]);assert.notEqual((await docker(['volume','inspect',marker.volumeName],true)).code,0);}
    rmSync(config,{recursive:true,force:true});cleaned=true;
  }
  try{
    await check('fresh supervisor uses a unique local tenant, a network-disabled owned database and unchanged seed',async()=>{
      handle=await runEvidenceDemo({packId:'focused-12',baseDirectory,ports,serveUi:false,installSignalHandlers:false});sourceId=handle.id;run=sourceId;
      const discovery=await request('/api/session',{runId:null,sessionCookie:null});assert.equal(discovery.body.demoRun.id,sourceId);assert.equal(discovery.body.authenticated,false);
      assert.equal((await request('/api/session',{method:'POST',body:{profileId:'reviewer'},runId:null,sessionCookie:null})).status,409);
      const access=await login();sourceTenant=access.workspace.id;assert.equal(sourceTenant,sourceId);
      const initial=await settled();assert.equal(initial.capabilities.demoReset,true);assert.equal(initial.capabilities.networkMode,'offline');assert.equal(initial.capabilities.paymentSubmission,false);
      digest=handle.control.current().datasetDigest;assert.equal(initial.cases.filter(c=>c.outcome==='awaiting-approval').length,6);assert.equal(initial.cases.filter(c=>c.outcome==='held').length,5);
    });
    await check('fictional evidence and its exact history are saved in the source before reset without approval',async()=>{
      const initial=await settled(),item=initial.cases.find(c=>c.caseId==='RF-2008');
      const held=await request('/api/cases/'+item.id+'/review',{method:'POST',body:{action:'request-evidence',expectedRevision:item.revision,note:'Synthetic lifecycle test asks which item is missing.',commandId:randomUUID()}});assert.equal(held.status,200);
      const context=await request('/api/cases/'+item.id+'/evidence-request');assert.equal(context.body.eligible,true);
      const result=await request('/api/cases/'+item.id+'/evidence-request',{method:'POST',body:{expectedRevision:context.body.revision,lineId:'SYN-F12-O008-L1',customerStatement:'The Sketchbook is missing from my order.',sourceReference:'Synthetic reset lifecycle customer reply',note:'Fictional evidence for isolated preservation verification only.',commandId:randomUUID()}});assert.equal(result.status,200);assert.equal(result.body.readbackVerified,true);savedClarification=result.body.submission;
      sourceCases=(await settled()).cases;const finished=sourceCases.find(c=>c.id===item.id);assert.equal(finished.outcome,'awaiting-approval');assert.equal(finished.proposedAmountMinor,1000);assert.equal(finished.approval.state,'required');assert.equal(finished.operationId,null);assert.equal(finished.receipt,null);
      write(join(output,'source-cases-before.json'),sourceCases);
    });
    await check('reset persists one target and exact retry recovers an ignored initial response without a second switch',async()=>{
      const command={commandId:randomUUID(),expectedRunId:sourceId},oldCookie=cookie;
      const sent=await request('/api/demo/reset',{method:'POST',body:command});assert.equal(sent.status,202); // Deliberately do not use its body as confirmation.
      const pending=await request('/api/demo/reset/'+command.commandId,{runId:null,sessionCookie:null});targetId=pending.body.targetRunId;assert.notEqual(targetId,sourceId);
      const concurrent=await request('/api/demo/reset',{method:'POST',body:{commandId:randomUUID(),expectedRunId:sourceId}});assert.ok([409,503].includes(concurrent.status));
      const deadline=Date.now()+45000;for(;;){receipt=(await request('/api/demo/reset/'+command.commandId,{runId:null,sessionCookie:null})).body;if(receipt.status!=='switching')break;if(Date.now()>deadline)throw Error('Reset did not complete.');await delay(150);}
      assert.equal(receipt.status,'ready');assert.equal(receipt.checkpointConfirmed,true);assert.equal(receipt.targetRunId,targetId);
      const retry=await request('/api/demo/reset',{method:'POST',body:command,runId:sourceId,sessionCookie:null});assert.equal(retry.status,200);assert.deepEqual(retry.body,receipt);
      assert.deepEqual(Object.keys(receipt).sort(),['commandId','sourceRunId','targetRunId','packId','status','checkpointConfirmed','message'].sort());
      assert.equal(handle.control.current().id,targetId);assert.equal(handle.control.current().tenantId,targetId);assert.equal(handle.control.current().datasetDigest,digest);
      assert.equal(readdirSync(baseDirectory).filter(name=>/^[a-f0-9-]{36}$/.test(name)).length,2);
      run=targetId;assert.equal((await request('/api/bootstrap',{sessionCookie:oldCookie})).status,401);
      const discovery=await request('/api/session',{runId:null,sessionCookie:oldCookie});assert.equal(discovery.body.authenticated,false);assert.equal(discovery.body.demoRun.id,targetId);
      sourceCheckpoint=JSON.parse(readFileSync(join(baseDirectory,sourceId,'rehearsal.json'))).checkpoint;
    });
    await check('replacement sign-in cannot let an old tab mutate new cases and logout keeps the current fence',async()=>{
      const access=await login();assert.equal(access.workspace.id,targetId);assert.notEqual(access.workspace.id,sourceTenant);
      for(const path of ['/api/intake','/api/cases/SYN-F12-C008/review','/api/session']){const result=await request(path,{method:path==='/api/session'?'DELETE':'POST',body:{},runId:sourceId});assert.equal(result.status,409);assert.equal(result.body.error.code,'demo_run_changed');}
      const logout=await request('/api/session',{method:'DELETE',body:{}});assert.equal(logout.status,200);assert.equal(logout.body.demoRun.id,targetId);await login();
    });
    await check('fresh run contains the same twelve source cases with no old clarification, new approval or payment',async()=>{
      const fresh=await settled();assert.equal(fresh.cases.filter(c=>c.outcome==='awaiting-approval').length,6);assert.equal(fresh.cases.filter(c=>c.outcome==='held').length,5);assert.equal(fresh.cases.filter(c=>c.outcome==='already-resolved').length,1);
      assert.deepEqual(fresh.cases.map(c=>c.id).sort(),sourceCases.map(c=>c.id).sort());assert.ok(fresh.cases.every(c=>(!c.operationId||c.receipt?.seeded===true)&&(!c.approval||c.approval.state==='required')&&(!c.receipt||c.receipt.seeded===true)));
      const item=fresh.cases.find(c=>c.caseId==='RF-2008');assert.equal(item.outcome,'held');assert.equal(item.evidence.some(e=>e.kind==='customer-clarification'),false);assert.equal((await request('/api/cases/'+item.id+'/evidence-request')).body.submissions.length,0);
      write(join(output,'target-cases.json'),fresh.cases);assert.equal(await handle.stop(),0);handle=null;
      const counts=JSON.parse(readFileSync(join(baseDirectory,targetId,'rehearsal.json'))).checkpoint.counts;assert.equal(counts.approvals,0);assert.equal(counts.operations,1);assert.equal(counts.evidence_submissions,0);
    });
    await check('explicit source restore preserves all prior cases, clarification and checkpoint exactly',async()=>{
      handle=await runEvidenceDemo({packId:'focused-12',reuseId:sourceId,baseDirectory,ports,serveUi:false,installSignalHandlers:false});run=sourceId;await login();
      const restored=await settled();assert.deepEqual(restored.cases,sourceCases);
      const saved=await request('/api/cases/SYN-F12-C008/evidence-request');assert.deepEqual(saved.body.submissions,[savedClarification]);
      assert.equal((await request('/api/demo/reset/'+receipt.commandId,{runId:null,sessionCookie:null})).body.targetRunId,targetId);
      assert.equal(await handle.stop(),0);handle=null;
      assert.deepEqual(JSON.parse(readFileSync(join(baseDirectory,sourceId,'rehearsal.json'))).checkpoint,sourceCheckpoint);
      assert.equal(readdirSync(baseDirectory).filter(name=>/^[a-f0-9-]{36}$/.test(name)).length,2);
    });
  }catch(error){failed=error.message;console.error(error.stack);}
  finally{
    try{if(handle){assert.equal(await handle.stop(),0);handle=null;}if(existsSync(baseDirectory))await cleanupOwnedVolumes();}catch(error){failed=[failed,'Owned cleanup: '+error.message].filter(Boolean).join('; ');}
    globalThis.fetch=nativeFetch;
    const after=sources();write(join(output,'sources-after.json'),after);if(before.digest!==after.digest)failed=[failed,'Sources changed during verification.'].filter(Boolean).join('; ');
    write(join(output,'verification.json'),{passed:!failed,checkedAt:new Date().toISOString(),checks,checksPassed:checks.length,sourceId,targetId,packId:'focused-12',datasetDigest:digest,sourceCheckpoint,sourceCasesPreserved:checks.some(c=>c.startsWith('explicit source restore')),freshTenant:targetId,providersContacted:0,paymentsCreated:0,ownedTestVolumesRemoved:cleaned,sourceDigest:before.digest,sourceFiles:before.files.length,error:failed});
  }
  console.log('Lifecycle verification: '+join(output,'verification.json'));if(failed)throw Error(failed);return {output,checks:checks.length};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))testDemoReset().catch(()=>{process.exitCode=1;});
