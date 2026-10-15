import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ORDERS, SEED_CASES, makeCase } from './fixtures.mjs';
import { validateDemoDataset, demoDatasetDigest, demoIntakePayloadHash, DemoDatasetError } from './demo-dataset.mjs';

export function createStore({ dbPath = process.env.DB_PATH || resolve('.data/refund-office.sqlite'), dataset, expectedDatasetId, expectedDatasetDigest } = {}) {
  const requiresIdentity = expectedDatasetId !== undefined || expectedDatasetDigest !== undefined;
  if (requiresIdentity) {
    if (!['focused-12', 'busy-50'].includes(expectedDatasetId) || typeof expectedDatasetDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDatasetDigest)) throw new DemoDatasetError('A demo launch requires its exact expected pack and catalogue digest.');
    if (dbPath === ':memory:' || !existsSync(dbPath)) throw new DemoDatasetError('The prepared demo database is missing. Prepare a fresh isolated pack before launching.');
  }
  const suppliedDataset = dataset === undefined ? null : validateDemoDataset(dataset);
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  try {
  // Check identity before schema/data writes, so a pack cannot be mixed into a
  // normal working database or replace an already imported pack.
  const existingTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
  const markerRow = existingTables.includes('settings') ? db.prepare("SELECT data FROM settings WHERE key='demoDataset'").get() : null;
  let activeDataset = null; let activeDigest = null;
  if (requiresIdentity && !markerRow) throw new DemoDatasetError('The selected database is not a marked demo pack. No startup recovery was performed.');
  if (markerRow) {
    let marker;
    try { marker = JSON.parse(markerRow.data); } catch { throw new DemoDatasetError('The saved dataset marker is invalid. No startup recovery was performed.'); }
    activeDataset = validateDemoDataset(marker.dataset);
    activeDigest = demoDatasetDigest(activeDataset);
    if (marker.digest !== activeDigest) throw new DemoDatasetError('The saved dataset catalogue failed its integrity check. Use a fresh isolated demo database.');
    if (requiresIdentity && (activeDataset.id !== expectedDatasetId || activeDigest !== expectedDatasetDigest)) throw new DemoDatasetError('The selected database does not match the expected demo pack and digest. No startup recovery was performed.');
    if (suppliedDataset && demoDatasetDigest(suppliedDataset) !== activeDigest) throw new DemoDatasetError('This database belongs to a different dataset digest. Choose a fresh isolated database.');
  } else if (suppliedDataset) {
    const nonempty = existingTables.some(name => db.prepare(`SELECT 1 FROM "${name.replaceAll('"', '""')}" LIMIT 1`).get());
    if (nonempty) throw new DemoDatasetError('Do not import a demo dataset into a nonempty unmarked database. Choose a fresh isolated database.');
    activeDataset = suppliedDataset; activeDigest = demoDatasetDigest(activeDataset);
  }
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS intake_requests (id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL, line_id TEXT NOT NULL, issue TEXT NOT NULL,
      amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), data TEXT NOT NULL,
      UNIQUE(order_id, line_id, issue)
    );
  `);
  const parse = (row) => row ? JSON.parse(row.data) : null;
  const store = {
    db,
    close() { db.close(); },
    orders() { return structuredClone(activeDataset ? activeDataset.orders : ORDERS); },
    demoDataset() { return activeDataset ? { id: activeDataset.id, title: activeDataset.title, synthetic: true, caseCount: activeDataset.cases.length, orderCount: activeDataset.orders.length, merchant: structuredClone(activeDataset.merchant), digest: activeDigest } : null; },
    getCase(id) { return parse(db.prepare('SELECT data FROM cases WHERE id=?').get(id)); },
    cases() { return db.prepare('SELECT data FROM cases ORDER BY rowid').all().map(parse); },
    saveCase(value) { db.prepare('INSERT INTO cases(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id, JSON.stringify(value)); return value; },
    intakeRequest(id) { return parse(db.prepare('SELECT data FROM intake_requests WHERE id=?').get(id)); },
    intakeByEvent(eventId) { return parse(db.prepare('SELECT data FROM intake_requests WHERE event_id=?').get(eventId)); },
    intakeRequests() { return db.prepare('SELECT data FROM intake_requests ORDER BY rowid').all().map(parse); },
    saveIntake(value) { db.prepare('INSERT INTO intake_requests(id,event_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id, value.eventId, JSON.stringify(value)); return value; },
    policy() { return parse(db.prepare("SELECT data FROM settings WHERE key='policy'").get()); },
    savePolicy(value) { db.prepare("INSERT INTO settings(key,data) VALUES('policy',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(JSON.stringify(value)); return value; },
    operation(id) { return parse(db.prepare('SELECT data FROM operations WHERE id=?').get(id)); },
    previous(orderId, lineId, issue) { return parse(db.prepare('SELECT data FROM operations WHERE order_id=? AND line_id=? AND issue=?').get(orderId, lineId, issue)); },
    operations(orderId) { return db.prepare('SELECT data FROM operations WHERE order_id=?').all(orderId).map(parse); },
    saveOperation(value) {
      db.prepare('INSERT INTO operations(id,order_id,line_id,issue,amount_minor,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id, value.orderId, value.lineId, value.issue, value.amountMinor, JSON.stringify(value));
      return value;
    },
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const value = fn(); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  store.transaction(() => {
    if (activeDataset) {
      if (!markerRow) {
        db.prepare("INSERT INTO settings(key,data) VALUES('demoDataset',?)").run(JSON.stringify({ digest: activeDigest, dataset: activeDataset }));
        store.savePolicy(activeDataset.policy);
        for (const operation of activeDataset.seedOperations) store.saveOperation(operation);
        const importedAt = new Date().toISOString();
        for (const seed of activeDataset.cases) {
          const item = makeCase(seed, activeDataset.orders);
          const requestId = `dataset-intake-${activeDataset.id}-${seed.id}`;
          const eventId = `demo-${activeDataset.id}-${seed.id}`;
          item.intakeManaged = true; item.intakeRequestId = requestId;
          item.events.push({ id: `${requestId}-imported`, at: importedAt, station: 'reception', label: 'Synthetic demo request saved', detail: `Pack ${activeDataset.id}, event ${eventId}. These fictional records are queued for local investigation; no decision or payment was created.` });
          item.revision += 1;
          store.saveCase(item);
          store.saveIntake({ id: requestId, eventId, caseId: item.id, caseLabel: item.caseId, orderId: item.orderId, status: 'queued',
            createdAt: importedAt, updatedAt: importedAt, payloadHash: demoIntakePayloadHash(item.orderId, item.complaint), attempts: 0 });
        }
      }
      if (!store.policy()) throw new DemoDatasetError('The marked demo database has no saved policy. Use a fresh isolated database.');
    } else {
    if (!store.policy()) store.savePolicy({ limitMinor: 2500, version: 1 });
    for (const seed of SEED_CASES) if (!store.getCase(seed.id)) store.saveCase(makeCase(seed));
    if (!store.operation('seed-remedy-106')) {
      const createdAt = '2026-10-11T12:00:00.000Z';
      store.saveOperation({ id: 'seed-remedy-106', orderId: 'DEMO-106', lineId: '106-3', issue: 'item_missing', amountMinor: 2000,
        status: 'succeeded', seeded: true, idempotencyKey: 'refund-office-seed-106', createdAt,
        payload: { operationId: 'seed-remedy-106', idempotencyKey: 'refund-office-seed-106', order: ORDERS.find((order) => order.id === 'DEMO-106'), amountMinor: 2000, lineId: '106-3', issue: 'item_missing' },
        receipt: { id: 'DEMO-REMEDY-106', provider: 'local', amountMinor: 2000, currency: 'gbp', status: 'succeeded', createdAt, operationId: 'seed-remedy-106' } });
    }
    }
    for (const item of store.cases()) if (item.status === 'running') {
      const request = item.intakeRequestId && store.intakeRequest(item.intakeRequestId);
      const recoverableIntake = request?.caseId === item.id && ['queued', 'running'].includes(request.status) && item.intakeManaged && !item.operationId && !item.receipt && item.approval?.state !== 'approved' && ['reception', 'evidence', 'policy'].includes(item.stage);
      if (recoverableIntake) {
        item.revision += 1;
        item.events.push({ id: `recovery-${item.revision}`, at: new Date().toISOString(), station: item.stage, label: 'Local intake recovered after restart', detail: 'The saved investigation will continue to human review. No payment can be submitted by intake.' });
        store.saveCase(item);
        continue;
      }
      item.status = 'paused'; item.pauseReason = 'restart'; item.revision += 1;
      item.events.push({ id: `recovery-${item.revision}`, at: new Date().toISOString(), station: item.stage, label: 'Recovered after restart', detail: 'Saved progress is paused. Resume to continue the same operation.' });
      store.saveCase(item);
    }
  });
  return store;
  } catch (error) { db.close(); throw error; }
}
