import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import * as helpers from '../src/judge-replay.js';
import { caseStatus } from '../src/case-view.js';

const props = () => ({ open: true, principalKey: 'workspace:reviewer:role', runId: '11111111-1111-4111-8111-111111111111', capabilities: {}, scenario: { id: 'case-8', caseId: 'RF-008', title: 'Missing sketchbook', revision: 5, runtime: true, status: 'review', summary: 'The recommendation needs a human decision.', proposedAmountMinor: 1000, approval: { state: 'required' }, proposal: { amountMinor: 1000, source: 'local', evidenceIds: ['packing-record'] }, evidence: [{ id: 'packing-record' }, { id: 'uncited-evidence' }], checks: [{ id: 'amount', status: 'pass' }], events: [
  { id: '9', at: '2026-10-14T10:00:00Z', type: 'intake.received', label: 'Request received', detail: 'Saved the request.' },
  { id: '10', at: '2026-10-14T10:00:00Z', type: 'investigation.recorded', label: 'Evidence checked', detail: 'Retrieved packing record.', payload: { evidenceIds: ['packing-record'], amountMinor: 1000 } },
  { id: '11', at: '2026-10-14T09:59:59Z', type: 'review.required', label: 'Awaiting reviewer', detail: 'No approval recorded.', actor: 'investigator-id' },
] }, onClose() {}, onInspect() {} });
const source = transformSync(readFileSync(new URL('../src/JudgeReplay.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsxFactory: '__view.element', jsxFragment: '__view.Fragment' }).code;
function mount(t, initial = props()) {
  const hooks = [], effects = [], timers = new Map(); let values = initial, cursor = 0, dirty = true, tree, disposed = false, nextTimer = 0, closes = 0, inspections = [];
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  values = { ...values, onClose() { closes++; }, onInspect(type) { inspections.push(type); } };
  const react = {
    useState(initial) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[slot].value, value => { const next = typeof value === 'function' ? value(hooks[slot].value) : value; if (!Object.is(next, hooks[slot].value)) { hooks[slot].value = next; dirty = true; } }]; },
    useRef(initial) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = { current: initial }; return hooks[slot]; },
    useEffect(effect, deps) { const slot = cursor++, previous = hooks[slot]; if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) effects.push(() => { previous?.cleanup?.(); hooks[slot] = { deps, cleanup: effect() }; }); },
  };
  const view = { Fragment: 'fragment', element(type, p, ...children) { const values = { ...p, children }; if (type === 'dialog' && p.ref) p.ref.current = dialog; return typeof type === 'function' ? type(values) : { type, props: values }; } };
  const module = { exports: {} };
  const require = id => { if (id === 'react') return react; if (id === './judge-replay.js') return helpers; if (id === './case-view.js') return { caseStatus }; if (id === './CaseDownload.jsx') return { CaseDownload: p => ({ type: 'run-bound-download', props: p }) }; if (id === 'lucide-react') return new Proxy({}, { get: () => 'icon' }); if (id.endsWith('.css')) return {}; throw Error(`Playback must not import a side-effect dependency: ${id}`); };
  runInNewContext(source, { module, exports: module.exports, require, __view: view, setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); }, fetch() { throw Error('Playback cannot contact a provider or mutation route.'); } });
  const dispose = () => { if (!disposed) { disposed = true; for (const hook of hooks) hook?.cleanup?.(); } }; t.after(dispose);
  return { dispose, timers, dialog, get tree() { return tree; }, get closes() { return closes; }, inspections, setProps(next) { values = { ...next, onClose: values.onClose, onInspect: values.onInspect }; dirty = true; },
    async flush() { for (let n = 0; n < 20; n++) { if (dirty) { dirty = false; cursor = 0; tree = module.exports.JudgeReplay(values); } while (effects.length) effects.shift()(); await new Promise(resolve => setImmediate(resolve)); if (!dirty && !effects.length) return; } throw Error('Did not settle'); },
    async tick() { const entry = timers.entries().next().value; if (!entry) return; timers.delete(entry[0]); entry[1].fn(); await this.flush(); } };
}
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '';
const button = (app, label) => nodes(app.tree).find(node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label));
const selected = app => nodes(app.tree).find(node => node.type === 'article' && node.props['aria-label'] === 'Selected saved event');
const field = (app, label) => nodes(app.tree).find(node => node.props?.['aria-label'] === label);

// In PostgreSQL this order comes from monotonically increasing event IDs. Local
// simulation uses append order; neither should be re-sorted by wall-clock time.
test('recorded ordering, tied timestamps and clock reversal survive without mutating the case', () => {
  const item = props().scenario, before = JSON.stringify(item), result = helpers.replayEvents(item);
  assert.deepEqual(result.map(event => event.id), ['9', '10', '11']);
  assert.deepEqual(result.map(event => event.replayIndex), [0, 1, 2]);
  assert.equal(JSON.stringify(item), before);
  item.events.push({ ...item.events[0] }); assert.equal(new Set(helpers.replayEvents(item).map(event => event.replayKey)).size, 4);
});

