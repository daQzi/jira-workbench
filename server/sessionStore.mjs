// 会话持久化：代理重启后免登录。
// Jira 会话 cookie 用 AES-256-GCM 加密后落盘；密钥是同目录下的随机文件，两者都只允许当前用户读写（0600）。
// 说明：密钥与密文同机存放，加密主要防止单独拷走会话文件后被直接复用，不能防御能读本用户目录的程序。
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const VERSION = 1;

export function encrypt(key, plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { v: VERSION, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function decrypt(key, box) {
  if (box?.v !== VERSION) throw new Error('会话文件版本不匹配');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
}

/** sessions Map -> 可序列化数组；已超时的不写 */
export function serializeSessions(sessions, idleMs, now = Date.now()) {
  const out = [];
  for (const [sid, s] of sessions) {
    if (now - s.lastSeen > idleMs) continue;
    out.push({ sid, user: s.user, lastSeen: s.lastSeen, cookies: [...s.cookies] });
  }
  return out;
}

/** 反序列化并丢弃超时或格式不对的条目 */
export function deserializeSessions(list, idleMs, now = Date.now()) {
  const out = new Map();
  if (!Array.isArray(list)) return out;
  for (const x of list) {
    if (!x || typeof x.sid !== 'string' || !/^[0-9a-f]{64}$/.test(x.sid)) continue;
    if (typeof x.user !== 'string' || typeof x.lastSeen !== 'number' || !Array.isArray(x.cookies)) continue;
    if (now - x.lastSeen > idleMs) continue;
    const cookies = new Map(x.cookies.filter((p) => Array.isArray(p) && p.length === 2).map(([k, v]) => [String(k), String(v)]));
    out.set(x.sid, { user: x.user, lastSeen: x.lastSeen, cookies });
  }
  return out;
}

function writePrivate(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows 上 chmod 只影响只读位，忽略 */
  }
}

/**
 * 基于目录的会话存储。dir 下有 session.key（密钥）和 sessions.json（密文）。
 * 所有错误只记录不抛出：持久化失败时退化为纯内存会话，不影响登录。
 */
export function createSessionStore(dir, { log = console } = {}) {
  const keyFile = path.join(dir, 'session.key');
  const dataFile = path.join(dir, 'sessions.json');
  let key = null;

  function ensureKey() {
    if (key) return key;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(keyFile)) {
      const k = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
      if (k.length === 32) return (key = k);
      log.error('[session] 密钥文件损坏，已重新生成（之前保存的登录会失效）');
    }
    key = randomBytes(32);
    writePrivate(keyFile, key.toString('base64'));
    return key;
  }

  return {
    dataFile,
    load(idleMs) {
      try {
        if (!existsSync(dataFile)) return new Map();
        const box = JSON.parse(readFileSync(dataFile, 'utf8'));
        return deserializeSessions(JSON.parse(decrypt(ensureKey(), box)), idleMs);
      } catch (e) {
        log.error('[session] 读取已保存的登录失败，需要重新登录：', e.message);
        return new Map();
      }
    },
    save(sessions, idleMs) {
      try {
        const list = serializeSessions(sessions, idleMs);
        if (!list.length) return rmSync(dataFile, { force: true });
        writePrivate(dataFile, JSON.stringify(encrypt(ensureKey(), JSON.stringify(list))));
      } catch (e) {
        log.error('[session] 保存登录状态失败：', e.message);
      }
    },
  };
}
