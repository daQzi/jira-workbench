import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { FilterState } from '../components/FilterBar';
import { BOARD_FIELDS, BOARD_FRESH_MS, BOARD_LIMIT, BOARD_STALE_MS, boardQuery } from './board';
import { STAGES, type StageId } from './stages';
import type { Issue, SearchResult } from './types';

export interface BoardColumn { result?: SearchResult; loading?: boolean; error?: string }
export interface BoardStats { issues: Issue[]; total: number; fetchedAt: number; complete: boolean; error?: string; loading?: boolean }
interface Snapshot { key: string; project: string; namespace: string; revision: string; columns: Partial<Record<StageId, BoardColumn>>; stats?: BoardStats; checking: boolean; error?: string; statsRefresh?: boolean }
const memory = new Map<string, Snapshot>();
const STORE = 'wb.board.snapshots.v1';
let cacheGeneration = 0;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
function validIssue(i: Issue) { return i && typeof i.key === 'string' && typeof i.fields?.summary === 'string' && typeof i.fields.status?.name === 'string' && typeof i.fields.issuetype?.name === 'string'; }
function validSnapshot(value: Snapshot) {
  return value && typeof value.key === 'string' && typeof value.revision === 'string' && typeof value.project === 'string' && typeof value.namespace === 'string'
    && value.columns && Object.values(value.columns).every(c => c && (!c.result || (Number.isFinite(c.result.total) && Array.isArray(c.result.issues) && c.result.issues.every(validIssue))))
    && (!value.stats || (Number.isFinite(value.stats.total) && Array.isArray(value.stats.issues) && value.stats.issues.every(validIssue)));
}
function remember(value: Snapshot) {
  memory.delete(value.key); memory.set(value.key, value);
  while (memory.size > 8) memory.delete(memory.keys().next().value!);
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistSnapshots, 250);
}
function persistSnapshots() {
  clearTimeout(persistTimer); persistTimer = undefined;
  try {
    const saved = [...memory.values()].map(v => ({ ...v, checking: false, columns: Object.fromEntries(Object.entries(v.columns).map(([id, c]) => [id, { result: c?.result }])), stats: !v.statsRefresh && v.stats && !v.stats.loading && !v.stats.error ? v.stats : undefined }));
    while (JSON.stringify(saved).length > 1_000_000) saved.shift();
    sessionStorage.setItem(STORE, JSON.stringify(saved));
  } catch { /* 只影响下次恢复，当前内存缓存仍然有效 */ }
}
export function clearBoardCaches() { cacheGeneration++; clearTimeout(persistTimer); memory.clear(); try { sessionStorage.removeItem(STORE); } catch { /* 存储不可用 */ } }
if (typeof window !== 'undefined') { window.addEventListener('wb-session-ended', clearBoardCaches); window.addEventListener('pagehide', persistSnapshots); }
function read(key: string, project: string, namespace: string): Snapshot {
  if (!memory.size) {
    try { const saved: unknown = JSON.parse(sessionStorage.getItem(STORE) || '[]'); if (Array.isArray(saved)) for (const value of saved) if (validSnapshot(value)) memory.set(value.key, value); } catch { /* 无可用快照 */ }
  }
  const value = memory.get(key);
  if (value) {
    const columns = Object.fromEntries(Object.entries(value.columns).filter(([, c]) => c?.result && Date.now() - (c.result.fetchedAt || 0) < BOARD_STALE_MS).map(([id, c]) => [id, { result: c?.result }]));
    return { ...value, columns, stats: !value.statsRefresh && value.stats && Date.now() - value.stats.fetchedAt < BOARD_STALE_MS ? value.stats : undefined, checking: true, error: undefined };
  }
  return { key, project, namespace, revision: '', columns: {}, checking: true };
}
function invalidateProject(project: string, namespace: string) {
  for (const [key, value] of memory) if (value.project === project && value.namespace === namespace) memory.delete(key);
  try { sessionStorage.removeItem(STORE); } catch { /* 内存已失效 */ }
}

