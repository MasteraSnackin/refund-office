import { useEffect, useRef, useState } from 'react';
import { CircleAlert, Download, FileAudio, LayoutDashboard, RefreshCw, ScanText, Workflow } from 'lucide-react';
import { api as baseApi } from './api.js';
import { CaseDownload } from './CaseDownload.jsx';
import { verifyPreparedMiroMap, miroReadbackSummary } from './miro-map-view.js';
import './sponsor-actions.css';

const names={voice:'ElevenLabs',miro:'Miro',modal:'Modal',port:'Port'};
const explanations={voice:'Read the saved case briefing using the explicitly configured voice.',miro:'Prepare the sources, checks, recommendation, human decision and outputs for a Miro board. Publishing needs a configured connection.',modal:'Process a saved evidence document as a separate, non-authoritative aid.',port:'Publish service readiness metadata. No customer or case contents are sent.'};
const icons={voice:FileAudio,miro:LayoutDashboard,modal:ScanText,port:Workflow};
function commandFor(principalKey,scenario,action,extra={}) {
  if (!principalKey) throw new Error('A signed-in workspace identity is required.');
  const key=['refund-office:sponsor',principalKey,scenario.id,scenario.revision,action,extra.evidenceId || ''].join(':');
  const saved=sessionStorage.getItem(key);
  if(saved){const body=JSON.parse(saved);if(body.expectedRevision!==scenario.revision||typeof body.commandId!=='string')throw new Error('The saved command could not be verified.');return body;}
  const body={expectedRevision:scenario.revision,commandId:crypto.randomUUID(),...extra};
  sessionStorage.setItem(key,JSON.stringify(body));return body;
}
function downloadJson(value,filename){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function requestAudio(path,body,runId){
  const response=await fetch(`/api${path}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',...(runId?{'x-refund-demo-run':runId}:{})},body:JSON.stringify(body)});
  if(runId&&response.headers.get('x-refund-demo-run')!==runId){window.dispatchEvent(new CustomEvent('refund-office:session-expired'));throw new Error('The rehearsal changed. This audio response was not applied.');}
  if(!response.ok){let result;try{result=await response.json();}catch{}if(response.status===401)window.dispatchEvent(new CustomEvent('refund-office:session-expired'));throw new Error(result?.error?.message||result?.error||'The voice response was not confirmed. Your saved command has been retained.');}
  if(response.headers.get('content-type')?.split(';')[0]!=='audio/mpeg')throw new Error('No validated MP3 audio was returned.');
  const blob=await response.blob();if(!blob.size||blob.size>3*1024*1024)throw new Error('The audio response is empty or exceeds the size limit.');return blob;
}

const money = amount => Number.isSafeInteger(amount) ? new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format(amount/100) : 'No amount returned';
function Opinion({title,opinion,source}) {
  if (!opinion) return null;
  return <section className="sponsor-opinion"><h5>{title} · {source==='local'?'Local rules':source==='openai'?'OpenAI':source==='anthropic'?'Anthropic':'Saved result'}</h5>{opinion.unavailable ? <p>No opinion was returned. A different model was not substituted.</p> : <><p><strong>{money(opinion.proposal?.amountMinor)}</strong> proposed · {String(opinion.proposal?.issue||'No issue identified').replaceAll('_',' ')}</p><p>{opinion.proposal?.reason}</p><ul><li>{opinion.checks?.referencesKnown?'Evidence references match the saved records.':'Some evidence references could not be matched.'}</li><li>{opinion.checks?.exactMissingValue?'Proposed amount matches the saved missing-item calculation.':'The saved missing-item calculation does not support this amount.'}</li></ul><p>{opinion.supportedBySnapshot?'These limited snapshot checks passed. Human review and the full policy remain required.':'These snapshot checks did not establish support for the proposal.'}</p></>}</section>;
}
function PreparedMap({value,runId}) {
  const labels={sources:'Original sources',investigation:'Investigation and recommendation',policy:'Saved policy checks',decision:'Human decision',destinations:'Outputs and destinations'},stateLabels={saved:'Saved record',waiting:'Waiting',available:'Available locally',unverified:'Not verified'};
  return <div className="miro-prepared-map"><p><strong>Prepared from saved records · This export does not publish a board.</strong></p><p>{value.provenance.nodes.length} records and {value.provenance.edges.length} labelled {value.provenance.edges.length===1?'connection':'connections'}. Arrows describe the saved relationships; they do not imply an agent is working now.</p><p>Record links retrieve the current saved case and may include a later revision. They are not permanent links to this snapshot.</p>
    {Object.entries(labels).map(([key,label])=><details key={key}><summary>{label}</summary><ul>{value.provenance.nodes.filter(node=>node.column===key).map(node=><li key={node.id}><h5>{node.title}<span>{stateLabels[node.state]}</span></h5><p>{node.text}</p>{node.refs.length>0&&<small>References: {node.refs.map(ref=>`${ref.type}: ${ref.id}`).join(' · ')}</small>}{node.links.map(link=><CaseDownload key={link.path} runId={runId} href={link.path} className="miro-record-download"><Download size={13}/>{link.label}</CaseDownload>)}</li>)}</ul></details>)}
    <details><summary>Saved source-to-destination relationships</summary><ul>{value.provenance.edges.map(edge=><li key={edge.id}><p>{value.provenance.nodes.find(node=>node.id===edge.from)?.title} → {value.provenance.nodes.find(node=>node.id===edge.to)?.title}</p><small>{edge.label} · {stateLabels[edge.state]}</small></li>)}</ul></details><ul className="miro-map-limitations">{value.limitations.map((limitation,index)=><li key={index}>{limitation}</li>)}</ul>
  </div>;
}
function ResultSummary({action,value,runId}) {
  if(action==='miro-plan')return <PreparedMap value={value} runId={runId}/>;
  if(action==='analysis')return <><p>{({agreement:'Both opinions agree on the issue, item and amount. Agreement is not approval.',disagreement:'The opinions disagree. Compare their evidence before making a decision.',incomplete:'The comparison is incomplete because an opinion was unavailable.','not-requested':'No second opinion was requested.'})[value.comparison]}</p><div className="sponsor-opinions"><Opinion title="Primary opinion" opinion={value.primary} source={value.events?.[0]?.actor}/><Opinion title="Second opinion" opinion={value.challenger} source={value.events?.[1]?.actor}/></div></>;
  if(action==='modal')return <><p>Processed {value.lines?.length||0} saved text lines. This output is not authoritative evidence.</p><ol className="sponsor-extracted-lines">{(value.lines||[]).slice(0,50).map(line=><li key={line.line}>{line.text||' '}</li>)}</ol>{value.lines?.length>50&&<p>The full result is available in the download.</p>}</>;
  if(action==='miro'){const state=miroReadbackSummary(value);return <><p><strong>{state.complete?'All planned map items have recorded readbacks.':'Map publication is not fully confirmed.'}</strong></p><p>Readback recorded for {state.verifiedNotes} saved {state.verifiedNotes===1?'card':'cards'} and {state.verifiedConnectors} {state.verifiedConnectors===1?'connector':'connectors'}.{!state.complete?' Unconfirmed items remain blocked from reposting.':''}</p><p>A saved readback describes that response; it does not prove the board is unchanged now.</p></>;}
  if(action==='port')return <p>{value.verified?'The recorded readback reports matching service readiness, human approval requirement and unverified live status.':'The service catalogue result is not yet confirmed.'}</p>;
  return <p>Audio was received from the configured voice service. Use the playback controls when you are ready.</p>;
}

export function SponsorActions({scenario,principalKey,apiClient=baseApi}){
  const api=apiClient;
  const [status,setStatus]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(''),[result,setResult]=useState(null),[audioUrl,setAudioUrl]=useState(''),[evidenceId,setEvidenceId]=useState('');
  const generation=useRef(0),lock=useRef(false),audio=useRef(''),observed=useRef('');
  const stamp=[principalKey,scenario.id,scenario.revision].join(':');observed.current=stamp;
  const base=`/cases/${encodeURIComponent(scenario.id)}/sponsor-actions`;
  useEffect(()=>{
    const current=++generation.current,controller=new AbortController();setStatus(null);setError('');setResult(null);setBusy('');lock.current=false;setEvidenceId(scenario.evidence?.[0]?.id||'');
    if(audio.current)URL.revokeObjectURL(audio.current);audio.current='';setAudioUrl('');
    api(`${base}/status`,{signal:controller.signal}).then(data=>{if(current===generation.current)setStatus(data);}).catch(failure=>{if(!controller.signal.aborted&&current===generation.current)setError(failure.message);});
    return()=>{controller.abort();generation.current++;if(audio.current)URL.revokeObjectURL(audio.current);audio.current='';};
  },[scenario.id,scenario.revision,principalKey]);
  async function run(action,{readback=false}={}){
    if(lock.current||observed.current!==stamp)return;const current=generation.current;lock.current=true;setBusy(`${action}${readback?'-readback':''}`);setError('');
    try{
      let output;
      if(action==='miro-plan')output=verifyPreparedMiroMap(await api(`/cases/${encodeURIComponent(scenario.id)}/board-export`),scenario);
      else if(action==='analysis')output=await api(`/cases/${encodeURIComponent(scenario.id)}/analysis`,{method:'POST',body:{expectedRevision:scenario.revision}});
      else {
        const body=readback?{expectedRevision:scenario.revision}:commandFor(principalKey,scenario,action,action==='modal'?{evidenceId}:{});
        if(action==='voice'){
          const blob=await requestAudio(`${base}/voice`,body,api.runId);if(current!==generation.current)return;
          if(audio.current)URL.revokeObjectURL(audio.current);audio.current=URL.createObjectURL(blob);setAudioUrl(audio.current);output={provider:'elevenlabs',audioAvailable:true,scope:'Saved briefing audio received. Playback starts only when you press play.'};
        }else output=await api(`${base}/${action}${readback?'/readback':''}`,{method:'POST',body});
      }
      if(current!==generation.current)return;setResult({action,value:output});
      if(!['analysis','miro-plan'].includes(action)){const next=await api(`${base}/status`);if(current===generation.current)setStatus(next);}
    }catch(failure){if(current===generation.current)setError(failure.message);}
    finally{if(current===generation.current){lock.current=false;setBusy('');}}
  }
  return <section className="sponsor-actions" aria-label="Optional sponsor actions"><div className="sponsor-actions-heading"><div><h3>Saved-case tools</h3><p>Each action uses revision {scenario.revision}. These tools cannot change evidence, approve a refund or submit a payment.</p><p>Readbacks are recorded by authorised workspace members. A saved record alone does not prove a provider action.</p></div><span>{status?.mode==='external-enabled'?'Explicit services enabled':'External services disconnected'}</span></div>
    <div className="sponsor-action-grid">{Object.keys(names).map(action=>{const Icon=icons[action],state=status?.actions?.[action],records=status?.records?.filter(record=>record.action===action)||[],pending=records.some(record=>record.state!=='succeeded');return <article key={action}><div className="sponsor-action-title"><Icon size={19}/><h4>{names[action]}</h4><span>{state?.configured?'Configured · unverified':'Disconnected'}</span></div><p>{explanations[action]}</p><small>{state?.reason || 'Checking saved configuration…'}</small>
      {action==='modal'&&<label className="sponsor-evidence-select">Saved evidence<select value={evidenceId} onChange={event=>setEvidenceId(event.target.value)} disabled={Boolean(busy)||!state?.configured}>{(scenario.evidence||[]).map(item=><option key={item.id} value={item.id}>{item.title||item.id}</option>)}</select></label>}
      {action==='miro'&&<><div className="sponsor-action-buttons"><button type="button" disabled={Boolean(busy)} onClick={()=>run('miro-plan')}>{busy==='miro-plan'?'Reading saved map…':'Inspect prepared map'}</button><CaseDownload runId={api.runId} className="miro-record-download" href={`/api/cases/${encodeURIComponent(scenario.id)}/board-export`}><Download size={14}/>Download prepared map</CaseDownload></div><small>Offline preparation: source records → checks → recommendation → human decision → output. This JSON is not a published board or a verified Miro import.</small></>}
      <div className="sponsor-action-buttons"><button disabled={Boolean(busy)||!state?.configured||(action==='modal'&&!evidenceId)||pending} onClick={()=>run(action)}>{busy===action?'Working…':action==='voice'?'Generate saved briefing':action==='miro'?'Publish prepared map':action==='modal'?'Process saved text':'Publish service metadata'}</button>{['miro','port'].includes(action)&&<button disabled={Boolean(busy)||!state?.configured||!records.length} onClick={()=>run(action,{readback:true})}><RefreshCw size={14}/>{busy===`${action}-readback`?'Checking…':'Check saved result'}</button>}</div>
      {records.map(record=><p className="sponsor-record" key={record.commandId}><strong>{record.state==='succeeded'?(record.verified?(action==='voice'?'Audio received':'Readback recorded'):'Result saved'):record.state==='unknown'?'Unconfirmed — repost blocked':record.state==='pending'?'Saved attempt — awaiting confirmation':record.state}</strong></p>)}
      {records.length>0&&<details className="sponsor-technical"><summary>Saved action details</summary>{records.map(record=><p key={record.commandId}>Command: {record.commandId}<br/>State: {record.state}</p>)}</details>}
      {action==='voice'&&audioUrl&&<audio controls preload="metadata" src={audioUrl} aria-label="ElevenLabs saved case briefing"/>}
    </article>;})}</div>
    <div className="sponsor-analysis"><div><h4>Inspect an advisory analysis</h4><p>Runs only when requested. Local rules work offline; configured model opinions remain advisory and do not change the saved recommendation.</p></div><button disabled={Boolean(busy)} onClick={()=>run('analysis')}>{busy==='analysis'?'Analysing…':'Run advisory analysis'}</button></div>
    {error&&<div className="sponsor-action-error" role="alert"><CircleAlert size={17}/><p>{error}</p></div>}
    {result&&<div className="sponsor-result" role="status"><div><strong>{result.action==='analysis'?'Advisory result':result.action==='miro-plan'?'Prepared Miro source map':`${names[result.action]} result`}</strong><button onClick={()=>downloadJson(result.value,`${scenario.caseId}-${result.action}-revision-${scenario.revision}.json`)}><Download size={15}/>Download result</button></div><p>{result.action==='miro-plan'?'Saved local preparation. No Miro request was made by this inspection.':result.value.scope || (result.value.advisoryOnly?'Advisory only. The saved case and approval are unchanged.':'Saved provider response.')}</p><ResultSummary action={result.action} value={result.value} runId={api.runId}/><details className="sponsor-technical"><summary>Full saved result</summary><pre>{JSON.stringify(result.value,null,2)}</pre></details></div>}
  </section>;
}
