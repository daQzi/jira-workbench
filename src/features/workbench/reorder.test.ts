import { describe, expect, it } from 'vitest';
import { defaultCards } from '../../lib/workCards';
import { mergeVisibleOrder, reorderCards } from './reorder';
describe('卡片换位', () => {
  it('保持其他卡片顺序，相同目标不修改数组', () => { const cards = defaultCards(); expect(reorderCards(cards, cards[0].id, cards[2].id).map(c => c.title)).toEqual(['开发中', '待测试 / 验收', '待处理', '临期与逾期']); expect(reorderCards(cards, cards[0].id, cards[0].id)).toBe(cards); });
  it('反向移动和无效 ID', () => { const cards = defaultCards(); expect(reorderCards(cards, cards[3].id, cards[1].id).map(c => c.title)).toEqual(['待处理', '临期与逾期', '开发中', '待测试 / 验收']); expect(reorderCards(cards, 'not-found', cards[1].id)).toBe(cards); });
  it('可见卡片换位后保留隐藏卡片、原始条件和位置', () => {
    const cards = defaultCards().map((card, index) => ({ ...card, hidden: index === 1 }));
    const hidden = cards[1];
    const next = mergeVisibleOrder(cards, [cards[3].id, cards[0].id, cards[2].id]);
    expect(next.map(c => c.id)).toEqual([cards[3].id, hidden.id, cards[0].id, cards[2].id]);
    expect(next[1]).toBe(hidden);
    const allHidden = cards.map(c => ({ ...c, hidden: true }));
    expect(mergeVisibleOrder(allHidden, [])).toEqual(allHidden);
  });
  it('重复、缺失或包含隐藏 ID 的排序不能覆盖完整配置', () => {
    const cards = defaultCards().map((card, index) => ({ ...card, hidden: index === 1 }));
    for (const ids of [[], cards.map(c => c.id), [cards[0].id, cards[0].id, cards[2].id], [cards[0].id, cards[2].id, 'unknown']]) expect(mergeVisibleOrder(cards, ids)).toBe(cards);
  });
});
