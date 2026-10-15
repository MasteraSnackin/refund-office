import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';

// Inject a different durable implementation in hosted runtimes. Never share the
// original case database or rely on a process-local Map for external writes.
export function createSponsorActionLedger({ dbPath } = {}) {
  if (typeof dbPath !== 'string' || !isAbsolute(dbPath)) throw new TypeError('Use an explicit absolute path for the durable sponsor-action database.');
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS sponsor_actions (
      action_key TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, case_id TEXT NOT NULL,
      revision INTEGER NOT NULL, action TEXT NOT NULL, command_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(tenant_id, command_id, action)
    );`);
  const decode = row => row ? { key: row.action_key, tenantId: row.tenant_id, caseId: row.case_id, revision: row.revision, action: row.action, commandId: row.command_id, payloadHash: row.payload_hash, state: row.state, result: row.result ? JSON.parse(row.result) : null, errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  const canonical = value => JSON.stringify(value, (_,item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item);
  const get = key => decode(db.prepare('SELECT * FROM sponsor_actions WHERE action_key=?').get(key));
  return {
    durable: true,
    get,
    begin(input) {
      const time = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = get(input.key) || decode(db.prepare('SELECT * FROM sponsor_actions WHERE tenant_id=? AND command_id=? AND action=?').get(input.tenantId, input.commandId, input.action));
        if (existing) { db.exec('COMMIT'); return { created: false, record: existing }; }
        db.prepare('INSERT INTO sponsor_actions(action_key,tenant_id,case_id,revision,action,command_id,payload_hash,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(input.key,input.tenantId,input.caseId,input.revision,input.action,input.commandId,input.payloadHash,'pending',time,time);
        db.exec('COMMIT'); return { created: true, record: get(input.key) };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    update(key, { state, result = null, errorCode = null }) {
      if (!['pending','acknowledged','succeeded','unknown','rejected'].includes(state)) throw new TypeError('Unsupported action state.');
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = get(key);
        if (!existing) throw new Error('The durable action record is missing.');
        if (['succeeded','rejected'].includes(existing.state)) {
          if (existing.state !== state || canonical(existing.result) !== canonical(result) || existing.errorCode !== errorCode) throw new Error('A completed sponsor-action receipt is immutable.');
          db.exec('COMMIT'); return existing;
        }
        db.prepare('UPDATE sponsor_actions SET state=?,result=?,error_code=?,updated_at=? WHERE action_key=?').run(state,result === null ? null : JSON.stringify(result),errorCode,new Date().toISOString(),key);
        db.exec('COMMIT'); return get(key);
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    list({ tenantId, caseId, revision }) {
      return db.prepare('SELECT * FROM sponsor_actions WHERE tenant_id=? AND case_id=? AND revision=? ORDER BY created_at,action_key').all(tenantId,caseId,revision).map(decode);
    },
    close() { db.close(); },
  };
}
