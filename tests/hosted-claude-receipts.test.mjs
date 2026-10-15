import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedHandler } from '../server/hosted-api.mjs';
import { createHostedRuntime } from '../server/hosted-runtime.mjs';
import { createInvestigationProviders } from '../server/investigation-proposal.mjs';

const tenantId = '00000000-0000-4000-8000-000000000012';
const userId = '40000000-0000-4000-8000-000000000001';
const origin = 'https://receipt-fixture.invalid';
const privateText = 'PRIVATE complaint, source and model commentary';
const providerEnv = { REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_ANALYSER: 'anthropic', REFUND_OFFICE_ENABLED_INTEGRATIONS: 'anthropic',
  REFUND_OFFICE_ANTHROPIC_MODE: 'tools', ANTHROPIC_API_KEY: 'controlled-only-token', ANTHROPIC_MODEL: 'claude-controlled-fixture' };
const token = () => `fixture.${Buffer.from(JSON.stringify({ sub: userId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 1800 })).toString('base64url')}.not-a-signature`;
const order = { id: 'SYN-RECEIPT-O1', totalMinor: 2000, lines: [{ id: 'SYN-RECEIPT-L1', name: 'Travel mug', ordered: 1, packed: 0, unitAmountMinor: 2000 }], delivery: { disputed: false } };
const evidence = ['order', 'packing', 'delivery', 'remedies'].map(kind => ({ id: `${kind}:${order.id}`, body: privateText }));