test('snapshots keep old facts separate, reject malformed entries and avoid invented timestamps', () => {
  const p = props(), scope = helpers.replayScope(p.scenario, p.principalKey, p.runId), snapshot = helpers.captureReplay(p.scenario, p.capabilities, scope);
  p.scenario.events[0].detail = 'Changed later'; assert.equal(snapshot.events[0].detail, 'Saved the request.');
  assert.equal(helpers.eventTime(null), 'Time not recorded'); assert.equal(helpers.eventTime('invalid'), 'Time not recorded');
  assert.match(helpers.eventTime('2026-10-14T10:00:00Z'), /11:00:00/);
  assert.equal(helpers.recordedAmount(undefined), 'Not recorded'); assert.equal(helpers.recordedAmount(1000), '£10.00');
  assert.throws(() => helpers.replayEvents({ events: [null] }), /could not be read/);
});

test('scope isolates case, workspace identity and run; playback positions and speeds are bounded', () => {
  const p = props(), original = helpers.replayScope(p.scenario, p.principalKey, p.runId);
  for (const args of [[{ id: 'other' }, p.principalKey, p.runId], [p.scenario, 'investigator', p.runId], [p.scenario, p.principalKey, 'another-run']]) assert.notEqual(helpers.replayScope(...args), original);
  assert.equal(helpers.replayPosition(-4, 3), 0); assert.equal(helpers.replayPosition(100, 3), 2); assert.equal(helpers.replayPosition('bad', 0), 0);
  assert.equal(helpers.replayDelay(4), 625); assert.equal(helpers.replayDelay(-1), 2500);
});

test('Judge mode starts paused and shows recorded facts separately from current case context', async t => {
  const app = mount(t); await app.flush(); assert.equal(app.dialog.open, true); assert.equal(app.timers.size, 0);
  assert.match(text(selected(app)), /Request received/); assert.match(text(app.tree), /Playback only/);
  assert.match(text(app.tree), /Awaiting approval/); assert.match(text(app.tree), /This does not establish what an earlier event cited/);
  assert.match(text(app.tree), /presentation speed, not the original elapsed time/);
  assert.equal(nodes(app.tree).some(node => node.type === 'form'), false);
});

test('play, speed, pause, step and seek change only playback, ending at the last saved event', async t => {
  const initial = props(), before = JSON.stringify(initial.scenario), app = mount(t, initial); await app.flush();
  button(app, 'Play history').props.onClick(); await app.flush(); assert.equal([...app.timers.values()][0].delay, 2500);
  field(app, 'Playback speed').props.onChange({ target: { value: '4' } }); await app.flush(); assert.equal([...app.timers.values()][0].delay, 625);
  await app.tick(); assert.match(text(selected(app)), /Evidence checked/); assert.match(text(selected(app)), /packing-record/);
  button(app, 'Pause playback').props.onClick(); await app.flush(); assert.equal(app.timers.size, 0);
  button(app, 'Previous saved event').props.onClick(); await app.flush(); assert.match(text(selected(app)), /Request received/);
  field(app, 'Seek saved event').props.onChange({ target: { value: '1' } }); await app.flush(); assert.match(text(selected(app)), /Evidence checked/);
  button(app, 'Play history').props.onClick(); await app.flush(); await app.tick(); assert.match(text(selected(app)), /Awaiting reviewer/); assert.equal(app.timers.size, 0); assert.ok(button(app, 'Replay from start'));
  button(app, 'Replay from start').props.onClick(); await app.flush(); assert.match(text(selected(app)), /Request received/);
  assert.equal(JSON.stringify(initial.scenario), before); assert.equal(app.inspections.length, 0);
});

test('revision change cancels playback and blocks stale handlers and links until explicit reload', async t => {
  const app = mount(t); await app.flush(); const staleLink = button(app, 'View saved evidence').props.onClick, stalePlay = button(app, 'Play history').props.onClick;
  stalePlay(); await app.flush(); const staleTick = [...app.timers.values()][0].fn;
  const next = props(); next.scenario.revision++; next.scenario.events.push({ id: '12', label: 'New saved clarification' }); app.setProps(next); await app.flush();
  assert.equal(app.timers.size, 0); assert.match(text(app.tree), /saved case has changed/); assert.equal(button(app, 'Play history').props.disabled, true);
  staleLink(); stalePlay(); staleTick(); await app.flush(); assert.equal(app.inspections.length, 0); assert.equal(app.timers.size, 0);
  assert.equal(nodes(app.tree).filter(node => node.type === 'run-bound-download').length, 0);
  button(app, 'Load latest saved history').props.onClick(); await app.flush(); assert.equal(button(app, 'Play history').props.disabled, false); assert.match(text(app.tree), /New saved clarification/);
});

