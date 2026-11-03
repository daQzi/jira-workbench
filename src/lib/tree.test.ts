import { describe, expect, it } from 'vitest';
import { childLinks, childProgress, otherLinks, parentOf, resolveChildren } from './tree';
import type { Issue, IssueLink, LinkedIssue } from './types';

const ref = (key: string, type: string, status = '新增'): LinkedIssue => ({
  id: key,
  key,
  fields: { summary: key, status: { id: status, name: status }, issuetype: { id: type, name: type } },
});
const link = (type: string, dir: 'in' | 'out', other: LinkedIssue): IssueLink => ({
  id: `${type}-${other.key}`,
  type: { name: type, inward: `${type}-in`, outward: `${type}-out` },
  ...(dir === 'in' ? { inwardIssue: other } : { outwardIssue: other }),
});
const issue = (key: string, type: string, issuelinks: IssueLink[]): Issue => ({
  id: key,
  key,
  fields: { summary: key, status: { id: '1', name: '新增' }, issuetype: { id: type, name: type }, issuelinks },
});

describe('父子关系（子项 blocks 父需求）', () => {
  const story = issue('S-1', '需求', [
    link('Blocks', 'in', ref('T-1', '编码任务', '开发中')),
    link('Blocks', 'in', ref('B-1', 'BUG及数据问题', '关闭')),
    link('Blocks', 'in', ref('S-2', '需求')), // 需求之间是依赖，不算子项
    link('Relates', 'in', ref('T-9', '编码任务')), // Relates 不算子项
    link('Blocks', 'out', ref('T-5', '编码任务')), // 需求 blocks 任务，方向相反
  ]);

  it('只取 Blocks 入向的非需求问题', () => {
    expect(childLinks(story).map((c) => c.key)).toEqual(['T-1', 'B-1']);
  });

  it('进度按已完成阶段统计', () => {
    expect(childProgress(story)).toEqual({ done: 1, total: 2 });
  });

  it('其余链接归入关联', () => {
    expect(otherLinks(story).map((o) => `${o.label}:${o.issue.key}`)).toEqual([
      'Blocks-in:S-2',
      'Relates-in:T-9',
      'Blocks-out:T-5',
    ]);
  });

  it('子项能找到父需求', () => {
    const task = issue('T-1', '编码任务', [link('Blocks', 'out', ref('S-1', '需求'))]);
    expect(parentOf(task)?.key).toBe('S-1');
    expect(childLinks(task)).toEqual([]);
  });

  it('完整数据缺失时保留链接摘要', () => {
    const full = new Map([['T-1', issue('T-1', '编码任务', [])]]);
    const kids = resolveChildren(story, full);
    expect(kids[0]).toBe(full.get('T-1'));
    expect(kids[1].fields.status.name).toBe('关闭');
  });
});
