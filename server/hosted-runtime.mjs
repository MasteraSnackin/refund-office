import { createRuntimeService } from './runtime-service.mjs';
import { createInvestigationProviders } from './investigation-proposal.mjs';
import { createHostedObserver, readHostedTrace, HOSTED_TRACE_SCOPE } from './hosted-observability.mjs';
import { createSupabaseRuntimeRepository } from './supabase-runtime-repository.mjs';
import { HostedError, requireHostedEnabled } from './hosted-auth.mjs';
import { buildCaseProvenance } from './case-provenance.mjs';
import { buildRuntimeBriefing, buildRuntimeDecisionReport } from './runtime-outputs.mjs';
import { buildCustomerClarificationDraft } from './customer-drafts.mjs';

export const HOSTED_CAPABILITIES = Object.freeze({ storage: 'supabase', runtime: true, networkMode: 'external-enabled', analyser: 'local', payments: 'disabled', paymentSubmission: false,
  humanApprovalRequired: true, authentication: 'supabase-verified', liveVerified: false, hosted: true });
const limits = ['Synthetic records only.', 'User identity and tenant membership are checked through Supabase.'];
const executionScope = 'This is the original case reservation record. Inspect the separately authorised Stripe test execution record for any submission, refund identity or provider result.';
const receiptScope = Object.freeze({ schemaVersion: 1, scope: 'request', storage: 'memory', durable: false, uploaded: false,
  executionMetadataOnly: true, establishesSavedCase: false });
const dataField = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const receiptInteger = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const receiptTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const receiptModel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value) && !/^(?:sk[-_]|sb_secret_|https?:)/i.test(value);
const receiptIdentity = (value, prefix, maximum) => typeof value === 'string' && value.length <= maximum && new RegExp(`^${prefix}[A-Za-z0-9_-]+$`).test(value);
const usageFields = ['inputTokens', 'outputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens'];
function receiptUsage(value, maximum = 4000000) {
  const clean = {};
  for (const key of usageFields) { const count = dataField(value, key); if (!receiptInteger(count, maximum)) return null; clean[key] = count; }
  return clean;
}
function sanitiseInvestigationReceipt(value) {
  const get = key => dataField(value, key), id = get('id'), startedAt = get('startedAt'), finishedAt = get('finishedAt');
  const requests = get('requests'), tools = get('tools'), usage = receiptUsage(get('usage'));
  if (get('schemaVersion') !== 1 || typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id) || get('provider') !== 'anthropic'
    || !['controlled-test', 'provider-response'].includes(get('transport')) || get('investigatorMode') !== 'bounded-tools' || !receiptModel(get('configuredModel'))
    || typeof get('inputHash') !== 'string' || !/^[a-f0-9]{64}$/.test(get('inputHash')) || !receiptTime(startedAt) || !receiptTime(finishedAt) || Date.parse(finishedAt) < Date.parse(startedAt)
    || !['running', 'completed', 'failed'].includes(get('status')) || !['not-run', 'passed', 'failed'].includes(get('validation')) || !usage
    || !Array.isArray(requests) || requests.length > 4 || !Array.isArray(tools) || tools.length > 12) return null;
  const clean = { schemaVersion: 1, id, provider: 'anthropic', transport: get('transport'), investigatorMode: 'bounded-tools', configuredModel: get('configuredModel'),
    inputHash: get('inputHash'), startedAt, finishedAt, status: get('status'), validation: get('validation'), requests: [], tools: [], usage };
  const errorCode = get('errorCode');
  if (errorCode !== undefined) { if (typeof errorCode !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(errorCode)) return null; clean.errorCode = errorCode; }
  for (let index = 0; index < requests.length; index++) {
    const row = dataField(requests, String(index)), field = key => dataField(row, key);
    if (!receiptInteger(field('number'), 4) || field('number') !== index + 1 || !receiptTime(field('startedAt')) || !receiptTime(field('finishedAt'))
      || !['requesting', 'completed', 'error'].includes(field('status')) || !(field('requestId') === null || receiptIdentity(field('requestId'), 'req_', 184))
      || !(field('messageId') === null || receiptIdentity(field('messageId'), 'msg_', 184)) || !(field('model') === null || receiptModel(field('model')))
      || ![null, 'tool_use'].includes(field('stopReason'))) return null;
    const recordedUsage = field('inputTokens') === null && field('outputTokens') === null ? null : receiptUsage(row, 1000000);
    if (recordedUsage === null && !(field('inputTokens') === null && field('outputTokens') === null)) return null;
    clean.requests.push({ number: field('number'), startedAt: field('startedAt'), finishedAt: field('finishedAt'), status: field('status'), requestId: field('requestId'),
      messageId: field('messageId'), model: field('model'), stopReason: field('stopReason'), ...(recordedUsage || { inputTokens: null, outputTokens: null }) });
  }
  for (let index = 0; index < tools.length; index++) {
    const row = dataField(tools, String(index)), field = key => dataField(row, key);
    if (!receiptInteger(field('round'), 4) || field('round') < 1 || !(field('id') === null || receiptIdentity(field('id'), '', 200))
      || !['read_order', 'read_evidence', 'submit_recommendation', 'unsupported'].includes(field('name')) || !['requested', 'completed', 'error'].includes(field('status'))
      || !receiptTime(field('at')) || !receiptTime(field('startedAt')) || !receiptTime(field('finishedAt'))) return null;
    clean.tools.push({ round: field('round'), id: field('id'), name: field('name'), status: field('status'), at: field('at'), startedAt: field('startedAt'), finishedAt: field('finishedAt') });
  }
  return Buffer.byteLength(JSON.stringify(clean)) <= 64 * 1024 ? clean : null;
}
// Only execution metadata from this request's selected tool provider is copied.
// A completed model receipt says nothing about whether SQL saved the case.
function recordedInvestigationReceipts(env, selected, providers) {
  if (env.REFUND_OFFICE_HOSTED_TRACING !== 'enabled' || selected.analyser !== 'anthropic' || selected.investigatorMode !== 'bounded-tools'
    || !['controlled-test', 'provider-response'].includes(selected.responseMode)) return undefined;
  const unavailable = { ...receiptScope, recordingAvailable: false, incomplete: true, receipts: [] };
  try {
    const getter = providers.receipts;
    if (typeof getter !== 'function') return unavailable;
    const raw = getter.call(providers);
    if (!Array.isArray(raw)) return unavailable;
    const receipts = [];
    // The hosted runtime executes at most one investigation per request.
    const value = raw.length === 1 ? sanitiseInvestigationReceipt(dataField(raw, '0')) : null;
    if (value) receipts.push(value);
    return { ...receiptScope, recordingAvailable: true, incomplete: raw.length > receipts.length, receipts };
  } catch { return unavailable; }
}
export function separateTestExecutionConfigured(env = {}) {
  return env.REFUND_OFFICE_NETWORK === 'enabled' && env.REFUND_OFFICE_PAYMENT_EXECUTION === 'stripe-test' && String(env.REFUND_OFFICE_ENABLED_INTEGRATIONS || '').split(',').map(value=>value.trim()).includes('stripe-runtime');
}

