import { trackRequest } from './requestActivity';
import type { Attachment, FieldDef, Issue, IssueDetail, JiraUser, Project, ProjectDetail, SearchResult, NamedRef } from './types';
import type { FieldMetaMap } from './fields';
import type { LinkTypeDef } from './links';
import type { LlmTask } from './dailyImport';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type UnauthorizedListener = () => void;
let onUnauthorized: UnauthorizedListener | null = null;
export function setUnauthorizedListener(fn: UnauthorizedListener | null) {
  onUnauthorized = fn;
}

function messageOf(body: unknown, status: number): string {
  const b = body as { errorMessages?: string[]; errors?: Record<string, string> } | null;
  const msgs = [...(b?.errorMessages ?? []), ...Object.values(b?.errors ?? {})].filter(Boolean);
  return msgs.length ? msgs.join('；') : `请求失败（HTTP ${status}）`;
}

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await trackRequest(() => fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  }), method !== 'GET');
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/login')) onUnauthorized?.();
    throw new ApiError(res.status, messageOf(data, res.status));
  }
  return data as T;
}

const jira = <T>(path: string, signal?: AbortSignal) => request<T>('GET', `/api/jira/${path}`, undefined, signal);
// 相同参数、仍未结束的写请求共享同一个 Promise，避免连点或 Enter/点击并发重复写入。
// 请求结束即删除记录；失败仍会由每个调用方正常收到，不吞错，也不会永久禁止重试。
const pendingWrites = new Map<string, Promise<unknown>>();
function writeOnce<T>(key: string, run: () => Promise<T>): Promise<T> {
  const pending = pendingWrites.get(key);
  if (pending) return pending as Promise<T>;
  const promise = run().finally(() => pendingWrites.delete(key));
  pendingWrites.set(key, promise);
  return promise;
}

const jiraWrite = <T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) =>
  writeOnce(`${method}:${path}:${JSON.stringify(body)}`, () => request<T>(method, `/api/jira/${path}`, body));

export interface Me {
  name: string;
  jiraBaseUrl: string;
  allowWrite: boolean;
  writeProjects: string[];
  /** 日报拆分用的大模型；未配置时 enabled=false（旧版代理没有该字段） */
  llm?: { enabled: boolean; model: string; maxHoursPerTask: number };
}

/** 登录页「连接设置」；Key 不下发明文 */
export interface ConnSettings {
  jiraBaseUrl: string;
  llmBaseUrl: string;
  llmModel: string;
  llmKeySet: boolean;
  llmKeyMask: string;
  /** 是否会写回配置文件（否则只在本次运行生效） */
  saved: boolean;
}

export interface ConnSettingsInput {
  jiraBaseUrl: string;
  llmBaseUrl: string;
  llmModel: string;
  /** 留空表示沿用当前 Key */
  llmApiKey: string;
}

export interface CreateMetaType {
  id: string;
  name: string;
  fields: FieldMetaMap;
}

export interface Transition {
  id: string;
  name: string;
  to: NamedRef;
  fields?: FieldMetaMap;
}

const enc = encodeURIComponent;

