import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Project } from '../lib/types';

interface Props {
  projects: Project[] | null;
  /** null = 全部项目 */
  current: string | null;
  onPick: (key: string | null) => void;
  canWrite: (key: string) => boolean;
}

const shortName = (p: Project) => p.name.replace(/^\d+-/, '');

/** 侧栏顶部的全局项目切换：可搜索、键盘上下选择；最底部是「全部项目」 */
export function ProjectSwitcher({ projects, current, onPick, canWrite }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listId = useId();
  const cur = projects?.find((p) => p.key === current);

  const items = useMemo(() => {
    const lower = q.trim().toLowerCase();
    const list = (projects ?? []).filter((p) => !lower || p.key.toLowerCase().includes(lower) || p.name.toLowerCase().includes(lower));
    return [...list.map((p) => ({ key: p.key as string | null, p })), ...(!lower || '全部项目all'.includes(lower) ? [{ key: null, p: null }] : [])];
  }, [projects, q]);

  useEffect(() => {
    if (!open) return;
    setQ('');
    const on = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const i = items.findIndex((x) => x.key === current);
    setActive(q ? 0 : Math.max(0, i));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q]);
  useEffect(() => {
    ref.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (key: string | null) => {
    setOpen(false);
    if (key !== current) onPick(key);
  };

  return (
    <div className="proj-switch" ref={ref}>
      <button className="proj-switch-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)} title="切换项目">
        <span className="proj-switch-label">当前项目</span>
        <span className="proj-switch-name">{current === null ? '全部项目' : cur ? shortName(cur) : current ?? '加载中…'}</span>
        <span className="proj-switch-key">{current === null ? 'ALL' : current}</span>
        <span className="proj-switch-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="proj-pop">
          <input
            className="input"
            autoFocus
            role="combobox"
            aria-label="搜索项目"
            aria-controls={listId}
            aria-expanded
            aria-activedescendant={items[active] ? `${listId}-${active}` : undefined}
            placeholder="搜索项目名或 Key"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, items.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (items[active]) choose(items[active].key);
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setOpen(false);
              }
            }}
          />
          <ul role="listbox" id={listId}>
            {projects === null && <li className="proj-empty">加载中…</li>}
            {items.length === 0 && projects !== null && <li className="proj-empty">没有匹配的项目</li>}
            {items.map((it, idx) => (
              <li
                key={it.key ?? '__all'}
                id={`${listId}-${idx}`}
                data-idx={idx}
                role="option"
                aria-selected={idx === active}
                aria-current={it.key === current}
                className={it.key === null ? 'proj-all' : undefined}
                onMouseMove={() => setActive(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(it.key);
                }}
              >
                {it.p ? (
                  <>
                    <span className="name">{shortName(it.p)}</span>
                    {!canWrite(it.p.key) && <span className="ro">只读</span>}
                    <span className="mono key">{it.p.key}</span>
                  </>
                ) : (
                  <>
                    <span className="name">全部项目</span>
                    <span className="muted hint">跨项目汇总，仅工作台/工时</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
