import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import * as helpers from '../src/case-view.js';

const reviewer = { review: true, investigate: false };
const investigator = { review: false, investigate: true };
const capabilities = { runtime: true, evidenceClarification: true, paymentSubmission: false };
const ready = (id = 'one', extra = {}) => ({ id, caseId: `RF-${id}`, orderId: 'SYN-1', title: 'Missing mug', complaint: 'The mug is missing.', runtime: true, status: 'review', stage: 'review', outcome: 'awaiting-approval', proposedAmountMinor: 2000, approval: { state: 'required', amountMinor: 2000, fingerprint: 'f'.repeat(64) }, checks: [{ id: 'amount', status: 'pass', detail: 'The exact amount matches.' }], intakeRequestId: 'request-one', ...extra });
const classify = (item, permissions = reviewer, extra = {}) => helpers.caseQueue(item, { capabilities, permissions, ...extra });
const held = extra => ready('held', { outcome: 'held', approval: null, checks: [{ id: 'limit', status: 'hold', detail: 'The amount exceeds the saved policy limit.' }], ...extra });

test('only an exact proposal with saved passing checks enters the human decision group', () => {
  const item = ready(); assert.equal(classify(item).group, 'decision'); assert.equal(classify(item).actionable, true);
  assert.equal(classify(item, investigator).actionable, false); assert.match(classify(item, investigator).nextAction, /reviewer must decide/);
  assert.equal(classify(item, {}).actionable, false);
  for (const change of [
    { approval: null }, { proposedAmountMinor: 2001 }, { approval: { ...item.approval, amountMinor: 0 } },
    { approval: { ...item.approval, amountMinor: 20.5 } }, { approval: { ...item.approval, fingerprint: '' } },
    { checks: [] }, { checks: [{ id: 'amount', status: 'not_checked' }] }, { checks: [{ id: 'amount', status: 'hold' }] },
    { checks: [{ id: 'amount', status: 'pass', pass: false }] }, { outcome: 'held' }, { operationId: 'existing-operation' },
  ]) assert.notEqual(classify({ ...item, ...change }).group, 'decision', JSON.stringify(change));
});

test('evidence requests and investigation errors override a stale required-approval field', () => {
  const waiting = ready('waiting', { review: { state: 'awaiting-evidence', note: 'Please identify which item is missing.' } });
  assert.equal(classify(waiting).group, 'evidence'); assert.equal(classify(waiting).reason, waiting.review.note);
  assert.match(classify(waiting).nextAction, /received clarification/); assert.equal(classify(waiting, investigator).actionable, false);
  assert.match(classify(waiting, investigator).nextAction, /reviewer/);
  const failed = ready('failed', { intakeStatus: 'error', summary: 'Investigation stopped after an error.' });
  assert.equal(classify(failed).group, 'recovery'); assert.equal(classify(failed).actionable, false);
  assert.equal(classify(failed, investigator).actionable, true); assert.match(classify(failed, investigator).nextAction, /before choosing investigation recovery/);
  assert.equal(classify({ ...failed, intakeRequestId: undefined }, investigator).actionable, false);
});

test('pending and failed payment records remain separate from investigation recovery', () => {
  for (const status of ['pending', 'error']) {
    const item = ready('payment', { status, operationId: 'original-operation', receipt: { status: status === 'error' ? 'failed' : 'pending', amountMinor: 2000 } });
    assert.equal(classify(item).group, 'holds'); assert.match(classify(item).nextAction, /original operation/); assert.equal(classify(item, investigator).actionable, false);
  }
  const running = ready('payment', { status: 'running', stage: 'payments', outcome: null, operationId: 'original-operation', approval: { state: 'approved' } });
  assert.equal(classify(running).group, 'payment'); assert.equal(classify(running, investigator).actionable, false);
});

