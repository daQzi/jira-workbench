// A8 协同（致远）工时系统接入：登录、未填写工日查询、配置存储。
// 接口与加密逻辑对照 auto-okr 的 A8LoginUtils / A8Client（a8_service.py）。
// 只在本机代理内使用账号密码；页面只能看到「已配置」和末位掩码。
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decrypt, encrypt } from './sessionStore.mjs';
import { normalizeUrl } from './settings.mjs';

export const DEFAULT_A8_URL = 'http://pp.bosssoft.com.cn:28101';

// 「工作日工时未填报查询」报表（A8 固定报表，取自 auto-okr）
const REPORT_ID = '3098973709647955683';
const QUERY_ID = '7862466538275884248';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 20_000;
const COOKIE_TTL_MS = 45 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const cookieCache = new Map();

function timeout(ms = TIMEOUT_MS) {
  return AbortSignal.timeout(ms);
}

function fail(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

/**
 * 生成 A8 登录密码密文，与页面里的 CryptoJS.DES.encrypt(明文, _SecuritySeed) 完全一致：
 * OpenSSL 兼容格式 "Salted__" + salt + 3DES-CBC（K1=K2=K3），
 * 密钥/IV 由 EVP_BytesToKey(MD5) 从「口令 = _SecuritySeed」和 salt 派生。
 */
export function encryptA8Password(password, seed, salt = randomBytes(8)) {
  // CryptoJS 的「口令」是 _SecuritySeed，明文才是密码；派生密钥用口令 + salt
  const pass = Buffer.from(String(seed ?? ''), 'utf8');
  const plain = Buffer.from(String(password ?? ''), 'utf8');
  let prev = Buffer.alloc(0);
  let material = Buffer.alloc(0);
  while (material.length < 16) {
    prev = createHash('md5').update(Buffer.concat([prev, pass, salt])).digest();
    material = Buffer.concat([material, prev]);
  }
  const key = material.subarray(0, 8);
  const iv = material.subarray(8, 16);
  let body;
  try {
    const cipher = createCipheriv('des-ede3-cbc', Buffer.concat([key, key, key]), iv);
    body = Buffer.concat([cipher.update(plain), cipher.final()]);
  } catch (e) {
    throw fail(`当前 Node 运行时不支持 A8 登录所需的 DES 加密：${e.message}`, 500);
  }
  return Buffer.concat([Buffer.from('Salted__'), salt, body]).toString('base64');
}

/** 极简 Cookie 容器：服务端会分多次 Set-Cookie，且登录前后需要带回。 */
class CookieJar {
  constructor(init = '') {
    this.map = new Map();
    for (const part of String(init).split(';')) {
      const i = part.indexOf('=');
      if (i > 0) this.map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  }

  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of list) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  header() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function request(url, init, jar) {
  const res = await fetch(url, {
    ...init,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      ...(jar?.header() ? { Cookie: jar.header() } : {}),
      ...(init.headers || {}),
    },
    redirect: 'manual',
    signal: init.signal || timeout(),
  });
  jar?.absorb(res);
  return res;
}

function decodeHeader(value) {
  const s = String(value || '');
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** GET 登录页，跟随少量跳转并收集 cookie，返回 _SecuritySeed */
async function fetchSecuritySeed(base, jar) {
  let url = `${base}/seeyon/main.do`;
  for (let hop = 0; hop < 6; hop++) {
    const res = await request(url, { method: 'GET' }, jar);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw fail(`A8 登录页返回 ${res.status} 但没有跳转地址`);
      url = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) throw fail(`A8 登录页不可用（HTTP ${res.status}），请检查地址`);
    const html = await res.text();
    const seed = /_SecuritySeed\s*=\s*'([0-9-]+)'/.exec(html)?.[1];
    if (!seed) throw fail('A8 登录页未返回安全种子（_SecuritySeed），请检查地址是否指向 A8 首页');
    return seed;
  }
  throw fail('A8 登录页跳转次数过多');
}

function normalizeCookie(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.includes('=')) return s;
  return `JSESSIONID=${s}`;
}

