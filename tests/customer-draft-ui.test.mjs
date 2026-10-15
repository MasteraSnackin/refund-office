import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import * as helpers from '../src/customer-draft-state.js';

const source = transformSync(readFileSync(new URL('../src/CustomerDraft.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsxFactory: '__view.element' }).code;
const fixture = () => ({ scenario: { id: 'SYN-F12-C008', caseId: 'RF-2008', revision: 4, orderId: 'SYN-F12-O008', stage: 'review', status: 'review', outcome: 'held', evidence: [{ id: 'order:SYN-F12-O008' }, { id: 'packing:SYN-F12-O008' }] }, capabilities: { customerDrafts: true }, principalKey: 'synthetic-workspace:run:reviewer' });
const draft = () => ({ schemaVersion: 1, id: 'SYN-F12-C008', caseId: 'RF-2008', revision: 4, unsent: true, eligible: true, reason: 'Prepared from the saved hold. No message has been sent.', draftText: 'Hello,\n\nCould you confirm whether the sketchbook or marker set did not arrive?\n\nThank you.', evidenceRefs: ['order:SYN-F12-O008', 'packing:SYN-F12-O008'], sourceBinding: { caseId: 'SYN-F12-C008', revision: 4, orderId: 'SYN-F12-O008', evidenceDigest: 'a'.repeat(64) } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function mount(t, initial, api, clipboard = { writeText: async () => {} }) {
  const hooks = [], effects = [], copied = [], files = [], urls = new Map(); let values = initial, cursor = 0, dirty = true, tree, disposed = false;
  const react = {
    useState(initial) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[slot].value, value => { hooks[slot].value = typeof value === 'function' ? value(hooks[slot].value) : value; dirty = true; }]; },
    useRef(initial) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = { current: initial }; return hooks[slot]; },
    useEffect(effect, deps) { const slot = cursor++, previous = hooks[slot]; if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) effects.push(() => { previous?.cleanup?.(); hooks[slot] = { deps, cleanup: effect() }; }); },
  };
  const view = { element(type, props, ...children) { return { type, props: { ...props, children } }; } };
  const module = { exports: {} };
  const require = id => { if (id === 'react') return react; if (id === './customer-draft-state.js') return helpers; if (id === 'lucide-react') return new Proxy({}, { get: () => 'icon' }); if (id.endsWith('.css')) return {}; throw Error(id); };
  const navigator = { clipboard: clipboard && { async writeText(text) { await clipboard.writeText(text); copied.push(text); } } };
  const URL = { createObjectURL(blob) { const id = 'blob:' + urls.size; urls.set(id, blob); return id; }, revokeObjectURL(id) { urls.delete(id); } };
  const document = { createElement(tag) { assert.equal(tag, 'a'); return { click() { files.push({ filename: this.download, blob: urls.get(this.href) }); } }; } };
  runInNewContext(source, { module, exports: module.exports, require, __view: view, AbortController, navigator, URL, document, Blob, setTimeout: () => 0 });
  const dispose = () => { if (!disposed) { disposed = true; for (const hook of hooks) hook?.cleanup?.(); } }; t.after(dispose);
  return { copied, files, dispose, get tree() { return tree; }, setProps(next) { values = next; dirty = true; },
    async flush() { for (let n = 0; n < 20; n++) { if (dirty) { dirty = false; cursor = 0; tree = module.exports.CustomerDraft({ ...values, apiClient: api }); } while (effects.length) effects.shift()(); await new Promise(resolve => setImmediate(resolve)); if (!dirty && !effects.length) return; } throw Error('The draft view did not settle.'); } };
}
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '';
const button = (app, label) => nodes(app.tree).find(node => node.type === 'button' && text(node) === label);
async function prepare(app) { await button(app, 'Prepare question').props.onClick(); await app.flush(); }

test('customer wording is prepared only on request and all reads remain GETs', async t => {
  const calls = [], app = mount(t, fixture(), async (path, options) => { calls.push([path, options]); return draft(); });
  await app.flush(); assert.equal(calls.length, 0); await prepare(app);
  assert.equal(calls[0][0], '/cases/SYN-F12-C008/customer-draft'); assert.equal(calls[0][1].method, undefined);
  assert.match(text(app.tree), /Unsent customer draft/); assert.match(text(app.tree), /Saved revision 4/);
  assert.match(text(app.tree), /Saved sources used/); assert.ok(button(app, 'Copy question')); assert.equal(nodes(app.tree).some(node => node.type === 'form'), false);
});

test('copy and download recheck the saved draft, preserve its wording and never send a message', async t => {
  let reads = 0; const app = mount(t, fixture(), async (_, options) => { assert.equal(options.method, undefined); reads++; return draft(); });
  await app.flush(); await prepare(app); await button(app, 'Copy question').props.onClick(); await app.flush();
  assert.equal(reads, 2); assert.deepEqual(app.copied, [draft().draftText]); assert.match(text(app.tree), /Draft copied.*has not sent/);
  await button(app, 'Download unsent draft').props.onClick(); await app.flush();
  assert.equal(reads, 3); assert.equal(app.files.length, 1); assert.equal(app.files[0].filename, 'RF-2008-unsent-question.txt');
  const saved = await app.files[0].blob.text(); assert.match(saved, /^UNSENT CUSTOMER DRAFT/); assert.ok(saved.includes(draft().draftText)); assert.match(saved, /Saved revision: 4/);
});

test('an unavailable template shows the saved reason without offering customer wording', async t => {
  const unavailable = { ...draft(), eligible: false, reason: 'This case includes a delivery dispute.', draftText: '', evidenceRefs: [], sourceBinding: { caseId: fixture().scenario.id, revision: 4 } };
  const app = mount(t, fixture(), async () => unavailable); await app.flush(); await prepare(app);
  assert.match(text(app.tree), /delivery dispute/); assert.equal(button(app, 'Copy question'), undefined); assert.equal(button(app, 'Download unsent draft'), undefined);
});

test('legacy, approved, historical and unsupported views never call the draft API', async t => {
  for (const alter of [p => { p.capabilities = {}; }, p => { p.scenario.approval = { state: 'required' }; }, p => { p.scenario.operationId = 'historical'; }, p => { p.scenario.outcome = 'already-resolved'; }, p => { p.scenario.status = 'closed'; }]) {
    const p = fixture(); alter(p); const app = mount(t, p, () => assert.fail('A blocked draft route was called.')); await app.flush(); assert.equal(app.tree, null); app.dispose();
  }
});

test('case, revision, principal and capability changes hide old wording and fence stale buttons', async t => {
  for (const alter of [p => { p.scenario.id = 'SYN-F12-C009'; }, p => { p.scenario.revision++; }, p => { p.principalKey = 'other-run:investigator'; }, p => { p.capabilities.customerDrafts = false; }]) {
    let reads = 0; const app = mount(t, fixture(), async () => { reads++; return draft(); }); await app.flush(); await prepare(app);
    const stale = button(app, 'Copy question').props.onClick, p = fixture(); alter(p); app.setProps(p); await app.flush();
    assert.ok(!text(app.tree).includes(draft().draftText)); await stale(); await app.flush(); assert.equal(reads, 1); assert.equal(app.copied.length, 0); app.dispose();
  }
});

test('a delayed response cannot restore wording after workspace change or unmount', async t => {
  const reply = deferred(), app = mount(t, fixture(), () => reply.promise); await app.flush();
  const loading = button(app, 'Prepare question').props.onClick(); await app.flush();
  app.setProps({ ...fixture(), principalKey: 'replacement-workspace' }); await app.flush(); reply.resolve(draft()); await loading; await app.flush();
  assert.ok(!text(app.tree).includes(draft().draftText)); assert.equal(button(app, 'Copy question'), undefined);
});

test('mismatched identity, revision, source digest or citation prevents copying and downloading', async t => {
  for (const alter of [d => { d.id = 'other'; }, d => { d.caseId = 'RF-9999'; }, d => { d.revision++; }, d => { d.sourceBinding.evidenceDigest = 'invented'; }, d => { d.evidenceRefs.push('other-source'); }, d => { d.unsent = false; }, d => { d.sourceBinding.fingerprint = 'b'.repeat(64); }]) {
    const value = draft(); alter(value); const app = mount(t, fixture(), async () => value); await app.flush(); await prepare(app);
    assert.ok(nodes(app.tree).some(node => node.props?.role === 'alert')); assert.equal(button(app, 'Copy question'), undefined); assert.equal(app.copied.length, 0); assert.equal(app.files.length, 0); app.dispose();
  }
});

test('changed or unreadable recheck clears the old question before any copy or download', async t => {
  for (const later of [async () => { const value = draft(); value.draftText = 'A changed question.'; return value; }, async () => { throw Error('Saved case could not be read.'); }, async () => { const value = draft(); value.revision++; return value; }]) {
    let reads = 0; const app = mount(t, fixture(), () => ++reads === 1 ? draft() : later()); await app.flush(); await prepare(app);
    await button(app, 'Copy question').props.onClick(); await app.flush(); assert.equal(app.copied.length, 0); assert.equal(app.files.length, 0); assert.equal(button(app, 'Copy question'), undefined); app.dispose();
  }
});

test('clipboard refusal retains a verified draft for selection or download and reports no success', async t => {
  for (const clipboard of [null, { writeText: async () => { throw Error('Clipboard permission denied.'); } }]) {
    const app = mount(t, fixture(), async () => draft(), clipboard); await app.flush(); await prepare(app);
    await button(app, 'Copy question').props.onClick(); await app.flush(); assert.ok(button(app, 'Download unsent draft')); assert.ok(text(app.tree).includes(draft().draftText)); assert.doesNotMatch(text(app.tree), /Draft copied/);
    await button(app, 'Download unsent draft').props.onClick(); await app.flush(); assert.equal(app.files.length, 1); app.dispose();
  }
});
