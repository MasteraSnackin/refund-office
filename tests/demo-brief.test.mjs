import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import * as helpers from '../src/demo-brief.js';
import * as replay from '../src/judge-replay.js';

const fixture = () => ({ open: true, principalKey: 'workspace:reviewer:role', runId: '11111111-1111-4111-8111-111111111111', capabilities: { identityMode: 'local-test-profile' }, scenario: {
  id: 'synthetic-case-8', caseId: 'RF-008', title: 'Missing sketchbook', revision: 5, runtime: true,
  status: 'review', stage: 'review', outcome: 'awaiting-approval', proposedAmountMinor: 1000,
  approval: { state: 'required', amountMinor: 1000, fingerprint: 'saved-exact-facts' },
  proposal: { source: 'local', amountMinor: 1000, reason: 'One sketchbook was not recorded as packed.', evidenceIds: ['packing:8'] },
  evidence: [{ id: 'packing:8', title: 'Packing record', source: 'Supplied synthetic record' }, { id: 'order:8', title: 'Order record' }],
  checks: [{ id: 'amount', label: 'Exact amount', status: 'pass', detail: 'One item at £10.' }, { id: 'evidence', label: 'Known evidence', pass: true }],
  events: [{ id: '1', at: '2026-10-15T10:00:00Z', label: 'Investigation saved', actor: 'investigator-test' }],
} });

const source = transformSync(readFileSync(new URL('../src/DemoBrief.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsxFactory: '__view.element', jsxFragment: '__view.Fragment' }).code;
function mount(t, initial = fixture()) {
  const hooks = [], effects = [], inspections = [], navigations = []; let values, cursor = 0, dirty = true, tree, disposed = false, closes = 0, focused = 0;
  const trigger = { isConnected: true, focus() { focused++; } };
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const callbacks = { onClose() { closes++; }, onInspect(type) { inspections.push(type); navigations.push(['inspect', dialog.open]); }, onReplay() { navigations.push(['replay', dialog.open]); }, onCanvas() { navigations.push(['canvas', dialog.open]); } };
  values = { ...initial, ...callbacks };
  const react = {
    useState(initial) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[slot].value, value => { const next = typeof value === 'function' ? value(hooks[slot].value) : value; if (!Object.is(next, hooks[slot].value)) { hooks[slot].value = next; dirty = true; } }]; },
    useRef(initial) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = { current: initial }; return hooks[slot]; },
    useEffect(effect, deps) { const slot = cursor++, previous = hooks[slot]; if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) effects.push(() => { previous?.cleanup?.(); hooks[slot] = { deps, cleanup: effect() }; }); },
  };
  const view = { Fragment: 'fragment', element(type, p, ...children) { const props = { ...p, children }; if (type === 'dialog' && p.ref) p.ref.current = dialog; return typeof type === 'function' ? type(props) : { type, props }; } };
  const module = { exports: {} };
  const require = id => {
    if (id === 'react') return react;
    if (id === './demo-brief.js') return helpers;
    if (id === './judge-replay.js') return replay;
    if (id === './CaseDownload.jsx') return { CaseDownload: props => ({ type: 'run-bound-download', props }) };
    if (id === 'lucide-react') return new Proxy({}, { get: () => 'icon' });
    if (id.endsWith('.css')) return {};
    throw Error(`Demo brief cannot import an action dependency: ${id}`);
  };
  runInNewContext(source, { module, exports: module.exports, require, __view: view, document: { activeElement: trigger }, fetch() { assert.fail('A read-only brief cannot contact a provider or mutation route.'); } });
  const dispose = () => { if (!disposed) { disposed = true; for (const hook of hooks) hook?.cleanup?.(); } }; t.after(dispose);
  return { dialog, inspections, navigations, dispose, trigger, get tree() { return tree; }, get closes() { return closes; }, get focused() { return focused; },
    setProps(next) { values = { ...next, ...callbacks }; dirty = true; },
    async flush() { for (let n = 0; n < 20; n++) { if (dirty) { dirty = false; cursor = 0; tree = module.exports.DemoBrief(values); } while (effects.length) effects.shift()(); await new Promise(resolve => setImmediate(resolve)); if (!dirty && !effects.length) return; } throw Error('The brief did not settle.'); },
  };
}
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '';
const button = (app, label) => nodes(app.tree).find(node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label));
const downloads = app => nodes(app.tree).filter(node => node.type === 'run-bound-download');

