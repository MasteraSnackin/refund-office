import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { requireClaudeProofConsent, runClaudeProof, renderClaudeProof } from '../scripts/run-claude-proof.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(join(root, 'work'), { recursive: true });
const env = { REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_ANALYSER: 'anthropic', REFUND_OFFICE_ENABLED_INTEGRATIONS: 'anthropic', REFUND_OFFICE_ANTHROPIC_MODE: 'tools', ANTHROPIC_API_KEY: 'controlled-fixture-key', ANTHROPIC_MODEL: 'controlled-fixture-model' };

test('a key alone cannot start proof; authorisation, provider selection and transport labelling are required', () => {
  const injected = async () => {};
  const good = { env, authorised: true, responseMode: 'controlled-test', fetchImpl: injected };
  assert.doesNotThrow(() => requireClaudeProofConsent(good));
  assert.throws(() => requireClaudeProofConsent({ ...good, authorised: false }), /permission/);
  for (const key of ['REFUND_OFFICE_NETWORK', 'REFUND_OFFICE_ANALYSER', 'REFUND_OFFICE_ENABLED_INTEGRATIONS', 'REFUND_OFFICE_ANTHROPIC_MODE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']) {
    assert.throws(() => requireClaudeProofConsent({ ...good, env: { ...env, [key]: '' } }), key);
  }
  assert.throws(() => requireClaudeProofConsent({ ...good, responseMode: undefined }), /Injected/);
  assert.throws(() => requireClaudeProofConsent({ ...good, fetchImpl: globalThis.fetch }), /Injected/);
});

function controlledTransport({ reject = false } = {}) {
  let calls = 0;
  const dataset = JSON.parse(readFileSync(join(root, 'demo-data/focused-12.json'), 'utf8'));
  return async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages'); assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body); calls++;
    if (reject) return new Response('Private provider body must never be copied into evidence', { status: 401 });
    const first = JSON.parse(body.messages[0].content);
    const order = dataset.orders.find(row => row.id === first.suppliedOrderId);
    const reading = body.messages.length === 1;
    const line = order.lines.find(row => row.ordered > row.packed);
    const ambiguous = order.id.endsWith('O008');
    const content = reading ? [
      { type: 'tool_use', id: `tool-order-${calls}`, name: 'read_order', input: {} },
      { type: 'tool_use', id: `tool-evidence-${calls}`, name: 'read_evidence', input: { ids: first.evidenceCatalogue.map(row => row.id) } },
    ] : [{ type: 'tool_use', id: `tool-result-${calls}`, name: 'submit_recommendation', input: {
      amountMinor: ambiguous ? 0 : (line.ordered - line.packed) * line.unitAmountMinor,
      lineId: ambiguous ? null : line.id, issue: ambiguous ? 'unknown' : 'item_missing',
      reason: ambiguous ? 'The supplied complaint does not identify which omitted item is claimed.' : 'The supplied order price and packing record support this missing item.',
      evidenceIds: ambiguous ? [] : [`order:${order.id}`, `packing:${order.id}`],
    } }];
    return new Response(JSON.stringify({ id: `msg_controlled_${calls}`, model: 'controlled-returned-model', stop_reason: 'tool_use', usage: { input_tokens: 40, output_tokens: 30 }, content }), { headers: { 'request-id': `req_controlled_${calls}` } });
  };
}

test('three controlled investigations persist useful reports without claims of live Claude or financial authority', async t => {
  const base = mkdtempSync(join(root, 'work/claude-proof-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const manifest = await runClaudeProof({ env, authorised: true, outputBase: base, responseMode: 'controlled-test', fetchImpl: controlledTransport() });
  assert.equal(manifest.passed, true); assert.equal(manifest.caseCount, 3);
  assert.equal(manifest.modelRequests, 6); assert.equal(manifest.transport, 'controlled-test'); assert.equal(manifest.liveClaudeRun, false);
  for (const key of ['approvals', 'newOperations', 'paymentAttempts']) assert.equal(manifest[key], 0);
  assert.equal(manifest.persistedReadback, true); assert.equal(manifest.sourceUnchanged, true);
  const saved = JSON.parse(readFileSync(join(manifest.outputDir, 'observed-cases.json'), 'utf8'));
  assert.deepEqual(saved.map(row => row.outcome), ['awaiting-approval', 'held', 'held']);
  assert.deepEqual(saved.map(row => row.proposedAmountMinor), [2000, 2501, 0]);
  const receipts = readFileSync(join(manifest.outputDir, 'receipts.json'), 'utf8');
  assert.doesNotMatch(receipts, /controlled-fixture-key|My parcel|travel mug is missing/);
  const page = readFileSync(join(manifest.outputDir, 'index.html'), 'utf8');
  assert.match(page, /Controlled responses — no real Claude run/);
  assert.match(page, /Readable decision brief/);
  assert.match(readFileSync(join(manifest.outputDir, 'SYN-F12-C001.brief.md'), 'utf8'), /Controlled responses only. No real Claude run occurred/);
  for (const item of saved) assert.equal(item.approval?.state === 'approved', false);
});

test('an authentication failure is retained as a failed proof and stops before further cases or model retries', async t => {
  const base = mkdtempSync(join(root, 'work/claude-proof-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const manifest = await runClaudeProof({ env, authorised: true, outputBase: base, responseMode: 'controlled-test', fetchImpl: controlledTransport({ reject: true }) });
  assert.equal(manifest.passed, false); assert.equal(manifest.modelRequests, 1); assert.equal(manifest.caseCount, 1);
  assert.equal(manifest.liveClaudeRun, false); assert.equal(manifest.approvals, 0); assert.equal(manifest.paymentAttempts, 0);
  assert.doesNotMatch(readFileSync(join(manifest.outputDir, 'receipts.json'), 'utf8'), /Private provider body/);
});

test('proof HTML escapes saved output rather than interpreting record text as markup', () => {
  const page = renderClaudeProof({ transport: 'controlled-test', passed: false }, [{ caseLabel: '<script>bad</script>', checks: [], receipt: {}, summary: '<img src=x onerror=bad>', packetFile: 'safe.json', reportFile: 'safe.md' }]);
  assert.doesNotMatch(page, /<script>|<img/); assert.match(page, /&lt;script&gt;/);
});
