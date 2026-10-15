import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { buildCaseProvenance } from '../server/case-provenance.mjs';
import { verifyPreparedMiroMap } from '../src/miro-map-view.js';
import * as helpers from '../src/case-canvas.js';
import * as voiceHelpers from '../src/canvas-voice.js';

const props = () => ({ scenario: { id: 'case-1', caseId: 'RF-2008', revision: 4 }, principalKey: 'workspace:run:reviewer' });
function boardFor(scenario = props().scenario) {
  return buildCaseProvenance({ mode: 'local-postgres-rehearsal', synthetic: true, paymentSubmissionEnabled: false, case: {
    ...scenario, title: 'Ambiguous missing items', complaint: 'Something did not arrive. Please investigate.', outcome: 'held', proposedAmountMinor: 1000,
    proposal: { source: 'local', issue: 'item_missing', amountMinor: 1000, reason: 'The customer has not identified which saved order item is missing.', evidenceIds: ['packing:order-1'] },
    evidence: [
      { id: 'order:order-1', title: 'Order record', source: 'Synthetic catalogue', body: 'Sketchbook £10. Marker set £12.' },
      { id: 'packing:order-1', title: 'Packing record', source: 'Synthetic catalogue', body: 'The Sketchbook and Marker set were not packed.' },
      { id: 'delivery:order-1', title: 'Delivery record', source: 'Synthetic catalogue', body: 'Delivered with no recorded dispute.' },
      { id: 'remedies:order-1', title: 'Previous remedies', source: 'Synthetic catalogue', body: 'No existing remedy.' },
    ],
    checks: Array.from({ length: 8 }, (_, index) => ({ id: 'check-' + index, label: 'Saved check ' + (index + 1), pass: index !== 0, detail: index === 0 ? 'Missing item is not yet identified.' : 'Passed the saved check.' })),
    events: [],
  } });
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const source = transformSync(readFileSync(new URL('../src/CaseCanvas.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsxFactory: '__view.element', jsxFragment: '__view.fragment' }).code;
function mount(t, initial, client) {
  const hooks = [], effects = []; let values = initial, api = client, cursor = 0, dirty = true, tree, disposed = false, afterDispose = 0;
  const react = {
    useCallback(value, deps) { const slot = cursor++, previous = hooks[slot]; if (!previous || deps.some((dep, index) => !Object.is(dep, previous.deps[index]))) hooks[slot] = { deps, value }; return hooks[slot].value; },
    useState(initialValue) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = { value: typeof initialValue === 'function' ? initialValue() : initialValue }; return [hooks[slot].value, value => { if (disposed) afterDispose++; hooks[slot].value = typeof value === 'function' ? value(hooks[slot].value) : value; dirty = true; }]; },
    useRef(initialValue) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = { current: initialValue }; return hooks[slot]; },
    useEffect(effect, deps) { const slot = cursor++, previous = hooks[slot]; if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) effects.push(() => { previous?.cleanup?.(); hooks[slot] = { deps, cleanup: effect() }; }); },
  };
  const view = { fragment: 'fragment', element(type, attributes, ...children) { return { type, props: { ...attributes, children } }; } };
  const module = { exports: {} };
  const require = id => {
    if (id === 'react') return react;
    if (id === './case-canvas.js') return helpers;
    if (id === './canvas-voice.js') return voiceHelpers;
    if (id === './CanvasAssistant.jsx') return { CanvasAssistant: 'case-assistant' };
    if (id === './miro-map-view.js') return { verifyPreparedMiroMap };
    if (id === './api.js') return { api: () => assert.fail('An injected API was not used.') };
    if (id === './CaseDownload.jsx') return { CaseDownload: 'case-download' };
    if (id === 'lucide-react') return new Proxy({}, { get: () => 'icon' });
    if (id.endsWith('.css')) return {};
    throw Error(id);
  };
  runInNewContext(source, { module, exports: module.exports, require, __view: view, AbortController });
  const dispose = () => { if (!disposed) { disposed = true; for (const hook of hooks) hook?.cleanup?.(); } }; t.after(dispose);
  return { dispose, get tree() { return tree; }, get afterDispose() { return afterDispose; }, setProps(next) { values = next; dirty = true; }, setClient(next) { api = next; dirty = true; },
    async flush() { for (let n = 0; n < 30; n++) { if (dirty) { dirty = false; cursor = 0; tree = module.exports.CaseCanvas({ ...values, apiClient: api }); } while (effects.length) effects.shift()(); await new Promise(resolve => setImmediate(resolve)); if (!dirty && !effects.length) return; } throw Error('The case canvas did not settle.'); } };
}
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '';
const button = (app, label) => nodes(app.tree).find(node => node.type === 'button' && text(node) === label);
const labelled = (app, label) => nodes(app.tree).find(node => node.props?.['aria-label'] === label);
const card = (app, title) => nodes(app.tree).find(node => node.type === 'button' && node.props?.className?.split(' ').includes('case-canvas-card') && node.props['aria-label'].startsWith(title + '.'));
const inspector = app => labelled(app, 'Selected record inspector');
const plane = app => nodes(app.tree).find(node => node.props?.className === 'case-canvas-plane');
const assistant = app => nodes(app.tree).find(node => node.type === 'case-assistant');
const key = (key, extra = {}) => ({ key, preventDefault() {}, stopPropagation() {}, ...extra });

test('case chat opens with a verified map and only reads case-scoped voice capabilities', async t => {
  const values = props(), board = boardFor(), calls = [];
  const app = mount(t, values, async (path, options) => {
    calls.push({ path, options });
    return path.endsWith('/board-export') ? board : { caseId: values.scenario.id, revision: values.scenario.revision, provider: 'elevenlabs', model: 'scribe_v2', available: false, configured: false, enabled: false };
  });
  await app.flush(); assert.equal(assistant(app), undefined);
  labelled(app, 'Toggle case assistant').props.onClick(); await app.flush();
  assert.equal(assistant(app).props.map.caseId, board.caseId);
  assert.equal(assistant(app).props.voiceStatus.available, false);
  assert.equal(calls.length, 2); assert.ok(calls.every(value => value.options.method === 'GET'));
  assert.equal(calls[1].path, '/cases/case-1/voice-input');
  const target = board.provenance.nodes.find(value => value.kind === 'investigation');
  assistant(app).props.onSelectNode(target.id); await app.flush();
  assert.equal(assistant(app).props.selectedNodeId, target.id); assert.ok(assistant(app));
});

test('unchanged canvas renders retain the voice callback while changed scope rejects its use', async t => {
  const values = props(), board = boardFor(), calls = [];
  const app = mount(t, values, async (path, options) => {
    calls.push({ path, options });
    return path.endsWith('/board-export') ? board : { caseId: values.scenario.id, revision: values.scenario.revision, provider: 'elevenlabs', model: 'scribe_v2', available: true, configured: true, enabled: true, text: 'Why is this held?' };
  });
  await app.flush(); labelled(app, 'Toggle case assistant').props.onClick(); await app.flush();
  const callback = assistant(app).props.transcribeAudio;
  app.setProps({ ...values, scenario: { ...values.scenario } }); await app.flush();
  assert.equal(assistant(app).props.transcribeAudio, callback);
  const blob = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1])], {type:'audio/webm'});
  assert.deepEqual(await callback({blob}), {text:'Why is this held?'});
  const before=calls.length;app.setProps({...values,principalKey:'different-reviewer'});await app.flush();
  const afterRead=calls.length;await assert.rejects(callback({blob}),/canvas changed/);
  assert.equal(calls.length,afterRead);assert.ok(afterRead>before);
});