test('saved output, citations and checks remain linked to one unchanged input', () => {
  const p = fixture(), before = JSON.stringify(p), brief = helpers.buildDemoBrief(p.scenario, p.capabilities);
  assert.equal(brief.status, 'Ready for human decision'); assert.equal(brief.amountMinor, 1000);
  assert.equal(brief.evidenceCount, 2); assert.equal(brief.uncitedCount, 1); assert.equal(brief.citations[0].records[0].title, 'Packing record');
  assert.equal(brief.passedChecks, 2); assert.equal(brief.eventCount, 1); assert.match(brief.decision.text, /Awaiting human approval/);
  assert.match(brief.paymentBoundary, /submission is disabled/); assert.equal(JSON.stringify(p), before);
});

test('missing and zero amounts stay distinct; conflicting saved amounts need inspection', () => {
  const item = fixture().scenario; item.proposal = null; delete item.proposedAmountMinor;
  let brief = helpers.buildDemoBrief(item); assert.equal(brief.amountMinor, null); assert.match(brief.reason, /No investigation recommendation/);
  item.proposedAmountMinor = 0; item.proposal = { source: 'local', amountMinor: 0, reason: 'Unsupported claim remains held.' }; item.outcome = 'held'; item.approval = null;
  brief = helpers.buildDemoBrief(item); assert.equal(brief.amountMinor, 0); assert.match(brief.status, /hold/i);
  item.proposal.amountMinor = 2000; brief = helpers.buildDemoBrief(item); assert.equal(brief.amountMismatch, true); assert.equal(brief.status, 'Saved amounts need inspection');
  item.proposal.amountMinor = -10; item.proposedAmountMinor = 0.5; assert.equal(helpers.buildDemoBrief(item).amountMinor, null);
});

test('evidence gaps and unknown check results cannot become successful proof', () => {
  const p = fixture(); p.scenario.proposal.evidenceIds.push('absent-reference', 'absent-reference');
  p.scenario.checks = [{ id: 'conflict', status: 'pass', pass: false }, { id: 'blocked', status: 'blocked' }, { id: 'unknown', status: 'new-status' }, { id: 'unchecked', status: 'not_checked' }, null];
  const brief = helpers.buildDemoBrief(p.scenario);
  assert.deepEqual(brief.unresolvedCitedIds, ['absent-reference']); assert.equal(brief.passedChecks, 0);
  assert.deepEqual(brief.checks.map(check => check.result), ['Review / blocked', 'Review / blocked', 'Not checked', 'Not checked']);
  assert.equal(brief.citations.at(-1).records.length, 0);
});

test('local, controlled, recorded provider and unknown provenance have different meanings', () => {
  assert.equal(helpers.briefAnalyser({ source: 'local' }).mode, 'local-rules');
  const proposal = { source: 'anthropic', provenance: { provider: 'anthropic', mode: 'controlled-test', model: 'test-model' } };
  assert.equal(helpers.briefAnalyser(proposal).label, 'Controlled model response'); assert.match(helpers.briefAnalyser(proposal).detail, /injected test response/);
  proposal.provenance.mode = 'provider-response'; assert.equal(helpers.briefAnalyser(proposal).label, 'Provider response recorded'); assert.match(helpers.briefAnalyser(proposal).detail, /does not retrieve a provider receipt/);
  for (const value of [undefined, { source: 'openai' }, { source: 'anthropic', provenance: { provider: 'openai', mode: 'provider-response', model: 'x' } }, { source: 'local', provenance: { provider: 'local', mode: 'provider-response' } }]) assert.equal(helpers.briefAnalyser(value).mode, 'unknown');
});

test('configured model capabilities never establish saved provider usage', () => {
  const p = fixture(); p.scenario.proposal = { source: 'openai', reason: 'Saved response, provenance absent.' };
  const brief = helpers.buildDemoBrief(p.scenario, { analyser: 'openai', analyserMode: 'provider-response', networkMode: 'external-enabled' });
  assert.equal(brief.analyser.mode, 'unknown'); assert.equal(brief.analyser.model, null); assert.doesNotMatch(brief.analyser.label, /Provider response recorded/);
});

test('approval, closure, reopened review and historical remedy are never inferred from history events', () => {
  const p = fixture(); p.scenario.approval = null; p.scenario.outcome = 'held'; p.scenario.events.push({ type: 'approval.recorded', label: 'Historical approval' });
  assert.match(helpers.buildDemoBrief(p.scenario).decision.text, /No current refund approval/);
  p.scenario.review = { state: 'reopened', actor: 'recorded-reviewer', at: '2026-10-15T10:00:00Z' };
  let brief = helpers.buildDemoBrief(p.scenario); assert.match(brief.decision.text, /not refund approval/); assert.equal(brief.decision.actor, 'recorded-reviewer');
  p.scenario.review.state = 'closed'; assert.match(helpers.buildDemoBrief(p.scenario).decision.text, /closed without a refund/);
  p.scenario.receipt = { seeded: true, status: 'succeeded' }; assert.match(helpers.buildDemoBrief(p.scenario).paymentBoundary, /supplied history, not a new payment/);
});

