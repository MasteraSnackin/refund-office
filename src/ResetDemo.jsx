import { useEffect, useRef, useState } from 'react';
import { Archive, CircleAlert, RefreshCw } from 'lucide-react';
import { api } from './api.js';
import { OperationsDialog } from './OperationsControls.jsx';
import { canResetDemo, readResetCommand, prepareResetCommand, verifyResetReceipt, rememberResetTarget, completeResetCommand } from './reset-demo-state.js';
import './reset-demo.css';

export function ResetDemo({ access, open, onClose, onBlockingChange, onReady }) {
  const [initial] = useState(() => { try { return { command: readResetCommand(sessionStorage), error: '' }; } catch (failure) { return { command: null, error: failure.message }; } });
  const [pending, setPending] = useState(initial.command), [corrupt] = useState(Boolean(initial.error));
  const [error, setError] = useState(initial.error), [receipt, setReceipt] = useState(null), [busy, setBusy] = useState(''), [confirmed, setConfirmed] = useState(false);
  const lock = useRef(false), alive = useRef(true), completed = useRef(null), observed = useRef(''), startedForStamp = useRef(null);
  const stamp = [access?.demoRun?.id, access?.workspace?.id, access?.session?.userId, access?.session?.role, access?.authenticated].join(':');
  observed.current = stamp;
  const supported = canResetDemo(access), blocked = Boolean(pending || corrupt);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { onBlockingChange?.(blocked); }, [blocked]);
  useEffect(() => { setConfirmed(false); }, [stamp, open]);

  async function accept(value, command) {
    const result = verifyResetReceipt(value, command);
    if (!alive.current) return;
    const saved = rememberResetTarget(sessionStorage, command, result); setPending(saved); setReceipt(result);
    if (result.status === 'ready' && completed.current !== command.commandId) {
      completeResetCommand(sessionStorage, saved); completed.current = command.commandId;
      setPending(null); setConfirmed(false); onBlockingChange?.(false); onClose?.();
      await onReady?.(result);
    }
  }

  async function check(command = pending) {
    if (!command || lock.current || !alive.current) return;
    lock.current = true; setBusy('status'); setError('');
    try { const result = await api(`/demo/reset/${encodeURIComponent(command.commandId)}`); if (alive.current) await accept(result, command); }
    catch (failure) { if (alive.current) setError(failure.status === 404 ? 'The service has not confirmed this reset. The original request is retained; retry only that same request.' : failure.message); }
    finally { if (alive.current) { lock.current = false; setBusy(''); } }
  }
  useEffect(() => { if (pending) check(pending); }, [pending?.commandId]);
  useEffect(() => {
    if (!pending || receipt?.status !== 'switching' || busy) return;
    const timer = setTimeout(() => check(pending), 1500); return () => clearTimeout(timer);
  }, [pending?.commandId, receipt?.status, busy]);

  async function submit(event) {
    event?.preventDefault();
    if (lock.current || corrupt || !alive.current || !pending && (!supported || !confirmed || observed.current !== stamp || startedForStamp.current === stamp)) return;
    lock.current = true; setBusy('reset'); setError('');
    try {
      const command = pending || prepareResetCommand(sessionStorage, access, () => crypto.randomUUID());
      startedForStamp.current = stamp;
      setPending(command); onBlockingChange?.(true);
      const result = await api('/demo/reset', { method: 'POST', runId: command.sourceRunId, acceptRunChange: true, body: { commandId: command.commandId, expectedRunId: command.sourceRunId } });
      if (alive.current) await accept(result, command);
    } catch (failure) { if (alive.current) setError(failure.message || 'The reset outcome is not confirmed. Check the saved status before continuing.'); }
    finally { if (alive.current) { lock.current = false; setBusy(''); } }
  }

  if (!supported && !blocked) return null;
  return <OperationsDialog open={open || blocked} onClose={() => { if (!blocked && !busy) onClose?.(); }} title={blocked ? 'Reset recovery' : 'Reset this demo'} subtitle="Keep this run and start a fresh copy of the same synthetic pack." icon={Archive} className="reset-demo-dialog" footer={!blocked && <button type="button" className="operations-secondary" disabled={Boolean(busy)} onClick={onClose}>Keep current run</button>}>
    {blocked ? <div className="reset-demo-recovery"><h3>{receipt?.status === 'switching' ? 'Saving this run and preparing its replacement' : receipt?.status === 'failed' ? 'The reset needs attention' : receipt?.status === 'unresolved' ? 'The reset outcome is unresolved' : 'Checking the original reset'}</h3>
      <p>The office stays closed while this reset is unresolved. The original command is retained; another reset cannot be started.</p>
      {receipt && <><p>{receipt.message}</p><p>{receipt.checkpointConfirmed ? 'The previous run checkpoint is confirmed.' : 'The previous run checkpoint has not yet been confirmed.'}</p></>}
      <div className="reset-demo-actions"><button type="button" className="operations-secondary" onClick={() => check()} disabled={Boolean(busy) || !pending}><RefreshCw size={15} />{busy === 'status' ? 'Checking saved reset…' : 'Check saved reset'}</button>{pending && <button type="button" className="operations-secondary" onClick={submit} disabled={Boolean(busy)}>{busy === 'reset' ? 'Checking original request…' : 'Retry same reset request'}</button>}</div>
    </div> : <form onSubmit={submit} className="reset-demo-form"><h3>A clean copy of the current pack</h3><p>The current run will be saved with its cases, evidence, decisions and history. A fresh copy of <strong>{access?.workspace?.title || access?.demoRun?.packId}</strong> will then start with a new workspace identity.</p><p>Earlier runs and the original demonstrations remain available on disk. This resets only the current rehearsal pack. It does not connect a sponsor service or approve any refund.</p><label className="reset-demo-confirm"><input type="checkbox" name="confirmReset" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} required disabled={Boolean(busy)} /><span>Save this run and start a fresh copy of the same pack. End the current profiles and return me to the profile chooser.</span></label><button type="submit" className="operations-primary" disabled={!confirmed || Boolean(busy)}>{busy === 'reset' ? 'Saving reset request…' : 'Save run and reset demo'}</button></form>}
    {error && <div className="reset-demo-error" role="alert"><CircleAlert size={18} /><p>{error}</p></div>}
  </OperationsDialog>;
}
