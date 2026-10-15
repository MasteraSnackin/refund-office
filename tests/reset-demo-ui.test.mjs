import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import * as reset from '../src/reset-demo-state.js';
import { api as realApi, bindRunApi, readRunDownload } from '../src/api.js';
import { clarificationStorageKey } from '../src/clarification-state.js';
import { paymentStorageKey } from '../src/payment-authorisation.js';

const sourceRunId = '90000000-0000-4000-8000-000000000001', targetRunId = '90000000-0000-4000-8000-000000000002', commandId = '90000000-0000-4000-8000-000000000003';
const access = () => ({ mode: 'local-rehearsal', authenticated: true, workspace: { id: sourceRunId, title: 'Focused synthetic pack' }, session: { userId: '40000000-0000-4000-8000-000000000001', profileId: 'reviewer', role: 'reviewer', expiresAt: '2099-01-01T00:00:00Z' }, profiles: [{ id: 'reviewer', role: 'reviewer', label: 'Local reviewer' }], demoRun: { id: sourceRunId, packId: 'focused-12', resetSupported: true } });
const receipt = (status = 'ready') => ({ commandId, sourceRunId, targetRunId, packId: 'focused-12', status, checkpointConfirmed: status === 'ready', message: status === 'ready' ? 'Previous run saved; fresh pack ready.' : 'The saved reset is being checked.' });
const storage = () => { const entries = new Map(); return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key), entries }; };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const sources = Object.fromEntries(['ResetDemo', 'RuntimeAccess', 'CaseDownload'].map(name => [name, transformSync(readFileSync(new URL(`../src/${name}.jsx`, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsxFactory: '__view.element', jsxFragment: '__view.Fragment' }).code]));
function mount(t, name, initial, api, saved = storage()) {
  const hooks = [], effects = [], timers = [], downloads = [], window = new EventTarget(), document = new EventTarget(); document.hidden = false;
  document.createElement = () => ({ click() { downloads.push({ href: this.href, filename: this.download }); } });
  let props = initial, cursor = 0, dirty = true, tree, disposed = false;
  const react = { useState(initial) { const n = cursor++; if (!(n in hooks)) hooks[n] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[n].value, value => { hooks[n].value = typeof value === 'function' ? value(hooks[n].value) : value; dirty = true; }]; }, useRef(initial) { const n = cursor++; if (!(n in hooks)) hooks[n] = { current: initial }; return hooks[n]; }, useId() { return 'test-' + cursor++; }, useMemo(factory, deps) { const n = cursor++, previous = hooks[n]; if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) hooks[n] = { deps, value: factory() }; return hooks[n].value; }, useEffect(effect, deps) { const n = cursor++, previous = hooks[n]; if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) effects.push(() => { previous?.cleanup?.(); hooks[n] = { deps, cleanup: effect() }; }); } };
  const view = { Fragment: 'fragment', element(type, props, ...children) { props = { ...props, children }; return typeof type === 'function' ? type(props) : { type, props }; } };
  const module = { exports: {} };
  const require = id => { if (id === 'react') return react; if (id === './api.js') return { api, readRunDownload: api, bindRunApi: runId => bindRunApi(runId, api) }; if (id === './reset-demo-state.js') return reset; if (id === './ResetDemo.jsx') return { ResetDemo: 'reset-controller' }; if (id === './OperationsControls.jsx') return { OperationsDialog: 'operations-dialog' }; if (id === './runtime-access.js') return {}; if (id === 'lucide-react') return new Proxy({}, { get: () => 'icon' }); if (id.endsWith('.css')) return {}; throw Error(id); };
  runInNewContext(sources[name === 'RuntimeSessionBoundary' ? 'RuntimeAccess' : name], { module, exports: module.exports, require, __view: view, sessionStorage: saved, window, document, AbortController, URL: { createObjectURL: () => 'blob:checked-report', revokeObjectURL() {} }, crypto: { randomUUID: () => commandId }, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {} });
  const dispose = () => { if (!disposed) { disposed = true; for (const hook of hooks) hook?.cleanup?.(); } }; t.after(dispose);
  return { saved, window, timers, downloads, dispose, get tree() { return tree; }, setProps(value) { props = value; dirty = true; }, async flush() { for (let n = 0; n < 30; n++) { if (dirty) { dirty = false; cursor = 0; tree = module.exports[name](props); } while (effects.length) effects.shift()(); await new Promise(resolve => setImmediate(resolve)); if (!dirty && !effects.length) return; } throw Error('Did not settle'); } };
}
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '';
const button = (app, label) => nodes(app.tree).find(node => node.type === 'button' && text(node) === label);
const form = app => nodes(app.tree).find(node => node.type === 'form');
const confirm = async app => { nodes(app.tree).find(node => node.props?.name === 'confirmReset').props.onChange({ target: { checked: true } }); await app.flush(); };
const send = app => form(app).props.onSubmit({ preventDefault() {} });
const office = access => ({ type: 'office', props: { access } });
const officeNode = app => nodes(app.tree).find(node => node.type === 'office');
const resetNode = app => nodes(app.tree).find(node => node.type === 'reset-controller');