test('a delayed voice capability result cannot expose a former case session', async t => {
  const values=props(),pending=deferred();let capabilitySignal;
  const app=mount(t,values,async(path,options)=>{if(path.endsWith('/board-export'))return boardFor();capabilitySignal=options.signal;return pending.promise;});
  await app.flush();labelled(app,'Toggle case assistant').props.onClick();await app.flush();
  app.setProps({...values,principalKey:'new-session'});await app.flush();assert.equal(capabilitySignal.aborted,true);
  pending.resolve({caseId:values.scenario.id,revision:4,provider:'elevenlabs',model:'scribe_v2',available:true,configured:true,enabled:true});await app.flush();
  assert.equal(assistant(app),undefined);
});

test('layout positions all nineteen real map records in the five stages without changing saved data', () => {
  const board = boardFor(), before = JSON.stringify(board), layout = helpers.layoutCaseCanvas(board.provenance.nodes);
  assert.equal(board.provenance.nodes.length, 19); assert.equal(Object.keys(layout.positions).length, 19);
  assert.deepEqual(layout.columns.map(column => column.id), ['sources', 'investigation', 'policy', 'decision', 'destinations']);
  for (const column of layout.columns) {
    const inColumn = board.provenance.nodes.filter(node => node.column === column.id);
    assert.equal(column.count, inColumn.length);
    for (let index = 0; index < inColumn.length; index++) {
      const point = layout.positions[inColumn[index].id]; assert.equal(point.x, column.x);
      if (index) assert.ok(point.y >= layout.positions[inColumn[index - 1].id].y + helpers.CANVAS_CARD.height);
    }
  }
  assert.equal(JSON.stringify(board), before);
});

