import { useEffect, useRef, useState } from 'react';
import { CircleAlert, ShieldCheck, RefreshCw } from 'lucide-react';
import { api as baseApi } from './api.js';
import { paymentMoney, paymentStorageKey, readPaymentCommand, makePaymentBody, verifyPaymentContext, verifyPaymentExecution, describePaymentExecution } from './payment-authorisation.js';
import './payment-authorisation.css';

function PaymentResult({ execution }) {
  const [title, description] = describePaymentExecution(execution);
  return <div className={`payment-review-result payment-state-${execution.status}`} role="status"><h4>{title}</h4><p>{description}</p>
    <dl className="payment-review-facts"><div><dt>Authorised amount</dt><dd>{paymentMoney(execution.payload.amountMinor)}</dd></div><div><dt>Order</dt><dd>{execution.mapping.orderId}</dd></div><div><dt>Test account</dt><dd>{execution.mapping.accountId}</dd></div><div><dt>Test payment</dt><dd>{execution.mapping.paymentIntentId}</dd></div></dl>
    {execution.refundId && <p>Saved refund reference: <strong>{execution.refundId}</strong></p>}
    {execution.receipt && <div className="payment-review-receipt"><strong>{['succeeded', 'failed', 'pending'].includes(execution.status) ? 'Saved independent provider readback' : 'Earlier saved readback — current result is unresolved'}</strong><p>{paymentMoney(execution.receipt.amount)} · {execution.receipt.status}. This records the last retrieved provider response; it is not a new provider check.</p></div>}
    <details><summary>Exact saved authorisation</summary><dl className="payment-review-details"><dt>Execution</dt><dd>{execution.id}</dd><dt>Payment reviewer</dt><dd>{execution.authorisation.actor}</dd><dt>Authorisation time</dt><dd>{execution.authorisation.at || 'Not supplied in this record'}</dd><dt>Reviewer reason</dt><dd>{execution.authorisation.note}</dd><dt>Original approval</dt><dd>{execution.originalApproval.id}</dd><dt>Approved revision</dt><dd>{execution.authorisation.caseRevision}</dd><dt>Original evidence fingerprint</dt><dd>{execution.authorisation.originalFingerprint}</dd><dt>Submission intent</dt><dd>{execution.submittedAt || 'Not recorded'}</dd><dt>Retry protection</dt><dd>{execution.idempotencyKey}</dd></dl></details>
  </div>;
}

