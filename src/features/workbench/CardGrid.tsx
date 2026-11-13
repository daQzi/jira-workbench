import { closestCenter, DndContext, DragOverlay, KeyboardSensor, MeasuringStrategy, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { rectSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import type { WorkbenchCard } from '../../lib/workCards';
import { cardDropAnimation, keyboardCoordinates } from './reorder';
export interface DragHandle { attributes: HTMLAttributes<HTMLElement>; listeners: ReturnType<typeof useSortable>['listeners']; ref: (node: HTMLElement | null) => void }
interface RenderCard { (card: WorkbenchCard, index: number, active: boolean, handle: DragHandle, overlay: boolean): ReactNode }
function SortableCard({ card, children, reduced }: { card: WorkbenchCard; children: RenderCard; reduced: boolean }) {
  const sortable = useSortable({ id: card.id, transition: { duration: reduced ? 0 : 240, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' } });
  const handle = { attributes: { ...sortable.attributes, 'aria-label': `移动卡片 ${card.title}`, 'aria-describedby': 'workbench-drag-help' } as HTMLAttributes<HTMLElement>, listeners: sortable.listeners, ref: sortable.setActivatorNodeRef };
  return <section ref={sortable.setNodeRef} className={`workbench-card${sortable.isDragging ? ' drag-source' : ''}${card.width === 4 ? ' wide' : ''}`} aria-label={card.title} data-card-id={card.id} style={{ gridColumn: card.width === 4 ? '1/-1' : `span ${card.width}`, height: card.height, transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition ?? undefined }} data-sorting={sortable.isSorting || undefined}>{children(card, sortable.index, sortable.isDragging, handle, false)}</section>;
}
export function CardGrid({ cards, persist, reduced, children }: { cards: WorkbenchCard[]; persist: (cards: WorkbenchCard[], message?: string) => boolean; reduced: boolean; children: RenderCard }) {
  const [activeId, setActiveId] = useState<string | null>(null); const [overlay, setOverlay] = useState<WorkbenchCard | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 7 } }), useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates, keyboardCodes: { start: ['Space', 'Enter'], cancel: ['Escape'], end: ['Space', 'Enter'] } }));
  const active = overlay ?? cards.find(c => c.id === activeId); const dropTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { document.body.classList.remove('is-card-dragging'); clearTimeout(dropTimer.current); }, []);
  function cancel() { setActiveId(null); document.body.classList.remove('is-card-dragging'); const leaving = overlay; setOverlay(null); if (leaving) setTimeout(() => setOverlay(current => current === leaving ? null : current), 280); }
  function start(event: DragStartEvent) { const id = String(event.active.id); setActiveId(id); setOverlay(cards.find(c => c.id === id) ?? null); clearTimeout(dropTimer.current); document.body.classList.add('is-card-dragging'); }
  function end(event: DragEndEvent) { const { active, over } = event; cancel(); if (!over || active.id === over.id) return; const from = cards.findIndex(c => c.id === active.id), to = cards.findIndex(c => c.id === over.id); if (from < 0 || to < 0) return; const next = [...cards]; const [card] = next.splice(from, 1); next.splice(to, 0, card); persist(next, '卡片位置已保存'); }
  return <DndContext sensors={sensors} collisionDetection={closestCenter} measuring={{ droppable: { strategy: MeasuringStrategy.Always } }} onDragStart={start} onDragCancel={cancel} onDragEnd={end}>
    <SortableContext items={cards.map(c => c.id)} strategy={rectSortingStrategy}><div className="workbench-grid">{cards.map(card => <SortableCard key={card.id} card={card} reduced={reduced}>{children}</SortableCard>)}</div></SortableContext>
    <DragOverlay dropAnimation={reduced ? null : cardDropAnimation} zIndex={40}>{active ? <section className="workbench-card pointer-dragging drag-overlay-card" style={{ height: active.height }} aria-hidden="true">{children(active, cards.indexOf(active), true, { attributes: {}, listeners: undefined, ref: () => {} }, true)}</section> : null}</DragOverlay>
  </DndContext>;
}
