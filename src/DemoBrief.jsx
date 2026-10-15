import { useEffect, useRef, useState } from 'react';
import { Download, FileText, History, Layers, Play, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { CaseDownload } from './CaseDownload.jsx';
import { buildDemoBrief } from './demo-brief.js';
import { captureReplay, eventTime, recordedAmount, recordedText, replayScope, replayStamp } from './judge-replay.js';
import './demo-brief.css';

// Only captured records and read-only navigation enter this component. It has
// no API client, investigation trigger, approval callback or payment callback.
export function DemoBrief({ open, scenario, capabilities = {}, principalKey, runId, onClose, onInspect, onReplay, onCanvas }) {
  const dialog = useRef(null), current = useRef(''), returnFocus = useRef(null), navigating = useRef(false), lifecycle = useRef({ open: false, generation: 0 });
  const [snapshot, setSnapshot] = useState(null), [error, setError] = useState('');
  if (open && !lifecycle.current.open) lifecycle.current.generation++;
  lifecycle.current.open = open;
  const scope = replayScope(scenario, principalKey, runId);
  const stamp = JSON.stringify([replayStamp(scenario, capabilities), capabilities.identityMode, capabilities.runtime === true, capabilities.paymentSubmission === false]);
  const identity = `${scope}:${stamp}:${lifecycle.current.generation}`; current.current = open ? identity : '';
  const scopeChanged = Boolean(snapshot && snapshot.scope !== scope), changed = Boolean(snapshot && snapshot.stamp !== stamp);
  const active = Boolean(open && snapshot && !scopeChanged && !changed);
  const guard = () => current.current === identity && active;
  function load() {
    if (current.current !== identity) return;
    try { setSnapshot({ ...captureReplay(scenario, capabilities, scope), stamp }); setError(''); }
    catch { setSnapshot(null); setError('The saved case could not be read. Reload it before using this brief.'); }
  }
  useEffect(() => {
    if (!open) { setSnapshot(null); setError(''); }
    else if (!snapshot) load();
  }, [open]);
  useEffect(() => { if (scopeChanged && open) onClose(); }, [scopeChanged, open]);
  useEffect(() => {
    if (open && !scopeChanged && !dialog.current.open) {
      returnFocus.current = typeof document === 'undefined' ? null : document.activeElement;
      navigating.current = false; dialog.current.showModal();
    } else if (!open || scopeChanged) {
      if (dialog.current.open) dialog.current.close();
      if (!navigating.current && returnFocus.current?.isConnected) returnFocus.current.focus?.();
      returnFocus.current = null;
    }
  }, [open, scopeChanged]);
  useEffect(() => () => {
    current.current = '';
    dialog.current?.close();
    if (!navigating.current && returnFocus.current?.isConnected) returnFocus.current.focus?.();
  }, []);
  function close() { current.current = ''; onClose(); }
  function navigate(kind) {
    if (!guard()) return;
    const callback = kind === 'replay' ? onReplay : kind === 'canvas' ? onCanvas : ['evidence', 'policy', 'history'].includes(kind) ? () => onInspect?.(kind) : null;
    if (!callback) return;
    // Closing synchronously lets the destination native dialog acquire focus.
    navigating.current = true; current.current = ''; dialog.current?.close(); onClose(); callback();
  }
  if (!open || scopeChanged) return <dialog ref={dialog} />;
  const brief = snapshot && buildDemoBrief(snapshot.scenario, snapshot.capabilities), saved = snapshot?.scenario;
  return <dialog ref={dialog} className="demo-brief" aria-labelledby="demo-brief-title" aria-describedby="demo-brief-description" onCancel={close} onClick={event => { if (event.target === dialog.current) close(); }}>
    <header className="demo-brief-header"><div><span className="demo-brief-kicker">Synthetic demonstration · Saved case snapshot</span><h2 id="demo-brief-title">Demo brief</h2><p>{brief ? `${brief.caseId} · ${brief.title} · revision ${brief.revision ?? 'not recorded'}` : 'Loading saved case'}</p></div><button type="button" onClick={close} aria-label="Close Demo brief"><X size={20} /></button></header>
    <div className="demo-brief-body">
      <p id="demo-brief-description" className="demo-brief-boundary">Read-only explanation of this saved case. Opening this brief does not investigate, approve, submit a payment or contact a customer.</p>
      {error && <div role="alert" className="demo-brief-change"><p>{error}</p><button type="button" onClick={load}>Reload saved case</button></div>}
      {changed && <div role="status" className="demo-brief-change"><strong>The saved case has changed.</strong><p>This brief retains revision {brief?.revision ?? 'not recorded'}. Load the latest snapshot before opening its records.</p><button type="button" onClick={load}><RefreshCw size={15} />Load latest saved case</button></div>}
      {brief && <div className="demo-brief-grid">
        <section className="demo-brief-card"><span className="demo-brief-step">1 · Problem and user</span><h3>Prepare the review for a small retailer</h3><p>Missing-item refunds require a support reviewer to reconcile a complaint, an order and a packing record. Refund Office saves the recommendation and supporting records for that person to inspect.</p><p className="demo-brief-muted">This prototype uses supplied synthetic cases. It does not verify the authenticity of customer evidence.</p></section>
        <section className="demo-brief-card demo-brief-result"><span className="demo-brief-step">2 · Saved output</span><h3>{brief.status}</h3><p className="demo-brief-amount">{brief.amountMinor === null ? 'Amount not recorded' : recordedAmount(brief.amountMinor)}<span>{brief.amountMinor === null ? '' : ' proposed'}</span></p><p>{brief.reason}</p>{brief.statusReason && brief.statusReason.trim() !== brief.reason.trim() && <p><strong>Saved status:</strong> {brief.statusReason}</p>}{brief.amountMismatch && <p role="alert">The saved proposal and case amounts differ. Inspect the records before any decision.</p>}<p><strong>Human decision:</strong> {brief.decision.text}</p>{brief.decision.actor && <p className="demo-brief-muted">Recorded actor: {brief.decision.actor} · {eventTime(brief.decision.at)}</p>}<p className="demo-brief-payment">{brief.paymentBoundary}</p></section>
        <section className="demo-brief-card"><span className="demo-brief-step">3 · Evidence and checks</span><h3>Trace the saved recommendation</h3><dl className="demo-brief-metrics"><div><dt>Gathered records</dt><dd>{brief.evidenceCount}</dd></div><div><dt>Cited references</dt><dd>{brief.citations.length}</dd></div><div><dt>Saved checks passed</dt><dd>{brief.passedChecks} / {brief.checks.length}</dd></div></dl><p className="demo-brief-muted">{brief.uncitedCount} gathered {brief.uncitedCount === 1 ? 'record is' : 'records are'} not cited by this proposal. These counts describe the loaded snapshot.</p>{brief.unresolvedCitedIds.length > 0 && <p role="alert" className="demo-brief-warning">Unresolved cited references: {brief.unresolvedCitedIds.join(', ')}. Matching gathered records are missing.</p>}<details><summary>Inspect saved citations and checks</summary><h4>Proposal citations</h4>{brief.citations.length ? <ul>{brief.citations.map(citation => <li key={citation.id}><strong>{citation.id}</strong>{citation.resolved ? citation.records.map((record, index) => <span key={index}> · {recordedText(record.title, 'Untitled saved record')} · {recordedText(record.source, 'Source not recorded')}</span>) : ' · No matching gathered record'}</li>)}</ul> : <p>No evidence references are saved on this proposal.</p>}<h4>Recorded checks</h4>{brief.checks.length ? <ul>{brief.checks.map((check, index) => <li key={`${check.id || 'check'}:${index}`}><strong>{recordedText(check.label, recordedText(check.id, 'Saved check'))}: {check.result}</strong><span>{recordedText(check.detail, 'No explanation was saved.')}</span></li>)}</ul> : <p>No policy checks are saved.</p>}<p className="demo-brief-muted">Source references are text; they are not fetched here. A saved check is not a payment result.</p></details></section>
        <section className="demo-brief-card"><span className="demo-brief-step">4 · Architecture and authority</span><h3>{brief.analyser.label}</h3><p>{brief.analyser.detail}</p>{brief.analyser.provider && <p className="demo-brief-muted">Saved source: {brief.analyser.provider}{brief.analyser.model ? ` · ${brief.analyser.model}` : ''}</p>}<ol className="demo-brief-flow"><li>Supplied evidence supports an analyser proposal.</li><li>Service rules constrain the amount, citations, policy and previous remedies.</li><li>A human reviewer decides; a proposal has no payment authority.</li></ol><p><strong>{brief.eventCount} saved {brief.eventCount === 1 ? 'event' : 'events'}.</strong> {brief.latestEvent ? `Latest: ${recordedText(brief.latestEvent.label, 'Unlabelled saved event')}.` : 'No investigation history is saved.'}</p><p className="demo-brief-muted">{brief.identityBoundary}</p></section>
        <section className="demo-brief-card"><span className="demo-brief-step">5 · Inspect the proof</span><h3>Open the supporting records</h3><div className="demo-brief-links"><button type="button" disabled={!active} onClick={() => navigate('evidence')}><FileText size={15} />Saved evidence</button><button type="button" disabled={!active} onClick={() => navigate('policy')}><ShieldCheck size={15} />Saved checks</button><button type="button" disabled={!active} onClick={() => navigate('history')}><History size={15} />Saved decisions</button>{onReplay && <button type="button" disabled={!active} onClick={() => navigate('replay')}><Play size={15} />Replay saved history</button>}{onCanvas && <button type="button" disabled={!active} onClick={() => navigate('canvas')}><Layers size={15} />Case canvas</button>}{active && <CaseDownload runId={runId} className="demo-brief-download" href={'/api/cases/' + encodeURIComponent(saved.id) + (saved.runtime ? '/report' : '/export')}><Download size={15} />Download saved {saved.runtime ? 'decision brief' : 'decision packet'}</CaseDownload>}</div><p className="demo-brief-muted">Navigation opens current saved records. Replay presents saved events; it does not create a new agent run. The case canvas shows recorded sources and destinations.</p></section>
        <section className="demo-brief-card"><span className="demo-brief-step">6 · Business hypothesis</span><h3>Customer benefit remains to be measured</h3><p>Preparing evidence and a supported amount may reduce the work a small retailer needs to review a missing-item refund.</p><p><strong>Validation state: not measured.</strong> Retailer interviews, time saved, willingness to pay and adoption have not been established.</p><p className="demo-brief-muted">The prepared next test compares manual and assisted review of the same synthetic cases, recording review time, outcome, amount, corrections and unfinished tasks. Human approval remains required.</p></section>
      </div>}
    </div><footer className="demo-brief-footer"><span>Saved output · Inspectable evidence · Human decision</span><button type="button" onClick={close}>Back to office</button></footer>
  </dialog>;
}