export function PaymentAuthorisation({ scenario, access, capabilities }) {
  const api = access?.request || baseApi;
  const scope = { tenantId: access?.workspace?.id, userId: access?.session?.userId || access?.session?.profileId, role: access?.session?.role, caseId: scenario.id, runId: access?.demoRun?.id };
  const identity = paymentStorageKey(scope), reviewer = scope.role === 'reviewer';
  const configured = capabilities?.hosted === true && capabilities?.separateTestExecutionConfigured === true;
  const viewKey = `${identity}:${scenario.revision}:${configured}`;
  const [context, setContext] = useState(null), [pending, setPending] = useState(null), [execution, setExecution] = useState(null);
  const [draft, setDraft] = useState({ accountId: '', paymentIntentId: '', note: '' }), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [storageBlocked, setStorageBlocked] = useState(false);
  const generation = useRef(0), lock = useRef(false), liveIdentity = useRef(viewKey);
  liveIdentity.current = viewKey;
  const path = `/cases/${encodeURIComponent(scenario.id)}/payment-authorisation`;

  useEffect(() => {
    const current = ++generation.current, controller = new AbortController();
    lock.current = false; setContext(null); setPending(null); setExecution(null); setBusy(''); setError(''); setStorageBlocked(false); setConfirmed(false); setDraft({ accountId: '', paymentIntentId: '', note: '' });
    if (reviewer && configured) {
      let saved = null;
      try { saved = readPaymentCommand(sessionStorage, identity); setPending(saved); }
      catch (failure) { setStorageBlocked(true); setError(failure.message); }
      setBusy('read');
      api(path, { signal: controller.signal }).then(value => {
        if (current !== generation.current || liveIdentity.current !== viewKey) return;
        const checked = verifyPaymentContext(value, scope); setContext(checked);
        if (checked.execution) setExecution(verifyPaymentExecution(checked.execution, scope, saved));
      }).catch(failure => { if (!controller.signal.aborted && current === generation.current && liveIdentity.current === viewKey) setError(failure.message); })
        .finally(() => { if (current === generation.current && liveIdentity.current === viewKey) setBusy(''); });
    }
    return () => { generation.current++; controller.abort(); };
  }, [identity, scenario.revision, configured, reviewer]);

  async function refreshResult() {
    if (lock.current || !reviewer || !configured || liveIdentity.current !== viewKey) return;
    const current = generation.current; lock.current = true; setBusy('read'); setError('');
    try {
      const checked = verifyPaymentContext(await api(path), scope);
      if (current !== generation.current || liveIdentity.current !== viewKey) return;
      setContext(checked);
      // Always read the case-scoped record: it also recovers an execution whose
      // creation response was lost, without guessing an execution identity.
      setExecution(checked.execution ? verifyPaymentExecution(checked.execution, scope, pending) : null);
    } catch (failure) { if (current === generation.current && liveIdentity.current === viewKey) setError(failure.message); }
    finally { if (current === generation.current && liveIdentity.current === viewKey) { lock.current = false; setBusy(''); } }
  }

  async function authorise(event) {
    event?.preventDefault();
    if (lock.current || !reviewer || !configured || storageBlocked || execution || liveIdentity.current !== viewKey || !context) return;
    if (!pending && (!context.eligible || !confirmed || context.caseRevision !== scenario.revision)) return;
    const current = generation.current; lock.current = true; setBusy('authorise'); setError('');
    try {
      // The exact command is saved before the first write. Every error keeps it;
      // neither a reload nor an uncertain response can produce a changed retry.
      const saved = readPaymentCommand(sessionStorage, identity);
      const body = saved || makePaymentBody(context.binding, { accountId: draft.accountId.trim(), paymentIntentId: draft.paymentIntentId.trim(), note: draft.note }, crypto.randomUUID());
      if (!saved) {
        sessionStorage.setItem(identity, JSON.stringify(body));
        if (!readPaymentCommand(sessionStorage, identity)) throw Error('The original authorisation could not be saved for a safe retry.');
      }
      setPending(body);
      const result = await api('/payment-executions', { method: 'POST', body });
      if (current !== generation.current || liveIdentity.current !== viewKey) return;
      if (result.authorisationReadbackVerified !== true) throw Error('The authorisation response was not independently confirmed. The exact original request is retained.');
      const checked = verifyPaymentExecution(result.execution, scope, body);
      if (result.submitted !== Boolean(checked.submittedAt)) throw Error('The authorisation response has an inconsistent submission state. Keep the original request.');
      setExecution(checked); setConfirmed(false);
    } catch (failure) { if (current === generation.current && liveIdentity.current === viewKey) setError(failure.message || 'The authorisation was not confirmed. Keep the saved request and inspect the result.'); }
    finally { if (current === generation.current && liveIdentity.current === viewKey) { lock.current = false; setBusy(''); } }
  }

  const binding = context?.binding;
  const update = name => event => { setDraft(value => ({ ...value, [name]: event.target.value })); setConfirmed(false); };
  const canStart = context?.eligible && context.caseRevision === scenario.revision && !pending && !storageBlocked;
  return <section className="payment-review" aria-label="Stripe test payment review"><div className="payment-review-heading"><div><h3><ShieldCheck size={19} />Stripe test payment review</h3><p>Review the exact payment mapping after the original refund approval. Authorisation and submission are separate steps.</p></div><span>{configured ? 'Separate test executor' : 'Payments disconnected'}</span></div>
    {!configured ? <div className="payment-review-offline"><h4>Unavailable in this rehearsal</h4><p>This office can save the refund decision and its reservation. Test payment authorisation is prepared for the hosted workspace and remains disconnected here.</p><ol><li>A reviewer approves the exact refund recommendation.</li><li>A reviewer separately authorises its test account, payment and amount.</li><li>A dedicated executor submits it and retrieves the result.</li></ol><p>No payment authorisation or provider request is made by this panel.</p></div>
      : !reviewer ? <p className="payment-review-offline">Only a reviewer can inspect or authorise a test payment. Investigators cannot access payment authorisation or execution controls.</p>
      : <><div className="payment-review-toolbar"><p>Submission and provider checks belong to the dedicated executor. This screen only records authorisation and reads saved results.</p><button type="button" onClick={refreshResult} disabled={Boolean(busy)}><RefreshCw size={15} />{busy === 'read' ? 'Reading saved result…' : 'Refresh saved result'}</button></div>
        {error && <div className="payment-review-error" role="alert"><CircleAlert size={18} /><p>{error}</p></div>}
        {execution ? <PaymentResult execution={execution} /> : pending ? <div className="payment-review-pending"><h4>Authorisation awaiting confirmation</h4><p>The original request is saved. Check the result or retry these exact details; a changed authorisation is blocked.</p><dl className="payment-review-facts"><div><dt>Refund</dt><dd>{paymentMoney(pending.expectedAmountMinor)}</dd></div><div><dt>Test account</dt><dd>{pending.mapping.accountId}</dd></div><div><dt>Test payment</dt><dd>{pending.mapping.paymentIntentId}</dd></div><div><dt>Reason</dt><dd>{pending.note}</dd></div></dl><button type="button" onClick={authorise} disabled={Boolean(busy) || storageBlocked || !context || Boolean(context.execution)}>{busy === 'authorise' ? 'Confirming saved authorisation…' : 'Retry exact authorisation'}</button></div>
          : canStart ? <form onSubmit={authorise} className="payment-review-form"><h4>Authorise {paymentMoney(binding.expectedAmountMinor)} in Stripe test mode</h4><dl className="payment-review-facts"><div><dt>Order</dt><dd>{binding.orderId}</dd></div><div><dt>Original payment</dt><dd>{paymentMoney(binding.paymentAmountMinor)}</dd></div><div><dt>Approved refund</dt><dd>{paymentMoney(binding.expectedAmountMinor)}</dd></div><div><dt>Saved case revision</dt><dd>{binding.expectedCaseRevision}</dd></div></dl><details><summary>Inspect the original approval</summary><dl className="payment-review-details"><dt>Approval</dt><dd>{binding.originalApprovalId}</dd><dt>Evidence fingerprint</dt><dd>{binding.originalFingerprint}</dd><dt>Reserved item</dt><dd>{binding.lineId}</dd><dt>Original reviewer</dt><dd>{binding.originalApprovedBy || 'Recorded in the case history'}</dd><dt>Original decision time</dt><dd>{binding.originalApprovedAt || 'Recorded in the case history'}</dd></dl></details>
            <fieldset disabled={Boolean(busy)}><legend>Exact Stripe test payment</legend><div className="payment-review-inputs"><label>Stripe test account<input name="accountId" autoComplete="off" spellCheck="false" value={draft.accountId} onChange={update('accountId')} placeholder="acct_…" pattern="acct_[A-Za-z0-9]{1,100}" maxLength={105} required /></label><label>Test payment reference<input name="paymentIntentId" autoComplete="off" spellCheck="false" value={draft.paymentIntentId} onChange={update('paymentIntentId')} placeholder="pi_…" pattern="pi_[A-Za-z0-9]{1,100}" maxLength={103} required /></label></div><p>The executor must verify this test payment belongs to the saved order and workspace, was paid in GBP for {paymentMoney(binding.paymentAmountMinor)}, and still supports this refund.</p><label>Reason for test payment authorisation<textarea name="note" value={draft.note} onChange={update('note')} rows={3} minLength={10} maxLength={2000} required /></label><label className="payment-review-confirm"><input name="confirmation" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} required /><span>I authorise the separate executor to refund exactly {paymentMoney(binding.expectedAmountMinor)} against the test account and payment above. This is a new payment authorisation tied to the saved approval.</span></label><button className="payment-review-primary" type="submit" disabled={!confirmed || Boolean(busy)}>{busy === 'authorise' ? 'Saving authorisation…' : 'Record test payment authorisation'}</button><p>Recording this decision does not submit the refund. No real money moves in Stripe test mode.</p></fieldset>
          </form> : <p className="payment-review-blocked">{storageBlocked ? 'A saved request needs inspection before another authorisation can be recorded.' : context ? context.caseRevision !== scenario.revision ? 'The saved case has changed. Refresh the office before authorising this payment.' : context.blockedReason || 'No test payment authorisation is currently available.' : busy ? 'Loading the exact saved approval…' : 'Refresh the saved result to check whether authorisation is available.'}</p>}
      </>}
  </section>;
}
