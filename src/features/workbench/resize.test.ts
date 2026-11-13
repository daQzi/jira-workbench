import { describe, expect, it } from 'vitest';
import { resizeCard, resizeColumn } from './resize';
const origin = { x: 100, y: 100, width: 300, height: 400, colWidth: 160 };
describe('卡片缩放几何', () => {
  it('按轨宽吸附1–4列，按20px吸附高度', () => {
    expect(resizeCard(origin, { x: 100, y: 100 })).toEqual({ width: 2, height: 400 });
    expect(resizeCard(origin, { x: 230, y: 143 })).toEqual({ width: 3, height: 440 });
    expect(resizeCard(origin, { x: 900, y: 900 })).toEqual({ width: 4, height: 900 });
    expect(resizeCard(origin, { x: -900, y: -900 })).toEqual({ width: 1, height: 200 });
  });
  it('整行卡片跨四列，其他保持跨度', () => { expect(resizeColumn(4)).toBe('1/-1'); expect(resizeColumn(3)).toBe('span 3'); });
});
