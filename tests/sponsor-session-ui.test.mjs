import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import * as resetHelpers from '../src/reset-demo-state.js';
import { bindRunApi } from '../src/api.js';
import * as miroHelpers from '../src/miro-map-view.js';
import { buildCaseProvenance } from '../server/case-provenance.mjs';

const sources = Object.fromEntries(['RuntimeAccess', 'SponsorActions'].map(name => [name, transformSync(readFileSync(new URL(`../src/${name}.jsx`, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsxFactory: '__view.element', jsxFragment: '__view.Fragment' }).code]));
const storage = () => { const entries = new Map(); return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) }; };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

// Exercise the actual component's event handlers and effects without a browser or
// provider connection. This small hook host does not replace React layout tests.
function mount(t, source, name, props, { api, sessionStorage = storage(), fetch = () => { throw Error('Unexpected network request'); } }) {
  const hooks = [], effects = [], window = new EventTarget(), document = new EventTarget();
  document.hidden = false;
  let cursor = 0, dirty = true, tree, disposed = false;
  const react = {
    useState(initial) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[slot].value, value => { hooks[slot].value = typeof value === 'function' ? value(hooks[slot].value) : value; dirty = true; }]; },
    useRef(initial) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = { current: initial }; return hooks[slot]; },
    useMemo(factory, deps) { const slot = cursor++, previous = hooks[slot]; if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) hooks[slot] = { deps, value: factory() }; return hooks[slot].value; },
    useId() { return `test-${cursor++}`; },
    useEffect(effect, deps) { const slot = cursor++, previous = hooks[slot]; if (!previous || !deps || deps.some((value, index) => !Object.is(value, previous.deps[index]))) { effects.push(() => { previous?.cleanup?.(); hooks[slot] = { deps, cleanup: effect() }; }); } },
  };
  const view = { Fragment: 'fragment', element(type, props, ...children) { props = { ...props, children }; return typeof type === 'function' ? type(props) : { type, props }; } };
  const module = { exports: {} };
  const require = id => {
    if (id === 'react') return react;
    if (id === './api.js') return { api, bindRunApi: runId => bindRunApi(runId, api) };
    if (id === './ResetDemo.jsx') return { ResetDemo: 'reset-controller' };
    if (id === './reset-demo-state.js') return resetHelpers;
    if (id === './miro-map-view.js') return miroHelpers;
    if (id === './CaseDownload.jsx') return { CaseDownload: 'case-download' };
    if (id === 'lucide-react') return new Proxy({}, { get: () => 'icon' });
    if (id === './OperationsControls.jsx') return { OperationsDialog: 'dialog' };
    if (id === './runtime-access.js') return {};
    if (id.endsWith('.css')) return {};
    throw Error(`Unexpected import: ${id}`);
  };
  runInNewContext(sources[source], { module, exports: module.exports, require, __view: view, window, document, sessionStorage, fetch, AbortController, Blob, URL, crypto: { randomUUID: () => 'saved-command' }, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {} });
  const Component = module.exports[name];
  const dispose = () => { if (!disposed) { disposed = true; for (const hook of hooks) hook?.cleanup?.(); } };
  t.after(dispose);
  return {
    window, sessionStorage, dispose, setProps(value) { props = value; dirty = true; },
    get tree() { return tree; },
    async flush() { for (let attempt = 0; attempt < 20; attempt++) { if (dirty) { dirty = false; cursor = 0; tree = Component(props); } while (effects.length) effects.shift()(); await new Promise(resolve => setImmediate(resolve)); if (!dirty && !effects.length) return; } throw Error('Component did not settle'); },
  };
}
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '';
const button = (app, label) => nodes(app.tree).find(node => node.type === 'button' && text(node) === label);
const form = app => nodes(app.tree).find(node => node.type === 'form');
const active = { mode: 'hosted-supabase', authenticated: true, passwordSignIn: true, workspace: { id: 'workspace', title: 'Synthetic workspace' }, session: { userId: 'reviewer', role: 'reviewer', expiresAt: '2099-01-01T00:00:00Z' } };
const signedOut = { ...active, authenticated: false, session: null, logoutPending: false };
const pending = { ...signedOut, logoutPending: true, durableRevocationConfirmed: false, providerRevocationConfirmed: false };
const ended = { ...signedOut, durableRevocationConfirmed: true, providerRevocationConfirmed: true };
const office = access => ({ type: 'office', props: { access, children: 'Visible office cases' } });
const noOffice = app => assert.ok(!nodes(app.tree).some(node => node.type === 'office'));

