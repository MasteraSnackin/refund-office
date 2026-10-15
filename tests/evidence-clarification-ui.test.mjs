import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import * as helpers from '../src/clarification-state.js';
import { createRuntimeSessions, LOCAL_RUNTIME_PROFILES } from '../server/runtime-auth.mjs';

const source = transformSync(readFileSync(new URL('../src/EvidenceClarification.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsxFactory: '__view.element', jsxFragment: '__view.Fragment' }).code;
const tenantId = '80000000-0000-4000-8000-000000000001', userId = '80000000-0000-4000-8000-000000000002', commandId = '80000000-0000-4000-8000-000000000003';
const originalComplaint = 'Something was missing from my order. Please help.';
const props = () => ({ scenario: { id: 'SYN-CASE-008', revision: 5, status: 'review', review: { state: 'awaiting-evidence' }, complaint: originalComplaint }, access: { workspace: { id: tenantId }, session: { userId, role: 'reviewer' } }, capabilities: { evidenceClarification: true } });
const context = (submissions = []) => ({ tenantId, caseId: 'SYN-CASE-008', revision: submissions.length ? 6 : 5, eligible: !submissions.length, blockedReason: submissions.length ? 'The received statement is queued for investigation.' : null, originalComplaint, requestNote: 'Ask the customer which of the original items was missing.', lines: [{ id: 'line-sketchbook', name: 'Sketchbook', ordered: 1, packed: 0, unitAmountMinor: 1000 }, { id: 'line-markers', name: 'Markers', ordered: 1, packed: 0, unitAmountMinor: 500 }], submissions, paymentSubmission: false });
const input = { lineId: 'line-sketchbook', customerStatement: 'The sketchbook was missing from the parcel.', sourceReference: 'Synthetic support reply 008', note: 'The received reply identifies the sketchbook from the existing order.' };
const submission = command => ({ id: '80000000-0000-4000-8000-000000000004', commandId: command.commandId, kind: 'customer-clarification', lineId: command.lineId, body: command.customerStatement, sourceReference: command.sourceReference, note: command.note, expectedRevision: command.expectedRevision, actor: userId, at: '2026-10-14T15:00:00Z' });
const ack = command => { const saved = submission(command); return { submission: saved, context: context([saved]), case: { id: 'SYN-CASE-008', revision: 6, complaint: originalComplaint, status: 'ready', approval: null, operationId: null, receipt: null, paymentSubmissionEnabled: false }, readbackVerified: true, replayed: false }; };
const storage = () => { const entries = new Map(); return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key), entries }; };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function mount(t, initial, api, saved = storage()) {
  const hooks = [], effects = []; let values = initial, cursor = 0, dirty = true, tree, disposed = false;
  const react = {
    useState(initial) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[slot].value, value => { hooks[slot].value = typeof value === 'function' ? value(hooks[slot].value) : value; dirty = true; }]; },
    useRef(initial) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = { current: initial }; return hooks[slot]; },
    useEffect(effect, deps) { const slot = cursor++, previous = hooks[slot]; if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) effects.push(() => { previous?.cleanup?.(); hooks[slot] = { deps, cleanup: effect() }; }); },
  };
  const view = { Fragment: 'fragment', element(type, p, ...children) { const values = { ...p, children }; return typeof type === 'function' ? type(values) : { type, props: values }; } };
  const module = { exports: {} };
  const require = id => { if (id === 'react') return react; if (id === './api.js') return { api }; if (id === './clarification-state.js') return helpers; if (id === 'lucide-react') return new Proxy({}, { get: () => 'icon' }); if (id.endsWith('.css')) return {}; throw Error(id); };
  runInNewContext(source, { module, exports: module.exports, require, __view: view, sessionStorage: saved, AbortController, crypto: { randomUUID: () => commandId } });
  const dispose = () => { if (!disposed) { disposed = true; for (const hook of hooks) hook?.cleanup?.(); } }; t.after(dispose);
  return { dispose, saved, get tree() { return tree; }, setProps(next) { values = next; dirty = true; },
    async flush() { for (let n = 0; n < 20; n++) { if (dirty) { dirty = false; cursor = 0; tree = module.exports.EvidenceClarification(values); } while (effects.length) effects.shift()(); await new Promise(resolve => setImmediate(resolve)); if (!dirty && !effects.length) return; } throw Error('Did not settle'); } };
}
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '';
const button = (app, label) => nodes(app.tree).find(node => node.type === 'button' && text(node) === label);
const form = app => nodes(app.tree).find(node => node.type === 'form');
const field = (app, name) => nodes(app.tree).find(node => node.props?.name === name);
async function fill(app) { for (const [key, value] of Object.entries(input)) field(app, key).props.onChange({ target: { value } }); await app.flush(); field(app, 'confirmation').props.onChange({ target: { checked: true } }); await app.flush(); }
const send = app => form(app).props.onSubmit({ preventDefault() {} });

