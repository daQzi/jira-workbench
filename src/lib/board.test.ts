import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTER } from '../components/FilterBar';
import { boardQuery, chartCounts, kindMatches, ownerOf, peopleCounts, UNASSIGNED } from './board';
import type { Issue } from './types';
const issue = (key: string, type: string, assignee?: string, developer?: string): Issue => ({ id: key, key, fields: { summary: key, status: { id: '1', name: '开发中' }, issuetype: { id: '1', name: type }, assignee: assignee ? { name: assignee, displayName: '同名人员' } : null, customfield_10204: developer ? { name: developer, displayName: developer } : null } });
describe('看板统计', () => {
  it('按Jira账号唯一归属，需求任务分开，Bug不混入任务，空字段单列', () => {
    const issues = [issue('AA-1', '需求', 'a', 'b'), issue('AA-2', '编码任务', 'b', 'a'), issue('AA-3', '其他任务'), issue('AA-4', 'BUG及数据问题', 'a')];
    expect(peopleCounts(issues, 'assignee', 'requirement').map(p => [p.name, p.count])).toEqual([['a', 1]]);
    expect(peopleCounts(issues, 'assignee', 'task').map(p => p.name).sort()).toEqual([UNASSIGNED, 'b'].sort());
    expect(ownerOf(issues[0], 'developer').name).toBe('b');
    expect(kindMatches(issues[3], 'task')).toBe(false);
    expect(peopleCounts([...issues, issues[0]], 'assignee').reduce((n, p) => n + p.count, 0)).toBe(4);
  });
  it('前五位加其他人员与未分配，合并不丢总数、下钻保留原人员身份', () => {
    const counts = peopleCounts(Array.from({ length: 9 }, (_, index) => issue(`AA-${index}`, '需求', index ? `u${index}` : undefined)), 'assignee');
    const chart = chartCounts(counts);
    expect(chart.length).toBe(7); expect(chart.reduce((n, p) => n + p.count, 0)).toBe(9);
    expect(chart.find(p => p.name === '__others__')?.members.length).toBe(3);
    expect(chart.find(p => p.name === UNASSIGNED)?.count).toBe(1);
  });
  it('版本与人员共用查询，多选点击顺序不影响缓存身份', () => {
    const a = { ...DEFAULT_FILTER, version: '2.2', types: ['需求', '其他任务'], stages: ['dev', 'todo'] as const, people: [{ name: 'alice', displayName: '小王' }, { name: 'bob', displayName: '小李' }] };
    expect(boardQuery('AA', { ...a, stages: [...a.stages] })).toBe(boardQuery('AA', { ...a, people: [...a.people].reverse(), types: [...a.types].reverse(), stages: [...a.stages].reverse() }));
    expect(boardQuery('AA', { ...a, stages: [...a.stages] })).toContain('affectedVersion = "2.2"');
    expect(boardQuery('AA', { ...a, stages: [...a.stages] })).toContain('assignee in ("alice", "bob")');
  });
});
