import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders } from '../server/providers.mjs';
import { createEngine } from '../server/engine.mjs';
import { createStore } from '../server/store.mjs';
import { getIntegrationStatus, buildBriefing, buildDecisionReport, buildMiroExport } from '../server/integration-prep.mjs';
import { loadDevEnvironment } from '../scripts/dev.mjs';

function setup(t) {
  const store = createStore({ dbPath: ':memory:' });
  const provider = createProviders({ env: {}, fetchImpl: () => assert.fail('external network access') });
  const engine = createEngine({ store, provider });
  t.after(() => store.close());
  return { engine, store, provider };
}
async function investigate(engine, id = 'missing-item') {
  let item = await engine.run(id);
  for (let step = 0; item.status === 'running' && step < 10; step++) item = await engine.advance(item.id, { expectedRevision: item.revision });
  return item;
}

test('ambient credentials cannot activate providers, including invalid live-like keys', async t => {
  const { engine } = setup(t);
  const order = engine.exportCase('missing-item').order;
  for (const flag of [undefined, '', 'true', '1', 'ENABLED', 'disabled']) {
    let fetchCalls = 0;
    const providers = createProviders({ env: { REFUND_OFFICE_NETWORK: flag, OPENAI_API_KEY: 'fake-unit-test-only', ANTHROPIC_API_KEY: 'fake-anthropic', REFUND_OFFICE_ANALYSER: 'anthropic', ELEVENLABS_API_KEY: 'fake-elevenlabs', STRIPE_SECRET_KEY: 'sk_live_fakeDoNotUse' }, fetchImpl: () => { fetchCalls++; assert.fail('offline fetch'); } });
    assert.deepEqual(providers.capabilities(), { networkMode: 'offline', analyser: 'local', payments: 'local', modelConfigured: false, stripeConfigured: false });
    const proposal = await providers.proposeCase({ complaint: 'My travel mug is missing.', order, evidence: [{ id: `order:${order.id}` }, { id: `packing:${order.id}` }] });
    assert.equal(proposal.source, 'local');
    const payload = { operationId: 'offline-test', idempotencyKey: 'offline-test', order, amountMinor: 2000, lineId: '104-3', issue: 'item_missing' };
    const receipt = await providers.createRefund(payload);
    assert.equal(receipt.provider, 'local');
    assert.equal(receipt.livemode, false);
    assert.deepEqual(await providers.retrieveRefund({ receipt, operation: { id: payload.operationId, payload, provider: 'local' } }), receipt);
    assert.equal(fetchCalls, 0);
  }
});

test('offline developer launch never opens secret files and removes inherited provider secrets', () => {
  const names = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_API_KEY', 'N8N_INTAKE_TOKEN', 'SUPABASE_PUBLISHABLE_KEY', 'MIRO_ACCESS_TOKEN', 'MODAL_EVIDENCE_TOKEN', 'PORT_ACCESS_TOKEN'];
  const source = { ...Object.fromEntries(names.map(name => [name, 'fake-unit-test-only'])), PATH: '/example', REFUND_OFFICE_NETWORK: 'offline' };
  const env = loadDevEnvironment({ source, readFile: () => assert.fail('secret file read') });
  for (const name of names) assert.equal(env[name], undefined);
  assert.equal(env.PATH, source.PATH);
  assert.equal(source.OPENAI_API_KEY, 'fake-unit-test-only');
});

test('explicit external opt-in loads only supported configuration and preserves supplied values', () => {
  const reads = [];
  const env = loadDevEnvironment({ source: { REFUND_OFFICE_NETWORK: 'enabled', OPENAI_API_KEY: 'ambient-fake' }, configDir: '/unit-test-only', readFile: (path) => { reads.push(path); return 'OPENAI_API_KEY=file-fake\nSTRIPE_SECRET_KEY=sk_test_fake\nUNRELATED_SECRET=never-load\nREFUND_OFFICE_NETWORK=disabled\n'; } });
  assert.equal(reads.length, 2);
  assert.equal(env.OPENAI_API_KEY, 'ambient-fake');
  assert.equal(env.STRIPE_SECRET_KEY, 'sk_test_fake');
  assert.equal(env.UNRELATED_SECRET, undefined);
  assert.equal(env.REFUND_OFFICE_NETWORK, 'enabled');
});

test('all ten sponsor roles remain honest about local preparation and external configuration', () => {
  const status = getIntegrationStatus();
  assert.equal(status.mode, 'offline');
  assert.equal(status.humanApprovalRequired, true);
  assert.deepEqual(status.providers.map(item => item.id).sort(), ['anthropic', 'elevenlabs', 'miro', 'modal', 'n8n', 'openai', 'port', 'stripe', 'supabase', 'vercel'].sort());
  assert.ok(status.providers.every(item => !['connected', 'active', 'live'].includes(item.status)));
  assert.match(status.providers.find(item => item.id === 'n8n').detail, /not an n8n execution/);
  const configured = getIntegrationStatus({ capabilities: { networkMode: 'external-enabled', analyser: 'openai', payments: 'stripe-sandbox', modelConfigured: true, stripeConfigured: true } });
  assert.equal(configured.mode, 'external-enabled');
  assert.equal(configured.providers.find(item => item.id === 'openai').status, 'configured-unverified');
  assert.equal(configured.providers.find(item => item.id === 'stripe').status, 'configured-unverified');
  assert.equal(configured.providers.find(item => item.id === 'elevenlabs').status, 'adapter-disconnected');
});