test('local reservation and configured hosted execution keep original and separate outcomes distinct', () => {
  const p = fixture(); p.scenario.status = 'reserved'; p.scenario.outcome = 'approved-not-submitted'; p.scenario.operationId = 'saved-op'; p.scenario.approval = { state: 'approved', amountMinor: 1000, actor: 'reviewer', decidedAt: '2026-10-15T10:01:00Z' };
  let brief = helpers.buildDemoBrief(p.scenario); assert.equal(brief.status, 'Approved — not submitted'); assert.match(brief.decision.text, /approval recorded for £10\.00/); assert.match(brief.paymentBoundary, /no payment was submitted/i);
  brief = helpers.buildDemoBrief(p.scenario, { hosted: true, separateTestExecutionConfigured: true });
  assert.equal(brief.status, 'Original approval saved'); assert.match(brief.paymentBoundary, /execution record and payment outcome are not included/); assert.doesNotMatch(brief.paymentBoundary, /No money|no payment was submitted/);
});

test('brief opens a native dialog with six evidence-based blocks and no financial controls', async t => {
  const app = mount(t); await app.flush(); assert.equal(app.dialog.open, true);
  assert.equal(nodes(app.tree).filter(node => node.type === 'section').length, 6);
  assert.match(text(app.tree), /Ready for human decision/); assert.match(text(app.tree), /£10\.00/); assert.match(text(app.tree), /Validation state: not measured/);
  assert.match(text(app.tree), /Local rules/); assert.match(text(app.tree), /Local test profiles/);
  assert.equal(nodes(app.tree).some(node => node.type === 'form'), false);
  assert.equal(nodes(app.tree).some(node => node.type === 'button' && /approve|submit payment|send customer/i.test(text(node))), false);
  assert.equal(app.inspections.length, 0); assert.equal(app.navigations.length, 0);
});

test('a held case shows its saved hold reason prominently without requiring the check details', async t => {
  const p = fixture(); p.scenario.outcome = 'held'; p.scenario.approval = null; p.scenario.proposedAmountMinor = 2501;
  p.scenario.proposal = { ...p.scenario.proposal, amountMinor: 2501, reason: 'The packing record supports the missing item value.' };
  p.scenario.checks = [{ id: 'limit', label: 'Policy limit', status: 'hold', detail: '£25.01 exceeded the £25 policy limit used by this investigation.' }];
  const app = mount(t, p); await app.flush();
  const output = nodes(app.tree).find(node => node.type === 'section' && node.props.className?.includes('demo-brief-result'));
  assert.match(text(output), /Saved status:\s*£25\.01 exceeded the £25 policy limit/);
  assert.match(text(output), /packing record supports the missing item value/);
  assert.equal(nodes(output).some(node => node.type === 'details'), false);
});

test('identical proposal and saved status explanations are shown only once in the output block', async t => {
  const p = fixture(); p.scenario.outcome = 'held'; p.scenario.approval = null;
  p.scenario.proposal.reason = 'The delivery evidence conflicts with the claim.';
  p.scenario.checks = [{ id: 'delivery', status: 'hold', detail: p.scenario.proposal.reason }];
  const app = mount(t, p); await app.flush();
  const output = nodes(app.tree).find(node => node.type === 'section' && node.props.className?.includes('demo-brief-result'));
  assert.equal(text(output).split(p.scenario.proposal.reason).length - 1, 1);
  assert.doesNotMatch(text(output), /Saved status:/);
});

test('read-only links close before opening their destination, fence repeat handlers and retain run-bound download', async t => {
  for (const [label, destination] of [['Saved evidence', 'evidence'], ['Saved checks', 'policy'], ['Saved decisions', 'history'], ['Replay saved history', 'replay'], ['Case canvas', 'canvas']]) {
    const app = mount(t); await app.flush(); const file = downloads(app)[0];
    assert.equal(file.props.href, '/api/cases/synthetic-case-8/report'); assert.equal(file.props.runId, fixture().runId);
    const action = button(app, label).props.onClick; action(); action();
    assert.equal(app.closes, 1); assert.equal(app.dialog.open, false); assert.equal(app.navigations.length, 1);
    assert.equal(app.navigations[0][1], false); assert.equal(app.navigations[0][0], ['replay', 'canvas'].includes(destination) ? destination : 'inspect');
    if (!['replay', 'canvas'].includes(destination)) assert.deepEqual(app.inspections, [destination]);
    assert.equal(app.focused, 0); app.dispose();
  }
});

