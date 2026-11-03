// 连接设置：Jira 地址、大模型地址 / Key / 模型 ID。登录页可改，保存到配置文件（桌面版 config.json，命令行 .wb-data/settings.json）。
// Key 只保存在本机文件里，接口只返回是否已配置和末 4 位，不下发明文。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_JIRA_BASE_URL = '';
export const DEFAULT_LLM = { baseUrl: '', model: '' };

const MAX_LEN = 300;

/** 规范化 http(s) 地址；不合法时抛错（写路径强校验） */
export function normalizeUrl(raw, label) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) throw badRequest(`请填写${label}`);
  if (s.length > MAX_LEN) throw badRequest(`${label}过长`);
  let u;
  try {
    u = new URL(s);
  } catch {
    throw badRequest(`${label}格式不正确，应以 http:// 或 https:// 开头`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw badRequest(`${label}只支持 http / https`);
  if (u.username || u.password) throw badRequest(`${label}不能包含账号密码`);
  if (u.search || u.hash) throw badRequest(`${label}不能包含 ? 或 # 参数`);
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

function badRequest(msg) {
  return Object.assign(new Error(msg), { status: 400 });
}

export function jiraOrDefault(url) {
  const s = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
  return s || DEFAULT_JIRA_BASE_URL;
}

/** Key 只露末 4 位 */
export function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  return k.length <= 8 ? '****' : `${k.slice(0, 3)}****${k.slice(-4)}`;
}

/**
 * 校验登录页提交的设置。apiKey 留空表示沿用当前 Key。
 * @returns {{jiraBaseUrl: string, llm: {baseUrl: string, model: string, apiKey?: string}}}
 */
export function parseSettingsInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  const model = typeof b.llmModel === 'string' ? b.llmModel.trim() : '';
  if (model.length > 100 || /\s/.test(model)) throw badRequest('模型 ID 不能包含空白，且不超过 100 个字符');
  const llmBaseUrl = typeof b.llmBaseUrl === 'string' ? b.llmBaseUrl.trim() : '';
  if (llmBaseUrl && !model) throw badRequest('请填写模型 ID');
  if (model && !llmBaseUrl) throw badRequest('请填写大模型请求地址');
  const key = typeof b.llmApiKey === 'string' ? b.llmApiKey.trim() : '';
  if (key.length > 500 || /\s/.test(key)) throw badRequest('大模型 Key 不能包含空白');
  return {
    jiraBaseUrl: normalizeUrl(b.jiraBaseUrl, 'Jira 地址'),
    llm: { baseUrl: llmBaseUrl ? normalizeUrl(llmBaseUrl, '大模型请求地址') : '', model, ...(key ? { apiKey: key } : {}) },
  };
}

export function readJson(file) {
  if (!file || !existsSync(file)) return {};
  const v = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** 合并写回文件（保留文件里的其他配置，如 allowWrite），仅当前用户可读写 */
export function saveSettings(file, s) {
  const cur = readJson(file);
  const llm = { ...(cur.llm && typeof cur.llm === 'object' ? cur.llm : {}), ...s.llm };
  const next = { ...cur, jiraBaseUrl: s.jiraBaseUrl, llm };
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows 忽略 */
  }
  return next;
}

/**
 * 只接受本应用页面发起的修改：Host 必须是本机回环地址（防 DNS 重绑定），
 * Origin 存在时必须与 Host 同源（防其他网页跨站提交，把 Jira 地址改到外部截获密码）。
 */
export function isLocalRequest(headers) {
  const host = String(headers.host || '');
  const local = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
  if (!local.test(host)) return false;
  const origin = headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
