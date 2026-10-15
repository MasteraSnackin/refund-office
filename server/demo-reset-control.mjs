import {randomUUID,createHash} from 'node:crypto';
import {existsSync,mkdirSync,lstatSync,readFileSync,writeFileSync,renameSync,openSync,closeSync,fsyncSync,readdirSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {RuntimeServiceError} from './runtime-service.mjs';
import {contentHash} from './supabase-import.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(status,code,message)=>{throw new RuntimeServiceError(status,code,message);};
const terminal=new Set(['ready','failed','unresolved']);
function safeDirectory(path){for(let p=resolve(path);;p=dirname(p)){if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw new Error('Reset journal paths cannot contain symbolic links.');if(dirname(p)===p)break;}}
function input(value){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||!UUID.test(value.commandId||'')||!UUID.test(value.expectedRunId||''))fail(400,'invalid_demo_reset','Use the original reset command and the exact current run.');return value;}
const message=record=>record.status==='ready'?'A fresh run of the same synthetic pack is ready. The previous run is saved.':record.status==='failed'?'The switch did not complete. Saved runs were retained; inspect the saved reset before taking another action.':record.status==='unresolved'?'The saved reset needs inspection. No further reset was started.':record.checkpointConfirmed?'The previous run is saved. Starting the fresh run.':'Preserving the current run before starting a fresh copy.';
const publicRecord=record=>({commandId:record.commandId,sourceRunId:record.sourceRunId,targetRunId:record.targetRunId,packId:record.packId,status:record.status,checkpointConfirmed:record.checkpointConfirmed,message:message(record)});