test('old previews and investigators do not access clarification API routes', async t => {
  const unavailable = props(); unavailable.capabilities = {};
  const app = mount(t, unavailable, () => { throw Error('No route may be called'); }); await app.flush(); assert.match(text(app.tree), /Unavailable in this rehearsal/); assert.equal(form(app), undefined);
  const investigator = props(); investigator.access.session.role = 'investigator'; app.setProps(investigator); await app.flush(); assert.match(text(app.tree), /A reviewer must record/); assert.equal(form(app), undefined);
});

test('an existing evidence request and explicit confirmation are required to record a statement', async t => {
  let current = { ...context(), eligible: false, requestNote: null, blockedReason: 'Request evidence before recording a received statement.' }, posts = 0;
  const app = mount(t, props(), async (_, options = {}) => { if (options.method) posts++; return current; }); await app.flush(); assert.equal(form(app), undefined); assert.match(text(app.tree), /Request evidence before/);
  current = context(); await button(app, 'Refresh saved evidence').props.onClick(); await app.flush(); assert.ok(form(app));
  assert.equal(button(app, 'Save statement and reinvestigate').props.disabled, true); await send(app); assert.equal(posts, 0);
});

test('received statement is persisted before write and confirmed by independent history before clearing', async t => {
  const saved = storage(), calls = [], updated = []; const p = props(); p.onCaseUpdated = value => updated.push(value);
  const app = mount(t, p, async (path, options = {}) => { calls.push([path, options]); if (!options.method) return context(); assert.equal(saved.entries.size, 1); assert.deepEqual(JSON.parse([...saved.entries.values()][0]), options.body); return ack(options.body); }, saved);
  await app.flush(); await fill(app); await send(app); await app.flush();
  assert.equal(calls[1][0], '/cases/SYN-CASE-008/evidence-request'); assert.deepEqual(calls[1][1].body, { expectedRevision: 5, ...input, commandId }); assert.equal('kind' in calls[1][1].body, false);
  assert.equal(saved.entries.size, 0); assert.equal(updated.length, 1); assert.equal(updated[0].complaint, originalComplaint);
  assert.match(text(app.tree), /Received customer clarification/); assert.ok(text(app.tree).includes(input.customerStatement)); assert.ok(text(app.tree).includes(originalComplaint)); assert.ok(text(app.tree).includes(input.sourceReference)); assert.ok(text(app.tree).includes(userId)); assert.match(text(app.tree), /fresh investigation still requires a human refund decision/);
});

test('the form chooses existing lines without permitting catalogue or price edits', async t => {
  const app = mount(t, props(), async () => context()); await app.flush();
  assert.deepEqual(nodes(field(app, 'lineId')).filter(node => node.type === 'option').map(node => node.props.value), ['', 'line-sketchbook', 'line-markers']);
  assert.match(text(app.tree), /£10.00 each/); assert.match(text(app.tree), /£5.00 each/); assert.equal(field(app, 'amount'), undefined);
  assert.match(text(app.tree), /cannot replace packing facts, settle a delivery dispute or bypass policy/);
});

test('an item or statement change clears confirmation and unknown lines cannot submit', async t => {
  let posts = 0; const app = mount(t, props(), async (_, options = {}) => { if (options.method) posts++; return context(); }); await app.flush(); await fill(app);
  field(app, 'lineId').props.onChange({ target: { value: 'line-not-in-order' } }); await app.flush(); assert.equal(field(app, 'confirmation').props.checked, false);
  field(app, 'confirmation').props.onChange({ target: { checked: true } }); await app.flush(); await send(app); assert.equal(posts, 0);
});

test('lost response stays locked after reload and retry preserves every original field', async t => {
  const saved = storage(), posted = []; let lose = true;
  const api = async (_, options = {}) => { if (!options.method) return context(); posted.push(options.body); if (lose) throw Error('Lost response'); return ack(options.body); };
  const app = mount(t, props(), api, saved); await app.flush(); await fill(app); await send(app); await app.flush(); assert.equal(form(app), undefined); assert.ok(button(app, 'Retry exact statement')); app.dispose();
  lose = false; const reloaded = mount(t, props(), api, saved); await reloaded.flush(); await button(reloaded, 'Retry exact statement').props.onClick(); await reloaded.flush();
  assert.equal(posted.length, 2); assert.deepEqual(posted[1], posted[0]); assert.equal(saved.entries.size, 0); assert.match(text(reloaded.tree), /Received customer clarification/);
});

