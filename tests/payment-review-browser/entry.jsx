import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PaymentAuthorisation } from '../../src/PaymentAuthorisation.jsx';
import { authorisationProps } from '../payment-review/fixtures.mjs';
import './style.css';

function Rehearsal() {
  const [mode, setMode] = useState('ready'), [generation, setGeneration] = useState(0), [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; fetch('/api/fixture').then(response => response.json()).then(value => { if (active) setMode(value.mode); }); return () => { active = false; }; }, []);
  async function change(next) {
    setBusy(true);
    try {
      const result = await fetch('/api/fixture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: next }) });
      if (!result.ok) throw Error('Fixture reset failed');
      // This origin is dedicated to disposable browser fixtures only.
      sessionStorage.clear(); setMode(next); setGeneration(value => value + 1);
    } finally { setBusy(false); }
  }
  return <main className="fixture-shell"><header><p className="fixture-eyebrow">Refund Office · Interface rehearsal</p><h1>Review a test payment</h1><div className="fixture-warning"><strong>Offline interface rehearsal</strong><p>Fictional fixture responses. No case database or provider connection. Decisions here affect this temporary example only.</p></div></header>
    <section className="fixture-controls" aria-label="Fictional example controls"><label>Example state<select value={mode} disabled={busy} onChange={event => change(event.target.value)}><option value="ready">Ready for authorisation</option><option value="lost-response">Lost authorisation response</option><option value="authorised">Authorised, not submitted</option><option value="uncertain">Payment outcome unknown</option><option value="pending">Refund pending</option><option value="failed">Refund failed</option><option value="succeeded">Refund succeeded</option></select></label><button disabled={busy} onClick={() => change(mode)}>Reset fictional example</button></section>
    <PaymentAuthorisation key={generation} {...authorisationProps()}/>
    <footer>This page exercises the production component using local canned responses. It does not establish Stripe or Supabase account behaviour.</footer>
  </main>;
}
createRoot(document.getElementById('root')).render(<Rehearsal/>);