test('an approved record without its operation cannot enter investigation recovery or claim a saved reservation', () => {
  const approvedHeld = held({ intakeStatus: 'error', approval: { state: 'approved', amountMinor: 2000 } });
  const missingReservation = ready('missing-reservation', { status: 'reserved', outcome: 'approved-not-submitted', approval: { state: 'approved', amountMinor: 2000 } });
  for (const item of [approvedHeld, missingReservation]) {
    for (const permissions of [reviewer, investigator, {}]) {
      const result = classify(item, permissions);
      assert.equal(result.group, 'holds'); assert.equal(result.actionable, false);
      assert.match(result.nextAction, /before taking any action/);
      assert.doesNotMatch(result.nextAction, /choosing investigation recovery|record your decision|Submission is disabled/);
      assert.equal(helpers.nextCaseForRole([item], { capabilities, permissions }), null);
    }
  }
  for (const operationId of [undefined, null, '', '   ', 1]) assert.equal(classify({ ...missingReservation, operationId }).group, 'holds');
  assert.deepEqual(helpers.summariseReviewQueue([approvedHeld, missingReservation]), { decision: 0, evidence: 0, recovery: 0, holds: 2 });
});

test('reservations, supplied history and closure cannot appear as new decisions or successful new payments', () => {
  const reserved = ready('reserved', { status: 'reserved', outcome: 'approved-not-submitted', approval: { state: 'approved', amountMinor: 2000 }, operationId: 'reservation' });
  assert.equal(classify(reserved).group, 'reserved'); assert.match(classify(reserved).reason, /no payment was submitted/);
  assert.equal(classify(reserved).actionable, false);
  const hosted = classify(reserved, reviewer, { capabilities: { hosted: true, separateTestExecutionConfigured: true } });
  assert.match(hosted.reason, /Inspect the separate execution record/); assert.doesNotMatch(hosted.reason, /no payment was submitted|not paid/i);
  assert.equal(classify({ ...reserved, receipt: { status: 'succeeded' } }).group, 'holds');
  const history = ready('historical', { status: 'complete', outcome: 'already-resolved', approval: null, receipt: { seeded: true, status: 'succeeded' } });
  assert.equal(classify(history).group, 'historical'); assert.match(classify(history).reason, /not a new refund/);
  assert.equal(classify({ ...history, receipt: { seeded: true, status: 'unknown' } }).group, 'holds');
  const closed = ready('closed', { status: 'closed', outcome: 'closed-no-refund', approval: null });
  assert.equal(classify(closed).group, 'resolved');
  assert.equal(classify({ ...closed, operationId: 'conflicting-operation' }).group, 'holds');
  assert.equal(classify({ ...history, approval: ready().approval }).group, 'holds');
});

test('policy holds use saved check reasons and unknown records stay inspectable without invented readiness', () => {
  assert.equal(classify(held()).group, 'holds'); assert.equal(classify(held()).reason, held().checks[0].detail);
  for (const item of [null, {}, { status: 'unexpected' }, ready('broken', { status: 'running' }), ready('broken', { status: 'complete' })]) {
    const result = classify(item); assert.equal(result.group, 'holds'); assert.notEqual(result.label, 'Ready for human decision');
  }
  assert.equal(classify({ status: 'unexpected' }).actionable, false);
});

test('queue counts, filters and transitions follow saved state without changing cases or receipt totals', () => {
  const cases = [ready(), held(), ready('failed', { status: 'error', approval: null }), ready('waiting', { review: { state: 'awaiting-evidence' } })];
  const before = JSON.stringify(cases), totals = helpers.summariseCases(cases);
  assert.deepEqual(helpers.summariseReviewQueue(cases), { decision: 1, evidence: 1, recovery: 1, holds: 1 });
  for (const [filter, id] of [['decision', 'one'], ['holds', 'held'], ['recovery', 'failed'], ['evidence', 'waiting']]) assert.deepEqual(helpers.filterCases(cases, { filter }).map(item => item.id), [id]);
  assert.deepEqual(helpers.filterCases(cases, { filter: 'evidence', query: 'missing mug' }).map(item => item.id), ['waiting']);
  assert.deepEqual(helpers.filterCases(cases, { filter: 'recovery', query: 'unmatched' }), []);
  assert.equal(JSON.stringify(cases), before); assert.deepEqual(helpers.summariseCases(cases), totals);
  cases[3] = ready('waiting'); assert.deepEqual(helpers.summariseReviewQueue(cases), { decision: 2, evidence: 0, recovery: 1, holds: 1 });
  cases[0] = { ...cases[0], status: 'reserved', outcome: 'approved-not-submitted', approval: { state: 'approved', amountMinor: 2000 }, operationId: 'saved-reservation' };
  assert.deepEqual(helpers.summariseReviewQueue(cases), { decision: 1, evidence: 0, recovery: 1, holds: 1 });
});

