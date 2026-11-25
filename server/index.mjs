// 本地代理：持有 Jira 会话 cookie，浏览器只拿到本地 sid。
// 只监听 127.0.0.1；默认只读。写操作需 WB_ALLOW_WRITE=1，且只放行白名单写接口；
// WB_WRITE_PROJECTS=AGENT,XXX 可把写操作限制在指定项目（验证阶段用）。不提供任何删除接口。
import http from 'node:http';
import { createMcpFeature } from './mcp.mjs';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWrite as checkWritePolicy, fileResponseHeaders, isAttachmentUpload, linkDeleteId, ownedTarget, parseFilePath } from './policy.mjs';
import { configureLlm, llmStatus, splitDaily } from './llm.mjs';
import { DEFAULT_A8_URL, a8Cookie, createA8Store, fetchUnfilledWorkdays, testA8Connection } from './a8.mjs';
import { listA8Templates, probeA8Template, pushA8Draft } from './a8-draft.mjs';
import { generateWorklog } from './worklog.mjs';
import { createSessionStore } from './sessionStore.mjs';
import { createRememberedLoginStore, REMEMBER_SECONDS } from './remembered-login.mjs';
import { createReadCache, readTtl } from './read-cache.mjs';
import { createJiraScheduler, readProjects, writeProjects } from './jira-scheduler.mjs';
import { DEFAULT_JIRA_BASE_URL, DEFAULT_LLM, isLocalRequest, jiraOrDefault, maskKey, parseSettingsInput, readJson, saveSettings } from './settings.mjs';
import { createStack } from '../stack/index.mjs';

export { DEFAULT_JIRA_BASE_URL };

// 运行配置：命令行启动时取环境变量；桌面端通过 startServer(opts) 传入
let jiraScheduler = createJiraScheduler();
const cacheEpoch = randomBytes(8).toString('hex');
let cacheRevision = 0;
let allProjectsRevision = 0;
const projectRevisions = new Map();
let JIRA_BASE_URL = '';
let PORT = 8787;
const HOST = '127.0.0.1';
let ALLOW_WRITE = false;
let WRITE_PROJECTS = [];
let SERVE_DIST = false;
let DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
/** 登录页「连接设置」保存到的文件；未配置时设置只在内存生效 */
let SETTINGS_FILE = null;
/** 联调栈（独立子项目 stack/）：随工作台启停，配置在 stack.json */
let stack = null;
let STACK_UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'stack', 'ui');
/** 当前生效的大模型配置（含 Key，只在本进程使用） */
let LLM_OPTS = {};
/** A8 工时系统配置（含密码，加密落盘；只在代理进程内使用） */
let a8Store = null;

export function parseProjects(text = '') {
  return String(text)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}
const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
const JIRA_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1024 * 1024;
// 附件上限与 Jira 配置一致（attachment/meta 返回 100MB）
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// 允许 GET 的 Jira REST v2 路径前缀，避免代理被当作任意 URL 跳板
const READ_PREFIXES = [
  'search', 'issue/', 'project', 'field', 'priority', 'status', 'issuetype',
  'resolution', 'user/', 'issueLinkType', 'filter/', 'mypermissions', 'serverInfo',
];

/** @type {Map<string, {cookies: Map<string,string>, user: string, lastSeen: number}>} */
const sessions = new Map();
/** 会话落盘（重启免登录）；未配置目录时只在内存 */
let store = null;
let rememberedLogin = null;
let mcp = null;
const readCache = createReadCache();
let saveTimer = null;
let lastSavedAt = 0;
// lastSeen 每次请求都会变，最多每分钟落盘一次；登录/退出立即保存
const SAVE_EVERY_MS = 60_000;

function persistSessions(now = false) {
  if (!store) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const doSave = () => {
    saveTimer = null;
    lastSavedAt = Date.now();
    store.save(sessions, SESSION_IDLE_MS);
  };
  if (now) return doSave();
  saveTimer = setTimeout(doSave, 1000);
  saveTimer.unref?.();
}

function dropSession(sid) {
  if (sessions.delete(sid)) {
    readCache.clearSession(sid);
    persistSessions(true);
  }
}

