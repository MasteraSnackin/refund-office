import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Play, Pause, FileText, History, ChevronRight, ChevronDown, Check, X, ShieldCheck, CircleAlert, ArrowRight, Archive, ReceiptText, Search, Inbox, Landmark, Activity, Download, Circle, RefreshCw, MessageSquareText } from 'lucide-react';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import { OfficeLife } from './OfficeLife.jsx';
import { OfficeAmbience } from './OfficeAmbience.jsx';
import { CaseTray } from './CaseTray.jsx';
import { CaseInbox } from './CaseInbox.jsx';
import { caseStatus, summariseCases, reservationLabels, nextCaseForRole } from './case-view.js';
import { ReviewActions } from './ReviewActions.jsx';
import { ApprovalActions } from './ApprovalActions.jsx';
import { OperationsBar, NewCaseDialog, PolicyDialog, ConnectionsDialog } from './OperationsControls.jsx';
import { api as baseApi } from './api.js';
import { IntakeDialog, BriefingDialog } from './IntakeOffice.jsx';
import { SponsorActions } from './SponsorActions.jsx';
import { PaymentAuthorisation } from './PaymentAuthorisation.jsx';
import { EvidenceClarification } from './EvidenceClarification.jsx';
import { CustomerDraft } from './CustomerDraft.jsx';
import { CaseDownload } from './CaseDownload.jsx';
import { JudgeReplay } from './JudgeReplay.jsx';
import { DemoBrief } from './DemoBrief.jsx';
import { SystemMap } from './SystemMap.jsx';
import { CanvasBoundary } from './CanvasBoundary.jsx';
import { isManagedInvestigation, hasActiveIntake, mergeBootstrap } from './intake-state.js';
import { RuntimeSessionBoundary, RuntimeSessionBar, RuntimeControls, RuntimeInfoDialog, RuntimeApproval, RuntimeRecovery } from './RuntimeAccess.jsx';
import { isRuntimeWorkspace, isReserved, runtimePermissions, prepareRuntimeCommand, readRuntimeCommand, completeRuntimeCommand, isDefinitiveCommandFailure, verifyRuntimeDecision } from './runtime-access.js';

const CaseCanvas = lazy(() => import('./CaseCanvas.jsx').then(module => ({ default: module.CaseCanvas })));

function CaseCanvasDialog({ scenario, principalKey, apiClient, onClose }) {
  const dialog = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    const element = dialog.current;
    element.showModal();
    return () => {
      element.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return <dialog ref={dialog} className="case-canvas-dialog" aria-label="Case canvas"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <CanvasBoundary onClose={onClose}><Suspense fallback={<div className="case-canvas-loading"><p>Opening the saved case canvas…</p><button type="button" onClick={onClose}>Back to office</button></div>}>
      <CaseCanvas scenario={scenario} principalKey={principalKey} apiClient={apiClient} onClose={onClose} />
    </Suspense></CanvasBoundary>
  </dialog>;
}

const STATIONS = [
  { id: 'reception', name: 'Reception', x: 14.8, y: 29, walk: [25.5, 47], icon: Inbox },
  { id: 'evidence', name: 'Evidence', x: 32.7, y: 30, walk: [42, 47], icon: Search },
  { id: 'policy', name: 'Policy', x: 54.7, y: 31, walk: [46.5, 47], icon: ShieldCheck },
  { id: 'payments', name: 'Payments', x: 72, y: 32, walk: [65.5, 47], icon: Landmark },
  { id: 'archive', name: 'Archive', x: 88.5, y: 31, walk: [81.3, 47], icon: Archive },
  { id: 'review', name: 'Review (On hold)', x: 55.7, y: 65, walk: [47.1, 69], icon: CircleAlert },
];
const STEPS = [
  { name: 'Received', station: 'reception' }, { name: 'Evidence', station: 'evidence' },
  { name: 'Check policy', station: 'policy' }, { name: 'Prepare refund', station: 'payments' },
  { name: 'Archive', station: 'archive' },
];
const stageIndex = stage => ({ reception: 0, evidence: 1, policy: 2, payments: 3, archive: 4, review: 2 })[stage] ?? 0;
const money = minor => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: minor % 100 ? 2 : 0 }).format((minor || 0) / 100);
const localTime = at => at ? new Date(at).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
const initialSelection = () => { try { return localStorage.getItem('refund-office-selected') || ''; } catch { return ''; } };
const needsApproval = c => c?.status === 'review' && c?.outcome === 'awaiting-approval' && c?.approval?.state === 'required';
function frameFor(c, capabilities) {
  const status = caseStatus(c, capabilities);
  const label = isReserved(c) ? status.label : c.status === 'ready' ? isManagedInvestigation(c) ? 'Queued for investigation' : 'Ready to investigate' : c.status === 'paused' ? 'Investigation paused'
    : c.status === 'running' ? ({ reception: 'Case received', evidence: 'Checking evidence', policy: 'Checking policy', payments: 'Preparing refund' })[c.stage] || 'Working'
    : status.label;
  return {
    station: c.stage, stage: stageIndex(c.stage), label, detail: c.summary,
    tone: status.tone, terminal: !['ready', 'running', 'paused'].includes(c.status),
    outcome: c.outcome,
    activityLabel: isReserved(c) ? reservationLabels(capabilities).activity : needsApproval(c) ? 'Awaiting your approval' : c.status === 'pending' ? 'Awaiting confirmation' : c.status === 'error' ? 'Needs attention'
      : c.status === 'closed' ? 'Closed without refund' : c.status === 'review' && c.review?.state === 'awaiting-evidence' ? 'Awaiting evidence'
      : c.status === 'complete' ? c.outcome === 'already-resolved' ? 'Previous remedy found' : c.receipt?.provider === 'stripe-sandbox' ? 'Sandbox receipt saved' : 'Local receipt saved' : undefined,
  };
}

export function App() {
  return <RuntimeSessionBoundary>{access => <RefundOffice key={access?.generation ?? 'sqlite'} runtimeAccess={access} />}</RuntimeSessionBoundary>;
}