test('unchanged session synchronisation preserves the case request transport', async t => {
  const app = mount(t, 'RuntimeAccess', 'RuntimeSessionBoundary', { children: office }, { api: async () => structuredClone(active) });
  await app.flush();
  const first = nodes(app.tree).find(node => node.type === 'office').props.access;
  for (let index = 0; index < 3; index++) {
    app.window.dispatchEvent(new Event('focus')); await app.flush();
    const next = nodes(app.tree).find(node => node.type === 'office').props.access;
    assert.equal(next.request, first.request);
    assert.equal(next.generation, first.generation);
  }
});

test('workspace, run, account, profile, role and expiry changes replace the request transport', async t => {
  for (const alter of [
    value => { value.workspace.id = 'another-workspace'; },
    value => { value.demoRun = { id: '7a46d0ce-790c-4f63-b43c-3dbcefc76831', packId: 'focused-12', resetSupported: true }; },
    value => { value.session.userId = 'another-reviewer'; },
    value => { value.session.profileId = 'another-profile'; },
    value => { value.session.role = 'investigator'; },
    value => { value.session.expiresAt = '2099-01-02T00:00:00Z'; },
  ]) {
    let current = structuredClone(active);
    const app = mount(t, 'RuntimeAccess', 'RuntimeSessionBoundary', { children: office }, { api: async () => structuredClone(current) });
    await app.flush(); const first = nodes(app.tree).find(node => node.type === 'office').props.access;
    alter(current); app.window.dispatchEvent(new Event('focus')); await app.flush();
    const next = nodes(app.tree).find(node => node.type === 'office').props.access;
    assert.notEqual(next.request, first.request);
    app.dispose();
  }
});

test('session expiry hides the office and a later authenticated entry gets a new transport', async t => {
  const app = mount(t, 'RuntimeAccess', 'RuntimeSessionBoundary', { children: office }, { api: async () => structuredClone(active) });
  await app.flush(); const first = nodes(app.tree).find(node => node.type === 'office').props.access;
  app.window.dispatchEvent(new Event('refund-office:session-expired')); await app.flush(); noOffice(app);
  app.window.dispatchEvent(new Event('focus')); await app.flush();
  const next = nodes(app.tree).find(node => node.type === 'office').props.access;
  assert.notEqual(next.request, first.request);
  assert.ok(next.generation > first.generation);
});

test('server pending logout hides sign-in and retries End session until confirmed', async t => {
  const calls = [];
  const app = mount(t, 'RuntimeAccess', 'RuntimeSessionBoundary', { children: office }, { api: async (path, options = {}) => { calls.push([path, options.method || 'GET']); return options.method === 'DELETE' ? ended : pending; } });
  await app.flush(); noOffice(app); assert.equal(form(app), undefined);
  assert.ok(button(app, 'Retry End session'));
  assert.match(text(app.tree), /Finish ending your session/);
  assert.doesNotMatch(text(app.tree), /browser session.*closed|browser credentials.*cleared/);
  app.window.dispatchEvent(new Event('focus')); await app.flush();
  assert.ok(button(app, 'Retry End session')); assert.equal(form(app), undefined);
  await button(app, 'Retry End session').props.onClick(); await app.flush();
  assert.ok(form(app)); assert.equal(button(app, 'Retry End session'), undefined);
  assert.equal(app.sessionStorage.getItem('refund-office:logout-pending'), null);
  assert.deepEqual(calls.map(row => row[1]), ['GET', 'GET', 'DELETE']);
});

