import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionStore, deserializeSessions, serializeSessions } from './sessionStore.mjs';

const SID = 'a'.repeat(64);
const HOUR = 3600_000;
const silent = { error: () => {} };
const dirs = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'wb-sess-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('会话序列化', () => {
  it('往返保持 cookie，丢弃超时和非法条目', () => {
    const now = Date.now();
    const m = new Map([
      [SID, { user: 'u1', lastSeen: now, cookies: new Map([['JSESSIONID', 'x']]) }],
      ['b'.repeat(64), { user: 'u2', lastSeen: now - 9 * HOUR, cookies: new Map() }],
    ]);
    const list = serializeSessions(m, 8 * HOUR, now);
    expect(list).toHaveLength(1);
    const back = deserializeSessions([...list, { sid: 'bad', user: 'x', lastSeen: now, cookies: [] }], 8 * HOUR, now);
    expect([...back.keys()]).toEqual([SID]);
    expect(back.get(SID).cookies.get('JSESSIONID')).toBe('x');
  });
});

describe('createSessionStore', () => {
  it('加密落盘、0600 权限、重新加载后可用', () => {
    const dir = tmp();
    const store = createSessionStore(dir, { log: silent });
    store.save(new Map([[SID, { user: 'u1', lastSeen: Date.now(), cookies: new Map([['JSESSIONID', 'secret-cookie']]) }]]), 8 * HOUR);
    const raw = readFileSync(store.dataFile, 'utf8');
    expect(raw).not.toContain('secret-cookie');
    // Base64 密文可能随机包含短字符串 u1；检查明文 JSON 字段，避免随机误报。
    expect(raw).not.toContain('"user":"u1"');
    expect(JSON.parse(raw)).not.toHaveProperty('user');
    if (process.platform !== 'win32') {
      expect(statSync(store.dataFile).mode & 0o777).toBe(0o600);
      expect(statSync(path.join(dir, 'session.key')).mode & 0o777).toBe(0o600);
    }
    const again = createSessionStore(dir, { log: silent }).load(8 * HOUR);
    expect(again.get(SID).user).toBe('u1');
    expect(again.get(SID).cookies.get('JSESSIONID')).toBe('secret-cookie');
  });

  it('没有会话时删除文件；密文被篡改时返回空', () => {
    const dir = tmp();
    const store = createSessionStore(dir, { log: silent });
    store.save(new Map([[SID, { user: 'u1', lastSeen: Date.now(), cookies: new Map() }]]), 8 * HOUR);
    const box = JSON.parse(readFileSync(store.dataFile, 'utf8'));
    box.data = Buffer.from('tampered').toString('base64');
    writeFileSync(store.dataFile, JSON.stringify(box));
    expect(store.load(8 * HOUR).size).toBe(0);
    store.save(new Map(), 8 * HOUR);
    expect(() => statSync(store.dataFile)).toThrow();
  });
});
