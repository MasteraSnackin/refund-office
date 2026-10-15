import { useEffect, useId, useMemo, useState } from 'react';
import { Search, X, Inbox, Folder, ChevronRight, ReceiptText } from 'lucide-react';
import { caseStatus, caseQueue, filterCases, nextCaseForRole, summariseCases, summariseReviewQueue, reservationLabels } from './case-view.js';
import './review-queue.css';

const FILTERS = [{ id: 'all', label: 'All', count: 'total' }, { id: 'attention', label: 'Needs attention', count: 'attention' }, { id: 'open', label: 'Open', count: 'open' }, { id: 'resolved', label: 'Resolved', count: 'resolved' }];
const QUEUES = [{ id: 'decision', label: 'Ready for decision', description: 'Exact recommendations awaiting a human decision.' }, { id: 'evidence', label: 'Waiting for evidence', description: 'Reviews with a saved request for supporting evidence.' }, { id: 'recovery', label: 'Investigation recovery', description: 'Stopped investigations that need an explicit recovery check.' }, { id: 'holds', label: 'Other holds', description: 'Policy holds, uncertain results or incomplete saved states.' }];
const money = value => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: value % 100 ? 2 : 0 }).format(value / 100);
const validFilter = value => [...FILTERS, ...QUEUES].some(filter => filter.id === value) ? value : 'all';

function amountLabel(item, capabilities) {
  if (item.status === 'closed' || item.outcome === 'closed-no-refund') return 'No refund';
  if (item.outcome === 'already-resolved') return '£0 additional';
  const amount = item.receipt?.amountMinor ?? item.proposedAmountMinor ?? item.proposal?.amountMinor;
  if ((item.receipt?.seeded === true || item.seededRemedy === true) && Number.isSafeInteger(amount)) return money(amount) + ' historical';
  if ((item.outcome === 'approved-not-submitted' || item.status === 'reserved') && Number.isSafeInteger(amount)) return caseQueue(item, { capabilities }).group === 'reserved' ? money(amount) + reservationLabels(capabilities).amountSuffix : money(amount) + ' · inspect record';
  if (item.receipt?.status === 'succeeded' && Number.isSafeInteger(amount)) return money(amount) + ' recorded';
  if (['failed', 'canceled'].includes(item.receipt?.status) && Number.isSafeInteger(amount)) return money(amount) + ' failed';
  if (item.status === 'pending' && Number.isSafeInteger(amount) && amount > 0) return money(amount) + ' pending';
  if (Number.isSafeInteger(amount) && amount > 0) return money(amount) + ' proposed';
  return 'Not assessed';
}