function parseCookieHeader(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function absorbSetCookies(jar, res) {
  for (const sc of res.headers.getSetCookie()) {
    const [pair] = sc.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

function jarHeader(jar) {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(data);
}

function sendError(res, status, message) {
  sendJson(res, status, { errorMessages: [message], errors: {} });
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function getSession(req) {
  const sid = parseCookieHeader(req.headers.cookie).wb_sid;
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() - s.lastSeen > SESSION_IDLE_MS) {
    dropSession(sid);
    return null;
  }
  s.lastSeen = Date.now();
  if (!saveTimer && s.lastSeen - lastSavedAt > SAVE_EVERY_MS) persistSessions();
  return { sid, ...s, ref: s };
}

async function jiraFetch(jar, pathAndQuery, init = {}) {
  const { priority = (init.method && init.method !== 'GET' ? 0 : 1), signal, ...options } = init;
  const target = JIRA_BASE_URL;
  return jiraScheduler.run(async () => {
    const timeout = AbortSignal.timeout(JIRA_TIMEOUT_MS);
    const res = await fetch(target + pathAndQuery, {
    ...options,
    headers: {
      Accept: 'application/json',
      // Jira 6 对非 GET 请求做 XSRF 校验，REST 调用需带此头
      'X-Atlassian-Token': 'no-check',
      ...(jar.size ? { Cookie: jarHeader(jar) } : {}),
      ...(init.headers || {}),
    },
    redirect: 'manual',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  absorbSetCookies(jar, res);
    const buf = await res.arrayBuffer();
    return new Response([204, 205, 304].includes(res.status) ? null : buf, { status: res.status, statusText: res.statusText, headers: res.headers });
  }, { signal, priority });
}

function dataRevision(project) {
  return project ? `${cacheEpoch}:${allProjectsRevision}:${projectRevisions.get(project.toUpperCase()) || 0}` : `${cacheEpoch}:${cacheRevision}`;
}
function invalidateJira(projects) {
  cacheRevision++;
  if (!projects?.length) allProjectsRevision = cacheRevision;
  else for (const project of projects) projectRevisions.set(project, cacheRevision);
  readCache.invalidate(path => {
    const scope = readProjects(path);
    return scope === null || (scope.length && (!projects?.length || scope.some(p => projects.includes(p))));
  });
}
async function readJira(session, sub, { signal, refresh = false, priority = 1 } = {}) {
  const ttl = readTtl(sub.split('?')[0]);
  if (!ttl) return jiraFetch(session.cookies, `/rest/api/2/${sub}`, { signal, priority });
  const projects = readProjects(`/rest/api/2/${sub}`);
  const revision = () => projects === null ? String(cacheRevision) : projects.map(dataRevision).join(',');
  const generation = revision();
  const value = await readCache.get(session.sid, `/rest/api/2/${sub}`, ttl, async sharedSignal => {
    const upstream = await jiraFetch(session.cookies, `/rest/api/2/${sub}`, { signal: sharedSignal, priority });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type') || '';
    if (upstream.ok && contentType.includes('json')) JSON.parse(buf.toString());
    return { status: upstream.status, buf, contentType };
  }, { signal, refresh });
  if (generation !== revision()) throw Object.assign(new Error('数据已发生变更，请重新加载'), { status: 409 });
  return new Response([204, 205, 304].includes(value.status) ? null : value.buf, { status: value.status, headers: { 'Content-Type': value.contentType, 'X-WB-Fetched-At': String(value.fetchedAt || Date.now()) } });
}

async function handleLogin(req, res) {
  if (!JIRA_BASE_URL) return sendError(res, 400, '请先在「连接设置」中填写 Jira 地址');
  let creds;
  try {
    creds = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    return sendError(res, 400, '请求格式错误');
  }
  if (!creds || typeof creds !== 'object' || Array.isArray(creds)) return sendError(res, 400, '请求格式错误');
  const username = typeof creds?.username === 'string' ? creds.username.trim() : '';
  if (['rememberAccount', 'rememberPassword', 'useSavedPassword'].some(key => creds[key] !== undefined && typeof creds[key] !== 'boolean')) return sendError(res, 400, '记住密码参数格式错误');
  if (creds.rememberPassword && creds.rememberAccount === false) return sendError(res, 400, '记住密码时需要同时记住账号');
  const usesRememberedLogin = creds.rememberAccount !== undefined || creds.rememberPassword !== undefined || creds.useSavedPassword;
  if (usesRememberedLogin && !isLocalRequest(req.headers)) return sendError(res, 403, '只允许本机页面使用记住密码');
  if ((creds.rememberPassword || creds.rememberAccount) && !rememberedLogin) return sendError(res, 400, '本机已关闭登录持久化，无法记住账号密码');
  const jiraBaseUrl = JIRA_BASE_URL;
  const token = parseCookieHeader(req.headers.cookie).wb_remember;
  let password = typeof creds?.password === 'string' ? creds.password : '';
  if (creds.useSavedPassword && !password) {
    const saved = rememberedLogin?.get(token, jiraBaseUrl);
    if (!saved?.password || saved.username !== username) return sendError(res, 400, '已保存密码不可用，请重新输入密码');
    password = saved.password;
  }
  if (!username || !password) return sendError(res, 400, '请输入用户名和密码');

  const jar = new Map();
  const jr = await jiraFetch(jar, '/rest/auth/1/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (JIRA_BASE_URL !== jiraBaseUrl) return sendError(res, 409, 'Jira 地址已更改，请重新登录');
  if (!jr.ok) {
    // Jira 连续失败后会要求验证码，此时只能去原生页面登录一次
    const denied = jr.headers.get('x-authentication-denied-reason');
    const msg = denied ? '登录被 Jira 拒绝（可能需要验证码），请先在 Jira 原生页面登录一次' : '用户名或密码错误';
    return sendError(res, jr.status === 403 ? 403 : 401, msg);
  }
  const cookies = [];
  if (creds.rememberPassword === true || creds.rememberAccount === true) {
    const savedToken = rememberedLogin.save(token, jiraBaseUrl, username, creds.rememberPassword ? password : '');
    cookies.push(`wb_remember=${savedToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${REMEMBER_SECONDS}`);
  } else if (creds.rememberPassword === false || creds.rememberAccount === false) {
    rememberedLogin?.forget(token);
    cookies.push('wb_remember=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  }
  const sid = randomBytes(32).toString('hex');
  sessions.set(sid, { cookies: jar, user: username, lastSeen: Date.now() });
  persistSessions(true);
  sendJson(res, 200, { name: username }, {
    // 带 Max-Age：关掉窗口/重启浏览器后 cookie 仍在；真正的过期由服务端空闲超时和 Jira 会话决定
    'Set-Cookie': [`wb_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`, ...cookies],
  });
}

function handleRememberedLogin(req, res) {
  if (!isLocalRequest(req.headers) || req.headers['sec-fetch-site'] === 'cross-site') return sendError(res, 403, '只允许本机页面访问已保存的登录');
  const token = parseCookieHeader(req.headers.cookie).wb_remember;
  if (req.method === 'DELETE') {
    rememberedLogin?.forget(token);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'wb_remember=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  const saved = rememberedLogin?.get(token, JIRA_BASE_URL);
  sendJson(res, 200, { available: !!rememberedLogin, username: saved?.username || '', passwordSaved: !!saved?.password });
}

async function handleMe(req, res) {
  const s = getSession(req);
  if (!s) return sendError(res, 401, '未登录');
  const jr = await jiraFetch(s.cookies, '/rest/auth/1/session');
  if (!jr.ok) {
    dropSession(s.sid);
    return sendError(res, 401, 'Jira 会话已失效，请重新登录');
  }
  const body = await jr.json();
  sendJson(res, 200, {
    name: body.name,
    jiraBaseUrl: JIRA_BASE_URL,
    allowWrite: ALLOW_WRITE,
    writeProjects: ALLOW_WRITE ? WRITE_PROJECTS : [],
    llm: llmStatus(),
  });
}

/** 日报拆分：需已登录，避免本机其他网页借代理消耗模型额度 */
async function handleLlmSplit(req, res) {
  const s = getSession(req);
  if (!s) return sendError(res, 401, '未登录');
  let input;
  try {
    input = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    return sendError(res, 400, '请求格式错误');
  }
  try {
    const out = await splitDaily(input);
    console.log(`[llm] ${s.user} split ${out.tasks.length} tasks in ${out.elapsedMs}ms (${out.model})`);
    sendJson(res, 200, out);
  } catch (e) {
    const status = e.status || (e.name === 'TimeoutError' ? 504 : 502);
    console.error(`[llm] ${s.user} split failed:`, e.message);
    sendError(res, status, status === 504 ? '大模型响应超时' : e.message);
  }
}

function publicSettings() {
  return {
    jiraBaseUrl: JIRA_BASE_URL,
    llmBaseUrl: LLM_OPTS.baseUrl || '',
    llmModel: LLM_OPTS.model || '',
    llmKeySet: !!LLM_OPTS.apiKey,
    llmKeyMask: maskKey(LLM_OPTS.apiKey),
    saved: !!SETTINGS_FILE,
  };
}

// ---------- A8 工时 ----------

function a8Public() {
  const info = a8Store ? a8Store.publicInfo() : { configured: false, url: DEFAULT_A8_URL, username: '', passwordSet: false, cookieSet: false };
  return { ...info, saved: !!a8Store, llm: llmStatus() };
}

/** A8 地址/账号密码是本机敏感配置：读写都只允许工作台页面本身发起 */
function assertLocal(req, res) {
  if (!isLocalRequest(req.headers)) {
    sendError(res, 403, '只允许本机工作台页面访问 A8 配置');
    return false;
  }
  return true;
}

async function readJsonBody(req) {
  try {
    const value = JSON.parse((await readBody(req)).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function handleA8ConfigGet(req, res) {
  if (!assertLocal(req, res)) return;
  sendJson(res, 200, a8Public());
}

async function handleA8ConfigPut(req, res) {
  if (!assertLocal(req, res)) return;
  const body = await readJsonBody(req);
  if (!body) return sendError(res, 400, '请求格式错误');
  try {
    a8Store.save(body);
  } catch (e) {
    return sendError(res, e.status || 500, e.status ? e.message : `A8 配置保存失败：${e.message}`);
  }
  console.log(`[a8] 配置已保存：${a8Store.publicInfo().username} @ ${a8Store.publicInfo().url}`);
  sendJson(res, 200, a8Public());
}

async function handleA8Test(req, res) {
  if (!assertLocal(req, res)) return;
  const cfg = a8Store?.get();
  if (!cfg) return sendError(res, 400, '请先保存 A8 地址与账号');
  try {
    await testA8Connection(cfg);
    sendJson(res, 200, { ok: true, url: cfg.url, username: cfg.username });
  } catch (e) {
    console.error('[a8] 连接测试失败：', e.message);
    sendError(res, e.status || 502, e.message);
  }
}

function requireA8(res) {
  const cfg = a8Store?.get();
  if (!cfg || !(cfg.password || cfg.browserCookie)) {
    sendError(res, 400, '请先在「A8 工时」里保存 A8 地址与账号');
    return null;
  }
  return cfg;
}

async function handleA8Unfilled(req, res) {
  if (!assertLocal(req, res)) return;
  const cfg = requireA8(res);
  if (!cfg) return;
  const body = await readJsonBody(req);
  if (!body) return sendError(res, 400, '请求格式错误');
  try {
    const dates = await fetchUnfilledWorkdays(cfg, body.start, body.end);
    console.log(`[a8] ${cfg.username} 未填工日 ${body.start}~${body.end}：${dates.length} 天`);
    sendJson(res, 200, { start: body.start, end: body.end, dates });
  } catch (e) {
    console.error('[a8] 查询未填工日失败：', e.message);
    sendError(res, e.status || 502, e.message);
  }
}

/** 当月 Jira 任务：我经办或开发的问题，按更新时间倒序；只取生成提示需要的字段 */
async function monthIssues(session, month) {
  const jql =
    `(assignee = currentUser() OR cf[10204] = currentUser()) AND ` +
    `(created >= "${month}-01" OR updated >= "${month}-01") ORDER BY updated DESC`;
  const q = new URLSearchParams({ jql, maxResults: '100', fields: 'summary,status,issuetype,updated,created' });
  const r = await jiraFetch(session.cookies, `/rest/api/2/search?${q}`);
  if (r.status === 401) {
    dropSession(session.sid);
    throw Object.assign(new Error('Jira 会话已失效，请重新登录'), { status: 401 });
  }
  const body = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(body?.errorMessages?.join('；') || `Jira HTTP ${r.status}`), { status: 502 });
  return (Array.isArray(body?.issues) ? body.issues : []).map((it) => ({
    key: String(it.key || ''),
    summary: String(it.fields?.summary || ''),
    type: String(it.fields?.issuetype?.name || ''),
    status: String(it.fields?.status?.name || ''),
    updated: String(it.fields?.updated || ''),
  }));
}

async function handleA8WorklogDraft(req, res) {
  const s = getSession(req);
  if (!s) return sendError(res, 401, '未登录');
  if (!assertLocal(req, res)) return;
  const cfg = requireA8(res);
  if (!cfg) return;
  const body = await readJsonBody(req);
  if (!body) return sendError(res, 400, '请求格式错误');
  const start = String(body.start || '');
  const end = String(body.end || '');
  const month = /^\d{4}-\d{2}$/.test(String(body.month || '')) ? String(body.month) : start.slice(0, 7);
  try {
    let dates = Array.isArray(body.dates)
      ? // 前端送来的是已核对的缺失日期：仍限制在查询区间内，避免被本机其它页面塞进任意日期
        body.dates.map((d) => String(d)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= start && d <= end)
      : null;
    if (dates && !dates.length) return sendJson(res, 200, { dates: [], entries: [], issues: [], model: '', message: '所选区间没有需要补填的日期' });
    if (!dates) dates = await fetchUnfilledWorkdays(cfg, start, end);
    dates = [...new Set(dates)].sort();
    if (!dates.length) return sendJson(res, 200, { dates: [], entries: [], issues: [], model: '', message: '所选区间没有缺失工作日' });
    const issues = await monthIssues(s, month);
    const out = await generateWorklog({
      dates,
      issues,
      hoursPerDay: Number(body.hoursPerDay) > 0 ? Number(body.hoursPerDay) : LLM_OPTS.maxHoursPerTask || 8,
      promptExtra: String(body.promptExtra || LLM_OPTS.promptExtra || ''),
    });
    console.log(`[a8] ${s.user} 生成 ${out.entries.length} 天工时草稿（${out.model}，${out.elapsedMs}ms）`);
    sendJson(res, 200, { ...out, dates });
  } catch (e) {
    console.error('[a8] 生成工时草稿失败：', e.message);
    sendError(res, e.status || (e.name === 'TimeoutError' ? 504 : 502), e.name === 'TimeoutError' ? '大模型响应超时' : e.message);
  }
}

/** A8 工时模板列表：只读，用于页面下拉与「推送草稿」前的确认 */
async function handleA8Templates(req, res) {
  if (!assertLocal(req, res)) return;
  const cfg = requireA8(res);
  if (!cfg) return;
  try {
    const cookie = await a8Cookie(cfg);
    const templates = await listA8Templates(cfg, cookie);
    sendJson(res, 200, { templates, current: cfg.templateId || '' });
  } catch (e) {
    console.error('[a8] 读取模板列表失败：', e.message);
    sendError(res, e.status || 502, e.message);
  }
}

/** 模板探测：告诉页面这个模板会把工时填进哪个项目/任务，避免推错 */
async function handleA8TemplateProbe(req, res) {
  if (!assertLocal(req, res)) return;
  const cfg = requireA8(res);
  if (!cfg) return;
  const body = await readJsonBody(req);
  if (!body) return sendError(res, 400, '请求格式错误');
  const templateId = String(body.templateId || '').trim();
  if (!/^\d{1,32}$/.test(templateId)) return sendError(res, 400, '模板 ID 格式不正确');
  try {
    const cookie = await a8Cookie(cfg);
    sendJson(res, 200, await probeA8Template(cfg, cookie, templateId));
  } catch (e) {
    console.error('[a8] 模板探测失败：', e.message);
    sendError(res, e.status || 502, e.message);
  }
}

/**
 * 推送草稿：把页面确认过的工时写进 A8 并保存为草稿。
 * 这是唯一会写 A8 的接口，只接受本机同源请求，且必须已登录本工作台。
 */
async function handleA8PushDraft(req, res) {
  const s = getSession(req);
  if (!s) return sendError(res, 401, '未登录');
  if (!assertLocal(req, res)) return;
  const cfg = requireA8(res);
  if (!cfg) return;
  const body = await readJsonBody(req);
  if (!body) return sendError(res, 400, '请求格式错误');
  const templateId = String(body.templateId || cfg.templateId || '').trim();
  if (!/^\d{1,32}$/.test(templateId)) return sendError(res, 400, '请先选择 A8 工时模板');
  const entries = Array.isArray(body.entries) ? body.entries : [];
  if (!entries.length) return sendError(res, 400, '没有可推送的工时');
  try {
    const cookie = await a8Cookie(cfg);
    const out = await pushA8Draft(cfg, cookie, {
      templateId,
      entries,
      summary: String(body.summary || '').slice(0, 500),
    });
    console.log(`[a8] ${s.user} 已推送 A8 草稿：${out.days} 天 / ${out.hours}h（${out.subject}）`);
    sendJson(res, 200, out);
  } catch (e) {
    console.error('[a8] 推送草稿失败：', e.message);
    sendError(res, e.status || 502, e.message);
  }
}

/** 登录页读取连接设置；不需要登录，但不含 Key 明文 */
function handleGetSettings(req, res) {
  if (!isLocalRequest(req.headers)) return sendError(res, 403, '只允许本机页面访问');
  sendJson(res, 200, publicSettings());
}

/**
 * 修改连接设置：立即生效并写回配置文件。
 * Jira 地址变了时清空所有登录（旧会话属于旧地址）。
 */
async function handlePutSettings(req, res) {
  if (!isLocalRequest(req.headers)) return sendError(res, 403, '只允许本机页面修改设置');
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    return sendError(res, 400, '请求格式错误');
  }
  let next;
  try {
    next = parseSettingsInput(body);
  } catch (e) {
    return sendError(res, e.status || 400, e.message);
  }
  if (SETTINGS_FILE) {
    try {
      saveSettings(SETTINGS_FILE, next);
    } catch (e) {
      console.error('[settings] 保存失败：', e.message);
      return sendError(res, 500, `设置保存失败：${e.message}`);
    }
  }
  const jiraChanged = next.jiraBaseUrl !== JIRA_BASE_URL;
  JIRA_BASE_URL = next.jiraBaseUrl;
  LLM_OPTS = { ...LLM_OPTS, ...next.llm };
  configureLlm(LLM_OPTS);
  let headers = {};
  if (jiraChanged) {
    sessions.clear();
    readCache.clear();
    persistSessions(true);
    headers = { 'Set-Cookie': 'wb_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' };
  }
  console.log(`[settings] Jira=${JIRA_BASE_URL} 大模型=${LLM_OPTS.baseUrl} ${LLM_OPTS.model} Key=${maskKey(LLM_OPTS.apiKey) || '未配置'}${jiraChanged ? '（Jira 地址变更，已清空登录）' : ''}`);
  sendJson(res, 200, publicSettings(), headers);
}

async function handleLogout(req, res) {
  const s = getSession(req);
  if (s) {
    dropSession(s.sid);
    await jiraFetch(s.cookies, '/rest/auth/1/session', { method: 'DELETE' }).catch(() => {});
  }
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'wb_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
}

/** 确认评论/附件确实属于该问题（防止借自己项目的编号去改/删别的项目的内容） */
async function belongsTo(jar, t) {
  const field = t.kind === 'comment' ? 'comment' : 'attachment';
  const r = await jiraFetch(jar, `/rest/api/2/issue/${encodeURIComponent(t.key)}?fields=${field}`);
  if (!r.ok) return false;
  const f = (await r.json().catch(() => null))?.fields?.[field];
  const list = t.kind === 'comment' ? f?.comments : f;
  return Array.isArray(list) && list.some((x) => String(x?.id) === t.id);
}

async function handleJiraProxy(req, res, url) {
  const s = getSession(req);
  if (!s) return sendError(res, 401, '未登录');
  const sub = url.pathname.slice('/api/jira/'.length);
  if (sub.includes('..') || sub.includes('//')) return sendError(res, 403, `不允许访问的接口：${sub}`);
  const init = { method: req.method, headers: {} };
  let changedProjects = null;
  if (req.method === 'GET') {
    if (!READ_PREFIXES.some((p) => sub === p || sub.startsWith(p))) {
      return sendError(res, 403, `不允许访问的接口：${sub}`);
    }
  } else {
    const upload = isAttachmentUpload(req.method, sub);
    const unlinkId = linkDeleteId(req.method, sub);
    const owned = ownedTarget(req.method, sub, url.searchParams);
    const ct = req.headers['content-type'] || '';
    let body = null;
    // 先按路径做策略校验，避免为被拒绝的上传读取大文件
    if (owned) {
      const what = owned.kind === 'comment' ? '评论' : '附件';
      const denied = checkWritePolicy({ allowWrite: ALLOW_WRITE, writeProjects: WRITE_PROJECTS }, req.method, sub, { issueKey: owned.key });
      if (denied) return sendError(res, denied.status, denied.msg);
      if (!(await belongsTo(s.cookies, owned))) return sendError(res, 404, `${what}不存在或不属于 ${owned.key}`);
      if (req.method === 'PUT') {
        const raw = await readBody(req);
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          return sendError(res, 400, '请求体不是合法 JSON');
        }
        if (typeof body?.body !== 'string' || !body.body.trim()) return sendError(res, 400, '评论内容不能为空');
        init.body = JSON.stringify({ body: body.body });
        init.headers['Content-Type'] = 'application/json';
      }
      console.log(`[write] ${s.user} ${req.method} ${sub} (${owned.key})`);
    } else if (unlinkId) {
      // 路径里只有链接 id：先用当前会话查出链接两端，再按项目范围校验
      const lr = await jiraFetch(s.cookies, `/rest/api/2/issueLink/${unlinkId}`);
      if (!lr.ok) return sendError(res, lr.status === 404 ? 404 : 502, `链接不存在或无法读取（HTTP ${lr.status}）`);
      const link = await lr.json().catch(() => null);
      const ends = { inwardIssue: { key: link?.inwardIssue?.key ?? null }, outwardIssue: { key: link?.outwardIssue?.key ?? null } };
      changedProjects = writeProjects(`/rest/api/2/${sub}`, ends);
      const denied = checkWritePolicy({ allowWrite: ALLOW_WRITE, writeProjects: WRITE_PROJECTS }, req.method, sub, ends.inwardIssue.key && ends.outwardIssue.key ? ends : null);
      if (denied) return sendError(res, denied.status, denied.msg);
      console.log(`[write] ${s.user} DELETE ${sub} (${ends.inwardIssue.key} -> ${ends.outwardIssue.key})`);
    } else if (upload) {
      const denied = checkWritePolicy({ allowWrite: ALLOW_WRITE, writeProjects: WRITE_PROJECTS }, req.method, sub, null);
      if (denied) return sendError(res, denied.status, denied.msg);
      if (!ct.startsWith('multipart/form-data')) return sendError(res, 400, '附件需以 multipart/form-data 上传');
      init.body = await readBody(req, MAX_UPLOAD_BYTES);
      init.headers['Content-Type'] = ct;
      // Jira 6.0 附件接口只认旧写法 nocheck（no-check 会报 XSRF check failed，已实测）
      init.headers['X-Atlassian-Token'] = 'nocheck';
    } else {
      const raw = await readBody(req);
      try {
        body = raw.length ? JSON.parse(raw.toString('utf8')) : null;
      } catch {
        return sendError(res, 400, '请求体不是合法 JSON');
      }
      const denied = checkWritePolicy({ allowWrite: ALLOW_WRITE, writeProjects: WRITE_PROJECTS }, req.method, sub, body);
      if (denied) return sendError(res, denied.status, denied.msg);
      init.body = raw;
      init.headers['Content-Type'] = 'application/json';
    }
    if (!changedProjects) changedProjects = writeProjects(`/rest/api/2/${sub}`, body);
    if (!changedProjects && owned) changedProjects = [owned.key.split('-')[0].toUpperCase()];
    if (!unlinkId && !owned) console.log(`[write] ${s.user} ${req.method} ${sub}`);
  }
  if (req.method === 'GET') {
    const ctrl = new AbortController();
    const disconnect = () => { if (!res.writableEnded) ctrl.abort(); };
    res.once('close', disconnect);
    try {
      const upstream = await readJira(s, `${sub}${url.search}`, {
        signal: ctrl.signal,
        refresh: req.headers['x-wb-refresh'] === '1',
        priority: req.headers['x-wb-priority'] === 'background' ? 2 : 1,
      });
      if (upstream.status === 401) dropSession(s.sid);
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (!(upstream.headers.get('content-type') || '').includes('json') && buf.length) return sendError(res, upstream.status >= 400 ? upstream.status : 502, `Jira 返回非 JSON 响应（HTTP ${upstream.status}）`);
      if (ctrl.signal.aborted) return;
      res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-WB-Fetched-At': upstream.headers.get('x-wb-fetched-at') || String(Date.now()) });
      return res.end(buf);
    } finally { res.off('close', disconnect); }
  }
  const search = req.method === 'DELETE' && sub.startsWith('attachment/') ? '' : url.search;
  let jr;
  try { jr = await jiraFetch(s.cookies, `/rest/api/2/${sub}${search}`, init); }
  catch (error) { invalidateJira(changedProjects); throw error; }
  if (jr.ok || jr.status >= 500) invalidateJira(changedProjects);
  if (jr.status === 401) dropSession(s.sid);
  const buf = Buffer.from(await jr.arrayBuffer());
  const ct = jr.headers.get('content-type') || '';
  if (!ct.includes('json') && buf.length) {
    // Jira 对未知路径返回 HTML 404 页面，统一转成 JSON 错误
    return sendError(res, jr.status >= 400 ? jr.status : 502, `Jira 返回非 JSON 响应（HTTP ${jr.status}）`);
  }
  res.writeHead(jr.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(buf);
}

/** 附件/缩略图透传：Jira 需要会话 cookie，浏览器不能直连 */
async function handleFile(req, res, url) {
  const s = getSession(req);
  if (!s) return sendError(res, 401, '未登录');
  const f = parseFilePath(url.pathname.slice('/api/file/'.length));
  if (!f || req.method !== 'GET') return sendError(res, 403, '不允许访问的文件');
  const jr = await jiraFetch(s.cookies, `/secure/${f.kind}/${f.id}/${f.name}`, { headers: { Accept: '*/*' } });
  if (!jr.ok) return sendError(res, jr.status === 404 ? 404 : 502, `附件获取失败（HTTP ${jr.status}）`);
  const buf = Buffer.from(await jr.arrayBuffer());
  res.writeHead(200, fileResponseHeaders(jr.headers.get('content-type'), decodeURIComponent(f.name)));
  res.end(buf);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};

async function serveStatic(res, url) {
  let rel = decodeURIComponent(url.pathname);
  let file = path.resolve(DIST_DIR, '.' + rel);
  if (!file.startsWith(DIST_DIR + path.sep) && file !== DIST_DIR) return sendError(res, 403, 'forbidden');
  try {
    if (!(await stat(file)).isFile()) throw new Error('dir');
  } catch {
    file = path.join(DIST_DIR, 'index.html'); // SPA 回退
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    sendError(res, 404, 'dist 不存在，请先执行 npm run build');
  }
}

/** 联调栈控制台：/stack/ 挂一份静态 UI，数据走 /api/stack/* */
const STACK_MIME = { ...MIME, '.woff': 'font/woff', '.ttf': 'font/ttf', '.map': 'application/json; charset=utf-8' };

async function serveStackUi(res, url) {
  const rel = decodeURIComponent(url.pathname).replace(/^\/stack(?:-ui)?\/?/, '') || 'index.html';
  const file = path.resolve(STACK_UI_DIR, rel);
  if (!file.startsWith(STACK_UI_DIR + path.sep) && file !== STACK_UI_DIR) return sendError(res, 403, 'forbidden');
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': STACK_MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    sendError(res, 404, '联调栈界面缺失');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  try {
    if (url.pathname === '/mcp') return await mcp.handle(req, res);
    if (url.pathname.startsWith('/api/workflow/')) return await mcp.web(req, res, url, getSession(req));
    if (url.pathname.startsWith('/api/mcp/')) return await mcp.manage(req, res, url, getSession(req));
    if (url.pathname === '/api/login' && req.method === 'POST') return await handleLogin(req, res);
    if (url.pathname === '/api/login/remembered' && ['GET', 'DELETE'].includes(req.method)) return handleRememberedLogin(req, res);
    if (url.pathname === '/api/logout' && req.method === 'POST') return await handleLogout(req, res);
    if (url.pathname === '/api/cache/status' && req.method === 'GET') {
      if (!getSession(req)) return sendError(res, 401, '未登录');
      return sendJson(res, 200, { revision: dataRevision(url.searchParams.get('project')), scheduler: jiraScheduler.stats() });
    }
    if (url.pathname === '/api/me' && req.method === 'GET') return await handleMe(req, res);
    // 桌面端用来识别已在运行的实例
    if (url.pathname === '/api/ping') return sendJson(res, 200, { app: 'jira-workbench' });
    if (url.pathname === '/api/settings' && req.method === 'GET') return handleGetSettings(req, res);
    if (url.pathname === '/api/settings' && req.method === 'PUT') return await handlePutSettings(req, res);
    if (url.pathname === '/api/llm/split' && req.method === 'POST') return await handleLlmSplit(req, res);
    // A8 工时：配置、连接测试、未填工日、模型生成草稿
    if (url.pathname === '/api/a8/config' && req.method === 'GET') return handleA8ConfigGet(req, res);
    if (url.pathname === '/api/a8/config' && req.method === 'PUT') return await handleA8ConfigPut(req, res);
    if (url.pathname === '/api/a8/test' && req.method === 'POST') return await handleA8Test(req, res);
    if (url.pathname === '/api/a8/unfilled' && req.method === 'POST') return await handleA8Unfilled(req, res);
    if (url.pathname === '/api/a8/worklog-draft' && req.method === 'POST') return await handleA8WorklogDraft(req, res);
    if (url.pathname === '/api/a8/templates' && req.method === 'POST') return await handleA8Templates(req, res);
    if (url.pathname === '/api/a8/template' && req.method === 'POST') return await handleA8TemplateProbe(req, res);
    if (url.pathname === '/api/a8/push' && req.method === 'POST') return await handleA8PushDraft(req, res);
    // 联调栈：只允许本机页面操作（会拉起本机子进程）
    if (url.pathname.startsWith('/api/stack/')) {
      if (!stack) return sendError(res, 503, '联调栈未启用');
      if (req.method !== 'GET' && !isLocalRequest(req.headers)) return sendError(res, 403, '只允许本机页面操作联调栈');
      return await stack.handle(req, res, url);
    }
    if (url.pathname === '/api/stack') return sendJson(res, 200, stack ? stack.status() : { enabled: false });
    if ((url.pathname === '/stack' || url.pathname === '/stack/' || url.pathname.startsWith('/stack/')) && req.method === 'GET') {
      return await serveStackUi(res, url);
    }
    if (url.pathname.startsWith('/api/jira/')) return await handleJiraProxy(req, res, url);
    if (url.pathname.startsWith('/api/file/')) return await handleFile(req, res, url);
    if (url.pathname.startsWith('/api/')) return sendError(res, 404, '未知接口');
    if (SERVE_DIST) return await serveStatic(res, url);
    sendError(res, 404, '开发模式请访问 http://127.0.0.1:5173');
  } catch (err) {
    const status = err.status || (err.name === 'TimeoutError' ? 504 : 502);
    console.error(`[proxy] ${req.method} ${url.pathname} ->`, err.message);
    if (!res.headersSent) sendError(res, status, status === 504 ? '请求 Jira 超时' : `代理错误：${err.message}`);
    else res.end();
  }
});

/**
 * 启动代理。port=0 时由系统分配；返回实际监听的地址。
 * @param {{jiraBaseUrl: string, port?: number, allowWrite?: boolean, writeProjects?: string[], serveDist?: boolean, distDir?: string, llm?: object, sessionDir?: string, settingsFile?: string, a8File?: string, jiraConcurrency?: number}} opts
 */
export async function startServer(opts) {
  jiraScheduler = createJiraScheduler({ concurrency: opts.jiraConcurrency ?? Number(process.env.WB_JIRA_CONCURRENCY || 2) });
  JIRA_BASE_URL = jiraOrDefault(opts.jiraBaseUrl);
  SETTINGS_FILE = opts.settingsFile || null;
  LLM_OPTS = { ...(opts.llm || {}) };
  if (!LLM_OPTS.baseUrl) LLM_OPTS.baseUrl = DEFAULT_LLM.baseUrl;
  if (!LLM_OPTS.model) LLM_OPTS.model = DEFAULT_LLM.model;
  PORT = opts.port ?? 8787;
  ALLOW_WRITE = !!opts.allowWrite;
  WRITE_PROJECTS = opts.writeProjects ?? [];
  SERVE_DIST = !!opts.serveDist;
  if (opts.distDir) DIST_DIR = path.resolve(opts.distDir);
  if (opts.stackUiDir) STACK_UI_DIR = opts.stackUiDir;
  configureLlm(LLM_OPTS);
  // A8 配置与登录会话同目录；命令行模式落在 .wb-data，桌面版落在 config.json 旁边
  const a8File = opts.a8File || (SETTINGS_FILE ? path.join(path.dirname(SETTINGS_FILE), 'a8.json') : null);
  a8Store = a8File ? createA8Store(a8File) : null;
  sessions.clear();
  readCache.clear();
  cacheRevision++; allProjectsRevision = cacheRevision; projectRevisions.clear();
  store = opts.sessionDir ? createSessionStore(opts.sessionDir) : null;
  rememberedLogin = opts.sessionDir ? createRememberedLoginStore(path.join(opts.sessionDir, 'remembered-login')) : null;
  if (store) for (const [sid, s] of store.load(SESSION_IDLE_MS)) sessions.set(sid, s);
  // 联调栈：配置随工作台落在同一目录（stack.json），启动时按用户策略自动拉起
  if (opts.stack !== false) {
    try {
      stack = createStack({
        configPath: opts.stackConfigPath || (SETTINGS_FILE ? path.join(path.dirname(SETTINGS_FILE), 'stack.json') : undefined),
        onLog: (id, line) => console.log(`[stack:${id}] ${line}`),
      });
    } catch (e) {
      stack = null;
      console.error('[stack] 初始化失败：', e.message);
    }
  }
  await mcp?.close();
  mcp = createMcpFeature({
    dir: SETTINGS_FILE ? path.dirname(SETTINGS_FILE) : opts.sessionDir,
    getBaseUrl: () => JIRA_BASE_URL,
    getWritePolicy: () => ({ allowWrite: ALLOW_WRITE, writeProjects: WRITE_PROJECTS }),
    getSession: (sid) => getSession({ headers: { cookie: `wb_sid=${sid}` } }),
    readBody, sendJson,
    jira: async (session, method, sub, body) => {
      if (method !== 'GET') {
        const payload = body instanceof FormData ? null : body;
        const denied = checkWritePolicy({ allowWrite: ALLOW_WRITE, writeProjects: WRITE_PROJECTS }, method, sub, payload);
        if (denied) throw Object.assign(new Error(denied.msg), { status: denied.status, code: 'FORBIDDEN' });
      }
      const upload = body instanceof FormData;
      if (method === 'GET') {
        const r = await readJira(session, sub);
        if (r.status === 401) dropSession(session.sid);
        const result = await r.json().catch(() => { throw Object.assign(new Error('Jira 返回非 JSON 响应'), { status: 502 }); });
        if (!r.ok) throw Object.assign(new Error(result?.errorMessages?.join('；') || `Jira HTTP ${r.status}`), { status: r.status, code: r.status === 401 ? 'AUTH_REQUIRED' : 'JIRA_ERROR' });
        return result;
      }
      let r;
      try { r = await jiraFetch(session.cookies, `/rest/api/2/${sub}`, {
        method,
        headers: upload ? { 'X-Atlassian-Token': 'nocheck' } : body !== undefined ? { 'Content-Type': 'application/json' } : {},
        ...(body !== undefined ? { body: upload ? body : JSON.stringify(body) } : {}),
      }); } catch (error) { invalidateJira(writeProjects(`/rest/api/2/${sub}`, body)); throw error; }
      if (r.ok || r.status >= 500) invalidateJira(writeProjects(`/rest/api/2/${sub}`, body));
      const result = r.status === 204 ? null : await r.json().catch(() => { throw Object.assign(new Error('Jira 返回非 JSON 响应'), { status: 502 }); });
      if (r.status === 401) dropSession(session.sid);
      if (!r.ok) throw Object.assign(new Error([...(result?.errorMessages || []), ...Object.values(result?.errors || {})].join('；') || `Jira HTTP ${r.status}`), { status: r.status, code: r.status === 401 ? 'AUTH_REQUIRED' : 'JIRA_ERROR' });
      return result;
    },
  });
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(e);
    server.once('error', onError);
    server.listen(PORT, HOST, () => {
      server.off('error', onError);
      const { port } = server.address();
      const scope = WRITE_PROJECTS.length ? `仅 ${WRITE_PROJECTS.join(',')}` : '全部项目';
      const llm = llmStatus();
      console.log(`[proxy] http://${HOST}:${port} -> ${JIRA_BASE_URL}  写操作：${ALLOW_WRITE ? `已开启（${scope}）` : '关闭（只读）'}  大模型：${llm.enabled ? llm.model : '未配置'}  已恢复登录：${sessions.size}`);
      if (stack) {
        console.log(`[stack] 控制台 http://${HOST}:${port}/stack/  配置：${stack.configPath}`);
        stack.start().catch((e) => console.error('[stack] 自动启动失败：', e.message));
      }
      resolve({ url: `http://${HOST}:${port}`, port });
    });
  });
}

export async function stopServer() {
  if (saveTimer) persistSessions(true);
  // 先收拾联调栈拉起的子进程（前端 dev server），否则它们会成为孤儿继续占端口
  if (stack) {
    await stack.stop().catch((e) => console.error('[stack] 停止失败：', e.message));
    stack = null;
  }
  await new Promise((resolve) => (server.listening ? server.close(async () => { await mcp?.close(); mcp = null; resolve(); }) : resolve()));
}

/** 大模型配置的环境变量（命令行模式）；Key 不写进代码和配置模板 */
export function llmFromEnv(env = process.env) {
  return {
    baseUrl: env.WB_LLM_BASE_URL || '',
    model: env.WB_LLM_MODEL || '',
    apiKey: env.WB_LLM_API_KEY || '',
    timeoutMs: Number(env.WB_LLM_TIMEOUT_MS) || undefined,
    maxHoursPerTask: Number(env.WB_LLM_MAX_HOURS) || undefined,
    promptExtra: env.WB_LLM_PROMPT_EXTRA || '',
  };
}

// 直接 node server/index.mjs 运行时按环境变量启动；项目根目录有 .env 时先加载（已在 .gitignore）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  try {
    process.loadEnvFile(envFile);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[proxy] .env 读取失败：', e.message);
  }
  // 登录页保存的设置优先于环境变量
  const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.wb-data');
  const settingsFile = path.join(dataDir, 'settings.json');
  let saved = {};
  try {
    saved = readJson(settingsFile);
  } catch (e) {
    console.error(`[proxy] ${settingsFile} 格式错误，已忽略：`, e.message);
  }
  const envLlm = llmFromEnv();
  startServer({
    llm: { ...envLlm, ...(saved.llm || {}) },
    jiraBaseUrl: saved.jiraBaseUrl || process.env.JIRA_BASE_URL || DEFAULT_JIRA_BASE_URL,
    settingsFile,
    port: Number(process.env.WB_PORT || 8787),
    allowWrite: process.env.WB_ALLOW_WRITE === '1',
    writeProjects: parseProjects(process.env.WB_WRITE_PROJECTS),
    serveDist: process.argv.includes('--serve-dist'),
    // 登录状态保存目录（加密），WB_SESSION_DIR=off 关闭
    sessionDir: process.env.WB_SESSION_DIR === 'off' ? undefined : process.env.WB_SESSION_DIR || dataDir,
  }).catch((e) => {
    console.error('[proxy] 启动失败：', e.message);
    process.exit(1);
  });
  // 退出前把未落盘的会话写下去
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stopServer().then(() => process.exit(0)));
}