test('same-revision evidence change is detected instead of mixing snapshots', async t => {
  const app = mount(t); await app.flush(); const next = props(); next.scenario.evidence.push({ id: 'later-source' }); app.setProps(next); await app.flush();
  assert.match(text(app.tree), /saved case has changed/); assert.match(text(app.tree), /2 records/); assert.doesNotMatch(text(app.tree), /3 records/);
});

test('case, run and principal switches close replay and invalidate old interaction handlers', async t => {
  for (const change of [p => { p.scenario.id = 'other'; }, p => { p.runId = '22222222-2222-4222-8222-222222222222'; }, p => { p.principalKey = 'workspace:investigator:role'; }]) {
    const app = mount(t); await app.flush(); const stale = button(app, 'View saved decisions').props.onClick;
    const next = props(); change(next); app.setProps(next); await app.flush(); stale(); await app.flush(); assert.equal(app.closes, 1); assert.equal(app.dialog.open, false); assert.equal(app.inspections.length, 0); assert.equal(text(app.tree), ''); app.dispose();
  }
});

test('read-only navigation passes only inspector types and report downloads keep the original run', async t => {
  const app = mount(t); await app.flush(); const download = nodes(app.tree).find(node => node.type === 'run-bound-download');
  assert.equal(download.props.href, '/api/cases/case-8/report'); assert.equal(download.props.runId, props().runId);
  for (const [label, type] of [['View saved evidence', 'evidence'], ['View saved checks', 'policy'], ['View saved decisions', 'history']]) { button(app, label).props.onClick(); assert.equal(app.inspections.at(-1), type); }
  assert.equal(app.closes, 3);
});

test('empty history cannot start work and missing timestamps stay unknown', async t => {
  const p = props(); p.scenario.events = []; const app = mount(t, p); await app.flush(); assert.match(text(app.tree), /No saved events yet/); assert.equal(button(app, 'Play history').props.disabled, true); assert.equal(app.timers.size, 0);
  const next = props(); next.scenario.events = [{ id: 'no-time', label: 'Saved without timestamp' }]; app.setProps(next); await app.flush(); button(app, 'Load latest saved history').props.onClick(); await app.flush(); assert.match(text(selected(app)), /Time not recorded/); assert.match(text(selected(app)), /No detail was saved/);
});

test('keyboard seeking works outside controls and preserves their native keyboard behaviour', async t => {
  const app = mount(t); await app.flush(); let prevented = 0;
  const key = (key, control = false) => app.tree.props.onKeyDown({ key, target: { closest: () => control }, preventDefault() { prevented++; } });
  key('ArrowRight'); await app.flush(); assert.match(text(selected(app)), /Evidence checked/);
  key('End'); await app.flush(); assert.match(text(selected(app)), /Awaiting reviewer/);
  key('Home'); await app.flush(); assert.match(text(selected(app)), /Request received/);
  key(' ', true); await app.flush(); assert.equal(app.timers.size, 0); assert.equal(prevented, 3);
  key(' '); await app.flush(); assert.equal(app.timers.size, 1);
});

test('hosted reservations and historical remedies do not claim a fresh successful payment', async t => {
  const p = props(); p.capabilities = { hosted: true, separateTestExecutionConfigured: true }; p.scenario.status = 'reserved'; p.scenario.outcome = 'approved-not-submitted'; p.scenario.approval.state = 'approved';
  const app = mount(t, p); await app.flush(); assert.match(text(app.tree), /Original approval saved/); assert.match(text(app.tree), /does not establish the payment outcome/); assert.doesNotMatch(text(app.tree), /No payment was made/);
  const next = props(); next.scenario.receipt = { seeded: true }; app.setProps(next); await app.flush(); button(app, 'Load latest saved history').props.onClick(); await app.flush(); assert.match(text(app.tree), /labelled historical remedy/);
});

test('closing or unmounting cancels timers and prevents stale navigation', async t => {
  const app = mount(t); await app.flush(); button(app, 'Play history').props.onClick(); await app.flush(); const stale = button(app, 'View saved checks').props.onClick;
  app.setProps({ ...props(), open: false }); await app.flush(); stale(); assert.equal(app.inspections.length, 0); assert.equal(app.timers.size, 0); assert.equal(app.dialog.open, false);
  app.setProps(props()); await app.flush(); assert.match(text(selected(app)), /Request received/); app.dispose(); stale(); assert.equal(app.inspections.length, 0);
});

test('App integration opens a read-only inspector without decision retry, rerun or approval controls', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /onInspect=\{type => setPanel\(\{ type, replayReadOnly: true \}\)\}/);
  assert.match(app, /!panel\.replayReadOnly && !runtime && \['complete', 'review'\]/);
  assert.match(app, /!panel\.replayReadOnly && pendingDecision/);
  assert.match(app, /!panel\.replayReadOnly && needsApproval/);
});
