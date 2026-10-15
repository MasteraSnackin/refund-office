import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {request as httpRequest} from 'node:http';
import {createDemoResetControl} from '../server/demo-reset-control.mjs';
import {createRuntimeApiServer} from '../server/runtime-api.mjs';
import {createRuntimeSessions,LOCAL_RUNTIME_PROFILES} from '../server/runtime-auth.mjs';
import {contentHash,prepareSyntheticImport} from '../server/supabase-import.mjs';
import {runEvidenceRehearsal,validateRuntimeMarker} from '../scripts/run-evidence-rehearsal.mjs';

const reviewer={...LOCAL_RUNTIME_PROFILES[0]},digest='a'.repeat(64);
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(t,options={}){
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'refund-reset-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const sourceId=randomUUID(),targetId=randomUUID(),commandId=randomUUID(),calls=[];
  const markerPath=join(dir,'source.json');
  const source={id:sourceId,tenantId:sourceId,packId:'focused-12',datasetDigest:digest,markerPath,
    async quiesce(){calls.push('quiesce');assert.equal(JSON.parse(readFileSync(join(dir,'journal',commandId+'.json'))).targetRunId,targetId);await options.quiesce?.();},
    async stop(){calls.push('stop');const marker={id:sourceId,status:'ready',datasetDigest:digest,lastStoppedAt:'2026-10-14T19:00:00.000Z',checkpoint:{sha256:'b'.repeat(64)}};writeFileSync(markerPath,JSON.stringify({...marker,markerSha256:options.badCheckpoint?'bad':contentHash(marker)}));return options.stopCode||0;},
  };
  const target={id:targetId,tenantId:targetId,packId:'focused-12',datasetDigest:digest,async stop(){calls.push('target-stop');}};
  const control=createDemoResetControl({journalDirectory:join(dir,'journal'),packId:'focused-12',newId:()=>targetId,
    launch:async args=>{calls.push('launch');assert.equal(args.newId,targetId);assert.equal(args.uniqueTenant,true);assert.equal(args.expectedDatasetDigest,digest);assert.equal(JSON.parse(readFileSync(join(dir,'journal',commandId+'.json'))).checkpointConfirmed,true);if(options.launchFailure)throw Error('private launch failure');return {...target,...options.target};}});
  control.attachInitial(source);return {dir,source,target,control,calls,command:{commandId,expectedRunId:sourceId},view:control.forRun(sourceId)};
}

