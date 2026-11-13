import { useEffect, useRef, type RefObject } from 'react';

const layers: HTMLElement[] = [];
const selector = 'button:not(:disabled),a[href],input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

/** 只让最上层弹窗处理焦点和 Esc，关闭后恢复触发入口。 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, onEscape: () => void) {
  const close = useRef(onEscape); close.current = onEscape;
  // 在弹窗挂载和子输入框 autoFocus 之前记下入口。
  const opener = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = opener.current;
    layers.push(dialog);
    const top = () => layers.at(-1) === dialog;
    const targets = () => [...dialog.querySelectorAll<HTMLElement>(selector)].filter(el => el.getClientRects().length && !el.closest('[hidden],[inert]'));
    const focus = () => (targets()[0] ?? dialog).focus({ preventScroll: true });
    if (!dialog.contains(document.activeElement)) focus();
    const key = (event: KeyboardEvent) => {
      if (!top()) return;
      if (event.key !== 'Tab') return;
      const items = targets(), index = items.indexOf(document.activeElement as HTMLElement);
      if (!items.length) { event.preventDefault(); dialog.focus(); }
      else if (event.shiftKey && index <= 0) { event.preventDefault(); items.at(-1)!.focus(); }
      else if (!event.shiftKey && (index < 0 || index === items.length - 1)) { event.preventDefault(); items[0].focus(); }
    };
    const escape = (event: KeyboardEvent) => { if (top() && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopImmediatePropagation(); close.current(); } };
    const guard = (event: FocusEvent) => { if (top() && !dialog.contains(event.target as Node)) focus(); };
    document.addEventListener('keydown', key, true);
    document.addEventListener('keydown', escape);
    document.addEventListener('focusin', guard);
    return () => {
      const wasTop = top(); const index = layers.indexOf(dialog); if (index >= 0) layers.splice(index, 1);
      document.removeEventListener('keydown', key, true); document.removeEventListener('focusin', guard);
      document.removeEventListener('keydown', escape);
      if (wasTop && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [ref]);
}