test('next case follows saved order for the current role, wraps once and never selects an ineligible case', () => {
  const cases = [ready('decision'), ready('waiting', { review: { state: 'awaiting-evidence' } }), ready('failed', { status: 'error' }), ready('queued', { status: 'ready', outcome: null, approval: null }), held()];
  assert.equal(helpers.nextCaseForRole(cases, { selectedId: 'decision', capabilities, permissions: reviewer }).id, 'waiting');
  assert.equal(helpers.nextCaseForRole(cases, { selectedId: 'held', capabilities, permissions: reviewer }).id, 'decision');
  assert.equal(helpers.nextCaseForRole(cases, { selectedId: 'decision', capabilities, permissions: investigator }).id, 'failed');
  assert.equal(helpers.nextCaseForRole(cases, { selectedId: 'failed', capabilities, permissions: investigator }).id, 'queued');
  assert.equal(helpers.nextCaseForRole(cases, { capabilities, permissions: {} }), null);
  assert.equal(helpers.nextCaseForRole([ready()], { selectedId: 'one', capabilities, permissions: reviewer }), null);
  assert.equal(helpers.nextCaseForRole([{ status: 'review', ...ready(), id: undefined }], { capabilities, permissions: reviewer }), null);
});

const source = transformSync(readFileSync(new URL('../src/CaseInbox.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsxFactory: '__view.element', jsxFragment: '__view.Fragment' }).code;
function mount(initial) {
  let props = initial, cursor = 0, dirty = true, tree; const hooks = [], effects = [], selected = [];
  const react = {
    useId() { return `field-${cursor++}`; },
    useMemo(fn) { cursor++; return fn(); },
    useState(initial) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial; return [hooks[slot], value => { const next = typeof value === 'function' ? value(hooks[slot]) : value; if (next !== hooks[slot]) { hooks[slot] = next; dirty = true; } }]; },
    useEffect(effect, deps) { const slot = cursor++, previous = hooks[slot]; if (!previous || deps.some((value, index) => value !== previous[index])) { hooks[slot] = deps; effects.push(effect); } },
  };
  const view = { Fragment: 'fragment', element(type, props, ...children) { return { type, props: { ...props, children } }; } };
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, __view: view, require(id) { if (id === 'react') return react; if (id === './case-view.js') return helpers; if (id.endsWith('.css')) return {}; if (id === 'lucide-react') return new Proxy({}, { get: () => 'icon' }); throw Error(`Queue navigation must not import a write dependency: ${id}`); }, fetch() { throw Error('Queue navigation cannot contact an API or provider.'); } });
  return { selected, get tree() { return tree; }, setProps(next) { props = next; dirty = true; }, flush() { for (let i = 0; i < 20; i++) { if (dirty) { dirty = false; cursor = 0; tree = module.exports.CaseInbox({ ...props, onSelect: id => selected.push(id) }); } while (effects.length) effects.shift()(); if (!dirty && !effects.length) return; } throw Error('Queue did not settle.'); } };
}
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '';
const button = (app, label) => nodes(app.tree).find(node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label));
const rowIds = app => nodes(app.tree).filter(node => node.type === 'button' && node.props.className?.startsWith('case-inbox-row')).map(node => node.props['aria-label'].split(' — ')[0]);