export function CaseInbox({ cases = [], capabilities, permissions = {}, selectedId, onSelect, initialFilter = 'all' }) {
  const [filter, setFilter] = useState(() => validFilter(initialFilter));
  const [query, setQuery] = useState('');
  const searchId = useId();
  const resultsId = useId();
  const summary = useMemo(() => summariseCases(cases), [cases]);
  const queueSummary = useMemo(() => summariseReviewQueue(cases), [cases]);
  const visible = useMemo(() => filterCases(cases, { filter, query }), [cases, filter, query]);
  const next = nextCaseForRole(cases, { selectedId, capabilities, permissions });
  useEffect(() => { setFilter(validFilter(initialFilter)); }, [initialFilter]);
  const searching = query.trim().length > 0;
  const clear = () => { setQuery(''); setFilter('all'); };
  const activeQueue = QUEUES.find(item => item.id === filter);
  const emptyTitle = searching ? 'No matching cases' : activeQueue ? `No cases in ${activeQueue.label.toLowerCase()}` : filter === 'attention' ? 'No cases need attention' : filter === 'open' ? 'No open cases' : filter === 'resolved' ? 'No resolved cases yet' : 'No saved cases yet';
  const emptyBody = searching ? 'Try a case number, order number or a few words from the customer request.' : activeQueue ? activeQueue.description : filter === 'attention' ? 'Cases waiting for evidence, review or a payment result will appear here.' : filter === 'open' ? 'New, running and paused investigations will appear here.' : filter === 'resolved' ? 'Completed investigations and cases closed without a refund will appear here.' : 'Create a case from the office to start an investigation.';
  return <section className="case-inbox" aria-label="Saved case inbox">
    <div className="review-queue-intro"><div><h3>Review queue</h3><p>Choose the work that needs your attention. Each group reflects the saved case records.</p></div><button type="button" className="review-queue-next" disabled={!next} onClick={() => { if (next) onSelect(next.id); }}>Next case for my role<ChevronRight size={15} aria-hidden="true" /></button></div>
    <div className="review-queue-groups" role="group" aria-label="Filter cases by next step">{QUEUES.map(item => <button type="button" key={item.id} className={filter === item.id ? 'selected' : ''} aria-pressed={filter === item.id} aria-label={`${item.label}: ${queueSummary[item.id]} ${queueSummary[item.id] === 1 ? 'case' : 'cases'}`} onClick={() => setFilter(item.id)}><strong>{queueSummary[item.id]}</strong><span>{item.label}</span></button>)}</div>
    <p className="review-queue-note">{permissions.review === true ? 'Reviewer: inspect recommendations, evidence requests and holds before recording a decision.' : permissions.investigate === true ? 'Investigator: inspect queued work and recovery. Refund decisions remain with a reviewer.' : 'Inspection only. Choose an authorised profile to work through its next cases.'} Opening a case does not approve a refund. The next-case button follows saved case order.</p>
    <div className="case-inbox-search"><label className="case-inbox-search-label" htmlFor={searchId}>Search saved cases</label><div className="case-inbox-search-input"><Search size={18} aria-hidden="true" /><input id={searchId} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Case, order or customer request" aria-controls={resultsId} autoComplete="off" />{query && <button type="button" aria-label="Clear case search" onClick={() => setQuery('')}><X size={16} /></button>}</div></div>
    <div className="case-inbox-filters" role="group" aria-label="Filter cases by status">{FILTERS.map(item => <button type="button" key={item.id} className={filter === item.id ? 'selected' : ''} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}><span>{item.label}</span><span className="case-inbox-filter-count">{summary[item.count]}</span></button>)}</div>
    <div className="case-inbox-results-heading"><p role="status" aria-live="polite">{visible.length} of {summary.total} {summary.total === 1 ? 'case' : 'cases'}</p>{(searching || filter !== 'all') && <button type="button" onClick={clear}>Show all cases</button>}</div>
    <div id={resultsId}>{visible.length ? <ul className="case-inbox-list">{visible.map(item => {
      const status = caseStatus(item, capabilities);
      const queue = caseQueue(item, { capabilities, permissions });
      const statusLabel = QUEUES.some(group => group.id === queue.group) ? queue.label : status.label;
      const selected = selectedId === item.id;
      return <li key={item.id}><button type="button" className={`case-inbox-row ${selected ? 'is-selected' : ''}`} onClick={() => onSelect(item.id)} aria-current={selected ? 'true' : undefined} aria-label={`${item.caseId} — ${item.title || item.shortTitle || 'Refund investigation'} — ${statusLabel}${selected ? ' — Selected case' : ''}`}>
        <span className="case-inbox-folder"><Folder size={23} aria-hidden="true" /></span>
        <span className="case-inbox-copy"><span className="case-inbox-identifiers"><strong>{item.caseId}</strong><span>{item.orderId}</span>{selected && <span className="case-inbox-selected-note">Selected</span>}</span><span className="case-inbox-title">{item.title || item.shortTitle || 'Refund investigation'}</span><span className="case-inbox-complaint">{item.complaint || 'No customer request supplied.'}</span><span className="case-inbox-row-meta"><span className={`case-inbox-status ${status.tone}`}><span aria-hidden="true" />{statusLabel}</span><span className="case-inbox-amount">{amountLabel(item, capabilities)}</span></span><span className="review-queue-reason">{queue.reason}</span><span className="review-queue-action"><strong>Next:</strong> {queue.nextAction}</span></span>
        <ChevronRight size={17} className="case-inbox-chevron" aria-hidden="true" />
      </button></li>;
    })}</ul> : <div className="case-inbox-empty"><Inbox size={33} aria-hidden="true" /><h3>{emptyTitle}</h3><p>{emptyBody}</p></div>}</div>
    {summary.recordedCount > 0 && <div className="case-inbox-refunds"><ReceiptText size={17} aria-hidden="true" /><div><strong>Refunds recorded</strong><span>{summary.localMinor > 0 ? `Local simulation ${money(summary.localMinor)}` : ''}{summary.localMinor > 0 && summary.stripeMinor > 0 ? ' · ' : ''}{summary.stripeMinor > 0 ? `Stripe sandbox ${money(summary.stripeMinor)}` : ''}</span><small>{summary.recordedCount} unique {summary.recordedCount === 1 ? 'receipt' : 'receipts'} · Seeded history excluded</small></div></div>}
  </section>;
}
