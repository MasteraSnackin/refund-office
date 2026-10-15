import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import * as paymentHelpers from '../src/payment-authorisation.js';
import { executionFixture } from './runtime-payments/fixtures.mjs';
import { contextFixture, authorisationProps } from './payment-review/fixtures.mjs';

const source = transformSync(readFileSync(new URL('../src/PaymentAuthorisation.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsxFactory: '__view.element', jsxFragment: '__view.Fragment' }).code;
const storage = () => { const entries = new Map(); return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key), entries }; };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const commandId = '70000000-0000-4000-8000-000000000001';

// Calls the real component's effects and event handlers with isolated saved
// commands and controlled API responses. Browser layout is checked separately.
function mount(t, initialProps, api, saved = storage()) {
  const hooks = [], effects = []; let props = initialProps, cursor = 0, dirty = true, tree, disposed = false;
  const react = {
    useState(initial) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[slot].value, value => { hooks[slot].value = typeof value === 'function' ? value(hooks[slot].value) : value; dirty = true; }]; },
    useRef(initial) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = { current: initial }; return hooks[slot]; },
    useEffect(effect, deps) { const slot = cursor++, previous = hooks[slot]; if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) effects.push(() => { previous?.cleanup?.(); hooks[slot] = { deps, cleanup: effect() }; }); },
  };
  const view = { Fragment: 'fragment', element(type, values, ...children) { const p = { ...values, children }; return typeof type === 'function' ? type(p) : { type, props: p }; } };
  const module = { exports: {} };
  const require = id => { if (id === 'react') return react; if (id === './api.js') return { api }; if (id === './payment-authorisation.js') return paymentHelpers; if (id === 'lucide-react') return new Proxy({}, { get: () => 'icon' }); if (id.endsWith('.css')) return {}; throw Error(id); };
  runInNewContext(source, { module, exports: module.exports, require, __view: view, sessionStorage: saved, AbortController, crypto: { randomUUID: () => commandId } });
  const dispose = () => { if (!disposed) { disposed = true; for (const hook of hooks) hook?.cleanup?.(); } }; t.after(dispose);
  return { dispose, saved, get tree() { return tree; }, setProps(value) { props = value; dirty = true; },
    async flush() { for (let attempt = 0; attempt < 20; attempt++) { if (dirty) { dirty = false; cursor = 0; tree = module.exports.PaymentAuthorisation(props); } while (effects.length) effects.shift()(); await new Promise(resolve => setImmediate(resolve)); if (!dirty && !effects.length) return; } throw Error('Did not settle'); },
  };
}
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '';
const button = (app, label) => nodes(app.tree).find(node => node.type === 'button' && text(node) === label);
const form = app => nodes(app.tree).find(node => node.type === 'form');
const field = (app, name) => nodes(app.tree).find(node => node.props?.name === name);
async function fill(app) {
  field(app, 'accountId').props.onChange({ target: { value: 'acct_Synthetic1' } });
  field(app, 'paymentIntentId').props.onChange({ target: { value: 'pi_Synthetic1' } });
  field(app, 'note').props.onChange({ target: { value: 'Synthetic exact execution decision.' } }); await app.flush();
  field(app, 'confirmation').props.onChange({ target: { checked: true } }); await app.flush();
}
const ack = (execution = executionFixture()) => ({ execution, authorisationReadbackVerified: true, submitted: Boolean(execution.submittedAt) });
const send = app => form(app).props.onSubmit({ preventDefault() {} });
function finalExecution(status = 'succeeded') { const e = executionFixture(); e.status = status; e.submittedAt = '2026-10-14T12:30:00Z'; e.refundId = 're_Synthetic1'; e.receipt = { id: e.refundId, amount: 2000, currency: 'gbp', payment_intent: e.mapping.paymentIntentId, metadata: structuredClone(e.payload.metadata), status }; return e; }

test('local rehearsal and investigator panels never read or write payment authorisations', async t => {
  const fail = () => { throw Error('Must not call an API'); };
  const local = authorisationProps(); local.capabilities = { hosted: false, separateTestExecutionConfigured: false };
  const app = mount(t, local, fail); await app.flush(); assert.match(text(app.tree), /Unavailable in this rehearsal/); assert.equal(form(app), undefined);
  const investigator = authorisationProps(); investigator.access.session.role = 'investigator'; app.setProps(investigator); await app.flush();
  assert.match(text(app.tree), /Only a reviewer/); assert.equal(form(app), undefined); assert.equal(button(app, 'Refresh saved result'), undefined);
});