test('history lookup recovers a lost write without posting the statement again', async t => {
  let current = context(), posts = 0;
  const app = mount(t, props(), async (_, options = {}) => { if (!options.method) return current; posts++; current = ack(options.body).context; throw Error('Lost response'); });
  await app.flush(); await fill(app); await send(app); await app.flush(); await button(app, 'Refresh saved evidence').props.onClick(); await app.flush();
  assert.equal(posts, 1); assert.equal(button(app, 'Retry exact statement'), undefined); assert.match(text(app.tree), /Received customer clarification/); assert.equal(app.saved.entries.size, 0);
});

test('mismatched evidence, actor, acknowledgement and original complaint retain the exact request', async t => {
  for (const alter of [value => { value.readbackVerified = false; }, value => { value.submission.body = 'A different received statement.'; }, value => { value.context.submissions[0].actor = '80000000-0000-4000-8000-000000000005'; }, value => { value.case.complaint = 'Overwritten original complaint'; }, value => { value.context.submissions = []; }]) {
    const app = mount(t, props(), async (_, options = {}) => { if (!options.method) return context(); const value = ack(options.body); alter(value); return value; }); await app.flush(); await fill(app); await send(app); await app.flush();
    assert.ok(button(app, 'Retry exact statement')); assert.equal(form(app), undefined); assert.equal(app.saved.entries.size, 1); app.dispose();
  }
});

test('unavailable browser storage stops the write before a received statement is sent', async t => {
  let posts = 0; const saved = storage(); saved.setItem = () => { throw Error('Storage unavailable'); };
  const app = mount(t, props(), async (_, options = {}) => { if (options.method) posts++; return context(); }, saved); await app.flush(); await fill(app); await send(app); await app.flush(); assert.equal(posts, 0); assert.match(text(app.tree), /Storage unavailable/);
});

test('corrupt stored requests block new statements and still allow saved history to be displayed', async t => {
  const saved = storage(); saved.setItem(helpers.clarificationStorageKey({ tenantId, userId, role: 'reviewer', caseId: 'SYN-CASE-008' }), '{');
  const app = mount(t, props(), async () => context(), saved); await app.flush(); assert.equal(form(app), undefined); assert.match(text(app.tree), /could not be read safely/); assert.ok(text(app.tree).includes(originalComplaint));
});

test('stale handlers cannot submit after role, tenant, revision or capability changes', async t => {
  for (const change of [p => { p.access.session.role = 'investigator'; }, p => { p.access.workspace.id = '80000000-0000-4000-8000-000000000006'; }, p => { p.scenario.revision = 7; }, p => { p.capabilities.evidenceClarification = false; }]) {
    let posts = 0; const app = mount(t, props(), async (_, options = {}) => { if (options.method) posts++; return context(); }); await app.flush(); await fill(app); const stale = form(app).props.onSubmit, next = props(); change(next); app.setProps(next); await app.flush(); await stale({ preventDefault() {} }); await app.flush(); assert.equal(posts, 0); app.dispose();
  }
});

test('a delayed write response cannot reopen a former reviewer workspace', async t => {
  const response = deferred(); let posted; const app = mount(t, props(), async (_, options = {}) => { if (!options.method) return context(); posted = options.body; return response.promise; });
  await app.flush(); await fill(app); const sending = send(app); await app.flush(); const next = props(); next.access.session.role = 'investigator'; app.setProps(next); await app.flush(); response.resolve(ack(posted)); await sending; await app.flush(); assert.match(text(app.tree), /A reviewer must record/); assert.doesNotMatch(text(app.tree), /Received customer clarification/);
});

test('new signed-in identity never sees the previous reviewer draft or pending body', async t => {
  const app = mount(t, props(), async (_, options = {}) => { if (options.method) throw Error('Lost response'); return context(); }); await app.flush(); await fill(app); await send(app); await app.flush();
  const next = props(); next.access.session.userId = '80000000-0000-4000-8000-000000000007'; app.setProps(next); await app.flush(); assert.equal(field(app, 'customerStatement').props.value, ''); assert.equal(button(app, 'Retry exact statement'), undefined);
});

test('unknown line history, duplicates and cross-workspace contexts cannot be accepted', async t => {
  const command = helpers.makeClarificationCommand({ expectedRevision: 5, ...input }, commandId);
  for (const alter of [value => { value.tenantId = 'other'; }, value => { value.caseId = 'other'; }, value => { value.submissions[0].lineId = 'other-line'; }, value => { value.submissions.push(structuredClone(value.submissions[0])); }, value => { value.paymentSubmission = true; }]) {
    const value = context([submission(command)]); alter(value); const app = mount(t, props(), async () => value); await app.flush(); assert.equal(form(app), undefined); assert.ok(nodes(app.tree).some(node => node.props?.role === 'alert')); app.dispose();
  }
});

