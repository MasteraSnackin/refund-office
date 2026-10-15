import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import * as caseView from '../src/case-view.js';
import * as intakeState from '../src/intake-state.js';
import * as runtimeAccess from '../src/runtime-access.js';

const compile = path => transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsxFactory: '__view.element', jsxFragment: '__view.Fragment' }).code;
const mapSource = compile('../src/SystemMap.jsx');
const officeSource = compile('../src/App.jsx') + '\nmodule.exports.TestOffice = RefundOffice;';
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '';
const button = (app, label) => nodes(app.tree).find(node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label));
const frame = app => nodes(app.tree).find(node => node.type === 'iframe');
const component = (app, type) => nodes(app.tree).find(node => node.type === type || node.type?.name === type);

function mount(t, source, exported, initial, imports = {}) {
  const hooks = [], effects = [], timers = new Map(); let values = initial, cursor = 0, dirty = true, tree, disposed = false, focused = 0, shows = 0, afterDispose = 0, timerId = 0;
  const trigger = { isConnected: true, focus() { focused++; } };
  const dialog = { open: false, showModal() { this.open = true; shows++; }, close() { this.open = false; } };
  const react = {
    lazy() { return 'lazy-component'; }, Suspense: 'suspense',
    useState(initialValue) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = { value: typeof initialValue === 'function' ? initialValue() : initialValue }; return [hooks[slot].value, value => { if (disposed) afterDispose++; const next = typeof value === 'function' ? value(hooks[slot].value) : value; if (!Object.is(next, hooks[slot].value)) { hooks[slot].value = next; dirty = true; } }]; },
    useRef(initialValue) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = { current: initialValue }; return hooks[slot]; },
    useEffect(effect, deps) { const slot = cursor++, previous = hooks[slot]; if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) effects.push(() => { previous?.cleanup?.(); hooks[slot] = { deps, effect, cleanup: effect() }; }); },
  };
  const view = { Fragment: 'fragment', element(type, attributes, ...children) {
    const props = { ...attributes, children };
    if (attributes?.ref) attributes.ref.current = type === 'dialog' ? dialog : { scrollWidth: 1200, clientWidth: 1200, scrollTo() {} };
    return { type, props };
  } };
  const require = id => {
    if (id === 'react') return react;
    if (id === 'lucide-react') return new Proxy({}, { get: () => 'icon' });
    if (id.endsWith('.css')) return {};
    if (id in imports) return imports[id];
    throw Error(`Unexpected dependency in isolated map test: ${id}`);
  };
  const module = { exports: {} }, media = { matches: false, addEventListener() {}, removeEventListener() {} };
  runInNewContext(source, { module, exports: module.exports, require, __view: view, document: { activeElement: trigger },
    window: { matchMedia: () => media }, localStorage: { getItem() { return ''; }, setItem() {} }, sessionStorage: {},
    ResizeObserver: class { observe() {} disconnect() {} }, AbortController,
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch() { assert.fail('Map views must not make application or provider requests.'); },
  });
  const dispose = () => { if (!disposed) { disposed = true; for (const hook of hooks) hook?.cleanup?.(); } }; t.after(dispose);
  return { dialog, trigger, timers, dispose, exports: module.exports, get tree() { return tree; }, get focused() { return focused; }, get shows() { return shows; }, get afterDispose() { return afterDispose; },
    setProps(next) { values = next; dirty = true; },
    replayEffects() { for (const hook of hooks) if (hook?.effect) { hook.cleanup?.(); hook.cleanup = hook.effect(); } },
    runTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
    async flush() { for (let n = 0; n < 30; n++) { if (dirty) { dirty = false; cursor = 0; tree = module.exports[exported](values); } while (effects.length) effects.shift()(); await new Promise(resolve => setImmediate(resolve)); if (!dirty && !effects.length) return; } throw Error('The map view did not settle.'); },
  };
}
function mountMap(t, initial = {}) {
  let closes = 0;
  const values = { open: true, motionEnabled: false, onClose() { closes++; }, ...initial };
  const app = mount(t, mapSource, 'SystemMap', values);
  return Object.assign(app, { values, getCloses: () => closes });
}

