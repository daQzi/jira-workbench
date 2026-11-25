import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createA8Store, encryptA8Password, normalizeA8ConfigInput, parseUnfilledResponse } from './a8.mjs';

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** 用 OpenSSL EVP_BytesToKey 反向解开，验证与 CryptoJS.DES.encrypt 的密文格式一致 */
function decryptLikeCryptoJs(payload, seed) {
  const raw = Buffer.from(payload, 'base64');
  expect(raw.subarray(0, 8).toString()).toBe('Salted__');
  const salt = raw.subarray(8, 16);
  const pass = Buffer.from(seed, 'utf8');
  let prev = Buffer.alloc(0);
  let material = Buffer.alloc(0);
  while (material.length < 16) {
    prev = createHash('md5').update(Buffer.concat([prev, pass, salt])).digest();
    material = Buffer.concat([material, prev]);
  }
  const key = material.subarray(0, 8);
  const d = createDecipheriv('des-ede3-cbc', Buffer.concat([key, key, key]), material.subarray(8, 16));
  return Buffer.concat([d.update(raw.subarray(16)), d.final()]).toString('utf8');
}

describe('A8 登录', () => {
  it('密码密文可被 CryptoJS 同格式解出（含 + 与中文）', () => {
    const salt = Buffer.from('0001020304050607', 'hex');
    const out = encryptA8Password('P@ssw0rd+中文', '58527', salt);
    // 固定 salt 时与 CryptoJS.DES.encrypt(CryptoJS.enc.Utf8.parse(pwd), seed) 输出完全一致
    expect(out).toBe('U2FsdGVkX18AAQIDBAUGB1suv44MGVhpNv4mUxYpHIM=');
    expect(decryptLikeCryptoJs(out, '58527')).toBe('P@ssw0rd+中文');
  });

  it('每次加密使用随机 salt', () => {
    const a = encryptA8Password('x', 'seed', randomBytes(8));
    const b = encryptA8Password('x', 'seed', randomBytes(8));
    expect(a).not.toBe(b);
    expect(decryptLikeCryptoJs(a, 'seed')).toBe('x');
  });
});

describe('A8 未填工日', () => {
  it('取 data.data.data 里的日期列（字符串键与数字键都支持）', () => {
    const json = {
      code: '0',
      data: {
        data: {
          data: [
            { data: { 4: { v: '2026-11-02' } } },
            { data: { '4': { v: '2026-11-03 00:00:00' } } },
            { data: { 4: { v: '2026-11-02' } } },
          ],
        },
      },
    };
    expect(parseUnfilledResponse(json)).toEqual(['2026-11-02', '2026-11-03']);
  });

  it('失败码与结构异常必须报错，不能当成“没有缺失”', () => {
    expect(() => parseUnfilledResponse({ code: '1', errorMsg: '会话失效' })).toThrow('会话失效');
    expect(() => parseUnfilledResponse({ code: '0', data: { success: false, errorMsg: '无权查看' } })).toThrow('无权查看');
    expect(() => parseUnfilledResponse({ code: '0', data: { data: { data: 'x' } } })).toThrow('格式异常');
  });
});

describe('A8 配置存储', () => {
  it('密码加密落盘，读取后可用；公开信息不含密码', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wb-a8-'));
    dirs.push(dir);
    const file = path.join(dir, 'a8.json');
    const store = createA8Store(file);
    expect(store.publicInfo().configured).toBe(false);
    store.save({ url: 'http://pp.bosssoft.com.cn:28101/', username: '58527', password: 'secret' });
    const cfg = store.get();
    expect(cfg.password).toBe('secret');
    expect(cfg.url).toBe('http://pp.bosssoft.com.cn:28101');
    expect(JSON.stringify(store.publicInfo())).not.toContain('secret');
    // 重新打开同一文件也能读（密钥在 a8.json.key）
    expect(createA8Store(file).get().password).toBe('secret');
  });

  it('校验必填项，密码留空时沿用已保存值', () => {
    const base = { url: 'http://a8.example.com', username: 'u', password: 'p' };
    expect(() => normalizeA8ConfigInput({ ...base, password: '' }, null)).toThrow('密码');
    expect(normalizeA8ConfigInput({ ...base, password: '' }, base).password).toBe('p');
    expect(() => normalizeA8ConfigInput({ ...base, url: 'ftp://a' })).toThrow('只支持');
    expect(normalizeA8ConfigInput({ url: 'http://a8.example.com', username: 'u', browserCookie: 'JSESSIONID=1' }).password).toBe('');
  });

  it('Cookie 与密码的切换规则', () => {
    const savedPassword = { url: 'http://a8.example.com', username: 'u', password: 'p', browserCookie: '' };
    // 只填 Cookie：改用 Cookie 登录，保留原密码备用
    expect(normalizeA8ConfigInput({ ...savedPassword, password: '', browserCookie: 'JSESSIONID=1' }, savedPassword).browserCookie).toBe('JSESSIONID=1');
    // 只填新密码：改回密码登录，清掉旧 Cookie
    expect(normalizeA8ConfigInput({ ...savedPassword, password: 'new', browserCookie: '' }, { ...savedPassword, browserCookie: 'JSESSIONID=1' }).browserCookie).toBe('');
    expect(normalizeA8ConfigInput({ ...savedPassword, password: 'new' }, savedPassword).password).toBe('new');
  });
});