test('search matches quoted references and relationship semantics and identifies connected records', () => {
  const graph = boardFor().provenance, packing = graph.nodes.find(node => node.title === 'Packing record'), investigation = graph.nodes.find(node => node.kind === 'investigation');
  const result = helpers.filterCaseCanvas(graph, 'packing:order-1');
  assert.ok(result.matches.has(packing.id)); assert.ok(result.related.has(investigation.id));
  assert.ok(result.edges.has(graph.edges.find(edge => edge.from === packing.id && edge.to === investigation.id).id));
  const relationship = helpers.filterCaseCanvas(graph, 'Gathered record; not cited');
  assert.ok(relationship.matches.has(investigation.id)); assert.ok(relationship.matches.has(graph.nodes.find(node => node.title === 'Delivery record').id));
  assert.equal(helpers.filterCaseCanvas(graph, 'definitely-no-record').matches.size, 0);
  assert.equal(helpers.filterCaseCanvas(graph, '').matches.size, graph.nodes.length);
});

test('navigation wraps predictably and connections retain their saved direction and labels', () => {
  const graph = boardFor().provenance, ordered = helpers.orderedCanvasNodes(graph.nodes), id = ordered[0].id;
  assert.equal(helpers.nextCanvasSelection(graph.nodes, id, -1), ordered.at(-1).id);
  assert.equal(helpers.nextCanvasSelection(graph.nodes, 'absent', -1), ordered.at(-1).id);
  assert.equal(helpers.nextCanvasSelection([], null), null);
  const edges = helpers.canvasConnections(graph, id); assert.equal(edges.incoming.length, 0); assert.ok(edges.outgoing.length > 0);
  assert.equal(edges.outgoing[0].edge.from, id); assert.equal(edges.outgoing[0].node.id, edges.outgoing[0].edge.to);
});

test('positions, focus and zoom are local view calculations with a readable fit and finite bounds', () => {
  const layout = helpers.layoutCaseCanvas(boardFor().provenance.nodes), firstId = Object.keys(layout.positions)[0], original = { ...layout.positions[firstId] };
  const moved = helpers.moveCanvasNode(layout.positions, firstId, 80, -1000);
  assert.deepEqual(layout.positions[firstId], original); assert.equal(moved[firstId].x, original.x + 80); assert.ok(moved[firstId].y >= helpers.CANVAS_CARD.heading);
  assert.equal(helpers.moveCanvasNode(layout.positions, firstId, NaN, 0), layout.positions);
  const fitted = helpers.fitCaseCanvas(layout, { width: 320, height: 220 }); assert.ok(fitted.zoom >= 0.85);
  const point = { x: 100, y: 100 }, base = { zoom: 1, pan: { x: 20, y: 30 } }, zoomed = helpers.zoomCaseCanvas(base, 1.5, point);
  assert.equal((point.x - zoomed.pan.x) / zoomed.zoom, (point.x - base.pan.x) / base.zoom);
  assert.equal(helpers.zoomCaseCanvas(base, 99, point).zoom, 1.8); assert.equal(helpers.zoomCaseCanvas(base, 0, point).zoom, 0.45);
  const focused = helpers.focusCanvasNode(original, { width: 800, height: 500 });
  assert.equal(focused.pan.x + (original.x + helpers.CANVAS_CARD.width / 2) * focused.zoom, 400);
});