test('reset persists one exact intent before effects, retains source and starts one same-pack unique tenant',async t=>{
  const wait=deferred(),f=fixture(t,{quiesce:()=>wait.promise});
  const pending=f.view.reset(reviewer,f.command);assert.equal(pending.status,'switching');assert.equal(pending.targetRunId,f.target.id);
  assert.deepEqual(f.view.lookupExact(f.command),pending);assert.throws(()=>f.view.reset(reviewer,{...f.command,commandId:randomUUID()}),{code:'demo_reset_in_progress'});
  assert.throws(()=>f.view.lookupExact({...f.command,expectedRunId:randomUUID()}),{code:'demo_reset_conflict'});
  wait.resolve();await f.control.waitForIdle();assert.deepEqual(f.calls,['quiesce','stop','launch']);
  assert.equal(f.control.current().tenantId,f.target.id);assert.notEqual(f.source.tenantId,f.target.tenantId);assert.ok(existsSync(f.source.markerPath));
  const saved=f.view.status(f.command.commandId);assert.equal(saved.status,'ready');assert.equal(saved.checkpointConfirmed,true);
  assert.deepEqual(f.view.reset(null,f.command),saved);assert.deepEqual(f.calls,['quiesce','stop','launch']);
  assert.deepEqual(Object.keys(saved).sort(),['commandId','sourceRunId','targetRunId','packId','status','checkpointConfirmed','message'].sort());
  assert.doesNotMatch(JSON.stringify(saved),/requestedBy|datasetDigest|markerPath|actor|40000000/);
});
for(const failure of ['drain','checkpoint','stop','start','mismatched-target'])test(`${failure} failure retains intent and blocks another reset without replay`,async t=>{
  const f=fixture(t,{quiesce:failure==='drain'?()=>{throw Error('private active handler');}:undefined,badCheckpoint:failure==='checkpoint',stopCode:failure==='stop'?1:0,launchFailure:failure==='start',target:failure==='mismatched-target'?{datasetDigest:'c'.repeat(64)}:undefined});
  f.view.reset(reviewer,f.command);await f.control.waitForIdle();const result=f.view.status(f.command.commandId);
  assert.equal(result.status,'failed');assert.equal(result.checkpointConfirmed,['start','mismatched-target'].includes(failure));assert.equal(f.control.current(),f.source);
  assert.equal(f.calls.includes('launch'),['start','mismatched-target'].includes(failure));
  assert.deepEqual(f.view.reset(null,f.command),result);assert.throws(()=>f.view.reset(reviewer,{commandId:randomUUID(),expectedRunId:f.source.id}),{code:'demo_reset_in_progress'});
  assert.doesNotMatch(JSON.stringify(result),/private/);
});
test('interrupted saved reset refuses automatic startup or replay; completed records remain readable',async t=>{
  const wait=deferred(),f=fixture(t,{quiesce:()=>wait.promise});f.view.reset(reviewer,f.command);
  let launches=0;const restarted=createDemoResetControl({journalDirectory:join(f.dir,'journal'),packId:'focused-12',launch:async()=>{launches++;}});
  for(const id of [f.source.id,f.target.id])assert.throws(()=>restarted.assertCanStart(id),/interrupted reset/);
  assert.equal(restarted.forRun(f.source.id).status(f.command.commandId).status,'switching');assert.equal(launches,0);
  wait.resolve();await f.control.waitForIdle();restarted.assertCanStart(f.target.id);assert.equal(restarted.forRun(f.target.id).status(f.command.commandId).status,'ready');
});
test('reset validation rejects investigators, stale source and caller-selected pack or target',async t=>{
  const f=fixture(t);assert.throws(()=>f.view.reset({...reviewer,role:'investigator'},f.command),{code:'demo_reset_reviewer_required'});
  assert.throws(()=>f.view.reset(reviewer,{...f.command,expectedRunId:randomUUID()}),{code:'demo_run_changed'});
  for(const key of ['targetRunId','packId','tenantId','confirmed'])assert.throws(()=>f.view.reset(reviewer,{...f.command,[key]:'forged'}),{code:'invalid_demo_reset'});
  assert.equal(f.calls.length,0);
});

