import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders } from '../server/providers.mjs';
import { createRuntimeService } from '../server/runtime-service.mjs';
import { createHostedRuntime } from '../server/hosted-runtime.mjs';
import { createInvestigationProviders, investigationIdentity, prepareInvestigationProposal } from '../server/investigation-proposal.mjs';
import { LANGUAGE_ORDER, LANGUAGE_CASES } from './fixtures/claim-language.mjs';
const order = structuredClone(LANGUAGE_ORDER), evidence = [{ id: 'order:LANG-O1' }, { id: 'packing:LANG-O1' }, { id: 'delivery:LANG-O1' }];
const session = { userId: '70000000-0000-4000-8000-000000000001', tenantId: '70000000-0000-4000-8000-000000000012', role: 'investigator' };
const valid = { amountMinor: 1000, lineId: 'LANG-SKETCH', issue: 'item_missing', reason: 'The supplied packing record omits the claimed sketchbook.', evidenceIds: ['order:LANG-O1', 'packing:LANG-O1'] };
const envFor = provider => ({ REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_ANALYSER: provider, REFUND_OFFICE_ENABLED_INTEGRATIONS: provider, OPENAI_API_KEY: 'fake-local-test', OPENAI_MODEL: 'gpt-test-fixture', ANTHROPIC_API_KEY: 'fake-local-test', ANTHROPIC_MODEL: 'claude-test-fixture' });
function controlled(provider = 'openai', output = valid, failure) {
  const calls = [];
  const providers = createInvestigationProviders({ env: envFor(provider), responseMode: 'controlled-test', fetchImpl: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) }); if (failure) throw new Error('PRIVATE test outage');
    return Response.json(provider === 'openai' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] } : { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(output) }] });
  } }); return { providers, calls };
}
function fixture(provider, { complaint = LANGUAGE_CASES[1].complaint, extraEvidence = [] } = {}) {
  let item = { id: 'LANG-C1', caseId: 'RF-900', revision: 2, orderId: order.id, complaint, title: 'Synthetic language test', status: 'running', stage: 'policy', approval: null, operationId: null, receipt: null, evidence: [...evidence, ...extraEvidence], checks: [], events: [] }, claimed = false;
  const calls = [], request = { id: 'LANG-R1', caseId: item.id, status: 'running' };
  const repo = { async claimIntake() { calls.push('claim'); if (claimed) return null; claimed = true; return { requestId: request.id, caseId: item.id, fence: 1, leaseUntil: new Date(Date.now()+30000).toISOString(), case: structuredClone(item), order: structuredClone(order), evidence: structuredClone(item.evidence), policy: { limitMinor: 2500, version: 1 } }; },
    async finishIntake({ proposal }) { calls.push('finish'); item = { ...item, proposal, proposedAmountMinor: proposal.amountMinor, revision: 3, fingerprint: 'f'.repeat(64), status: 'paused', stage: 'review', outcome: 'awaiting-approval' }; return { case: item, request }; },
    async failIntake({ errorCode }) { calls.push('fail'); item = { ...item, status: 'paused', stage: 'review', outcome: 'held', errorCode }; request.status = 'error'; return { case: item, request }; },
    async readWorkspace() { return { tenantId: session.tenantId, cases: [item], orders: [order], policy: {}, intakeRequests: [request] }; } };
  return { repo, calls, get item() { return item; }, service: createRuntimeService({ repositoryForSession: () => repo, workerRepository: repo, automaticWorker: false, investigationProviders: provider }) };
}
for (const example of LANGUAGE_CASES) test(`local language regression: ${example.id}`, async () => {
  const before = JSON.stringify(order), result = await createProviders({ env: {}, fetchImpl: () => assert.fail('Offline request') }).proposeCase({ complaint: example.complaint, order, evidence });
  assert.equal(result.issue, example.issue, example.complaint); assert.equal(result.amountMinor, example.amountMinor); assert.equal(result.lineId, example.lineId); assert.equal(JSON.stringify(order), before);
});
for (const provider of ['openai','anthropic']) test(`${provider} participates in the main investigation and returns only a pending recommendation`, async t => {
  const c = controlled(provider), f = fixture(c.providers); t.after(() => f.service.close());
  const result = await f.service.runNext(session);
  assert.equal(result.case.outcome, 'awaiting-approval'); assert.equal(result.case.approval?.state, 'required'); assert.equal(result.case.operationId, null); assert.equal(result.case.receipt, null);
  assert.deepEqual(f.item.proposal.provenance, { provider, model: `${provider === 'openai' ? 'gpt' : 'claude'}-test-fixture`, mode: 'controlled-test' });
  assert.equal(f.item.proposal.source, provider); assert.equal(c.calls.length, 1); assert.deepEqual(f.calls, ['claim','finish']);
  assert.equal((await f.service.bootstrap(session)).capabilities.analyserMode, 'controlled-test');
  assert.equal(f.service.workerState().mode, 'controlled-model-test');
});
for (const [name, output, options] of [
  ['wrong amount', { ...valid, amountMinor: 999 }], ['invented citation', { ...valid, evidenceIds: [...valid.evidenceIds, 'invented:record'] }],
  ['missing order citation', { ...valid, evidenceIds: ['packing:LANG-O1'] }], ['foreign item', { ...valid, lineId: 'FOREIGN-LINE' }],
  ['fully packed item', { ...valid, lineId: 'LANG-CLIPS', amountMinor: 300 }], ['decision injection', { ...valid, approved: true }],
  ['unsafe number', { ...valid, amountMinor: 1.1 }], ['paid unknown', { ...valid, issue: 'unknown' }],
  ['contradictory statement', valid, { complaint: 'The sketchbook is not missing.' }],
  ['generic multi-item omission', valid, { complaint: 'Some items are missing from my order. Please check the packing record.' }],
  ['multiple named items without identification', valid, { complaint: 'My order has a sketchbook and a marker set. Some items are missing.' }],
  ['alternative items', valid, { complaint: 'The sketchbook or marker set is missing.' }],
  ['delivery dispute', valid, { complaint: 'My parcel is missing.' }],
  ['conflicting clarification', valid, { extraEvidence: [{ id: 'clarification:70000000-0000-4000-8000-000000000002', kind: 'customer-clarification', source: 'Customer clarification recorded by reviewer', lineId: 'LANG-MARKER', body: 'The marker set is missing.' }] }],
]) test(`main investigation rejects ${name} and records a recoverable error without fallback`, async t => {
  const c = controlled('openai', output), f = fixture(c.providers, options); t.after(() => f.service.close());
  await assert.rejects(f.service.runNext(session)); assert.deepEqual(f.calls, ['claim','fail']); assert.equal(c.calls.length, 1);
  assert.equal(f.item.outcome, 'held'); assert.equal(f.item.approval, null); assert.equal(f.item.operationId, null); assert.equal(f.item.proposal, undefined);
});
test('unavailable chosen model records its error; the local analyser is never substituted', async t => {
  const c = controlled('anthropic', valid, true), f = fixture(c.providers); t.after(() => f.service.close());
  await assert.rejects(f.service.runNext(session), { code: 'anthropic_unavailable' }); assert.deepEqual(f.calls, ['claim','fail']); assert.equal(f.item.errorCode, 'anthropic_unavailable');
  assert.doesNotMatch(JSON.stringify(f.service.workerState()), /PRIVATE|fake-local-test/);
});
test('provider selection is explicit, offline keys are unread and controlled test mode cannot use global fetch', () => {
  const offline = new Proxy({ REFUND_OFFICE_NETWORK: 'offline' }, { get(target, key) { assert.equal(key, 'REFUND_OFFICE_NETWORK'); return target[key]; } });
  assert.equal(createInvestigationProviders({ env: offline }).capabilities().analyser, 'local');
  const unselected = new Proxy({ REFUND_OFFICE_NETWORK: 'enabled' }, { get(target, key) { assert.ok(['REFUND_OFFICE_NETWORK','REFUND_OFFICE_ANALYSER'].includes(key)); return target[key]; } });
  assert.equal(createInvestigationProviders({ env: unselected }).capabilities().analyser, 'local');
  assert.equal(createProviders({ env: { REFUND_OFFICE_NETWORK: 'enabled', OPENAI_API_KEY: 'unused-key' } }).capabilities().analyser, 'local');
  const refused = new Proxy({ ...envFor('openai'), REFUND_OFFICE_ENABLED_INTEGRATIONS: 'anthropic' }, { get(target,key) { if (/^(OPENAI_|ANTHROPIC_|STRIPE_)/.test(String(key))) assert.fail('Disabled analyser key was read'); return target[key]; } });
  assert.throws(() => createInvestigationProviders({ env: refused }), { code: 'analysis_disconnected' });
  assert.throws(() => createInvestigationProviders({ env: envFor('openai'), responseMode: 'controlled-test' }), { code: 'controlled_transport_required' });
  assert.throws(() => createInvestigationProviders({ env: { ...envFor('anthropic'), ANTHROPIC_API_KEY: '' }, responseMode: 'controlled-test', fetchImpl() {} }), { code: 'analyser_not_configured' });
});
test('provider cannot mutate saved catalogue or supply its own provenance', async t => {
  const p = controlled().providers, identity = investigationIdentity(p);
  assert.throws(() => prepareInvestigationProposal({ ...valid, source: 'openai', provenance: { mode: 'local-rules' } }, { order, evidence }, identity));
  assert.throws(() => prepareInvestigationProposal({ ...valid, source: 'anthropic' }, { order, evidence }, identity));
  const f = fixture({ capabilities: p.capabilities, async proposeCase(input) { input.order.lines[0].unitAmountMinor = 1; return { ...valid, source: 'openai', amountMinor: 1 }; } }); t.after(() => f.service.close());
  await assert.rejects(f.service.runNext(session)); assert.equal(order.lines[0].unitAmountMinor, 1000); assert.equal(f.item.approval, null);
});
test('hosted runtime uses the selected main analyser and a bounded injected repository transport', async t => {
  const c = controlled('anthropic'), f = fixture(c.providers); t.after(() => f.service.close()); let saved;
  const env = { ...envFor('anthropic'), REFUND_OFFICE_HOSTED: 'enabled', REFUND_OFFICE_WORKING_STORE: 'supabase', REFUND_OFFICE_ENABLED_INTEGRATIONS: 'supabase-runtime,anthropic', SUPABASE_URL: 'https://controlled.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture' };
  const token = `test.${Buffer.from(JSON.stringify({ sub: session.userId, role: 'authenticated', exp: Math.floor(Date.now()/1000) + 3600 })).toString('base64url')}.signature`;
  const service = createHostedRuntime({ env, principal: session, accessToken: token, investigationProviders: c.providers, fetchImpl: async (url, init) => {
    const name = new URL(url).pathname.split('/').at(-1), body = JSON.parse(init.body); assert.equal(new URL(url).hostname, 'controlled.supabase.co');
    if (name === 'refund_runtime_claim_intake') return Response.json(await f.repo.claimIntake());
    if (name === 'refund_runtime_finish_intake') { saved = await f.repo.finishIntake({ proposal: body.p_proposal }); return Response.json(saved); }
    if (name === 'refund_runtime_read_case') return Response.json(saved.case);
    if (name === 'refund_runtime_read_workspace') return Response.json({ ...(await f.repo.readWorkspace()), mode: 'synthetic-only', paymentsEnabled: false });
    assert.fail(name);
  } }); t.after(() => service.close());
  const result = await service.runNext(session); assert.equal(result.case.proposal.source, 'anthropic'); assert.equal(result.case.proposal.provenance.mode, 'controlled-test'); assert.equal(result.case.approval?.state, 'required');
  assert.equal((await service.bootstrap(session)).capabilities.analyser, 'anthropic'); assert.equal(c.calls.length, 1);
});

