import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeRehearsalEnvironment, requireRuntimePortsFree, authenticatedStatement, parseRuntimeSqlResult, validateRuntimeMarker, validateOwnedVolume, expectedVolumeLabels, RUNTIME_PORTS } from '../scripts/run-runtime-rehearsal.mjs';
import { contentHash, prepareSyntheticImport } from '../server/supabase-import.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const id = '50000000-0000-4000-8000-000000000001';
const userId = '40000000-0000-4000-8000-000000000001';
const pack = prepareSyntheticImport(JSON.parse(readFileSync(resolve(root,'demo-data/focused-12.json'),'utf8')));
const schemaHashes = { one: 'a'.repeat(64), two: 'b'.repeat(64) };
const members = [{ userId, role: 'reviewer' }];
function marker(changes = {}) {
  const value = { kind: 'refund-office-local-postgres-rehearsal', schemaVersion: 1, id, status: 'ready', datasetId: pack.datasetId,
    datasetDigest: pack.manifest.digest, tenantId: pack.tenantId, volumeName: `refund-office-runtime-${id}`, imageId: 'sha256:'+'c'.repeat(64),
    schemaHashes, members, checkpoint: { sha256: 'd'.repeat(64) }, ...changes };
  return { ...value, markerSha256: contentHash(value) };
}

test('rehearsal environment excludes credentials, remote Docker context and Node injection settings', () => {
  const env = runtimeRehearsalEnvironment({ PATH: '/test/bin', HOME: '/test/home', OPENAI_API_KEY: 'secret', SUPABASE_PUBLISHABLE_KEY: 'secret',
    DOCKER_HOST: 'tcp://remote', DOCKER_CONTEXT: 'remote', NODE_OPTIONS: '--import private.mjs', VITE_SECRET: 'secret', REFUND_OFFICE_NETWORK: 'enabled' });
  assert.equal(env.PATH, '/test/bin'); assert.equal(env.REFUND_OFFICE_NETWORK,'offline'); assert.equal(env.REFUND_OFFICE_ENABLED_INTEGRATIONS,'');
  for (const key of ['OPENAI_API_KEY','SUPABASE_PUBLISHABLE_KEY','DOCKER_HOST','DOCKER_CONTEXT','NODE_OPTIONS','VITE_SECRET']) assert.equal(env[key],undefined);
  assert.equal(env.API_PORT,'4274');
});

test('both separate ports are checked and an occupied port prevents preparation', async () => {
  const checked = [];
  await assert.rejects(requireRuntimePortsFree(async port => { checked.push(port); return port === RUNTIME_PORTS.ui; }), /No process was stopped and no data was created/);
  assert.deepEqual(checked.sort(),[4273,4274]);
  await requireRuntimePortsFree(async () => false);
});

test('local SQL context selects only an authenticated test profile and enables strict string literals', () => {
  const sql = authenticatedStatement({ statement: `SELECT public.refund_runtime_read_case(p_tenant_id => '${pack.tenantId}'::uuid, p_case_id => 'case-1'::text);`, role: 'authenticated', userId });
  assert.match(sql,/SET LOCAL standard_conforming_strings=on/); assert.match(sql,/SET LOCAL ROLE authenticated/);
  assert.match(sql, /"is_anonymous":false/);
  for (const role of ['postgres','service_role','anon']) assert.throws(() => authenticatedStatement({ statement:'SELECT public.refund_runtime_read_workspace();',role,userId }));
  assert.throws(() => authenticatedStatement({ statement:'SELECT public.refund_runtime_import_dataset();',role:'authenticated',userId }));
  assert.throws(() => authenticatedStatement({ statement:'SELECT arbitrary();',role:'authenticated',userId }));
});

test('reuse marker requires exact dataset, schema, profiles, checkpoint and integrity', () => {
  const options = { id, pack, schemaHashes, members };
  assert.equal(validateRuntimeMarker(marker(),options).id,id);
  for (const changes of [{status:'initializing'},{datasetDigest:'f'.repeat(64)},{schemaHashes:{}},{members:[]},{checkpoint:null},{volumeName:'another-project'}]) assert.throws(() => validateRuntimeMarker(marker(changes),options));
  const damaged = marker(); damaged.status='changed'; assert.throws(() => validateRuntimeMarker(damaged,options));
});

test('SQL NULL means an empty claim queue without accepting blank write acknowledgements', () => {
  const claim = { statement: 'SELECT public.refund_runtime_claim_intake();' };
  assert.equal(parseRuntimeSqlResult(' \n\t', claim), null);
  assert.equal(parseRuntimeSqlResult('null\n', claim), null);
  assert.deepEqual(parseRuntimeSqlResult('{"caseId":"case-1"}\n', claim), { caseId: 'case-1' });
  for (const rpc of ['read_case','approve_and_reserve','finish_intake','review_case','recover_intake','fail_intake']) {
    assert.throws(() => parseRuntimeSqlResult(' \n', { statement: `SELECT public.refund_runtime_${rpc}();` }), SyntaxError);
  }
  assert.throws(() => parseRuntimeSqlResult('not JSON', claim), SyntaxError);
});

test('a reusable volume must have exact ownership labels and no bind or network driver options', () => {
  const saved = marker();
  const volume = { Name:saved.volumeName,Driver:'local',Scope:'local',Options:null,Labels:expectedVolumeLabels(saved) };
  validateOwnedVolume(volume,saved);
  for (const change of [{Name:'other-project'},{Driver:'nfs'},{Scope:'global'},{Labels:{}},{Options:{type:'none',device:'/another/project',o:'bind'}}]) assert.throws(() => validateOwnedVolume({...volume,...change},saved));
});

test('the separate Vite configuration disables env-file loading and fixes the new proxy ports', async () => {
  const { default: config } = await import('../vite.runtime.config.mjs');
  assert.equal(config.envDir,false); assert.equal(config.server.port,4273); assert.equal(config.server.strictPort,true);
  assert.equal(config.server.proxy['/api'],'http://127.0.0.1:4274');
});
