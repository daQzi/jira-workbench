import { useEffect, useRef, useState } from 'react';
import { useSession } from '../lib/session';
import type { Issue } from '../lib/types';
import { NO_VERSION, versionNames } from '../lib/versions';
import { ErrorState, Loading } from '../components/States';
import { ManagementTable } from '../components/ManagementTable';
import { TypeBadge, StatusPill } from '../components/Badges';
import { CopyIssueButton } from '../components/CopyIssue';
import { WorkCardEditor } from '../components/WorkCardEditor';
import { Modal } from '../components/Modal';
import { loadLocal, saveLocal, scopeKey, overdue, dueDate, finished } from '../lib/management';
import { useManagementData } from '../lib/useManagementData';
import { relativeTime } from '../lib/format';
import { CARD_LIMIT, CARD_TEMPLATES, cardFromLegacy, cardSummary, defaultCards, needsProjectIssues, newCard, selectCardIssues, validCards, validLegacyViews, type WorkCard } from '../lib/workCards';

export function MyWorkView(props: { projectKey: string | null; onOpen: (key: string) => void }) {
  const { me } = useSession();
  return <CardWorkbench key={scopeKey(me.jiraBaseUrl, me.name, props.projectKey)} {...props}/>;
}
function CardWorkbench({ projectKey, onOpen }: { projectKey: string | null; onOpen: (key: string) => void }) {
  const { me, toast } = useSession();
  const store = `wb.workCards.v2:${scopeKey(me.jiraBaseUrl, me.name, null)}`;
  const legacyStore = `wb.workCards.v1:${scopeKey(me.jiraBaseUrl, me.name, null)}`;
  const [cards, setCards] = useState(() => loadLocal(store, loadLocal(legacyStore, defaultCards(), validCards), validCards));
  const [library, setLibrary] = useState(false);
  const [editor, setEditor] = useState<WorkCard | null>(null);
  const [allId, setAllId] = useState<string | null>(null);
  const [resizing, setResizing] = useState<{ id: string; width: WorkCard['width']; height?: number } | null>(null);
  const dragId = useRef<string | null>(null);
  const resizeRef = useRef<{ id: string; x: number; y: number; width: number; height: number; colWidth: number } | null>(null);
  const latest = useRef({ cards, resizing }); latest.current = { cards, resizing };
  const everyone = needsProjectIssues(cards);
  const data = useManagementData(projectKey, everyone);
  useEffect(() => {
    if (resizing || allId || !data.data) return;
    const grid = document.querySelector<HTMLElement>('.workbench-grid'); if (!grid) return;
    let frame = 0;
    const align = () => {
      const cards = [...grid.querySelectorAll<HTMLElement>('.workbench-card')];
      cards.forEach(c => { if (!c.style.height) c.style.removeProperty('--row-height'); });
      if (window.innerWidth <= 1100) return;
      const rows = new Map<number, HTMLElement[]>();
      for (const card of cards) {
        if (card.style.height) continue;
        const top = Math.round(card.offsetTop); rows.set(top, [...(rows.get(top) ?? []), card]);
      }
      for (const row of rows.values()) {
        const height = Math.ceil(Math.max(...row.map(c => c.getBoundingClientRect().height)));
        row.forEach(c => c.style.setProperty('--row-height', `${height}px`));
      }
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(align); };
    schedule(); const observer = new ResizeObserver(schedule); observer.observe(grid);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [cards, data.data, resizing, allId]);
  const issues = data.data?.issues ?? [];
  const savedViews = loadLocal(`wb.workViews.v1:${scopeKey(me.jiraBaseUrl, me.name, projectKey)}:saved`, [], validLegacyViews);
  const atLimit = cards.length >= CARD_LIMIT;

  function persist(next: WorkCard[], message?: string) {
    if (!saveLocal(store, next)) { toast('无法保存卡片设置，请检查本机存储空间后重试', 'error'); return false; }
    setCards(next); if (message) toast(message);
    return true;
  }
  function saveCard(card: WorkCard) {
    if (!cards.some(c => c.id === card.id) && atLimit) { toast(`工作台最多放置 ${CARD_LIMIT} 张卡片`, 'error'); return; }
    const next = cards.some(c => c.id === card.id) ? cards.map(c => c.id === card.id ? card : c) : [...cards, card];
    if (persist(next)) setEditor(null);
  }
  function move(id: string, toId: string) {
    const next = [...cards], from = next.findIndex(c => c.id === id), to = next.findIndex(c => c.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    const [card] = next.splice(from, 1); next.splice(to, 0, card); persist(next);
  }
  useEffect(() => {
    if (!resizing) return;
    const move = (event: PointerEvent) => {
      const r = resizeRef.current; if (!r) return;
      const width = Math.max(1, Math.min(4, Math.round((r.width + event.clientX - r.x) / r.colWidth))) as WorkCard['width'];
      const height = Math.max(200, Math.min(900, Math.round((r.height + event.clientY - r.y) / 20) * 20));
      setResizing({ id: r.id, width, height });
    };
    const finish = () => {
      const r = resizeRef.current, value = latest.current.resizing; if (!r) return;
      resizeRef.current = null; setResizing(null);
      if (value) persist(latest.current.cards.map(c => c.id === value.id ? { ...c, width: value.width, height: value.height } : c));
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { resizeRef.current = null; setResizing(null); } };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); window.removeEventListener('keydown', key); };
  }, [resizing?.id]);

  const all = cards.find(c => c.id === allId);
  const hf = data.data?.hourFields;
  const listFor = (c: WorkCard) => hf ? selectCardIssues(issues, c, hf, me.name) : [];

  return <div className="card-workbench">
    <div className="workspace-intro"><div><h2>{all ? all.title : '把常看的任务清单，贴在这里。'}</h2><p>{all ? cardSummary(all) : '拖动标题调整位置，拖右下角调整大小，松手自动保存。'}</p></div><div className="workbench-actions">
      <button className="btn" disabled={data.loading} onClick={data.reload}>{data.loading ? '刷新中…' : '刷新'}</button>
      {all ? <><button className="btn" onClick={() => setEditor(all)}>编辑条件</button><button className="btn" onClick={() => setAllId(null)}>返回卡片工作台</button></> : <button className="btn primary" disabled={atLimit} onClick={() => setLibrary(true)}>＋ 添加卡片</button>}
    </div></div>
    {data.error && !data.data && <ErrorState error={data.error} onRetry={data.reload}/>}
    {data.data && <div className="workbench-context"><span><i className={`workbench-sync-dot${data.data.backgroundLoading ? ' active' : ''}`}/>{everyone ? '项目内所有人' : '与我相关'} · 未解决事项及近30天解决事项</span><span>{cards.length} / {CARD_LIMIT} 张卡片</span></div>}
    {data.data && <div className="workbench-sync" role="status"><span>{data.data.backgroundLoading ? '正在同步最新数据，已有内容可继续操作' : data.data.error ? '当前显示上次读取的数据，请重试同步' : data.data.provisional ? '首批数据已就绪，其余清单仍在补全' : '数据已同步'}</span><span>{data.data.issues.length} / {Math.min(1000, data.data.total)} 条{data.data.backgroundLoading ? ` · ${data.data.progress}%` : ''}</span>{data.data.backgroundLoading && <span className="workbench-sync-track" aria-hidden="true"><i style={{ transform: `scaleX(${data.data.progress / 100})` }}/></span>}</div>}
    {data.data?.provisional && data.data.issues.length > 0 && !data.data.backgroundLoading && <div className="management-notice">当前卡片基于首批或临时数据，最终统计仍在补全，请稍后刷新核对。</div>}
    {data.data?.error && <div className="management-notice" role="alert">{data.data.error.message} 当前结果可能不完整或不是最新，统计与导出以页面显示范围为准。<button className="btn small" onClick={data.reload}>重试同步</button></div>}
    {data.data && !data.data.backgroundLoading && data.data.total > issues.length && <div className="management-notice" role="status">共 {data.data.total} 项，当前仅加载前 {issues.length} 项；卡片数量、筛选与导出基于已加载结果。请在左上角选择具体项目缩小范围。</div>}
    {!data.data ? !data.error && <Loading rows={6}/> : all ? <>
      {all.view === 'blocked' && <div className="management-notice">仅显示未完成的入向 Blocks 依赖；需求下子项的父子链接不视为阻塞。</div>}
      {all.view === 'missing' && <div className="management-notice">检查开发人员、开发预估时间、开发完成/解决日期；未结束任务也可能缺完成日期。</div>}
      <ManagementTable key={all.id} issues={data.data?.error ? [] : listFor(all)} onOpen={onOpen} scope={`work-card:${projectKey ?? '*'}:${all.id}`} onChanged={data.reload}/>
    </> : <div className="workbench-grid" aria-busy={data.loading}>
      {cards.map((c, index) => {
        const list = listFor(c), visible = list.slice(0, c.limit), size = resizing?.id === c.id ? resizing : c;
        return <section className={`workbench-card${size.width === 4 ? ' wide' : ''}${size.height ? ' fixed-height' : ''}${resizing?.id === c.id ? ' resizing' : ''}`} key={c.id} aria-label={c.title} data-card-id={c.id} style={{ gridColumn: size.width === 4 ? '1/-1' : `span ${size.width}`, height: size.height }}
          onDragOver={e => { if (!resizing) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (dragId.current && !resizing) move(dragId.current, c.id); dragId.current = null; }}>
          <header className={`workbench-card-head accent-${index % 4}`} draggable onDragStart={e => {
            if ((e.target as HTMLElement).closest('[data-no-drag]')) { e.preventDefault(); return; }
            e.currentTarget.closest('.workbench-card')?.classList.add('is-dragging'); dragId.current = c.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.id);
          }} onDragEnd={e => { e.currentTarget.closest('.workbench-card')?.classList.remove('is-dragging'); dragId.current = null; }}>
            <div><h3>{c.title}<span className="workbench-count">{list.length}</span>{c.custom && <span className="workbench-custom">自定义</span>}</h3><p>{cardSummary(c)}</p></div>
            <button className="btn small ghost" data-no-drag aria-label={`配置${c.title}`} onClick={() => setEditor(c)}>配置</button>
          </header>
          <div className="workbench-card-items">{visible.map(i => <div className="workbench-task" key={i.key}><button className="workbench-task-open" onClick={() => onOpen(i.key)}><span className="workbench-task-title"><TypeBadge type={i.fields.issuetype.name}/><span>{i.fields.summary}</span></span><span className="workbench-task-meta"><span className="mono">{i.key}</span><StatusPill status={i.fields.status.name}/>{dueDate(i) && !finished(i) ? <span className={overdue(i) ? 'err' : ''}>{overdue(i) ? '已逾期 · ' : '到期 '}{dueDate(i)}</span> : <span>{relativeTime(i.fields.updated)}</span>}</span></button><CopyIssueButton issueKey={i.key} summary={i.fields.summary} className="workbench-copy"/></div>)}{!list.length && <div className="workbench-empty"><span aria-hidden="true">✓</span> 当前清单已清空</div>}</div>
          <footer className="workbench-card-foot"><span>显示 {visible.length} / {list.length} 条</span><div><button className="btn small ghost" onClick={() => setAllId(c.id)}>查看全部 →</button></div></footer>
          <button className="workbench-resize-handle" aria-label={`拖拽调整${c.title}大小，方向键也可调整`} onPointerDown={event => {
            if (event.button !== 0 || window.innerWidth < 1100 || resizing) return;
            event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
            const rect = event.currentTarget.closest('.workbench-card')!.getBoundingClientRect();
            const gridElement = event.currentTarget.closest('.workbench-grid')!, grid = gridElement.getBoundingClientRect();
            const gap = parseFloat(getComputedStyle(gridElement).columnGap) || 16;
            resizeRef.current = { id: c.id, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, colWidth: (grid.width + gap) / 4 };
            setResizing({ id: c.id, width: c.width, height: Math.max(200, rect.height) });
          }} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            const width = Math.max(1, Math.min(4, c.width + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0))) as WorkCard['width'];
            const height = Math.max(200, Math.min(900, (c.height ?? 400) + (event.key === 'ArrowUp' ? -20 : event.key === 'ArrowDown' ? 20 : 0)));
            persist(cards.map(x => x.id === c.id ? { ...x, width, height } : x));
          }}><span aria-hidden="true" /></button>
        </section>;
      })}
      <button className="workbench-add" disabled={atLimit} onClick={() => setLibrary(true)}><strong>＋ 再贴一张常用清单</strong><span>{atLimit ? `已达 ${CARD_LIMIT} 张上限` : '内置卡片 / 已保存视图 / 自定义条件'}</span></button>
    </div>}
    {library && <Modal title="添加到工作台" onClose={() => setLibrary(false)} width={740}>
      <div className="workbench-library">{CARD_TEMPLATES.map(t => <button key={t.name} className="workbench-template" onClick={() => { if (persist([...cards, newCard({ ...t.patch, title: t.name, custom: false })])) setLibrary(false); }}><strong>{t.name}</strong><span>{t.hint}</span></button>)}<button className="workbench-template custom" onClick={() => { setLibrary(false); setEditor(newCard()); }}><strong>＋ 自定义筛选卡片</strong><span>选择人员、类型、状态、版本和日期等条件</span></button></div>
      <h4>从已保存的工作视图添加</h4>{savedViews.length ? <div className="workbench-library">{savedViews.map(v => <button key={v.id} className="workbench-template" onClick={() => { if (persist([...cards, cardFromLegacy(v)])) setLibrary(false); }}><strong>{v.name}</strong><span>沿用原工作台保存的条件</span></button>)}</div> : <p className="muted">当前项目没有旧版已保存工作视图。你可以新建自定义卡片，条件会随卡片保存。</p>}
    </Modal>}
    {editor && hf && <WorkCardEditor card={editor} issues={issues} hourFields={hf} user={me.name} canPreviewAll={everyone} projectKey={projectKey} onSave={saveCard} onClose={() => setEditor(null)}/>}
  </div>;
}

/** 手上问题涉及的版本及条数，按条数倒序；未设置版本的放最后 */
export function versionCounts(issues: Issue[]): [string, number][] {
  const m = new Map<string, number>();
  let none = 0;
  for (const i of issues) {
    const names = versionNames(i.fields.versions);
    if (!names.length) none++;
    for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
  }
  const list = [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // 只有一种情况（全部同版本或全都没设）时不需要筛选
  if (list.length + (none ? 1 : 0) < 2) return [];
  return none ? [...list, [NO_VERSION, none]] : list;
}
