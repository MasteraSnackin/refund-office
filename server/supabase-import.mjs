import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateDemoDataset, demoDatasetDigest } from './demo-dataset.mjs';

export const SYNTHETIC_TENANTS = Object.freeze({
  'focused-12': '00000000-0000-4000-8000-000000000012',
  'busy-50': '00000000-0000-4000-8000-000000000050',
});
export const canonicalJSON = value => JSON.stringify(value, (_, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
export const contentHash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJSON(value)).digest('hex');
const fail = message => { throw new Error(message); };
const secretFields = /(?:apikey|secretkey|accesstoken|refreshtoken|password|bearertoken|authorization|privatekey|clientsecret)$/;
function rejectSecrets(value) {
  if (typeof value === 'string') {
    if (/\b(?:sk_(?:live|test)_|rk_(?:live|test)_|sk-proj-|sk-ant-|Bearer\s+[A-Za-z0-9._~-]{12,})|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/i.test(value)) fail('The snapshot contains credential-like content and cannot be exported. Remove it through a separately reviewed source correction.');
  } else if (Array.isArray(value)) value.forEach(rejectSecrets);
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (secretFields.test(key.replace(/[^a-z]/gi, '').toLowerCase()) && child) fail('The snapshot contains a credential field and cannot be exported.');
    rejectSecrets(child);
  }
}

export function prepareSyntheticImport(value) {
  const data = validateDemoDataset(value);
  rejectSecrets(data);
  const tenantId = SYNTHETIC_TENANTS[data.id];
  const digest = demoDatasetDigest(data);
  const encoded = canonicalJSON(data);
  const delimiter = `$refund_dataset_${digest.slice(0, 20)}$`;
  if (encoded.includes(delimiter)) fail('The dataset conflicts with its SQL delimiter.');
  const sql = `-- Synthetic staging only. Requires the separately applied runtime/001_runtime.sql.\n` +
    `-- Execute only in an authorised disposable synthetic project as its privileged migration operator.\n` +
    `-- No members or approvals are created. Historical local remedies stay seeded, succeeded and non-executable.\n` +
    `-- This file has been prepared locally; it does not connect to or apply a database.\n` +
    `BEGIN;\nSELECT public.refund_runtime_import_dataset(\n` +
    `  p_tenant_id => '${tenantId}'::uuid,\n  p_dataset => ${delimiter}${encoded}${delimiter}::jsonb,\n` +
    `  p_digest => '${digest}',\n  p_members => '[]'::jsonb\n);\nCOMMIT;\n`;
  const historicalAmountMinor = data.seedOperations.reduce((total, operation) => total + operation.amountMinor, 0);
  const orderTotalMinor = data.orders.reduce((total, order) => total + order.totalMinor, 0);
  if (![historicalAmountMinor, orderTotalMinor].every(Number.isSafeInteger)) fail('The dataset amount totals exceed the supported range.');
  const manifest = {
    kind: 'refund-office-synthetic-runtime-import', schemaVersion: 1, datasetId: data.id, tenantId,
    synthetic: true, mode: 'offline-preparation', applied: false, liveVerified: false,
    digest, dataSha256: contentHash(encoded), sqlSha256: contentHash(sql),
    hashEncoding: 'dataSha256 and digest use canonical JSON; sqlSha256 uses exact UTF-8 SQL. The output-file manifest separately hashes the pretty-printed data file.',
    rpc: 'public.refund_runtime_import_dataset', migration: 'integrations/supabase/runtime/001_runtime.sql',
    membershipCreated: false, authenticatedReviewerEstablished: false,
    activeApprovalsImported: 0, humanApprovalRequired: true, submissionEnabled: false,
    counts: { orders: data.orders.length, orderLines: data.orders.reduce((total, order) => total + order.lines.length, 0),
      freshCases: data.cases.length, intakeRequests: data.cases.length, historicalLocalOperations: data.seedOperations.length, approvals: 0, members: 0 },
    amounts: { currency: 'gbp', orderTotalMinor, historicalLocalRemedyMinor: historicalAmountMinor, newSubmittedRefundMinor: 0 },
    mappings: {
      orders: data.orders.map(order => ({ sourceId: order.id, targetKey: { tenantId, orderId: order.id } })),
      cases: data.cases.map(item => ({ sourceId: item.id, displayId: item.caseId, targetKey: { tenantId, caseId: item.id }, state: 'fresh-ready', approval: null })),
      historicalOperations: data.seedOperations.map(operation => ({ sourceId: operation.id, targetKey: { tenantId, operationId: operation.id }, idempotencyKey: operation.idempotencyKey, receiptId: operation.receipt.id, amountMinor: operation.amountMinor, seeded: true, executable: false })),
    },
    blockers: ['Apply and verify the separate runtime schema in a synthetic-only database.', 'Explicitly establish authenticated test reviewer membership later; the import supplies no members.', 'Cloud deployment, authorisation and payment execution remain disabled and unverified.'],
  };
  return { schemaVersion: 1, datasetId: data.id, tenantId, data, sql, manifest };
}

function fileCapture(path) {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024) fail('Use a regular explicit SQLite file no larger than 128 MiB, without symbolic links.');
  const bytes = readFileSync(path);
  return { bytes, state: { bytes: bytes.length, sha256: contentHash(bytes) } };
}
const fileState = path => fileCapture(path)?.state ?? null;