test('Reset demo is available only for the supported local reviewer', async t => {
  for (const alter of [a => { delete a.demoRun; }, a => { a.mode = 'hosted-supabase'; }, a => { a.session.role = 'investigator'; }, a => { a.authenticated = false; }, a => { a.demoRun.resetSupported = false; }]) {
    const a = access(); alter(a); const app = mount(t, 'ResetDemo', { access: a, open: true }, async () => { throw Error('Unexpected call'); }); await app.flush(); assert.equal(app.tree, null); app.dispose();
  }
});

test('confirmation is required and the exact reset is persisted before POST', async t => {
  const saved = storage(), calls = [], ready = []; saved.setItem('old-approval-command', 'keep'); saved.setItem('old-clarification-command', 'keep');
  const app = mount(t, 'ResetDemo', { access: access(), open: true, onReady: value => ready.push(value) }, async (path, options = {}) => { calls.push([path, options]); assert.equal(reset.readResetCommand(saved).commandId, commandId); return receipt(); }, saved);
  await app.flush(); await send(app); assert.equal(calls.length, 0); await confirm(app); await send(app); await app.flush();
  assert.equal(calls.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1].body)), { commandId, expectedRunId: sourceRunId }); assert.equal(calls[0][1].runId, sourceRunId); assert.equal(calls[0][1].acceptRunChange, true);
  assert.equal(ready.length, 1); assert.equal(saved.getItem(reset.RESET_PENDING_KEY), null); assert.equal(saved.getItem('old-approval-command'), 'keep'); assert.equal(saved.getItem('old-clarification-command'), 'keep');
});

test('double clicks and a completed stale form handler cannot request a second reset', async t => {
  const response = deferred(); let writes = 0;
  const app = mount(t, 'ResetDemo', { access: access(), open: true }, async () => { writes++; return response.promise; }); await app.flush(); await confirm(app); const stale = form(app).props.onSubmit;
  const first = stale({ preventDefault() {} }), second = stale({ preventDefault() {} }); await app.flush(); assert.equal(writes, 1);
  response.resolve(receipt()); await Promise.all([first, second]); await app.flush(); await stale({ preventDefault() {} }); assert.equal(writes, 1);
});

test('lost response recovery after reload reads status without automatically retrying a mutation', async t => {
  const saved = storage(), calls = [], ready = [];
  const app = mount(t, 'ResetDemo', { access: access(), open: true }, async (path, options = {}) => { calls.push([path, options.method || 'GET']); throw Error('Response lost'); }, saved);
  await app.flush(); await confirm(app); await send(app); await app.flush(); assert.ok(reset.readResetCommand(saved)); app.dispose();
  const next = mount(t, 'ResetDemo', { access: { ...access(), authenticated: false, session: null }, open: false, onReady: value => ready.push(value) }, async (path, options = {}) => { calls.push([path, options.method || 'GET']); return receipt(); }, saved);
  await next.flush(); assert.equal(calls.filter(row => row[1] === 'POST').length, 1); assert.ok(calls.some(row => row[0] === `/demo/reset/${commandId}`)); assert.equal(ready.length, 1); assert.equal(reset.readResetCommand(saved), null);
});

