import { useEffect, useRef, useState } from 'react';
import { CircleAlert, FileText, RefreshCw } from 'lucide-react';
import { api as baseApi } from './api.js';
import { clarificationStorageKey, hasClarificationIdentity, makeClarificationCommand, readClarificationCommand, verifyClarificationContext, findConfirmedClarification, verifyClarificationAcknowledgement } from './clarification-state.js';
import './evidence-clarification.css';

const blank = () => ({ lineId: '', customerStatement: '', sourceReference: '', note: '' });
const money = amount => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(amount / 100);
const time = at => new Date(at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

function SavedClarification({ item, lines }) {
  const line = lines.find(value => value.id === item.lineId);
  return <article className="clarification-card"><header><strong>Received customer clarification</strong><time dateTime={item.at}>Recorded {time(item.at)}</time></header><p className="clarification-quoted">{item.body}</p><dl><dt>Source reference</dt><dd>{item.sourceReference}</dd><dt>Item identified</dt><dd>{line?.name || item.lineId}</dd><dt>Reviewer reason</dt><dd>{item.note}</dd><dt>Recorded by</dt><dd>{item.actor}</dd></dl><p className="clarification-disclosure">A supporting customer statement. Original packing, delivery and catalogue records remain unchanged.</p></article>;
}

export function EvidenceClarification({ scenario, access, capabilities, onCaseUpdated, onRequestEvidence }) {
  const api = access?.request || baseApi;
  const scope = { tenantId: access?.workspace?.id, userId: access?.session?.userId, role: access?.session?.role, caseId: scenario.id, runId: access?.demoRun?.id };
  const supported = capabilities?.evidenceClarification === true, reviewer = scope.role === 'reviewer';
  const identityVerified = hasClarificationIdentity(scope);
  const key = clarificationStorageKey(scope), viewKey = `${key}:${scenario.revision}:${supported}`;
  const [context, setContext] = useState(null), [pending, setPending] = useState(null), [draft, setDraft] = useState(blank), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [storageBlocked, setStorageBlocked] = useState(false), [notice, setNotice] = useState('');
  const generation = useRef(0), lock = useRef(false), liveView = useRef(viewKey); liveView.current = viewKey;
  const path = `/cases/${encodeURIComponent(scenario.id)}/evidence-request`;
  const currentView = current => current === generation.current && liveView.current === viewKey;

  function acceptContext(value, saved) {
    const checked = verifyClarificationContext(value, scope);
    const matched = findConfirmedClarification(checked, saved, scope);
    setContext(checked);
    if (matched) {
      // Clear a retry only after its exact statement and reviewer are found in
      // independently read history. This permits a later, separate clarification.
      sessionStorage.removeItem(key);
      if (sessionStorage.getItem(key) !== null) throw Error('The saved statement is confirmed, but its browser retry record could not be cleared. Refresh the saved evidence before adding another statement.');
      setPending(null); setStorageBlocked(false); setNotice('The received statement is saved. Its fresh investigation still requires a human refund decision.');
    }
    return checked;
  }

  useEffect(() => {
    const current = ++generation.current, controller = new AbortController();
    lock.current = false; setContext(null); setPending(null); setDraft(blank()); setConfirmed(false); setBusy(''); setError(''); setNotice(''); setStorageBlocked(false);
    if (supported && reviewer && identityVerified) {
      let saved = null;
      try { saved = readClarificationCommand(sessionStorage, key); setPending(saved); }
      catch (failure) { setError(failure.message); setStorageBlocked(true); }
      setBusy('read');
      api(path, { signal: controller.signal }).then(value => { if (currentView(current)) acceptContext(value, saved); })
        .catch(failure => { if (!controller.signal.aborted && currentView(current)) setError(failure.message); })
        .finally(() => { if (currentView(current)) setBusy(''); });
    }
    return () => { generation.current++; controller.abort(); };
  }, [viewKey, reviewer]);

  async function refresh() {
    if (lock.current || !supported || !reviewer || !identityVerified || liveView.current !== viewKey) return;
    const current = generation.current; lock.current = true; setBusy('read'); setError('');
    try {
      const result = await api(path); if (!currentView(current)) return;
      let saved;
      try { saved = readClarificationCommand(sessionStorage, key); }
      catch (failure) { setStorageBlocked(true); throw failure; }
      acceptContext(result, saved); setPending(saved && !findConfirmedClarification(result, saved, scope) ? saved : null);
    } catch (failure) { if (currentView(current)) setError(failure.message); }
    finally { if (currentView(current)) { lock.current = false; setBusy(''); } }
  }

  async function submit(event) {
    event?.preventDefault();
    if (lock.current || !reviewer || !supported || !identityVerified || storageBlocked || liveView.current !== viewKey || !context) return;
    if (!pending && (!confirmed || !context.eligible || context.revision !== scenario.revision || !context.lines.some(line => line.id === draft.lineId))) return;
    const current = generation.current; lock.current = true; setBusy('save'); setError(''); setNotice('');
    try {
      let command = readClarificationCommand(sessionStorage, key);
      if (!command) {
        command = makeClarificationCommand({ expectedRevision: context.revision, ...draft }, crypto.randomUUID());
        sessionStorage.setItem(key, JSON.stringify(command));
        if (!readClarificationCommand(sessionStorage, key)) throw Error('The statement could not be saved for a safe retry. No submission was sent.');
      }
      setPending(command);
      const result = await api(path, { method: 'POST', body: command }); if (!currentView(current)) return;
      const checked = verifyClarificationAcknowledgement(result, scope, command);
      acceptContext(checked.context, command); setDraft(blank()); setConfirmed(false);
      onCaseUpdated?.(checked.case);
    } catch (failure) { if (currentView(current)) setError(failure.message || 'The received statement is not confirmed. Its original request is retained.'); }
    finally { if (currentView(current)) { lock.current = false; setBusy(''); } }
  }

  const update = name => event => { setDraft(value => ({ ...value, [name]: event.target.value })); setConfirmed(false); };
  const canRecord = context?.eligible && context.revision === scenario.revision && !pending && !storageBlocked;
  return <section className="evidence-clarification" aria-label="Customer clarification"><div className="clarification-heading"><div><h3><FileText size={19} />Customer clarification</h3><p>Record a statement already received from the customer. It can identify a missing item, but cannot replace packing facts, settle a delivery dispute or bypass policy.</p></div><span>{supported ? 'Supporting evidence only' : 'Unavailable in this rehearsal'}</span></div>
    {!supported ? <p className="clarification-muted">Recording received clarifications is available in the separate evidence rehearsal. Existing cases and evidence remain unchanged here.</p>
      : !reviewer ? <p className="clarification-muted">A reviewer must record received customer statements. Investigators cannot add or change them.</p>
      : !identityVerified ? <p className="clarification-error" role="alert">Your reviewer identity could not be verified. End this session and choose the reviewer profile again before recording a statement.</p>
      : <><div className="clarification-toolbar"><p>No message is sent to the customer and no source link is fetched.</p><button type="button" onClick={refresh} disabled={Boolean(busy)}><RefreshCw size={14} />{busy === 'read' ? 'Reading saved evidence…' : 'Refresh saved evidence'}</button></div>
        {error && <div className="clarification-error" role="alert"><CircleAlert size={18} /><p>{error}</p></div>}
        {notice && <p className="clarification-notice" role="status">{notice}</p>}
        {context && <><div className="clarification-original"><h4>Original customer request</h4><p>{context.originalComplaint}</p><small>This original request is preserved.</small>{context.requestNote && <><h4>Evidence requested by the reviewer</h4><p>{context.requestNote}</p></>}</div>
          {context.submissions.length > 0 && <div className="clarification-history"><h4>Recorded statements</h4>{context.submissions.map(item => <SavedClarification key={item.id} item={item} lines={context.lines} />)}</div>}</>}
        {pending ? <div className="clarification-pending"><h4>Received statement awaiting confirmation</h4><p>The exact original request is retained. Refresh the saved evidence or retry it unchanged; do not record the statement again.</p><p className="clarification-quoted">{pending.customerStatement}</p><p><strong>Source reference:</strong> {pending.sourceReference}</p><button type="button" onClick={submit} disabled={Boolean(busy) || !context || storageBlocked}>{busy === 'save' ? 'Checking original statement…' : 'Retry exact statement'}</button></div>
          : canRecord ? <form className="clarification-form" onSubmit={submit}><h4>Add the received clarification</h4><fieldset disabled={Boolean(busy)}><legend>Existing order and customer statement</legend><label>Item identified by the customer<select name="lineId" value={draft.lineId} onChange={update('lineId')} required><option value="">Choose an existing order item</option>{context.lines.map(line => <option key={line.id} value={line.id}>{line.name} · {money(line.unitAmountMinor)} each · {line.ordered} ordered, {line.packed} packed</option>)}</select></label><p className="clarification-muted">Choose only an item named by the received statement. Prices, quantities and packing records are fixed.</p><label>Received customer statement<textarea name="customerStatement" value={draft.customerStatement} onChange={update('customerStatement')} rows={4} minLength={10} maxLength={4000} required /></label><label>Source reference<input name="sourceReference" value={draft.sourceReference} onChange={update('sourceReference')} autoComplete="off" minLength={10} maxLength={200} placeholder="For example: synthetic support reply 008" required /></label><p className="clarification-muted">Use a non-sensitive reference. This is a recorded label, not a connection to an inbox or document.</p><label>Reason for recording this clarification<textarea name="note" value={draft.note} onChange={update('note')} rows={3} minLength={10} maxLength={2000} required /></label><label className="clarification-confirm"><input name="confirmation" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} required /><span>I have received this statement, it identifies the selected existing item, and I am recording it as supporting evidence. The original catalogue, packing and delivery records remain unchanged.</span></label><button type="submit" className="clarification-primary" disabled={!confirmed || Boolean(busy)}>{busy === 'save' ? 'Saving received statement…' : 'Save statement and reinvestigate'}</button><p>Saving queues a fresh investigation. Remaining conflicts or policy holds still need review, and every refund still requires approval.</p></fieldset></form>
            : <div className="clarification-blocked"><p>{storageBlocked ? 'The previous statement needs inspection before another can be recorded.' : context ? context.revision !== scenario.revision ? 'The saved case has changed. Refresh the office before recording a statement.' : context.blockedReason || 'No received clarification can be recorded at this stage.' : busy ? 'Loading the saved evidence request…' : 'Refresh saved evidence to inspect this case.'}</p>{context && !context.eligible && scenario.status === 'review' && scenario.review?.state !== 'awaiting-evidence' && !scenario.operationId && !scenario.receipt && onRequestEvidence && <button type="button" onClick={onRequestEvidence} disabled={Boolean(busy)}>Open review to request evidence</button>}</div>}
      </>}
  </section>;
}
