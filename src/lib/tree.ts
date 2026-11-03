import { isFinished } from './stages';
import type { Issue, IssueLink, LinkedIssue } from './types';

// 父子约定：子项 --Blocks--> 父需求。
// 在父需求上该链接表现为 inwardIssue（is blocked by），在子项上表现为 outwardIssue（blocks）。
export const PARENT_LINK_TYPE = 'Blocks';
export const PARENT_ISSUE_TYPES = ['需求'];

const isParentType = (typeName: string) => PARENT_ISSUE_TYPES.includes(typeName);

function links(issue: Issue): IssueLink[] {
  return issue.fields.issuelinks ?? [];
}

/** 需求下挂的子项（排除需求互相 block 的情况，那属于依赖而非父子） */
export function childLinks(issue: Issue): LinkedIssue[] {
  if (!isParentType(issue.fields.issuetype.name)) return [];
  return links(issue)
    .filter((l) => l.type.name === PARENT_LINK_TYPE && l.inwardIssue)
    .map((l) => l.inwardIssue!)
    .filter((c) => !isParentType(c.fields.issuetype.name));
}

/** 子项所属父需求；多个时取第一个，其余在详情里作为关联展示 */
export function parentLinks(issue: Issue): LinkedIssue[] {
  if (isParentType(issue.fields.issuetype.name)) return [];
  return links(issue)
    .filter((l) => l.type.name === PARENT_LINK_TYPE && l.outwardIssue)
    .map((l) => l.outwardIssue!)
    .filter((p) => isParentType(p.fields.issuetype.name));
}

export function parentOf(issue: Issue): LinkedIssue | null {
  return parentLinks(issue)[0] ?? null;
}

/** 父子以外的链接，按 Jira 链接描述分组 */
/** 需求上「子项 key -> 链接 id」，用于移除子项关系 */
export function childLinkIds(issue: Issue): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of links(issue)) if (l.type.name === PARENT_LINK_TYPE && l.inwardIssue) m.set(l.inwardIssue.key, l.id);
  return m;
}

export function otherLinks(issue: Issue): { linkId: string; label: string; type: string; dir: 'in' | 'out'; issue: LinkedIssue }[] {
  const children = new Set(childLinks(issue).map((c) => c.key));
  const parents = new Set(parentLinks(issue).map((p) => p.key));
  const out: { linkId: string; label: string; type: string; dir: 'in' | 'out'; issue: LinkedIssue }[] = [];
  for (const l of links(issue)) {
    if (l.inwardIssue && !children.has(l.inwardIssue.key)) out.push({ linkId: l.id, label: l.type.inward, type: l.type.name, dir: 'in', issue: l.inwardIssue });
    if (l.outwardIssue && !parents.has(l.outwardIssue.key)) out.push({ linkId: l.id, label: l.type.outward, type: l.type.name, dir: 'out', issue: l.outwardIssue });
  }
  return out;
}

export interface Progress {
  done: number;
  total: number;
}

export function childProgress(issue: Issue): Progress {
  const children = childLinks(issue);
  return { done: children.filter((c) => isFinished(c.fields.status.name)).length, total: children.length };
}

/** 链接里只带摘要字段，用完整问题替换；拿不到的保留摘要版本 */
export function resolveChildren(parent: Issue, full: Map<string, Issue>): Issue[] {
  return childLinks(parent).map(
    (c) => full.get(c.key) ?? { id: c.id, key: c.key, fields: { ...c.fields, issuelinks: [] } },
  );
}
