import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaseAnalysis } from '../server/case-analysis.mjs';

const principal = { userId: '00000000-0000-4000-8000-000000000001', tenantId: '00000000-0000-4000-8000-000000000012', role: 'reviewer' };
const packet = { tenantId: principal.tenantId, case: { id: 'C1', orderId: 'O1', revision: 3, complaint: 'The mug is missing.', evidence: [{ id: 'packing:O1', title: 'Packing record', body: 'One mug missing', source: 'Synthetic catalogue' }] },
  order: { id: 'O1', totalMinor: 2000, currency: 'gbp', lines: [{ id: 'mug', name: 'mug', ordered: 1, packed: 0, unitAmountMinor: 2000 }] } };
const proposal = { amountMinor: 2000, lineId: 'mug', issue: 'item_missing', reason: 'The saved packing record omits one mug.', evidenceIds: ['packing:O1'] };
const online = { REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_ENABLED_INTEGRATIONS: 'openai,anthropic', REFUND_OFFICE_ANALYSER: 'openai', REFUND_OFFICE_CHALLENGER: 'anthropic', OPENAI_API_KEY: 'dummy-openai', OPENAI_MODEL: 'fixture-model', ANTHROPIC_API_KEY: 'dummy-anthropic', ANTHROPIC_MODEL: 'fixture-model' };
function fakeFetch(calls, second = proposal) {
  return async (url, request) => { calls.push({ url, request }); return new Response(JSON.stringify(url.includes('anthropic')
    ? { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(second) }] }
    : { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }] }), { status: 200 }); };
}
test('offline analysis ignores credentials and performs only the real local rule check', async () => {
  const env = new Proxy({ REFUND_OFFICE_NETWORK: 'offline' }, { get(target, key) { if (String(key).includes('KEY')) throw Error('Secret read'); return target[key]; } });
  const before = JSON.stringify(packet); const analysis = createCaseAnalysis({ env, getPacket: async () => packet, fetchImpl: () => { throw Error('Outbound forbidden'); } });
  const result = await analysis.run(principal, 'C1', { expectedRevision: 3 });
  assert.equal(result.mode, 'local-rules'); assert.equal(result.primary.proposal.source, 'local'); assert.equal(result.primary.supportedBySnapshot, true);
  assert.equal(result.challenger, null); assert.equal(result.comparison, 'not-requested'); assert.equal(result.changesSavedCase, false); assert.equal(JSON.stringify(packet), before);
});
test('explicit provider allowlist is required before any provider can be selected', () => {
  assert.throws(() => createCaseAnalysis({ env: { ...online, REFUND_OFFICE_ENABLED_INTEGRATIONS: 'openai' }, getPacket: async () => packet }), error => error.code === 'analysis_disconnected');
});
test('primary and independent challenger compare actual returned conclusions with no authority', async () => {
  const calls = []; const analysis = createCaseAnalysis({ env: online, getPacket: async () => packet, fetchImpl: fakeFetch(calls, { ...proposal, amountMinor: 1000 }) });
  const result = await analysis.run(principal, 'C1', { expectedRevision: 3 });
  assert.equal(calls.length, 2); assert.equal(result.comparison, 'disagreement'); assert.equal(result.challenger.supportedBySnapshot, false); assert.equal(result.needsHumanReview, true);
  const input1 = JSON.parse(JSON.parse(calls[0].request.body).input[0].content);
  const input2 = JSON.parse(JSON.parse(calls[1].request.body).messages[0].content);
  assert.deepEqual(input1, input2); assert.equal(input1.complaint, packet.case.complaint); assert.equal(input2.proposal, undefined);
  assert.equal(result.events.length, 2); assert.equal(result.advisoryOnly, true);
});
test('unknown citations cannot pass even when both models agree on the amount', async () => {
  const analysis = createCaseAnalysis({ env: online, getPacket: async () => packet, fetchImpl: fakeFetch([], { ...proposal, evidenceIds: ['fabricated'] }) });
  const result = await analysis.run(principal, 'C1', { expectedRevision: 3 });
  assert.equal(result.comparison, 'agreement'); assert.equal(result.challenger.checks.referencesKnown, false); assert.equal(result.challenger.supportedBySnapshot, false);
});
test('failed models are labelled unavailable without fallback or leaked remote details', async () => {
  const analysis = createCaseAnalysis({ env: online, getPacket: async () => packet, fetchImpl: async () => { throw Error('secret remote details'); } });
  const result = await analysis.run(principal, 'C1', { expectedRevision: 3 });
  assert.equal(result.comparison, 'incomplete'); assert.equal(result.primary.unavailable, true); assert.equal(result.challenger.unavailable, true);
  assert.doesNotMatch(JSON.stringify(result), /secret remote/);
});
test('tenant, role, revision and caller-supplied facts are checked before model access', async () => {
  let calls = 0; const analysis = createCaseAnalysis({ env: online, getPacket: async () => packet, fetchImpl: async () => { calls++; throw Error(); } });
  for (const [who, body, code] of [[{ ...principal, role: 'payment-executor' }, { expectedRevision: 3 }, 'analysis_access_denied'],
    [{ ...principal, tenantId: '00000000-0000-4000-8000-000000000013' }, { expectedRevision: 3 }, 'analysis_access_denied'],
    [principal, { expectedRevision: 2 }, 'analysis_stale_case'], [principal, { expectedRevision: 3, complaint: 'forged' }, 'invalid_analysis_input']]) {
    await assert.rejects(analysis.run(who, 'C1', body), error => error.code === code);
  }
  assert.equal(calls, 0);
});
test('a changed saved snapshot cannot produce a current advisory result', async () => {
  let reads = 0; const analysis = createCaseAnalysis({ getPacket: async () => { const copy = structuredClone(packet); if (++reads > 1) copy.case.evidence[0].body = 'changed'; return copy; } });
  await assert.rejects(analysis.run(principal, 'C1', { expectedRevision: 3 }), error => error.code === 'analysis_stale_case');
});