function fixture({ tracing = true, role = 'investigator', authUser = userId, machineActor = userId, empty = false, finishFailure, providerFailure = false, getterFailure = false, transformReceipts, wrongProvider = false, traceFailure = false } = {}) {
  const counts = { model: 0, claim: 0, finish: 0, hold: 0, getter: 0, runtime: 0, trace: 0 };
  const env = new Proxy({ REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_HOSTED: 'enabled', REFUND_OFFICE_WORKING_STORE: 'supabase',
    REFUND_OFFICE_ENABLED_INTEGRATIONS: 'supabase-runtime,anthropic', REFUND_OFFICE_ANALYSER: 'anthropic', REFUND_OFFICE_ANTHROPIC_MODE: 'tools',
    REFUND_OFFICE_PUBLIC_ORIGIN: origin, REFUND_OFFICE_HOSTED_TENANT_ID: tenantId, SUPABASE_URL: 'https://receipt-fixture.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture',
    REFUND_OFFICE_MACHINE_KEY: 'controlled-machine-fixture'.repeat(2), REFUND_OFFICE_MACHINE_USER_ID: machineActor, REFUND_OFFICE_HOSTED_TRACING: tracing ? 'enabled' : 'disabled' }, {
    get(target, key) { assert.notEqual(key, 'ANTHROPIC_API_KEY', 'Receipt exposure must not read a provider secret'); return target[key]; },
  });
  const provider = createInvestigationProviders({ env: providerEnv, responseMode: 'controlled-test', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages'); assert.equal(options.method, 'POST'); counts.model++;
    if (providerFailure) return new Response(privateText, { status: 401 });
    const body = JSON.parse(options.body);
    const content = body.messages.length === 1 ? [
      { type: 'tool_use', id: 'tool_order', name: 'read_order', input: {} },
      { type: 'tool_use', id: 'tool_evidence', name: 'read_evidence', input: { ids: evidence.map(row => row.id) } },
      { type: 'text', text: privateText },
    ] : [{ type: 'tool_use', id: 'tool_submit', name: 'submit_recommendation', input: { amountMinor: 2000, lineId: 'SYN-RECEIPT-L1', issue: 'item_missing', reason: 'Packing confirms the missing mug.', evidenceIds: [`order:${order.id}`, `packing:${order.id}`] } }];
    return Response.json({ id: `msg_fixture_${counts.model}`, model: 'claude-returned-fixture', stop_reason: 'tool_use', usage: { input_tokens: 80, output_tokens: 20 }, content }, { headers: { 'request-id': `req_fixture_${counts.model}` } });
  } });
  const originalReceipts = provider.receipts;
  Object.defineProperty(provider, 'receipts', { get() {
    counts.getter++;
    if (getterFailure) throw new Error(privateText);
    return () => transformReceipts ? transformReceipts(originalReceipts()) : originalReceipts();
  } });
  if (wrongProvider) { const capabilities = provider.capabilities; provider.capabilities = () => ({ ...capabilities(), investigatorMode: undefined }); }
  let item = { id: 'SYN-RECEIPT-C1', caseId: 'RF-1', orderId: order.id, title: 'Missing mug', complaint: 'The travel mug is missing.', revision: 1, status: 'ready', stage: 'reception',
    proposedAmountMinor: 0, approval: null, receipt: null, operationId: null, intakeRequestId: 'request-receipt-1', evidence, events: [], checks: [] };
  const request = () => ({ id: 'request-receipt-1', caseId: item.id, orderId: order.id, fence: 1, status: item.outcome || 'queued' });
  const fetchImpl = async (url, init = {}) => {
    assert.equal(new URL(url).hostname, 'receipt-fixture.supabase.co', 'All hosted transport is controlled; no network fetch is used');
    const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : {};
    if (path === '/auth/v1/user') return Response.json({ id: authUser, is_anonymous: false });
    if (path.endsWith('refund_runtime_session_context')) return Response.json({ tenantId, userId, role, synthetic: true, title: 'Controlled synthetic workspace' });
    if (path.endsWith('refund_runtime_claim_intake')) {
      counts.claim++;
      if (empty) return Response.json(null);
      item = { ...item, status: 'running', stage: 'policy', revision: 2 };
      return Response.json({ requestId: 'request-receipt-1', caseId: item.id, fence: 1, leaseUntil: new Date(Date.now() + 30000).toISOString(), case: item, order, evidence, policy: { version: 1, limitMinor: 2500 } });
    }
    if (path.endsWith('refund_runtime_finish_intake')) {
      counts.finish++;
      if (finishFailure === 'uncertain') throw new Error(privateText);
      if (finishFailure === 'conflict') return Response.json({ code: '40001', message: privateText }, { status: 409 });
      item = { ...item, revision: 3, status: 'paused', stage: 'review', outcome: 'awaiting-approval', proposedAmountMinor: 2000, proposal: body.p_proposal };
      return Response.json({ case: item, request: request() });
    }
    if (path.endsWith('refund_runtime_fail_intake')) {
      counts.hold++; item = { ...item, revision: 3, status: 'paused', stage: 'review', outcome: 'held' };
      return Response.json({ case: item, request: { ...request(), status: 'error', lastError: body.p_error_code } });
    }
    if (path.endsWith('refund_runtime_read_case')) return Response.json(item);
    assert.fail(`No approval, payment or other provider route is permitted: ${path}`);
  };
  const handler = createHostedHandler({ env, fetchImpl, runtimeFactory: options => {
    counts.runtime++;
    const runtime = createHostedRuntime({ ...options, investigationProviders: provider });
    if (traceFailure) runtime.recordedTrace = () => { counts.trace++; throw new Error(privateText); };
    return runtime;
  } });
  const call = ({ key = env.REFUND_OFFICE_MACHINE_KEY, method = 'POST', body = {}, headers = {}, path = '/api/machine/investigate' } = {}) => handler(new Request(origin + path, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}`, 'x-refund-machine-key': key, ...headers }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }));
  return { call, counts, env, provider, get item() { return item; } };
}

test('authenticated machine investigation returns strictly selected execution metadata alongside separately saved case and trace', async () => {
  const f = fixture({ transformReceipts: rows => {
    for (const row of rows) {
      Object.defineProperty(row, 'rawResponse', { get() { assert.fail('Unknown receipt fields must never be read'); } });
      row.customerStatement = privateText; row.requests[0].prompt = privateText; row.tools[0].input = { complaint: privateText };
    }
    return rows;
  } });
  const response = await f.call(), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.case.outcome, 'awaiting-approval'); assert.equal(body.readbackVerified, true);
  const metadata = body.recordedInvestigationReceipts, receipt = metadata.receipts[0];
  assert.equal(metadata.scope, 'request'); assert.equal(metadata.durable, false); assert.equal(metadata.uploaded, false);
  assert.equal(metadata.executionMetadataOnly, true); assert.equal(metadata.establishesSavedCase, false); assert.equal(metadata.incomplete, false);
  assert.equal(receipt.transport, 'controlled-test'); assert.equal(receipt.status, 'completed'); assert.equal(receipt.validation, 'passed');
  assert.deepEqual(receipt.requests.map(row => row.requestId), ['req_fixture_1', 'req_fixture_2']);
  assert.deepEqual(receipt.tools.map(row => row.name), ['read_order', 'read_evidence', 'submit_recommendation']);
  assert.deepEqual(receipt.usage, { inputTokens: 160, outputTokens: 40, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
  assert.equal(body.recordedTrace.recordingAvailable, true); assert.equal(body.recordedTrace.spans.length, 4);
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE|rawResponse|customerStatement|prompt|controlled-only-token|complaint/);
  assert.equal(f.counts.claim, 1); assert.equal(f.counts.finish, 1); assert.equal(f.counts.model, 2);
  assert.equal(f.item.approval, null); assert.equal(f.item.operationId, null); assert.equal(f.item.receipt, null);
});

test('trace opt-in and selected bounded tool identity are checked before accessing provider receipt getter', async () => {
  for (const options of [{ tracing: false, getterFailure: true }, { wrongProvider: true, getterFailure: true }]) {
    const f = fixture(options), response = await f.call(), body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.recordedInvestigationReceipts, undefined); assert.equal(f.counts.getter, 0);
    if (options.tracing === false) assert.equal(body.recordedTrace, undefined);
    assert.equal(f.counts.model, 2); assert.equal(f.counts.finish, 1);
  }
});

for (const finishFailure of ['conflict', 'uncertain']) test(`failed SQL ${finishFailure} retains original error and never treats model completion as a saved case`, async () => {
  const f = fixture({ finishFailure }), response = await f.call(), body = await response.json();
  const withoutTrace = fixture({ finishFailure, tracing: false }), original = await withoutTrace.call(), originalBody = await original.json();
  assert.equal(response.status, original.status); assert.deepEqual(body.error, originalBody.error);
  assert.equal(body.error.uncertain, finishFailure === 'uncertain'); assert.equal(body.case, undefined);
  const metadata = body.recordedInvestigationReceipts;
  assert.equal(metadata.receipts[0].status, 'completed'); assert.equal(metadata.establishesSavedCase, false); assert.equal(metadata.executionMetadataOnly, true);
  assert.equal(body.recordedTrace.recordingAvailable, true); assert.ok(body.recordedTrace.spans.some(row => row.status === 'ERROR'));
  assert.equal(f.counts.model, 2); assert.equal(f.counts.claim, 1); assert.equal(f.counts.finish, 1); assert.equal(f.counts.hold, 1);
  assert.equal(f.item.approval, null); assert.equal(f.item.operationId, null); assert.equal(f.item.receipt, null);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE|controlled-only-token/);
});

test('provider rejection returns its failed metadata without retrying the investigation', async () => {
  const f = fixture({ providerFailure: true }), response = await f.call(), body = await response.json();
  assert.equal(response.status, 500); assert.equal(body.error.code, 'hosted_internal_error');
  assert.equal(body.recordedInvestigationReceipts.receipts[0].status, 'failed');
  assert.equal(body.recordedInvestigationReceipts.receipts[0].errorCode, 'anthropic_http_401');
  assert.equal(f.counts.model, 1); assert.equal(f.counts.claim, 1); assert.equal(f.counts.finish, 0); assert.equal(f.counts.hold, 1);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE|controlled-only-token/);
});

test('failed metadata getters cannot repeat work or mask a completed result or original SQL error', async () => {
  for (const finishFailure of [undefined, 'uncertain']) {
    const f = fixture({ getterFailure: true, traceFailure: true, finishFailure }), response = await f.call(), body = await response.json();
    assert.equal(response.status, finishFailure ? 503 : 200);
    if (finishFailure) assert.equal(body.error.code, 'hosted_write_unresolved'); else assert.equal(body.case.outcome, 'awaiting-approval');
    assert.equal(body.recordedTrace, undefined); assert.equal(body.recordedInvestigationReceipts.recordingAvailable, false);
    assert.equal(body.recordedInvestigationReceipts.incomplete, true); assert.deepEqual(body.recordedInvestigationReceipts.receipts, []);
    assert.equal(f.counts.model, 2); assert.equal(f.counts.finish, 1); assert.equal(f.counts.trace, 1);
    assert.equal(f.counts.getter, 1);
    assert.doesNotMatch(JSON.stringify({ error: body.error, metadata: body.recordedInvestigationReceipts }), /PRIVATE/);
  }
});

test('unauthenticated, wrong-identity, reviewer, forged-origin and invalid-body callers cannot read receipts', async () => {
  for (const [options, input, status] of [
    [{}, { key: 'bad' }, 401],
    [{ authUser: '90000000-0000-4000-8000-000000000001' }, {}, 401],
    [{ machineActor: '90000000-0000-4000-8000-000000000001' }, {}, 403],
    [{ role: 'reviewer' }, {}, 403],
    [{}, { headers: { origin } }, 403],
    [{}, { body: { caseId: 'SYN-RECEIPT-C1' } }, 400],
    [{}, { method: 'GET' }, 405],
  ]) {
    const f = fixture({ ...options, getterFailure: true }), response = await f.call(input), body = await response.json();
    assert.equal(response.status, status); assert.equal(body.recordedInvestigationReceipts, undefined); assert.equal(body.recordedTrace, undefined);
    assert.equal(f.counts.getter, 0); assert.equal(f.counts.model, 0); assert.equal(f.counts.claim, 0);
  }
});

test('an empty authenticated queue has no invented provider receipts or completed investigation spans', async () => {
  const f = fixture({ empty: true }), response = await f.call(), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.empty, true);
  assert.deepEqual(body.recordedInvestigationReceipts.receipts, []); assert.equal(body.recordedInvestigationReceipts.incomplete, false);
  assert.deepEqual(body.recordedTrace.spans, []); assert.equal(f.counts.model, 0); assert.equal(f.counts.claim, 1); assert.equal(f.counts.finish, 0);
});

test('malformed, oversized and accessor metadata is dropped without serialising arbitrary content', async () => {
  for (const transformReceipts of [
    rows => { rows[0].requests.push(...Array(4).fill(rows[0].requests[0])); return rows; },
    rows => { rows[0].tools.push(...Array(12).fill(rows[0].tools[0])); return rows; },
    rows => { rows[0].configuredModel = 'https://private.invalid'; return rows; },
    rows => { Object.defineProperty(rows[0], 'inputHash', { get() { assert.fail('Receipt accessors must not execute'); } }); return rows; },
    rows => { rows[0].id = { toString() { assert.fail('Receipt objects must not be coerced'); } }; return rows; },
    rows => [rows[0], rows[0]],
  ]) {
    const f = fixture({ transformReceipts }), response = await f.call(), body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.case.outcome, 'awaiting-approval');
    assert.equal(body.recordedInvestigationReceipts.incomplete, true); assert.deepEqual(body.recordedInvestigationReceipts.receipts, []);
    assert.equal(f.counts.model, 2); assert.equal(f.counts.finish, 1);
  }
});
