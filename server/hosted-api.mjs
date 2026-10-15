import { createHostedAuth, HostedError, hostedPublicSettings, requireHostedEnabled } from './hosted-auth.mjs';
import { createHostedRuntime } from './hosted-runtime.mjs';
import { createSponsorActions, SponsorActionError } from './sponsor-actions.mjs';
import { createSupabaseSponsorLedger } from './supabase-sponsor-ledger.mjs';
import { createSponsorClients } from './sponsor-clients.mjs';
import { createElevenLabs } from './elevenlabs.mjs';
import { createCaseAnalysis } from './case-analysis.mjs';
import { authenticatePaymentMachine, createHostedPayments } from './hosted-payments.mjs';
import { requireRuntimePaymentGate, RuntimePaymentError } from './runtime-payments.mjs';
import { createElevenLabsTranscription } from './elevenlabs-transcription.mjs';
import { CanvasVoiceError, createCanvasVoice, runtimeJsonBodyLimit, voiceInputCaseId } from './canvas-voice.mjs';

const MAX_BODY = 16 * 1024;
const fail = (status, code, message) => { throw new HostedError(status, code, message); };
async function input(request, empty = false, limit = MAX_BODY) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail(415, 'json_required', 'Send this action as JSON.');
  if (Number(request.headers.get('content-length')) > limit) fail(413, 'body_too_large', 'The request is too large.');
  const reader = request.body?.getReader(); const chunks = []; let size = 0;
  if (reader) { try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) { await reader.cancel(); fail(413, 'body_too_large', 'The request is too large.'); } chunks.push(Buffer.from(part.value)); } } finally { reader.releaseLock(); } }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { fail(400, 'invalid_json', 'Send a JSON object.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || empty && Object.keys(value).length) fail(400, 'invalid_hosted_input', 'Send only the fields required for this action.');
  return value;
}
function failure(error) {
  if (error instanceof HostedError || error instanceof SponsorActionError || error instanceof CanvasVoiceError) return { status: error.status, code: error.code, message: error.message, uncertain: Boolean(error.uncertain) };
  if (error instanceof RuntimePaymentError) return { status: error.uncertain || error.code === 'payment_execution_disabled' ? 503 : 409, code: error.code, message: error.message, uncertain: Boolean(error.uncertain) };
  const known = { invalid_runtime_input: [400, 'The action is incomplete or invalid.'], runtime_access_denied: [403, 'This user cannot perform the requested action.'], runtime_conflict: [409, 'The saved facts changed. Refresh before deciding again.'], runtime_disconnected: [503, 'The working store is disconnected.'], reviewer_session_required: [401, 'Refresh your session or sign in again.'] };
  const match = known[error?.code];
  if (error?.uncertain) return { status: 503, code: 'hosted_write_unresolved', message: 'The write could not be confirmed. Keep its original command identity and inspect saved state before retrying.', uncertain: true };
  // RuntimeServiceError contains only curated application messages.
  if (error?.name === 'RuntimeServiceError') return { status: error.status, code: error.code, message: error.message };
  if (['analysis_access_denied','invalid_analysis_input','analysis_stale_case','analysis_evidence_required','analysis_input_too_large','analysis_configuration','analysis_disconnected'].includes(error?.code)) return { status: error.status, code: error.code, message: error.message };
  return { status: match?.[0] || 500, code: match ? error.code : 'hosted_internal_error', message: match?.[1] || 'The hosted action could not be completed. Saved records are preserved.' };
}
export function createHostedHandler({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, authTimeoutMs = 10000, sponsorActions, analysis, auth: suppliedAuth, runtimeFactory = createHostedRuntime, transcription } = {}) {
  const auth = suppliedAuth || createHostedAuth({ env, fetchImpl, now, timeoutMs: authTimeoutMs });
  let voiceTranscription = transcription;
  const voiceInFlight = new Set();
  return async function hostedHandler(request) {
    let service, authenticatedInvestigation = false;
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" };
    const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), { status, headers: { ...headers, ...extra } });
    const investigationMetadata = () => {
      if (!authenticatedInvestigation || env.REFUND_OFFICE_HOSTED_TRACING !== 'enabled') return {};
      const metadata = {};
      for (const name of ['recordedTrace', 'recordedInvestigationReceipts']) {
        try { const value = service?.[name]?.(); if (value) metadata[name] = value; } catch { /* Recording cannot replace an investigation result or error. */ }
      }
      return metadata;
    };
    try {
      requireHostedEnabled(env);
      const config = hostedPublicSettings(env), url = new URL(request.url), method = request.method, origin = request.headers.get('origin');
      if (url.origin !== config.origin || request.headers.has('host') && request.headers.get('host') !== url.host) fail(403, 'host_not_allowed', 'Use the configured application host.');
      const machine = url.pathname.startsWith('/api/machine/');
      if (origin && origin !== config.origin || !['GET', 'HEAD'].includes(method) && !machine && origin !== config.origin || machine && origin) fail(403, 'origin_not_allowed', 'This request does not have the required origin.');
      if (url.pathname === '/api/public-config' && method === 'GET') {
        const separateTestExecutionConfigured = env.REFUND_OFFICE_PAYMENT_EXECUTION === 'stripe-test' && String(env.REFUND_OFFICE_ENABLED_INTEGRATIONS || '').split(',').map(value => value.trim()).includes('stripe-runtime');
        return json({ mode: 'hosted-supabase', passwordSignIn: true, paymentsEnabled: false, machineScheduling: true, ...(separateTestExecutionConfigured ? { separateTestExecutionConfigured: true } : {}) });
      }
      if (url.pathname === '/api/session' && method === 'POST') { const result = await auth.signIn(await input(request), request); return json(result.body, 200, { 'Set-Cookie': result.cookie }); }
      if (url.pathname === '/api/session/refresh' && method === 'POST') { await input(request, true); const result = await auth.refresh(request); return json(result.body, 200, { 'Set-Cookie': result.cookie }); }
      if (url.pathname === '/api/session' && method === 'DELETE') { await input(request, true); const result = await auth.signOut(request); return json(result.body, 200, { 'Set-Cookie': result.cookie }); }
      if (url.pathname === '/api/session' && method === 'GET') {
        try { return json(auth.publicBody((await auth.authenticate(request)).principal)); }
        catch (error) { if (error instanceof HostedError && error.status === 401) return json({ ...auth.publicBody(null), logoutPending: error.code === 'hosted_logout_pending' }); throw error; }
      }
      const paymentMachine = /^\/api\/machine\/payments\/([a-f0-9-]{36})\/(execute|reconcile)$/.exec(url.pathname);
      if (paymentMachine) {
        requireRuntimePaymentGate(env);
        if (method !== 'POST') fail(405, 'method_not_allowed', 'Use POST for a payment executor invocation.');
        await input(request, true);
        const verified = await authenticatePaymentMachine(request, { env, fetchImpl, now });
        const payments = createHostedPayments({ env, fetchImpl, now, ...verified });
        return json(await payments[paymentMachine[2]](paymentMachine[1]));
      }
      const paymentRead = /^\/api\/payment-executions\/([a-f0-9-]{36})$/.exec(url.pathname);
      const paymentContext = /^\/api\/cases\/([A-Za-z0-9_-]+)\/payment-authorisation$/.exec(url.pathname);
      if (url.pathname === '/api/payment-executions' || paymentRead || paymentContext) {
        requireRuntimePaymentGate(env);
        if (method !== (paymentRead || paymentContext ? 'GET' : 'POST')) fail(405, 'method_not_allowed', 'Use the supported execution review method.');
        const verified = await auth.authenticate(request);
        const payments = createHostedPayments({ env, fetchImpl, now, ...verified });
        return json(paymentContext ? await payments.context(paymentContext[1]) : paymentRead ? await payments.read(paymentRead[1]) : await payments.authorise(await input(request)));
      }
      if (machine && !['/api/machine/intake', '/api/machine/investigate'].includes(url.pathname)) fail(404, 'route_not_found', 'No such machine action is provided.');
      const verified = await (machine ? auth.machine(request) : auth.authenticate(request)), principal = verified.principal;
      service = runtimeFactory({ env, fetchImpl, ...verified });
      const voiceCaseId = voiceInputCaseId(url.pathname);
      if (voiceCaseId) {
        if (request.headers.has('x-refund-machine-key') || request.headers.has('authorization')) fail(403, 'voice_input_access_denied', 'Voice input requires an interactive signed-in session.');
        voiceTranscription ||= createElevenLabsTranscription({ env, fetchImpl, timeoutMs: 18000, maxAudioBytes: 2 * 1024 * 1024 });
        const voice = createCanvasVoice({ getPacket: service.exportCase, transcription: voiceTranscription, inFlight: voiceInFlight, checkAccess: async expected => {
          const current = (await auth.authenticate(request)).principal;
          if (['userId', 'tenantId', 'role'].some(key => current?.[key] !== expected[key])) fail(403, 'voice_input_access_denied', 'The signed-in workspace or role changed. Refresh before recording again.');
        } });
        if (method === 'GET') return json(await voice.status(principal, voiceCaseId));
        if (method === 'POST') return json(await voice.transcribe(principal, voiceCaseId, await input(request, false, runtimeJsonBodyLimit(url.pathname, method)), { signal: request.signal }));
        fail(405, 'method_not_allowed', 'Use GET for voice availability or POST for a consented recording.');
      }
      const customerDraft=/^\/api\/cases\/([A-Za-z0-9_-]+)\/customer-draft$/.exec(url.pathname);
      if(customerDraft){
        if(method!=='GET')fail(405,'method_not_allowed','Customer drafts are read-only. No message is sent by this application.');
        return json(await service.customerDraft(principal,customerDraft[1]));
      }
      const evidenceRequest=/^\/api\/cases\/([A-Za-z0-9_-]+)\/evidence-request$/.exec(url.pathname);
      if(evidenceRequest){
        if(method==='GET')return json(await service.evidenceRequest(principal,evidenceRequest[1]));
        if(method==='POST')return json(await service.submitClarification(principal,evidenceRequest[1],await input(request)));
        fail(405,'method_not_allowed','Use the supported evidence request method.');
      }
      if (machine) {
        if (method !== 'POST') fail(405, 'method_not_allowed', 'Use POST for a machine invocation.');
        if (url.pathname.endsWith('/intake')) { const result = await service.intake(principal, await input(request)); return json(result, result.replayed ? 200 : 201); }
        await input(request, true);
        authenticatedInvestigation = principal.role === 'investigator';
        const result = await service.runNext(principal);
        return json({ ...result, ...investigationMetadata() });
      }
      if (url.pathname === '/api/bootstrap' && method === 'GET') return json(await service.bootstrap(principal));
      if (url.pathname === '/api/integrations' && method === 'GET') return json(service.integrations());
      if (url.pathname === '/api/intake' && method === 'GET') return json(await service.listIntake(principal));
      if (url.pathname === '/api/intake' && method === 'POST') { const result = await service.intake(principal, await input(request)); return json(result, result.replayed ? 200 : 201); }
      if (url.pathname === '/api/worker/run-next' && method === 'POST') { await input(request, true); return json(await service.runNext(principal)); }
      const resume = /^\/api\/intake\/([A-Za-z0-9_-]+)\/resume$/.exec(url.pathname);
      if (resume && method === 'POST') return json(await service.resume(principal, resume[1], await input(request)));
      const sponsored = /^\/api\/cases\/([A-Za-z0-9_-]+)\/sponsor-actions\/(status|voice|miro|miro\/readback|modal|port|port\/readback)$/.exec(url.pathname);
      if (sponsored) {
        const actions = sponsorActions || createSponsorActions({ env,
          clients: createSponsorClients({ env, fetchImpl }),
          voice: { synthesise: value => createElevenLabs({ env, fetchImpl, maxAudioBytes: 3 * 1024 * 1024 }).synthesise(value) },
          ledger: createSupabaseSponsorLedger({ env, tenantId: principal.tenantId, getAccessToken: async () => verified.accessToken, fetchImpl }),
          getPacket: service.exportCase, getBriefing: service.briefing, getBoard: service.boardExport });
        const names = { status: 'status', voice: 'generateVoice', miro: 'publishMiro', 'miro/readback': 'readMiro', modal: 'processEvidence', port: 'publishPort', 'port/readback': 'readPort' };
        if (method !== (sponsored[2] === 'status' ? 'GET' : 'POST')) fail(405, 'method_not_allowed', 'That action uses another request method.');
        const result = await actions[names[sponsored[2]]](principal, sponsored[1], ...(sponsored[2] === 'status' ? [] : [await input(request)]));
        if (sponsored[2] === 'voice' && result.bytes) return new Response(result.bytes, { status: 200, headers: { ...headers, 'Content-Type': result.contentType } });
        return json(result);
      }
      const advisory = /^\/api\/cases\/([A-Za-z0-9_-]+)\/analysis$/.exec(url.pathname);
      if (advisory && method === 'POST') { const analyser = analysis || createCaseAnalysis({ env, fetchImpl, getPacket: service.exportCase }); return json(await analyser.run(principal, advisory[1], await input(request))); }
      const match = /^\/api\/cases\/([A-Za-z0-9_-]+)(?:\/(approve|review|export|history|report|briefing|board-export))?$/.exec(url.pathname);
      if (!match) fail(404, 'route_not_found', 'This application does not provide that action.');
      const id = match[1], action = match[2];
      if (!action && method === 'GET') return json(await service.getCase(principal, id));
      if (method === 'POST' && ['approve', 'review'].includes(action)) return json(await service[action](principal, id, await input(request)));
      if (method === 'GET') {
        if (action === 'history') return json(await service.history(principal, id));
        if (action === 'briefing') return json(await service.briefing(principal, id));
        if (action === 'export' || action === 'board-export') return json(await service[action === 'export' ? 'exportCase' : 'boardExport'](principal, id), 200, { 'Content-Disposition': 'attachment; filename="runtime-case-export.json"' });
        if (action === 'report') { const result = await service.report(principal, id); return new Response(result.text, { status: 200, headers: { ...headers, 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${result.filename.replace(/[^A-Za-z0-9_.-]/g, '')}"` } }); }
      }
      fail(405, 'method_not_allowed', 'That request method is not supported.');
    } catch (error) { const result = failure(error); return json({ error: { code: result.code, message: result.message, uncertain: Boolean(result.uncertain) }, ...investigationMetadata() }, result.status); }
    finally { if (service) await service.close(); }
  };
}