test('the canvas reads exactly the board GET and exposes no approval or publication action', async t => {
  const calls = [], board = boardFor(), before = JSON.stringify(board);
  const app = mount(t, props(), async (path, options) => { calls.push({ path, options }); return board; }); await app.flush();
  assert.equal(calls.length, 1); assert.equal(calls[0].path, '/cases/case-1/board-export'); assert.equal(calls[0].options.method, 'GET'); assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.match(text(app.tree), /19 records/); assert.match(text(app.tree), /Saved revision 4/); assert.match(text(app.tree), /A recommendation is not approval/);
  assert.equal(nodes(app.tree).some(node => node.type === 'form'), false);
  assert.equal(nodes(app.tree).some(node => node.type === 'button' && /^(Approve|Publish|Submit|Send)/.test(text(node))), false);
  await labelled(app, 'Refresh saved case canvas').props.onClick(); await app.flush();
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.options.method === 'GET' && !call.options.body)); assert.equal(JSON.stringify(board), before);
});

test('search, selection and local positions survive list toggles and ordinary parent renders', async t => {
  let reads = 0; const app = mount(t, props(), async () => { reads++; return boardFor(); }); await app.flush();
  await card(app, 'Packing record').props.onClick(); await app.flush();
  const search = nodes(app.tree).find(node => node.type === 'input'); search.props.onChange({ target: { value: 'Sketchbook' } }); await app.flush();
  assert.equal(nodes(app.tree).find(node => node.type === 'input').props.value, 'Sketchbook'); assert.match(text(inspector(app)), /Packing record/);
  button(app, 'List').props.onClick(); await app.flush(); assert.match(text(inspector(app)), /Packing record/); assert.match(text(app.tree), /2 of 19 records match/);
  assert.equal(nodes(app.tree).find(node => node.type === 'input').props.value, 'Sketchbook');
  app.setProps({ ...props(), scenario: { ...props().scenario } }); await app.flush();
  button(app, 'Canvas').props.onClick(); await app.flush();
  assert.equal(card(app, 'Packing record').props['aria-pressed'], true); assert.equal(nodes(app.tree).find(node => node.type === 'input').props.value, 'Sketchbook'); assert.equal(reads, 1);
});

test('the inspector preserves long saved text and source URLs remain inert quoted references', async t => {
  const board = boardFor(), evidence = board.provenance.nodes.find(node => node.title === 'Packing record');
  evidence.text = 'BEGIN SAVED TEXT\n' + 'A precise source statement. '.repeat(100) + '\nEND SAVED TEXT';
  evidence.refs.push({ type: 'source-reference', id: 'javascript:alert("do not follow")' });
  const app = mount(t, props(), async () => board); await app.flush(); card(app, 'Packing record').props.onClick(); await app.flush();
  assert.ok(text(inspector(app)).includes(evidence.text)); assert.match(text(inspector(app)), /javascript:alert/);
  assert.equal(nodes(app.tree).some(node => node.type === 'a'), false); assert.equal(nodes(app.tree).some(node => node.props?.dangerouslySetInnerHTML), false);
  assert.match(text(inspector(app)), /Cited by the saved proposal/); assert.match(text(inspector(app)), /Outgoing/);
  const relation = nodes(inspector(app)).find(node => node.type === 'button' && text(node).includes('Saved investigation'));
  relation.props.onClick(); await app.flush(); assert.equal(card(app, 'Saved investigation').props['aria-pressed'], true); assert.match(text(inspector(app)), /Incoming/);
});

