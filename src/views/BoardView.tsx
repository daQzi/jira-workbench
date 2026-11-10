import { useMemo, useRef, useState } from 'react';
import { api, type Transition } from '../lib/api';
import { boardQuery, BOARD_FRESH_MS } from '../lib/board';
import { useBoardData } from '../lib/useBoardData';
import { BoardStatistics } from '../components/BoardStatistics';
import { STAGES, stageOf, type Stage, type StageId } from '../lib/stages';
import { parentOf } from '../lib/tree';
import { relativeTime, userName } from '../lib/format';
import { useSession } from '../lib/session';
import { useTransition } from '../lib/useTransition';
import type { Issue, SearchResult } from '../lib/types';
import { Priority, StatusPill, TypeBadge, VersionTags } from '../components/Badges';
import { Modal } from '../components/Modal';
import { ErrorState, Loading } from '../components/States';
import type { FilterState } from '../components/FilterBar';

interface Props {
  projectKey: string;
  filter: FilterState;
  onOpen: (key: string) => void;
}

interface DragState {
  issue: Issue;
  /** null = 正在加载可用流转 */
  transitions: Transition[] | null;
  error?: string;
}

/** 按目标阶段对流转分组 */
export function transitionsByStage(list: Transition[]): Map<StageId, Transition[]> {
  const m = new Map<StageId, Transition[]>();
  for (const t of list) {
    const st = stageOf(t.to.name);
    if (!st) continue;
    m.set(st, [...(m.get(st) ?? []), t]);
  }
  return m;
}