// One service per verified request. There is deliberately no service.start():
// serverless lifetimes cannot own an unattended worker or durable retry loop.
export function createHostedRuntime({ env = process.env, fetchImpl = globalThis.fetch, principal, accessToken, observer, packId, investigationProviders } = {}) {
  requireHostedEnabled(env);
  const repository = createSupabaseRuntimeRepository({ env, tenantId: principal.tenantId, getAccessToken: async () => accessToken, fetchImpl });
  const repositoryForSession = session => {
    if (session.userId !== principal.userId || session.tenantId !== principal.tenantId || session.role !== principal.role) throw new HostedError(403, 'hosted_principal_changed', 'The verified request identity cannot be replaced.');
    return repository;
  };
  const evidenceClarification=env.REFUND_OFFICE_EVIDENCE_CLARIFICATION==='enabled';
  const selectedObserver = observer ?? createHostedObserver({ env });
  const providers = investigationProviders || createInvestigationProviders({ env, fetchImpl });
  const service = createRuntimeService({ repositoryForSession, workerRepository: repository, automaticWorker: false, evidenceClarification, observer: selectedObserver, packId, investigationProviders: providers });
  const configured = separateTestExecutionConfigured(env);
  const selected = providers.capabilities();
  const capabilities = () => ({ ...HOSTED_CAPABILITIES, analyser: selected.analyser, analyserMode: selected.analyser === 'local' ? 'local-rules' : selected.responseMode, analyserModel: selected.analyser === 'local' ? 'local-rules-v2' : selected.model, evidenceClarification, customerDrafts: true, separateTestExecutionConfigured: configured, paymentExecutionScope: 'original-reservation', payments: configured ? 'separate-stripe-test-prepared' : 'disabled' });
  const caseScope = item => ({ ...item, separateTestExecutionConfigured: configured, paymentExecutionScope: 'original-reservation',
    summary: item.outcome === 'approved-not-submitted' ? `Human approval is saved in the original reservation. That reservation does not submit a payment. ${executionScope}` : `${item.summary} ${executionScope}` });
  const exported = async (session, id) => {
    const value = await service.exportCase(session,id);
    return { ...value, case:caseScope(value.case), mode:'hosted-supabase', capabilities:capabilities(), separateTestExecutionConfigured:configured,
      limitations:[limits[0],limits[1],executionScope,'Separate execution records are not included in this case export. Configuration does not verify a provider result.'] };
  };
  const withCase = method => async (...args) => { const value=await service[method](...args); return value.case ? {...value,case:caseScope(value.case)} : value.id ? caseScope(value) : value; };
  const briefing = async(session,id) => {
    const {case:item}=await exported(session,id);
    return { ...buildRuntimeBriefing(item, { hosted: true, paymentText: executionScope }), separateTestExecutionConfigured: configured };
  };
  return {
    ...service,
    recordedTrace() { return env.REFUND_OFFICE_HOSTED_TRACING === 'enabled' ? readHostedTrace(selectedObserver) : undefined; },
    recordedInvestigationReceipts() { return recordedInvestigationReceipts(env, selected, providers); },
    async bootstrap(session) {
      const value = await service.bootstrap(session);
      return { ...value, cases:value.cases.map(caseScope), capabilities:capabilities(), session: { userId: principal.userId, profileId: principal.userId, role: principal.role, expiresAt: principal.expiresAt },
        runtime: { ...value.runtime, mode: 'hosted-supabase', observability: { ...value.runtime.observability, ...(value.runtime.observability?.enabled ? HOSTED_TRACE_SCOPE : {}) }, worker: { ...value.runtime.worker, enabled: false, scheduling: 'authenticated-machine-hook' } },
        demoDataset: { ...value.demoDataset, title: principal.title || 'Synthetic hosted workspace' } };
    },
    exportCase: exported,
    async customerDraft(session, id) { return buildCustomerClarificationDraft(await exported(session, id)); },
    async getCase(session,id) {return (await exported(session,id)).case;},
    approve:withCase('approve'),review:withCase('review'),intake:withCase('intake'),resume:withCase('resume'),runNext:withCase('runNext'),submitClarification:withCase('submitClarification'),
    async listIntake(session) { const value = await service.listIntake(session); return { ...value, mode: 'hosted-supabase', worker: { ...value.worker, enabled: false, scheduling: 'authenticated-machine-hook' } }; },
    async report(session, id) {
      const {case:item}=await exported(session,id);
      return buildRuntimeDecisionReport(item, { hosted: true, paymentText: executionScope, connectionText: 'Supabase verifies the user and stores this case. Model agreement, configuration and a reservation do not establish payment completion.' });
    },
    briefing,
    async boardExport(session,id) {
      return {...buildCaseProvenance(await exported(session,id)),separateTestExecutionConfigured:configured};
    },
    integrations() {
      const value = service.integrations();
      return { ...value, mode: 'external-enabled', providers: value.providers.map(provider => provider.id === 'supabase'
        ? { ...provider, role: 'Verify user access and store the synthetic workflow', status: 'request-verified', detail: 'The current request has a verified user and tenant role. Original reservations and separate test execution records retain their distinct authority and history.' }
        : provider.id === 'vercel' ? { ...provider, status: 'prepared', detail: 'A callable serverless handler and separate deployment configuration are prepared. This status does not verify a Vercel deployment.' }
          : provider.id === 'n8n' ? { ...provider, detail: 'An authenticated machine hook can save a stable intake event and run one investigation. This status does not verify an n8n execution.' }
            : provider.id === 'stripe' ? {...provider,status:configured?'configured-unverified':'adapter-disconnected',detail:configured?'Separate test execution gates are enabled. A further exact reviewer authorisation, mapped test payment and dedicated executor are required. No provider result is verified by this status.':'Separate test execution is disconnected. Original case reservations do not submit payments.'}:provider) };
    },
    start() { throw new HostedError(409, 'hosted_timer_disabled', 'Use an authenticated bounded machine invocation.'); },
  };
}