test('explicit retry after session revocation uses the original command and source run', async t => {
  const saved = storage(); reset.prepareResetCommand(saved, access(), () => commandId); const calls = [];
  const app = mount(t, 'ResetDemo', { access: { ...access(), authenticated: false, session: null } }, async (path, options = {}) => { calls.push([path, options]); if (!options.method) throw Object.assign(Error('Not confirmed'), { status: 404 }); return receipt(); }, saved);
  await app.flush(); assert.equal(calls.length, 1); await button(app, 'Retry same reset request').props.onClick(); await app.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1][1].body)), { commandId, expectedRunId: sourceRunId }); assert.equal(calls[1][1].runId, sourceRunId); assert.equal(saved.getItem(reset.RESET_PENDING_KEY), null);
});

test('wrong command, run, pack or unconfirmed checkpoint never releases recovery', async t => {
  for (const alteration of [{ commandId: targetRunId }, { sourceRunId: targetRunId }, { targetRunId: sourceRunId }, { packId: 'busy-50' }, { checkpointConfirmed: false }]) {
    const saved = storage(); reset.prepareResetCommand(saved, access(), () => commandId); let ready = 0;
    const app = mount(t, 'ResetDemo', { onReady: () => ready++ }, async () => ({ ...receipt(), ...alteration }), saved); await app.flush(); assert.equal(ready, 0); assert.ok(reset.readResetCommand(saved)); assert.match(text(app.tree), /could not be matched/); app.dispose();
  }
});

test('an observed reset target cannot change on a later status read', async t => {
  const saved = storage(); reset.prepareResetCommand(saved, access(), () => commandId); let reads = 0;
  const app = mount(t, 'ResetDemo', {}, async () => ++reads === 1 ? receipt('switching') : { ...receipt(), targetRunId: '90000000-0000-4000-8000-000000000004' }, saved);
  await app.flush(); await button(app, 'Check saved reset').props.onClick(); await app.flush(); assert.match(text(app.tree), /could not be matched/); assert.equal(reset.readResetCommand(saved).targetRunId, targetRunId);
});

test('storage failure prevents reset and malformed saved recovery cannot start another command', async t => {
  let calls = 0; const saved = storage(); saved.setItem = () => { throw Error('Storage unavailable'); };
  const app = mount(t, 'ResetDemo', { access: access(), open: true }, async () => { calls++; return receipt(); }, saved); await app.flush(); await confirm(app); await send(app); await app.flush(); assert.equal(calls, 0); assert.match(text(app.tree), /Storage unavailable/);
  const corrupt = storage(); corrupt.setItem(reset.RESET_PENDING_KEY, '{'); const broken = mount(t, 'ResetDemo', { access: access(), open: true }, async () => { calls++; }, corrupt); await broken.flush(); assert.equal(form(broken), undefined); assert.equal(calls, 0); assert.match(text(broken.tree), /could not be read safely/);
});

test('role and run changes invalidate a previously confirmed reset form', async t => {
  for (const alter of [a => { a.session.role = 'investigator'; }, a => { a.demoRun.id = targetRunId; a.workspace.id = targetRunId; }, a => { a.authenticated = false; }]) {
    let calls = 0; const app = mount(t, 'ResetDemo', { access: access(), open: true }, async () => { calls++; return receipt(); }); await app.flush(); await confirm(app); const stale = form(app).props.onSubmit; const next = access(); alter(next); app.setProps({ access: next, open: true }); await app.flush(); await stale({ preventDefault() {} }); assert.equal(calls, 0); app.dispose();
  }
});

test('failed and unresolved resets keep their single command and do not auto POST', async t => {
  for (const state of ['failed', 'unresolved']) {
    const saved = storage(); reset.prepareResetCommand(saved, access(), () => commandId); let reads = 0, writes = 0;
    const app = mount(t, 'ResetDemo', {}, async (_, options = {}) => { if (options.method) writes++; else reads++; return receipt(state); }, saved); await app.flush(); assert.equal(reads, 1); assert.equal(writes, 0); assert.equal(form(app), undefined); assert.ok(reset.readResetCommand(saved)); app.dispose();
  }
});

test('bound API clients retain their original run even when a newer client exists or options try to replace it', async () => {
  const calls = [], transport = async (_, options) => calls.push(options);
  const original = bindRunApi(sourceRunId, transport), fresh = bindRunApi(targetRunId, transport);
  await fresh('/cases/new/approve', { method: 'POST', body: {} }); await original('/cases/old/approve', { method: 'POST', body: {}, runId: targetRunId, acceptRunChange: true });
  assert.equal(calls[0].runId, targetRunId); assert.equal(calls[1].runId, sourceRunId); assert.equal(calls[1].acceptRunChange, false); assert.throws(() => { original.runId = targetRunId; });
});

