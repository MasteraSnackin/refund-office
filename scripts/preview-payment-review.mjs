import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { contextFixture } from '../tests/payment-review/fixtures.mjs';
import { executionFixture } from '../tests/runtime-payments/fixtures.mjs';

// Explicitly separate from both office servers. This fixture has no repository,
// authentication adapter, provider client, credentials or persistent case store.
const root = fileURLToPath(new URL('../', import.meta.url));
const port = 4373, origin = `http://127.0.0.1:${port}`;
const modes = new Set(['ready', 'lost-response', 'authorised', 'uncertain', 'pending', 'failed', 'succeeded']);
let mode = 'ready', saved = null, originalBody = null, lostOnce = false;
function reset(next) {
  mode = next; originalBody = null; lostOnce = false; saved = null;
  if (!['ready', 'lost-response'].includes(mode)) {
    saved = executionFixture(); saved.status = mode;
    if (mode !== 'authorised') saved.submittedAt = '2026-10-14T12:00:00Z';
    if (['pending', 'failed', 'succeeded'].includes(mode)) {
      saved.refundId = 're_Synthetic1';
      saved.receipt = { id: saved.refundId, amount: saved.payload.amountMinor, currency: 'gbp', payment_intent: saved.mapping.paymentIntentId, metadata: saved.payload.metadata, status: mode };
    }
  }
}
const vite = await createViteServer({ configFile: false, envFile: false, envDir: false, root,
  plugins: [react()], appType: 'custom', server: { middlewareMode: true, hmr: false },
});
async function body(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > 16384) throw Error('Fixture input too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  try {
    if (request.headers.host !== `127.0.0.1:${port}` || request.headers.origin && request.headers.origin !== origin || request.method === 'POST' && request.headers.origin !== origin) return json(403, { error: { message: 'Use the local fictional rehearsal.' } });
    const path = new URL(request.url, origin).pathname;
    if (path.startsWith('/api/')) {
      if (path === '/api/fixture' && request.method === 'POST') { const value = await body(request); if (!modes.has(value.mode)) return json(400, { error: { message: 'Unknown fixture state.' } }); reset(value.mode); return json(200, { mode }); }
      if (path === '/api/fixture' && request.method === 'GET') return json(200, { mode });
      if (path === '/api/cases/runtime-case-1/payment-authorisation' && request.method === 'GET') return json(200, { ...contextFixture(), eligible: !saved, blockedReason: saved ? 'An execution authorisation is already recorded.' : null, execution: saved });
      if (path === '/api/payment-executions' && request.method === 'POST') {
        const value = await body(request);
        if (originalBody && JSON.stringify(originalBody) !== JSON.stringify(value)) return json(409, { error: { message: 'The fictional retry must keep the original payload.' } });
        originalBody = structuredClone(value);
        saved ||= executionFixture();
        saved.mapping = structuredClone(value.mapping);
        saved.authorisation = { ...saved.authorisation, note: value.note, commandId: value.commandId };
        saved.payload = { ...saved.payload, accountId: value.mapping.accountId, paymentIntentId: value.mapping.paymentIntentId };
        if (mode === 'lost-response' && !lostOnce) { lostOnce = true; return json(503, { error: { code: 'execution_authorisation_unconfirmed', uncertain: true, message: 'Fictional lost response. The fixture retained this exact authorisation.' } }); }
        return json(200, { execution: saved, authorisationReadbackVerified: true, submitted: false });
      }
      if (path === `/api/payment-executions/${executionFixture().id}` && request.method === 'GET' && saved) return json(200, { execution: saved });
      return json(404, { error: { message: 'This interface fixture provides no other operation.' } });
    }
    if (path === '/' && request.method === 'GET') {
      const html = await vite.transformIndexHtml('/', await readFile(resolve(root, 'tests/payment-review-browser/index.html'), 'utf8'));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return;
    }
    vite.middlewares(request, response, () => { response.writeHead(404); response.end(); });
  } catch { json(400, { error: { message: 'The fictional fixture could not handle this input.' } }); }
});
server.listen(port, '127.0.0.1', () => console.log(`Offline fictional payment-screen rehearsal: ${origin}`));
const close = async () => { server.close(); await vite.close(); process.exit(0); };
process.once('SIGTERM', close); process.once('SIGINT', close);