test('the native dialog contains only the isolated prepared viewer and truthful controls', async t => {
  const app = mountMap(t); await app.flush();
  assert.equal(app.dialog.open, true); assert.equal(app.shows, 1);
  assert.equal(app.tree.props['aria-labelledby'], 'system-map-title'); assert.equal(app.tree.props['aria-describedby'], 'system-map-description');
  assert.match(text(app.tree), /Illustrated architecture, not live traffic/); assert.match(text(app.tree), /prepared provider paths/);
  assert.match(text(app.tree), /does not establish a request, approval or payment/);
  assert.match(text(app.tree), /starts Still.*Live.*Play story.*Still/); assert.match(text(app.tree), /reduced-motion preferences/);
  assert.match(text(app.tree), /Office motion is off\. Map playback uses its own controls/);
  assert.equal(frame(app).props.src, '/system-map.html?theme=dark'); assert.equal(frame(app).props.sandbox, 'allow-scripts');
  assert.equal(frame(app).props.referrerPolicy, 'no-referrer'); assert.ok(frame(app).props.title);
  assert.equal(nodes(app.tree).filter(node => ['form', 'a', 'input', 'audio'].includes(node.type)).length, 0);
});

test('closed maps have no iframe or loading timer; load completion clears the real-frame status', async t => {
  const app = mountMap(t, { open: false }); await app.flush();
  assert.equal(app.dialog.open, false); assert.equal(frame(app), undefined); assert.equal(app.timers.size, 0);
  app.setProps(app.values = { ...app.values, open: true }); await app.flush();
  assert.match(text(app.tree), /Loading the prepared system map/); assert.equal(app.timers.size, 1);
  frame(app).props.onLoad(); await app.flush(); assert.doesNotMatch(text(app.tree), /Loading the prepared system map/); assert.equal(app.timers.size, 0);
});

test('slow or failed loading offers a retry without inventing a replacement map', async t => {
  const app = mountMap(t); await app.flush(); app.runTimers(); await app.flush();
  assert.match(text(app.tree), /taking longer to open/); assert.ok(frame(app));
  const previous = frame(app); previous.props.onError(); await app.flush();
  assert.equal(frame(app), undefined); assert.match(text(app.tree), /System map unavailable/);
  button(app, 'Reload map').props.onClick(); await app.flush();
  assert.ok(frame(app)); assert.notEqual(frame(app).props.key, previous.props.key); assert.match(text(app.tree), /Loading the prepared system map/);
  previous.props.onLoad(); await app.flush(); assert.match(text(app.tree), /Loading the prepared system map/);
  frame(app).props.onLoad(); await app.flush(); assert.doesNotMatch(text(app.tree), /Loading the prepared system map/);
});

test('Escape, the explicit close button and true backdrop clicks close accessibly and return focus', async t => {
  for (const close of [app => button(app, 'Close System map').props.onClick(), app => app.tree.props.onCancel({ preventDefault() { this.prevented = true; } }), app => app.tree.props.onClick({ target: app.dialog, currentTarget: app.dialog })]) {
    const app = mountMap(t); await app.flush();
    app.tree.props.onClick({ target: {}, currentTarget: app.dialog }); assert.equal(app.getCloses(), 0);
    close(app); assert.equal(app.getCloses(), 1);
    app.setProps({ ...app.values, open: false }); await app.flush();
    assert.equal(app.dialog.open, false); assert.equal(app.focused, 1); assert.equal(frame(app), undefined); assert.equal(app.timers.size, 0); app.dispose();
  }
});

test('unmounting cancels work and stale frame or retry callbacks cannot act after reopening', async t => {
  const app = mountMap(t); await app.flush(); const staleFrame = frame(app), staleRetry = button(app, 'Reload map').props.onClick;
  app.setProps({ ...app.values, open: false }); await app.flush(); app.setProps(app.values); await app.flush();
  const freshKey = frame(app).props.key; staleRetry(); staleFrame.props.onLoad(); await app.flush();
  assert.equal(frame(app).props.key, freshKey); assert.match(text(app.tree), /Loading the prepared system map/);
  const currentFrame = frame(app); app.dispose(); currentFrame.props.onError(); staleRetry();
  assert.equal(app.dialog.open, false); assert.equal(app.timers.size, 0); assert.equal(app.afterDispose, 0);
});