export function BoardView({ projectKey, filter, onOpen }: Props) {
  const { version, bump, canWriteProject, toast, me } = useSession();
  const writable = canWriteProject(projectKey);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [over, setOver] = useState<StageId | null>(null);
  const [choose, setChoose] = useState<{ issue: Issue; options: Transition[] } | null>(null);
  const { run, dialog } = useTransition(bump);
  // 拖动开始即请求可用流转；放下时等待这个请求，避免快速拖放被误拒
  const pendingTransitions = useRef<{ key: string; promise: Promise<Transition[]> } | null>(null);

  // 阶段筛选在看板里决定显示哪些列
  const columns = useMemo(
    () => (filter.stages.length ? STAGES.filter((s) => filter.stages.includes(s.id)) : STAGES),
    [filter.stages],
  );
  const namespace = `${me.jiraBaseUrl}:${me.name}`;
  const preferenceKey = `wb.board.statistics:${namespace}:${projectKey}`;
  const initialOpen = () => { try { return localStorage.getItem(preferenceKey) !== 'closed'; } catch { return true; } };
  const [preference, setPreference] = useState(() => ({ key: preferenceKey, open: initialOpen() }));
  if (preference.key !== preferenceKey) setPreference({ key: preferenceKey, open: initialOpen() });
  const statsOpen = preference.key === preferenceKey ? preference.open : initialOpen();
  const { snapshot, refresh, retryColumn } = useBoardData(projectKey, filter, namespace, version, statsOpen);
  const loading = snapshot.checking || columns.some(col => snapshot.columns[col.id]?.loading);
  const times = columns.map(col => snapshot.columns[col.id]?.result?.fetchedAt).filter((time): time is number => !!time);
  const loadedAt = times.length ? Math.min(...times) : 0;
  const stale = snapshot.checking || loading || !loadedAt || Date.now() - loadedAt >= BOARD_FRESH_MS || !!snapshot.error || columns.some(col => snapshot.columns[col.id]?.error);
  const scope = `${namespace}:${projectKey}`;

  const byStage = drag?.transitions ? transitionsByStage(drag.transitions) : null;

  function startDrag(issue: Issue) {
    setDrag({ issue, transitions: null });
    const promise = api.transitions(issue.key);
    pendingTransitions.current = { key: issue.key, promise };
    promise.then(
      (t) => setDrag((d) => (d?.issue.key === issue.key ? { ...d, transitions: t } : d)),
      (e: Error) => setDrag((d) => (d?.issue.key === issue.key ? { ...d, transitions: [], error: e.message } : d)),
    );
  }

  async function drop(stage: Stage) {
    const d = drag;
    const pending = pendingTransitions.current;
    setDrag(null);
    setOver(null);
    if (!d || !pending || pending.key !== d.issue.key) return;
    let list: Transition[];
    try {
      list = await pending.promise;
    } catch (e) {
      return toast(`获取流转失败：${(e as Error).message}`, 'error');
    }
    const options = transitionsByStage(list).get(stage.id) ?? [];
    if (!options.length) {
      // 拖回原列视为取消
      if (stageOf(d.issue.fields.status.name) === stage.id) return;
      return toast(`${d.issue.key} 当前状态「${d.issue.fields.status.name}」不能直接流转到「${stage.name}」`, 'error');
    }
    if (options.length === 1) return start(d.issue, options[0]);
    setChoose({ issue: d.issue, options });
  }

  function start(issue: Issue, t: Transition) {
    run({ key: issue.key, summary: issue.fields.summary, status: issue.fields.status.name, current: issue.fields }, t);
  }


  return (
    <>
      <div className="board-sync" role="status"><span>{loading ? (loadedAt ? '正在核对最新数据…' : '正在加载看板…') : snapshot.error ? '同步失败，当前结果可能不是最新' : loadedAt ? `上次更新 ${new Date(loadedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '等待加载'}{!loading && loadedAt > 0 && Date.now() - loadedAt >= BOARD_FRESH_MS ? ' · 缓存结果' : ''}</span><button className="btn small" disabled={loading || !!snapshot.stats?.loading} onClick={refresh}>{loading ? '同步中…' : '刷新看板与统计'}</button></div>
      {snapshot.error && <ErrorState error={new Error(snapshot.error)} onRetry={refresh}/>}
      <BoardStatistics key={boardQuery(projectKey, filter)} data={snapshot.stats} open={statsOpen} scope={scope} stale={stale} onOpen={onOpen} onRetry={refresh} onToggle={() => { const open = !statsOpen; setPreference({ key: preferenceKey, open }); try { localStorage.setItem(preferenceKey, open ? 'open' : 'closed'); } catch { /* 不影响统计 */ } }}/>
      {writable && <p className="board-tip muted">拖动卡片到其他列即可流转，只有工作流允许的列会高亮；需要补充字段时会弹窗。</p>}
      <div className={`board${drag ? ' dragging' : ''}`} >
        {columns.map((col, i) => {
          const allowed = byStage?.get(col.id)?.length ?? 0;
          const state = !drag ? '' : !byStage ? 'pending' : allowed ? 'allowed' : 'blocked';
          return (
            <Column
              key={col.id}
              stage={col}
              result={snapshot.columns[col.id]?.result}
              loading={!!snapshot.columns[col.id]?.loading || snapshot.checking}
              error={snapshot.columns[col.id]?.error}
              onRetry={retryColumn}
              delay={i}
              onOpen={onOpen}
              draggable={writable && !stale}
              dropState={state}
              isOver={over === col.id}
              draggingKey={drag?.issue.key}
              onDragStart={startDrag}
              onDragEnd={() => {
                // drop 先于 dragend 触发；这里只清理未落到列上的拖动
                setDrag(null);
                setOver(null);
              }}
              onDragOver={() => setOver(col.id)}
              onDrop={() => drop(col)}
            />
          );
        })}
      </div>
      {choose && (
        <Modal title={`选择目标状态 · ${choose.issue.key}`} onClose={() => setChoose(null)} width={420}>
          <div className="link-list">
            {choose.options.map((t) => (
              <button
                key={t.id}
                className="link-item"
                onClick={() => {
                  setChoose(null);
                  start(choose.issue, t);
                }}
              >
                <span className="summary">{t.name}</span>
                <StatusPill status={t.to.name} />
              </button>
            ))}
          </div>
        </Modal>
      )}
      {dialog}
    </>
  );
}

interface ColumnProps {
  stage: Stage;
  result?: SearchResult;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  delay: number;
  onOpen: (k: string) => void;
  draggable: boolean;
  dropState: '' | 'pending' | 'allowed' | 'blocked';
  isOver: boolean;
  draggingKey?: string;
  onDragStart: (issue: Issue) => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onDrop: () => void;
}

function Column({ stage, result, loading, error, onRetry, delay, onOpen, draggable, dropState, isOver, draggingKey, onDragStart, onDragEnd, onDragOver, onDrop }: ColumnProps) {
  return (
    <section
      className={`column${dropState ? ` drop-${dropState}` : ''}${isOver ? ' over' : ''}`}
      style={{ animationDelay: `${delay * 60}ms` }}
      aria-label={stage.name}
      onDragOver={(e) => {
        if (!draggingKey) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = dropState === 'blocked' ? 'none' : 'move';
        onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      <header className="column-head">
        <h3 className={`stage-${stage.id}`}>
          <span style={{ color: 'var(--ink)' }}>{stage.name}</span>
        </h3>
        <span className="count">{result?.total ?? (error ? '!' : '…')}</span>
      </header>
      <div className="column-body">
        {error && <div className="board-column-error" role="alert">{error}<button className="text-btn" onClick={onRetry}>重试此列</button></div>}
        {loading && <p className="board-column-loading muted">{result ? '正在同步…' : '加载中…'}</p>}
        {!result && loading && <Loading rows={3}/>}
        {result?.issues.map((issue) => {
          const f = issue.fields;
          const parent = parentOf(issue);
          return (
            <button
              key={issue.key}
              className={`card t-${f.issuetype.name}${draggingKey === issue.key ? ' is-dragging' : ''}`}
              onClick={() => onOpen(issue.key)}
              draggable={draggable}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', issue.key);
                onDragStart(issue);
              }}
              onDragEnd={onDragEnd}
            >
              <span className="card-top">
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <TypeBadge type={f.issuetype.name} />
                  <span className="mono muted">{issue.key}</span>
                </span>
                <span className="card-status muted">{f.status.name}</span>
              </span>
              <span className="card-summary" data-full-text={f.summary}>{f.summary}</span>
              {parent && (
                <span className="card-parent" data-full-text={`${parent.key} ${parent.fields.summary}`}>
                  ↳ {parent.key} {parent.fields.summary}
                </span>
              )}
              <span className="card-foot">
                <span className="card-who">
                  {userName(f.assignee) || '未分配'}
                  <VersionTags versions={f.versions} max={1} empty={null} />
                </span>
                <span style={{ display: 'flex', gap: 8 }}>
                  <Priority name={f.priority?.name} />
                  <span>{relativeTime(f.updated)}</span>
                </span>
              </span>
            </button>
          );
        })}
        {result && result.total > result.issues.length && (
          <div className="column-more">仅显示前 {result.issues.length} 条，请用筛选缩小范围</div>
        )}
      </div>
    </section>
  );
}
