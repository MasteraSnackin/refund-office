import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowRight, CircleAlert, Database, FileText, Inbox, LogOut, RefreshCw, ShieldCheck, UserRound } from 'lucide-react';
import { api, bindRunApi } from './api.js';
import { OperationsDialog } from './OperationsControls.jsx';
import { ResetDemo } from './ResetDemo.jsx';
import { canResetDemo, readResetCommand, validDemoRun } from './reset-demo-state.js';
import { runtimePermissions } from './runtime-access.js';
import './runtime-access.css';

const money = minor => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100);
const clock = value => new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const logoutIntentKey = 'refund-office:logout-pending';
const pendingLogoutMessage = 'The office view is closed, but the service has not confirmed that the session has ended. Retry End session before continuing.';
function hasLogoutIntent() {
  try { return sessionStorage.getItem(logoutIntentKey) === 'true'; } catch { return false; }
}
function hasResetIntent() { try { return Boolean(readResetCommand(sessionStorage)); } catch { return true; } }

export function RuntimeSessionBoundary({ children }) {
  const [access, setAccess] = useState(undefined);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [generation, setGeneration] = useState(0);
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [resetOpen, setResetOpen] = useState(false), [resetBlocked, setResetBlocked] = useState(hasResetIntent);
  const resetGuard = useRef(resetBlocked); resetGuard.current = resetBlocked;
  const runtimeSeen = useRef(false);
  const inFlight = useRef(false);
  const requestGeneration = useRef(0);
  const sessionStamp = useRef(null);
  const logoutIntent = useRef(hasLogoutIntent());
  function rememberLogout(value) {
    logoutIntent.current = value;
    try { if (value) sessionStorage.setItem(logoutIntentKey, 'true'); else sessionStorage.removeItem(logoutIntentKey); } catch { /* The in-memory guard still closes this office view. */ }
  }
  function holdLogout() {
    rememberLogout(true);
    setAccess(current => ({ ...current, authenticated: false, session: null, logoutPending: true }));
  }
  function accept(result) {
    if (result.demoRun !== undefined && !validDemoRun(result.demoRun)) throw new Error('The local rehearsal identity could not be confirmed. Check access again.');
    if (result.logoutPending === true) rememberLogout(true);
    else if (result.authenticated === false) rememberLogout(false);
    if (logoutIntent.current) result = { ...result, authenticated: false, session: null, logoutPending: true };
    const stamp = result.authenticated ? [result.workspace.id, result.demoRun?.id || 'original', result.session.userId || result.session.profileId, result.session.role, result.session.expiresAt].join('|') : `signed-out:${result.demoRun?.id || 'original'}`;
    if (stamp !== sessionStamp.current) { sessionStamp.current = stamp; setGeneration(value => value + 1); }
    setAccess(result);
    return result.logoutPending === true;
  }
  async function load(signal) {
    const request = ++requestGeneration.current;
    try {
      const result = await api('/session', { signal });
      if (signal?.aborted || request !== requestGeneration.current) return;
      if (!['local-rehearsal','hosted-supabase'].includes(result.mode)) throw new Error('The session service returned an unknown access mode.');
      if (typeof result.authenticated !== 'boolean' || (result.authenticated ? !result.session || !result.workspace?.id : result.session !== null)) throw new Error('The session state could not be confirmed.');
      runtimeSeen.current = true; const pending = accept(result); setError(pending ? pendingLogoutMessage : '');
    } catch (failure) {
      if (signal?.aborted || request !== requestGeneration.current) return;
      if (failure.status === 404 && !runtimeSeen.current && !logoutIntent.current) { setAccess(null); setError(''); }
      else setError(failure.message);
    }
  }
  useEffect(() => { const controller = new AbortController(); load(controller.signal); return () => controller.abort(); }, []);
  useEffect(() => {
    if (access === null) return;
    const sync = () => { if (!document.hidden && !inFlight.current) load(); };
    window.addEventListener('focus', sync); window.addEventListener('pageshow', sync); document.addEventListener('visibilitychange', sync);
    const timer = access?.authenticated ? setInterval(sync, 20000) : null;
    return () => { window.removeEventListener('focus', sync); window.removeEventListener('pageshow', sync); document.removeEventListener('visibilitychange', sync); if (timer !== null) clearInterval(timer); };
  }, [access === null, Boolean(access?.authenticated)]);
  useEffect(() => {
    const expire = () => {
      requestGeneration.current++;
      sessionStamp.current = 'signed-out';
      setAccess(current => current ? { ...current, authenticated: false, session: null } : current);
      setGeneration(value => value + 1);
      setError(logoutIntent.current ? pendingLogoutMessage : access?.mode === 'hosted-supabase' ? 'Your session has ended. Sign in again to continue.' : 'Your local rehearsal session has ended. Choose a test profile to continue.');
    };
    window.addEventListener('refund-office:session-expired', expire);
    const expiry = Date.parse(access?.session?.expiresAt);
    const timer = access?.authenticated && Number.isFinite(expiry) ? setTimeout(expire, Math.max(0, expiry - Date.now())) : null;
    return () => { window.removeEventListener('refund-office:session-expired', expire); if (timer !== null) clearTimeout(timer); };
  }, [access?.authenticated, access?.session?.expiresAt, access?.mode]);
  async function choose(profileId) {
    if (inFlight.current || logoutIntent.current || resetGuard.current) return;
    inFlight.current = true; setBusy(profileId); setError(''); const request = ++requestGeneration.current;
    try {
      const result = await api('/session', { method: 'POST', body: { profileId }, runId: access?.demoRun?.id });
      if (request !== requestGeneration.current || resetGuard.current) return;
      if (!result.authenticated || result.mode !== 'local-rehearsal' || !result.session) throw new Error('The local test session could not be confirmed.');
      runtimeSeen.current = true; accept(result);
    } catch (failure) { if (request === requestGeneration.current && !resetGuard.current) setError(failure.message); }
    finally { inFlight.current = false; setBusy(''); }
  }
  async function signIn(event) {
    event.preventDefault(); if (inFlight.current || logoutIntent.current || resetGuard.current) return;
    inFlight.current = true; setBusy('signin'); setError(''); const request = ++requestGeneration.current;
    try {
      const result = await api('/session', { method: 'POST', body: { email: email.trim(), password } });
      if (request !== requestGeneration.current || resetGuard.current) return;
      if (!result.authenticated || result.mode !== 'hosted-supabase' || !result.session?.userId) throw new Error('Your workspace session could not be confirmed.');
      runtimeSeen.current = true; accept(result);
    } catch (failure) { if (request === requestGeneration.current && !resetGuard.current) { if (failure.code === 'hosted_logout_pending') holdLogout(); setError(failure.message); } }
    finally { setPassword(''); inFlight.current = false; setBusy(''); }
  }
  async function refreshSession() {
    if (inFlight.current || logoutIntent.current || resetGuard.current) return;
    inFlight.current = true; setBusy('refresh'); setError(''); const request = ++requestGeneration.current;
    try {
      const result = await api('/session/refresh', { method: 'POST', body: {} });
      if (request !== requestGeneration.current || resetGuard.current) return;
      if (!result.authenticated || result.mode !== 'hosted-supabase') throw new Error('The refreshed session could not be confirmed. Sign in again.');
      accept(result);
    } catch (failure) {
      if (request !== requestGeneration.current || resetGuard.current) return;
      if (failure.code === 'hosted_logout_pending') holdLogout();
      sessionStamp.current = 'signed-out'; setAccess(current => ({ ...current, authenticated: false, session: null })); setGeneration(value => value + 1); setError(failure.message);
    } finally { inFlight.current = false; setBusy(''); }
  }
  async function logout() {
    if (inFlight.current || resetGuard.current) return;
    inFlight.current = true; setBusy('logout'); const request = ++requestGeneration.current;
    sessionStamp.current = 'signed-out';
    // Clear visible cases immediately, including if the network disappears.
    holdLogout();
    setGeneration(value => value + 1); setPassword(''); setError('');
    try {
      const result = await api('/session', { method: 'DELETE', body: {}, runId: access?.demoRun?.id });
      if (request !== requestGeneration.current || resetGuard.current) return;
      if (!['local-rehearsal','hosted-supabase'].includes(result?.mode) || result.authenticated !== false || result.session !== null) throw new Error('The sign-out response could not be confirmed.');
      if (accept(result)) setError(pendingLogoutMessage);
      else if (result.mode === 'hosted-supabase' && (result.durableRevocationConfirmed === false || result.providerRevocationConfirmed === false)) setError('The office session has ended, but full account session revocation was not confirmed. Sign out of the account directly before using a shared device.');
    } catch { if (request === requestGeneration.current && !resetGuard.current) setError(pendingLogoutMessage); }
    finally { inFlight.current = false; setBusy(''); }
  }
  function resetBlocking(value) { resetGuard.current = value; setResetBlocked(value); if (value) { requestGeneration.current++; setGeneration(value => value + 1); } }
  async function resetReady() {
    requestGeneration.current++; sessionStamp.current = null; rememberLogout(false); setAccess(undefined); setGeneration(value => value + 1);
    resetGuard.current = false; setResetBlocked(false); setResetOpen(false); setError(''); await load();
  }
  const sessionRequest = useMemo(() => bindRunApi(access?.demoRun?.id), [
    generation, access?.workspace?.id, access?.demoRun?.id,
    access?.session?.userId, access?.session?.profileId, access?.session?.role,
  ]);
  const withReset = content => <>{content}<ResetDemo access={access} open={resetOpen} onClose={() => setResetOpen(false)} onBlockingChange={resetBlocking} onReady={resetReady} /></>;
  if (access === null && !resetBlocked) return children(null);
  if (access?.authenticated && access.session && !logoutIntent.current && !resetBlocked) return withReset(children({ ...access, logout, refreshSession, generation,
    request: sessionRequest, openReset: () => { if (canResetDemo(access) && !inFlight.current) setResetOpen(true); }, resetAvailable: canResetDemo(access) }));
  const hosted = access?.mode === 'hosted-supabase';
  const logoutPending = logoutIntent.current || access?.logoutPending === true;
  return withReset(<main className="runtime-access-screen"><section className="runtime-access-card" aria-labelledby="runtime-access-title">
    <div className="runtime-access-brand"><img src="/assets/case-folder.png" alt="" /><span>Refund Office</span></div>
    <span className="runtime-kicker">{hosted ? 'Hosted workspace' : 'Local PostgreSQL rehearsal'}</span><h1 id="runtime-access-title">{resetBlocked ? 'Rehearsal reset needs confirmation' : logoutPending ? 'Finish ending your session' : hosted ? 'Sign in to your workspace' : 'Choose your test profile'}</h1>
    <p>{logoutPending ? 'Sign-in and workspace access stay unavailable until the session service confirms that this session has ended.' : hosted ? 'Use your configured Supabase account. Your workspace membership determines investigation and review permissions.' : 'Explore the same office with separate investigation and review permissions. These are local test identities, not a Supabase sign-in.'}</p>
    {access?.workspace && <div className="runtime-workspace-preview"><Database size={19} /><div><strong>{access.workspace.title}</strong><span>{hosted ? 'Access limited to your workspace membership' : 'Separate synthetic workspace · No online services'}</span></div></div>}
    {resetBlocked && <div className="runtime-reset-wait"><strong>The office is closed for reset recovery.</strong><p>Check the saved reset in the dialog. The profile chooser returns when the fresh run is confirmed.</p></div>}
    {hosted && !logoutPending && !resetBlocked && (access.passwordSignIn ? <form className="runtime-signin" onSubmit={signIn}><label>Email<input type="email" autoComplete="username" required value={email} onChange={event=>setEmail(event.target.value)} disabled={Boolean(busy)}/></label><label>Password<input type="password" autoComplete="current-password" required value={password} onChange={event=>setPassword(event.target.value)} disabled={Boolean(busy)}/></label><button type="submit" disabled={Boolean(busy)}>{busy==='signin'?'Checking account…':'Sign in'}</button><p>Credentials are sent only to this application's configured sign-in service. No password is saved in browser storage.</p></form> : <p role="status">Hosted account access is disconnected. It requires explicit server configuration before sign-in is available.</p>)}
    {!hosted && !logoutPending && !resetBlocked && (access?.profiles?.length ? <div className="runtime-profile-list">{access.profiles.map(profile => <button key={profile.id} className="runtime-profile" onClick={() => choose(profile.id)} disabled={Boolean(busy)}>
      {profile.role === 'reviewer' ? <ShieldCheck size={25} /> : <FileText size={25} />}<span><strong>{profile.label}</strong><small>{profile.description || (profile.role === 'reviewer' ? 'Inspect evidence and record an explicit decision.' : 'Inspect investigations and recover stopped work. No approval permission.')}</small><b>{busy === profile.id ? 'Opening local session…' : `Enter as ${profile.role}`}</b></span><ArrowRight size={20} />
    </button>)}</div> : !error && <p role="status">Checking local access…</p>)}
    {error && <div className="runtime-access-error" role="alert"><CircleAlert size={18} /><p>{error}</p></div>}
    {logoutPending && <button className="runtime-text-button" disabled={Boolean(busy)} onClick={logout}><LogOut size={16} />{busy === 'logout' ? 'Ending session…' : 'Retry End session'}</button>}
    {(error || logoutPending) && <button className="runtime-text-button" disabled={Boolean(busy)} onClick={() => load()}><RefreshCw size={16} />{logoutPending ? 'Check session status' : 'Check access again'}</button>}
    <div className="runtime-access-boundary"><ShieldCheck size={17} /><p>Every refund requires a reviewer’s decision. This office saves a reservation only; payment submission is disabled.</p></div>
  </section></main>);
}

export function RuntimeSessionBar({ access }) {
  const hosted = access.mode === 'hosted-supabase';
  return <section className="runtime-session-bar" aria-label={hosted ? 'Active workspace and account session' : 'Active local workspace and test session'}>
    <div className="runtime-store"><Database size={17} /><span><strong>{hosted ? 'Supabase · hosted workspace' : 'PostgreSQL · local rehearsal'}</strong><small>{access.workspace.title}</small></span></div>
    <div className="runtime-session"><UserRound size={16} /><span>{hosted ? '' : 'Test '}{access.session.role}<small>Expires {clock(access.session.expiresAt)}</small></span>{hosted && <button onClick={access.refreshSession}><RefreshCw size={16}/>Refresh session</button>}<button onClick={access.logout}><LogOut size={16} />End session</button></div>
  </section>;
}

export function RuntimeControls({ access, policy, casesCount, onIntake, onCases, onPolicy, onInfo, onWorker, busy, workerActive }) {
  const permissions = runtimePermissions(access.session);
  return <section className="operations-bar runtime-operations" aria-label="Workspace controls"><div className="operations-actions">
    <button className="operations-new" onClick={onIntake}><Inbox size={17} />New request / queue</button>
    <button className="operations-policy" onClick={onPolicy}><ShieldCheck size={16} />Policy limit <strong>{money(policy.limitMinor)}</strong></button>
    <button className="operations-cases" onClick={onCases}><Inbox size={16} />All cases ({casesCount})</button>
    {permissions.investigate && <button className="operations-intake" onClick={onWorker} disabled={busy}><RefreshCw size={16} />{busy ? 'Checking queue…' : 'Process next request'}</button>}
    {access.resetAvailable && <button type="button" className="runtime-reset-button" onClick={access.openReset} disabled={busy}><RefreshCw size={16} />Reset demo</button>}
  </div><div className="operations-context"><button className="operations-connections" onClick={onInfo}><Database size={15} />Local rules · Payments disabled</button><span className="operations-saved">{workerActive ? 'Investigation queue active' : 'Human approval required'}</span></div></section>;
}

export function RuntimeInfoDialog({ open, onClose, access }) {
  if (access.mode === 'hosted-supabase') return <OperationsDialog open={open} onClose={onClose} title="Workspace access" subtitle="Supabase account and workspace membership" icon={Database} footer={<button className="operations-primary" onClick={onClose}>Back to office</button>}><div className="runtime-information"><h3>{access.workspace.title}</h3><p>This workspace uses authenticated Supabase access. Your assigned role controls investigation and review actions.</p><p>Approving an exact amount records a reservation only. Payment submission remains disabled. Sponsor configuration does not establish that any external action succeeded; inspect its saved result.</p></div></OperationsDialog>;
  return <OperationsDialog open={open} onClose={onClose} title="Local rehearsal" subtitle="A separate PostgreSQL workspace on this device." icon={Database} footer={<button className="operations-primary" onClick={onClose}>Back to office</button>}>
    <div className="runtime-information"><h3>{access.workspace.title}</h3><p>The office reads and writes its working cases in local PostgreSQL. The original SQLite demonstration remains separate.</p><p>The background investigator follows local rules and stops for review. The investigator profile can recover work but cannot approve. The reviewer profile records decisions but cannot claim investigation work.</p><p>Approval saves the exact amount, evidence, policy and reviewer identity with one reserved operation. <strong>Payment submission is disabled.</strong> A reservation is not a refund or a provider receipt.</p><p>Profiles and expiring sessions are for this local rehearsal. No Supabase login, external model, Stripe payment or other sponsor service is connected.</p></div>
  </OperationsDialog>;
}

export function RuntimeApproval({ scenario, order, draft, onDraftChange, onApprove, onEvidence, onPolicy, busy, canReview }) {
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const lock = useRef(false);
  const noteId = useId(), hintId = useId();
  const approval = scenario.approval;
  const item = order?.lines?.find(line => line.id === approval?.lineId);
  useEffect(() => setError(''), [scenario.id, scenario.revision]);
  async function submit(event) {
    event.preventDefault(); if (busy || lock.current || !canReview) return;
    if (draft.trim().length < 10) { setError('Explain this decision in at least 10 characters.'); return; }
    lock.current = true; setSubmitting(true); setError('');
    try { await onApprove({ expectedRevision: scenario.revision, expectedAmountMinor: approval.amountMinor, fingerprint: approval.fingerprint, note: draft.trim() }); }
    catch (failure) { setError(failure.message); }
    finally { lock.current = false; setSubmitting(false); }
  }
  return <section className="approval-actions runtime-approval"><div className="approval-summary"><div className="approval-summary-heading"><ShieldCheck size={22} /><div><span className="approval-mode">Reservation · Payment disabled</span><h3>{canReview ? 'Your decision is required' : 'Waiting for a reviewer'}</h3></div><strong className="approval-amount">{money(approval.amountMinor)}</strong></div>
    <dl className="approval-facts"><div><dt>Order</dt><dd>{scenario.orderId}</dd></div><div><dt>Item</dt><dd>{item?.name || approval.lineId}</dd></div><div><dt>Policy</dt><dd>Version {approval.policyVersion}</dd></div></dl><p className="approval-scope">The saved evidence supports this proposed amount. Approval records a reservation only. No payment is submitted.</p></div>
    <div className="runtime-review-links"><button onClick={onEvidence}><FileText size={16} />Inspect evidence</button><button onClick={onPolicy}><ShieldCheck size={16} />Inspect policy checks</button></div>
    {canReview ? <form className="approval-form" onSubmit={submit}><label htmlFor={noteId}>Reason for approval</label><textarea id={noteId} rows={3} minLength={10} maxLength={1000} required value={draft} onChange={event => onDraftChange(event.target.value)} disabled={busy || submitting} aria-describedby={hintId} placeholder="Explain why the evidence supports this exact amount." /><p id={hintId} className="approval-guidance">Saved with your reviewer identity and the current case facts. A changed amount or evidence requires another review.</p>{error && <p className="approval-error" role="alert">{error}</p>}<div className="approval-submit-bar"><button className="approval-submit" disabled={busy || submitting}><ShieldCheck size={17} />{busy || submitting ? 'Recording decision…' : `Approve ${money(approval.amountMinor)} reservation`}</button><span>No payment submitted</span></div></form>
      : <p className="runtime-role-note"><ShieldCheck size={18} />Your investigator role cannot approve. A reviewer in this workspace must record the human decision.</p>}
  </section>;
}

export function RuntimeRecovery({ scenario, onResume, busy, reviewReopen = false }) {
  const [note, setNote] = useState(''), [error, setError] = useState('');
  const id = useId();
  useEffect(() => { setNote(''); setError(''); }, [scenario.id]);
  async function submit(event) {
    event.preventDefault(); if (busy) return;
    try { setError(''); await onResume({ expectedRevision: scenario.revision, note: note.trim() }); setNote(''); }
    catch (failure) { setError(failure.message); }
  }
  return <form className="review-decision-form runtime-recovery" onSubmit={submit}><h3>{reviewReopen ? 'Reopen existing records' : 'Recover this investigation'}</h3><p>{reviewReopen ? 'Lift this evidence hold only if the existing records are ready for another investigation. No new evidence has been received. Your reason remains in the audit history.' : 'Recheck the saved records with the local investigator. Previous evidence and decisions remain in the audit history. This cannot approve or submit a refund.'}</p><label htmlFor={id}>{reviewReopen ? 'Reason for reopening the existing records' : 'Reason for rechecking'}</label><textarea id={id} rows={3} minLength={10} maxLength={1000} required value={note} onChange={event => setNote(event.target.value)} disabled={busy} />{error && <p role="alert" className="review-form-error">{error}</p>}<div className="review-submit-bar"><button className="review-save" disabled={busy}><RefreshCw size={16} />{busy ? 'Saving decision…' : reviewReopen ? 'Reopen existing records' : 'Resume investigation'}</button></div></form>;
}
