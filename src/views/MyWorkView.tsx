import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { CARD_LIMIT, CARD_TEMPLATES, cardFromLegacy, cardSummary, defaultCards, isWidget, needsProjectIssues, newCard, newWidget, selectCardIssues, validCards, validLegacyViews, type WorkCard, type WorkbenchCard } from '../lib/workCards';
import { loadWorkbench, saveWorkbench, downloadBackup, readBackup } from '../lib/workbenchBackup';
import { useTools } from '../features/tools/useTools';
import { WidgetCard } from '../features/tools/WidgetCard';
import { resizeCard, resizeColumn } from '../features/workbench/resize';
import { useWorkbenchMotion } from '../features/scene/useWorkbenchMotion';
import { CardGrid } from '../features/workbench/CardGrid';

interface WorkbenchProps {
  projectKey: string | null;
  onOpen: (key: string) => void;
  cardId: string | null;
  onCardChange: (id: string | null) => void;
}
export function MyWorkView(props: WorkbenchProps) {
  const { me } = useSession();
  return <CardWorkbench key={scopeKey(me.jiraBaseUrl, me.name, props.projectKey)} {...props}/>;
}
function CardWorkbench({ projectKey, onOpen, cardId: allId, onCardChange }: WorkbenchProps) {
  const { me, toast } = useSession();
  const store = `wb.workCards.v2:${scopeKey(me.jiraBaseUrl, me.name, null)}`;
  const legacyStore = `wb.workCards.v1:${scopeKey(me.jiraBaseUrl, me.name, null)}`;
  const [cards, setCards] = useState<WorkbenchCard[]>(() => loadWorkbench(me.jiraBaseUrl, me.name).cards ?? loadLocal(legacyStore, defaultCards(), validCards));
  const tools = useTools();
  const [library, setLibrary] = useState(false);
  const [editor, setEditor] = useState<WorkCard | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  useEffect(() => { if (!menu) return; const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setMenu(null); } }; window.addEventListener('keydown', escape, true); return () => window.removeEventListener('keydown', escape, true); }, [menu]);
  useEffect(() => { setEditor(null); setLibrary(false); setHiddenOpen(false); setRemoving(null); setMenu(null); }, [projectKey]);
  const [removing, setRemoving] = useState<WorkbenchCard | null>(null);
  const [undo, setUndo] = useState<{ card: WorkbenchCard; index: number } | null>(null);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const reducedMotion = useWorkbenchMotion();
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(undoTimer.current), []);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollStore = `wb.workbench.scroll.v1:${scopeKey(me.jiraBaseUrl, me.name, projectKey)}`;
  const [initialScroll] = useState(() => {
    if (!allId) return 0;
    try { const top = Number(sessionStorage.getItem(scrollStore)); return Number.isFinite(top) && top > 0 ? top : 0; }
    catch { return 0; }
  });
  const gridScroll = useRef(initialScroll);
  const previousCard = useRef(allId);
  const currentCard = useRef(allId); currentCard.current = allId;
  const resizeRef = useRef<{ id: string; x: number; y: number; width: number; height: number; colWidth: number; widthSpan: WorkCard['width']; element: HTMLElement } | null>(null);
  const everyone = needsProjectIssues(cards);
  const data = useManagementData(projectKey, everyone);
  const issues = data.data?.issues ?? [];
  const savedViews = loadLocal(`wb.workViews.v1:${scopeKey(me.jiraBaseUrl, me.name, projectKey)}:saved`, [], validLegacyViews);
  const atLimit = cards.length >= CARD_LIMIT;

  const visibleCards = cards.filter(c => !('hidden' in c && c.hidden));
  const hiddenCards = cards.filter(c => 'hidden' in c && c.hidden);
  const all = cards.find(c => c.id === allId);
  function persist(next: WorkbenchCard[], message?: string) {
    if (!validCards(next)) { toast('卡片设置未通过校验，请检查后重试', 'error'); return false; }
    if (!saveLocal(store, next)) { toast('无法保存卡片设置，请检查本机存储空间后重试', 'error'); return false; }
    setCards(next); if (message) toast(message);
    return true;
  }
  function saveCard(card: WorkCard) {
    if (!cards.some(c => c.id === card.id) && atLimit) { toast(`工作台最多放置 ${CARD_LIMIT} 张卡片`, 'error'); return; }
    const next = cards.some(c => c.id === card.id) ? cards.map(c => c.id === card.id ? { ...c, ...card } : c) : [...cards, card];
    if (persist(next, '卡片已保存到本机')) setEditor(null);
  }
  function removeCard() {
    if (!removing) return;
    const index = cards.findIndex(c => c.id === removing.id); if (index < 0) return;
    if (!persist(cards.filter(c => c.id !== removing.id))) return;
    setUndo({ card: removing, index }); setRemoving(null); setMenu(null); onCardChange(null);
    clearTimeout(undoTimer.current); undoTimer.current = setTimeout(() => setUndo(null), 10000);
  }
  function restoreUndo() {
    if (!undo) return;
    const next = [...cards]; next.splice(Math.min(undo.index, next.length), 0, undo.card);
    if (persist(next, '已恢复卡片')) { setUndo(null); clearTimeout(undoTimer.current); }
  }
  function changeHidden(id: string, hidden: boolean) {
    const card = cards.find(c => c.id === id); if (!card) return;
    if (!hidden && visibleCards.length >= CARD_LIMIT) { toast(`工作台最多显示 ${CARD_LIMIT} 张卡片`, 'error'); return; }
    persist(cards.map(c => c.id === id ? { ...c, hidden } : c)); setMenu(null);
  }
  async function importBackup(file: File | undefined) {
    if (!file) return; setImporting(true);
    try {
      const backup = await readBackup(file);
      if (!saveWorkbench(me.jiraBaseUrl, me.name, backup.cards, backup.tools)) throw new Error('本机存储失败，备份尚未完整导入');
      setCards(backup.cards); tools.replace(backup.tools); setHiddenOpen(false); onCardChange(null); toast('已导入布局、便签与个人待办');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setImporting(false); if (importRef.current) importRef.current.value = ''; }
  }
  const dataReady = !!data.data;
  useEffect(() => {
    const content = rootRef.current?.closest('.content');
    if (!content) return;
    const remember = () => { if (!currentCard.current) gridScroll.current = content.scrollTop; };
    content.addEventListener('scroll', remember, { passive: true });
    return () => content.removeEventListener('scroll', remember);
  }, []);
  useLayoutEffect(() => {
    const content = rootRef.current?.closest('.content');
    if (!content || (!allId && !dataReady)) return;
    if (allId) {
      try { sessionStorage.setItem(scrollStore, String(gridScroll.current)); } catch { /* 会话记忆不可用时仍支持本次页面内返回 */ }
    }
    content.scrollTop = allId ? 0 : gridScroll.current;
    if (!allId && previousCard.current) {
      const origin = [...rootRef.current!.querySelectorAll<HTMLButtonElement>('[data-card-open]')].find(button => button.dataset.cardOpen === previousCard.current);
      origin?.focus({ preventScroll: true });
    }
    previousCard.current = allId;
  }, [allId, scrollStore, dataReady]);
  function openCard(id: string) {
    // 默认卡片的 ID 首次生成后也要落盘，否则刷新列表链接时会找不到原卡片。
    if (!persist(cards)) return;
    gridScroll.current = rootRef.current?.closest('.content')?.scrollTop ?? 0;
    onCardChange(id);
  }
  const hf = data.data?.hourFields;
  const listFor = (c: WorkCard) => hf ? selectCardIssues(issues, c, hf, me.name) : [];
  return <div className="card-workbench" ref={rootRef}><p id="workbench-drag-help" className="sr-only">按住标题拖动排序，松手保存；按空格或回车抓取卡片，方向键选择位置，再按空格或回车放下；Esc 取消。</p><span className="sr-only" role="status" aria-live="polite"></span>
    {all && <nav className="workbench-list-nav" aria-label="卡片列表导航"><button className="workbench-back" onClick={() => onCardChange(null)}>←<span>返回工作台</span></button></nav>}
    <div className="workspace-intro"><div><h2>{all && !isWidget(all) ? all.title : '把常看的任务清单，贴在这里。'}</h2><p>{all && !isWidget(all) ? cardSummary(all) : '按住标题拖动排序，其他卡片自动让位；拖右下角调整大小，松手自动保存。'}</p></div><div className="workbench-actions">
      <button className="btn" disabled={data.loading} onClick={data.reload}>{data.loading ? '刷新中…' : '刷新'}</button>
      {!all && <><button className="btn" onClick={() => setHiddenOpen(true)}>管理卡片{hiddenCards.length ? `（${hiddenCards.length}）` : ''}</button><button className="btn primary" disabled={atLimit} onClick={() => setLibrary(true)}>＋ 添加卡片</button></>}
    </div></div>
    {data.error && !data.data && <ErrorState error={data.error} onRetry={data.reload}/>}
    {data.data && <div className="workbench-context"><span><i className={`workbench-sync-dot${data.data.backgroundLoading ? ' active' : ''}`}/>{everyone ? '项目内所有人' : '与我相关'} · 未解决事项及近30天解决事项</span><span>{visibleCards.length} 张显示 / {cards.length} 张总计</span></div>}
    {data.data && <div className="workbench-sync" role="status"><span>{data.data.backgroundLoading ? '正在同步最新数据，已有内容可继续操作' : data.data.error ? '当前显示上次读取的数据，请重试同步' : data.data.provisional ? '首批数据已就绪，其余清单仍在补全' : '数据已同步'}</span><span>{data.data.issues.length} / {Math.min(1000, data.data.total)} 条{data.data.backgroundLoading ? ` · ${data.data.progress}%` : ''}</span>{data.data.backgroundLoading && <span className="workbench-sync-track" aria-hidden="true"><i style={{ transform: `scaleX(${data.data.progress / 100})` }}/></span>}</div>}
    {data.data?.provisional && data.data.issues.length > 0 && !data.data.backgroundLoading && <div className="management-notice">当前卡片基于首批或临时数据，最终统计仍在补全，请稍后刷新核对。</div>}
    {data.data?.error && <div className="management-notice" role="alert">{data.data.error.message} 当前结果可能不完整或不是最新，统计与导出以页面显示范围为准。<button className="btn small" onClick={data.reload}>重试同步</button></div>}
    {data.data && !data.data.backgroundLoading && data.data.total > issues.length && <div className="management-notice" role="status">共 {data.data.total} 项，当前仅加载前 {issues.length} 项；卡片数量、筛选与导出基于已加载结果。请在左上角选择具体项目缩小范围。</div>}
    {!data.data ? !data.error && <Loading rows={6}/> : <>
    {all && !isWidget(all) && <>
      {all.view === 'blocked' && <div className="management-notice">仅显示未完成的入向 Blocks 依赖；需求下子项的父子链接不视为阻塞。</div>}
      {all.view === 'missing' && <div className="management-notice">检查开发人员、开发预估时间、开发完成/解决日期；未结束任务也可能缺完成日期。</div>}
      <ManagementTable key={all.id} issues={data.data?.error ? [] : listFor(all)} onOpen={onOpen} scope={`work-card:${projectKey ?? '*'}:${all.id}`} onChanged={data.reload}/>
    </>}
    <div hidden={!!all}><div className="workbench-grid-wrap"><CardGrid cards={visibleCards} persist={persist} reduced={reducedMotion}>{(c, index, _active, handle, overlay) => {
        const widget = isWidget(c);
        const list = widget ? [] : listFor(c);
        const shown = widget ? 0 : !c.height ? list.length : Math.max(1, Math.min(c.limit, Math.floor((c.height - 96) / 64)));
        const visible = widget ? [] : list.slice(0, shown);
        return <><section className={`workbench-card-inner${widget ? ' widget-card' : ''}${c.width === 4 ? ' wide' : ''}${c.height ? ' fixed-height' : ''}`} key={c.id} aria-label={c.title} style={{ height: c.height }}>
          <header {...handle.attributes} {...handle.listeners} ref={handle.ref} className={`workbench-card-head accent-${index % 4}`} tabIndex={0}>
            <div><h3>{c.title}{!widget && <span className="workbench-count">{list.length}</span>}{!widget && c.custom && <span className="workbench-custom">自定义</span>}{widget && <span className="workbench-custom">本机组件</span>}</h3><p>{widget ? (c.widget === 'notes' ? '临时想法与提醒，仅保存在本机' : '个人清单，不创建 Jira 任务') : cardSummary(c)}</p></div>
            <div className="workbench-menu" data-no-drag hidden={overlay}><button className="btn small ghost workbench-more" aria-label={`更多操作：${c.title}`} aria-expanded={menu === c.id} aria-haspopup="menu" onClick={() => setMenu(menu === c.id ? null : c.id)}>•••</button>{menu === c.id && <div className="workbench-menu-list" role="menu">
              {!widget && <button role="menuitem" onClick={() => { setEditor(c); setMenu(null); }}>编辑条件</button>}
              {c.height && <button role="menuitem" onClick={() => { persist(cards.map(x => x.id === c.id ? { ...x, height: undefined } : x)); setMenu(null); }}>恢复自动高度</button>}
              <button role="menuitem" onClick={() => changeHidden(c.id, true)}>隐藏卡片</button>
              <button role="menuitem" className="danger" onClick={() => { setRemoving(c); setMenu(null); }}>删除卡片</button>
            </div>}</div>
          </header>
          {widget ? <WidgetCard kind={c.widget} data={tools.data} save={tools.save}/> : <>
          <div className="workbench-card-items">{visible.map(i => <div className="workbench-task" key={i.key}><button className="workbench-task-open" onClick={() => onOpen(i.key)}><span className="workbench-task-title"><TypeBadge type={i.fields.issuetype.name}/><span>{i.fields.summary}</span></span><span className="workbench-task-meta"><span className="mono">{i.key}</span><StatusPill status={i.fields.status.name}/>{dueDate(i) && !finished(i) ? <span className={overdue(i) ? 'err' : ''}>{overdue(i) ? '已逾期 · ' : '到期 '}{dueDate(i)}</span> : <span>{relativeTime(i.fields.updated)}</span>}</span></button><CopyIssueButton issueKey={i.key} summary={i.fields.summary} className="workbench-copy"/></div>)}{!list.length && <div className="workbench-empty"><span aria-hidden="true">✓</span> 当前清单已清空</div>}</div>
          <footer className="workbench-card-foot"><span>显示 {visible.length} / {list.length} 条</span><div><button className="btn small ghost" data-card-open={c.id} onClick={() => openCard(c.id)}>查看全部 →</button></div></footer></>}
          <button className="workbench-resize-handle" aria-label={`拖拽调整${c.title}大小，方向键也可调整`} onPointerDown={event => {
            if (event.button !== 0 || window.innerWidth < 1100 || resizeRef.current) return;
            event.preventDefault(); event.stopPropagation();
            const cardElement = event.currentTarget.closest<HTMLElement>('.workbench-card')!, rect = cardElement.getBoundingClientRect();
            const gridElement = event.currentTarget.closest('.workbench-grid')!, grid = gridElement.getBoundingClientRect();
            const gap = parseFloat(getComputedStyle(gridElement).columnGap) || 16;
            const start = { id: c.id, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, colWidth: (grid.width + gap) / 4, widthSpan: c.width, element: cardElement };
            resizeRef.current = start; cardElement.classList.add('resizing'); document.body.classList.add('is-card-resizing'); event.currentTarget.setPointerCapture(event.pointerId);
            let frame = 0, next = { width: c.width, height: Math.max(200, rect.height) }, lastHeight = next.height;
            const move = (moveEvent: PointerEvent) => {
              if (moveEvent.pointerId !== event.pointerId) return;
              const result = resizeCard(start, { x: moveEvent.clientX, y: moveEvent.clientY }), width = result.width, height = result.height;
              if (width === next.width && height === next.height) return;
              next = { width, height };
              if (height !== lastHeight) { lastHeight = height; cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { cardElement.style.height = `${height}px`; cardElement.style.gridColumn = resizeColumn(width); }); }
              else { cardElement.style.gridColumn = resizeColumn(width); }
            };
            const restore = () => { cardElement.style.height = c.height ? `${c.height}px` : ''; cardElement.style.gridColumn = resizeColumn(c.width); };
            const finish = (commit: boolean) => {
              cancelAnimationFrame(frame); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', escape, true);
              cardElement.classList.remove('resizing'); document.body.classList.remove('is-card-resizing'); resizeRef.current = null; restore();
              if (commit && (next.width !== c.width || next.height !== c.height)) persist(cards.map(x => x.id === c.id ? { ...x, width: next.width, height: next.height } : x));
            };
            const up = () => finish(true); const cancel = () => finish(false);
            const escape = (escapeEvent: KeyboardEvent) => { if (escapeEvent.key === 'Escape') { escapeEvent.preventDefault(); escapeEvent.stopPropagation(); finish(false); } };
            window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', escape, true);
          }} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            const width = Math.max(1, Math.min(4, c.width + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0))) as WorkCard['width'];
            const height = Math.max(200, Math.min(900, (c.height ?? 400) + (event.key === 'ArrowUp' ? -20 : event.key === 'ArrowDown' ? 20 : 0)));
            persist(cards.map(x => x.id === c.id ? { ...x, width, height } : x));
          }}><span aria-hidden="true" /></button>
        </section></>;
    }}</CardGrid><button className="workbench-add" disabled={atLimit} onClick={() => setLibrary(true)}><strong>＋ 再贴一张卡片</strong><span>{atLimit ? `已达 ${CARD_LIMIT} 张上限` : 'Jira 清单 / 本机便签 / 个人待办'}</span></button></div></div></>}
    {library && <Modal title="添加到工作台" onClose={() => setLibrary(false)} width={740}>
      <h4 className="workbench-library-heading">Jira 任务清单</h4>
      <div className="workbench-library">{CARD_TEMPLATES.map(t => <button key={t.name} className="workbench-template" onClick={() => { if (persist([...cards, newCard({ ...t.patch, title: t.name, custom: false })])) setLibrary(false); }}><strong>{t.name}</strong><span>{t.hint}</span></button>)}<button className="workbench-template custom" onClick={() => { setLibrary(false); setEditor(newCard()); }}><strong>＋ 自定义筛选卡片</strong><span>选择人员、类型、状态、版本和日期等条件</span></button></div>
      <h4>本机功能卡片</h4><div className="workbench-library"><button className="workbench-template" onClick={() => { if (persist([...cards, newWidget('notes')])) setLibrary(false); }}><strong>便签</strong><span>多条便签、颜色与置顶；不写 Jira</span></button><button className="workbench-template" onClick={() => { if (persist([...cards, newWidget('todos')])) setLibrary(false); }}><strong>个人待办</strong><span>本机清单、勾选完成；不写 Jira</span></button></div>
      <h4>从已保存的工作视图添加</h4>{savedViews.length ? <div className="workbench-library">{savedViews.map(v => <button key={v.id} className="workbench-template" onClick={() => { if (persist([...cards, cardFromLegacy(v)])) setLibrary(false); }}><strong>{v.name}</strong><span>沿用原工作台保存的条件</span></button>)}</div> : <p className="muted">当前项目没有旧版已保存工作视图。你可以新建自定义卡片，条件会随卡片保存。</p>}
    </Modal>}
    {editor && hf && <WorkCardEditor card={editor} issues={issues} hourFields={hf} user={me.name} canPreviewAll={everyone} projectKey={projectKey} onSave={saveCard} onClose={() => setEditor(null)}/>}
    {removing && <Modal title="删除本机卡片" onClose={() => setRemoving(null)} footer={<><button className="btn" onClick={() => setRemoving(null)}>取消</button><button className="btn danger-btn" onClick={removeCard}>删除卡片</button></>}><p>确定删除「{removing.title}」吗？仅删除本机卡片和布局，不会修改或删除 Jira 问题。删除后可立即撤销。</p></Modal>}
    {hiddenOpen && <Modal title="管理工作台卡片" onClose={() => setHiddenOpen(false)} width={700} footer={<><button className="btn" onClick={() => downloadBackup(cards, tools.data)}>导出备份</button><button className="btn" disabled={importing} onClick={() => importRef.current?.click()}>{importing ? '正在导入…' : '导入备份'}</button><input ref={importRef} className="sr-only" type="file" accept=".json,application/json" aria-label="选择工作台备份" onChange={e => importBackup(e.target.files?.[0])}/><button className="btn primary" onClick={() => setHiddenOpen(false)}>完成</button></>}>
      <p className="muted">隐藏只影响首页显示，仍保留筛选和布局。导入会替换当前账号的本机卡片、便签与待办，不包含 Jira 任务或登录信息。</p>
      <h4>显示中（{visibleCards.length}）</h4><div className="workbench-manage-list">{visibleCards.map(c => <div key={c.id}><span>{c.title}<small>{isWidget(c) ? '本机组件' : 'Jira 清单'}</small></span><button className="btn small" onClick={() => changeHidden(c.id, true)}>隐藏</button></div>)}</div>
      <h4>已隐藏（{hiddenCards.length}）</h4>{hiddenCards.length ? <div className="workbench-manage-list">{hiddenCards.map(c => <div key={c.id}><span>{c.title}<small>{isWidget(c) ? '本机组件' : 'Jira 清单'}</small></span><button className="btn small" onClick={() => changeHidden(c.id, false)}>恢复显示</button></div>)}</div> : <p className="muted">暂无隐藏卡片</p>}
    </Modal>}
    {undo && <div className="workbench-undo" role="status"><span>已删除「{undo.card.title}」</span><button className="btn small" onClick={restoreUndo}>撤销</button><button className="btn small ghost" aria-label="关闭撤销提示" onClick={() => { clearTimeout(undoTimer.current); setUndo(null); }}>×</button></div>}
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