test('keyboard selection and local card movement do not change records or issue writes', async t => {
  const board = boardFor(), before = JSON.stringify(board); let reads = 0;
  const app = mount(t, props(), async () => { reads++; return board; }); await app.flush();
  const first = card(app, 'Original customer complaint'), initial = first.props.style.left;
  first.props.onKeyDown(key('ArrowRight', { shiftKey: true })); await app.flush(); assert.equal(card(app, 'Original customer complaint').props.style.left, initial + 24);
  button(app, 'Reset layout').props.onClick(); await app.flush(); assert.equal(card(app, 'Original customer complaint').props.style.left, initial);
  card(app, 'Original customer complaint').props.onKeyDown(key('ArrowRight')); await app.flush(); assert.equal(card(app, 'Order record').props['aria-pressed'], true);
  labelled(app, 'Zoom in').props.onClick(); await app.flush(); assert.match(text(labelled(app, 'Canvas zoom')), /120%/);
  button(app, 'Fit readable').props.onClick(); await app.flush(); assert.match(text(labelled(app, 'Canvas zoom')), /85%/);
  assert.equal(reads, 1); assert.equal(JSON.stringify(board), before);
});

test('pointer gestures pan the view and move cards without persisting evidence or layout', async t => {
  const app = mount(t, props(), async () => boardFor()); await app.flush();
  const viewport = nodes(app.tree).find(node => node.props?.className === 'case-canvas-viewport'), target = { closest: () => null }, captured = new Set();
  const pointer = (x, y) => ({ button: 0, pointerId: 1, clientX: x, clientY: y, target, currentTarget: { setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id), releasePointerCapture: id => captured.delete(id), focus() {} }, preventDefault() {}, stopPropagation() {} });
  viewport.props.onPointerDown(pointer(100, 100)); viewport.props.onPointerMove(pointer(150, 180)); await app.flush();
  assert.match(plane(app).props.style.transform, /translate\(74px, 100px\)/); viewport.props.onPointerUp(pointer(150, 180)); assert.equal(captured.size, 0);
  const selected = card(app, 'Original customer complaint'), old = { left: selected.props.style.left, top: selected.props.style.top };
  selected.props.onPointerDown(pointer(100, 100)); selected.props.onPointerMove(pointer(185, 185)); await app.flush();
  assert.equal(card(app, 'Original customer complaint').props.style.left, old.left + 100); assert.equal(card(app, 'Original customer complaint').props.style.top, old.top + 100);
});

test('case, revision, principal, run and transport changes immediately hide the previous graph and abort its read', async t => {
  for (const change of ['case', 'revision', 'principal', 'run', 'transport']) {
    const replies = [deferred(), deferred()], calls = [];
    const client = (path, options) => { calls.push({ path, options }); return replies[calls.length - 1].promise; }; client.runId = 'run-a';
    const initial = props(), app = mount(t, initial, client); await app.flush();
    const next = props();
    if (change === 'case') next.scenario.id = 'case-2';
    if (change === 'revision') next.scenario.revision++;
    if (change === 'principal') next.principalKey = 'workspace:other-role';
    if (change === 'run') client.runId = 'run-b';
    if (change === 'transport') { const replacement = (path, options) => { calls.push({ path, options }); return replies[1].promise; }; replacement.runId = 'run-a'; app.setClient(replacement); }
    app.setProps(next); await app.flush(); assert.equal(calls.length, 2); assert.equal(calls[0].options.signal.aborted, true);
    replies[0].resolve(boardFor()); await app.flush(); assert.equal(card(app, 'Original customer complaint'), undefined);
    replies[1].resolve(boardFor(next.scenario)); await app.flush(); assert.ok(card(app, 'Original customer complaint')); assert.match(text(app.tree), new RegExp('Saved revision ' + next.scenario.revision)); app.dispose();
  }
});

test('loaded graphs and stale controls cannot cross workspace changes or unmount', async t => {
  const waiting = deferred(); let reads = 0;
  const app = mount(t, props(), async () => ++reads === 1 ? boardFor() : waiting.promise); await app.flush();
  const staleRefresh = labelled(app, 'Refresh saved case canvas').props.onClick, staleMove = card(app, 'Original customer complaint').props.onKeyDown;
  app.setProps({ ...props(), principalKey: 'different-workspace' }); await app.flush(); assert.equal(card(app, 'Original customer complaint'), undefined);
  staleRefresh(); staleMove(key('ArrowRight', { shiftKey: true })); await app.flush(); assert.equal(reads, 2);
  app.dispose(); waiting.resolve(boardFor()); await new Promise(resolve => setImmediate(resolve)); assert.equal(app.afterDispose, 0);
});

