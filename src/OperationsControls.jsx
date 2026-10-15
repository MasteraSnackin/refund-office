import { useEffect, useId, useRef, useState } from 'react';
import { Plus, SlidersHorizontal, Plug, Database, X, FileText, ShieldCheck, Check, BrainCircuit, Landmark, Inbox, CircleAlert } from 'lucide-react';
import { api } from './api.js';

const currency = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 2 });
const pounds = minor => currency.format((Number.isSafeInteger(minor) ? minor : 0) / 100);

function modes(capabilities = {}) {
  return {
    ai: ['openai', 'anthropic'].includes(capabilities.analyser) && capabilities.modelConfigured === true,
    stripe: capabilities.payments === 'stripe-sandbox' && capabilities.stripeConfigured === true,
  };
}

export function OperationsBar({ policy, capabilities, onNewCase, onIntake, onPolicy, onConnections, casesCount, onCases, intakeActive = false }) {
  const { ai, stripe } = modes(capabilities);
  return <section className="operations-bar" aria-label="Office controls">
    <div className="operations-actions">
      <button className="operations-new" onClick={onNewCase}><Plus size={17} /><span>New case</span></button>
      {onIntake && <button className="operations-intake" onClick={onIntake}><Inbox size={16} /><span>Intake queue{intakeActive ? ' · Working' : ''}</span></button>}
      <button className="operations-policy" onClick={onPolicy}><SlidersHorizontal size={16} /><span>Refund policy limit <strong>{policy ? pounds(policy.limitMinor) : 'Loading…'}</strong></span></button>
      {onCases && <button className="operations-cases" onClick={onCases}><Inbox size={16} /><span>All cases{Number.isInteger(casesCount) ? ` (${casesCount})` : ''}</span></button>}
    </div>
    <div className="operations-context">
      <button className="operations-connections" onClick={onConnections} aria-label={`View connections: ${ai ? capabilities.analyser === 'anthropic' ? 'Anthropic analyser' : 'OpenAI analyser' : 'Local analyser'}, ${stripe ? 'Stripe sandbox' : 'Local simulation'}`}><Plug size={15} /><span>{ai ? capabilities.analyser === 'anthropic' ? 'Anthropic analyser' : 'OpenAI analyser' : 'Local analyser'}<span className="operations-divider" aria-hidden="true">·</span>{stripe ? 'Stripe sandbox' : 'Local simulation'}</span></button>
      <span className="operations-saved" title="Every new refund waits for your approval"><ShieldCheck size={13} />Approval required</span>
    </div>
  </section>;
}

export function OperationsDialog({ open, onClose, title, subtitle, icon: Icon, children, footer, className = '' }) {
  const ref = useRef(null);
  const titleId = useId();
  const subtitleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector('.operations-dialog-body')?.scrollTo({ top: 0 });
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className={`operations-dialog ${className}`} aria-labelledby={titleId} aria-describedby={subtitleId} onCancel={event => { event.preventDefault(); onClose(); }} onClose={() => { if (open) onClose(); }}>
    <div className="operations-dialog-inner">
      <header className="operations-dialog-header">
        <div className="operations-dialog-heading"><Icon size={25} aria-hidden="true" /><div><h2 id={titleId}>{title}</h2><p id={subtitleId}>{subtitle}</p></div></div>
        <button type="button" className="close-button" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}><X size={19} /></button>
      </header>
      <div className="operations-dialog-body">{children}</div>
      {footer && <footer className="operations-dialog-footer">{footer}</footer>}
    </div>
  </dialog>;
}

export function ErrorMessage({ error }) {
  if (!error) return null;
  return <p className="operations-error" role="alert"><CircleAlert size={17} /><span>{typeof error === 'string' ? error : error.message || 'The request could not be completed. Please try again.'}</span></p>;
}

function sampleComplaint(order) {
  return order?.sampleComplaint || order?.complaint || 'One item from this order is missing. Please check the packing records and refund any item that was not supplied.';
}