test('lost logout closes cases immediately and an active GET cannot reopen them', async t => {
  const reply = deferred(), calls = []; let current = active;
  const app = mount(t, 'RuntimeAccess', 'RuntimeSessionBoundary', { children: office }, { api: (path, options = {}) => { calls.push([path, options.method || 'GET']); return options.method === 'DELETE' ? reply.promise : Promise.resolve(current); } });
  await app.flush(); const formerAccess = nodes(app.tree).find(node => node.type === 'office').props.access;
  const ending = formerAccess.logout(); await app.flush(); noOffice(app); assert.equal(form(app), undefined);
  assert.ok(button(app, 'Ending session…').props.disabled);
  reply.reject(Error('Lost response')); await ending; await app.flush();
  await formerAccess.refreshSession(); assert.ok(!calls.some(row => row[0] === '/session/refresh'));
  app.window.dispatchEvent(new Event('focus')); await app.flush(); noOffice(app); assert.equal(form(app), undefined);
  assert.ok(button(app, 'Retry End session'));
  current = signedOut; await button(app, 'Check session status').props.onClick(); await app.flush();
  assert.ok(form(app)); noOffice(app);
});

test('uncertain logout intent survives a page remount and stale login handlers stay blocked', async t => {
  const saved = storage(); let current = signedOut, posts = 0;
  const api = async (_, options = {}) => { if (options.method === 'POST') { posts++; return active; } return current; };
  const app = mount(t, 'RuntimeAccess', 'RuntimeSessionBoundary', { children: office }, { api, sessionStorage: saved });
  await app.flush(); const staleSignIn = form(app).props.onSubmit;
  current = pending; app.window.dispatchEvent(new Event('focus')); await app.flush();
  await staleSignIn({ preventDefault() {} }); assert.equal(posts, 0); app.dispose();
  current = active;
  const reloaded = mount(t, 'RuntimeAccess', 'RuntimeSessionBoundary', { children: office }, { api, sessionStorage: saved });
  await reloaded.flush(); noOffice(reloaded); assert.equal(form(reloaded), undefined); assert.ok(button(reloaded, 'Retry End session'));
});

test('stale session reads and malformed logout responses cannot release the logout guard', async t => {
  const stale = deferred(); let reads = 0;
  const app = mount(t, 'RuntimeAccess', 'RuntimeSessionBoundary', { children: office }, { api: (_, options = {}) => options.method === 'DELETE' ? Promise.resolve({ ...ended, session: active.session }) : ++reads === 2 ? stale.promise : Promise.resolve(active) });
  await app.flush(); const access = nodes(app.tree).find(node => node.type === 'office').props.access;
  app.window.dispatchEvent(new Event('focus'));
  await access.logout(); await app.flush(); stale.resolve(active); await app.flush();
  noOffice(app); assert.equal(form(app), undefined); assert.ok(button(app, 'Retry End session'));
});

test('provider-only revocation failure permits sign-in after the office session has ended', async t => {
  const app = mount(t, 'RuntimeAccess', 'RuntimeSessionBoundary', { children: office }, { api: async (_, options = {}) => options.method === 'DELETE' ? { ...ended, providerRevocationConfirmed: false } : active });
  await app.flush(); await nodes(app.tree).find(node => node.type === 'office').props.access.logout(); await app.flush();
  noOffice(app); assert.ok(form(app)); assert.equal(button(app, 'Retry End session'), undefined);
  assert.match(text(app.tree), /full account session revocation was not confirmed/);
});

const scenario = { id: 'case-1', caseId: 'SYN-C001', revision: 3, evidence: [{ id: 'evidence-1', title: 'Saved packing record' }] };
const sponsorStatus = { mode: 'external-enabled', actions: Object.fromEntries(['voice', 'miro', 'modal', 'port'].map(action => [action, { configured: true }])), records: [{ action: 'miro', commandId: 'miro-command', state: 'succeeded', verified: true }, { action: 'port', commandId: 'port-command', state: 'succeeded', verified: true }] };

