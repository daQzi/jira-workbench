import { statusesOf, type StageId } from './stages';
import { NO_VERSION } from './versions';

/** JQL 字符串字面量转义 */
export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function quoteList(values: string[]): string {
  return `(${values.map(quote).join(', ')})`;
}

const ISSUE_KEY_RE = /^[A-Za-z][A-Za-z0-9]+-\d+$/;
// summary ~ 走 Lucene 解析，特殊字符会导致 JQL 报错，直接替换为空格
const LUCENE_SPECIAL_RE = /[+\-&|!(){}[\]^"~*?:\\/]/g;

export function isIssueKey(text: string): boolean {
  return ISSUE_KEY_RE.test(text.trim());
}

export interface IssueFilter {
  project?: string;
  types?: string[];
  component?: string;
  /** 影响版本名；NO_VERSION = 未设置版本 */
  version?: string;
  text?: string;
  stages?: StageId[];
  onlyMine?: boolean;
  /** 经办人、开发人员或测试人员任一匹配的 Jira 用户名 */
  people?: string[];
  /** 已结束的问题只保留最近 N 天内更新过的 */
  recentClosedDays?: number;
  closedStatuses?: string[];
}

// 开发人员 / 测试人员是自定义字段，用 id 引用避免重名歧义
export const MINE_CLAUSE = '(assignee = currentUser() OR cf[10204] = currentUser() OR cf[10401] = currentUser())';

export function buildJql(f: IssueFilter, orderBy = 'updated DESC'): string {
  const clauses: string[] = [];
  if (f.project) clauses.push(`project = ${quote(f.project)}`);
  if (f.types?.length) clauses.push(`issuetype in ${quoteList(f.types)}`);
  if (f.component) clauses.push(`component = ${quote(f.component)}`);
  if (f.version === NO_VERSION) clauses.push('affectedVersion is EMPTY');
  else if (f.version) clauses.push(`affectedVersion = ${quote(f.version)}`);
  if (f.stages?.length) {
    const statuses = statusesOf(f.stages);
    if (statuses.length) clauses.push(`status in ${quoteList(statuses)}`);
  }
  const people = [...new Set(f.people?.map(name => name.trim()).filter(Boolean))].sort();
  if (people.length) {
    const users = quoteList(people);
    clauses.push(`(assignee in ${users} OR cf[10204] in ${users} OR cf[10401] in ${users})`);
  } else if (f.onlyMine) clauses.push(MINE_CLAUSE);
  if (f.recentClosedDays && f.closedStatuses?.length) {
    clauses.push(`(status not in ${quoteList(f.closedStatuses)} OR updated >= -${f.recentClosedDays}d)`);
  }
  const text = f.text?.trim();
  if (text) {
    if (isIssueKey(text)) {
      clauses.push(`key = ${quote(text.toUpperCase())}`);
    } else {
      const cleaned = text.replace(LUCENE_SPECIAL_RE, ' ').replace(/\s+/g, ' ').trim();
      if (cleaned) clauses.push(`summary ~ ${quote(cleaned)}`);
    }
  }
  return `${clauses.join(' AND ')}${orderBy ? ` ORDER BY ${orderBy}` : ''}`.trim();
}