export function NewCaseDialog({ open, orders = [], onClose, onCreate, busy = false, submissionBlocked = false, error }) {
  const [orderId, setOrderId] = useState('');
  const [complaint, setComplaint] = useState('');
  const [validation, setValidation] = useState('');
  const selectId = useId();
  const complaintId = useId();
  const hintId = useId();
  const formId = useId();
  const previousOpen = useRef(false);
  const textarea = useRef(null);
  useEffect(() => {
    if (open && !previousOpen.current) {
      setOrderId(orders[0]?.id || '');
      setComplaint('');
      setValidation('');
    }
    previousOpen.current = open;
  }, [open, orders]);
  useEffect(() => {
    if (open && orders.length && !orders.some(order => order.id === orderId)) setOrderId(orders[0].id);
  }, [open, orderId, orders]);
  const selectedOrder = orders.find(order => order.id === orderId);
  const trimmed = complaint.trim();
  const submit = event => {
    event.preventDefault();
    if (busy || submissionBlocked) return;
    if (!selectedOrder) { setValidation('Choose a supplied demo order.'); return; }
    if (trimmed.length < 10) { setValidation('Describe the issue in at least 10 characters.'); textarea.current?.focus(); return; }
    if (trimmed.length > 2000) { setValidation('Keep the request to 2,000 characters or fewer.'); return; }
    setValidation('');
    onCreate({ orderId, complaint: trimmed });
  };
  return <OperationsDialog open={open} onClose={onClose} title="New refund case" subtitle="Investigate a new request against the supplied demo records." icon={FileText} footer={<><span className="operations-footer-note">Synthetic orders only</span><div className="operations-dialog-actions"><button type="button" className="operations-secondary" onClick={onClose}>Cancel</button><button type="submit" className="operations-primary" form={formId} disabled={busy || submissionBlocked || !orders.length}>{busy ? 'Creating case…' : submissionBlocked ? 'Finishing current step…' : 'Create case'}<Plus size={16} /></button></div></>}>
    <form id={formId} onSubmit={submit} className="operations-form">
      <div className="operations-field"><label htmlFor={selectId}>Demo order</label><select id={selectId} value={orderId} onChange={event => { setOrderId(event.target.value); setValidation(''); }} disabled={busy || !orders.length} required>{!orders.length && <option value="">No demo orders available</option>}{orders.map(order => <option key={order.id} value={order.id}>{order.label || (order.id + ' · ' + pounds(order.totalMinor))}</option>)}</select></div>
      {selectedOrder && <div className="operations-order-summary"><span>{selectedOrder.id}</span><span>{selectedOrder.lines?.length ? `${selectedOrder.lines.length} order ${selectedOrder.lines.length === 1 ? 'line' : 'lines'}` : 'Supplied order records'}<span aria-hidden="true"> · </span>{pounds(selectedOrder.totalMinor)}</span></div>}
      <div className="operations-field"><div className="operations-field-heading"><label htmlFor={complaintId}>Customer request</label><button type="button" className="operations-text-button" onClick={() => { setComplaint(sampleComplaint(selectedOrder)); setValidation(''); textarea.current?.focus(); }} disabled={busy || !selectedOrder}>Use sample text</button></div><textarea ref={textarea} id={complaintId} value={complaint} onChange={event => { setComplaint(event.target.value); setValidation(''); }} placeholder="Tell the office what was missing or went wrong…" rows={5} minLength={10} maxLength={2000} required aria-describedby={hintId} disabled={busy} autoFocus /><div id={hintId} className="operations-field-help"><span>The office checks the request against the order and supporting records.</span><span className="operations-count">{complaint.length.toLocaleString('en-GB')} / 2,000</span></div></div>
      <ErrorMessage error={validation || error} />
    </form>
  </OperationsDialog>;
}

export function PolicyDialog({ open, policy, onClose, onSave, busy = false, error }) {
  const [limit, setLimit] = useState('25');
  const [validation, setValidation] = useState('');
  const inputId = useId();
  const hintId = useId();
  const formId = useId();
  const previousOpen = useRef(false);
  useEffect(() => {
    if (open && !previousOpen.current) {
      setLimit(((policy?.limitMinor ?? 2500) / 100).toFixed(2).replace(/\.00$/, ''));
      setValidation('');
    }
    previousOpen.current = open;
  }, [open, policy]);
  const submit = event => {
    event.preventDefault();
    if (busy) return;
    const value = limit.trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(value)) { setValidation('Enter a non-negative amount in pounds, with no more than two decimal places.'); return; }
    const [whole, fraction = ''] = value.split('.');
    const limitMinor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(limitMinor)) { setValidation('Enter a smaller refund limit.'); return; }
    setValidation('');
    onSave({ limitMinor });
  };
  return <OperationsDialog open={open} onClose={onClose} title="Refund policy" subtitle={`Refund rules · Human approval required${policy?.version ? ` · Version ${policy.version}` : ''}`} icon={ShieldCheck} footer={<><span className="operations-footer-note">Completed cases keep their original policy.</span><div className="operations-dialog-actions"><button type="button" className="operations-secondary" onClick={onClose}>Cancel</button><button type="submit" className="operations-primary" form={formId} disabled={busy || !policy}>{busy ? 'Saving policy…' : 'Save policy'}<Check size={16} /></button></div></>}>
    <form id={formId} onSubmit={submit} className="operations-form">
      <div className="operations-field"><label htmlFor={inputId}>Refund policy limit</label><div className="operations-money-input"><span aria-hidden="true">£</span><input id={inputId} value={limit} onChange={event => { setLimit(event.target.value); setValidation(''); }} inputMode="decimal" type="text" maxLength={12} required disabled={busy} aria-describedby={hintId} autoFocus /></div><p className="operations-field-help" id={hintId}>Every refund needs your approval. Requests above this amount remain blocked by policy.</p></div>
      <div className="operations-policy-rules"><h3>Always required</h3><ul><li><ShieldCheck size={17} /><span>You must approve the exact refund before payment.</span></li><li><ShieldCheck size={17} /><span>Evidence must support the refund and its amount.</span></li><li><ShieldCheck size={17} /><span>Only one remedy is allowed for each order line.</span></li><li><ShieldCheck size={17} /><span>Conflicting or missing evidence sends the case to Review.</span></li></ul></div>
      <p className="operations-explanation">The current policy and your case approval are both checked before payment. Changing the policy requires a fresh investigation and approval; it never rewrites a completed refund.</p>
      <ErrorMessage error={validation || error} />
    </form>
  </OperationsDialog>;
}

