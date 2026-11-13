import { describe, expect, it } from 'vitest';
import { cardFromLegacy, cardPreviewCount, cardSummary, defaultCards, needsProjectIssues, newCard, selectCardIssues, validCards } from './workCards';
import type { Issue } from './types';
const hf = { estimate: [], devDone: [], devStart: [] };
const issue = (key: string, fields: Record<string, unknown> = {}): Issue => ({ id: key, key, fields: {
  summary: '接口优化', status: { id: '1', name: '开发中' }, issuetype: { id: '1', name: '编码任务' },
  customfield_10204: { name: 'alice' }, updated: '2026-11-10T10:00:00Z', ...fields,
} });
const select = (issues: Issue[], patch: Parameters<typeof newCard>[0] = {}) => selectCardIssues(issues, newCard(patch), hf, 'alice', '2026-11-10');
describe('工作台卡片', () => {
  it('自动高度遵守预览条数，固定高度也不会超出条数设置', () => {
    expect(cardPreviewCount(newCard({ limit: 5 }))).toBe(5);
    expect(cardPreviewCount(newCard({ limit: 3, height: 900 }))).toBe(3);
    expect(cardPreviewCount(newCard({ limit: 10, height: 200 }))).toBe(1);
    expect(cardPreviewCount(newCard({ limit: 10, height: 300 }))).toBe(3);
  });
  it('默认清单覆盖熟悉阶段与临期风险，配置独立并通过校验', () => {
    const cards = defaultCards(); expect(cards.map(c => c.title)).toEqual(['待处理', '开发中', '待测试 / 验收', '临期与逾期']);
    expect(validCards(cards)).toBe(true); expect(new Set(cards.map(c => c.id)).size).toBe(4);
    expect(validCards([{ ...cards[0], stages: ['unknown'] }])).toBe(false);
    expect(validCards([cards[0], cards[0]])).toBe(false);
    expect(validCards([{ ...cards[0], limit: 10000 }])).toBe(false);
    expect(validCards([])).toBe(true);
  });
  it('按 Jira 账号判断经办、开发、测试关系，所有人需要扩大查询范围', () => {
    const dev = issue('A-1');
    const tester = issue('A-2', { customfield_10204: null, customfield_10401: { name: 'alice' } });
    const other = issue('A-3', { customfield_10204: { name: 'bob' }, assignee: { name: 'bob', displayName: 'alice' } });
    expect(select([dev, tester, other]).map(i => i.key)).toEqual(['A-1', 'A-2']);
    expect(select([dev, tester], { relation: 'tester' }).map(i => i.key)).toEqual(['A-2']);
    expect(select([other], { relation: 'all' })).toHaveLength(1);
    expect(needsProjectIssues([newCard()])).toBe(false);
    expect(needsProjectIssues([newCard({ relation: 'all' })])).toBe(true);
  });
  it('多个字段同时满足，版本与优先级使用实际名称', () => {
    const good = issue('A-1', { issuetype: { id: '9', name: '需求' }, priority: { id: '2', name: '紧急' }, versions: [{ name: '1.0' }], duedate: '2026-11-11' });
    const filter = { types: ['需求'], stages: ['dev'] as const, priority: '紧急', version: '1.0', text: '接口', dueFrom: '2026-11-10', dueTo: '2026-11-12' };
    const card = newCard({ ...filter, stages: [...filter.stages] });
    expect(selectCardIssues([good, issue('A-2')], card, hf, 'alice')).toEqual([good]);
    expect(select([good], { ...card, dueTo: '2026-11-10' })).toHaveLength(0);
    expect(cardSummary(card)).toContain('紧急'); expect(cardSummary(card)).toContain('1.0');
  });
  it('临期包含逾期与3天边界，排除已解决事项和无到期日期', () => {
    const cases = [issue('A-1', { duedate: '2026-11-08' }), issue('A-2', { duedate: '2026-11-13' }), issue('A-3', { duedate: '2026-11-14' }), issue('A-4', { duedate: '2026-11-08', resolution: { id: '1' } }), issue('A-5')];
    expect(select(cases, { view: 'due', sort: 'due' }).map(i => i.key)).toEqual(['A-1', 'A-2']);
  });
  it('未知状态在未完成条件保留，指定阶段才排除；日期缺失排序置后', () => {
    const unknown = issue('A-1', { status: { id: '9', name: '待排期确认' } });
    expect(select([unknown])).toHaveLength(1); expect(select([unknown], { stages: ['dev'] })).toHaveLength(0);
    expect(select([issue('A-2'), issue('A-3', { duedate: '2026-11-11' })], { sort: 'due' }).map(i => i.key)).toEqual(['A-3', 'A-2']);
  });
  it('旧版已保存视图保留条件，可转成卡片', () => {
    const card = cardFromLegacy({ id: 'old', name: '版本风险', prefs: { view: 'blocked', text: '回归', version: 'v2' } });
    expect(card).toMatchObject({ title: '版本风险', view: 'blocked', text: '回归', version: 'v2', custom: true });
    expect(validCards([card])).toBe(true);
  });
});