/** 展示按范围隔离的快照；本机修订号先校验，列独立更新，统计在首屏之后串行补齐。 */
export function useBoardData(project: string, filter: FilterState, namespace: string, version: number, statsOpen: boolean) {
  const jql = boardQuery(project, filter);
  const key = JSON.stringify([namespace, project, jql]);
  const stageKey = (filter.stages.length ? filter.stages : STAGES.map(s => s.id)).slice().sort().join(',');
  const [snapshot, setSnapshot] = useState(() => read(key, project, namespace));
  if (snapshot.key !== key) setSnapshot(read(key, project, namespace));
  // React updater 保持纯函数；序列化合并到交互之后，避免逐列/逐页阻塞渲染。
  useEffect(() => { remember(snapshot); }, [snapshot]);
  const current = useRef(snapshot); current.current = snapshot;
  const [nonce, setNonce] = useState(0);
  const forceNext = useRef(false);
  const lastVersion = useRef(version);
  const refresh = useCallback(() => { invalidateProject(project, namespace); forceNext.current = true; setNonce(n => n + 1); }, [project, namespace]);

  useEffect(() => {
    const ctrl = new AbortController();
    const generation = cacheGeneration;
    let force = forceNext.current || lastVersion.current !== version;
    forceNext.current = false; lastVersion.current = version;
    const ids = stageKey.split(',') as StageId[];
    const update = (fn: (s: Snapshot) => Snapshot) => {
      if (ctrl.signal.aborted || generation !== cacheGeneration) return;
      setSnapshot(s => { if (ctrl.signal.aborted || generation !== cacheGeneration || s.key !== key) return s; return fn(s); });
    };
    update(s => ({ ...s, checking: true, error: undefined, statsRefresh: s.statsRefresh || force }));
    (async () => {
      if (!force) await pause(300, ctrl.signal);
      const { revision } = await api.cacheStatus(project, ctrl.signal);
      if (typeof revision !== 'string') throw new Error('无法读取看板缓存状态，请更新并重启本地代理');
      if (ctrl.signal.aborted) return;
      const old = current.current;
      if (old.revision && old.revision !== revision) {
        force = true; invalidateProject(project, namespace);
        update(s => ({ ...s, columns: {}, stats: undefined, revision, statsRefresh: true }));
      } else update(s => ({ ...s, revision, statsRefresh: s.statsRefresh || force }));
      const wanted = ids.filter(id => force || !!old.columns[id]?.error || !old.columns[id]?.result || Date.now() - (old.columns[id]!.result!.fetchedAt || 0) >= BOARD_FRESH_MS);
      update(s => ({ ...s, checking: false, columns: { ...s.columns, ...Object.fromEntries(wanted.map(id => [id, { ...s.columns[id], loading: true, error: undefined }])) } }));
      await Promise.allSettled(wanted.map(async id => {
        try {
          const result = await api.search(boardQuery(project, filter, [id]), { fields: BOARD_FIELDS, maxResults: 60, refresh: force || !!old.columns[id]?.error }, ctrl.signal);
          update(s => ({ ...s, columns: { ...s.columns, [id]: { result } } }));
        } catch (error) {
          update(s => ({ ...s, columns: { ...s.columns, [id]: { ...s.columns[id], loading: false, error: (error as Error).message } } }));
        }
      }));
    })().catch((error: Error) => update(s => ({ ...s, checking: false, error: error.message })));
    let focusedAt = Date.now();
    const focus = () => { if (!document.hidden && Date.now() - focusedAt > 1500) { focusedAt = Date.now(); setNonce(n => n + 1); } };
    window.addEventListener('focus', focus);
    return () => { ctrl.abort(); window.removeEventListener('focus', focus); };
    // jql 是查询身份；同名人员的显示名不改变查询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, stageKey, project, namespace, version, nonce]);

  const ready = snapshot.key === key && !snapshot.checking && !snapshot.error && stageKey.split(',').every(id => {
    const column = snapshot.columns[id as StageId]; return column && !column.loading && (!!column.result || !!column.error);
  });
  useEffect(() => {
    if (!statsOpen || !ready) return;
    if (!current.current.statsRefresh && (current.current.stats?.complete || (current.current.stats?.issues.length || 0) >= BOARD_LIMIT) && !current.current.stats?.error && Date.now() - (current.current.stats?.fetchedAt || 0) < BOARD_FRESH_MS) return;
    const ctrl = new AbortController();
    const generation = cacheGeneration;
    const update = (fn: (s: Snapshot) => Snapshot) => {
      if (!ctrl.signal.aborted && generation === cacheGeneration) setSnapshot(s => { if (ctrl.signal.aborted || generation !== cacheGeneration || s.key !== key) return s; return fn(s); });
    };
    const revision = current.current.revision;
    const refreshStats = !!current.current.statsRefresh;
    update(s => ({ ...s, stats: { issues: [], total: 0, fetchedAt: 0, complete: false, ...s.stats, loading: true, error: undefined } }));
    (async () => {
      const cached = current.current.stats;
      const resume = cached && !refreshStats && !cached.error && !cached.complete && Date.now() - cached.fetchedAt < BOARD_FRESH_MS;
      const issues = new Map<string, Issue>(resume ? cached.issues.map(i => [i.key, i]) : []);
      let total = resume ? cached.total : 0, startAt = issues.size, fetchedAt = resume ? cached.fetchedAt : 0;
      while (startAt < BOARD_LIMIT) {
        const page = await api.search(jql, { fields: BOARD_FIELDS, startAt, maxResults: Math.min(100, BOARD_LIMIT - startAt), refresh: refreshStats, background: true }, ctrl.signal);
        total = page.total;
        for (const issue of page.issues) issues.set(issue.key, issue);
        startAt += page.issues.length;
        const done = startAt >= total;
        if (!page.issues.length && !done) throw new Error('Jira 分页提前结束，请重新同步');
        fetchedAt = Math.min(fetchedAt || Infinity, page.fetchedAt || Date.now());
        if (done || startAt >= BOARD_LIMIT) {
          const status = await api.cacheStatus(project, ctrl.signal);
          if (status.revision !== revision) throw new Error('读取期间事项已变更，请刷新统计');
          if (done && issues.size !== total) throw new Error('分页期间数据发生变化，统计未完整，请刷新');
        }
        const stats: BoardStats = { issues: [...issues.values()], total, fetchedAt, complete: done && issues.size === total, loading: !done && startAt < BOARD_LIMIT };
        update(s => ({ ...s, stats, statsRefresh: stats.loading ? s.statsRefresh : false }));
        if (done || startAt >= BOARD_LIMIT) break;
        await pause(100, ctrl.signal);
        ctrl.signal.throwIfAborted();
      }
    })().catch((error: Error) => update(s => ({ ...s, stats: { issues: [], total: 0, fetchedAt: 0, complete: false, ...s.stats, loading: false, error: error.message } })));
    return () => {
      ctrl.abort();
      setSnapshot(s => s.key === key && s.stats?.loading ? { ...s, stats: { ...s.stats, loading: false } } : s);
    };
  }, [key, jql, project, statsOpen, ready, nonce, version]);
  return { snapshot: snapshot.key === key ? snapshot : read(key, project, namespace), refresh, retryColumn: () => setNonce(n => n + 1), ready };
}