// One explicitly started local supervisor owns this controller. No request can
// choose a filesystem path, dataset, database connection or replacement ID.
export function createDemoResetControl({journalDirectory,packId,launch,now=()=>new Date().toISOString(),newId=randomUUID,onStateChange=()=>{}}={}){
  if(!['focused-12','busy-50'].includes(packId)||typeof launch!=='function')throw new Error('Configure the current synthetic pack and local launcher.');
  if(typeof onStateChange!=='function')throw new Error('The reset state observer must be a function.');
  const directory=resolve(journalDirectory);safeDirectory(directory);mkdirSync(directory,{recursive:true,mode:0o700});
  let current=null,pending=null,job=null,initialRunId=null,lastReset=null;
  function snapshot(){return Object.freeze({packId,runId:current?.id||null,initialRunId,state:pending?.status||(current?'ready':'starting'),reset:lastReset?Object.freeze(publicRecord(lastReset)):null});}
  // Presentation observers do not participate in the saved reset transaction.
  function notify(){try{Promise.resolve(onStateChange(snapshot())).catch(()=>{});}catch{}}
  function pathFor(id){if(!UUID.test(id||''))fail(400,'invalid_demo_reset','Use the saved reset command.');return join(directory,id+'.json');}
  function read(id){const path=pathFor(id);if(!existsSync(path))return null;if(lstatSync(path).isSymbolicLink()||lstatSync(path).size>16384)throw new Error('The saved reset journal cannot be read safely.');const value=JSON.parse(readFileSync(path,'utf8'));const {checksum,...record}=value;
    if(checksum!==hash(record)||record.commandId!==id||!UUID.test(record.sourceRunId)||!UUID.test(record.targetRunId)||record.sourceRunId===record.targetRunId||!['focused-12','busy-50'].includes(record.packId)||!['switching',...terminal].includes(record.status)||typeof record.checkpointConfirmed!=='boolean'||!/^[a-f0-9]{64}$/.test(record.datasetDigest))throw new Error('The saved reset journal failed validation.');return record;}
  function save(record,create=false){const path=pathFor(record.commandId),encoded=JSON.stringify({...record,checksum:hash(record)},null,2)+'\n';
    const destination=create?path:path+'.next';writeFileSync(destination,encoded,{flag:'wx',mode:0o600});const fd=openSync(destination,'r');try{fsyncSync(fd);}finally{closeSync(fd);}if(!create)renameSync(destination,path);const dirFd=openSync(directory,'r');try{fsyncSync(dirFd);}finally{closeSync(dirFd);}if(readFileSync(path,'utf8')!==encoded)throw new Error('The reset journal did not read back exactly.');}
  function lookupExact(value){const clean=input(value),record=read(clean.commandId);if(!record)return null;if(record.sourceRunId!==clean.expectedRunId||record.packId!==packId)fail(409,'demo_reset_conflict','This reset command belongs to a different run.');return publicRecord(record);}
  function assertCanStart(runId){for(const filename of readdirSync(directory)){if(!/^[a-f0-9-]{36}\.json$/i.test(filename))continue;const record=read(filename.slice(0,-5));if(record.status==='switching'&&(record.sourceRunId===runId||record.targetRunId===runId))throw new Error('An interrupted reset targets this run. Inspect the saved source and target before explicitly restoring either; no reset was replayed.');}}
  async function switchRun(record,source){
    try{
      await source.quiesce();
      const stopped=await source.stop();if(stopped!==0)throw new Error('The previous run did not stop with a verified checkpoint.');
      const marker=JSON.parse(readFileSync(source.markerPath,'utf8'));
      const {markerSha256,...markerPayload}=marker;
      if(markerSha256!==contentHash(markerPayload)||marker.status!=='ready'||marker.id!==source.id||marker.datasetDigest!==record.datasetDigest||!marker.lastStoppedAt||!/^[a-f0-9]{64}$/.test(marker.checkpoint?.sha256||''))throw new Error('The retained checkpoint was not confirmed.');
      record={...record,checkpointConfirmed:true,updatedAt:now()};save(record);pending=record;lastReset=record;notify();
      const target=await launch({packId,newId:record.targetRunId,uniqueTenant:true,expectedDatasetDigest:record.datasetDigest,control:api});
      if(target.id!==record.targetRunId||target.tenantId!==record.targetRunId||target.packId!==packId||target.datasetDigest!==record.datasetDigest){await target.stop();throw new Error('The fresh run does not match the saved reset intent.');}
      current=target;record={...record,status:'ready',updatedAt:now()};save(record);pending=null;lastReset=record;notify();
    }catch{
      const failed={...record,status:'failed',updatedAt:now()};pending=failed;
      try{save(failed);}catch{pending={...failed,status:'unresolved'};}
      lastReset=pending;notify();
    }
  }
  function reset(principal,value){const clean=input(value),known=lookupExact(clean);if(known)return known;
    if(principal?.role!=='reviewer'||!UUID.test(principal.userId||''))fail(403,'demo_reset_reviewer_required','Only a reviewer can restart this demo pack.');
    if(!current||clean.expectedRunId!==current.id)fail(409,'demo_run_changed','This reset belongs to a different run.');
    if(pending)fail(409,'demo_reset_in_progress','Inspect the saved reset before starting another.');
    const targetRunId=newId();if(!UUID.test(targetRunId)||targetRunId===current.id)throw new Error('A fresh run identity is required.');
    const record={schemaVersion:1,commandId:clean.commandId,sourceRunId:current.id,targetRunId,packId,datasetDigest:current.datasetDigest,status:'switching',checkpointConfirmed:false,requestedBy:principal.userId,createdAt:now(),updatedAt:now()};
    try{save(record,true);}catch{pending={...record,status:'unresolved'};lastReset=pending;notify();throw new RuntimeServiceError(503,'demo_reset_unconfirmed','The reset intent could not be verified. Keep the original command and inspect its saved status.',{uncertain:true});}
    pending=record;lastReset=record;notify();const source=current;
    job=Promise.resolve().then(()=>switchRun(record,source));return publicRecord(record);
  }
  const api={
    assertCanStart,
    attachInitial(handle){if(current)throw new Error('The initial run is already attached.');if(handle.packId!==packId)throw new Error('The initial pack differs.');current=handle;initialRunId=handle.id;notify();},
    current(){return current;},
    snapshot,
    async waitForIdle(){await job;},
    forRun(runId){if(!UUID.test(runId))throw new Error('A run identity is required.');return {describe:()=>({id:runId,packId,resetSupported:true}),blocked:()=>Boolean(pending),lookupExact,status(commandId){const record=pending?.commandId===commandId&&pending.status==='unresolved'?pending:read(commandId);if(!record||record.packId!==packId)fail(404,'demo_reset_not_found','No saved reset was found for that command.');return publicRecord(record);},reset};},
  };
  return api;
}
