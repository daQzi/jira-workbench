import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { buildJql, isIssueKey } from '../lib/jql';
import { loadRecent, type RecentIssue } from '../lib/recent';
import type { Project } from '../lib/types';
import { StatusPill, TypeBadge } from './Badges';

interface Props {
  projects: Project[];
  /** 当前全局项目：关键字只搜这个项目；完整编号仍可跨项目打开 */
  currentProject: string | null;
  onOpenIssue: (key: string) => void;
  onOpenProject: (key: string) => void;
  onClose: () => void;
}

type Item =
  | { kind: 'issue'; key: string; summary: string; type: string; status: string }
  | { kind: 'project'; key: string; name: string };

const FIELDS = ['summary', 'status', 'issuetype'];

/** ⌘K / Ctrl+K 跳转：输入编号直接打开，关键字跨项目搜标题，也能跳项目 */
export function CommandPalette({ projects, currentProject, onOpenIssue, onOpenProject, onClose }: Props) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<Item[]>([]);
  const [state, setState] = useState<'' | 'loading' | string>('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const recent = useMemo<RecentIssue[]>(() => loadRecent(), []);
  const q = text.trim();
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!q) {
      setFound([]);
      setState('');
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      setState('loading');
      const jql = isIssueKey(q) ? buildJql({ text: q }, '') : buildJql({ project: currentProject ?? undefined, text: q }, 'updated DESC');
      api.search(jql, { maxResults: 15, fields: FIELDS }).then(
        (r) => {
          if (!alive) return;
          setFound(r.issues.map((i) => ({ kind: 'issue', key: i.key, summary: i.fields.summary, type: i.fields.issuetype.name, status: i.fields.status.name })));
          setState('');
        },
        (e: Error) => alive && setState(e.message),
      );
    }, 220);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, currentProject]);

  const items: Item[] = useMemo(() => {
    if (!q) return recent.map((r) => ({ kind: 'issue' as const, ...r }));
    const lower = q.toLowerCase();
    const projs = projects
      .filter((p) => p.key.toLowerCase().includes(lower) || p.name.toLowerCase().includes(lower))
      .slice(0, 4)
      .map((p) => ({ kind: 'project' as const, key: p.key, name: p.name }));
    return [...projs, ...found];
  }, [q, recent, projects, found]);

  useEffect(() => setActive(0), [items]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (it: Item | undefined) => {
    if (it?.kind === 'project') onOpenProject(it.key);
    else if (it) onOpenIssue(it.key);
    else if (isIssueKey(q)) onOpenIssue(q.toUpperCase()); // 搜索还没返回也能直接开
    else return;
    onClose();
  };

  return (
    <div className="modal-mask palette-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="快速跳转">
        <input
          className="palette-input"
          autoFocus
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-activedescendant={items[active] ? `${listId}-${active}` : undefined}
          placeholder={currentProject ? `输入编号直接打开，搜索 ${currentProject} 的标题，或输入项目名切换` : '输入编号直接打开，或搜索标题 / 项目'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, items.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              choose(items[active]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <ul className="palette-list" role="listbox" id={listId} ref={listRef}>
          {!q && <li className="palette-head">{recent.length ? '最近查看' : '还没有查看记录，输入编号或关键字开始'}</li>}
          {items.map((it, idx) => (
            <li
              key={`${it.kind}:${it.key}`}
              id={`${listId}-${idx}`}
              data-idx={idx}
              role="option"
              aria-selected={idx === active}
              onMouseMove={() => setActive(idx)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(it);
              }}
            >
              {it.kind === 'project' ? (
                <>
                  <span className="palette-tag">切换项目</span>
                  <span className="summary">{it.name}</span>
                  <span className="mono muted">{it.key}</span>
                </>
              ) : (
                <>
                  {it.type && <TypeBadge type={it.type} />}
                  <span className="mono muted">{it.key}</span>
                  <span className="summary">{it.summary}</span>
                  {it.status && <StatusPill status={it.status} />}
                </>
              )}
            </li>
          ))}
          {q && state === 'loading' && !found.length && <li className="palette-head">搜索中…</li>}
          {q && state && state !== 'loading' && <li className="palette-head err">{state}</li>}
          {q && !state && !items.length && (
            <li className="palette-head">{isIssueKey(q) ? `回车直接打开 ${q.toUpperCase()}` : '没有匹配的问题'}</li>
          )}
        </ul>
        <footer className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 打开</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </footer>
      </div>
    </div>
  );
}