// Read-only inspection only: this module never imports createStore and never
// runs seeding, schema changes, WAL configuration or startup recovery.
export function exportSqliteSnapshot({ dbPath } = {}) {
  if (typeof dbPath !== 'string' || !isAbsolute(dbPath) || dbPath === ':memory:' || !existsSync(dbPath)) fail('Supply an explicit absolute path to an existing SQLite database. There is no default working database.');
  const database = fileCapture(dbPath), wal = fileCapture(dbPath + '-wal');
  const before = { database: database.state, wal: wal?.state ?? null };
  const stableBeforeOpen = { database: fileState(dbPath), wal: fileState(dbPath + '-wal') };
  if (canonicalJSON(before) !== canonicalJSON(stableBeforeOpen)) fail('The SQLite source changed while its bytes were copied. Retry a stable source.');
  // SQLite can create shared-memory sidecars even with readOnly:true. Query a
  // verified private copy so the selected source directory is never written.
  const temporary = mkdtempSync(join(tmpdir(), 'refund-quarantine-'));
  const copyPath = join(temporary, 'snapshot.sqlite');
  let db;
  let tables;
  try {
    writeFileSync(copyPath, database.bytes, { flag: 'wx', mode: 0o600 });
    if (wal) writeFileSync(copyPath + '-wal', wal.bytes, { flag: 'wx', mode: 0o600 });
    db = new DatabaseSync(copyPath, { readOnly: true });
    db.exec('PRAGMA query_only=ON; BEGIN');
    const available = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!['cases', 'settings', 'operations'].every(name => available.has(name))) fail('The database is not a recognised Refund Office store. No recovery or writes were attempted.');
    const columns = {
      cases: ['id', 'data'], settings: ['key', 'data'],
      operations: ['id', 'order_id', 'line_id', 'issue', 'amount_minor', 'data'],
      intake_requests: ['id', 'event_id', 'data'],
    };
    tables = {};
    for (const [name, names] of Object.entries(columns)) {
      if (!available.has(name)) { tables[name] = []; continue; }
      tables[name] = db.prepare(`SELECT ${names.join(',')} FROM ${name} ORDER BY ${names[0]}`).all().map(row => {
        if (typeof row.data !== 'string' || Buffer.byteLength(row.data) > 4 * 1024 * 1024) fail('A snapshot row is invalid or exceeds its four-MiB bound.');
        let data;
        try { data = JSON.parse(row.data); } catch { fail('A snapshot row contains invalid JSON. No source content was exported.'); }
        rejectSecrets(data);
        const { data: rawData, ...identity } = row;
        rejectSecrets(identity);
        if (name === 'settings' && secretFields.test(String(identity.key).replace(/[^a-z]/gi, '').toLowerCase())) fail('The snapshot contains a credential setting and cannot be exported.');
        return { identity: { ...identity }, rawData, data, rawSha256: contentHash(rawData), canonicalSha256: contentHash(data),
          disposition: 'archival-quarantine', executable: false };
      });
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db?.exec('ROLLBACK'); } catch { /* A failed BEGIN has no transaction. */ }
    throw error;
  } finally { db?.close(); rmSync(temporary, { recursive: true, force: true }); }
  const after = { database: fileState(dbPath), wal: fileState(dbPath + '-wal') };
  if (canonicalJSON(before) !== canonicalJSON(after)) fail('The SQLite source changed while it was being read. Retry a stable source; no executable import was produced.');
  const marker = tables.settings.find(row => row.identity.key === 'demoDataset')?.data;
  let dataset = null;
  if (marker) {
    dataset = validateDemoDataset(marker.dataset);
    if (demoDatasetDigest(dataset) !== marker.digest) fail('The saved synthetic dataset identity does not match its digest.');
  }
  const approvals = tables.cases.filter(row => row.data?.approval?.state === 'approved').map(row => ({
    caseId: row.identity.id, actor: row.data.approval.actor ?? null, fingerprint: row.data.approval.fingerprint ?? null,
    disposition: 'archival-quarantine', executable: false,
    reason: row.data.approval.actor === 'local-reviewer' ? 'The local-reviewer label is not an authenticated cloud reviewer. Preserve the original decision but grant no cloud execution authority.' : 'Existing source approvals need independent identity, tenant and exact-facts review; this export grants no execution authority.',
  }));
  const amountsByStatus = Object.create(null);
  for (const row of tables.operations) {
    const amount = row.data?.amountMinor;
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount !== row.identity.amount_minor) fail('An operation amount is invalid or differs from its SQLite index. Keep the source for separate reconciliation.');
    const status = String(row.data.status || 'unknown');
    amountsByStatus[status] = (amountsByStatus[status] || 0) + amount;
    if (!Number.isSafeInteger(amountsByStatus[status])) fail('The operation amount total exceeds the supported range.');
  }
  const manifest = {
    kind: 'refund-office-sqlite-quarantine-snapshot', schemaVersion: 1, sourceName: basename(dbPath),
    sourceFiles: before, readOnly: true, transaction: 'read-only-transaction-on-verified-private-copy', sourceOpenedBySqlite: false, startupRecoveryRun: false,
    disposition: 'archival-quarantine', executable: false, operationalImportAllowed: false,
    dataset: dataset ? { id: dataset.id, digest: marker.digest, synthetic: true } : null,
    catalogueSource: dataset ? 'Preserved dataset marker in settings.' : 'No saved dataset catalogue exists. Current code fixtures were not substituted for historical source records.',
    counts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])),
    approvedCases: approvals.length, localReviewerApprovals: approvals.filter(x => x.actor === 'local-reviewer').length,
    operationAmountsMinorByStatus: amountsByStatus,
    payloadSha256: contentHash(tables),
    warning: 'Raw approvals, snapshots, fingerprints, operation identities, retry keys and receipts are preserved as archive evidence. They must never be loaded into active operational tables by this preparation tool.',
  };
  return { manifest, approvals, tables };
}
