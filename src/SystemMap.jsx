import { useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import './system-map.css';

// The prepared viewer is intentionally isolated from office records, storage
// and actions. Its runtime supports ?theme=dark, but no parent motion channel.
export function SystemMap({ open, motionEnabled, onClose }) {
  const dialog = useRef(null), current = useRef(''), timer = useRef(null);
  const lifecycle = useRef({ open: false, generation: 0 });
  const [attempt, setAttempt] = useState(0), [load, setLoad] = useState({ identity: '', status: 'loading' });
  if (open && !lifecycle.current.open) lifecycle.current.generation++;
  lifecycle.current.open = open;
  const identity = `${lifecycle.current.generation}:${attempt}`;
  current.current = open ? identity : '';
  const status = load.identity === identity ? load.status : 'loading';

  useEffect(() => {
    if (!open) return;
    const element = dialog.current, opener = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (opener?.isConnected) opener.focus?.();
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    timer.current = setTimeout(() => {
      if (current.current === identity) setLoad({ identity, status: 'slow' });
    }, 12000);
    return () => { clearTimeout(timer.current); timer.current = null; };
  }, [open, identity]);
  useEffect(() => {
    current.current = open ? identity : '';
    return () => { current.current = ''; };
  }, [open, identity]);

  function close() { if (current.current !== identity) return; current.current = ''; onClose(); }
  function finish(next) {
    if (current.current !== identity) return;
    clearTimeout(timer.current); timer.current = null;
    setLoad({ identity, status: next });
  }
  function retry() { if (current.current === identity) setAttempt(value => value + 1); }

  if (!open) return <dialog ref={dialog} />;
  return <dialog ref={dialog} className="system-map" aria-labelledby="system-map-title" aria-describedby="system-map-description"
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <header className="system-map-header"><div><span className="system-map-kicker">Refund Office architecture</span><h2 id="system-map-title">System map</h2><p id="system-map-description">Illustrated architecture, not live traffic</p></div><button type="button" onClick={close} aria-label="Close System map" autoFocus><X size={21} /></button></header>
    <div className="system-map-context">
      <p>Explore the workflow and prepared provider paths. The animation does not establish a request, approval or payment.</p>
      <p>The map starts Still. Choose Live, then Play story for a guided tour; choose Still to pause. The viewer respects reduced-motion preferences.</p>
      <p className="system-map-motion">Office motion is {motionEnabled ? 'on' : 'off'}. Map playback uses its own controls.</p>
    </div>
    <div className="system-map-viewer" aria-busy={status === 'loading'}>
      {status === 'loading' && <p className="system-map-status" role="status">Loading the prepared system map…</p>}
      {status === 'slow' && <p className="system-map-status" role="status">The system map is taking longer to open. You can reload it or return to the office.</p>}
      {status === 'failed' ? <div className="system-map-unavailable" role="alert"><h3>System map unavailable</h3><p>The prepared map could not be opened. Reload it to try again.</p><button type="button" onClick={retry}><RefreshCw size={15} />Reload map</button></div>
        : <iframe key={identity} src="/system-map.html?theme=dark" title="Refund Office illustrated architecture map" sandbox="allow-scripts" referrerPolicy="no-referrer" onLoad={() => finish('loaded')} onError={() => finish('failed')} />}
    </div>
    <footer className="system-map-footer"><span>If the frame is blank, reload the map.</span><div><button type="button" onClick={retry}><RefreshCw size={15} />Reload map</button><button type="button" onClick={close}>Back to office</button></div></footer>
  </dialog>;
}
