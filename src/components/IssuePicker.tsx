import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../lib/api';
import { buildJql, isIssueKey } from '../lib/jql';
import type { Issue } from '../lib/types';
import { StatusPill, TypeBadge } from './Badges';

interface Props {
  /** 默认在此项目内搜索；输入完整编号时可跨项目 */
  projectKey: string;
  /** 只列出这些类型（如选父需求时只要「需求」） */
  types?: string[];
  exclude?: string[];
  placeholder?: string;
  onPick: (issue: Issue) => void;
  autoFocus?: boolean;
}

const FIELDS = ['summary', 'status', 'issuetype', 'priority', 'components'];

/** 问题搜索框：输入编号或标题关键字，键盘上下选择、回车确认 */
export function IssuePicker({ projectKey, types, exclude = [], placeholder = '搜索编号或标题', onPick, autoFocus }: Props) {
  const [text, setText] = useState('');
  const [list, setList] = useState<Issue[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [state, setState] = useState<'' | 'loading' | 'empty' | string>('');
  const listId = useId();
  const blurTimer = useRef<number | undefined>(undefined);
  const typesKey = types?.join(',') ?? '';
  const excludeKey = exclude.join(',');

  useEffect(() => {
    const q = text.trim();
    if (!open) return;
    let alive = true;
    const t = setTimeout(() => {
      setState('loading');
      // 完整编号跨项目精确查找；否则在当前项目按标题搜，空输入列最近更新
      const jql = isIssueKey(q)
        ? buildJql({ text: q, types }, '')
        : buildJql({ project: projectKey, types, text: q }, 'updated DESC');
      api.search(jql, { maxResults: 12, fields: FIELDS }).then(
        (r) => {
          if (!alive) return;
          const items = r.issues.filter((i) => !exclude.includes(i.key));
          setList(items);
          setActive(0);
          setState(items.length ? '' : 'empty');
        },
        (e: Error) => alive && setState(e.message),
      );
    }, q ? 250 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, open, projectKey, typesKey, excludeKey]);

  const pick = (i: Issue) => {
    onPick(i);
    setText('');
    setOpen(false);
  };

  return (
    <div className="combo issue-picker">
      <input
        className="input"
        role="combobox"
        aria-label={placeholder}
        aria-expanded={open && list.length > 0}
        aria-controls={listId}
        aria-activedescendant={open && list[active] ? `${listId}-${active}` : undefined}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          blurTimer.current = window.setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, list.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (open && list[active]) pick(list[active]);
          } else if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {open && (list.length > 0 || state) && (
        <ul className="combo-list" role="listbox" id={listId}>
          {state === 'loading' && !list.length && <li className="combo-empty">搜索中…</li>}
          {state === 'empty' && <li className="combo-empty">没有匹配的问题{text.trim() ? '' : '（输入编号可跨项目查找）'}</li>}
          {state && state !== 'loading' && state !== 'empty' && <li className="combo-empty">{state}</li>}
          {list.map((i, idx) => (
            <li
              key={i.key}
              id={`${listId}-${idx}`}
              role="option"
              aria-selected={idx === active}
              onMouseDown={(e) => {
                e.preventDefault();
                clearTimeout(blurTimer.current);
                pick(i);
              }}
            >
              <TypeBadge type={i.fields.issuetype.name} />
              <span className="mono muted">{i.key}</span>
              <span className="summary">{i.fields.summary}</span>
              <StatusPill status={i.fields.status.name} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
