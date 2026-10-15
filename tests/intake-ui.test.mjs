import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { intakeStatus } from '../src/intake-state.js';

const source = transformSync(readFileSync(new URL('../src/IntakeOffice.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsxFactory: '__view.element', jsxFragment: '__view.Fragment' }).code;
const order = { id: 'SYN-1', label: 'Synthetic order 1', sampleComplaint: 'The travel mug was missing from the parcel.' };
const request = status => ({ id: 'request-1', caseId: 'case-1', caseLabel: 'RF-1', orderId: order.id, status, updatedAt: '2026-10-15T10:00:00Z' });

function mount(t, initial = {}, savedRequests = []) {
  const hooks = [], effects = [], timers = new Map(), storage = new Map(), calls = [], cases = [];
  let values = initial, cursor = 0, dirty = true, tree, nextTimer = 0, disposed = false, requests = savedRequests;
  const react = {
    useState(initial) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[slot].value, value => { hooks[slot].value = typeof value === 'function' ? value(hooks[slot].value) : value; dirty = true; }]; },
    useRef(initial) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = { current: initial }; return hooks[slot]; },
    useId() { return `intake-${cursor++}`; },
    useEffect(effect, deps) { const slot = cursor++, previous = hooks[slot]; if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) effects.push(() => { previous?.cleanup?.(); hooks[slot] = { deps, cleanup: effect() }; }); },
  };
  const view = { Fragment: 'fragment', element(type, props, ...children) { const values = { ...props, children }; return typeof type === 'function' ? type(values) : { type, props: values }; } };
  const api = async (path, options = {}) => {
    calls.push({ path, ...options }); assert.equal(path, '/intake', 'Intake wording must not trigger an investigation, approval or payment route.');
    if (!options.method) return { requests };
    assert.equal(options.method, 'POST'); requests = [request('queued')];
    return { request: requests[0], case: { id: 'case-1', caseId: 'RF-1' }, replayed: false };
  };
  const module = { exports: {} };
  const require = id => {
    if (id === 'react') return react;
    if (id === './api.js') return { api };
    if (id === './intake-state.js') return { intakeStatus };
    if (id === './OperationsControls.jsx') return {
      OperationsDialog: props => view.element('operations-dialog', props, props.title, props.subtitle, props.children, props.footer),
      ErrorMessage: ({ error }) => error ? view.element('p', { role: 'alert' }, error) : null,
    };
    if (id === './CaseDownload.jsx') return { CaseDownload: 'download' };
    if (id === 'lucide-react') return new Proxy({}, { get: () => 'icon' });
    if (id.endsWith('.css')) return {};
    throw Error(id);
  };
  runInNewContext(source, {
    module, exports: module.exports, require, __view: view, AbortController,
    crypto: { randomUUID: () => 'event-1' },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
  });
  t.after(() => { if (!disposed) { disposed = true; for (const hook of hooks) hook?.cleanup?.(); } });
  return { calls, cases, storage, get tree() { return tree; }, setProps(next) { values = next; dirty = true; },
    async flush() {
      for (let n = 0; n < 20; n++) {
        if (dirty) { dirty = false; cursor = 0; tree = module.exports.IntakeDialog({ open: true, orders: [order], onClose() {}, onCase: value => cases.push(value), onOpenCase: async () => true, ...values, apiClient: api }); }
        while (effects.length) effects.shift()();
        await new Promise(resolve => setImmediate(resolve));
        if (!dirty && !effects.length) return;
      }
      throw Error('Intake view did not settle.');
    },
  };
}
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '';
const button = (app, label) => nodes(app.tree).find(node => node.type === 'button' && text(node) === label);
async function submit(app) {
  button(app, 'Use sample text').props.onClick(); await app.flush();
  await nodes(app.tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await app.flush();
}

test('the original local intake keeps background investigation and the human approval boundary', async t => {
  const app = mount(t); await app.flush();
  assert.equal(app.tree.props.title, 'Local intake queue');
  assert.match(app.tree.props.subtitle, /investigates in the background, then waits for you/);
  assert.match(text(app.tree), /No n8n or model service is contacted\. Every new refund needs your approval/);
  assert.ok(button(app, 'Submit and investigate'));
  await submit(app);
  assert.match(text(app.tree), /RF-1 queued\. The office will investigate and stop for your decision/);
  const posts = app.calls.filter(call => call.method); assert.equal(posts.length, 1);
  assert.equal(posts[0].body.orderId, order.id); assert.equal(posts[0].body.complaint, order.sampleComplaint);
  assert.deepEqual(Object.keys(posts[0].body).sort(), ['complaint', 'eventId', 'orderId']);
  assert.equal(app.cases.length, 1); assert.equal(app.storage.size, 0);
});

test('an enabled local runtime worker retains background investigation and waits for a reviewer', async t => {
  const app = mount(t, { runtime: true, capabilities: { runtime: true, storage: 'postgres-local', analyser: 'local' }, worker: { enabled: true }, canResume: false });
  await app.flush(); assert.equal(app.tree.props.title, 'Local intake queue');
  assert.match(app.tree.props.subtitle, /investigates in the background, then waits for a reviewer/);
  assert.match(text(app.tree), /Every new refund needs a reviewer’s approval/);
  assert.ok(button(app, 'Submit and investigate')); await submit(app);
  assert.match(text(app.tree), /queued\. The office will investigate and stop for a reviewer’s decision/);
});

test('hosted intake with its worker disabled saves requests without promising background investigation or reviewer processing rights', async t => {
  const app = mount(t, { runtime: true, capabilities: { hosted: true, storage: 'supabase', analyser: 'local' }, worker: { enabled: false, scheduling: 'authenticated-machine-hook' }, canResume: false }, [request('paused')]);
  await app.flush(); assert.equal(app.tree.props.title, 'Hosted intake queue');
  assert.match(app.tree.props.subtitle, /authorised investigator must process it before review/);
  assert.match(text(app.tree), /Automatic background investigation is not enabled/);
  assert.match(text(app.tree), /Every new refund needs a reviewer’s approval/);
  assert.match(text(app.tree), /Hosted queue|Hosted intake/);
  assert.doesNotMatch(text(app.tree), /Local intake|local service|investigates in the background|see the office investigate it/);
  assert.ok(button(app, 'Submit request')); assert.equal(button(app, 'Submit and investigate'), undefined); assert.equal(button(app, 'Resume investigation'), undefined);
  await submit(app);
  assert.match(text(app.tree), /RF-1 saved to the queue\. An authorised investigator must process it before review/);
  assert.doesNotMatch(text(app.tree), /The office will investigate/);
  assert.equal(app.calls.filter(call => call.method).length, 1); assert.equal(app.cases.length, 1);
});

test('runtime scheduling that is not confirmed never promises an automatic investigation', async t => {
  const initial = { runtime: true, capabilities: { runtime: true }, canResume: false };
  const app = mount(t, initial); await app.flush();
  assert.equal(app.tree.props.title, 'Saved intake queue'); assert.ok(button(app, 'Submit request'));
  assert.match(text(app.tree), /Submit a demo request above to save it to the queue/);
  assert.doesNotMatch(text(app.tree), /investigates in the background|Automatic background investigation is not enabled|see the office investigate it/);
  app.setProps({ ...initial, capabilities: { ...initial.capabilities, storage: 'postgres-local' }, worker: { enabled: true } }); await app.flush();
  assert.ok(button(app, 'Submit and investigate'));
  app.setProps({ ...initial, worker: { enabled: false } }); await app.flush();
  assert.ok(button(app, 'Submit request')); assert.doesNotMatch(app.tree.props.subtitle, /background/);
});