/**
 * 账号密码登录，返回可直接放进请求头的 Cookie。
 * 与 auto-okr 一样：先取种子，加密密码，再 POST main.do?method=login，检查 loginok 头。
 */
export async function loginA8(cfg) {
  if (cfg.browserCookie) return normalizeCookie(cfg.browserCookie);
  const base = normalizeA8Url(cfg.url);
  const username = String(cfg.username || '').trim();
  const password = String(cfg.password || '');
  if (!username || !password) throw fail('请先配置 A8 用户名和密码', 400);

  const jar = new CookieJar();
  const seed = await fetchSecuritySeed(base, jar);
  const encryptPwd = encryptA8Password(password, seed);

  const form = new URLSearchParams();
  form.append('authorization', '');
  form.append('login.timezone', 'GMT+8:00');
  form.append('province', '');
  form.append('city', '');
  form.append('redirect_url', '');
  form.append('token_login_app_id', '');
  form.append('token_login_third_user_id', '');
  form.append('request_auth_authenticator', '');
  form.append('rectangle', '');
  form.append('login_username', username);
  form.append('trustdo_type', '');
  form.append('login_password', encryptPwd);
  form.append('login_validatePwdStrength', '3');
  form.append('selGroup', '');
  form.append('phone_number', '');
  form.append('login_smsVerifyCode', '');
  form.append('trustdo_type', '');
  form.append('random', '');
  form.append('fontSize', '12');
  form.append('screenWidth', '1920');
  form.append('screenHeight', '1080');

  const res = await request(
    `${base}/seeyon/main.do?method=login`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${base}/seeyon/main.do`,
      },
      body: form.toString(),
    },
    jar,
  );
  const loginOk = String(res.headers.get('loginok') || '').toLowerCase();
  if (loginOk !== 'ok') {
    const reason = decodeHeader(res.headers.get('loginerror') || '');
    throw fail(
      `${reason ? `A8 登录失败：${reason}` : `A8 登录失败（HTTP ${res.status}）`}；` +
        '如果账号启用了图形验证码或单点登录，可在配置里填写浏览器 Cookie',
      401,
    );
  }
  const sid = jar.map.get('JSESSIONID');
  if (!sid) throw fail('A8 登录成功但未返回 JSESSIONID，请改用浏览器 Cookie', 401);
  return `JSESSIONID=${sid}`;
}

export function normalizeA8Url(raw) {
  if (!String(raw || '').trim()) throw fail('请填写 A8 地址', 400);
  try {
    return normalizeUrl(raw, 'A8 地址');
  } catch (e) {
    throw fail(e.message, 400);
  }
}

export function normalizeA8ConfigInput(body, current = null) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const url = normalizeA8Url(typeof b.url === 'string' ? b.url : current?.url || DEFAULT_A8_URL);
  const username = typeof b.username === 'string' ? b.username.trim() : String(current?.username || '');
  if (!username) throw fail('请填写 A8 用户名', 400);
  if (username.length > 100) throw fail('A8 用户名过长', 400);
  const typedPassword = typeof b.password === 'string' ? b.password : '';
  const password = typedPassword || String(current?.password || '');
  const typedCookie = typeof b.browserCookie === 'string' ? b.browserCookie.trim() : '';
  // 优先级：填了新 Cookie 用 Cookie；只填新密码说明要改回密码登录，清掉旧 Cookie；都留空沿用原凭据。
  const browserCookie = typedCookie || (typedPassword ? '' : String(current?.browserCookie || ''));
  if (browserCookie.length > 8000) throw fail('浏览器 Cookie 过长', 400);
  if (!password && !browserCookie) throw fail('请填写 A8 密码，或提供浏览器 Cookie', 400);
  const templateId = typeof b.templateId === 'string' ? b.templateId.trim() : String(current?.templateId || '');
  if (templateId && !/^\d{1,32}$/.test(templateId)) throw fail('A8 模板 ID 格式不正确', 400);
  return { url, username, password, browserCookie, templateId, updatedAt: new Date().toISOString() };
}

/**
 * A8 配置单独存放（a8.json，AES-GCM 加密），避免把密码混进连接设置。
 */
export function createA8Store(file) {
  const keyFile = `${file}.key`;
  const dir = path.dirname(file);
  let cachedKey = null;

  function key() {
    if (cachedKey) return cachedKey;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(keyFile)) {
      const buf = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
      if (buf.length === 32) return (cachedKey = buf);
      throw fail('A8 配置密钥文件损坏，请删除 a8.json 与 a8.json.key 后重新填写', 500);
    }
    cachedKey = randomBytes(32);
    writeFileSync(keyFile, cachedKey.toString('base64'), { mode: 0o600 });
    return cachedKey;
  }

  function read() {
    if (!existsSync(file)) return null;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      const cfg = raw?.box ? JSON.parse(decrypt(key(), raw.box)) : raw;
      if (!cfg || typeof cfg !== 'object' || !cfg.username) return null;
      return { ...cfg, url: String(cfg.url || DEFAULT_A8_URL), browserCookie: String(cfg.browserCookie || '') };
    } catch (e) {
      if (e.status) throw e;
      throw fail(`A8 配置读取失败：${e.message}`, 500);
    }
  }

  function write(cfg) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, box: encrypt(key(), JSON.stringify(cfg)) }) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* Windows 忽略 */
    }
  }

  return {
    file,
    get: read,
    save(body) {
      const cfg = normalizeA8ConfigInput(body, read());
      write(cfg);
      cookieCache.clear();
      return cfg;
    },
    publicInfo() {
      const cfg = read();
      if (!cfg) {
        return {
          configured: false,
          url: DEFAULT_A8_URL,
          username: '',
          passwordSet: false,
          cookieSet: false,
          templateId: '',
        };
      }
      return {
        configured: !!cfg.username && !!(cfg.password || cfg.browserCookie),
        url: cfg.url,
        username: cfg.username,
        passwordSet: !!cfg.password,
        cookieSet: !!cfg.browserCookie,
        templateId: cfg.templateId || '',
        updatedAt: cfg.updatedAt || null,
      };
    },
  };
}

function cacheKey(cfg) {
  return `${normalizeA8Url(cfg.url)}|${cfg.username}|${cfg.browserCookie ? 'cookie' : 'login'}`;
}

async function cookieFor(cfg, force = false) {
  if (cfg.browserCookie) return normalizeCookie(cfg.browserCookie);
  const key = cacheKey(cfg);
  const hit = cookieCache.get(key);
  if (!force && hit && Date.now() - hit.at < COOKIE_TTL_MS) return hit.cookie;
  const cookie = await loginA8(cfg);
  cookieCache.set(key, { cookie, at: Date.now() });
  return cookie;
}

export async function testA8Connection(cfg) {
  const cookie = await cookieFor(cfg, true);
  const base = normalizeA8Url(cfg.url);
  const res = await fetch(`${base}/seeyon/main.do?method=main`, {
    headers: { Cookie: cookie, 'User-Agent': USER_AGENT },
    redirect: 'manual',
    signal: timeout(),
  });
  if (res.status >= 400) throw fail(`A8 主页面返回 HTTP ${res.status}，登录状态可能无效`, 502);
  return { ok: true };
}

/**
 * 取可直接用于请求头的 Cookie，供草稿推送等后续模块复用。
 * 与查询共用 45 分钟内存缓存；登录失效（401）时清缓存重试一次。
 */
export async function a8Cookie(cfg, { forceLogin = false } = {}) {
  return cookieFor(cfg, forceLogin);
}

export function validateDate(value, label) {
  const s = String(value || '').trim();
  if (!DATE_RE.test(s)) throw fail(`${label}格式应为 YYYY-MM-DD`, 400);
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) throw fail(`${label}不是有效日期`, 400);
  return s;
}

function normalizeA8Date(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 从 A8 报表返回值里取出未填工日；结构异常直接抛错，不静默返回空数组。 */
export function parseUnfilledResponse(json) {
  const code = json?.code;
  if (code !== undefined && String(code) !== '0') {
    throw fail(`A8 查询失败：${json?.errorMsg || json?.message || `code=${code}`}`);
  }
  const wrapper = json?.data;
  if (wrapper && wrapper.success === false) {
    throw fail(`A8 查询失败：${wrapper.errorMsg || wrapper.message || '返回 success=false'}`);
  }
  const rows = wrapper?.data?.data ?? json?.data?.data?.data ?? [];
  if (!Array.isArray(rows)) throw fail('A8 查询返回格式异常（缺少 data.data.data 数组）');
  const dates = [];
  for (const row of rows) {
    const cell = row?.data?.['4'] ?? row?.data?.[4];
    const date = normalizeA8Date(cell?.v ?? cell);
    if (date && !dates.includes(date)) dates.push(date);
  }
  return dates.sort();
}

function unfilledPayload(start, end) {
  return {
    platform: '1',
    op: 'default',
    queryParams: {
      userConditions: [
        {
          aliasTableName: 'formson_0494_1',
          fieldName: 'field0006',
          fieldValue: start,
          leftChar: '(',
          operation: 'GreatEqual',
          rightChar: '',
          rowOperation: 'and',
          fieldType: 'TIMESTAMP',
          inputType: 'date',
        },
        {
          aliasTableName: 'formson_0494_1',
          fieldName: 'field0006',
          fieldValue: end,
          leftChar: '',
          operation: 'LessEqual',
          rightChar: ')',
          rowOperation: 'and',
          fieldType: 'TIMESTAMP',
          inputType: 'date',
        },
        {
          aliasTableName: 'formson_0494_1',
          fieldName: 'field0017',
          fieldValue: [{ id: '6962225325866241176', name: '否', value: '0' }],
          leftChar: '(',
          operation: 'Equal',
          rightChar: ')',
          rowOperation: 'and',
          fieldType: 'DECIMAL',
          inputType: 'select',
        },
        {
          aliasTableName: 'formmain_0493_0',
          fieldName: 'field0024',
          fieldValue: '是',
          leftChar: '(',
          operation: 'Like',
          rightChar: ')',
          rowOperation: 'and',
          fieldType: 'VARCHAR',
          inputType: 'text',
        },
      ],
      customOrderFields: [],
      bizId: REPORT_ID,
      appId: QUERY_ID,
      _t: String(Date.now()),
      isShowCondition: true,
      schlogId: null,
      preview: null,
      conditionId: null,
      templateId: null,
      isMobile: false,
      print: false,
      bussId: REPORT_ID,
      platform: '1',
    },
    pagination: { page: 1, pageSize: 200 },
    enableConStyle: true,
  };
}

async function queryUnfilled(cfg, cookie, start, end) {
  const base = normalizeA8Url(cfg.url);
  const url = `${base}/seeyon/rest/cap4/report/${REPORT_ID}/query/${QUERY_ID}/1`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      Referer: `${base}/seeyon/rest/cap4/report/${REPORT_ID}/${QUERY_ID}/1/index.html?bizId=${REPORT_ID}&appId=${QUERY_ID}`,
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(unfilledPayload(start, end)),
    signal: timeout(30_000),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403 || /^\s*</.test(text)) {
    throw fail('A8 登录状态已失效', 401);
  }
  if (!res.ok) throw fail(`A8 查询失败（HTTP ${res.status}）：${text.slice(0, 200)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw fail(`A8 查询返回的不是 JSON：${text.slice(0, 200)}`);
  }
  return parseUnfilledResponse(json);
}

/**
 * 查询区间内未填写工时的工作日。
 * 登录失效时清缓存重试一次；其它错误直接抛给页面。
 */
export async function fetchUnfilledWorkdays(cfg, start, end, { forceLogin = false } = {}) {
  const from = validateDate(start, '开始日期');
  const to = validateDate(end, '结束日期');
  if (from > to) throw fail('开始日期不能晚于结束日期', 400);
  const days = Math.round((new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86_400_000) + 1;
  if (days > 92) throw fail('单次查询范围不能超过 92 天', 400);

  const cookie = await cookieFor(cfg, forceLogin);
  try {
    return await queryUnfilled(cfg, cookie, from, to);
  } catch (e) {
    if (e.status !== 401 || cfg.browserCookie) throw e;
    cookieCache.delete(cacheKey(cfg));
    const fresh = await cookieFor(cfg, true);
    return await queryUnfilled(cfg, fresh, from, to);
  }
}
