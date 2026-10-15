import { useEffect, useId, useState } from 'react';
import { Archive, CircleAlert, FileSearch, RotateCcw, Save } from 'lucide-react';

export function ReviewActions({ scenario, onDecide, onPayment, busy }) {
  const [action, setAction] = useState('request-evidence');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const noteId = useId();
  const hintId = useId();
  const choiceId = useId();
  useEffect(() => { setNote(''); setError(''); setAction('request-evidence'); }, [scenario.id]);
  const closed = scenario.status === 'closed';
  const linkedOperation = Boolean(scenario.operationId || scenario.receipt);
  const eligible = (scenario.status === 'review' || closed) && !linkedOperation;
  const saved = scenario.review;
  async function submit(event) {
    event.preventDefault();
    if (busy || !eligible) return;
    const trimmed = note.trim();
    if (trimmed.length < 10) { setError('Explain the next action in at least 10 characters.'); return; }
    setError('');
    try {
      await onDecide({ action: closed ? 'reopen' : action, note: trimmed, expectedRevision: scenario.revision });
      setNote(''); setError(''); setAction('request-evidence');
    }
    catch (failure) { setError(failure.message); }
  }
  return <section className="review-actions" aria-label="Recorded review decision">
    {saved?.note && <div className="review-saved">
      <span className="eyebrow">{saved.state === 'closed' ? 'Closure recorded' : saved.state === 'awaiting-evidence' ? 'Evidence request recorded' : 'Previous review note'}</span>
      <p>{saved.note}</p>
      <span className="review-saved-meta">Local reviewer · {new Date(saved.decidedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
      {saved.state === 'awaiting-evidence' && <small>Internal follow-up only. No message has been sent and no new evidence has been received.</small>}
    </div>}
    {linkedOperation ? <div className="review-operation-note"><CircleAlert size={20} /><div><strong>A payment operation already exists</strong><p>Its saved result must be checked before the case can be resolved. Review cannot cancel or replace that operation.</p><button onClick={onPayment}>View refund result</button></div></div>
      : eligible ? <form onSubmit={submit} className="review-decision-form">
        <h3>{closed ? 'Reopen this review' : 'Record the next action'}</h3>
        {closed ? <p className="review-guidance">Explain why the case needs another look. Reopening keeps its history and does not authorise a refund.</p>
          : <fieldset className="review-choice-list"><legend>Review decision</legend>
            <label className={action === 'request-evidence' ? 'selected' : ''}><input type="radio" name={choiceId} value="request-evidence" checked={action === 'request-evidence'} onChange={() => setAction('request-evidence')} disabled={busy} /><FileSearch size={20} /><span><strong>Request evidence</strong><small>Record what is needed and keep the case on hold.</small></span></label>
            <label className={action === 'close-no-refund' ? 'selected' : ''}><input type="radio" name={choiceId} value="close-no-refund" checked={action === 'close-no-refund'} onChange={() => setAction('close-no-refund')} disabled={busy} /><Archive size={20} /><span><strong>Close without refund</strong><small>Archive the case with a reason. It can be reopened.</small></span></label>
          </fieldset>}
        <label className="review-note-label" htmlFor={noteId}>{closed ? 'Reason to reopen' : action === 'request-evidence' ? 'Evidence needed' : 'Reason for closing'}</label>
        <textarea id={noteId} value={note} onChange={event => setNote(event.target.value)} maxLength={1000} minLength={10} required rows={3} disabled={busy} aria-describedby={hintId} placeholder={closed ? 'What has changed or needs another look?' : action === 'request-evidence' ? 'For example: delivery photograph and recipient confirmation are needed.' : 'Explain why this case is being closed without a refund.'} />
        <p id={hintId} className="review-guidance">Saved in the case history and decision packet. {closed ? 'Existing evidence and policy checks stay unchanged.' : 'This action records a human decision; it does not approve payment.'}</p>
        {error && <p className="review-form-error" role="alert">{error}</p>}
        <div className="review-submit-bar"><button className="review-save" type="submit" disabled={busy}>{closed ? <RotateCcw size={16} /> : <Save size={16} />}{busy ? 'Saving decision…' : closed ? 'Reopen review' : action === 'request-evidence' ? 'Save evidence request' : 'Close without refund'}</button></div>
      </form> : <p className="review-guidance">Review actions become available when an investigation stops for review.</p>}
  </section>;
}
