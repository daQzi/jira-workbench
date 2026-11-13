import { describe, expect, it } from 'vitest';
import { defaultCards } from '../../lib/workCards';
import { reorderCards } from './reorder';
describe('卡片换位', () => {
  it('保持其他卡片顺序，相同目标不修改数组', () => { const cards = defaultCards(); expect(reorderCards(cards, cards[0].id, cards[2].id).map(c => c.title)).toEqual(['开发中', '待测试 / 验收', '待处理', '临期与逾期']); expect(reorderCards(cards, cards[0].id, cards[0].id)).toBe(cards); });
  it('反向移动和无效 ID', () => { const cards = defaultCards(); expect(reorderCards(cards, cards[3].id, cards[1].id).map(c => c.title)).toEqual(['待处理', '临期与逾期', '开发中', '待测试 / 验收']); expect(reorderCards(cards, 'not-found', cards[1].id)).toBe(cards); });
});
