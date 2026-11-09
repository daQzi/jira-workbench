import { loadLocal, saveLocal } from './management';
export const COLUMNS = { status: '状态', parent: '所属需求', assignee: '经办人', developer: '开发人员', version: '影响版本', priority: '优先级', due: '到期日', created: '创建时间', updated: '更新时间' };
export type Column = keyof typeof COLUMNS;
export type Sort = 'updated' | 'due' | 'priority' | 'key' | 'created';
export interface ListPrefs { columns: Column[]; widths: Partial<Record<Column | 'title', number>>; sort: Sort; direction: 'asc' | 'desc' }
export const DEFAULT_LIST: ListPrefs = { columns: ['status', 'parent', 'assignee', 'version', 'priority', 'due', 'updated'], widths: {}, sort: 'updated', direction: 'desc' };
export function normalizeList(raw: unknown): ListPrefs {
  const x = raw && typeof raw === 'object' ? raw as Partial<ListPrefs> : {};
  const columns = Array.isArray(x.columns) ? [...new Set(x.columns.filter((c): c is Column => typeof c === 'string' && Object.hasOwn(COLUMNS, c)))] : DEFAULT_LIST.columns;
  const widths: ListPrefs['widths'] = {};
  if (x.widths && typeof x.widths === 'object') for (const [k,v] of Object.entries(x.widths)) if ((k === 'title' || Object.hasOwn(COLUMNS,k)) && typeof v === 'number' && Number.isFinite(v)) widths[k as Column] = Math.min(700,Math.max(k === 'title' ? 240 : 90,v));
  return { columns, widths, sort: ['updated','due','priority','key','created'].includes(String(x.sort)) ? x.sort! : 'updated', direction: x.direction === 'asc' ? 'asc' : 'desc' };
}
export function readList(key: string) { return normalizeList(loadLocal<unknown>(key,null,(_): _ is unknown => true)); }
export function writeList(key: string, p: ListPrefs) { return saveLocal(key,p); }
