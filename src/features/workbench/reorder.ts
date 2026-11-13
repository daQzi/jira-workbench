import { defaultDropAnimationSideEffects, type DropAnimation, type KeyboardCoordinateGetter } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { WorkbenchCard } from '../../lib/workCards';
export function reorderCards(cards: WorkbenchCard[], activeId: string, overId: string): WorkbenchCard[] {
  const from = cards.findIndex(c => c.id === activeId), to = cards.findIndex(c => c.id === overId);
  if (from < 0 || to < 0 || from === to) return cards;
  const next = [...cards]; const [item] = next.splice(from, 1); next.splice(to, 0, item); return next;
}
/** 排序只替换可见位置；隐藏卡片保留在完整配置的原位置。 */
export function mergeVisibleOrder(cards: WorkbenchCard[], ids: string[]): WorkbenchCard[] {
  const visible = cards.filter(card => !card.hidden);
  const byId = new Map(visible.map(card => [card.id, card]));
  if (ids.length !== visible.length || new Set(ids).size !== ids.length || ids.some(id => !byId.has(id))) return cards;
  let index = 0;
  return cards.map(card => card.hidden ? card : byId.get(ids[index++])!);
}
export const cardDropAnimation: DropAnimation = { duration: 240, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0' }, dragOverlay: { opacity: '1' } } }) };
export const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => sortableKeyboardCoordinates(event, args);