test('API sends the run fence and rejects another run response before applying a write result', async () => {
  const formerFetch = globalThis.fetch, formerWindow = globalThis.window; const target = new EventTarget(); let expired = 0; target.addEventListener('refund-office:session-expired', () => expired++); globalThis.window = target;
  try {
    globalThis.fetch = async (_, options) => { assert.equal(options.headers['x-refund-demo-run'], sourceRunId); return Response.json({ saved: true }, { headers: { 'x-refund-demo-run': targetRunId } }); };
    await assert.rejects(bindRunApi(sourceRunId)('/cases/example/approve', { method: 'POST', body: {} }), error => error.code === 'demo_run_changed' && error.uncertain === true); assert.equal(expired, 1);
    await assert.rejects(bindRunApi(sourceRunId)('/bootstrap'), error => error.code === 'demo_run_changed' && error.uncertain === false);
  } finally { globalThis.fetch = formerFetch; if (formerWindow === undefined) delete globalThis.window; else globalThis.window = formerWindow; }
});

test('reset POST alone can accept the new run response after its exact saved command', async () => {
  const former = globalThis.fetch;
  try { globalThis.fetch = async () => Response.json(receipt(), { headers: { 'x-refund-demo-run': targetRunId } });
    assert.equal((await realApi('/demo/reset', { method: 'POST', runId: sourceRunId, acceptRunChange: true, body: { commandId, expectedRunId: sourceRunId } })).targetRunId, targetRunId);
    await assert.rejects(realApi('/cases/example/approve', { method: 'POST', runId: sourceRunId, acceptRunChange: true, body: {} }), error => error.code === 'demo_run_changed');
  } finally { globalThis.fetch = former; }
});

test('pending case commands have separate keys for the original and replacement runs', () => {
  const scope = { tenantId: sourceRunId, userId: access().session.userId, role: 'reviewer', caseId: 'SYN-C001' };
  assert.notEqual(clarificationStorageKey({ ...scope, runId: sourceRunId }), clarificationStorageKey({ ...scope, runId: targetRunId }));
  assert.notEqual(paymentStorageKey({ ...scope, runId: sourceRunId }), paymentStorageKey({ ...scope, runId: targetRunId }));
});

test('session boundary closes the office during reset and returns to the fresh profile chooser', async t => {
  let current = access(); const calls = [];
  const app = mount(t, 'RuntimeSessionBoundary', { children: office }, async (path, options = {}) => { calls.push([path, options]); return current; }); await app.flush(); const old = officeNode(app).props.access;
  resetNode(app).props.onBlockingChange(true); await app.flush(); assert.equal(officeNode(app), undefined); assert.ok(!nodes(app.tree).some(node => node.props?.className === 'runtime-profile'));
  current = { ...access(), authenticated: false, session: null, workspace: { ...access().workspace, id: targetRunId }, demoRun: { ...access().demoRun, id: targetRunId } };
  await resetNode(app).props.onReady(receipt()); await app.flush(); assert.equal(officeNode(app), undefined); assert.match(text(app.tree), /Choose your test profile/);
  const profile = nodes(app.tree).find(node => node.props?.className === 'runtime-profile'); current = { ...current, authenticated: true, session: access().session }; await profile.props.onClick(); await app.flush();
  assert.equal(calls.findLast(row => row[1].method === 'POST')[1].runId, targetRunId); const fresh = officeNode(app).props.access; assert.notEqual(fresh.generation, old.generation); assert.equal(fresh.request.runId, targetRunId); assert.equal(old.request.runId, sourceRunId);
});

test('a retained reset on reload blocks an otherwise authenticated session from reopening the office', async t => {
  const saved = storage(); reset.prepareResetCommand(saved, access(), () => commandId);
  const app = mount(t, 'RuntimeSessionBoundary', { children: office }, async () => access(), saved); await app.flush(); assert.equal(officeNode(app), undefined); assert.match(text(app.tree), /Rehearsal reset needs confirmation/); assert.equal(reset.readResetCommand(saved).commandId, commandId);
});