test('exact authorisation requires separate confirmation, freezes mapping and persists before POST', async t => {
  const saved = storage(), calls = [];
  const app = mount(t, authorisationProps(), async (path, options = {}) => {
    calls.push([path, options]); if (!options.method) return contextFixture();
    assert.equal(saved.entries.size, 1); assert.deepEqual(JSON.parse([...saved.entries.values()][0]), options.body); return ack();
  }, saved);
  await app.flush(); assert.equal(button(app, 'Record test payment authorisation').props.disabled, true);
  await send(app); assert.equal(calls.length, 1); await fill(app);
  assert.equal(button(app, 'Record test payment authorisation').props.disabled, false); await send(app); await app.flush();
  assert.equal(calls[1][0], '/payment-executions'); assert.equal(calls[1][1].body.expectedAmountMinor, 2000); assert.deepEqual(calls[1][1].body.mapping, executionFixture().mapping);
  assert.match(text(app.tree), /Authorised — not submitted/); assert.equal(form(app), undefined); assert.doesNotMatch(text(app.tree), /Submit refund|Reconcile payment/);
});

test('editing any mapping or reason clears explicit confirmation', async t => {
  const app = mount(t, authorisationProps(), async () => contextFixture()); await app.flush(); await fill(app);
  field(app, 'accountId').props.onChange({ target: { value: 'acct_Changed' } }); await app.flush();
  assert.equal(field(app, 'confirmation').props.checked, false); assert.equal(button(app, 'Record test payment authorisation').props.disabled, true);
});

test('lost authorisation is locked across remount and exact retry reuses its original command', async t => {
  const saved = storage(), posts = []; let lose = true;
  const api = async (path, options = {}) => { if (!options.method) return contextFixture(); posts.push(options.body); if (lose) throw Error('Lost response'); return ack(); };
  const app = mount(t, authorisationProps(), api, saved); await app.flush(); await fill(app); await send(app); await app.flush();
  assert.equal(form(app), undefined); assert.match(text(app.tree), /Authorisation awaiting confirmation/); assert.ok(button(app, 'Retry exact authorisation')); app.dispose(); lose = false;
  const reloaded = mount(t, authorisationProps(), api, saved); await reloaded.flush(); assert.equal(form(reloaded), undefined);
  await button(reloaded, 'Retry exact authorisation').props.onClick(); await reloaded.flush();
  assert.equal(posts.length, 2); assert.deepEqual(posts[0], posts[1]); assert.equal(posts[1].commandId, commandId); assert.match(text(reloaded.tree), /Authorised — not submitted/);
});

test('saved case lookup recovers a lost creation response without a second POST', async t => {
  let savedExecution = null, posts = 0;
  const app = mount(t, authorisationProps(), async (_, options = {}) => { if (!options.method) return contextFixture(savedExecution); posts++; savedExecution = executionFixture(); throw Error('Lost response'); });
  await app.flush(); await fill(app); await send(app); await app.flush();
  await button(app, 'Refresh saved result').props.onClick(); await app.flush();
  assert.equal(posts, 1); assert.match(text(app.tree), /Authorised — not submitted/); assert.equal(button(app, 'Retry exact authorisation'), undefined);
});

test('malformed, mismatched and unconfirmed POST results retain the pending request', async t => {
  for (const result of [ {}, { ...ack(), authorisationReadbackVerified: false }, { ...ack(), submitted: true }, ack({ ...executionFixture(), caseId: 'other-case' }), ack({ ...executionFixture(), mapping: { ...executionFixture().mapping, accountId: 'acct_Other' } }) ]) {
    const app = mount(t, authorisationProps(), async (_, options = {}) => options.method ? result : contextFixture()); await app.flush(); await fill(app); await send(app); await app.flush();
    assert.match(text(app.tree), /Authorisation awaiting confirmation/); assert.ok(button(app, 'Retry exact authorisation')); assert.equal(form(app), undefined); app.dispose();
  }
});