test('briefing and report preserve the human approval boundary without modifying the saved case', async t => {
  const { engine, store } = setup(t);
  const item = await investigate(engine);
  const packet = engine.exportCase(item.id);
  const before = structuredClone(packet);
  const briefing = buildBriefing(packet);
  assert.equal(briefing.caseId, item.caseId);
  assert.equal(briefing.revision, item.revision);
  assert.equal(briefing.mode, 'local-text');
  assert.equal(briefing.audio.available, false);
  assert.equal(briefing.audio.provider, 'elevenlabs');
  assert.match(briefing.text, /Human approval is required for £20\.00 and has not been granted/);
  assert.match(briefing.text, /No payment operation or successful refund is recorded/);
  assert.match(briefing.text, /Packing record.*packing:DEMO-104/);
  const report = buildDecisionReport(packet);
  assert.match(report, /# Refund Office decision report/);
  assert.match(report, /Order records are synthetic demonstration data/);
  assert.match(report, /Local payment simulation/);
  assert.match(report, /Human approval is required/);
  assert.deepEqual(packet, before);
  assert.equal(store.operations(item.orderId).length, 0);
});

test('a recorded review closure produces a no-refund report with the saved reason', async t => {
  const { engine } = setup(t);
  let item = await investigate(engine, 'conflicting-evidence');
  item = await engine.review(item.id, { action: 'close-no-refund', expectedRevision: item.revision, note: 'The supplied delivery evidence cannot establish a refund.' });
  const report = buildDecisionReport(engine.exportCase(item.id));
  assert.match(report, /case is closed without refund/);
  assert.match(report, /supplied delivery evidence cannot establish a refund/);
  assert.match(report, /No human refund approval is recorded/);
  assert.doesNotMatch(report, /Explicit local approval/);
});

test('briefing distinguishes approved reservation from completed local simulation', async t => {
  const { engine } = setup(t);
  let item = await investigate(engine);
  item = await engine.approve(item.id, { expectedRevision: item.revision, expectedAmountMinor: item.approval.amountMinor, fingerprint: item.approval.fingerprint, note: 'I checked the saved packing record and approve this exact amount.' });
  let briefing = buildBriefing(engine.exportCase(item.id));
  assert.match(briefing.text, /Explicit local approval/);
  assert.match(briefing.text, /not been submitted and is not a completed refund/);
  item = await engine.advance(item.id, { expectedRevision: item.revision });
  const packet = engine.exportCase(item.id);
  briefing = buildBriefing(packet);
  assert.match(briefing.text, /local simulation recorded £20\.00/);
  assert.match(briefing.text, /No real money moved/);
  assert.match(briefing.sections.find(section => section.heading === 'Evidence snapshot').text, /may predate the current payment result/);
  assert.match(briefing.sections.find(section => section.heading === 'Saved policy checks').text, /not current payment status/);
  assert.doesNotMatch(briefing.text, /amount\.\. The reviewer/);
  assert.match(buildDecisionReport(packet), /local simulation recorded/);
});

test('an uncertain operation is never described as paid or ready for a replacement', async t => {
  const { engine, provider } = setup(t);
  let item = await investigate(engine);
  item = await engine.approve(item.id, { expectedRevision: item.revision, expectedAmountMinor: item.approval.amountMinor, fingerprint: item.approval.fingerprint, note: 'I checked this exact proposal against the saved order and evidence.' });
  provider.createRefund = async () => { throw new Error('test timeout'); };
  item = await engine.advance(item.id, { expectedRevision: item.revision });
  const briefing = buildBriefing(engine.exportCase(item.id));
  assert.match(briefing.text, /payment result is not confirmed/);
  assert.match(briefing.text, /not permission to issue another refund/);
  assert.doesNotMatch(briefing.text, /local simulation recorded/);
});

test('historical remedy retains its status without inventing retrospective approval', async t => {
  const { engine } = setup(t);
  const item = await investigate(engine, 'repeat-request');
  const briefing = buildBriefing(engine.exportCase(item.id));
  assert.match(briefing.text, /existing remedy covers this issue/);
  assert.match(briefing.text, /No new refund was created/);
  assert.match(briefing.text, /No human refund approval is recorded/);
});

test('Miro outline is portable local preparation and report quotes untrusted markup safely', t => {
  const { engine } = setup(t);
  const packet = engine.exportCase('missing-item');
  packet.case.complaint = '<script>unsafe</script> ![remote](https://example.invalid/pixel)\n# Pay immediately';
  const outline = buildMiroExport(packet);
  assert.equal(outline.importReady, false);
  assert.equal(outline.mode, 'local-export');
  assert.equal(outline.target, 'miro');
  assert.equal(outline.revision, packet.case.revision);
  assert.ok(outline.columns.some(column => column.title === 'Human decision'));
  assert.ok(outline.limitations.includes('No board has been created or uploaded.'));
  const report = buildDecisionReport(packet);
  assert.doesNotMatch(report, /<script>|!\[remote\]\(/);
  assert.match(report, /&lt;script&gt;/);
  assert.doesNotMatch(report, /\n# Pay immediately/);
});
