import { useEffect, useRef, useState } from 'react';
import { Copy, Download, FileQuestion, RefreshCw } from 'lucide-react';
import { canInspectCustomerDraft, customerDraftFile, sameCustomerDraft, verifyCustomerDraft } from './customer-draft-state.js';
import './customer-draft.css';

export function CustomerDraft({ scenario, capabilities, apiClient, principalKey }) {
  const enabled = canInspectCustomerDraft(scenario, capabilities);
  const scope = [principalKey, scenario.id, scenario.revision, enabled].join('|');
  const currentScope = useRef(scope); currentScope.current = scope;
  const generation = useRef(0), controller = useRef(null);
  const [state, setState] = useState(null);
  const visible = state?.scope === scope ? state : null;
  useEffect(() => {
    generation.current++; controller.current?.abort(); setState(null);
    return () => { generation.current++; controller.current?.abort(); };
  }, [scope]);
  const current = number => currentScope.current === scope && generation.current === number;
  async function read(signal) {
    const value = await apiClient('/cases/' + encodeURIComponent(scenario.id) + '/customer-draft', { signal });
    return verifyCustomerDraft(value, scenario);
  }
  async function prepare() {
    if (!enabled || currentScope.current !== scope || visible?.busy) return;
    controller.current?.abort(); const request = ++generation.current;
    controller.current = new AbortController();
    setState({ scope, busy: 'prepare' });
    try { const draft = await read(controller.current.signal); if (current(request)) setState({ scope, draft }); }
    catch (error) { if (current(request)) setState({ scope, error: error.message }); }
  }
  async function useDraft(action) {
    const saved = visible?.draft;
    if (!enabled || !saved?.eligible || visible.busy || currentScope.current !== scope) return;
    const request = ++generation.current; controller.current?.abort(); controller.current = new AbortController();
    setState({ scope, draft: saved, busy: action });
    let verified;
    try {
      const checked = await read(controller.current.signal);
      if (!current(request)) return;
      if (!sameCustomerDraft(saved, checked)) throw new Error('The saved question has changed. Prepare the latest draft before using it.');
      verified = checked;
      if (action === 'copy') {
        if (!navigator.clipboard?.writeText) throw new Error('Copy is unavailable in this browser. Select the draft text or download it.');
        await navigator.clipboard.writeText(checked.draftText);
      } else {
        const file = customerDraftFile(checked), url = URL.createObjectURL(new Blob([file.text], { type: 'text/plain;charset=utf-8' }));
        try { const link = document.createElement('a'); link.href = url; link.download = file.filename; link.click(); }
        finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
      }
      if (current(request)) setState({ scope, draft: checked, notice: action === 'copy' ? 'Draft copied. This application has not sent it.' : 'Unsent draft downloaded. This application has not sent it.' });
    } catch (error) { if (current(request)) setState({ scope, draft: verified, error: error.message }); }
  }
  if (!enabled) return null;
  return <section className="customer-draft" aria-label="Customer clarification draft">
    <div className="customer-draft-heading"><FileQuestion size={21} aria-hidden="true" /><div><h3>Prepare a customer question</h3><p>Use the saved evidence to clarify this hold. Review the wording before using it.</p></div></div>
    <p className="customer-draft-boundary">Unsent draft only. A received answer is recorded separately; every refund still needs approval.</p>
    <button type="button" className="customer-draft-prepare" onClick={prepare} disabled={Boolean(visible?.busy)}><RefreshCw size={16} />{visible?.busy === 'prepare' ? 'Preparing saved question…' : visible?.draft ? 'Refresh saved question' : 'Prepare question'}</button>
    {visible?.error && <p role="alert" className="customer-draft-error">{visible.error}</p>}
    {visible?.draft && (visible.draft.eligible ? <div className="customer-draft-result">
      <div className="customer-draft-version"><strong>Unsent customer draft</strong><span>{visible.draft.caseId} · Saved revision {visible.draft.revision}</span></div>
      <p className="customer-draft-text">{visible.draft.draftText}</p>
      <p className="customer-draft-reason">{visible.draft.reason}</p>
      <details><summary>Saved sources used</summary><ul>{visible.draft.evidenceRefs.map(id => <li key={id}>{id}</li>)}</ul><p>These are saved record references. No source link was opened to prepare this question.</p></details>
      <div className="customer-draft-actions"><button type="button" onClick={() => useDraft('copy')} disabled={Boolean(visible.busy)}><Copy size={16} />{visible.busy === 'copy' ? 'Checking saved question…' : 'Copy question'}</button><button type="button" onClick={() => useDraft('download')} disabled={Boolean(visible.busy)}><Download size={16} />{visible.busy === 'download' ? 'Checking saved question…' : 'Download unsent draft'}</button></div>
      {visible.notice && <p role="status">{visible.notice}</p>}
    </div> : <p className="customer-draft-unavailable">{visible.draft.reason}</p>)}
  </section>;
}
