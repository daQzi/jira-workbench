import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const SELECTOR = '[data-full-text], .link-item .summary, .management-title > span:last-child, .management-table td, .workbench-task-title > span:last-child, .card-summary, .title-cell .summary, .proj-switch-name, .proj-pop .name, .att-name, .palette-list .summary, .issue-picker .summary';
interface Hint { element: Element; text: string }
/** 所有省略标题共享一个浮层；支持悬停、键盘焦点及复制，避开抽屉 overflow 裁切。 */
export function FullTextTooltip() {
  const [hint, setHint] = useState<Hint | null>(null);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = useRef(hint); current.current = hint;
  const cancel = () => clearTimeout(timer.current);
  const close = () => { cancel(); setHint(null); };
  const leave = () => { cancel(); timer.current = setTimeout(() => setHint(null), 180); };
  useEffect(() => {
    function find(target: EventTarget | null, focus: boolean) {
      if (document.body.matches('.is-card-dragging,.is-card-resizing')) return null;
      if (!(target instanceof Element) || target.closest('.full-text-tooltip')) return null;
      const element = (focus ? target.querySelector(SELECTOR) : null) || target.closest(SELECTOR);
      if (!element) return null;
      const text = element.getAttribute('data-full-text') || element.getAttribute('title') || element.textContent?.trim();
      const explicit = element.hasAttribute('data-full-text');
      if (!text || (!explicit && element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)) return null;
      return { element, text };
    }
    const show = (event: Event) => {
      const next = find(event.target, event.type === 'focusin');
      if (!next) return;
      cancel();
      if (current.current?.element === next.element) return;
      timer.current = setTimeout(() => { if (next.element.isConnected) setHint(next); }, event.type === 'focusin' ? 0 : 280);
    };
    const out = (event: Event) => {
      const related = (event as MouseEvent).relatedTarget;
      if (related instanceof Node && (current.current?.element.contains(related) || tip.current?.contains(related))) return;
      leave();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && current.current) { event.stopPropagation(); close(); } };
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !tip.current?.contains(event.target)) close(); };
    const click = (event: Event) => { if (!(event.target instanceof Node) || !tip.current?.contains(event.target)) close(); };
    document.addEventListener('mouseover', show);
    document.addEventListener('focusin', show);
    document.addEventListener('mouseout', out);
    document.addEventListener('focusout', out);
    document.addEventListener('keydown', escape, true);
    document.addEventListener('scroll', scroll, true);
    document.addEventListener('click', click);
    document.addEventListener('pointerdown', click);
    window.addEventListener('resize', close);
    return () => {
      cancel(); document.removeEventListener('mouseover', show); document.removeEventListener('focusin', show);
      document.removeEventListener('mouseout', out); document.removeEventListener('focusout', out);
      document.removeEventListener('keydown', escape, true); document.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', close);
      document.removeEventListener('click', click);
      document.removeEventListener('pointerdown', click);
    };
  }, []);
  useLayoutEffect(() => {
    if (!hint || !tip.current) return;
    const rect = hint.element.getBoundingClientRect(), box = tip.current.getBoundingClientRect();
    setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - box.width - 12)), top: Math.max(12, rect.bottom + box.height + 10 <= window.innerHeight ? rect.bottom + 8 : rect.top - box.height - 8) });
    const description = hint.element.getAttribute('aria-describedby');
    const title = hint.element.getAttribute('title');
    hint.element.setAttribute('aria-describedby', [description, 'full-text-tooltip'].filter(Boolean).join(' '));
    hint.element.removeAttribute('title');
    return () => {
      if (description) hint.element.setAttribute('aria-describedby', description); else hint.element.removeAttribute('aria-describedby');
      if (title) hint.element.setAttribute('title', title);
    };
  }, [hint]);
  return hint ? createPortal(<div ref={tip} id="full-text-tooltip" role="tooltip" className="full-text-tooltip" style={position} onMouseEnter={cancel} onMouseLeave={leave}>{hint.text}</div>, document.body) : null;
}