test('unavailable browser storage prevents authorisation before any POST', async t => {
  let posts = 0; const saved = storage(); saved.setItem = () => { throw Error('Storage unavailable'); };
  const app = mount(t, authorisationProps(), async (_, options = {}) => { if (options.method) posts++; return contextFixture(); }, saved); await app.flush(); await fill(app); await send(app); await app.flush();
  assert.equal(posts, 0); assert.match(text(app.tree), /Storage unavailable/);
});

test('corrupt saved command blocks a new form while allowing a read-only lookup', async t => {
  const saved = storage(), props = authorisationProps(); const key = paymentHelpers.paymentStorageKey({ tenantId: props.access.workspace.id, userId: props.access.session.userId, role: 'reviewer', caseId: props.scenario.id });
  saved.setItem(key, '{broken'); let calls = 0; const app = mount(t, props, async () => { calls++; return contextFixture(); }, saved); await app.flush();
  assert.equal(form(app), undefined); assert.match(text(app.tree), /could not be read safely/); await button(app, 'Refresh saved result').props.onClick(); await app.flush(); assert.equal(calls, 2); assert.equal(form(app), undefined);
});

test('stale approval context and wrong tenant responses cannot open an authorisation form', async t => {
  for (const context of [{ ...contextFixture(), tenantId: 'wrong' }, { ...contextFixture(), caseId: 'wrong' }, { ...contextFixture(), caseRevision: 5, binding: { ...contextFixture().binding, expectedCaseRevision: 5 } }]) {
    const app = mount(t, authorisationProps(), async () => context); await app.flush(); assert.equal(form(app), undefined); assert.ok(nodes(app.tree).some(node => node.props?.role === 'alert') || text(app.tree).includes('saved case has changed')); app.dispose();
  }
});

test('an in-flight response and stale handlers cannot affect a different case or role', async t => {
  const response = deferred(); let posts = 0;
  const app = mount(t, authorisationProps(), async (_, options = {}) => { if (options.method) { posts++; return response.promise; } return contextFixture(); }); await app.flush(); await fill(app);
  const stale = form(app).props.onSubmit, submitting = send(app); await app.flush();
  const next = authorisationProps(); next.access.session.role = 'investigator'; app.setProps(next); await app.flush();
  await stale({ preventDefault() {} }); response.resolve(ack()); await submitting; await app.flush();
  assert.equal(posts, 1); assert.doesNotMatch(text(app.tree), /Authorised — not submitted/); assert.match(text(app.tree), /Only a reviewer/);
});

test('separate signed-in identities cannot see another reviewer pending mapping', async t => {
  const saved = storage(), app = mount(t, authorisationProps(), async (_, options = {}) => { if (options.method) throw Error('Lost response'); return contextFixture(); }, saved);
  await app.flush(); await fill(app); await send(app); await app.flush();
  const next = authorisationProps(); next.access.session.userId = '70000000-0000-4000-8000-000000000002'; app.setProps(next); await app.flush();
  assert.ok(form(app)); assert.equal(field(app, 'accountId').props.value, ''); assert.doesNotMatch(text(app.tree), /Authorisation awaiting confirmation/);
});

test('all execution stages describe saved evidence without offering submission or automatic resubmission', async t => {
  const labels = { authorised: 'Authorised — not submitted', claimed: 'Executor preparing', submitting: 'Submission recorded — result unknown', uncertain: 'Payment result unresolved', 'response-saved': 'Refund reference saved — awaiting readback', reconciling: 'Checking saved refund', pending: 'Stripe test refund pending', succeeded: 'Stripe test refund confirmed', failed: 'Stripe test refund failed or cancelled' };
  for (const [status, label] of Object.entries(labels)) {
    const e = ['pending', 'succeeded', 'failed'].includes(status) ? finalExecution(status) : { ...executionFixture(), status, submittedAt: ['authorised', 'claimed'].includes(status) ? null : '2026-10-14T12:30:00Z' };
    const app = mount(t, authorisationProps(), async () => contextFixture(e)); await app.flush(); assert.match(text(app.tree), new RegExp(label)); assert.equal(form(app), undefined);
    assert.deepEqual(nodes(app.tree).filter(node => node.type === 'button').map(text), ['Refresh saved result']); app.dispose();
  }
});