test('saved sponsor readbacks describe member records without claiming independent database verification', async t => {
  const app = mount(t, 'SponsorActions', 'SponsorActions', { scenario, principalKey: 'workspace:reviewer' }, { api: async path => path.endsWith('/status') ? sponsorStatus : { records: [{ action: 'miro-card-1', verified: true }, { action: 'miro-card-2', verified: false }] } });
  await app.flush(); assert.equal((text(app.tree).match(/Readback recorded/g) || []).length, 2);
  assert.match(text(app.tree), /recorded by authorised workspace members/);
  assert.match(text(app.tree), /saved record alone does not prove a provider action/);
  const miro = nodes(app.tree).find(node => node.type === 'article' && text(node).startsWith('Miro'));
  await nodes(miro).find(node => node.type === 'button' && text(node) === 'Check saved result').props.onClick(); await app.flush();
  assert.match(text(app.tree), /Readback recorded for 1 saved card/);
  assert.match(text(app.tree), /Unconfirmed items remain blocked from reposting/);
  assert.doesNotMatch(text(app.tree), /Readback verified|independently checked|independently verified/);
});

test('voice UI rejects responses above the shared 3 MiB bound without offering playback', async t => {
  const app = mount(t, 'SponsorActions', 'SponsorActions', { scenario, principalKey: 'workspace:reviewer' }, { api: async () => ({ ...sponsorStatus, records: [] }), fetch: async () => ({ ok: true, headers: new Headers({ 'content-type': 'audio/mpeg' }), blob: async () => new Blob([new Uint8Array(3 * 1024 * 1024 + 1)]) }) });
  await app.flush(); await button(app, 'Generate saved briefing').props.onClick(); await app.flush();
  assert.match(text(app.tree), /exceeds the size limit/);
  assert.ok(!nodes(app.tree).some(node => node.type === 'audio'));
});

function preparedMap() {
  const nodes = [
    { id:'complaint',kind:'complaint',title:'Original customer request',text:'One synthetic mug was missing.',state:'saved',column:'sources',refs:[{type:'case',id:'SYN-C001'}],links:[{label:'Saved case record',path:'/api/cases/case-1'}] },
    { id:'recommendation',kind:'recommendation',title:'Saved recommendation',text:'A £20 reservation is proposed.',state:'saved',column:'investigation',refs:[],links:[] },
    { id:'policy',kind:'policy',title:'Saved amount check',text:'The proposal is below the saved policy limit.',state:'saved',column:'policy',refs:[],links:[] },
    { id:'review',kind:'review',title:'Human review required',text:'No human approval has been recorded.',state:'waiting',column:'decision',refs:[],links:[] },
    { id:'report',kind:'report',title:'Decision brief',text:'Available from the saved case.',state:'available',column:'destinations',refs:[],links:[{label:'Download decision brief',path:'/api/cases/case-1/report'}] },
  ];
  return {schemaVersion:1,format:'refund-office-case-board',mode:'local-export',target:'miro',importReady:false,caseId:scenario.caseId,caseRecordId:scenario.id,revision:scenario.revision,publication:{prepared:true,published:false,provider:'miro'},provenance:{schemaVersion:1,nodes,edges:[{id:'source-to-recommendation',from:'complaint',to:'recommendation',label:'Saved input',state:'saved'}]},limitations:['This export does not publish a board.','Payment submission is disabled.']};
}
const disconnected = {...sponsorStatus,mode:'offline',actions:Object.fromEntries(['voice','miro','modal','port'].map(action=>[action,{configured:false,reason:'Disconnected. No external request will be sent.'}])),records:[]};

test('prepared Miro inspection remains useful offline and makes only a saved-record GET', async t => {
  const calls=[];
  const app=mount(t,'SponsorActions','SponsorActions',{scenario,principalKey:'workspace:reviewer'},{api:async(path,options={})=>{calls.push([path,options.method||'GET']);return path.endsWith('/status')?disconnected:preparedMap();}});
  await app.flush();assert.equal(button(app,'Publish prepared map').props.disabled,true);assert.equal(button(app,'Inspect prepared map').props.disabled,false);
  await button(app,'Inspect prepared map').props.onClick();await app.flush();
  assert.deepEqual(calls.map(row=>row[1]),['GET','GET']);assert.equal(calls[1][0],'/cases/case-1/board-export');assert.match(text(app.tree),/Prepared Miro source map/);assert.match(text(app.tree),/No Miro request was made by this inspection/);
  assert.match(text(app.tree),/No human approval has been recorded/);assert.match(text(app.tree),/5 records and 1 labelled connection/);assert.match(text(app.tree),/they do not imply an agent is working now/);assert.match(text(app.tree),/not permanent links to this snapshot/);
  assert.ok(nodes(app.tree).some(node=>node.type==='case-download'&&node.props.href==='/api/cases/case-1/report'));assert.equal(button(app,'Publish prepared map').props.disabled,true);
});

