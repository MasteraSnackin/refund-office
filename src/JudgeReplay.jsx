import { useEffect, useRef, useState } from 'react';
import { Play, Pause, SkipBack, SkipForward, History, X, FileText, ShieldCheck, Download, RefreshCw } from 'lucide-react';
import { CaseDownload } from './CaseDownload.jsx';
import { caseStatus } from './case-view.js';
import { captureReplay, replayScope, replayStamp, replayDelay, replayPosition, replayKeyAction, eventTime, recordedText, recordedAmount, REPLAY_SPEEDS } from './judge-replay.js';
import './judge-replay.css';

// This component receives saved data and read-only navigation. It deliberately
// has no API client, approval callback, worker trigger or payment callback.
export function JudgeReplay({ open, scenario, capabilities = {}, principalKey, runId, onClose, onInspect }) {
  const dialog = useRef(null), current = useRef('');
  const [snapshot, setSnapshot] = useState(null), [error, setError] = useState('');
  const [position, setPosition] = useState(0), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(1);
  const scope = replayScope(scenario, principalKey, runId), stamp = replayStamp(scenario, capabilities);
  const identity = `${scope}:${stamp}`; current.current = open ? identity : '';
  const scopeChanged = Boolean(snapshot && snapshot.scope !== scope);
  const changed = Boolean(snapshot && snapshot.stamp !== stamp);
  const active = open && !scopeChanged && !changed && snapshot;
  const events = snapshot?.events || [], index = replayPosition(position, events.length), event = events[index];
  const guard = () => current.current === identity && Boolean(active);
  function load() {
    if (current.current !== identity) return;
    try { setSnapshot(captureReplay(scenario, capabilities, scope)); setPosition(0); setPlaying(false); setError(''); }
    catch (failure) { setSnapshot(null); setPlaying(false); setError(failure.message); }
  }
  useEffect(() => {
    if (!open) { setSnapshot(null); setPlaying(false); setError(''); }
    else if (!snapshot) load();
  }, [open]);
  useEffect(() => {
    if (scopeChanged && open) { setPlaying(false); onClose(); }
    else if (changed) setPlaying(false);
  }, [scopeChanged, changed, open]);
  useEffect(() => {
    if (open && !scopeChanged && !dialog.current.open) dialog.current.showModal();
    else if ((!open || scopeChanged) && dialog.current.open) dialog.current.close();
  }, [open, scopeChanged]);
  useEffect(() => () => { current.current = ''; }, []);
  useEffect(() => {
    if (!playing || !active || events.length < 2) return;
    const timer = setTimeout(() => {
      if (!guard()) return;
      if (index >= events.length - 1) setPlaying(false);
      else { setPosition(index + 1); if (index + 1 === events.length - 1) setPlaying(false); }
    }, replayDelay(speed));
    return () => clearTimeout(timer);
  }, [playing, index, speed, identity, Boolean(active), events.length]);
  function seek(value) { if (!guard()) return; setPlaying(false); setPosition(replayPosition(value, events.length)); }
  function toggle() { if (!guard() || events.length < 2) return; if (!playing && index === events.length - 1) setPosition(0); setPlaying(value => !value); }
  function inspect(type) { if (!guard() || !['evidence', 'policy', 'history'].includes(type)) return; setPlaying(false); onClose(); onInspect?.(type); }
  function keyboard(event) {
    if (!guard()) return;
    const action = replayKeyAction(event); if (!action) return; event.preventDefault();
    if (action === 'toggle') toggle(); else seek(action === 'first' ? 0 : action === 'last' ? events.length - 1 : index + (action === 'next' ? 1 : -1));
  }
  if (!open || scopeChanged) return <dialog ref={dialog} />;
  const saved = snapshot?.scenario, savedCapabilities = snapshot?.capabilities;
  return <dialog ref={dialog} className="judge-replay" aria-labelledby="judge-replay-title" aria-describedby="judge-replay-description" onCancel={onClose} onClick={e => { if (e.target === dialog.current) onClose(); }} onKeyDown={keyboard}>
    <header className="judge-header"><div><span className="judge-kicker">Judge mode · Saved history</span><h2 id="judge-replay-title">Follow the case</h2><p>{scenario.caseId} · {scenario.title}</p></div><button type="button" className="judge-close" onClick={onClose} aria-label="Close Judge mode"><X size={21} /></button></header>
    <div className="judge-body">
      <p id="judge-replay-description" className="judge-boundary">Playback only. These are saved events in recorded order. Playing, stepping or seeking does not rerun the agent, approve a refund or submit a payment.</p>
      {error && <p role="alert" className="judge-change">{error}<button type="button" onClick={load}>Reload saved history</button></p>}
      {changed && <div role="status" className="judge-change"><strong>The saved case has changed.</strong><p>Playback is paused at revision {saved?.revision}. Load the latest saved history before continuing or opening its records.</p><button type="button" onClick={load}><RefreshCw size={15} />Load latest saved history</button></div>}
      {snapshot && <><div className="judge-toolbar" aria-label="Playback controls"><button type="button" aria-label="Previous saved event" onClick={() => seek(index - 1)} disabled={!active || index === 0}><SkipBack size={17} /></button><button type="button" className="judge-play" onClick={toggle} disabled={!active || events.length < 2}>{playing ? <Pause size={17} /> : <Play size={17} />}{playing ? 'Pause playback' : index === events.length - 1 && events.length > 1 ? 'Replay from start' : 'Play history'}</button><button type="button" aria-label="Next saved event" onClick={() => seek(index + 1)} disabled={!active || index >= events.length - 1}><SkipForward size={17} /></button><label>Speed<select aria-label="Playback speed" value={speed} disabled={!active} onChange={e => { if (guard() && REPLAY_SPEEDS.includes(Number(e.target.value))) setSpeed(Number(e.target.value)); }}>{REPLAY_SPEEDS.map(value => <option key={value} value={value}>{value}×</option>)}</select></label><span className="judge-count">{events.length ? index + 1 : 0} / {events.length} events</span></div>
        <label className="judge-seek">Saved event<input type="range" min="0" max={Math.max(0, events.length - 1)} step="1" value={index} disabled={!active || events.length < 2} onChange={e => seek(e.target.value)} aria-label="Seek saved event" aria-valuetext={event ? `Event ${index + 1} of ${events.length}: ${recordedText(event.label, 'Saved event')}` : 'No saved events'} /></label>
        <p className="judge-pace">At 1×, each event is shown for 2.5 seconds. This is presentation speed, not the original elapsed time. Use the arrow keys on the playback area or the controls to step.</p>
        {events.length ? <div className="judge-history"><nav aria-label="Saved event list"><ol>{events.map((entry, at) => <li key={entry.replayKey}><button type="button" aria-current={at === index ? 'step' : undefined} disabled={!active} onClick={() => seek(at)}><span className="judge-event-number">{at + 1}</span><span><strong>{recordedText(entry.label, 'Saved event')}</strong><small>{eventTime(entry.at)}</small></span></button></li>)}</ol></nav><article className="judge-event" aria-label="Selected saved event" tabIndex="0"><span className="judge-kicker">Recorded event {index + 1}</span><h3 aria-live="polite">{recordedText(event.label, 'Saved event')}</h3><time dateTime={Number.isFinite(Date.parse(event.at)) ? event.at : undefined}>{eventTime(event.at)}</time><p className="judge-event-detail">{recordedText(event.detail, 'No detail was saved for this event.')}</p><dl><div><dt>Saved event reference</dt><dd>{event.id ?? 'Not recorded'}</dd></div>{event.type && <div><dt>Recorded event type</dt><dd>{event.type}</dd></div>}{event.actor && <div><dt>Recorded actor</dt><dd>{event.actor}</dd></div>}</dl>{event.payload && Object.keys(event.payload).length > 0 && <details className="judge-payload"><summary>Exact saved event fields</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details>}<p className="judge-event-limit">Only the record above describes this point in time. The case summary below may include later evidence or decisions.</p></article></div> : <div className="judge-empty"><History size={30} /><h3>No saved events yet</h3><p>This case has no history to replay. Judge mode will not start an investigation.</p></div>}
        <section className="judge-snapshot" aria-label="Saved case snapshot"><div className="judge-snapshot-heading"><div><span className="judge-kicker">Separate case context · revision {saved.revision}</span><h3>{caseStatus(saved, savedCapabilities).label}</h3></div><span>{recordedAmount(saved.proposal?.amountMinor ?? saved.proposedAmountMinor)} proposed</span></div><p>{saved.summary}</p><dl><div><dt>Evidence gathered in this snapshot</dt><dd>{saved.evidence?.length || 0} records</dd></div><div><dt>Saved policy checks</dt><dd>{saved.checks?.length || 0} checks</dd></div><div><dt>Proposal source</dt><dd>{saved.proposal?.source === 'local' ? 'Local rules' : recordedText(saved.proposal?.source, 'Not recorded')}</dd></div><div><dt>Human decision</dt><dd>{saved.approval?.state === 'approved' ? 'Approval recorded in this snapshot' : saved.review?.state === 'closed' || saved.status === 'closed' ? 'Closure recorded in this snapshot' : saved.review?.state === 'awaiting-evidence' ? 'Evidence requested; refund not approved' : saved.approval?.state === 'required' ? 'Awaiting approval' : 'No approval recorded in this snapshot'}</dd></div></dl>
          {saved.proposal && <p className="judge-citations"><strong>Evidence cited by this snapshot’s proposal:</strong> {Array.isArray(saved.proposal.evidenceIds) && saved.proposal.evidenceIds.length ? saved.proposal.evidenceIds.join(', ') : 'No references recorded'}. This does not establish what an earlier event cited.</p>}
          {saved.receipt?.seeded === true && <p className="judge-citations">This case links to a labelled historical remedy. It is not a new payment from this rehearsal.</p>}
          {savedCapabilities.hosted && savedCapabilities.separateTestExecutionConfigured && <p className="judge-citations">Separate test execution is configured. This case snapshot alone does not establish the payment outcome; inspect the separate execution record in the office.</p>}
          <div className="judge-links"><button type="button" disabled={!active} onClick={() => inspect('evidence')}><FileText size={15} />View saved evidence</button><button type="button" disabled={!active} onClick={() => inspect('policy')}><ShieldCheck size={15} />View saved checks</button><button type="button" disabled={!active} onClick={() => inspect('history')}><History size={15} />View saved decisions</button>{active && <CaseDownload runId={runId} className="judge-download" href={'/api/cases/' + encodeURIComponent(saved.id) + (saved.runtime ? '/report' : '/export')}><Download size={15} />Download saved {saved.runtime ? 'brief' : 'packet'}</CaseDownload>}</div><p className="judge-pace">These links open the currently saved case records, not a reconstruction of the selected historical event. Playback creates no new records.</p>
        </section></>}
    </div><footer className="judge-footer"><span>Saved evidence · Human decisions remain separate</span><button type="button" onClick={onClose}>Back to office</button></footer>
  </dialog>;
}