async function apiFixture(t){
  const f=fixture(t),auth=createRuntimeSessions({tenantId:f.source.id});let writes=0,resetQuiesced=false;
  const active=deferred(),entered=deferred();
  const service={bootstrap:async()=>({cases:[],capabilities:{}}),intake:async()=>{writes++;entered.resolve();await active.promise;return {replayed:false};}};
  const server=createRuntimeApiServer({service,auth,demoControl:f.view});server.listen(0,'127.0.0.1');await once(server,'listening');
  f.source.quiesce=async()=>{server.beginQuiesce();auth.close();await server.drainRequests();resetQuiesced=true;};
  t.after(async()=>{active.resolve();await f.control.waitForIdle();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));auth.close();});
  const request=(path,{method='GET',body,cookie,run=f.source.id,origin='http://127.0.0.1:4273',host='127.0.0.1:4274'}={})=>new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port:server.address().port,path,method,agent:false,headers:{Host:host,...(origin?{Origin:origin}:{}),...(run?{'x-refund-demo-run':run}:{}),...(cookie?{Cookie:cookie}:{}),...(body!==undefined?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(JSON.stringify(body))}:{})}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(chunks).toString()||'null')}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  const login=async role=>{const r=await request('/api/session',{method:'POST',body:{profileId:role}});assert.equal(r.status,200);return r.headers['set-cookie'][0].split(';')[0];};
  return {...f,request,login,server,auth,active,entered,get writes(){return writes;},get resetQuiesced(){return resetQuiesced;}};
}
test('run fence covers login, logout, case actions and stale tabs even with a valid replacement cookie',async t=>{
  const f=await apiFixture(t);const discovered=await f.request('/api/session',{run:null});assert.equal(discovered.body.demoRun.id,f.source.id);assert.equal(discovered.headers['x-refund-demo-run'],f.source.id);
  assert.equal((await f.request('/api/session',{method:'POST',body:{profileId:'reviewer'},run:null})).status,409);
  const cookie=await f.login('reviewer');const bootstrap=await f.request('/api/bootstrap',{cookie});assert.equal(bootstrap.body.capabilities.demoReset,true);
  for(const path of ['/api/session','/api/intake','/api/cases/C1/review','/api/worker/run-next']){
    const result=await f.request(path,{method:path==='/api/session'?'DELETE':'POST',body:{},cookie,run:randomUUID()});assert.equal(result.status,409);assert.equal(result.body.error.code,'demo_run_changed');
  }
  assert.equal((await f.request('/api/bootstrap',{cookie,run:randomUUID()})).status,409);assert.equal(f.writes,0);
  assert.equal((await f.request('/api/session',{method:'DELETE',body:{},cookie})).body.demoRun.id,f.source.id);
});
test('reset drains active mutations, revokes sessions, denies new actions and exposes only command receipt',async t=>{
  const f=await apiFixture(t),cookie=await f.login('reviewer');const running=f.request('/api/intake',{method:'POST',body:{},cookie});await f.entered.promise;
  const reset=await f.request('/api/demo/reset',{method:'POST',body:f.command,cookie});assert.equal(reset.status,202);
  assert.equal(f.resetQuiesced,false);assert.equal(f.calls.length,0);
  assert.equal((await f.request('/api/session',{run:null,cookie})).body.authenticated,false);
  assert.equal((await f.request('/api/intake',{method:'POST',body:{},cookie})).status,503);assert.equal(f.writes,1);
  const status=await f.request('/api/demo/reset/'+f.command.commandId,{run:null});assert.equal(status.body.status,'switching');
  assert.equal((await f.request('/api/demo/reset',{method:'POST',body:f.command,run:null})).status,200);
  for(const options of [{origin:'https://foreign.example'},{host:'foreign.example'}])assert.equal((await f.request('/api/demo/reset/'+f.command.commandId,options)).status,403);
  f.active.resolve();assert.equal((await running).status,201);await f.control.waitForIdle();assert.equal(f.resetQuiesced,true);assert.deepEqual(f.calls,['stop','launch']);
});
test('new reset is reviewer-only',async t=>{
  const f=await apiFixture(t),cookie=await f.login('investigator');const denied=await f.request('/api/demo/reset',{method:'POST',body:f.command,cookie});assert.equal(denied.status,403);assert.equal(f.calls.length,0);
});
test('changed seed digest is rejected before an isolated run directory or database can be created',async t=>{
  const f=fixture(t),baseDirectory=join(f.dir,'new-runs');
  await assert.rejects(runEvidenceRehearsal({packId:'focused-12',newId:randomUUID(),uniqueTenant:true,expectedDatasetDigest:'0'.repeat(64),serve:false,baseDirectory,installSignalHandlers:false}),/synthetic pack changed/);
  assert.equal(existsSync(baseDirectory),false);
});
test('legacy evidence v1 markers remain valid and run-tenant markers require the exact separate identity',()=>{
  const pack=prepareSyntheticImport(JSON.parse(readFileSync(new URL('../demo-data/focused-12.json',import.meta.url),'utf8'))),id=randomUUID(),schemaHashes={one:'b'.repeat(64)},members=[];
  const make=(changes={})=>{const payload={kind:'refund-office-evidence-postgres-rehearsal',schemaVersion:1,status:'ready',id,datasetId:pack.datasetId,datasetDigest:pack.manifest.digest,tenantId:pack.tenantId,volumeName:'refund-office-evidence-runtime-'+id,imageId:'sha256:'+'a'.repeat(64),schemaHashes,members,checkpoint:{sha256:'c'.repeat(64)},...changes};return {...payload,markerSha256:contentHash(payload)};};
  assert.equal(validateRuntimeMarker(make(),{id,pack,schemaHashes,members}).tenantMode,undefined);
  const isolated=make({tenantMode:'run',tenantId:id});assert.equal(validateRuntimeMarker(isolated,{id,pack:{...pack,tenantId:id},schemaHashes,members}).tenantId,id);
  assert.throws(()=>validateRuntimeMarker(isolated,{id,pack,schemaHashes,members}));
});