test('prepared Miro downloads retain the captured run and preparation label', async t => {
  const api=async()=>disconnected;Object.defineProperty(api,'runId',{value:'90000000-0000-4000-8000-000000000001'});
  const app=mount(t,'SponsorActions','SponsorActions',{scenario,principalKey:'workspace:run:reviewer',apiClient:api},{api});await app.flush();
  const link=nodes(app.tree).find(node=>node.type==='case-download'&&text(node)==='Download prepared map');assert.equal(link.props.runId,api.runId);assert.equal(link.props.href,'/api/cases/case-1/board-export');
  assert.match(text(app.tree),/not a published board or a verified Miro import/);
});

test('mismatched maps, external links and unknown graph references are refused', async t => {
  for(const alter of [map=>{map.revision++;},map=>{map.caseId='another-case';},map=>{map.caseRecordId='another-record';},map=>{map.publication.published=true;},map=>{map.provenance.nodes[4].links[0].path='https://miro.example/pretend-board';},map=>{map.provenance.edges[0].to='missing-node';},map=>{map.provenance.nodes[0].state='live';}]) {
    const map=preparedMap();alter(map);
    const app=mount(t,'SponsorActions','SponsorActions',{scenario,principalKey:'workspace:reviewer'},{api:async path=>path.endsWith('/status')?disconnected:map});await app.flush();await button(app,'Inspect prepared map').props.onClick();await app.flush();
    assert.match(text(app.tree),/could not be matched to this saved case/);assert.doesNotMatch(text(app.tree),/Prepared Miro source map/);app.dispose();
  }
});

test('a delayed source map cannot enter a different case and stale inspect handlers do nothing', async t => {
  const reply=deferred(),calls=[];const api=async path=>{calls.push(path);return path.endsWith('/status')?disconnected:reply.promise;};
  const app=mount(t,'SponsorActions','SponsorActions',{scenario,principalKey:'workspace:reviewer'},{api});await app.flush();const stale=button(app,'Inspect prepared map').props.onClick;const read=stale();
  app.setProps({scenario:{...scenario,id:'case-2',caseId:'SYN-C002'},principalKey:'workspace:reviewer'});await app.flush();await stale();reply.resolve(preparedMap());await read;await app.flush();
  assert.equal(calls.filter(path=>path.endsWith('/board-export')).length,1);assert.doesNotMatch(text(app.tree),/Prepared Miro source map|One synthetic mug was missing/);
});

test('partial Miro publication cannot be called complete when a connector is unresolved', async t => {
  const output={provider:'miro',verified:false,counts:{notes:2,connectors:1},items:[{id:'note-1',verified:true},{id:'note-2',verified:true}],connectors:[{id:'edge-1',verified:false}]};
  const app=mount(t,'SponsorActions','SponsorActions',{scenario,principalKey:'workspace:reviewer'},{api:async path=>path.endsWith('/status')?sponsorStatus:output});await app.flush();
  const card=nodes(app.tree).find(node=>node.type==='article'&&text(node).startsWith('Miro'));await nodes(card).find(node=>node.type==='button'&&text(node)==='Check saved result').props.onClick();await app.flush();
  assert.match(text(app.tree),/Map publication is not fully confirmed/);assert.match(text(app.tree),/2 saved cards and 0 connectors/);assert.match(text(app.tree),/Unconfirmed items remain blocked from reposting/);assert.doesNotMatch(text(app.tree),/All planned map items have recorded readbacks/);
});

