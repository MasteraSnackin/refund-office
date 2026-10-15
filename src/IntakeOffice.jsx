import { useEffect, useId, useRef, useState } from 'react';
import { Inbox, FileText, ShieldCheck, ArrowRight, RefreshCw, Copy, Download, VolumeX } from 'lucide-react';
import { OperationsDialog, ErrorMessage } from './OperationsControls.jsx';
import { api as baseApi } from './api.js';
import { CaseDownload } from './CaseDownload.jsx';
import { intakeStatus } from './intake-state.js';
import './intake-office.css';

const PENDING_KEY = 'refund-office-pending-intake-v1';
const ACTIVE = new Set(['queued', 'running']);
const defaultComplaint = 'One item from this order is missing. Please check the packing records and refund any item that was not supplied.';
function readPending(key = PENDING_KEY) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key));
    if (saved && typeof saved.eventId === 'string' && typeof saved.orderId === 'string' && typeof saved.complaint === 'string') return saved;
  } catch {}
  return null;
}
function shortTime(value) {
  return value ? new Date(value).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
}

export function IntakeDialog({ open, orders = [], onClose, onCase, onOpenCase, canResume = true, runtime = false, capabilities = {}, worker, apiClient = baseApi, scopeKey }) {
  const api = apiClient, pendingKey = scopeKey ? `${PENDING_KEY}:${scopeKey}` : PENDING_KEY;
  const hosted = capabilities.hosted === true;
  const automaticWorker = worker?.enabled === true || (!runtime && !hosted && worker?.enabled !== false);
  const queueLocation = hosted ? 'Hosted' : !runtime || capabilities.storage === 'postgres-local' ? 'Local' : 'Saved';
  const reviewer = runtime || hosted ? 'a reviewer' : 'you';
  const approval = runtime || hosted ? 'a reviewer’s approval' : 'your approval';
  const [pending, setPending] = useState(() => readPending(pendingKey));
  const [orderId, setOrderId] = useState(() => readPending(pendingKey)?.orderId || '');
  const [complaint, setComplaint] = useState(() => readPending(pendingKey)?.complaint || '');
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [queueError, setQueueError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const sending = useRef(false);
  const formId = useId();
  const orderInputId = useId();
  const complaintId = useId();
  const hintId = useId();
  const selectedOrder = orders.find(order => order.id === orderId);
  useEffect(() => { if (open) setNotice(''); }, [open]);
  useEffect(() => {
    if (!pending && !orders.some(order => order.id === orderId)) setOrderId(orders[0]?.id || '');
  }, [orders, orderId, pending]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer;
    setLoading(true);
    async function poll() {
      try {
        const result = await api('/intake', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setRequests(result.requests); setQueueError(''); setLoading(false);
        if (result.requests.some(request => ACTIVE.has(request.status))) timer = setTimeout(poll, 1200);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setQueueError(failure.message); setLoading(false);
      }
    }
    poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [open, reload]);

  async function submit(event) {
    event.preventDefault();
    if (sending.current) return;
    if (!pending && (!selectedOrder || complaint.trim().length < 8)) { setError('Choose a demo order and describe the issue in at least 8 characters.'); return; }
    const payload = pending || { eventId: crypto.randomUUID(), orderId, complaint: complaint.trim() };
    // Save the exact request before sending. A lost response can be retried safely.
    try { sessionStorage.setItem(pendingKey, JSON.stringify(payload)); }
    catch { setError('This browser could not save the retry information. Enable local session storage before submitting.'); return; }
    setPending(payload); setError(''); setNotice(''); setBusy('submit'); sending.current = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const result = await api('/intake', { method: 'POST', body: payload, signal: controller.signal });
      onCase(result.case);
      setRequests(current => [result.request, ...current.filter(item => item.id !== result.request.id)]);
      try { sessionStorage.removeItem(pendingKey); } catch {}
      setPending(null); setComplaint(''); setReload(value => value + 1);
      setNotice(result.replayed ? `${result.request.caseLabel || result.case.caseId} recovered. The same request was reused.` : automaticWorker ? `${result.request.caseLabel || result.case.caseId} queued. The office will investigate and stop for ${runtime || hosted ? 'a reviewer’s' : 'your'} decision.` : `${result.request.caseLabel || result.case.caseId} saved to the queue. An authorised investigator must process it before review.`);
    } catch (failure) {
      if ([400, 422].includes(failure.status)) {
        try { sessionStorage.removeItem(pendingKey); } catch {}
        setPending(null); setError(failure.message);
      } else setError(`${failure.message} The saved request is unchanged. Retry it to recover the result without creating another case.`);
    } finally { clearTimeout(timeout); setBusy(''); sending.current = false; }
  }
  async function resume(request) {
    if (sending.current) return;
    sending.current = true; setBusy(request.id); setQueueError('');
    try {
      const result = await api('/intake/' + encodeURIComponent(request.id) + '/resume', { method: 'POST', body: {} });
      onCase(result.case);
      setRequests(current => current.map(item => item.id === result.request.id ? result.request : item));
      setReload(value => value + 1);
      setNotice(automaticWorker ? 'Investigation resumed. It will stop before any refund.' : 'Request requeued. An authorised investigator must process it before review.');
    } catch (failure) { setQueueError(failure.message); }
    finally { setBusy(''); sending.current = false; }
  }
  const working = requests.filter(request => ACTIVE.has(request.status)).length;
  return <OperationsDialog open={open} onClose={onClose} className="intake-dialog" title={`${queueLocation} intake queue`} subtitle={automaticWorker ? `Submit a request. The office investigates in the background, then waits for ${reviewer}.` : 'Submit a request to the queue. An authorised investigator must process it before review.'} icon={Inbox} footer={<><span className="operations-footer-note">{queueLocation} queue · {capabilities.analyser === 'anthropic' ? 'Anthropic analyser' : capabilities.analyser === 'openai' ? 'OpenAI analyser' : 'Local analyser'} · Human approval</span><button className="operations-secondary" onClick={onClose}>Back to office</button></>}>
    <div className="intake-boundary"><ShieldCheck size={18} /><p>{automaticWorker ? hosted ? 'Investigation runs in the hosted workspace, even while you inspect another case. ' : 'Investigation runs on the local service, even while you inspect another case. ' : `${hosted ? 'Requests are saved in the hosted workspace. ' : ''}${worker?.enabled === false ? 'Automatic background investigation is not enabled. ' : ''}An authorised investigator must process the queue before review. `}{!hosted && (!capabilities.analyser || capabilities.analyser === 'local') && 'No n8n or model service is contacted. '}Every new refund needs {approval}.</p></div>
    <form id={formId} onSubmit={submit} className="operations-form intake-form">
      <div className="operations-field"><label htmlFor={orderInputId}>Demo order</label><select id={orderInputId} value={orderId} onChange={event => setOrderId(event.target.value)} disabled={Boolean(busy || pending) || !orders.length} required>{!orders.length && <option value="">No demo orders available</option>}{orders.map(order => <option key={order.id} value={order.id}>{order.label || order.id}</option>)}</select></div>
      <div className="operations-field"><div className="operations-field-heading"><label htmlFor={complaintId}>Customer request</label><button className="operations-text-button" type="button" disabled={Boolean(busy || pending) || !selectedOrder} onClick={() => { setComplaint(selectedOrder?.sampleComplaint || selectedOrder?.complaint || defaultComplaint); setError(''); }}>Use sample text</button></div><textarea id={complaintId} rows={3} minLength={8} maxLength={4000} required value={complaint} onChange={event => setComplaint(event.target.value)} disabled={Boolean(busy || pending)} aria-describedby={hintId} placeholder="What was missing or went wrong?" /><p id={hintId} className="operations-field-help">Synthetic order records only. {automaticWorker ? 'The queue checks evidence and policy' : 'An authorised investigator must check evidence and policy'}; intake cannot approve a refund.</p></div>
      {pending && <p className="intake-retry-note">A submission is awaiting confirmation. Its order, text and request reference are saved in this tab. Retry the same request before starting another.</p>}
      <ErrorMessage error={error} />
      <div className="intake-submit"><button className="operations-primary" type="submit" disabled={Boolean(busy) || !orders.length}>{busy === 'submit' ? 'Saving request…' : pending ? 'Retry same request' : automaticWorker ? 'Submit and investigate' : 'Submit request'}<ArrowRight size={16} /></button></div>
    </form>
    {notice && <p className="intake-notice" role="status">{notice}</p>}
    <section className="intake-queue" aria-labelledby="intake-queue-title"><div className="intake-queue-heading"><h3 id="intake-queue-title">Saved requests <span>{requests.length}</span></h3><button className="operations-text-button" type="button" onClick={() => setReload(value => value + 1)} disabled={loading}>Refresh</button></div><p className="intake-queue-context">{working ? `${working} ${working === 1 ? 'request is' : 'requests are'} queued or investigating.` : 'Requests remain here after investigation stops.'}</p>
      <ErrorMessage error={queueError} />
      {loading && !requests.length && <p role="status">Loading saved requests…</p>}
      {!loading && !requests.length && !queueError && <p className="intake-empty">No intake requests yet. {automaticWorker ? 'Submit a demo request above to see the office investigate it.' : 'Submit a demo request above to save it to the queue.'}</p>}
      <ul className="intake-request-list">{requests.map(request => <li key={request.id}><div className="intake-request-top"><strong>{request.caseLabel || 'Saved case'} <span>{request.orderId}</span></strong><span className={'intake-status intake-status-' + request.status}>{intakeStatus(request.status)}</span></div><p className="intake-request-time">{queueLocation} intake · Updated {shortTime(request.updatedAt || request.createdAt)}</p>{request.lastError && <p className="intake-request-error">{typeof request.lastError === 'string' ? request.lastError : request.lastError.message || 'Investigation stopped. Inspect the case before resuming.'}</p>}<div className="intake-request-actions"><button type="button" className="operations-secondary" onClick={async () => { if (await onOpenCase(request.caseId)) onClose(); else setQueueError('The case could not be opened yet. Wait for the current action to finish, then try again.'); }} disabled={Boolean(busy)}>Open case<ArrowRight size={14} /></button>{canResume && ['paused', 'error'].includes(request.status) && <button type="button" className="operations-secondary" onClick={() => resume(request)} disabled={Boolean(busy)}><RefreshCw size={14} />{busy === request.id ? 'Resuming…' : 'Resume investigation'}</button>}</div></li>)}</ul>
    </section>
  </OperationsDialog>;
}

export function BriefingDialog({ open, scenario, onClose, apiClient = baseApi }) {
  const api = apiClient;
  const [briefing, setBriefing] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open || !scenario?.id) return;
    const controller = new AbortController();
    setBriefing(null); setError(''); setNotice('');
    api('/cases/' + encodeURIComponent(scenario.id) + '/briefing', { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setBriefing(result); }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [open, scenario?.id, scenario?.revision, reload]);
  async function copy() {
    try { setError(''); await navigator.clipboard.writeText(briefing.text); setNotice('Briefing copied.'); }
    catch { setError('Copy is unavailable in this browser. Download the decision brief instead.'); }
  }
  const base = '/api/cases/' + encodeURIComponent(scenario?.id || '');
  return <OperationsDialog open={open} onClose={onClose} className="briefing-dialog" title="Case briefing" subtitle={`${scenario?.caseId || ''} · Saved evidence and current decision state`} icon={FileText} footer={<><span className="operations-footer-note">Local text summary · No generated speech</span><button className="operations-secondary" onClick={onClose}>Back to office</button></>}>
    {!briefing && !error && <p role="status">Preparing the saved case briefing…</p>}
    <ErrorMessage error={error} />
    {!briefing && error && <button className="operations-secondary" onClick={() => setReload(value => value + 1)}>Retry briefing</button>}
    {briefing && <><div className="briefing-summary"><span className="eyebrow">Saved case · Revision {briefing.revision}</span><h3>{briefing.title}</h3>{briefing.sections?.length ? briefing.sections.map((section, index) => <section key={index}><h4>{section.heading}</h4><p>{section.text}</p></section>) : <p className="briefing-plain">{briefing.text}</p>}</div><div className="briefing-audio"><VolumeX size={18} /><div><strong>Saved text briefing</strong><p>This view has not generated speech. Optional ElevenLabs audio is available only through a configured saved-case tool; no replacement voice is used.</p></div></div><div className="briefing-downloads"><button className="operations-secondary" onClick={copy}><Copy size={15} />Copy briefing</button><CaseDownload runId={api.runId} className="operations-secondary" href={base + '/report'}><Download size={15} />Decision brief</CaseDownload><CaseDownload runId={api.runId} className="operations-secondary" href={base + '/board-export'}><Download size={15} />Prepared Miro map</CaseDownload></div><p className="operations-field-help">Prepared source records → checks → recommendation → human decision → outputs. This local JSON does not publish a Miro board, and direct import is not verified.</p></>}
    {notice && <p role="status" className="intake-notice">{notice}</p>}
  </OperationsDialog>;
}
