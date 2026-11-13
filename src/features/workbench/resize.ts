import type { WorkCard } from '../../lib/workCards';
/** 缩放起点与当前指针，换算出第四轨宽度和20px对齐高度；纯函数便于边界测试。 */
export function resizeCard(origin: { x: number; y: number; width: number; height: number; colWidth: number }, pointer: { x: number; y: number }) {
  const width = Math.max(1, Math.min(4, Math.round((origin.width + pointer.x - origin.x) / origin.colWidth))) as WorkCard['width'];
  const height = Math.max(200, Math.min(900, Math.round((origin.height + pointer.y - origin.y) / 20) * 20));
  return { width, height };
}
export const resizeColumn = (width: WorkCard['width']) => width === 4 ? '1/-1' : `span ${width}`;