test('the real queue component filters saved cases, searches within a group and selects only without financial mutation', () => {
  const cases = [ready('one'), ready('evidence', { review: { state: 'awaiting-evidence', note: 'Name the missing mug.' } }), ready('failed', { status: 'error' }), held()];
  const before = JSON.stringify(cases), app = mount({ cases, capabilities, permissions: reviewer, selectedId: 'one' }); app.flush();
  assert.equal(rowIds(app).length, 4); button(app, 'Waiting for evidence: 1 case').props.onClick(); app.flush(); assert.deepEqual(rowIds(app), ['RF-evidence']);
  assert.match(text(app.tree), /Name the missing mug/); assert.match(text(app.tree), /record a received clarification/);
  const search = nodes(app.tree).find(node => node.type === 'input'); search.props.onChange({ target: { value: 'unknown' } }); app.flush(); assert.match(text(app.tree), /No matching cases/);
  button(app, 'Show all cases').props.onClick(); app.flush(); assert.equal(rowIds(app).length, 4);
  button(app, 'Next case for my role').props.onClick(); assert.deepEqual(app.selected, ['evidence']);
  nodes(app.tree).find(node => node.type === 'button' && node.props.className?.startsWith('case-inbox-row')).props.onClick(); assert.deepEqual(app.selected, ['evidence', 'one']);
  assert.equal(JSON.stringify(cases), before); assert.equal(nodes(app.tree).some(node => node.type === 'form'), false);
  assert.doesNotMatch(nodes(app.tree).filter(node => node.type === 'button').map(text).join(' '), /Approve|Submit refund|Pay|Recover investigation/);
});

test('role and saved-case transitions immediately change the next-case target and group counts', () => {
  const cases = [ready('one'), ready('failed', { status: 'error' })], app = mount({ cases, capabilities, permissions: reviewer, selectedId: 'one' }); app.flush();
  assert.equal(button(app, 'Next case for my role').props.disabled, true);
  app.setProps({ cases, capabilities, permissions: investigator, selectedId: 'one' }); app.flush(); assert.equal(button(app, 'Next case for my role').props.disabled, false);
  button(app, 'Next case for my role').props.onClick(); assert.deepEqual(app.selected, ['failed']); assert.match(text(app.tree), /Refund decisions remain with a reviewer/);
  app.setProps({ cases: [ready('one'), { ...cases[1], status: 'running', outcome: null, approval: null }], capabilities, permissions: investigator, selectedId: 'one' }); app.flush();
  assert.ok(button(app, 'Investigation recovery: 0 cases')); assert.equal(button(app, 'Next case for my role').props.disabled, true);
  app.setProps({ cases, capabilities, permissions: {}, selectedId: 'one' }); app.flush(); assert.equal(button(app, 'Next case for my role').props.disabled, true); assert.match(text(app.tree), /Inspection only/);
});

test('contradictory approvals render as inspection only, including accessible labels and amount wording', () => {
  const cases = [held({ intakeStatus: 'error', approval: { state: 'approved', amountMinor: 2000 } }), ready('missing-reservation', { status: 'reserved', outcome: 'approved-not-submitted', approval: { state: 'approved', amountMinor: 2000 } })];
  for (const permissions of [reviewer, investigator]) {
    const app = mount({ cases, capabilities, permissions }); app.flush();
    assert.equal(button(app, 'Next case for my role').props.disabled, true);
    assert.ok(button(app, 'Investigation recovery: 0 cases')); assert.ok(button(app, 'Other holds: 2 cases'));
    const rows = nodes(app.tree).filter(node => node.type === 'button' && node.props.className?.startsWith('case-inbox-row'));
    assert.match(rows[0].props['aria-label'], /Saved approval needs inspection/);
    assert.match(rows[1].props['aria-label'], /Saved result needs inspection/);
    assert.doesNotMatch(rows.map(node => node.props['aria-label']).join(' '), /Approved — not submitted|Investigation recovery/);
    assert.match(text(rows[1]), /£20 · inspect record/);
    assert.doesNotMatch(text(rows[1]), /reserved · not submitted|The amount is reserved|no payment was submitted/);
  }
});
