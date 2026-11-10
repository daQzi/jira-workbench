import type { FilterState } from '../components/FilterBar';
import type { Issue, JiraUser } from './types';
import { buildJql } from './jql';
import { CLOSED_STATUSES, stageOf, type StageId } from './stages';

export const BOARD_LIMIT = 1000;
export const BOARD_FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'updated', 'created', 'duedate', 'issuelinks', 'versions', 'customfield_10204', 'customfield_10401'];
export const BOARD_FRESH_MS = 60_000;
export const BOARD_STALE_MS = 300_000;
export function boardQuery(project: string, filter: FilterState, stages = filter.stages) {
  return buildJql({ project, types: [...filter.types].sort(), component: filter.component, version: filter.version,
    text: filter.text, stages: [...stages].sort() as StageId[], onlyMine: filter.onlyMine, people: filter.people.map(p => p.name),
    recentClosedDays: filter.hideOldClosed ? 30 : undefined, closedStatuses: CLOSED_STATUSES }, 'priority ASC, updated DESC, key ASC');
}
export type OwnerRole = 'assignee' | 'developer' | 'tester';
export const OWNER_ROLES: Record<OwnerRole, string> = { assignee: '经办人', developer: '开发人员', tester: '测试人员' };
export type IssueKind = 'requirement' | 'task' | 'bug' | 'coding' | 'other';
export const ISSUE_KINDS: Record<IssueKind, string> = { requirement: '需求', task: '任务', bug: 'Bug', coding: '编码任务', other: '其他任务' };
export function kindMatches(issue: Issue, kind: IssueKind) {
  const type = issue.fields.issuetype.name;
  return kind === 'requirement' ? type === '需求' : kind === 'coding' ? type === '编码任务' : kind === 'other' ? type === '其他任务'
    : kind === 'task' ? ['编码任务', '其他任务'].includes(type) : /bug|缺陷/i.test(type);
}
export const UNASSIGNED = '__unassigned__';
export function ownerOf(issue: Issue, role: OwnerRole): { name: string; displayName: string } {
  const field = { assignee: 'assignee', developer: 'customfield_10204', tester: 'customfield_10401' }[role];
  const user = issue.fields[field] as JiraUser | null;
  return user?.name ? { name: user.name, displayName: user.displayName || user.name } : { name: UNASSIGNED, displayName: '未分配' };
}
export interface PersonCount { name: string; displayName: string; count: number; members: string[] }
export function peopleCounts(issues: Issue[], role: OwnerRole, kind?: IssueKind): PersonCount[] {
  const counts = new Map<string, PersonCount>();
  for (const issue of new Map(issues.map(i => [i.key, i])).values()) {
    if (kind && !kindMatches(issue, kind)) continue;
    const user = ownerOf(issue, role);
    const entry = counts.get(user.name) ?? { ...user, count: 0, members: [user.name] };
    entry.count++; counts.set(user.name, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
export function chartCounts(counts: PersonCount[]): PersonCount[] {
  const assigned = counts.filter(p => p.name !== UNASSIGNED), top = assigned.slice(0, 5), rest = assigned.slice(5);
  if (rest.length) top.push({ name: '__others__', displayName: '其他人员', count: rest.reduce((n, p) => n + p.count, 0), members: rest.map(p => p.name) });
  const empty = counts.find(p => p.name === UNASSIGNED);
  if (empty) top.push(empty);
  return top;
}
export function unmappedCount(issues: Issue[]) { return issues.filter(i => !stageOf(i.fields.status.name)).length; }