test('legacy report link uses the packet export and encodes the saved case identifier', async t => {
  const p = fixture(); p.scenario.runtime = false; p.scenario.id = 'case/with space';
  const app = mount(t, p); await app.flush(); assert.equal(downloads(app)[0].props.href, '/api/cases/case%2Fwith%20space/export');
});

test('changed revision blocks navigation and download until explicit snapshot reload', async t => {
  const app = mount(t); await app.flush(); const stale = button(app, 'Saved evidence').props.onClick;
  const next = fixture(); next.scenario.revision++; next.scenario.proposal.reason = 'Changed saved explanation.'; app.setProps(next); await app.flush();
  assert.match(text(app.tree), /saved case has changed/); assert.match(text(app.tree), /One sketchbook was not recorded/); assert.doesNotMatch(text(app.tree), /Changed saved explanation/);
  assert.equal(button(app, 'Saved evidence').props.disabled, true); assert.equal(downloads(app).length, 0); stale(); assert.equal(app.inspections.length, 0);
  button(app, 'Load latest saved case').props.onClick(); await app.flush(); assert.match(text(app.tree), /Changed saved explanation/); assert.equal(downloads(app).length, 1);
});

test('same-revision evidence and authority-setting changes require reloading the brief', async t => {
  for (const change of [p => { p.scenario.evidence.push({ id: 'new' }); }, p => { p.capabilities.hosted = true; p.capabilities.separateTestExecutionConfigured = true; }, p => { p.capabilities.identityMode = 'unknown'; }, p => { p.capabilities.paymentSubmission = false; }]) {
    const app = mount(t); await app.flush(); const next = fixture(); change(next); app.setProps(next); await app.flush();
    assert.match(text(app.tree), /saved case has changed/); assert.equal(downloads(app).length, 0); app.dispose();
  }
});

test('case, run and principal switches close the brief and invalidate captured callbacks', async t => {
  for (const change of [p => { p.scenario.id = 'other-case'; }, p => { p.runId = 'another-run'; }, p => { p.principalKey = 'another-workspace:profile'; }]) {
    const app = mount(t); await app.flush(); const stale = button(app, 'Case canvas').props.onClick;
    const next = fixture(); change(next); app.setProps(next); await app.flush(); stale();
    assert.equal(app.closes, 1); assert.equal(app.dialog.open, false); assert.equal(app.navigations.length, 0); assert.equal(text(app.tree), ''); app.dispose();
  }
});

test('closing returns focus, clears the snapshot and blocks old actions after reopening', async t => {
  const app = mount(t); await app.flush(); const stale = button(app, 'Saved decisions').props.onClick;
  button(app, 'Back to office').props.onClick(); stale(); assert.equal(app.inspections.length, 0);
  app.setProps({ ...fixture(), open: false }); await app.flush(); assert.equal(app.dialog.open, false); assert.equal(app.focused, 1); assert.equal(text(app.tree), '');
  const next = fixture(); next.scenario.revision = 9; next.scenario.proposal.reason = 'Fresh snapshot after reopening.';
  app.setProps(next); await app.flush(); assert.match(text(app.tree), /revision 9/); assert.match(text(app.tree), /Fresh snapshot after reopening/); stale(); assert.equal(app.inspections.length, 0);
});

test('malformed history is reported without retaining an actionable snapshot', async t => {
  const p = fixture(); p.scenario.events = [null]; const app = mount(t, p); await app.flush();
  assert.match(text(app.tree), /saved case could not be read/); assert.equal(downloads(app).length, 0); assert.equal(button(app, 'Saved evidence'), undefined);
});

test('reopening the identical saved case does not reactivate handlers from the prior opening', async t => {
  const app = mount(t); await app.flush(); const stale = button(app, 'Saved evidence').props.onClick;
  app.setProps({ ...fixture(), open: false }); await app.flush(); app.setProps(fixture()); await app.flush();
  stale(); assert.equal(app.inspections.length, 0); button(app, 'Saved evidence').props.onClick(); assert.deepEqual(app.inspections, ['evidence']);
});

test('unmount blocks stale navigation and restores connected trigger focus', async t => {
  const app = mount(t); await app.flush(); const stale = button(app, 'Replay saved history').props.onClick;
  app.dispose(); stale(); assert.equal(app.navigations.length, 0); assert.equal(app.dialog.open, false); assert.equal(app.focused, 1);
});