export function ConnectionsDialog({ open, capabilities, onClose }) {
  const { ai, stripe } = modes(capabilities);
  const [manifest, setManifest] = useState(null);
  const [failure, setFailure] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setFailure(''); setManifest(null);
    api('/integrations', { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setManifest(result); }).catch(error => { if (!controller.signal.aborted) setFailure(error.message); });
    return () => controller.abort();
  }, [open, reload]);
  return <OperationsDialog open={open} onClose={onClose} title="Office connections" subtitle="What is running this demonstration." icon={Plug} footer={<><span className="operations-footer-note">All supplied orders and evidence are synthetic.</span><button type="button" className="operations-primary" onClick={onClose}>Done<Check size={16} /></button></>}>
    <div className="operations-connection-list">
      <article><div className="operations-connection-icon"><BrainCircuit size={22} /></div><div><div className="operations-connection-heading"><h3>{ai ? capabilities.analyser === 'anthropic' ? 'Anthropic analyser' : 'OpenAI analyser' : 'Local analyser'}</h3><span className={`operations-mode ${ai ? 'connected' : ''}`}>{ai ? 'Configured' : 'Local'}</span></div><p>{ai ? 'AI reads the supplied order and evidence records to propose a remedy. The refund policy still decides whether payment is allowed.' : 'The local analyser follows fixed matching rules against the supplied records. An AI connection is not configured.'}</p><p className="operations-connection-detail">Every proposal includes its reason and supporting evidence references.</p></div></article>
      <article><div className="operations-connection-icon"><Landmark size={22} /></div><div><div className="operations-connection-heading"><h3>{stripe ? 'Stripe sandbox' : 'Local simulation'}</h3><span className={`operations-mode ${stripe ? 'connected' : ''}`}>{stripe ? 'Configured' : 'Local'}</span></div><p>{stripe ? 'Refunds use Stripe test payments. The office records the provider’s refund reference and returned status. Test funds only; no real money moves.' : 'Refunds are recorded in the local demonstration. A Stripe sandbox connection is not configured, and no payment service is contacted.'}</p><p className="operations-connection-detail">A recorded remedy prevents another refund for the same order line.</p></div></article>
      <article><div className="operations-connection-icon"><Database size={22} /></div><div><div className="operations-connection-heading"><h3>Saved locally</h3><span className="operations-mode">On this device</span></div><p>Cases, evidence, policy versions and refund records stay available after you reload the page.</p><p className="operations-connection-detail">Decision packets can be downloaded from each case.</p></div></article>
    </div>
    <section className="sponsor-readiness" aria-labelledby="sponsor-readiness-title">
      <h3 id="sponsor-readiness-title">Sponsor integration readiness</h3>
      <p>{manifest?.mode === 'external-enabled' ? 'An external adapter is enabled. The status below distinguishes configured services from local preparation.' : 'External services are disconnected. Local tools demonstrate the workflow without sponsor accounts or credits.'}</p>
      {!manifest && !failure && <p role="status">Loading integration readiness…</p>}
      {failure && <><ErrorMessage error={failure} /><button className="operations-secondary" onClick={() => setReload(value => value + 1)}>Retry readiness check</button></>}
      {manifest && <ul className="sponsor-readiness-list">{manifest.providers.map(provider => <li key={provider.id}><div className="operations-connection-heading"><h4>{provider.name}</h4><span className="operations-mode">{({ disconnected: 'Disconnected', prepared: 'Prepared locally', planned: 'Planned', 'local-only': 'Local only', 'external-enabled': 'External adapter enabled', configured: 'Configured' })[provider.status] || String(provider.status).replaceAll('-', ' ')}</span></div><p className="sponsor-role">{provider.role}</p><p>{provider.detail}</p></li>)}</ul>}
      <p>Prepared code or local configuration does not mean a service is connected or has passed a live test.</p>
      <p className="sponsor-boundary"><ShieldCheck size={15} />No integration may approve a refund. Your explicit decision is always required.</p>
    </section>
  </OperationsDialog>;
}
