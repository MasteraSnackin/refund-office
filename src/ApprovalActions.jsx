import { useEffect, useId, useRef, useState } from 'react';
import { Check, CircleAlert, FileText, ShieldCheck } from 'lucide-react';

const money = amount => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: amount % 100 ? 2 : 0 }).format(amount / 100);

export function ApprovalActions({ scenario, order, onApprove, busy = false, capabilities, onEvidence, onPolicy, draft, onDraftChange }) {
  const [localNote, setLocalNote] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const noteId = useId();
  const hintId = useId();
  const titleId = useId();
  const inputRef = useRef(null);
  const submitLock = useRef(false);
  const currentCase = useRef(scenario.id);
  currentCase.current = scenario.id;
  useEffect(() => { setLocalNote(''); setError(''); }, [scenario.id]);
  const note = draft === undefined ? localNote : String(draft ?? '');
  const setNote = value => { if (draft === undefined) setLocalNote(value); else onDraftChange?.(value); };
  const approval = scenario.approval;
  const hasReceipt = Boolean(scenario.receipt);
  const eligible = scenario.status === 'review' && scenario.outcome === 'awaiting-approval' && approval?.state === 'required' && !hasReceipt
    && Number.isSafeInteger(approval.amountMinor) && approval.amountMinor > 0 && approval.currency === 'gbp'
    && typeof approval.fingerprint === 'string' && approval.fingerprint.length > 0;
  const pending = busy || submitting;
  const provider = approval?.provider || capabilities?.payments;
  const mode = provider === 'stripe-sandbox' ? 'Stripe sandbox · test funds' : provider === 'local' ? 'Local simulation' : 'Synthetic order';
  const referencedEvidence = (scenario.evidence || []).filter(item => scenario.proposal?.evidenceIds?.includes(item.id)).slice(0, 3);
  const passed = (scenario.checks || []).filter(check => check.status === 'pass').length;
  const totalChecks = scenario.checks?.length || 0;
  const itemName = order?.lines?.find(line => line.id === approval?.lineId)?.name;

  async function submit(event) {
    event.preventDefault();
    if (pending || submitLock.current || !eligible) return;
    const trimmed = note.trim();
    if (trimmed.length < 10 || trimmed.length > 1000) {
      setError('Explain your approval in 10 to 1,000 characters.');
      inputRef.current?.focus();
      return;
    }
    const submittedCase = scenario.id;
    submitLock.current = true;
    setSubmitting(true);
    setError('');
    try {
      await onApprove({ expectedRevision: scenario.revision, expectedAmountMinor: approval.amountMinor, fingerprint: approval.fingerprint, note: trimmed });
    } catch (failure) {
      if (currentCase.current === submittedCase) setError(failure?.message || 'The approval was not saved. Your note is preserved; check the current proposal before trying again.');
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  if (!eligible) return <div className="approval-unavailable"><CircleAlert size={19} /><p>{hasReceipt ? 'A refund result already exists. Check its saved result before taking another action.' : 'This case has no current refund proposal awaiting approval.'}</p></div>;

  return <section className="approval-actions" aria-labelledby={titleId}>
    <div className="approval-summary">
      <div className="approval-summary-heading"><ShieldCheck size={21} aria-hidden="true" /><div><span className="approval-mode">{mode} · No real money</span><h3 id={titleId}>Your approval is required</h3></div><strong className="approval-amount">{money(approval.amountMinor)}</strong></div>
      <dl className="approval-facts"><div><dt>Order</dt><dd>{approval.orderId}</dd></div><div><dt>Item</dt><dd>{itemName || approval.lineId}{itemName && <span className="approval-line-id">{approval.lineId}</span>}</dd></div><div><dt>Policy</dt><dd>Version {approval.policyVersion}</dd></div></dl>
      <p className="approval-scope">Approve this amount for the missing item shown above. The office checks the current policy again before recording the refund.</p>
    </div>
    <div className="approval-checks">
      <div className="approval-checks-heading"><span><Check size={15} aria-hidden="true" />{totalChecks && passed === totalChecks ? `All ${totalChecks} policy checks passed` : `${passed} of ${totalChecks} policy checks passed`}</span>{onPolicy && <button type="button" onClick={onPolicy} disabled={pending}>View policy checks</button>}</div>
      <div className="approval-evidence"><FileText size={15} aria-hidden="true" /><span>{referencedEvidence.length ? referencedEvidence.map(item => item.title).join(' · ') : 'Evidence references are included in the investigation proposal.'}</span>{onEvidence && <button type="button" onClick={onEvidence} disabled={pending}>View evidence</button>}</div>
    </div>
    <form className="approval-form" onSubmit={submit}>
      <label htmlFor={noteId}>Reason for approval</label>
      <textarea ref={inputRef} id={noteId} rows={3} value={note} onChange={event => { setNote(event.target.value); setError(''); }} placeholder="Explain why the evidence supports this refund." minLength={10} maxLength={1000} required disabled={pending} aria-describedby={hintId} />
      <p id={hintId} className="approval-guidance">Recorded as a local reviewer decision in the case history and decision packet. Approval allows this specific refund to proceed.</p>
      {error && <p className="approval-error" role="alert"><CircleAlert size={16} /><span>{error}</span></p>}
      <div className="approval-submit-bar"><button className="approval-submit" type="submit" disabled={pending}><ShieldCheck size={17} />{pending ? 'Saving approval…' : `Approve ${money(approval.amountMinor)} refund`}</button><span>{mode}</span></div>
    </form>
  </section>;
}