export const api = {
  login: (username: string, password: string) => writeOnce('login', () => request<{ name: string }>('POST', '/api/login', { username, password })),
  logout: () => request<{ ok: boolean }>('POST', '/api/logout'),
  me: () => request<Me>('GET', '/api/me'),
  settings: () => request<ConnSettings>('GET', '/api/settings'),
  saveSettings: (input: ConnSettingsInput) => writeOnce(`settings:${JSON.stringify(input)}`, () => request<ConnSettings>('PUT', '/api/settings', input)),

  projects: () => jira<Project[]>('project'),
  project: (key: string) => jira<ProjectDetail>(`project/${encodeURIComponent(key)}`),
  priorities: () => jira<NamedRef[]>('priority'),

  search(jql: string, opts: { startAt?: number; maxResults?: number; fields: string[] }, signal?: AbortSignal) {
    const q = new URLSearchParams({
      jql,
      startAt: String(opts.startAt ?? 0),
      maxResults: String(opts.maxResults ?? 50),
      fields: opts.fields.join(','),
    });
    return jira<SearchResult>(`search?${q}`, signal);
  },

  issue: (key: string, signal?: AbortSignal) =>
    jira<IssueDetail>(`issue/${enc(key)}?expand=renderedFields,names,changelog`, signal),

  async createMeta(projectKey: string): Promise<CreateMetaType[]> {
    const r = await jira<{ projects: { key: string; issuetypes: CreateMetaType[] }[] }>(
      `issue/createmeta?projectKeys=${enc(projectKey)}&expand=projects.issuetypes.fields`,
    );
    return r.projects[0]?.issuetypes ?? [];
  },
  editMeta: (key: string) => jira<{ fields: FieldMetaMap }>(`issue/${enc(key)}/editmeta`).then((r) => r.fields ?? {}),
  transitions: (key: string) =>
    jira<{ transitions: Transition[] }>(`issue/${enc(key)}/transitions?expand=transitions.fields`).then((r) => r.transitions),
  assignableUsers: (opts: { project?: string; issueKey?: string; query: string }) => {
    const q = new URLSearchParams({ username: opts.query, maxResults: '20' });
    if (opts.issueKey) q.set('issueKey', opts.issueKey);
    else if (opts.project) q.set('project', opts.project);
    return jira<JiraUser[]>(`user/assignable/search?${q}`);
  },

  createIssue: (body: { fields: Record<string, unknown>; update?: Record<string, unknown> }) =>
    jiraWrite<{ id: string; key: string }>('POST', 'issue', body),
  editIssue: (key: string, fields: Record<string, unknown>) => jiraWrite<null>('PUT', `issue/${enc(key)}`, { fields }),
  doTransition: (key: string, transitionId: string, fields?: Record<string, unknown>) =>
    jiraWrite<null>('POST', `issue/${enc(key)}/transitions`, {
      transition: { id: transitionId },
      ...(fields && Object.keys(fields).length ? { fields } : {}),
    }),
  addComment: (key: string, body: string) => jiraWrite<{ id: string }>('POST', `issue/${enc(key)}/comment`, { body }),
  editComment: (key: string, id: string, body: string) => jiraWrite<{ id: string }>('PUT', `issue/${enc(key)}/comment/${enc(id)}`, { body }),
  deleteComment: (key: string, id: string) => jiraWrite<null>('DELETE', `issue/${enc(key)}/comment/${enc(id)}`),
  /** 删除附件；issueKey 只给本地代理校验归属和项目范围用 */
  deleteAttachment: (key: string, id: string) => jiraWrite<null>('DELETE', `attachment/${enc(id)}?issueKey=${enc(key)}`),
  /** 当前用户在该问题上的权限（Jira 6：{ permissions: { KEY: { havePermission } } }） */
  myPermissions: (key: string) =>
    jira<{ permissions: Record<string, { havePermission: boolean }> }>(`mypermissions?issueKey=${enc(key)}`).then((r) => {
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(r.permissions ?? {})) out[k] = !!v?.havePermission;
      return out;
    }),
  /** child blocks parent：Jira 里 inward=子项（blocks 的发起方），outward=父需求 */
  linkChild: (childKey: string, parentKey: string) =>
    jiraWrite<null>('POST', 'issueLink', {
      type: { name: 'Blocks' },
      inwardIssue: { key: childKey },
      outwardIssue: { key: parentKey },
    }),
  /** 通用建链接：body 由 links.issueLinkBody 生成 */
  addLink: (body: { type: { name: string }; inwardIssue: { key: string }; outwardIssue: { key: string } }) =>
    jiraWrite<null>('POST', 'issueLink', body),
  /** 移除链接（只删两个问题之间的关系，问题本身不受影响） */
  removeLink: (linkId: string) => jiraWrite<null>('DELETE', `issueLink/${encodeURIComponent(linkId)}`),
  linkTypes: () => jira<{ issueLinkTypes: LinkTypeDef[] }>('issueLinkType').then((r) => r.issueLinkTypes),
  fields: () => jira<FieldDef[]>('field'),

  /** 日报交给大模型拆成任务草稿（经本地代理，Key 不进浏览器） */
  llmSplit: (body: { text: string; date: string; defaultProject: string; projects: string[] }) =>
    writeOnce(`llm:${JSON.stringify(body)}`, () => request<{ tasks: LlmTask[]; model: string; elapsedMs: number }>('POST', '/api/llm/split', body)),

  /** 上传附件（multipart，字段名必须是 file） */
  uploadAttachments(key: string, files: File[]): Promise<Attachment[]> {
    const signature = files.map((f) => `${f.name}:${f.size}:${f.lastModified}`).join(',');
    return writeOnce(`upload:${key}:${signature}`, () => trackRequest(async () => {
      const fd = new FormData();
      for (const f of files) fd.append('file', f, f.name);
      const res = await fetch(`/api/jira/issue/${enc(key)}/attachments`, { method: 'POST', credentials: 'same-origin', body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 401) onUnauthorized?.();
        throw new ApiError(res.status, messageOf(data, res.status));
      }
      return data as Attachment[];
    }, true));
  },
};

/** Jira 附件地址转本地代理地址（附件需要 Jira 会话） */
export function fileUrl(jiraUrl: string | undefined): string | undefined {
  if (!jiraUrl) return undefined;
  const m = jiraUrl.match(/\/secure\/(attachment|thumbnail)\/(\d+)\/([^/?#]+)/);
  return m ? `/api/file/${m[1]}/${m[2]}/${m[3]}` : undefined;
}

export function canWrite(me: Me | null, projectKey: string | null | undefined): boolean {
  if (!me?.allowWrite || !projectKey) return false;
  return me.writeProjects.length === 0 || me.writeProjects.includes(projectKey.toUpperCase());
}

// 列表/看板需要的字段；开发人员 cf10204、测试人员 cf10401、产品经理 cf10400、影响版本 versions
export const LIST_FIELDS = [
  'summary', 'status', 'issuetype', 'priority', 'assignee', 'components', 'updated', 'created',
  'issuelinks', 'customfield_10204', 'customfield_10401', 'customfield_10400', 'versions',
];

const KEY_BATCH = 80;

/** 按 key 批量取完整问题（链接里只有摘要字段） */
export async function fetchByKeys(keys: string[], signal?: AbortSignal): Promise<Map<string, Issue>> {
  const unique = [...new Set(keys)];
  const out = new Map<string, Issue>();
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += KEY_BATCH) batches.push(unique.slice(i, i + KEY_BATCH));
  const results = await Promise.all(
    batches.map((b) =>
      api.search(`key in (${b.join(',')})`, { maxResults: b.length, fields: LIST_FIELDS }, signal),
    ),
  );
  for (const r of results) for (const issue of r.issues) out.set(issue.key, issue);
  return out;
}
