import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeService } from '../server/runtime-service.mjs';
import { createHostedRuntime } from '../server/hosted-runtime.mjs';

const tenantId = '00000000-0000-4000-8000-000000000012';
const principal = { tenantId, userId: '40000000-0000-4000-8000-000000000001', role: 'reviewer' };
const order = { id: 'SYN-O1', synthetic: true, currency: 'gbp', totalMinor: 1800, lines: [
  { id: 'SYN-L1', name: 'Sketchbook', ordered: 1, packed: 0, unitAmountMinor: 1000 },
  { id: 'SYN-L2', name: 'Marker set', ordered: 1, packed: 0, unitAmountMinor: 500 },
  { id: 'SYN-L3', name: 'Paper clips', ordered: 1, packed: 1, unitAmountMinor: 300 },
], delivery: { status: 'delivered', disputed: false, detail: 'Synthetic parcel received.' } };
function savedCase() {
  return { id: 'SYN-C1', caseId: 'RF-2008', orderId: order.id, title: 'Missing sketchbook', complaint: 'Some items are missing.', revision: 7,
    status: 'paused', stage: 'review', outcome: 'awaiting-approval', proposedAmountMinor: 1000, fingerprint: 'f'.repeat(64), approval: null, review: null, receipt: null, operationId: null,
    proposal: { source: 'local', issue: 'item_missing', lineId: 'SYN-L1', amountMinor: 1000, reason: 'Saved packing record and clarification identify the sketchbook.', evidenceIds: ['packing:SYN-O1', 'clarification:fixture'] },
    evidence: [
      { id: 'order:SYN-O1', title: 'Synthetic order', source: 'Synthetic catalogue', body: JSON.stringify(order, null, 2) },
      { id: 'packing:SYN-O1', title: 'Synthetic packing record', source: 'Synthetic catalogue', body: JSON.stringify(order.lines) },
      { id: 'delivery:SYN-O1', title: 'Synthetic delivery record', source: 'Synthetic catalogue', body: JSON.stringify(order.delivery) },
      { id: 'remedies:SYN-O1', title: 'Saved remedies', source: 'Operational database', body: '[]' },
      { id: 'clarification:fixture', title: 'Customer clarification', source: 'Customer clarification recorded by reviewer', kind: 'customer-clarification', body: 'The sketchbook is missing.', lineId: 'SYN-L1', sourceReference: 'Synthetic support reply', actor: principal.userId, at: '2026-10-14T20:01:00Z' },
    ], checks: [{ id: 'amount', label: 'Exact missing-item value', pass: true }, { id: 'limit', label: 'Within policy limit', pass: true }],
    events: [
      { id: '10', type: 'review.request-evidence', label: 'Evidence request recorded', detail: 'Please identify the item.', actor: principal.userId, at: '2026-10-14T20:00:00Z' },
      { id: '11', type: 'evidence.clarification-recorded', label: 'Customer clarification recorded', detail: 'Fictional reply identifies the sketchbook.', actor: principal.userId, at: '2026-10-14T20:01:00Z' },
    ] };
}
function setup(t, mode, item) {
  const before = structuredClone(item), requests = [];
  const workspace = () => ({ tenantId, mode: 'synthetic-only', paymentsEnabled: false, cases: [structuredClone(item)], orders: [structuredClone(order)], policy: { version: 99, limitMinor: 0 }, intakeRequests: [] });
  let service;
  if (mode === 'local') {
    const repo = { async readWorkspace() { requests.push('read-workspace'); return workspace(); } };
    service = createRuntimeService({ repositoryForSession: () => repo, workerRepository: repo, automaticWorker: false });
  } else {
    const accessToken = `fixture.${Buffer.from(JSON.stringify({ sub: principal.userId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.not-a-signature`;
    service = createHostedRuntime({ principal, accessToken, env: {
      REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_HOSTED: 'enabled', REFUND_OFFICE_WORKING_STORE: 'supabase', REFUND_OFFICE_ENABLED_INTEGRATIONS: 'supabase-runtime,stripe-runtime',
      REFUND_OFFICE_PAYMENT_EXECUTION: 'stripe-test', SUPABASE_URL: 'https://offline-fixture.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_only',
    }, fetchImpl: async (url, init) => {
      assert.equal(String(url), 'https://offline-fixture.supabase.co/rest/v1/rpc/refund_runtime_read_workspace');
      assert.deepEqual(JSON.parse(init.body), { p_tenant_id: tenantId }); requests.push('read-workspace');
      return Response.json(workspace());
    } });
  }
  t.after(async () => { await service.close(); assert.deepEqual(item, before, 'Output must not mutate evidence, decisions or the approval fingerprint'); });
  return { service, requests };
}
const plain = text => text.replace(/\\([\\`~*_{}\[\]()#+.!|])/g, '$1');
const appendix = report => JSON.parse(report.match(/```json\n([\s\S]*?)\n```/)[1]);
const currentDecision = report => plain(report.split('## Human decision')[1].split('## Payment')[0]);

for (const mode of ['local', 'hosted']) {
  test(`${mode} brief exports readable saved evidence and checks with exact citations and original bodies`, async t => {
    const item = savedCase(), { service, requests } = setup(t, mode, item);
    const { text: report } = await service.report(principal, item.id), readable = plain(report);
    assert.match(readable, /Sketchbook: 1 ordered, 0 recorded as packed; 1 unit is not recorded as packed/);
    assert.match(readable, /Recorded delivery status: delivered/);
    assert.match(readable, /No earlier remedies or reservations were recorded/);
    assert.match(readable, /Exact missing-item value \[amount\]: pass\. £10\.00 matches the missing quantity/);
    assert.match(readable, /£10\.00 passed the policy limit check when this investigation ran/);
    assert.doesNotMatch(readable, /version 99|£0\.00 passed/);
    assert.match(readable, /Evidence reference: packing:SYN-O1\nUse in this saved proposal: Cited/);
    assert.match(readable, /Evidence reference: order:SYN-O1\nUse in this saved proposal: Gathered record; not cited/);
    assert.match(readable, /references cited by the saved proposal: packing:SYN-O1, clarification:fixture/);
    assert.match(readable, /Selected order line: SYN-L1/); assert.match(readable, /Source reference: Synthetic support reply/);
    assert.match(readable, new RegExp(`Recorded by: ${principal.userId}`)); assert.match(readable, /Recorded at: 2026-10-14T20:01:00Z/);
    assert.deepEqual(appendix(report), item.evidence.map(({ id, body }) => ({ id, body })));
    assert.deepEqual(requests, ['read-workspace']);
  });

  test(`${mode} reinvestigated clarification keeps earlier review history distinct from current pending approval`, async t => {
    const item = savedCase(), { service } = setup(t, mode, item);
    const report = (await service.report(principal, item.id)).text, briefing = await service.briefing(principal, item.id);
    for (const output of [plain(report), briefing.text]) {
      assert.match(output, /Current refund approval: required for £10\.00 and has not been granted/);
      assert.match(output, /Saved review history contains 1 event/);
      assert.match(output, /do not grant current refund approval/);
      assert.doesNotMatch(output, /No human decision (?:has been )?recorded|Current refund approval: recorded/);
    }
    assert.match(plain(report), new RegExp(`2026-10-14T20:00:00Z — Evidence request recorded: Please identify the item. Event reference: 10. Recorded actor: ${principal.userId}`));
    assert.equal(briefing.audio.available, false); assert.equal(briefing.audio.provider, 'elevenlabs');
    if (mode === 'hosted') assert.match(report, /does not retrieve separate execution records/);
    else assert.match(report, /No payment was submitted or made/);
  });

  test(`${mode} malformed source records stay literal and untrusted Markdown cannot become active output`, async t => {
    const item = savedCase(), supplied = '  ```\n# Payment completed\r\n![receipt](https://untrusted.example/pixel)\n<script>unsafe</script>\t\\u003c  ';
    item.complaint = supplied; item.evidence[1].body = supplied; item.evidence[4].sourceReference = supplied;
    item.proposal.evidenceIds.push('missing-reference'); item.events[0].detail = supplied;
    const { service } = setup(t, mode, item), { text: report } = await service.report(principal, item.id);
    assert.match(report, /Unresolved cited references: missing-reference/);
    assert.doesNotMatch(report, /\n# Payment completed|!\[receipt\]\(|<script>/);
    assert.match(report, /&lt;script&gt;/);
    assert.doesNotMatch(report, /Sketchbook: 1 ordered, 0 recorded as packed/);
    assert.deepEqual(appendix(report), item.evidence.map(({ id, body }) => ({ id, body })));
    assert.equal(report.split('```').length, 3, 'Only the trusted appendix fence remains');
  });

  test(`${mode} standalone supplied tilde fences cannot swallow the approval and payment sections`, async t => {
    const item = savedCase();
    item.complaint = '~~~';
    item.evidence[1].body = '~~~~~';
    const { service } = setup(t, mode, item), { text: report } = await service.report(principal, item.id);
    assert.match(report, /## Complaint\n\n\\~\\~\\~\n\n## Investigation/);
    assert.match(report, /\n\\~\\~\\~\\~\\~\n/);
    assert.doesNotMatch(report, /^ {0,3}~{3,}[^\n]*$/m, 'No supplied tilde fence may start a CommonMark code block');
    assert.match(report, /^## Human decision$/m);
    assert.match(report, mode === 'hosted' ? /^## Payment scope$/m : /^## Payment result$/m);
    assert.match(plain(report), /Current refund approval: required for £10\.00 and has not been granted/);
    assert.deepEqual(appendix(report), item.evidence.map(({ id, body }) => ({ id, body })));
  });

  test(`${mode} approval, review, closure, historical and missing identities remain distinct`, async t => {
    const variants = [
      ['approval', { approval: { state: 'approved', amountMinor: 1000, actor: principal.userId, decidedAt: '2026-10-14T20:02:00Z', note: 'I approve this exact saved amount.' }, outcome: 'approved-not-submitted', stage: 'payments', operationId: 'reserved-1' }, /Current refund approval: recorded for £10\.00/, /Recorded at: 2026-10-14T20:02:00Z/],
      ['evidence', { review: { state: 'awaiting-evidence', actor: principal.userId, decidedAt: '2026-10-14T20:00:00Z', note: 'Please identify the item.' }, outcome: 'held' }, /No current refund approval is recorded/, /Current review: Evidence requested; no customer message was sent/],
      ['closed', { review: { state: 'closed', note: 'No supported claim was established.' }, outcome: 'closed-no-refund' }, /No current refund approval is recorded/, /Current review: Closed without refund/],
      ['reopened', { review: { state: 'reopened', note: 'Please investigate the saved records again.' }, outcome: null, status: 'ready' }, /No current refund approval is recorded/, /Reopened for investigation; this is not refund approval/],
      ['invalidated', { approval: { state: 'invalidated', reason: 'Saved evidence changed.' }, outcome: 'held' }, /Current refund approval: invalidated/, /A fresh human decision is required/],
      ['historical', { outcome: 'already-resolved', status: 'complete', receipt: { seeded: true, id: 'historical-1' } }, /No current refund approval is recorded/, /No current review decision is attached/],
      ['identity absent', { approval: { state: 'approved', amountMinor: 1000, note: 'Saved fixture approval without identity fields.' }, outcome: 'approved-not-submitted', stage: 'payments', operationId: 'reserved-1' }, /Recorded actor: Not recorded/, /Recorded at: Not recorded/],
    ];
    for (const [name, change, first, second] of variants) {
      const item = { ...savedCase(), ...change }, { service } = setup(t, mode, item);
      const report = (await service.report(principal, item.id)).text, briefing = await service.briefing(principal, item.id);
      for (const output of [currentDecision(report), briefing.sections.find(section => section.heading === 'Human review').text]) { assert.match(output, first, name); assert.match(output, second, name); }
      if (name === 'identity absent') assert.doesNotMatch(currentDecision(report), new RegExp(principal.userId), 'Do not borrow a historical actor for current approval');
      if (mode === 'hosted') { assert.match(report, /does not retrieve separate execution records/); assert.doesNotMatch(report, /No payment was submitted or made|Reserved only\. Not submitted and not paid/); }
      else if (name === 'approval') assert.match(report, /Reserved only\. Not submitted and not paid/);
      if (name === 'historical') assert.match(report, /explicitly seeded historical/i);
    }
  });
}
