import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDemoResetControl} from '../server/demo-reset-control.mjs';
import {runEvidenceRehearsal,RUNTIME_PORTS,runtimePortInUse,runtimeRehearsalEnvironment} from './run-evidence-rehearsal.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');

// Explicit local reset-enabled supervisor. The original launcher remains
// available without reset controls and can restore its existing v1 markers.
export async function runEvidenceDemo({packId,reuseId,baseDirectory=join(ROOT,'.data/evidence-runtime-rehearsals'),journalDirectory=join(baseDirectory,'reset-commands'),ports=RUNTIME_PORTS,serveUi=true,installSignalHandlers=true,launch=runEvidenceRehearsal,onStateChange=()=>{},log=console.log,warn=console.warn}={}){
  if(!['focused-12','busy-50'].includes(packId)||!ports||!Number.isInteger(ports.api)||!Number.isInteger(ports.ui)||ports.api===ports.ui||Object.values(ports).some(p=>p<1024||p>65535)||serveUi&&(ports.api!==4474||ports.ui!==4473))throw new Error('Use a known pack and the dedicated local preview ports.');
  if(typeof onStateChange!=='function'||typeof log!=='function'||typeof warn!=='function')throw new Error('Use function observers and loggers.');
  if((await Promise.all(Object.values(ports).map(runtimePortInUse))).some(Boolean))throw new Error('The dedicated ports are in use. No running preview was stopped.');
  let proxy,ui,stopping=false,lifecycle='starting',exitCode=null;let resolveDone;const done=new Promise(resolve=>{resolveDone=resolve;});
  const runId=reuseId||randomUUID();
  const snapshot=()=>Object.freeze({...control.snapshot(),lifecycle,exitCode});
  const observerFailed=()=>{try{warn('Rehearsal status could not be published. Inspect the current run before using saved restart instructions.');}catch{}};
  function notify(){try{Promise.resolve(onStateChange(snapshot())).catch(observerFailed);}catch{observerFailed();}}
  const control=createDemoResetControl({journalDirectory,packId,onStateChange:notify,launch:args=>launch({...args,demoControl:args.control,baseDirectory,ports,serve:false,installSignalHandlers:false,printResumeCommand:false})});
  control.assertCanStart(runId);
  const signals=new Map();
  async function stop(){if(stopping)return done;stopping=true;lifecycle='stopping';notify();
    if(ui&&ui.exitCode===null&&ui.signalCode===null)ui.kill('SIGTERM');
    await control.waitForIdle();const handle=control.current();let code=0;
    try{if(handle)code=await handle.stop();}catch{code=1;}
    if(proxy?.listening){proxy.closeAllConnections?.();await new Promise(resolve=>proxy.close(resolve));}
    for(const [signal,listener] of signals)process.removeListener(signal,listener);
    lifecycle=code===0?'stopped':'failed';exitCode=code;notify();
    resolveDone(code);return code;
  }
  try{
    const handle=await launch({packId,...(reuseId?{reuseId}:{newId:runId,uniqueTenant:true}),baseDirectory,ports,serve:false,demoControl:control,installSignalHandlers:false,printResumeCommand:false});control.attachInitial(handle);
    proxy=createServer((request,response)=>{const current=control.current();if(!current){response.writeHead(503);response.end();return;}current.server.emit('request',request,response);});
    proxy.requestTimeout=30000;proxy.headersTimeout=10000;
    await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(ports.api,'127.0.0.1',resolve);});
    if(serveUi){ui=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','vite.evidence.config.mjs','--host','127.0.0.1','--port',String(ports.ui),'--strictPort'],{cwd:ROOT,env:runtimeRehearsalEnvironment(),stdio:'inherit'});ui.once('error',()=>{void stop();});ui.once('exit',()=>{if(!stopping)void stop();});}
    if(installSignalHandlers)for(const signal of ['SIGINT','SIGTERM']){const listener=()=>{void stop();};signals.set(signal,listener);process.once(signal,listener);}
    lifecycle='running';notify();
    log(`Reset-enabled local rehearsal: http://127.0.0.1:${ports.ui}/ . Reset preserves each previous run. All sponsors remain disconnected.`);
    return {get id(){return control.current()?.id||null;},initialRunId:handle.id,url:`http://127.0.0.1:${ports.ui}/`,apiUrl:`http://127.0.0.1:${ports.api}`,control,snapshot,stop,done};
  }catch(error){await stop();throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [packId,option,reuseId,...extra]=process.argv.slice(2);
  if(extra.length||option&&(option!=='--reuse'||!reuseId)){console.error('Use a pack, optionally --reuse and its saved run identity.');process.exitCode=1;}
  else {
    let printed;
    runEvidenceDemo({packId,reuseId,onStateChange:state=>{const key=state.runId+':'+state.lifecycle;if(state.state==='ready'&&['running','stopped'].includes(state.lifecycle)&&key!==printed){printed=key;console.log(`Resume the current saved run: node scripts/run-evidence-demo.mjs ${packId} --reuse ${state.runId}`);}}}).then(async handle=>{process.exitCode=await handle.done;}).catch(error=>{console.error(error.message);process.exitCode=1;});
  }
}
