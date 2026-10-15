import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SYSTEM_MAP_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; media-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'";
export const SYSTEM_MAP_LAYOUT = '<style id="office-map-layout">@media (min-width:721px) and (max-width:1100px){.toolbar{position:relative;top:auto;right:auto;width:max-content;max-width:100%;margin:0 0 1rem auto}.header{padding-right:0!important}.header-row{flex-wrap:wrap}h1{min-width:0;overflow-wrap:anywhere}}</style>';
const STARTUP = "readerPaused = readStored() === 'still';";
const sha = value => createHash('sha256').update(value).digest('hex');

// The canonical Archify artifact is unchanged. This embedded derivative adds
// an outbound-request restriction, a reader-started motion default, and a
// toolbar row on narrower office frames. Authored graph content is untouched.
export function embeddedSystemMap(canonical) {
  if (typeof canonical !== 'string' || canonical.split('<head>').length !== 2 || canonical.split('</head>').length !== 2 || canonical.split(STARTUP).length !== 2) {
    throw new Error('The checked map no longer has the expected embedding contract. Redeliver and review it before preparing the app view.');
  }
  return canonical.replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${SYSTEM_MAP_CSP}">`)
    .replace('</head>', `${SYSTEM_MAP_LAYOUT}\n</head>`)
    .replace(STARTUP, 'readerPaused = true;');
}

export function prepareSystemMap(root = ROOT) {
  const sourcePath = 'docs/diagrams/sponsor-runtime.html';
  const source = readFileSync(resolve(root, sourcePath));
  const receipt = JSON.parse(readFileSync(resolve(root, 'docs/diagrams/sponsor-runtime.delivery.json'), 'utf8'));
  const sourceDigest = sha(source);
  if (receipt.ok !== true || receipt.artifact?.sha256 !== sourceDigest || receipt.artifact?.bytes !== source.length
    || receipt.validation?.checksPassed !== 9 || receipt.validation?.errors !== 0 || receipt.validation?.warnings !== 0) {
    throw new Error('Prepare the embedded map only from an unchanged passing Archify delivery.');
  }
  const outputPath = 'public/system-map.html';
  const output = embeddedSystemMap(source.toString('utf8'));
  mkdirSync(resolve(root, 'public'), { recursive: true });
  writeFileSync(resolve(root, outputPath), output);
  return { source: sourcePath, sourceSha256: sourceDigest, output: outputPath, outputSha256: sha(Buffer.from(output)),
    transformation: 'Early CSP, initial Still mode and a narrower-frame toolbar row. No topology, labels or financial authority changed.', csp: SYSTEM_MAP_CSP,
    scope: 'Authored architecture only. No case input, provider request or live traffic.' };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.stdout.write(JSON.stringify(prepareSystemMap(), null, 2) + '\n');
}
