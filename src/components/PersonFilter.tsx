import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { JiraUser } from '../lib/types';

export type FilterPerson = Pick<JiraUser, 'name' | 'displayName'>;
interface Props {
  value: FilterPerson[];
  onlyMine: boolean;
  onChange: (people: FilterPerson[]) => void;
}

/** 搜索与勾选只修改草稿，应用后一次查询；人员来自 Jira，不另维护名单。 */
export function PersonFilter({ value, onlyMine, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<FilterPerson[]>([]);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, above: false, height: 500 });
  const [result, setResult] = useState<{ query: string; users: FilterPerson[]; error?: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const query = text.trim();
  const ready = result?.query === query;
  const items = query ? ready ? result.users : [] : draft;
  const selected = new Set(draft.map(person => person.name));

  useLayoutEffect(() => {
    if (!open) return;
    const align = () => {
      if (!ref.current || !popup.current) return;
      const rect = ref.current.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 20, above = rect.top - 20;
      const placeAbove = below < Math.min(popup.current.scrollHeight, 420) && above > below;
      setPosition({ left: Math.max(14 - rect.left, Math.min(0, window.innerWidth - 14 - rect.left - popup.current.offsetWidth)), above: placeAbove, height: Math.max(120, Math.min(500, placeAbove ? above : below)) });
    };
    align(); window.addEventListener('resize', align);
    return () => window.removeEventListener('resize', align);
  }, [open, draft.length, items.length]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  useEffect(() => {
    if (!open || !query) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      api.searchUsers(query, ctrl.signal).then(
        users => { if (!ctrl.signal.aborted) { setResult({ query, users }); setActive(0); } },
        (error: Error) => { if (!ctrl.signal.aborted) setResult({ query, users: [], error: error.message }); },
      );
    }, 300);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [open, query]);

  useEffect(() => { list.current?.children[active]?.scrollIntoView({ block: 'nearest' }); }, [active]);
  function toggle(person: FilterPerson) {
    setDraft(people => people.some(p => p.name === person.name) ? people.filter(p => p.name !== person.name) : [...people, { name: person.name, displayName: person.displayName || person.name }]);
  }
  function close() { setOpen(false); trigger.current?.focus(); }
  const label = value.length > 1 ? `已选 ${value.length} 人` : value.length ? value[0].displayName || value[0].name : onlyMine ? '我' : '全部人员';
  return <div className="person-filter" ref={ref} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <button ref={trigger} type="button" className={`btn person-filter-trigger${value.length || onlyMine ? ' is-set' : ''}`} aria-label={`人员筛选：${label}`} aria-expanded={open} aria-haspopup="dialog" title="按经办人、开发人员或测试人员筛选" onClick={() => {
      setOpen(!open); setDraft(value.map(p => ({ ...p }))); setText(''); setResult(null); setActive(0);
    }}>
      <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="10" cy="6" r="3"/><path d="M4 17v-2a6 6 0 0 1 12 0v2"/></svg>
      <span data-full-text={value.length ? value.map(p => `${p.displayName || p.name}（${p.name}）`).join('\n') : undefined}>{value.length || onlyMine ? `人员：${label}` : label}</span><span className="muted" aria-hidden="true">⌄</span>
    </button>
    {open && <div ref={popup} className="person-filter-pop" style={{ left: position.left, top: position.above ? 'auto' : undefined, bottom: position.above ? 'calc(100% + 6px)' : undefined, maxHeight: position.height }} role="dialog" aria-label="选择筛选人员" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
      <div className="person-filter-selection-head"><strong>已选 {draft.length} 人</strong><button className="text-btn" disabled={!draft.length} onClick={() => { setDraft([]); setActive(0); }}>清空选择</button></div>
      {!!draft.length && <div className="person-filter-selected">{draft.map(person => <button key={person.name} className="chip" aria-label={`移除 ${person.displayName}（${person.name}）`} title={person.name} onClick={() => toggle(person)}>{person.displayName}<span aria-hidden="true">×</span></button>)}</div>}
      <input className="input" autoFocus role="combobox" aria-label="搜索人员" aria-expanded aria-controls={listId} aria-autocomplete="list" aria-activedescendant={items.length && active < items.length ? `${listId}-${active}` : undefined} placeholder="搜索姓名或账号，可多选" value={text} onChange={event => { setText(event.target.value); setActive(0); }} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, Math.min(index + (event.key === 'ArrowDown' ? 1 : -1), items.length - 1))); }
        else if (event.key === 'Enter') { event.preventDefault(); if (items.length && active < items.length) toggle(items[active]); }
      }}/>
      <p className="person-filter-hint">任一所选人员匹配经办、开发或测试；未选择时查看全部人员</p>
      <ul ref={list} role="listbox" aria-multiselectable="true" id={listId} aria-label="人员搜索结果">{items.map((person, index) => <li key={person.name} id={`${listId}-${index}`} role="option" aria-selected={selected.has(person.name)} className={index === active ? 'is-active' : undefined} onMouseMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => toggle(person)}>
        <span className={`person-filter-check${selected.has(person.name) ? ' checked' : ''}`} aria-hidden="true">{selected.has(person.name) ? '✓' : ''}</span><span className="avatar" aria-hidden="true">{(person.displayName || person.name).slice(-2)}</span>
        <span className="person-filter-name">{person.displayName || person.name}<small className="muted">{person.name}</small></span>
      </li>)}</ul>
      <div className="person-filter-hint" role="status">{!query ? '输入姓名或账号查找同事，可连续搜索勾选' : !ready ? '搜索中…' : result.error ? `无法搜索人员：${result.error}` : !items.length ? '没有匹配的人员，请尝试姓名或完整账号' : '每次搜索最多显示 20 位，已选人员会保留'}</div>
      <div className="person-filter-actions"><button className="btn small ghost" onClick={close}>取消</button><button className="btn primary small" onClick={() => { onChange(draft); close(); }}>应用{draft.length ? ` ${draft.length} 人` : '全部人员'}</button></div>
    </div>}
  </div>;
}