test('a delayed old profile response cannot reopen the previous run after reset recovery', async t => {
  const delayed = deferred(); let current = { ...access(), authenticated: false, session: null };
  const app = mount(t, 'RuntimeSessionBoundary', { children: office }, async (_, options = {}) => options.method === 'POST' ? delayed.promise : current);
  await app.flush(); const profile = nodes(app.tree).find(node => node.props?.className === 'runtime-profile'); const login = profile.props.onClick();
  resetNode(app).props.onBlockingChange(true); await app.flush();
  current = { ...current, workspace: { ...current.workspace, id: targetRunId }, demoRun: { ...current.demoRun, id: targetRunId } };
  await resetNode(app).props.onReady(receipt()); await app.flush(); delayed.resolve(access()); await login; await app.flush();
  assert.equal(officeNode(app), undefined); assert.match(text(app.tree), /Choose your test profile/); assert.equal(resetNode(app).props.access.demoRun.id, targetRunId);
});

test('case downloads send the captured run and refuse files from another run', async () => {
  const former = globalThis.fetch;
  try {
    globalThis.fetch = async (href, options) => { assert.equal(href, '/api/cases/example/report'); assert.equal(options.headers['x-refund-demo-run'], sourceRunId); return new Response('Saved report', { headers: { 'x-refund-demo-run': sourceRunId, 'content-disposition': 'attachment; filename="case-report.md"' } }); };
    const saved = await readRunDownload('/api/cases/example/report', sourceRunId); assert.equal(await saved.blob.text(), 'Saved report'); assert.equal(saved.filename, 'case-report.md');
    globalThis.fetch = async (_, options) => { assert.equal(options.headers['x-refund-demo-run'], sourceRunId); return Response.json({ id:'example' }, { headers: { 'x-refund-demo-run': sourceRunId } }); };
    const record = await readRunDownload('/api/cases/example', sourceRunId); assert.equal(record.filename,'saved-case.json'); assert.equal(JSON.parse(await record.blob.text()).id,'example');
    globalThis.fetch = async () => new Response('Different run', { headers: { 'x-refund-demo-run': targetRunId } });
    await assert.rejects(readRunDownload('/api/cases/example/report', sourceRunId), error => error.code === 'demo_run_changed');
    await assert.rejects(readRunDownload('https://external.invalid/report', sourceRunId), /could not be matched/);
  } finally { globalThis.fetch = former; }
});

test('run-bound downloads are buttons with checked files; original links stay unchanged', async t => {
  const props = { href: '/api/cases/example/report', runId: sourceRunId, className: 'export-button', children: 'Download brief' }, calls = [];
  const app = mount(t, 'CaseDownload', props, async (...args) => { calls.push(args); return { blob: new Blob(['saved']), filename: 'saved.md' }; });
  await app.flush(); assert.equal(nodes(app.tree).some(node => node.type === 'a'), false); await button(app, 'Download brief').props.onClick(); await app.flush(); assert.equal(calls[0][1], sourceRunId); assert.deepEqual(app.downloads, [{ href: 'blob:checked-report', filename: 'saved.md' }]);
  const legacy = mount(t, 'CaseDownload', { ...props, runId: undefined }, async () => { throw Error('Unexpected fetch'); }); await legacy.flush(); assert.equal(legacy.tree.type, 'a'); assert.equal(legacy.tree.props.href, props.href);
});

test('downloads reject old handlers and discard responses after the run changes', async t => {
  const pending = deferred(), calls = [], props = { href: '/api/cases/example/export', runId: sourceRunId, children: 'Download packet' };
  const app = mount(t, 'CaseDownload', props, async (...args) => { calls.push(args); return pending.promise; }); await app.flush(); const stale = button(app, 'Download packet').props.onClick, read = stale();
  app.setProps({ ...props, runId: targetRunId }); await app.flush(); assert.equal(calls[0][2].signal.aborted, true); await stale(); assert.equal(calls.length, 1);
  pending.resolve({ blob: new Blob(['old']), filename: 'old.json' }); await read; await app.flush(); assert.equal(app.downloads.length, 0);
});

test('an unverified download displays its error without creating a local file', async t => {
  const app = mount(t, 'CaseDownload', { href: '/api/cases/example/report', runId: sourceRunId, children: 'Download brief' }, async () => { throw Error('Another rehearsal; nothing downloaded.'); });
  await app.flush(); await button(app, 'Download brief').props.onClick(); await app.flush(); assert.equal(app.downloads.length, 0); assert.match(text(app.tree), /Another rehearsal; nothing downloaded/);
});
