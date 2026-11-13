import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDialogFocus } from '../lib/useDialogFocus';

interface Props {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** 提交期间禁止遮罩、Esc 和关闭按钮关闭，防止用户误以为已取消而再次提交 */
  busy?: boolean;
}

/** 通用对话框：Esc 关闭、打开时聚焦第一个输入控件 */
export function Modal({ title, onClose, children, footer, width = 640, busy = false }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const close = () => { if (!busy) onClose(); };
  useDialogFocus(ref, close);
  return createPortal(
    <div
      className="modal-mask"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-busy={busy} aria-label={typeof title === 'string' ? title : undefined} tabIndex={-1} ref={ref} style={{ width: `min(${width}px, 94vw)` }}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="btn ghost" disabled={busy} onClick={close} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>, document.body
  );
}