test('malformed identities, later revisions, broken edges and arbitrary links fail closed', async t => {
  for (const change of [board => { board.revision++; }, board => { board.caseRecordId = 'another-case'; }, board => { board.provenance.edges[0].to = 'absent'; }, board => { board.provenance.nodes[0].links.push({ label: 'Unsafe source', path: 'https://source.example/private' }); }, board => { board.provenance.nodes[0].id = board.provenance.nodes[1].id; }]) {
    const value = boardFor(); change(value); const app = mount(t, props(), async () => value); await app.flush();
    assert.ok(nodes(app.tree).some(node => node.props?.role === 'alert')); assert.equal(card(app, 'Original customer complaint'), undefined); assert.equal(nodes(app.tree).some(node => node.type === 'case-download'), false); app.dispose();
  }
});

test('record downloads are restricted to validated current-case paths and bound to the current run', async t => {
  const client = async () => boardFor(); client.runId = 'the-bound-run'; const app = mount(t, props(), client); await app.flush();
  card(app, 'Saved case export available').props.onClick(); await app.flush();
  const downloads = nodes(inspector(app)).filter(node => node.type === 'case-download');
  assert.deepEqual(downloads.map(node => node.props.href), ['/api/cases/case-1', '/api/cases/case-1/export']);
  assert.ok(downloads.every(node => node.props.runId === 'the-bound-run')); assert.match(text(inspector(app)), /may contain a later revision/);
});

test('a saved pending case displays waiting records without fabricating an investigation or approval', async t => {
  const board = buildCaseProvenance({ synthetic: true, paymentSubmissionEnabled: false, case: { ...props().scenario, complaint: 'New request', evidence: [], checks: [], events: [] } });
  const app = mount(t, props(), async () => board); await app.flush(); card(app, 'Saved investigation').props.onClick(); await app.flush();
  assert.match(text(inspector(app)), /No completed investigation proposal is saved/); assert.match(text(inspector(app)), /Waiting/);
  card(app, 'Human decision pending').props.onClick(); await app.flush(); assert.match(text(inspector(app)), /No current refund approval/);
});

test('hosted payment uncertainty and synthetic historical remedies retain the saved scope', async t => {
  for (const hosted of [true, false]) {
    const packet = { mode: hosted ? 'hosted-supabase' : 'local-postgres-rehearsal', synthetic: true, case: { ...props().scenario, complaint: 'Saved', evidence: [], checks: [], events: [], outcome: hosted ? 'approved-not-submitted' : 'already-resolved', operationId: 'original-operation', ...(hosted ? { approval: { state: 'approved', actor: 'reviewer', amountMinor: 1000 } } : { receipt: { seeded: true, id: 'historical-receipt', status: 'succeeded' } }) } };
    const app = mount(t, props(), async () => buildCaseProvenance(packet)); await app.flush(); card(app, hosted ? 'Payment record' : 'Seeded historical remedy').props.onClick(); await app.flush();
    assert.match(text(inspector(app)), hosted ? /does not establish whether a separate refund was submitted/ : /supplied synthetic history, not a new refund/); app.dispose();
  }
});

test('invalid display identity makes no request and a failed GET can be retried without a write', async t => {
  const denied = mount(t, { ...props(), principalKey: '' }, () => assert.fail('No request without a verified display scope.')); await denied.flush(); assert.match(text(denied.tree), /workspace identity are required/);
  let calls = 0; const app = mount(t, props(), async (_, options) => { assert.equal(options.method, 'GET'); if (!calls++) throw Error('Local read unavailable.'); return boardFor(); }); await app.flush();
  assert.match(text(app.tree), /Local read unavailable/); button(app, 'Read saved case again').props.onClick(); await app.flush(); assert.ok(card(app, 'Original customer complaint')); assert.equal(calls, 2);
});

test('Escape and the explicit close control return control to the parent without an API action', async t => {
  let closes = 0, reads = 0; const app = mount(t, { ...props(), onClose: () => closes++ }, async () => { reads++; return boardFor(); }); await app.flush();
  labelled(app, 'Close case canvas').props.onClick(); labelled(app, 'Case canvas for RF-2008').props.onKeyDown(key('Escape'));
  assert.equal(closes, 2); assert.equal(reads, 1);
});
