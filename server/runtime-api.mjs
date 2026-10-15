import { createServer } from 'node:http';
import { RuntimeServiceError } from './runtime-service.mjs';
import { RuntimeAuthError } from './runtime-auth.mjs';
import { SponsorActionError } from './sponsor-actions.mjs';
import { createElevenLabsTranscription } from './elevenlabs-transcription.mjs';
import { CanvasVoiceError, createCanvasVoice, runtimeJsonBodyLimit, voiceInputCaseId } from './canvas-voice.mjs';

const HOSTS = new Set(['127.0.0.1:4273', 'localhost:4273', '127.0.0.1:4274', 'localhost:4274']);
const ORIGINS = new Set([...HOSTS].map(host => `http://${host}`));
const MAX_BODY = 16 * 1024;
const mutation = method => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
const localAddress = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const error = (status, code, message) => { throw new RuntimeServiceError(status, code, message); };
async function readBody(request, limit = MAX_BODY) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') error(415, 'json_required', 'Send this action as JSON.');
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) error(413, 'body_too_large', 'The request is too large.');
  let bytes = 0; const chunks = [];
  for await (const chunk of request) { bytes += chunk.length; if (bytes > limit) error(413, 'body_too_large', 'The request is too large.'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { error(400, 'invalid_json', 'Send a JSON object.'); }
}
function failure(error) {
  if (error instanceof RuntimeAuthError || error instanceof RuntimeServiceError || error instanceof SponsorActionError || error instanceof CanvasVoiceError) return { status: error.status, code: error.code, message: error.message, uncertain: Boolean(error.uncertain) };
  const codes = {
    invalid_runtime_input: [400, 'The action is incomplete or invalid.'], runtime_access_denied: [403, 'This profile cannot perform that database action.'],
    runtime_conflict: [409, 'The saved facts or workflow changed. Refresh the case before deciding again.'],
    runtime_disconnected: [503, 'The working database is disconnected.'],
    analysis_access_denied: [403, 'This session cannot inspect that case.'],
    invalid_analysis_input: [400, 'Use only the exact saved case revision for this advisory action.'],
    analysis_stale_case: [409, 'The saved case or evidence changed. Refresh before requesting another opinion.'],
    analysis_evidence_required: [409, 'Investigate the case before requesting another opinion.'],
    analysis_input_too_large: [413, 'The saved evidence exceeds this action’s size limit.'],
  };
  const match = codes[error?.code];
  return { status: error?.uncertain ? 503 : match?.[0] || 500,
    code: match || error?.uncertain ? error.code : 'runtime_internal_error',
    message: error?.uncertain ? 'The write could not be confirmed. Keep its original command identity and inspect saved state before retrying.' : match?.[1] || 'The local rehearsal could not complete this action. Saved records are preserved.', uncertain: Boolean(error?.uncertain) };
}
function decode(value) { try { return decodeURIComponent(value); } catch { error(400, 'invalid_identifier', 'The identifier is invalid.'); } }

export function createRuntimeApiServer({ service, auth, sponsorActions, analysis, allowedHosts = HOSTS, allowedOrigins = ORIGINS, demoControl, env = {}, fetchImpl = globalThis.fetch, transcription, voiceInput } = {}) {
  if (!service || !auth || [...allowedHosts].some(host => !/^(localhost|127\.0\.0\.1):[0-9]{1,5}$/.test(host)) || [...allowedOrigins].some(origin => !/^http:\/\/(localhost|127\.0\.0\.1):[0-9]{1,5}$/.test(origin))) throw new Error('Use a local runtime service, sessions and loopback allowlists.');
  let quiescing=false,activeRequests=0;const drained=new Set();
  const voiceTranscription = transcription || createElevenLabsTranscription({ env, fetchImpl, timeoutMs: 18000, maxAudioBytes: 2 * 1024 * 1024 });
  const voiceInFlight = new Set();
  const server = createServer(async (request, response) => {
    activeRequests++;
    const cancelled = new AbortController();
    const abort = () => cancelled.abort();
    const closed = () => { if (!response.writableEnded) abort(); };
    request.once('aborted', abort); response.once('close', closed);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    if(demoControl)response.setHeader('x-refund-demo-run',demoControl.describe().id);
    const send = (status, body) => { if (response.destroyed || response.writableEnded) return; response.writeHead(status); response.end(body === null ? '' : JSON.stringify(body)); };
    try {
      if (!localAddress(request.socket.remoteAddress) || !allowedHosts.has(request.headers.host)) error(403, 'host_not_allowed', 'Only the local rehearsal host is allowed.');
      const origin = request.headers.origin;
      if ((origin && !allowedOrigins.has(origin)) || (mutation(request.method) && !allowedOrigins.has(origin))) error(403, 'origin_not_allowed', 'Open the local rehearsal to perform this action.');
      if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Access-Control-Allow-Credentials', 'true'); response.setHeader('Vary', 'Origin'); }
      if (request.method === 'OPTIONS') { response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS'); response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Refund-Demo-Run'); return send(204, null); }
      const path = new URL(request.url, 'http://127.0.0.1:4274').pathname, method = request.method;
      const decorate=body=>demoControl?{...body,demoRun:demoControl.describe()}:body;
      let resetInput;
      if(demoControl){
        const status=/^\/api\/demo\/reset\/([a-f0-9-]{36})$/.exec(path);
        if(status&&method==='GET')return send(200,demoControl.status(status[1]));
        if(path==='/api/demo/reset'&&method==='POST'){
          resetInput=await readBody(request);const known=demoControl.lookupExact(resetInput);
          if(known)return send(200,known);
        }
        const fence=request.headers['x-refund-demo-run'];
        if((mutation(method)||fence!==undefined)&&fence!==demoControl.describe().id)error(409,'demo_run_changed','This action belongs to a different demo run. Return to the profile chooser.');
      }
      if((quiescing||demoControl?.blocked())&&!(path==='/api/session'&&method==='GET'))error(503,'demo_switch_in_progress','The current run is being preserved. Inspect the reset status before continuing.');
      if (path === '/api/session' && method === 'GET') return send(200, decorate(auth.describe(request)));
      if (path === '/api/session' && method === 'POST') { const result = auth.signIn(request, await readBody(request)); response.setHeader('Set-Cookie', result.cookie); return send(200, decorate(result.body)); }
      if (path === '/api/session' && method === 'DELETE') { const body = await readBody(request); if (Object.keys(body).length) error(400, 'invalid_runtime_input', 'Logout takes no additional fields.'); const result = auth.signOut(request); response.setHeader('Set-Cookie', result.cookie); return send(200, decorate(result.body)); }
      const principal = auth.authenticate(request);
      if(path==='/api/demo/reset'&&method==='POST'&&demoControl)return send(202,demoControl.reset(principal,resetInput));
      const voiceCaseId = voiceInputCaseId(path);
      if (voiceCaseId) {
        if (demoControl && request.headers['x-refund-demo-run'] !== demoControl.describe().id) error(409, 'demo_run_changed', 'This recording belongs to a different demo run. Return to the profile chooser.');
        if (request.headers['x-refund-machine-key'] || request.headers.authorization) error(403, 'voice_input_access_denied', 'Voice input requires an interactive signed-in session.');
        const voice = voiceInput || createCanvasVoice({ getPacket: (...args) => service.exportCase(...args), transcription: voiceTranscription, inFlight: voiceInFlight, checkAccess: expected => {
          if (demoControl && request.headers['x-refund-demo-run'] !== demoControl.describe().id) error(409, 'demo_run_changed', 'This recording belongs to a different demo run. Return to the profile chooser.');
          const current = auth.authenticate(request);
          if (['userId', 'tenantId', 'role'].some(key => current?.[key] !== expected[key])) error(403, 'voice_input_access_denied', 'The signed-in workspace or role changed. Refresh before recording again.');
        } });
        if (method === 'GET') return send(200, await voice.status(principal, voiceCaseId));
        if (method === 'POST') return send(200, await voice.transcribe(principal, voiceCaseId, await readBody(request, runtimeJsonBodyLimit(path, method)), { signal: cancelled.signal }));
        error(405, 'method_not_allowed', 'Use GET for voice availability or POST for a consented recording.');
      }
      const customerDraft=/^\/api\/cases\/([^/]+)\/customer-draft$/.exec(path);
      if(customerDraft){
        if(method!=='GET')error(405,'method_not_allowed','Customer drafts are read-only. No message is sent by this application.');
        if(demoControl&&request.headers['x-refund-demo-run']!==demoControl.describe().id)error(409,'demo_run_changed','This draft belongs to a different demo run. Return to the profile chooser.');
        return send(200,await service.customerDraft(principal,decode(customerDraft[1])));
      }
      const evidenceRequest=/^\/api\/cases\/([^/]+)\/evidence-request$/.exec(path);
      if(evidenceRequest){
        const id=decode(evidenceRequest[1]);
        if(method==='GET')return send(200,await service.evidenceRequest(principal,id));
        if(method==='POST')return send(200,await service.submitClarification(principal,id,await readBody(request)));
        error(405,'method_not_allowed','Use the supported evidence request method.');
      }
      if (path === '/api/bootstrap' && method === 'GET') {const body=await service.bootstrap(principal);return send(200,decorate({...body,capabilities:{...body.capabilities,...(demoControl?{demoReset:true}:{})}}));}
      if (path === '/api/integrations' && method === 'GET') return send(200, service.integrations());
      if (path === '/api/intake' && method === 'GET') return send(200, await service.listIntake(principal));
      if (path === '/api/intake' && method === 'POST') { const result = await service.intake(principal, await readBody(request)); return send(result.replayed ? 200 : 201, result); }
      if (path === '/api/worker/run-next' && method === 'POST') { const body = await readBody(request); if (Object.keys(body).length) error(400, 'invalid_runtime_input', 'The worker action takes no additional fields.'); return send(200, await service.runNext(principal)); }
      const intake = /^\/api\/intake\/([^/]+)\/resume$/.exec(path);
      if (intake && method === 'POST') return send(200, await service.resume(principal, decode(intake[1]), await readBody(request)));
      const advisory = /^\/api\/cases\/([^/]+)\/analysis$/.exec(path);
      if (advisory) {
        if (!analysis) error(503, 'analysis_disconnected', 'Case advisory analysis is unavailable in this preview.');
        if (method !== 'POST') error(405, 'method_not_allowed', 'Use the saved revision to request this advisory action.');
        return send(200, await analysis.run(principal, decode(advisory[1]), await readBody(request)));
      }
      const sponsor = /^\/api\/cases\/([^/]+)\/sponsor-actions\/(status|voice|miro(?:\/readback)?|modal|port(?:\/readback)?)$/.exec(path);
      if (sponsor) {
        if (!sponsorActions) error(503, 'sponsor_actions_unavailable', 'Sponsor actions are unavailable in this preview. No service was contacted.');
        const caseId = decode(sponsor[1]), action = sponsor[2];
        if (action === 'status' && method === 'GET') return send(200, await sponsorActions.status(principal, caseId));
        if (method !== 'POST' || action === 'status') error(405, 'method_not_allowed', 'That request method is not supported.');
        const methods = { voice: 'generateVoice', miro: 'publishMiro', 'miro/readback': 'readMiro', modal: 'processEvidence', port: 'publishPort', 'port/readback': 'readPort' };
        const result = await sponsorActions[methods[action]](principal, caseId, await readBody(request));
        if (action === 'voice') {
          if (result?.contentType !== 'audio/mpeg' || !(result.bytes instanceof Uint8Array) || !result.bytes.length || result.bytes.length > 8 * 1024 * 1024) error(502, 'unverified_audio', 'The voice action did not return verified MP3 audio.');
          response.setHeader('Content-Type', 'audio/mpeg'); response.setHeader('Content-Length', result.bytes.length);
          response.setHeader('Content-Disposition', 'inline; filename="case-briefing.mp3"');
          response.writeHead(200); response.end(result.bytes); return;
        }
        return send(200, result);
      }
      const match = /^\/api\/cases\/([^/]+)(?:\/(approve|review|export|history|report|briefing|board-export))?$/.exec(path);
      if (!match) error(404, 'route_not_found', 'This rehearsal does not provide that action.');
      const id = decode(match[1]), action = match[2];
      if (!action && method === 'GET') return send(200, await service.getCase(principal, id));
      if (method === 'POST' && ['approve', 'review'].includes(action)) return send(200, await service[action](principal, id, await readBody(request)));
      if (method === 'GET') {
        if (action === 'history') return send(200, await service.history(principal, id));
        if (action === 'briefing') return send(200, await service.briefing(principal, id));
        if (action === 'export' || action === 'board-export') { const result = await service[action === 'export' ? 'exportCase' : 'boardExport'](principal, id); response.setHeader('Content-Disposition', 'attachment; filename="runtime-case-export.json"'); return send(200, result); }
        if (action === 'report') { const result = await service.report(principal, id); response.setHeader('Content-Type', 'text/markdown; charset=utf-8'); response.setHeader('Content-Disposition', `attachment; filename="${result.filename.replace(/[^A-Za-z0-9_.-]/g, '')}"`); response.writeHead(200); response.end(result.text); return; }
      }
      error(405, 'method_not_allowed', 'That request method is not supported.');
    } catch (cause) { const result = failure(cause); send(result.status, { error: { code: result.code, message: result.message, uncertain: result.uncertain } }); }
    finally{request.removeListener('aborted',abort);response.removeListener('close',closed);activeRequests--;if(!activeRequests){for(const resolve of drained)resolve();drained.clear();}}
  });
  server.beginQuiesce=()=>{quiescing=true;};
  server.drainRequests=()=>activeRequests?new Promise(resolve=>drained.add(resolve)):Promise.resolve();
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  return server;
}