test('React strict effect replay retains the loading guard and the disconnected trigger is not refocused', async t => {
  const app = mountMap(t); await app.flush(); app.replayEffects();
  frame(app).props.onLoad(); await app.flush(); assert.doesNotMatch(text(app.tree), /Loading the prepared system map/);
  app.trigger.isConnected = false; const before = app.focused; app.dispose(); assert.equal(app.focused, before);
});

function mountOffice(t) {
  const cases = ['first', 'second'].map(id => ({ id, caseId: `DEMO-${id}`, title: 'Synthetic saved case', revision: 1, status: 'ready', stage: 'reception', orderTotalMinor: 2000, evidence: [], checks: [], events: [] }));
  const data = { cases, capabilities: { payments: 'local' }, policy: {}, orders: [] }, calls = [];
  const api = async (path, options) => { calls.push({ path, options }); if (path === '/bootstrap') return structuredClone(data); const saved = cases.find(item => path === '/cases/' + item.id); assert.ok(saved, 'Only bootstrap or a selected saved case may be read.'); assert.equal(options?.method, undefined); return structuredClone(saved); };
  const jsxPaths = ['./OfficeLife.jsx', './OfficeAmbience.jsx', './CaseTray.jsx', './CaseInbox.jsx', './ReviewActions.jsx', './ApprovalActions.jsx', './OperationsControls.jsx', './IntakeOffice.jsx', './SponsorActions.jsx', './PaymentAuthorisation.jsx', './EvidenceClarification.jsx', './CustomerDraft.jsx', './CaseDownload.jsx', './JudgeReplay.jsx', './DemoBrief.jsx', './SystemMap.jsx', './CanvasBoundary.jsx', './RuntimeAccess.jsx'];
  const imports = Object.fromEntries(jsxPaths.map(path => [path, new Proxy({}, { get: (_, name) => String(name) })]));
  Object.assign(imports, { './case-view.js': caseView, './intake-state.js': intakeState, './runtime-access.js': runtimeAccess, './api.js': { api } });
  return { app: mount(t, officeSource, 'TestOffice', { runtimeAccess: null }, imports), calls, data };
}

test('office map navigation is mutually exclusive and receives no case, API or financial actions', async t => {
  const { app, calls, data } = mountOffice(t), original = JSON.stringify(data); await app.flush();
  for (const [label, target] of [['Demo brief', 'DemoBrief'], ['Judge mode', 'JudgeReplay'], ['Case canvas', 'CaseCanvasDialog'], ['Brief me', 'BriefingDialog'], ['View evidence', 'Inspector']]) {
    button(app, 'System map').props.onClick(); await app.flush();
    const map = component(app, 'SystemMap'); assert.equal(map.props.open, true);
    assert.deepEqual(Object.keys(map.props).filter(key => key !== 'children').sort(), ['motionEnabled', 'onClose', 'open']);
    assert.equal(component(app, 'DemoBrief').props.open, false); assert.equal(component(app, 'JudgeReplay').props.open, false);
    assert.equal(component(app, 'CaseCanvasDialog'), undefined); assert.equal(component(app, 'Inspector').props.panel, null);
    button(app, label).props.onClick(); await app.flush();
    assert.equal(component(app, 'SystemMap').props.open, false);
    const destination = component(app, target); assert.ok(destination); if ('open' in destination.props) assert.equal(destination.props.open, true);
  }
  button(app, 'System map').props.onClick(); await app.flush(); component(app, 'SystemMap').props.onClose(); await app.flush();
  assert.equal(component(app, 'SystemMap').props.open, false);
  assert.deepEqual(calls.map(call => call.path), ['/bootstrap']); assert.equal(JSON.stringify(data), original);
});

test('selecting another case closes the map and the session generation remains the office unmount boundary', async t => {
  const { app, calls } = mountOffice(t); await app.flush(); button(app, 'System map').props.onClick(); await app.flush();
  await component(app, 'CaseTray').props.onSelect('second'); await app.flush();
  assert.equal(component(app, 'SystemMap').props.open, false); assert.deepEqual(calls.map(call => call.path), ['/bootstrap', '/cases/second']);
  const boundary = app.exports.App(), office = boundary.props.children[0]({ generation: 42 }); assert.equal(office.props.key, 42);
});
