import { api, LIST_FIELDS } from './api';
import { dateOf, hoursOf, parseYmd, ymd, type HourFields } from './hours';
import { parentOf, PARENT_LINK_TYPE } from './tree';
import { isFinished, stageOf } from './stages';
import { MINE_CLAUSE, quote } from './jql';
import type { Issue } from './types';

export const MANAGEMENT_LIMIT = 1000;
export const MANAGEMENT_FIELDS = [...LIST_FIELDS, 'project', 'duedate', 'resolutiondate', 'resolution'];
export async function searchPages(jql: string, fields: string[], signal: AbortSignal, limit = MANAGEMENT_LIMIT) {
  const issues: Issue[] = []; let total = 0;
  while (issues.length < limit) {
    const page = await api.search(jql, { startAt: issues.length, maxResults: Math.min(100, limit - issues.length), fields }, signal);
    total = page.total;
    issues.push(...page.issues);
    if (!page.issues.length || issues.length >= total) break;
  }
  return { issues, total };
}
export function personalJql(project: string | null) {
  // 既保留所有未结束事项，也查询近30天完成项；未知状态不能被阶段枚举排除。
  return `${project ? `project = ${quote(project)} AND ` : ''}${MINE_CLAUSE} AND (resolution is EMPTY OR resolved >= -30d) ORDER BY updated DESC`;
}
export function finished(i: Issue) { return !!i.fields.resolution || isFinished(i.fields.status.name); }
export function dueDate(i: Issue): string | null { return typeof i.fields.duedate === 'string' ? i.fields.duedate.slice(0, 10) : null; }
export function overdue(i: Issue, today = ymd(new Date())) { const due = dueDate(i); return !finished(i) && !!due && due < today; }
export function dueSoon(i: Issue, today = ymd(new Date())) {
  const d = parseYmd(today); d.setDate(d.getDate() + 3);
  const due = dueDate(i); return !finished(i) && !!due && due >= today && due <= ymd(d);
}
/** 只看阻塞当前项的依赖；需求被编码任务 blocks 属于父子关系，不能显示“被阻塞”。 */
export function blockers(i: Issue) {
  return (i.fields.issuelinks ?? []).filter(l => l.type.name === PARENT_LINK_TYPE && l.inwardIssue)
    .map(l => l.inwardIssue!)
    .filter(b => !(i.fields.issuetype.name === '需求' && b.fields.issuetype.name !== '需求'))
    .filter(b => !isFinished(b.fields.status.name));
}
export function stale(i: Issue, now = Date.now()) {
  const updated = typeof i.fields.updated === 'string' ? Date.parse(i.fields.updated) : NaN;
  return !finished(i) && Number.isFinite(updated) && now - updated >= 7 * 86400000;
}
export function hoursProblems(i: Issue, hf: HourFields): string[] {
  const problems: string[] = [];
  const dev = i.fields.customfield_10204 as { name?: string } | null;
  if (!dev?.name) problems.push('缺开发人员');
  if (hoursOf(i, hf, { measure: 'estimate', basis: 'devDone', hoursPerDay: 8 }) === null) problems.push('缺少或无法识别工时');
  if (!dateOf(i, hf, 'devDone')) problems.push('缺开发完成/解决日期');
  return problems;
}
export type WorkView = 'active' | 'today' | 'overdue' | 'soon' | 'blocked' | 'stale' | 'missing' | 'orphan' | 'recent' | 'test';
export const WORK_VIEWS: Record<WorkView, string> = {
  active: '进行中', today: '今日待办', overdue: '已逾期', soon: '近3天到期', blocked: '被阻塞', stale: '7天未更新', missing: '待补工时', orphan: '未关联需求', recent: '最近完成', test: '等我测试/验收',
};
export function matchesView(i: Issue, view: WorkView, hf: HourFields, user: string, today = ymd(new Date())) {
  switch (view) {
    case 'active': return !finished(i);
    case 'today': return !finished(i) && (dueDate(i) === today || dateOf(i, hf, 'devStart') === today);
    case 'overdue': return overdue(i, today);
    case 'soon': return dueSoon(i, today);
    case 'blocked': return !finished(i) && blockers(i).length > 0;
    case 'stale': return stale(i, parseYmd(today).getTime());
    case 'missing': return i.fields.issuetype.name !== '需求' && hoursProblems(i, hf).length > 0;
    case 'orphan': return !finished(i) && ['编码任务', 'BUG及数据问题', '其他任务'].includes(i.fields.issuetype.name) && !parentOf(i);
    case 'recent': return finished(i);
    case 'test': return !finished(i) && stageOf(i.fields.status.name) === 'test' && (i.fields.customfield_10401 as { name?: string } | null)?.name === user;
  }
}

export function csvCell(v: unknown) {
  let s = String(v ?? '');
  // 防止导出的用户文本在 Excel 中变成公式。
  if (/^[\s]*[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export function downloadCsv(name: string, rows: unknown[][]) {
  const url = URL.createObjectURL(new Blob(['\uFEFF', rows.map(row => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function scopeKey(baseUrl: string, user: string, project: string | null) { return `${baseUrl}:${user}:${project ?? '*'}`; }
export function loadLocal<T>(key: string, fallback: T, validate: (x: unknown) => x is T): T {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null'); return validate(value) ? value : fallback; } catch { return fallback; }
}
export function saveLocal(key: string, value: unknown): boolean {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