function RefundOffice({ runtimeAccess }) {
  const api = runtimeAccess?.request || baseApi;
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState(initialSelection);
  const [error, setError] = useState('');
  const [intakeError, setIntakeError] = useState('');
  const [busy, setBusy] = useState(false);
  const [networkBusy, setNetworkBusy] = useState(false);
  const [advanceRetry, setAdvanceRetry] = useState(0);
  const [panel, setPanel] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [judgeOpen, setJudgeOpen] = useState(false);
  const [demoBriefOpen, setDemoBriefOpen] = useState(false);
  const [systemMapOpen, setSystemMapOpen] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [approvalDrafts, setApprovalDrafts] = useState({});
  const [motionEnabled, setMotionEnabled] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [stageEntranceKey, setStageEntranceKey] = useState(null);
  const advancing = useRef(false);
  const officeRef = useRef(null);
  const previousFrame = useRef(null);
  const scenario = data?.cases.find(c => c.id === selectedId) || data?.cases[0];
  const frame = scenario ? frameFor(scenario, data?.capabilities) : null;
  const activeStation = STATIONS.find(s => s.id === frame?.station) || STATIONS[0];
  const phase = scenario?.status === 'running' ? 'running' : scenario?.status === 'paused' ? 'paused' : scenario?.status === 'ready' ? 'ready' : 'complete';
  const frameKey = scenario ? scenario.id + ':' + scenario.stage : 'loading';
  const intakeActive = hasActiveIntake(data?.cases);
  const runtime = Boolean(runtimeAccess) || isRuntimeWorkspace(data);
  const permissions = runtimePermissions(runtimeAccess?.session);
  const pendingRuntimeDecision = runtimeAccess && scenario ? ['approve', 'review', 'resume'].map(action => readRuntimeCommand(sessionStorage, {
    workspaceId: runtimeAccess.workspace.id + (runtimeAccess.demoRun?.id ? ':' + runtimeAccess.demoRun.id : ''), profileId: runtimeAccess.session.profileId, caseId: scenario.id, action,
  })).find(Boolean) : null;

  async function refresh() {
    try { const next = await api('/bootstrap'); setData(current => mergeBootstrap(current, next)); setError(''); setIntakeError(''); }
    catch (e) { setError(e.message); }
  }
  function updateCase(record) {
    setData(current => current && ({ ...current, cases: current.cases.some(c => c.id === record.id) ? current.cases.map(c => c.id === record.id && c.revision <= record.revision ? record : c) : [record, ...current.cases] }));
  }
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    if (!data || busy) return;
    const controller = new AbortController();
    let timer;
    async function poll() {
      try {
        const next = await api('/bootstrap', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setData(current => mergeBootstrap(current, next)); setIntakeError('');
      } catch (failure) {
        if (controller.signal.aborted) return;
        setIntakeError('The intake queue cannot be refreshed. ' + failure.message);
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, intakeActive ? 1200 : 5000);
    }
    timer = setTimeout(poll, intakeActive ? 700 : 5000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [Boolean(data), intakeActive, busy]);
  useEffect(() => {
    if (!scenario) return;
    try { localStorage.setItem('refund-office-selected', scenario.id); } catch {}
  }, [scenario?.id]);
  useEffect(() => { setSystemMapOpen(false); }, [scenario?.id]);
  useEffect(() => {
    if (panel || dialog || judgeOpen || demoBriefOpen || canvasOpen) setSystemMapOpen(false);
  }, [panel, dialog, judgeOpen, demoBriefOpen, canvasOpen]);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const reduce = () => { if (preference.matches) setMotionEnabled(false); };
    preference.addEventListener('change', reduce);
    return () => preference.removeEventListener('change', reduce);
  }, []);
  useEffect(() => {
    const previous = previousFrame.current;
    const entered = previous && previous.id === scenario?.id && (previous.stage !== scenario?.stage || (previous.phase === 'ready' && phase === 'running'));
    if (!motionEnabled || previous?.id !== scenario?.id || phase === 'ready') setStageEntranceKey(null);
    else if (entered) setStageEntranceKey(frameKey);
    previousFrame.current = { id: scenario?.id, stage: scenario?.stage, phase };
  }, [scenario?.id, scenario?.stage, phase, motionEnabled, frameKey]);
  useEffect(() => {
    const office = officeRef.current;
    if (!office) return;
    const centre = behavior => office.scrollTo({ left: office.scrollWidth > office.clientWidth ? office.scrollWidth * activeStation.x / 100 - office.clientWidth / 2 : 0, behavior });
    centre(motionEnabled && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant');
    let first = true;
    const observer = new ResizeObserver(() => { if (first) { first = false; return; } centre('instant'); });
    observer.observe(office);
    return () => observer.disconnect();
  }, [activeStation, motionEnabled, scenario?.id, Boolean(data)]);
  useEffect(() => {
    if (runtime || !scenario || scenario.status !== 'running' || isManagedInvestigation(scenario) || error || busy) return;
    // This beat makes the returned event visible. Only the server response advances the case.
    const timer = setTimeout(async () => {
      if (advancing.current) return;
      advancing.current = true;
      setNetworkBusy(true);
      try { updateCase(await api('/cases/' + scenario.id + '/advance', { method: 'POST', body: { expectedRevision: scenario.revision } })); }
      catch (e) {
        if (e.status === 409) { try { updateCase(await api('/cases/' + scenario.id)); setAdvanceRetry(value => value + 1); } catch (readError) { setError(readError.message); } }
        else setError(e.message);
      } finally { advancing.current = false; setNetworkBusy(false); }
    }, motionEnabled ? 1400 : 200);
    return () => clearTimeout(timer);
  }, [runtime, scenario?.id, scenario?.revision, scenario?.status, scenario?.stage, scenario?.intakeManaged, error, busy, motionEnabled, advanceRetry]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  async function selectCase(id) {
    if (id === scenario.id) { setPanel(null); return true; }
    if (busy || advancing.current) { setNotice('Finishing this step. You can switch cases in a moment.'); return false; }
    setBusy(true);
    try {
      if (!runtime && scenario.status === 'running' && !isManagedInvestigation(scenario)) updateCase(await api('/cases/' + scenario.id + '/pause', { method: 'POST', body: {} }));
      updateCase(await api('/cases/' + id));
      setSelectedId(id); setPanel(null); setError(''); setStageEntranceKey(null);
      return true;
    } catch (e) { setError(e.message); return false; } finally { setBusy(false); }
  }
  function inspectQueuedCase(id) {
    if (id !== scenario.id && !runtime && scenario.status === 'running' && !isManagedInvestigation(scenario)) {
      setNotice('Pause the current investigation before choosing another case from the review queue.');
      return false;
    }
    return selectCase(id);
  }
  async function runButton() {
    if (runtime) { setPanel({ type: 'review' }); return; }
    setBusy(true); setError('');
    const action = scenario.status === 'running' ? 'pause' : scenario.status === 'paused' ? 'resume'
      : ['pending', 'error'].includes(scenario.status) && scenario.operationId ? 'reconcile' : 'run';
    try {
      if (isManagedInvestigation(scenario) && scenario.intakeRequestId && scenario.status !== 'running') {
        const result = await api('/intake/' + encodeURIComponent(scenario.intakeRequestId) + '/resume', { method: 'POST', body: {} });
        updateCase(result.case);
      } else updateCase(await api('/cases/' + scenario.id + '/' + action, { method: 'POST', body: {} }));
    }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function reviewCase(input) {
    if (runtime && !permissions.review) throw new Error('A reviewer test profile is required to record a decision.');
    setBusy(true);
    let command;
    try {
      if (runtime) command = runtimeCommand('review', input);
      const record = await api('/cases/' + scenario.id + '/review', { method: 'POST', body: command?.body || input });
      if (runtime) verifyRuntimeDecision(record, scenario.id);
      if (command) completeRuntimeCommand(sessionStorage, command.key);
      updateCase(record);
      setNotice(input.action === 'request-evidence' ? 'Evidence request saved. No message sent.' : input.action === 'reopen' ? 'Review reopened. Previous history is preserved.' : 'Case closed without a refund.');
    } catch (failure) {
      if (command && isDefinitiveCommandFailure(failure)) completeRuntimeCommand(sessionStorage, command.key);
      if (failure.status === 409) updateCase(await api('/cases/' + scenario.id));
      throw failure;
    } finally { setBusy(false); }
  }
  async function approveCase(input) {
    if (runtime && !permissions.review) throw new Error('An investigator cannot approve a refund. Choose the reviewer test profile to make this decision.');
    setBusy(true); setError('');
    let command;
    try {
      if (runtime) command = runtimeCommand('approve', input);
      const record = await api('/cases/' + scenario.id + '/approve', { method: 'POST', body: command?.body || input });
      if (runtime) verifyRuntimeDecision(record, scenario.id, { approval: input });
      if (command) completeRuntimeCommand(sessionStorage, command.key);
      updateCase(record); setPanel(null);
      setApprovalDrafts(drafts => ({ ...drafts, [scenario.id]: '' }));
      setNotice(isReserved(record) ? reservationLabels(data.capabilities).notice : record.outcome === 'already-resolved' ? 'An existing refund covers this issue. No additional refund was created.' : record.status === 'running' ? 'Your approval is recorded. Checking the approved refund before submission.' : record.summary);
    } catch (failure) {
      if (command && isDefinitiveCommandFailure(failure)) completeRuntimeCommand(sessionStorage, command.key);
      if (failure.status === 409) setData(await api('/bootstrap'));
      throw failure;
    } finally { setBusy(false); }
  }
  function runtimeCommand(action, payload) {
    return prepareRuntimeCommand(sessionStorage, { workspaceId: runtimeAccess.workspace.id + (runtimeAccess.demoRun?.id ? ':' + runtimeAccess.demoRun.id : ''), profileId: runtimeAccess.session.profileId, caseId: scenario.id, action }, payload);
  }
  async function resumeRuntime(input) {
    if (!permissions.investigate || !scenario.intakeRequestId) throw new Error('An investigator profile and saved intake request are required.');
    setBusy(true); let command;
    try {
      command = runtimeCommand('resume', input);
      const result = await api('/intake/' + encodeURIComponent(scenario.intakeRequestId) + '/resume', { method: 'POST', body: command.body });
      verifyRuntimeDecision(result.case, scenario.id);
      completeRuntimeCommand(sessionStorage, command.key); updateCase(result.case); setPanel(null);
      setNotice('Investigation queued again. Previous records are preserved and review is still required.');
    } catch (failure) {
      if (command && isDefinitiveCommandFailure(failure)) completeRuntimeCommand(sessionStorage, command.key);
      if (failure.status === 409) await refresh();
      throw failure;
    } finally { setBusy(false); }
  }
  async function workNext() {
    if (!permissions.investigate || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api('/worker/run-next', { method: 'POST', body: {} });
      if (result.case) updateCase(result.case);
      setNotice(result.empty ? 'No unclaimed requests are ready. Active work keeps its existing owner.' : 'The next investigation step was recorded. Approval remains a separate human decision.');
      await refresh();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  async function retryRuntimeDecision() {
    if (!pendingRuntimeDecision) return;
    if (pendingRuntimeDecision.action === 'approve') return approveCase(pendingRuntimeDecision.payload);
    if (pendingRuntimeDecision.action === 'review') return reviewCase(pendingRuntimeDecision.payload);
    return resumeRuntime(pendingRuntimeDecision.payload);
  }
  async function createCase(input) {
    setBusy(true); setFormError('');
    try {
      if (scenario?.status === 'running' && !isManagedInvestigation(scenario)) updateCase(await api('/cases/' + scenario.id + '/pause', { method: 'POST', body: {} }));
      const created = await api('/cases', { method: 'POST', body: input });
      updateCase(created); setSelectedId(created.id); setDialog(null); setError('');
      setNotice(created.caseId + ' saved. Ready to investigate.');
    } catch (e) { setFormError(e.message); } finally { setBusy(false); }
  }
  async function savePolicy(input) {
    setBusy(true); setFormError('');
    try { const policy = await api('/policy', { method: 'PATCH', body: input }); setData(current => ({ ...current, policy })); setDialog(null); setNotice('Refund policy saved. Every refund still needs your approval.'); }
    catch (e) { setFormError(e.message); } finally { setBusy(false); }
  }
  function openDialog(type) { setSystemMapOpen(false); setFormError(''); setDialog(type); }
  function openSystemMap() { setPanel(null); setDialog(null); setJudgeOpen(false); setDemoBriefOpen(false); setCanvasOpen(false); setSystemMapOpen(true); }
  function stepState(index) {
    if (phase === 'ready') return 'waiting';
    if (scenario.status === 'closed') return index === 3 ? 'skipped' : index === 2 ? 'reviewed' : 'done';
    if (scenario.outcome === 'already-resolved') return index === 3 ? 'skipped' : 'done';
    if (isReserved(scenario)) return index < 3 ? 'done' : index === 3 ? 'held' : 'waiting';
    if (scenario.outcome === 'held' || scenario.status === 'review') return index < 2 ? 'done' : index === 2 ? 'held' : 'waiting';
    if (index < frame.stage || (scenario.status === 'complete' && index === frame.stage)) return 'done';
    return index === frame.stage ? 'active' : 'waiting';
  }
  if (!data || !scenario) return <main className="service-start"><img src="/assets/case-folder.png" alt="" /><h1>Refund Office</h1><p>{error || 'Opening your saved cases…'}</p>{error && <button className="run-button" onClick={refresh}>Retry connection</button>}</main>;
  const cases = data.cases;
  const awaitingApproval = needsApproval(scenario);
  const workload = summariseCases(cases);
  const nextCase = runtime ? nextCaseForRole(cases, { selectedId: scenario.id, capabilities: data.capabilities, permissions })
    : cases.find(c => c.id !== scenario.id && c.status === 'review' && c.review?.state !== 'awaiting-evidence')
      || cases.find(c => c.id !== scenario.id && ['pending', 'error', 'paused', 'ready', 'running'].includes(c.status));
  const trayCases = [scenario, ...cases.filter(c => c.id !== scenario.id)].slice(0, 3).map(c => ({ ...c, shortTitle: c.shortTitle || c.title, status: caseStatus(c, data.capabilities) }));
  const primaryLabel = busy ? 'Saving…' : runtime ? isReserved(scenario) ? 'View reservation' : scenario.status === 'running' ? 'View investigation' : scenario.status === 'ready' ? 'View intake queue' : awaitingApproval ? permissions.review ? 'Review ' + money(scenario.approval.amountMinor) + ' proposal' : 'Inspect recommendation' : scenario.status === 'complete' ? 'Next case' : 'Inspect case'
    : scenario.status === 'ready' && isManagedInvestigation(scenario) ? 'View intake queue' : scenario.status === 'running' ? 'Pause investigation' : scenario.status === 'paused' ? 'Resume investigation'
    : ['pending', 'error'].includes(scenario.status) && scenario.operationId ? 'Check result' : awaitingApproval ? 'Review ' + money(scenario.approval.amountMinor) + ' refund' : scenario.status === 'review' ? 'Review case' : scenario.status === 'closed' ? 'Reopen review' : scenario.status === 'complete' ? nextCase ? 'Next case' : 'Case inbox' : scenario.status === 'ready' ? 'Run investigation' : 'Investigate again';
  const PrimaryIcon = runtime ? isReserved(scenario) ? ReceiptText : scenario.status === 'ready' ? Inbox : scenario.status === 'running' ? History : CircleAlert : scenario.status === 'running' ? Pause : scenario.status === 'ready' || scenario.status === 'paused' ? Play : scenario.status === 'review' ? CircleAlert : scenario.status === 'complete' ? ArrowRight : RefreshCw;
  function primaryAction() {
    if (runtime) {
      if (isReserved(scenario)) return setPanel({ type: 'payments' });
      if (scenario.status === 'running') return setPanel({ type: 'history' });
      if (scenario.status === 'ready') return openDialog('intake');
      if (scenario.status === 'complete') return nextCase ? selectCase(nextCase.id) : setPanel({ type: 'cases' });
      return setPanel({ type: 'review' });
    }
    if (scenario.status === 'ready' && isManagedInvestigation(scenario)) return openDialog('intake');
    if (['review', 'closed'].includes(scenario.status)) return setPanel({ type: 'review' });
    if (scenario.status === 'complete') return nextCase ? selectCase(nextCase.id) : setPanel({ type: 'cases' });
    return runButton();
  }
  const amount = scenario.receipt?.amountMinor ?? scenario.proposedAmountMinor ?? scenario.proposal?.amountMinor ?? 0;
  const amountLabel = isReserved(scenario) ? money(amount) + reservationLabels(data.capabilities).amountSuffix : scenario.status === 'closed' ? 'No refund issued' : scenario.outcome === 'already-resolved' ? 'Additional refund £0' : awaitingApproval ? money(scenario.approval.amountMinor) + (runtime && !permissions.review ? ' awaiting reviewer approval' : ' awaiting your approval') : scenario.status === 'review' ? 'Refund on hold'
    : scenario.status === 'pending' ? 'Awaiting confirmation' : scenario.outcome === 'refunded' ? 'Recorded ' + money(amount)
    : scenario.proposal ? 'Proposed refund ' + money(amount) : 'Refund not assessed';

  return <main className={'refund-app connected-office ' + (phase === 'running' ? 'office-running ' : '') + (phase === 'paused' ? 'office-paused ' : '') + (!motionEnabled ? 'office-motion-off' : '')}>
    <header className="app-header">
      <button className="brand" onClick={() => setPanel({ type: 'cases' })} aria-label="Refund Office — choose a case"><img src="/assets/case-folder.png" alt="" /><span>Refund Office</span></button>
      <span className="environment">{runtime ? data.capabilities.hosted ? data.capabilities.separateTestExecutionConfigured ? 'HOSTED WORKSPACE · SEPARATE TEST EXECUTOR' : 'HOSTED WORKSPACE · RESERVATIONS ONLY' : 'LOCAL REHEARSAL · PAYMENTS DISABLED' : data.capabilities.payments === 'stripe-sandbox' ? 'STRIPE SANDBOX' : 'LOCAL SIMULATION'} <span aria-hidden="true">·</span> SYNTHETIC ORDERS <span aria-hidden="true">·</span> NO REAL MONEY</span>
      <div className="header-actions"><button className="run-button" onClick={primaryAction} disabled={busy || networkBusy}><PrimaryIcon size={19} fill={PrimaryIcon === Play ? 'currentColor' : 'none'} />{networkBusy ? 'Working…' : primaryLabel}</button><time dateTime={runtime ? new Date().toISOString().slice(0, 10) : '2026-10-12'}>{runtime ? new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '12 October 2026'}</time></div>
    </header>
    {runtimeAccess && <RuntimeSessionBar access={runtimeAccess} />}
    {data.demoDataset && <div className="demo-pack-banner" role="status"><strong>{data.demoDataset.title}</strong><span>Separate practice data · Human approval required</span></div>}
    {(error || intakeError) && <div className="service-error" role="alert"><CircleAlert size={18} /><span>{error || intakeError}</span><button onClick={refresh}>Reconnect</button></div>}
    <div className="office-stage"><section className="office-viewport" ref={officeRef} aria-label="Interactive refund operations office"><div className="office-scene">
      <img className="office-art" src="/assets/office-floor.png" alt="A dark pixel-art office with five workstations, a central review desk and warm desk lamps." draggable="false" />
      <OfficeAmbience phase={phase} />
      {STATIONS.map(station => <div key={station.id}>
        <button className={'station-label ' + (station.id === frame.station ? 'current ' : '') + (station.id === 'review' ? 'review-label' : '')} style={{ left: station.x + '%', top: (station.id === 'review' ? 53.8 : 6.7) + '%' }} onClick={() => setPanel({ type: 'station', station: station.id })} aria-label={'Inspect ' + station.name + ' desk'} aria-current={station.id === frame.station ? 'step' : undefined}>{station.name}</button>
        <button className={'desk-hit ' + (station.id === frame.station ? 'desk-active ' : '') + (station.id === 'review' ? 'review-hit ' : '') + (station.id === frame.station && frame.tone === 'warning' ? 'desk-hold' : '')} style={{ left: station.x + '%', top: station.y + '%' }} onClick={() => setPanel({ type: 'station', station: station.id })} aria-label={'Open ' + station.name + ' case details'} />
      </div>)}
      <OfficeLife key={scenario.id} activeStation={activeStation} frame={frame} phase={phase} frameKey={frameKey} motionEnabled={motionEnabled} stageEntranceKey={stageEntranceKey} />
    </div></section><CaseTray cases={trayCases} selectedId={scenario.id} onSelect={selectCase} /></div>
    {runtimeAccess ? <RuntimeControls access={runtimeAccess} policy={data.policy} casesCount={cases.length} onCases={() => setPanel({ type: 'cases' })} onIntake={() => openDialog('intake')} onPolicy={() => setPanel({ type: 'policy' })} onInfo={() => openDialog('runtime-info')} onWorker={workNext} busy={busy} workerActive={intakeActive} />
      : <OperationsBar policy={data.policy} capabilities={data.capabilities} casesCount={cases.length} onCases={() => setPanel({ type: 'cases' })} onNewCase={() => openDialog('new')} onIntake={() => openDialog('intake')} intakeActive={intakeActive} onPolicy={() => openDialog('policy')} onConnections={() => openDialog('connections')} />}
    <section className="case-panel" aria-label="Selected refund case">
      <div className="case-overview">
        <button className="case-folder" onClick={() => setPanel({ type: 'cases' })} aria-label="Choose another case"><img src="/assets/case-folder.png" alt="" /></button>
        <div className="case-copy"><div className="case-heading">
          <button className="case-title" onClick={() => setPanel({ type: 'cases' })}><span>{scenario.caseId}<span className="title-dot"> · </span>{scenario.title}</span><ChevronDown size={21} /></button>
          <span className={'status-pill ' + (phase === 'ready' ? 'neutral' : frame.tone)} role="status"><span className="status-dot" />{frame.label}</span>
        </div>
          <p className="case-amounts">Order {money(scenario.orderTotalMinor)} <ArrowRight size={18} /> {amountLabel}</p>
          <p className="case-summary" aria-live="polite">{scenario.summary || 'Run the investigation to retrieve evidence and check the merchant policy.'}</p>
        </div>
        <div className="case-actions office-case-actions"><button onClick={() => setPanel({ type: 'evidence' })}><FileText /><span>View evidence</span><ChevronRight /></button><button onClick={() => setPanel({ type: 'history' })}><History /><span>View history</span><ChevronRight /></button><button onClick={() => openDialog('briefing')}><MessageSquareText /><span>Brief me</span><ChevronRight /></button><button onClick={() => { setPanel(null); setDialog(null); setJudgeOpen(false); setDemoBriefOpen(false); setSystemMapOpen(false); setCanvasOpen(true); }}><Activity /><span>Case canvas</span><ChevronRight /></button></div>
      </div>
      <ol className="progress-steps" aria-label="Case progress">{STEPS.map((step, i) => {
        const state = stepState(i);
        const detail = state === 'waiting' ? i === 0 ? 'Ready to start' : 'Not checked' : state === 'skipped' ? 'Not required'
          : state === 'reviewed' ? 'Closed by reviewer' : state === 'held' ? isReserved(scenario) ? reservationLabels(data.capabilities).progressDetail : awaitingApproval ? 'Checks passed · human decision' : 'Action stopped' : state === 'active' ? networkBusy ? 'Working' : phase === 'paused' ? 'Paused' : 'In progress'
          : i === 0 ? 'Case saved' : i === 1 ? 'Records retrieved' : i === 2 ? 'Rules evaluated' : i === 3 ? 'Result recorded' : 'History saved';
        return <li className={'progress-step ' + state} key={step.station}><button onClick={() => setPanel(awaitingApproval && i === 2 ? { type: 'review' } : { type: 'station', station: step.station })} aria-label={step.name + ': ' + state + '. View details'} aria-current={state === 'active' || state === 'held' ? 'step' : undefined}><span className="step-marker">{state === 'done' ? <Check size={17} strokeWidth={3} /> : state === 'reviewed' ? <FileText size={13} /> : state === 'held' ? <Pause size={13} fill="currentColor" /> : state === 'skipped' ? <X size={13} /> : null}</span><span className="step-title">{state === 'reviewed' ? 'Reviewed' : state === 'held' ? isReserved(scenario) ? reservationLabels(data.capabilities).stepTitle : awaitingApproval ? 'Human approval' : 'Review needed' : step.name}</span><span className="step-detail">{detail}</span></button></li>;
      })}</ol>
      <div className="footer-note"><button className="office-workload" onClick={() => setPanel({ type: 'cases', filter: workload.attention ? 'attention' : 'all' })} aria-label="Open workload summary"><strong>{workload.attention} {workload.attention === 1 ? 'needs' : 'need'} attention</strong><span>{workload.open} open</span><span>{runtime ? data.capabilities.separateTestExecutionConfigured ? 'Separate execution records' : 'Payments disabled' : money(workload.localMinor) + ' simulated'}</span>{workload.stripeMinor > 0 && <span>{money(workload.stripeMinor)} sandbox</span>}</button><button className="demo-brief-launch" onClick={() => { setPanel(null); setDialog(null); setJudgeOpen(false); setCanvasOpen(false); setSystemMapOpen(false); setDemoBriefOpen(true); }}><FileText size={13} />Demo brief</button><button className="system-map-launch" aria-haspopup="dialog" aria-expanded={systemMapOpen} onClick={openSystemMap}><Activity size={13} />System map</button><button className="judge-launch" onClick={() => { setPanel(null); setDialog(null); setCanvasOpen(false); setDemoBriefOpen(false); setSystemMapOpen(false); setJudgeOpen(true); }}><Play size={13} />Judge mode</button><button className="motion-control" aria-pressed={motionEnabled} aria-label={motionEnabled ? 'Turn office motion off' : 'Turn office motion on'} onClick={() => setMotionEnabled(enabled => !enabled)}><Activity size={13} />Motion {motionEnabled ? 'on' : 'off'}</button><CaseDownload runId={api.runId} className="packet-link" href={'/api/cases/' + scenario.id + '/export'}><Download size={13} />Decision packet</CaseDownload></div>
    </section>
    {runtimeAccess && <CustomerDraft scenario={scenario} capabilities={data.capabilities} apiClient={api} principalKey={`${runtimeAccess.workspace.id}:${runtimeAccess.demoRun?.id || 'original'}:${runtimeAccess.session.userId || runtimeAccess.session.profileId}:${runtimeAccess.session.role}`} />}
    {runtimeAccess && <EvidenceClarification scenario={scenario} access={runtimeAccess} capabilities={data.capabilities} onCaseUpdated={updateCase} onRequestEvidence={() => setPanel({ type: 'review' })} />}
    {runtimeAccess && <PaymentAuthorisation scenario={scenario} access={runtimeAccess} capabilities={data.capabilities} />}
    {runtimeAccess && <SponsorActions scenario={scenario} apiClient={api} principalKey={`${runtimeAccess.workspace.id}:${runtimeAccess.demoRun?.id || 'original'}:${runtimeAccess.session.userId || runtimeAccess.session.profileId}`} />}
    {notice && <div className="toast" role="status"><Check size={18} />{notice}</div>}
    {canvasOpen && <CaseCanvasDialog scenario={scenario} apiClient={api} principalKey={runtimeAccess ? `${runtimeAccess.workspace.id}:${runtimeAccess.demoRun?.id || 'original'}:${runtimeAccess.session.userId || runtimeAccess.session.profileId}:${runtimeAccess.session.role}` : 'legacy-local-simulation'} onClose={() => setCanvasOpen(false)} />}
    <JudgeReplay open={judgeOpen} scenario={scenario} capabilities={data.capabilities} principalKey={runtimeAccess ? `${runtimeAccess.workspace.id}:${runtimeAccess.session.userId || runtimeAccess.session.profileId}:${runtimeAccess.session.role}` : 'local-simulation'} runId={api.runId} onClose={() => setJudgeOpen(false)} onInspect={type => setPanel({ type, replayReadOnly: true })} />
    <DemoBrief open={demoBriefOpen} scenario={scenario} capabilities={data.capabilities} principalKey={runtimeAccess ? `${runtimeAccess.workspace.id}:${runtimeAccess.demoRun?.id || 'original'}:${runtimeAccess.session.userId || runtimeAccess.session.profileId}:${runtimeAccess.session.role}` : 'local-simulation'} runId={api.runId} onClose={() => setDemoBriefOpen(false)} onInspect={type => setPanel({ type, replayReadOnly: true })} onReplay={() => setJudgeOpen(true)} onCanvas={() => setCanvasOpen(true)} />
    <SystemMap open={systemMapOpen} motionEnabled={motionEnabled} onClose={() => setSystemMapOpen(false)} />
    <Inspector runId={api.runId} panel={panel} close={() => setPanel(null)} scenario={scenario} cases={cases} orders={data.orders} policy={data.policy} selectCase={inspectQueuedCase} onReview={reviewCase} onApprove={approveCase} approvalDraft={approvalDrafts[scenario.id] || ''} onApprovalDraft={note => setApprovalDrafts(drafts => ({ ...drafts, [scenario.id]: note }))} capabilities={data.capabilities} onInspect={type => setPanel({ type })} onRun={runButton} onPayment={() => setPanel({ type: 'payments' })} busy={busy || networkBusy} runtime={runtime} permissions={permissions} onResume={resumeRuntime} pendingDecision={pendingRuntimeDecision} onRetryDecision={retryRuntimeDecision} />
    <NewCaseDialog open={dialog === 'new'} orders={data.orders} onClose={() => setDialog(null)} onCreate={createCase} busy={busy} submissionBlocked={networkBusy} error={formError} />
    <PolicyDialog open={dialog === 'policy'} policy={data.policy} onClose={() => setDialog(null)} onSave={savePolicy} busy={busy} error={formError} />
    <IntakeDialog apiClient={api} scopeKey={runtimeAccess ? `${runtimeAccess.workspace.id}:${runtimeAccess.demoRun?.id || 'original'}` : undefined} open={dialog === 'intake'} orders={data.orders} onClose={() => setDialog(null)} onCase={updateCase} onOpenCase={selectCase} canResume={!runtime} runtime={runtime} capabilities={data.capabilities} worker={data.runtime?.worker} />
    <BriefingDialog apiClient={api} open={dialog === 'briefing'} scenario={scenario} onClose={() => setDialog(null)} />
    <ConnectionsDialog open={dialog === 'connections'} capabilities={data.capabilities} onClose={() => setDialog(null)} />
    {runtimeAccess && <RuntimeInfoDialog open={dialog === 'runtime-info'} access={runtimeAccess} onClose={() => setDialog(null)} />}
  </main>;
}

function Inspector({ runId, panel, close, scenario, cases, orders, policy, selectCase, onReview, onApprove, approvalDraft, onApprovalDraft, capabilities, onInspect, onRun, onPayment, busy, runtime, permissions, onResume, pendingDecision, onRetryDecision }) {
  const dialogRef = useRef(null);
  const awaitingApproval = needsApproval(scenario);
  const [retryError, setRetryError] = useState('');
  const decisionBusy = busy || Boolean(pendingDecision);
  useEffect(() => setRetryError(''), [scenario.id, pendingDecision?.commandId]);
  useEffect(() => { if (panel && !dialogRef.current.open) dialogRef.current.showModal(); if (!panel && dialogRef.current.open) dialogRef.current.close(); }, [panel]);
  if (!panel) return <dialog ref={dialogRef} />;
  const order = orders.find(item => item.id === scenario.orderId);
  const type = panel.type === 'station' ? panel.station === 'archive' ? 'history' : panel.station : panel.type;
  const title = ({ cases: 'Case inbox', history: 'Case history', evidence: 'Case evidence', policy: 'Policy checks', payments: runtime ? 'Reservation and payment status' : 'Refund result', review: runtime && needsApproval(scenario) ? 'Review recommendation' : needsApproval(scenario) ? 'Approve refund' : scenario.status === 'closed' ? 'Recorded closure' : 'Case review', reception: 'Case details' })[type];
  const Icon = ({ cases: Inbox, history: History, evidence: FileText, policy: ShieldCheck, payments: ReceiptText, review: CircleAlert, reception: Inbox })[type] || FileText;
  const receipt = scenario.receipt;
  const knownFailure = ['failed', 'canceled'].includes(receipt?.status);
  const unresolved = ['pending', 'error'].includes(scenario.status) && Boolean(scenario.operationId) && !knownFailure;
  const history = <>{scenario.events.length ? <ol className="history-list">{scenario.events.map((event, i) => <li key={event.id || i}><time>{localTime(event.at)}</time><div><strong>{event.label}</strong><p>{event.detail}</p></div></li>)}</ol> : <div className="empty-state"><History size={34} /><h3>No investigation yet</h3><p>This case is saved. Run it to add evidence, policy checks and an outcome.</p></div>}
    {receipt && <Receipt receipt={receipt} />}
    <CaseDownload runId={runId} className="export-button" href={'/api/cases/' + scenario.id + '/export'}><Download size={17} />Download decision packet</CaseDownload>
    {!panel.replayReadOnly && !runtime && ['complete', 'review'].includes(scenario.status) && <button className="export-button history-rerun" onClick={async () => { await onRun(); close(); }} disabled={busy}><RefreshCw size={16} />Investigate again</button>}
    {runtime && <CaseDownload runId={runId} className="export-button" href={'/api/cases/' + scenario.id + '/report'}><Download size={17} />Download decision brief</CaseDownload>}
    <p className="small-disclosure">Saved locally with the evidence, policy version and operation result. Reloading does not remove this case or its receipt.</p></>;
  let content;
  if (type === 'cases') content = <CaseInbox cases={cases} capabilities={capabilities} permissions={runtime ? permissions : { review: true, investigate: true }} selectedId={scenario.id} onSelect={selectCase} initialFilter={panel.filter || 'all'} />;
  else if (type === 'history') content = history;
  else if (type === 'policy') content = <>
    <div className="mandate"><ShieldCheck size={22} /><div><strong>Merchant mandate · version {scenario.policySnapshot?.version || policy.version}</strong><p>Every refund requires your approval. Policy permits evidence-backed refunds up to {money(scenario.policySnapshot?.limitMinor ?? policy.limitMinor)}. One remedy per order line. Conflicting or insufficient evidence requires review.</p></div></div>
    <div className="policy-list">{scenario.checks.map((check, i) => <div className={'policy-check ' + (check.status === 'not_checked' ? 'unchecked' : check.status)} key={check.id || i}>{check.status === 'pass' ? <Check size={20} /> : check.status === 'not_checked' ? <Circle size={20} /> : <CircleAlert size={20} />}<div><strong>{check.label}</strong><p>{check.detail}</p></div><span>{({ pass: 'Passed', hold: 'Review', blocked: 'Blocked', not_checked: 'Not checked' })[check.status] || 'Not checked'}</span></div>)}</div>
    <p className="small-disclosure">{runtime ? 'The service checks the saved evidence, exact amount and current policy again when a reviewer approves a reservation. Payment submission is disabled.' : 'The service enforces these checks before a refund. An analyser cannot override the mandate. Policy changes are checked again before execution.'}</p>
  </>;
  else if (type === 'payments' && runtime) content = <><div className="runtime-reservation-note"><h3>{isReserved(scenario) ? reservationLabels(capabilities).panelTitle : receipt?.seeded ? 'Historical local remedy' : capabilities.separateTestExecutionConfigured ? 'Separate test execution' : 'Payment submission is disabled'}</h3><p>{capabilities.separateTestExecutionConfigured ? 'This panel shows the original case reservation. Separate test execution is configured; inspect its execution record for submission and receipt status. An original reservation alone does not establish the payment result.' : isReserved(scenario) ? `${money(scenario.approval?.amountMinor || scenario.proposedAmountMinor)} is reserved against the saved decision. No payment provider was contacted and no refund receipt was created.` : receipt?.seeded ? 'This is an imported synthetic historical receipt, not a new payment from this rehearsal.' : 'The reviewer may record an exact approval and reservation. This local rehearsal cannot submit a refund.'}</p>{scenario.operationId && <p>Saved operation: {scenario.operationId}</p>}</div>{receipt && <Receipt receipt={receipt} />}<CaseDownload runId={runId} className="export-button" href={'/api/cases/' + scenario.id + '/report'}><Download size={17} />Download decision brief</CaseDownload><button className="export-button" onClick={() => onInspect('history')}><History size={17} />View recorded decisions</button></>;
  else if (type === 'payments') content = <><div className="payment-summary"><ReceiptText size={34} /><span className="eyebrow">{receipt ? receipt.provider === 'stripe-sandbox' ? 'Stripe sandbox · test funds' : 'Local payment simulation' : 'Refund operation'}</span><strong>{unresolved ? 'Result unconfirmed' : receipt ? money(receipt.amountMinor) + ' · ' + receipt.status : awaitingApproval ? money(scenario.approval.amountMinor) + ' awaiting your approval' : scenario.status === 'review' ? 'Refund on hold' : 'No refund recorded'}</strong><p>{unresolved ? 'The original operation is saved. Check its result before another action; no new refund will be submitted.' : receipt ? receipt.id : 'Your approval and all policy checks are required before a refund can be recorded.'}</p></div>{receipt && <Receipt receipt={receipt} />}<p className="small-disclosure">No real money moves. A local receipt demonstrates the workflow; a Stripe sandbox receipt confirms a test API operation.</p></>;
  else if (type === 'review' && needsApproval(scenario)) content = <>{runtime ? <RuntimeApproval scenario={scenario} order={order} draft={approvalDraft} onDraftChange={onApprovalDraft} onApprove={onApprove} busy={decisionBusy} canReview={permissions.review} onEvidence={() => onInspect('evidence')} onPolicy={() => onInspect('policy')} /> : <ApprovalActions scenario={scenario} order={order} draft={approvalDraft} onDraftChange={onApprovalDraft} onApprove={onApprove} capabilities={capabilities} busy={decisionBusy} onEvidence={() => onInspect('evidence')} onPolicy={() => onInspect('policy')} />}{(!runtime || permissions.review) && <details className="approval-alternatives"><summary>Request evidence or close without a refund</summary><ReviewActions scenario={scenario} onDecide={onReview} onPayment={onPayment} busy={decisionBusy} /></details>}</>;
  else if (type === 'review' && runtime) content = <><div className="review-notice"><CircleAlert size={30} /><h3>{isReserved(scenario) ? reservationLabels(capabilities).panelTitle : scenario.status === 'closed' ? 'Closed without refund' : scenario.review?.state === 'awaiting-evidence' ? 'Waiting for supporting evidence' : 'Investigation stopped for review'}</h3><p>{scenario.summary}</p>{scenario.checks.filter(item => item.status === 'hold' || item.status === 'blocked').map(item => <p key={item.id}><strong>Reason:</strong> {item.detail}</p>)}</div>
    {isReserved(scenario) ? <button className="export-button" onClick={onPayment}><ReceiptText size={17} />View saved reservation</button>
      : scenario.operationId || scenario.receipt ? <p className="runtime-role-note">A saved historical remedy already covers this case. No new refund can be approved.</p>
      : permissions.review ? scenario.review?.state === 'awaiting-evidence' ? <RuntimeRecovery scenario={scenario} busy={decisionBusy} reviewReopen onResume={input => onReview({ ...input, action: 'reopen' })} /> : <ReviewActions scenario={scenario} onDecide={onReview} onPayment={onPayment} busy={decisionBusy} />
      : scenario.review?.state === 'awaiting-evidence' || scenario.status === 'closed' ? <p className="runtime-role-note">A reviewer must reopen these records before an investigator can resume. No new evidence has been received.</p>
      : scenario.intakeRequestId && ['review', 'error', 'paused'].includes(scenario.status) ? <RuntimeRecovery scenario={scenario} onResume={onResume} busy={decisionBusy} /> : <p className="runtime-role-note">The investigator checks requests in the background. Human decisions remain with the reviewer.</p>}</>;
  else if (type === 'review') content = <><div className={'review-notice ' + (scenario.status === 'closed' ? 'review-closed' : '')}><CircleAlert size={30} /><h3>{scenario.status === 'closed' ? 'Closed without refund' : scenario.review?.state === 'awaiting-evidence' && scenario.status === 'review' ? 'Waiting for supporting evidence' : scenario.status === 'review' ? 'Action stopped for review' : 'No review decision for this case'}</h3><p>{['review', 'closed'].includes(scenario.status) ? scenario.summary : 'Unresolved evidence, unsupported requests and actions outside the mandate stop here.'}</p>{scenario.checks.filter(c => c.status === 'hold' || c.status === 'blocked').map((check, i) => <p key={check.id || i}><strong>Reason for review:</strong> {check.detail}</p>)}</div><ReviewActions scenario={scenario} onDecide={onReview} onPayment={onPayment} busy={decisionBusy} /></>;
  else content = <>
    <div className="customer-message"><span className="eyebrow">Submitted request · {scenario.orderId}</span><p>“{scenario.complaint}”</p></div>
    {scenario.proposal && <div className="proposal-summary"><span className="eyebrow">{scenario.proposal.source === 'openai' ? 'OpenAI proposal' : scenario.proposal.source === 'anthropic' ? 'Anthropic proposal' : 'Local analyser proposal'}</span><h3>{money(scenario.proposal.amountMinor)} proposed</h3><p>{scenario.proposal.reason}</p><p className="source-refs">Evidence: {scenario.proposal.evidenceIds?.join(', ') || 'No supporting source identified'}</p></div>}
    <div className="record-list">{scenario.evidence.map(item => <article key={item.id}><div className="record-icon"><FileText size={21} /></div><div><h3>{item.title}</h3><span className="record-source">{item.id} · {item.source}</span><p>{item.displayBody || item.body}</p></div></article>)}</div>
    {!scenario.evidence.length && <p className="small-disclosure">Evidence has not been retrieved yet. Run the investigation to check this order.</p>}
    {order && <div className="order-snapshot"><span className="eyebrow">Supplied synthetic order · {order.id}</span>{order.lines.map(line => <div key={line.id}><span>{line.name}</span><span>{line.ordered} ordered · {line.packed} packed · {money(line.unitAmountMinor)} each</span></div>)}</div>}
  </>;
  return <dialog className="inspector" ref={dialogRef} onCancel={close} onClick={e => { if (e.target === dialogRef.current) close(); }} aria-labelledby="inspector-title"><div className="inspector-inner"><header className="inspector-header"><div className="inspector-heading"><Icon size={26} /><div><h2 id="inspector-title">{title}</h2><p>{scenario.caseId} · {scenario.title}</p></div></div><button onClick={close} className="close-button" aria-label="Close panel"><X size={23} /></button></header><div className="inspector-body">{!panel.replayReadOnly && pendingDecision && <section className="runtime-reservation-note" aria-label="Saved decision awaiting confirmation"><h3>A decision is awaiting confirmation</h3><p>The exact request is saved in this tab. Retry its original reference to check the result; a second decision will not be created.</p><p><strong>Saved action:</strong> {pendingDecision.action === 'approve' ? 'Approve ' + money(pendingDecision.payload.expectedAmountMinor) + ' reservation' : pendingDecision.payload.action || 'Resume investigation'}</p><p>{pendingDecision.payload.note}</p><button className="export-button" disabled={busy} onClick={async () => { setRetryError(''); try { await onRetryDecision(); } catch (failure) { setRetryError(failure.message); } }}><RefreshCw size={16} />{busy ? 'Checking original decision…' : 'Retry saved decision'}</button>{retryError && <p role="alert">{retryError}</p>}</section>}{content}{!panel.replayReadOnly && needsApproval(scenario) && ['evidence', 'policy'].includes(type) && <button className="export-button approval-return" onClick={() => onInspect('review')}><ShieldCheck size={17} />{runtime && !permissions.review ? 'Return to recommendation' : 'Return to approval'}</button>}</div><footer className="inspector-footer"><span><span className="demo-dot" />Synthetic orders · No real money</span><button onClick={close}>Back to office <ArrowRight size={16} /></button></footer></div></dialog>;
}
function Receipt({ receipt }) {
  return <div className="receipt"><ReceiptText size={24} /><div><span className="eyebrow">{receipt.provider === 'stripe-sandbox' ? 'Stripe sandbox receipt' : 'Local simulation receipt'}</span><strong>{receipt.id}</strong><p>{money(receipt.amountMinor)} · {receipt.status} · {localTime(receipt.createdAt)}</p><p>No real money moved</p></div></div>;
}