test('repeat clicks create a single statement write', async t => {
  const response = deferred(); let count = 0, posted; const app = mount(t, props(), async (_, options = {}) => { if (!options.method) return context(); count++; posted = options.body; return response.promise; }); await app.flush(); await fill(app);
  const handler = form(app).props.onSubmit, first = handler({ preventDefault() {} }), second = handler({ preventDefault() {} }); await app.flush(); assert.equal(count, 1); response.resolve(ack(posted)); await Promise.all([first, second]); await app.flush(); assert.equal(app.saved.entries.size, 0);
});

test('stale case revision must be refreshed before another statement can be recorded', async t => {
  const p = props(); p.scenario.revision = 4; const app = mount(t, p, async () => context()); await app.flush(); assert.equal(form(app), undefined); assert.match(text(app.tree), /saved case has changed/);
});

test('exact recovery accepts a newer saved case while preserving the independently read statement', async t => {
  const command = helpers.makeClarificationCommand({ expectedRevision: 5, ...input }, commandId);
  const result = ack(command); result.case.revision = 8; result.case.approval = { state: 'required' };
  const checked = helpers.verifyClarificationAcknowledgement(result, { tenantId, userId, caseId: 'SYN-CASE-008' }, command);
  assert.equal(checked.case.revision, 8); assert.equal(checked.submission.body, input.customerStatement);
  const catalogue = context(); catalogue.lines[1].unitAmountMinor = 0;
  assert.equal(helpers.verifyClarificationContext(catalogue, { tenantId, caseId: 'SYN-CASE-008' }).lines[1].unitAmountMinor, 0);
  assert.throws(() => helpers.makeClarificationCommand({ expectedRevision: 5, ...input, customerStatement: 'A statement with a bad\u0000character.' }, commandId));
});

test('the actual local public session identity records and verifies the reviewer statement', async t => {
  const auth = createRuntimeSessions({ tenantId, datasetTitle: 'Synthetic evidence rehearsal', cookieName: 'refund_evidence_rehearsal' }); t.after(() => auth.close());
  const login = auth.signIn({}, { profileId: 'reviewer' });
  const request = { headers: { cookie: login.cookie.split(';')[0] } }, access = auth.describe(request), principal = auth.authenticate(request);
  assert.equal(access.mode, 'local-rehearsal'); assert.equal(access.authenticated, true); assert.equal(access.session.profileId, 'reviewer');
  assert.equal(access.session.userId, principal.userId); assert.equal(access.session.userId, LOCAL_RUNTIME_PROFILES.find(profile => profile.id === 'reviewer').userId);
  const actual = props(); actual.access = access; const received = []; actual.onCaseUpdated = item => received.push(item);
  const app = mount(t, actual, async (_, options = {}) => { if (!options.method) return context(); const result = ack(options.body); result.submission.actor = principal.userId; return result; });
  await app.flush(); await fill(app); await send(app); await app.flush();
  assert.equal(app.saved.entries.size, 0); assert.equal(received.length, 1); assert.ok(text(app.tree).includes(principal.userId));
  assert.match(text(app.tree), /Received customer clarification/); assert.equal(button(app, 'Retry exact statement'), undefined);
});

test('a profile label without an immutable reviewer identity fails closed before any API request', async t => {
  for (const userId of [undefined, null, '', 'reviewer']) {
    const actual = props(); actual.access.mode = 'local-rehearsal'; actual.access.session = { role: 'reviewer', profileId: 'reviewer', userId };
    let calls = 0; const app = mount(t, actual, async () => { calls++; return context(); }); await app.flush();
    assert.equal(calls, 0); assert.equal(form(app), undefined); assert.equal(button(app, 'Refresh saved evidence'), undefined);
    assert.match(text(app.tree), /reviewer identity could not be verified/); assert.equal(app.saved.entries.size, 0); app.dispose();
  }
});

test('losing the immutable identity also invalidates a previously confirmed form handler', async t => {
  let posts = 0; const app = mount(t, props(), async (_, options = {}) => { if (options.method) posts++; return context(); }); await app.flush(); await fill(app);
  const stale = form(app).props.onSubmit, next = props(); next.access.session.profileId = 'reviewer'; delete next.access.session.userId;
  app.setProps(next); await app.flush(); await stale({ preventDefault() {} }); await app.flush();
  assert.equal(posts, 0); assert.equal(form(app), undefined); assert.match(text(app.tree), /reviewer identity could not be verified/);
});
