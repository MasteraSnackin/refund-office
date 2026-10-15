import { useEffect, useRef, useState } from 'react';
import { readRunDownload } from './api.js';

export function CaseDownload({ href, runId, className, children }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const current = useRef(''), request = useRef(null);
  const stamp = `${runId || 'original'}:${href}`; current.current = stamp;
  useEffect(() => {
    current.current = stamp; setBusy(false); setError('');
    return () => { current.current = ''; request.current?.abort(); request.current = null; };
  }, [stamp]);
  async function download() {
    if (current.current !== stamp || request.current) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setError('');
    try {
      const result = await readRunDownload(href, runId, { signal: controller.signal });
      if (controller.signal.aborted || current.current !== stamp) return;
      const url = URL.createObjectURL(result.blob), link = document.createElement('a');
      link.href = url; link.download = result.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { if (!controller.signal.aborted && current.current === stamp) setError(failure.message); }
    finally { if (request.current === controller) { request.current = null; if (current.current === stamp) setBusy(false); } }
  }
  if (!runId) return <a className={className} href={href} download>{children}</a>;
  return <><button type="button" className={className} onClick={download} disabled={busy} aria-busy={busy}>{busy ? 'Preparing file…' : children}</button>{error && <span role="alert" className="operations-error">{error}</span>}</>;
}
