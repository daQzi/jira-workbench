import { defaultDropAnimationSideEffects, type DropAnimation, type KeyboardCoordinateGetter } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { WorkbenchCard } from '../../lib/workCards';
export function reorderCards(cards: WorkbenchCard[], activeId: string, overId: string): WorkbenchCard[] {
  const from = cards.findIndex(c => c.id === activeId), to = cards.findIndex(c => c.id === overId);
  if (from < 0 || to < 0 || from === to) return cards;
  const next = [...cards]; const [item] = next.splice(from, 1); next.splice(to, 0, item); return next;
}
export const cardDropAnimation: DropAnimation = { duration: 240, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0' }, dragOverlay: { opacity: '1' } } }) };
export const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => sortableKeyboardCoordinates(event, args);