test('completion requires all planned notes and connectors, including the parent recorded result', () => {
  const value={verified:true,counts:{notes:1,connectors:1},items:[{verified:true}],connectors:[{verified:true}]};
  assert.equal(miroHelpers.miroReadbackSummary(value).complete,true);
  assert.equal(miroHelpers.miroReadbackSummary({...value,connectors:[]}).complete,false);
  assert.equal(miroHelpers.miroReadbackSummary({...value,verified:false}).complete,false);
  assert.equal(miroHelpers.miroReadbackSummary({...value,counts:undefined}).complete,false);
  assert.equal(miroHelpers.miroReadbackSummary({records:[{action:'miro',state:'succeeded',verified:true,counts:{notes:1,connectors:1}},{action:'miro-card-one',verified:true},{action:'miro-connector-one',itemKind:'connector',verified:true}]}).complete,true);
});

test('recovered connector records in the shared card namespace are counted only as connectors', () => {
  const records=[{action:'miro',state:'succeeded',verified:true,counts:{notes:1,connectors:1}},{action:'miro-card-note',itemKind:'note',verified:true},{action:'miro-card-relationship',itemKind:'connector',verified:true}];
  assert.deepEqual(miroHelpers.miroReadbackSummary({records}),{complete:true,verifiedNotes:1,verifiedConnectors:1,expectedNotes:1,expectedConnectors:1});
  assert.equal(miroHelpers.miroReadbackSummary({records:records.map(row=>row.itemKind==='connector'?{...row,verified:false}:row)}).complete,false);
});

test('the actual provenance builder renders pending decisions and original reservation limits truthfully', async t => {
  for(const hosted of [false,true]) {
    const saved={...scenario,title:'Synthetic mug request',complaint:'The synthetic mug was missing.',proposedAmountMinor:2000,proposal:{source:'local',amountMinor:2000,issue:'missing_item',reason:'Saved packing record supports a missing mug.',evidenceIds:['evidence-1']},checks:[{id:'limit',label:'Policy amount',status:'pass',detail:'Within the saved limit.'}],...(hosted?{outcome:'approved-not-submitted',operationId:'original-reservation',approval:{state:'approved',amountMinor:2000,actor:'synthetic-reviewer',note:'Packing record supports this reservation.'}}:{})};
    saved.events=[{id:'earlier-review',type:'review.request-evidence',label:'Evidence requested',detail:'A reviewer requested clarification earlier.',actor:'synthetic-reviewer',at:'2026-10-14T12:00:00Z'}];
    const result=buildCaseProvenance({case:saved,synthetic:true,mode:hosted?'hosted-supabase':'local-postgres-rehearsal',capabilities:{paymentSubmission:false},...(!hosted?{operation:{id:'original-operation',status:'reserved',approval:{id:'old-approval',state:'approved',amountMinor:2000,actor:'synthetic-reviewer',note:'Earlier approval for the original operation.'}}}:{})});
    assert.equal(miroHelpers.verifyPreparedMiroMap(result,scenario),result);
    const app=mount(t,'SponsorActions','SponsorActions',{scenario,principalKey:'workspace:reviewer'},{api:async path=>path.endsWith('/status')?disconnected:result});await app.flush();await button(app,'Inspect prepared map').props.onClick();await app.flush();
    if(hosted){assert.match(text(app.tree),/original reservation is saved; that record is not a completed payment/);assert.match(text(app.tree),/does not establish whether a separate refund was submitted or completed/);}
    else {assert.match(text(app.tree),/No current refund approval or review decision is attached/);assert.match(text(app.tree),/earlier decisions may remain in recorded history/);assert.match(text(app.tree),/Human decision pending/);assert.match(text(app.tree),/Original operation approval/);assert.match(text(app.tree),/not fresh authority for the current case state/);assert.match(text(app.tree),/Local rehearsal profiles are fictional test identities/);}
    assert.match(text(app.tree),/Recorded review history/);assert.match(text(app.tree),/Synthetic demonstration records only/);assert.match(text(app.tree),/Local analyser; no model call is implied/);app.dispose();
  }
});
