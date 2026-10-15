import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createStore } from './store.mjs';
import { createEngine, ApiError } from './engine.mjs';
import { createProviders } from './providers.mjs';
import { createIntake } from './intake.mjs';
import { getIntegrationStatus, buildBriefing, buildMiroExport, buildDecisionReport } from './integration-prep.mjs';

const ALLOWED_HOSTS = new Set(['127.0.0.1:4173', 'localhost:4173', '127.0.0.1:4174', 'localhost:4174']);
const ALLOWED_ORIGINS = new Set(['http://127.0.0.1:4173', 'http://localhost:4173', 'http://127.0.0.1:4174', 'http://localhost:4174']);
const MAX_BODY = 16 * 1024;

async function readBody(request) {
  const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new ApiError(415, 'json_required', 'Send mutations as application/json.');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ApiError(413, 'body_too_large', 'The request body is too large.');
    chunks.push(chunk);
  }
  try {
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Not an object');
    return body;
  } catch { throw new ApiError(400, 'invalid_json', 'Provide a JSON object.'); }
}

export function createApiServer({ engine, intake, allowedHosts = ALLOWED_HOSTS, allowedOrigins = ALLOWED_ORIGINS } = {}) {
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    const send = (status, body) => { response.writeHead(status); response.end(body === null ? '' : JSON.stringify(body)); };
    try {
      if (!allowedHosts.has(request.headers.host)) throw new ApiError(403, 'host_not_allowed', 'Only the local demo host is allowed.');
      const origin = request.headers.origin;
      if (origin && !allowedOrigins.has(origin)) throw new ApiError(403, 'origin_not_allowed', 'This origin cannot access the local demo API.');
      if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return send(204, null);
      }
      const url = new URL(request.url, 'http://127.0.0.1:4174');
      const path = url.pathname;
      const method = request.method;
      let result;
      let status = 200;
      if (path === '/api/bootstrap' && method === 'GET') result = engine.bootstrap();
      else if (path === '/api/integrations' && method === 'GET') result = getIntegrationStatus({ capabilities: engine.bootstrap().capabilities });
      else if (path === '/api/intake' && ['GET', 'POST'].includes(method)) {
        if (!intake) throw new ApiError(503, 'intake_unavailable', 'The local intake worker is unavailable.');
        if (method === 'GET') result = intake.list();
        else { result = intake.submit(await readBody(request)); status = result.replayed ? 200 : 201; }
      }
      else if (/^\/api\/intake\/[^/]+\/resume$/.test(path) && method === 'POST') {
        if (!intake) throw new ApiError(503, 'intake_unavailable', 'The local intake worker is unavailable.');
        await readBody(request);
        let id;
        try { id = decodeURIComponent(path.split('/')[3]); } catch { throw new ApiError(400, 'invalid_intake_id', 'The intake identifier is invalid.'); }
        result = await intake.resume(id);
      }
      else if (path === '/api/policy' && method === 'PATCH') result = engine.updatePolicy(await readBody(request));
      else if (path === '/api/cases' && method === 'POST') { result = engine.createCase(await readBody(request)); status = 201; }
      else {
        const match = /^\/api\/cases\/([^/]+)(?:\/(run|advance|pause|resume|reconcile|review|approve|export|briefing|board-export|report))?$/.exec(path);
        if (!match) throw new ApiError(404, 'route_not_found', 'That API route does not exist.');
        let id;
        try { id = decodeURIComponent(match[1]); } catch { throw new ApiError(400, 'invalid_case_id', 'The case identifier is invalid.'); }
        const action = match[2];
        if (!action && method === 'GET') result = engine.getCase(id);
        else if (['briefing', 'board-export', 'report'].includes(action) && method === 'GET') {
          const packet = engine.exportCase(id);
          if (action === 'briefing') result = buildBriefing(packet);
          else if (action === 'board-export') {
            result = buildMiroExport(packet);
            response.setHeader('Content-Disposition', `attachment; filename="${packet.case.caseId}-case-board.json"`);
          } else {
            response.setHeader('Content-Type', 'text/markdown; charset=utf-8');
            response.setHeader('Content-Disposition', `attachment; filename="${packet.case.caseId}-decision-report.md"`);
            response.writeHead(200); response.end(buildDecisionReport(packet)); return;
          }
        }
        else if (action === 'export' && method === 'GET') {
          result = engine.exportCase(id);
          response.setHeader('Content-Disposition', `attachment; filename="${result.case.caseId}-decision-packet.json"`);
        } else if (['run', 'advance', 'pause', 'resume', 'reconcile', 'review', 'approve'].includes(action) && method === 'POST') {
          const input = await readBody(request);
          const current = engine.getCase(id);
          if (action === 'resume' && intake && current.intakeManaged && current.stage !== 'payments') result = (await intake.resume(current.intakeRequestId)).case;
          else result = await engine[action](id, input);
          intake?.notifyCaseChanged(id, { restart: action === 'run' });
        } else throw new ApiError(405, 'method_not_allowed', 'That request method is not supported.');
      }
      send(status, result);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      send(status, { error: { code: error instanceof ApiError ? error.code : 'internal_error', message: error instanceof ApiError ? error.message : 'The local service could not complete that operation. Saved operations are preserved.' } });
    }
  });
}

export function startServer({ port = Number(process.env.API_PORT || 4174), dbPath, provider = createProviders(), expectedDatasetId = process.env.REFUND_OFFICE_DEMO_PACK, expectedDatasetDigest = process.env.REFUND_OFFICE_DEMO_DIGEST } = {}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('API_PORT must be a valid port.');
  const store = createStore({ dbPath, expectedDatasetId, expectedDatasetDigest });
  const engine = createEngine({ store, provider });
  const intake = createIntake({ store, engine });
  const server = createApiServer({ engine, intake });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.listen(port, '127.0.0.1', () => { intake.start(); console.log(`Refund Office API listening on http://127.0.0.1:${port}`); });
  server.on('close', () => { void intake.close(); });
  return { server, store, engine, intake };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, store, intake } = startServer();
  const close = () => server.close(async () => { await intake.close(); store.close(); process.exit(0); });
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
