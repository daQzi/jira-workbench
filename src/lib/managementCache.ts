import { resolveHourFields } from './hours';
import type { Issue, SearchResult } from './types';
import { api } from './api';
import { quote } from './jql';
import { readCached } from './requestCache';

export function managementFields(signal: AbortSignal) {
  return readCached('hour-fields', 300_000, async s => resolveHourFields(await api.fields(s)), signal);
}
export function managementJql(projectKey: string | null, everyone: boolean): string {
  return `${projectKey ? `project = ${quote(projectKey)} AND ` : ''}${everyone ? '' : '(assignee = currentUser() OR cf[10204] = currentUser() OR cf[10401] = currentUser()) AND '}(resolution is EMPTY OR resolved >= -30d) ORDER BY updated DESC`;
}
export function searchCached(jql: string, startAt: number, fields: string[], signal: AbortSignal): Promise<SearchResult> {
  return readCached(`search:${jql}:${startAt}:${fields.join(',')}`, 20_000, s => api.search(jql, { startAt, maxResults: 100, fields }, s), signal);
}
export interface WorkCache { key: string; issues: Issue[]; total: number; loadedAt: string; complete: boolean }
export function peekManagement(projectKey: string | null, everyone: boolean): WorkCache | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(`wb.workbench.cache.v1:${location.pathname}:${projectKey ?? '*'}:${everyone}`) ?? 'null');
    return value && Array.isArray(value.issues) && typeof value.key === 'string' ? value : null;
  } catch { return null; }
}
export function saveManagement(value: WorkCache) {
  try { sessionStorage.setItem(`wb.workbench.cache.v1:${location.pathname}:${value.key}`, JSON.stringify(value)); } catch { /* 临时缓存失败不阻塞当前页面 */ }
}