test('model trace attribution identifies only the proposal as a model operation', async t => {
  const { createLocalObserver } = await import('../server/observability.mjs');
  const c = controlled('openai'), f = fixture(c.providers), observer = createLocalObserver(); t.after(() => f.service.close());
  const service = createRuntimeService({ repositoryForSession: () => f.repo, workerRepository: f.repo, automaticWorker: false, investigationProviders: c.providers, observer }); t.after(() => service.close());
  await service.runNext(session);
  const spans = observer.snapshot().spans, proposal = spans.find(span => span.name === 'refund.investigation.propose');
  assert.equal(proposal.attributes.provider,'openai'); assert.equal(proposal.attributes['span.kind'],'LLM'); assert.equal(proposal.attributes.analyserMode,'controlled-test');
  assert.ok(spans.filter(span => span !== proposal).every(span => span.attributes.provider === 'local'));
  const serialised = JSON.stringify(spans); assert.doesNotMatch(serialised,/fake-local-test|supplied packing record omits|missing item I am claiming/);
});

test('an explicitly identified unfamiliar paraphrase can use a controlled model while several omissions stay unambiguous', async t => {
  const c = controlled('openai'), f = fixture(c.providers, { complaint: 'The only claim I am making concerns the sketchbook; that product was left behind at fulfilment.' }); t.after(() => f.service.close());
  const result = await f.service.runNext(session); assert.equal(result.case.proposedAmountMinor, 1000); assert.equal(result.case.outcome, 'awaiting-approval'); assert.equal(result.case.operationId, null);
});
