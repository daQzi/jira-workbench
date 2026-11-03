// 项目筛选条件按项目记在本机 localStorage，切项目/刷新/重启后还原。
// 搜索关键字属于临时查找，不记忆。
import { DEFAULT_FILTER, type FilterState } from '../components/FilterBar';
import { STAGES, type StageId } from './stages';

const STORE = 'wb.filters.v1';
const STAGE_IDS = new Set<string>(STAGES.map((s) => s.id));

type KV = Pick<Storage, 'getItem' | 'setItem'>;
const storage = (): KV | null => (typeof localStorage === 'undefined' ? null : localStorage);

const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** 把存储里的任意值收敛成合法的 FilterState；未知阶段等脏数据直接丢弃 */
export function normalizeFilter(raw: unknown): FilterState {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    text: '',
    component: typeof r.component === 'string' ? r.component : '',
    version: typeof r.version === 'string' ? r.version : '',
    stages: strList(r.stages).filter((s): s is StageId => STAGE_IDS.has(s)),
    onlyMine: r.onlyMine === true,
    hideOldClosed: typeof r.hideOldClosed === 'boolean' ? r.hideOldClosed : DEFAULT_FILTER.hideOldClosed,
    types: strList(r.types),
  };
}

function readAll(kv: KV | null): Record<string, unknown> {
  try {
    const v = JSON.parse(kv?.getItem(STORE) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function loadFilter(project: string, kv: KV | null = storage()): FilterState {
  return normalizeFilter(readAll(kv)[project]);
}

export function saveFilter(project: string, f: FilterState, kv: KV | null = storage()) {
  if (!kv) return;
  const all = readAll(kv);
  const { text: _text, ...rest } = f;
  void _text;
  if (isDefaultFilter(f)) delete all[project];
  else all[project] = rest;
  try {
    kv.setItem(STORE, JSON.stringify(all));
  } catch {
    /* 存储已满或被禁用：只影响记忆，不影响筛选 */
  }
}

/** 是否等于默认条件（关键字也算在内），用于显示「清空筛选」 */
export function isDefaultFilter(f: FilterState): boolean {
  return (
    !f.text.trim() &&
    !f.component &&
    !f.version &&
    !f.stages.length &&
    !f.types.length &&
    f.onlyMine === DEFAULT_FILTER.onlyMine &&
    f.hideOldClosed === DEFAULT_FILTER.hideOldClosed
  );
}