test('a past success readback remains visibly unresolved after uncertain reconciliation', async t => {
  const e = finalExecution(); e.status = 'uncertain'; const app = mount(t, authorisationProps(), async () => contextFixture(e)); await app.flush();
  assert.match(text(app.tree), /Payment result unresolved/); assert.match(text(app.tree), /Earlier saved readback — current result is unresolved/); assert.doesNotMatch(text(app.tree), /Stripe test refund confirmed/);
});

test('success without matching independent provider receipt is never rendered as confirmed', async t => {
  for (const mutate of [ e => { e.receipt = null; }, e => { e.receipt.amount = 2100; }, e => { e.receipt.metadata = {}; }, e => { e.receipt.status = 'pending'; } ]) {
    const e = finalExecution(); mutate(e); const app = mount(t, authorisationProps(), async () => contextFixture(e)); await app.flush();
    assert.doesNotMatch(text(app.tree), /Stripe test refund confirmed/); assert.ok(nodes(app.tree).some(node => node.props?.role === 'alert')); assert.equal(form(app), undefined); app.dispose();
  }
});

test('repeat clicks while authorisation is pending result in a single write', async t => {
  const response = deferred(); let posts = 0; const app = mount(t, authorisationProps(), async (_, options = {}) => { if (options.method) { posts++; return response.promise; } return contextFixture(); });
  await app.flush(); await fill(app); const submit = form(app).props.onSubmit; const first = submit({ preventDefault() {} }); const second = submit({ preventDefault() {} }); await app.flush();
  assert.equal(posts, 1); response.resolve(ack()); await Promise.all([first, second]); await app.flush(); assert.match(text(app.tree), /Authorised — not submitted/);
});

test('context executions must match the displayed immutable original binding', async t => {
  for (const fieldName of ['operationId', 'originalApprovalId', 'originalFingerprint', 'expectedCaseRevision', 'expectedAmountMinor', 'orderId', 'lineId', 'paymentAmountMinor']) {
    const context = contextFixture(executionFixture()); context.binding[fieldName] = typeof context.binding[fieldName] === 'number' ? context.binding[fieldName] + 1 : fieldName === 'originalApprovalId' ? '70000000-0000-4000-8000-000000000002' : fieldName === 'originalFingerprint' ? 'c'.repeat(64) : 'other-value';
    const app = mount(t, authorisationProps(), async () => context); await app.flush();
    assert.doesNotMatch(text(app.tree), /Authorised — not submitted/); assert.ok(nodes(app.tree).some(node => node.props?.role === 'alert')); assert.equal(form(app), undefined); app.dispose();
  }
});

test('new POST response must name the signed-in reviewer but saved results may name another reviewer', async t => {
  const e = executionFixture(); e.authorisation.actor = '70000000-0000-4000-8000-000000000002';
  const app = mount(t, authorisationProps(), async (_, options = {}) => options.method ? ack(e) : contextFixture()); await app.flush(); await fill(app); await send(app); await app.flush();
  assert.match(text(app.tree), /Authorisation awaiting confirmation/); assert.doesNotMatch(text(app.tree), /Authorised — not submitted/);
  const other = mount(t, authorisationProps(), async () => contextFixture(e)); await other.flush();
  assert.match(text(other.tree), /Authorised — not submitted/); assert.match(text(other.tree), /70000000-0000-4000-8000-000000000002/); assert.match(text(other.tree), /2026-10-14T12:15:00Z/);
});

test('stale authorisation handlers stay blocked after a case revision or connection gate changes', async t => {
  for (const change of [props => { props.scenario.revision = 5; }, props => { props.capabilities.separateTestExecutionConfigured = false; }]) {
    let posts = 0;
    const app = mount(t, authorisationProps(), async (_, options = {}) => { if (options.method) posts++; return contextFixture(); }); await app.flush(); await fill(app);
    const stale = form(app).props.onSubmit, next = authorisationProps(); change(next); app.setProps(next); await app.flush();
    await stale({ preventDefault() {} }); await app.flush(); assert.equal(posts, 0); app.dispose();
  }
});
