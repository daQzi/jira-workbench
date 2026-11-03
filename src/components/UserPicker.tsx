import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { JiraUser } from '../lib/types';

interface Props {
  value: string;
  onChange: (username: string) => void;
  project?: string;
  issueKey?: string;
  autoFocus?: boolean;
  placeholder?: string;
  /** 选中后立即回调（行内编辑用） */
  onPick?: (username: string) => void;
  onCancel?: () => void;
  label?: string;
}

/** 可分配用户搜索框：按 Jira assignable 接口检索，键盘可操作 */
export function UserPicker({ value, onChange, project, issueKey, autoFocus, placeholder = '输入姓名搜索', onPick, onCancel, label }: Props) {
  const [text, setText] = useState(value);
  const [users, setUsers] = useState<JiraUser[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState('');
  const listId = useId();
  const blurTimer = useRef<number | undefined>(undefined);

  useEffect(() => setText(value), [value]);

  useEffect(() => {
    const q = text.trim();
    if (!open || !q) {
      setUsers([]);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api.assignableUsers({ project, issueKey, query: q }).then(
        (u) => {
          if (!alive) return;
          setUsers(u);
          setActive(0);
          setError('');
        },
        (e: Error) => alive && setError(e.message),
      );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [text, open, project, issueKey]);

  const pick = (u: JiraUser) => {
    setText(u.name);
    onChange(u.name);
    setOpen(false);
    onPick?.(u.name);
  };

  return (
    <div className="combo">
      <input
        className="input"
        role="combobox"
        aria-label={label ?? '选择用户'}
        aria-expanded={open && users.length > 0}
        aria-controls={listId}
        aria-activedescendant={open && users[active] ? `${listId}-${active}` : undefined}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          // 清空即表示不设置
          if (!e.target.value.trim()) onChange('');
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          blurTimer.current = window.setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, users.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (open && users[active]) pick(users[active]);
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setOpen(false);
            onCancel?.();
          }
        }}
      />
      {open && (users.length > 0 || error) && (
        <ul className="combo-list" role="listbox" id={listId}>
          {error && <li className="combo-empty">{error}</li>}
          {users.map((u, i) => (
            <li
              key={u.name}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                clearTimeout(blurTimer.current);
                pick(u);
              }}
            >
              <span className="avatar" aria-hidden="true">
                {(u.displayName || u.name).slice(-2)}
              </span>
              {u.displayName || u.name}
              {u.displayName && u.displayName !== u.name && <span className="muted"> {u.name}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
