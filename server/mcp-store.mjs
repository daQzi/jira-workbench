import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const digest = (s) => createHash('sha256').update(s).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function problem(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

/** 写入前先落盘，响应丢失不盲重试。数据库只保存 Token 摘要和会话绑定，不保存 Jira 凭据。 */
export function createMcpStore(dir) {
  if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = dir ? path.join(dir, 'mcp.sqlite') : ':memory:';
  const db = new DatabaseSync(file);
  if (dir && process.platform !== 'win32') chmodSync(file, 0o600);
  db.exec(`
    PRAGMA journal_mode=DELETE;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, request_id TEXT NOT NULL, tool TEXT NOT NULL, input_hash TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(grant_id,request_id));
    CREATE TABLE IF NOT EXISTS steps (operation_id TEXT NOT NULL, step_key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(operation_id,step_key));
  `);
  // 上次进程可能在 Jira 写入后、记下结果前退出，不能假定没写成功。
  for (const r of db.prepare('SELECT operation_id,step_key,body FROM steps').all()) {
    const b = JSON.parse(r.body);
    if (b.state === 'in_flight') {
      b.state = 'unknown'; b.code = 'UNKNOWN_OUTCOME';
      db.prepare('UPDATE steps SET body=? WHERE operation_id=? AND step_key=?').run(JSON.stringify(b), r.operation_id, r.step_key);
    }
  }
  const getBody = (sql, ...args) => { const row = db.prepare(sql).get(...args); return row ? JSON.parse(row.body) : null; };
  return {
    close: () => db.close(),
    config: () => getBody('SELECT body FROM config WHERE id=1') ?? { enabled: false, policies: [] },
    saveConfig(c) { db.prepare('INSERT OR REPLACE INTO config VALUES(1,?)').run(JSON.stringify(c)); },
    grants: () => db.prepare('SELECT body FROM grants').all().map(r => JSON.parse(r.body)),
    grant: (id) => getBody('SELECT body FROM grants WHERE id=?', id),
    createGrant(input) {
      const token = `wb_mcp_${randomBytes(32).toString('base64url')}`;
      const grant = { ...input, id: randomUUID(), enabled: true, createdAt: new Date().toISOString() };
      db.prepare('INSERT INTO grants VALUES(?,?,?)').run(grant.id, digest(token), JSON.stringify(grant));
      return { grant, token };
    },
    authenticate(token) { return getBody('SELECT body FROM grants WHERE hash=?', digest(token)); },
    updateGrant(g) { db.prepare('UPDATE grants SET body=? WHERE id=?').run(JSON.stringify(g), g.id); },
    operation: (id) => getBody('SELECT body FROM operations WHERE id=?', id),
    operations: (grantId) => db.prepare('SELECT body FROM operations WHERE grant_id=? ORDER BY rowid DESC LIMIT 100').all(grantId).map(r => JSON.parse(r.body)),
    begin(grantId, requestId, tool, input) {
      const old = getBody('SELECT body FROM operations WHERE grant_id=? AND request_id=?', grantId, requestId);
      const hash = digest(canonical({ tool, input }));
      if (old) {
        if (old.inputHash !== hash) throw problem('IDEMPOTENCY_CONFLICT', '相同 requestId 已用于不同内容，请查询原操作。');
        return { ...old, existing: true };
      }
      const op = { id: randomUUID(), grantId, requestId, tool, inputHash: hash, input, state: 'running', createdAt: new Date().toISOString(), results: [] };
      db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(op.id, grantId, requestId, tool, hash, JSON.stringify(op));
      return op;
    },
    saveOperation(op) { op.updatedAt = new Date().toISOString(); db.prepare('UPDATE operations SET body=? WHERE id=?').run(JSON.stringify(op), op.id); },
    steps: (opId) => db.prepare('SELECT step_key,body FROM steps WHERE operation_id=?').all(opId).map(r => ({ key:r.step_key, ...JSON.parse(r.body) })),
    step: (opId, key) => getBody('SELECT body FROM steps WHERE operation_id=? AND step_key=?', opId, key),
    saveStep(opId, key, b) { db.prepare('INSERT OR REPLACE INTO steps VALUES(?,?,?)').run(opId, key, JSON.stringify({ ...b, updatedAt: new Date().toISOString() })); },
  };
}
