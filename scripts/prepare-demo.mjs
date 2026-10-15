import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from '../server/store.mjs';
import { demoDatasetDigest } from '../server/demo-dataset.mjs';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const demoPackIds = ['focused-12', 'busy-50'];

export function prepareDemo({ packId, fresh = false, baseDirectory = join(projectRoot, '.data', 'demo-packs') } = {}) {
  if (!demoPackIds.includes(packId)) throw new Error('Choose the focused-12 or busy-50 synthetic pack.');
  const source = readFileSync(join(projectRoot, 'demo-data', packId + '.json'), 'utf8');
  const dataset = JSON.parse(source);
  const datasetDigest = demoDatasetDigest(dataset);
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const base = resolve(baseDirectory);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const directory = fresh ? mkdtempSync(join(base, packId + '-')) : join(base, packId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dbPath = join(directory, 'cases.sqlite');
  const metadataPath = join(directory, 'pack.json');
  if (existsSync(dbPath)) {
    if (lstatSync(dbPath).isSymbolicLink() || !existsSync(metadataPath)) throw new Error('This demo path is not a recognised prepared pack. Use a fresh pack directory.');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (metadata.packId !== packId || metadata.sourceHash !== sourceHash || metadata.datasetDigest !== datasetDigest || metadata.dbPath !== dbPath) throw new Error('The saved demo differs from this pack. Start a fresh copy to preserve existing decisions.');
    // Do not open a live database just to prepare it again: startup recovery is a runtime action.
    return { ...metadata, created: false };
  }
  if (existsSync(metadataPath)) throw new Error('The pack manifest exists without its database. Start a fresh copy.');
  const store = createStore({ dbPath, dataset });
  store.close();
  const metadata = { schemaVersion: 1, packId, title: dataset.title, caseCount: dataset.cases.length, dbPath, sourceHash, datasetDigest, synthetic: true, networkMode: 'offline' };
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ...metadata, created: true };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--all', '--fresh', ...demoPackIds].includes(arg))) throw new Error('Use --all, focused-12 or busy-50, with optional --fresh.');
    const selected = args.includes('--all') || !args.some(arg => demoPackIds.includes(arg)) ? demoPackIds : args.filter(arg => demoPackIds.includes(arg));
    for (const packId of selected) {
      const result = prepareDemo({ packId, fresh: args.includes('--fresh') });
      console.log(`${result.title} ${result.created ? 'prepared' : 'already prepared'}. No investigation, approval or external connection was started.`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
