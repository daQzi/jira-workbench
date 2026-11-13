import { useEffect, useRef } from 'react';
import type { WorkbenchCard, CardWidth } from '../../lib/workCards';
import { resizeCard, resizeColumn } from './resize';

/** 缩放只改当前 DOM，跨度改变时给邻居做位置补间，结束后提交一次。 */
export function CardResizeHandle({ card, onResize }: { card: WorkbenchCard; onResize: (width: CardWidth, height: number) => void }) {
  const cleanup = useRef<(() => void) | null>(null);
  const label = useRef<HTMLOutputElement>(null);
  useEffect(() => () => cleanup.current?.(), []);
  return <>
    <output ref={label} className="workbench-size-preview" hidden aria-live="off"/>
    <button className="workbench-resize-handle" aria-label={`拖拽调整${card.title}大小，方向键也可调整`} onPointerDown={event => {
      if (event.button !== 0 || window.innerWidth <= 1100 || cleanup.current) return;
      event.preventDefault(); event.stopPropagation();
      const element = event.currentTarget.closest<HTMLElement>('.workbench-card')!;
      const grid = element.closest<HTMLElement>('.workbench-grid')!;
      const rect = element.getBoundingClientRect(), gap = parseFloat(getComputedStyle(grid).columnGap) || 16;
      const origin = { x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, colWidth: (grid.getBoundingClientRect().width + gap) / 4 };
      let next = { width: card.width, height: Math.max(200, rect.height) }, appliedWidth = card.width, frame = 0;
      const animations: Animation[] = [];
      const reduced = document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;
      element.classList.add('resizing'); grid.classList.add('resize-guides'); document.body.classList.add('is-card-resizing');
      grid.style.setProperty('--grid-track', `${origin.colWidth}px`);
      event.currentTarget.setPointerCapture(event.pointerId);
      const paint = () => {
        const neighbours = !reduced && next.width !== appliedWidth ? [...grid.querySelectorAll<HTMLElement>(':scope > .workbench-card')].filter(el => el !== element).map(el => ({ el, rect: el.getBoundingClientRect() })) : [];
        if (next.width !== appliedWidth) { animations.splice(0).forEach(a => a.cancel()); }
        element.style.height = `${next.height}px`; element.style.gridColumn = resizeColumn(next.width);
        for (const { el, rect: before } of neighbours) {
          const after = el.getBoundingClientRect(), x = before.x - after.x, y = before.y - after.y;
          if (x || y) animations.push(el.animate([{ transform: `translate(${x}px,${y}px)` }, { transform: 'translate(0,0)' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' }));
        }
        appliedWidth = next.width;
        if (label.current) { label.current.hidden = false; label.current.textContent = `${next.width} / 4 列 · ${next.height}px`; }
      };
      const move = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return;
        const result = resizeCard(origin, { x: moveEvent.clientX, y: moveEvent.clientY });
        if (next.width === result.width && next.height === result.height) return;
        next = result; cancelAnimationFrame(frame); frame = requestAnimationFrame(paint);
      };
      const finish = (commit: boolean) => {
        if (!cleanup.current) return;
        cleanup.current = null; cancelAnimationFrame(frame);
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape, true);
        animations.forEach(a => a.cancel()); element.classList.remove('resizing'); grid.classList.remove('resize-guides'); document.body.classList.remove('is-card-resizing');
        if (label.current) label.current.hidden = true;
        element.style.height = card.height ? `${card.height}px` : ''; element.style.gridColumn = resizeColumn(card.width);
        if (commit && (next.width !== card.width || next.height !== card.height)) onResize(next.width, next.height);
      };
      const up = (upEvent: PointerEvent) => { if (upEvent.pointerId === event.pointerId) finish(true); };
      const cancel = () => finish(false);
      const escape = (key: KeyboardEvent) => { if (key.key === 'Escape') { key.preventDefault(); key.stopImmediatePropagation(); cancel(); } };
      cleanup.current = cancel;
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel); window.addEventListener('blur', cancel); window.addEventListener('keydown', escape, true);
    }} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const width = Math.max(1, Math.min(4, card.width + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0))) as CardWidth;
      const height = Math.max(200, Math.min(900, (card.height ?? 400) + (event.key === 'ArrowUp' ? -20 : event.key === 'ArrowDown' ? 20 : 0)));
      onResize(width, height);
    }}><span aria-hidden="true"/></button>
  </>;
}
