import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { embeddedSystemMap, prepareSystemMap, SYSTEM_MAP_CSP, SYSTEM_MAP_LAYOUT } from '../scripts/prepare-system-map.mjs';

const fixture = '<!doctype html><html><head></head><body><script>readerPaused = readStored() === \'still\';</script></body></html>';
const sha = value => createHash('sha256').update(value).digest('hex');

test('embedded diagram starts still and blocks outbound requests without changing authored content', () => {
  const result = embeddedSystemMap(fixture);
  assert.match(result, /readerPaused = true;/);
  assert.ok(result.startsWith('<!doctype html><html><head>\n<meta http-equiv="Content-Security-Policy"'));
  assert.ok(result.includes(SYSTEM_MAP_CSP));
  assert.ok(SYSTEM_MAP_CSP.includes("connect-src 'none'"));
  assert.ok(SYSTEM_MAP_CSP.includes("frame-src 'none'"));
  assert.equal(result.replace(`\n<meta http-equiv="Content-Security-Policy" content="${SYSTEM_MAP_CSP}">`, '')
    .replace(`${SYSTEM_MAP_LAYOUT}\n`, '')
    .replace('readerPaused = true;', "readerPaused = readStored() === 'still';"), fixture);
});

test('embedding refuses changed or ambiguous runtime contracts', () => {
  assert.throws(() => embeddedSystemMap(fixture.replace('readerPaused = readStored()', 'paused = readStored()')), /embedding contract/);
  assert.throws(() => embeddedSystemMap(fixture.replace('</body>', "readerPaused = readStored() === 'still';</body>")), /embedding contract/);
  assert.throws(() => embeddedSystemMap('<html><body>unknown</body></html>'), /embedding contract/);
});

test('preparation rejects stale receipt bytes and leaves the earlier embedded map intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refund-system-map-'));
  try {
    mkdirSync(join(dir, 'docs/diagrams'), { recursive: true });
    mkdirSync(join(dir, 'public'));
    writeFileSync(join(dir, 'docs/diagrams/sponsor-runtime.html'), fixture);
    const receipt = { ok: true, artifact: { sha256: sha(fixture), bytes: Buffer.byteLength(fixture) },
      validation: { checksPassed: 9, errors: 0, warnings: 0 } };
    writeFileSync(join(dir, 'docs/diagrams/sponsor-runtime.delivery.json'), JSON.stringify(receipt));
    const result = prepareSystemMap(dir);
    const before = readFileSync(join(dir, result.output));
    assert.equal(sha(before), result.outputSha256);
    writeFileSync(join(dir, 'docs/diagrams/sponsor-runtime.html'), fixture + '\nchanged');
    assert.throws(() => prepareSystemMap(dir), /unchanged passing Archify delivery/);
    assert.deepEqual(readFileSync(join(dir, result.output)), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the shipped public diagram is the isolated derivative of the exact checked source', () => {
  const canonical = readFileSync(new URL('../docs/diagrams/sponsor-runtime.html', import.meta.url));
  const receipt = JSON.parse(readFileSync(new URL('../docs/diagrams/sponsor-runtime.delivery.json', import.meta.url)));
  const shipped = readFileSync(new URL('../public/system-map.html', import.meta.url), 'utf8');
  assert.equal(sha(canonical), receipt.artifact.sha256);
  assert.equal(shipped, embeddedSystemMap(canonical.toString('utf8')));
  assert.match(shipped, /not live traffic/);
});
