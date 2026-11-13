import type { Issue } from './types';
import type { HourFields } from './hours';
import { dueDate, matchesView, WORK_VIEWS, type WorkView } from './management';
import { stageOf, STAGES, type StageId } from './stages';
import { NO_VERSION, versionNames } from './versions';

export const CARD_LIMIT = 20;
export const CARD_WIDTHS = [1, 2, 3, 4] as const;
export type CardWidth = typeof CARD_WIDTHS[number];
export const clampCardWidth = (value: unknown): CardWidth => CARD_WIDTHS.includes(value as CardWidth) ? value as CardWidth : 2;
export const clampCardHeight = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(900, Math.max(200, value))) : undefined;
export const RELATIONS = { mine: '与我相关', assignee: '我经办的', developer: '我开发的', tester: '我测试的', all: '项目内所有人' };
export type Relation = keyof typeof RELATIONS;
export interface WorkCard {
  id: string;
  title: string;
  relation: Relation;
  stages: StageId[];
  types: string[];
  priority: string;
  version: string;
  text: string;
  view: WorkView | 'any' | 'due';
  dueFrom: string;
  dueTo: string;
  sort: 'updated' | 'due' | 'priority';
  limit: number;
  width: CardWidth;
  /** 手动高度；undefined 表示按内容自适应 */
  height?: number;
  hidden?: boolean;
  custom: boolean;
}
export function newCard(patch: Partial<WorkCard> = {}): WorkCard {
  return { id: crypto.randomUUID(), title: '自定义清单', relation: 'mine', stages: [], types: [], priority: '', version: '', text: '', view: 'active', dueFrom: '', dueTo: '', sort: 'updated', limit: 5, width: 2, custom: true, ...patch };
}
export const CARD_TEMPLATES: { name: string; hint: string; patch: Partial<WorkCard> }[] = [
  { name: '待处理', hint: '与我相关 · 尚未开始', patch: { stages: ['todo'] } },
  { name: '开发中', hint: '与我相关 · 研发阶段', patch: { stages: ['dev'] } },
  { name: '设计评审', hint: '与我相关 · 设计与评审', patch: { stages: ['design'] } },
  { name: '待测试 / 验收', hint: '与我相关 · 测试验证阶段', patch: { stages: ['test'] } },
  { name: '临期与逾期', hint: '未完成 · 3天内到期或已逾期', patch: { view: 'due', sort: 'due' } },
  ...(['today', 'blocked', 'stale', 'missing', 'orphan', 'recent', 'test'] as WorkView[]).map(view => ({ name: WORK_VIEWS[view], hint: '沿用现有工作视图判断规则', patch: { view } })),
];
export function defaultCards(): WorkCard[] {
  return [0, 1, 3, 4].map(index => { const t = CARD_TEMPLATES[index]; return newCard({ ...t.patch, title: t.name, custom: false }); });
}
export interface Note { id: string; text: string; color: 'yellow' | 'blue' | 'green'; pinned: boolean; updated: string }
export interface Todo { id: string; text: string; done: boolean; created: string; completed?: string }
export type WidgetKind = 'notes' | 'todos';
export type WorkbenchCard = WorkCard | { kind: 'widget'; widget: WidgetKind; id: string; title: string; width: CardWidth; height?: number; hidden?: boolean };
export function newWidget(widget: WidgetKind): WorkbenchCard { return { kind: 'widget', widget, id: crypto.randomUUID(), title: widget === 'notes' ? '便签' : '个人待办', width: 1 }; }
export const isWidget = (c: WorkbenchCard): c is Extract<WorkbenchCard, { kind: 'widget' }> => (c as { kind?: string }).kind === 'widget';
export function validWidget(c: unknown): boolean {
  if (!c || typeof c !== 'object') return false;
  const w = c as Record<string, unknown>;
  return w.kind === 'widget' && (w.widget === 'notes' || w.widget === 'todos') && typeof w.id === 'string' && !!w.id && typeof w.title === 'string' && !!w.title.trim() && w.title.length <= 40 && CARD_WIDTHS.includes(w.width as CardWidth) && (w.height === undefined || typeof w.height === 'number' && w.height >= 200 && w.height <= 900) && (w.hidden === undefined || typeof w.hidden === 'boolean');
}
/** 本机配置也做完整校验，避免旧格式或损坏数据造成页面崩溃。 */
export function validCards(value: unknown): value is WorkbenchCard[] {
  if (!Array.isArray(value) || value.length > CARD_LIMIT) return false;
  const ids = new Set<string>();
  return value.every(c => {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id || ids.has(c.id)) return false;
    ids.add(c.id);
    if (isWidget(c)) return validWidget(c);
    return typeof c.title === 'string' && !!c.title.trim() && c.title.length <= 40
      && Object.hasOwn(RELATIONS, c.relation)
      && Array.isArray(c.stages) && c.stages.every((s: unknown) => STAGES.some(stage => stage.id === s))
      && Array.isArray(c.types) && c.types.every((t: unknown) => typeof t === 'string')
      && ['priority', 'version', 'text', 'dueFrom', 'dueTo'].every(k => typeof c[k] === 'string')
      && (Object.hasOwn(WORK_VIEWS, c.view) || c.view === 'any' || c.view === 'due')
      && ['updated', 'due', 'priority'].includes(c.sort) && [3, 5, 8, 10].includes(c.limit)
      && CARD_WIDTHS.includes(c.width) && (c.height === undefined || (typeof c.height === 'number' && c.height >= 200 && c.height <= 900)) && typeof c.custom === 'boolean' && (c.hidden === undefined || typeof c.hidden === 'boolean');
  });
}
function userIs(value: unknown, user: string): boolean { return !!value && typeof value === 'object' && (value as { name?: string }).name === user; }
export function selectCardIssues(issues: Issue[], card: WorkCard, hf: HourFields, user: string, today?: string): Issue[] {
  return issues.filter(i => {
    const f = i.fields;
    const related = { assignee: userIs(f.assignee, user), developer: userIs(f.customfield_10204, user), tester: userIs(f.customfield_10401, user) };
    if (card.relation === 'mine' ? !Object.values(related).some(Boolean) : card.relation !== 'all' && !related[card.relation]) return false;
    if (card.stages.length && !card.stages.some(s => stageOf(f.status.name) === s)) return false;
    if (card.types.length && !card.types.includes(f.issuetype.name)) return false;
    if (card.priority && f.priority?.name !== card.priority) return false;
    if (card.version && (card.version === NO_VERSION ? versionNames(f.versions).length > 0 : !versionNames(f.versions).includes(card.version))) return false;
    if (card.text && !`${i.key} ${f.summary}`.toLowerCase().includes(card.text.trim().toLowerCase())) return false;
    const due = dueDate(i);
    if ((card.dueFrom && (!due || due < card.dueFrom)) || (card.dueTo && (!due || due > card.dueTo))) return false;
    if (card.view === 'due') return matchesView(i, 'overdue', hf, user, today) || matchesView(i, 'soon', hf, user, today);
    return card.view === 'any' || matchesView(i, card.view, hf, user, today);
  }).sort((a, b) => {
    if (card.sort === 'updated') return String(b.fields.updated ?? '').localeCompare(String(a.fields.updated ?? '')) || a.key.localeCompare(b.key);
    const av = card.sort === 'due' ? dueDate(a) : a.fields.priority?.id;
    const bv = card.sort === 'due' ? dueDate(b) : b.fields.priority?.id;
    if (!av || !bv) return av ? -1 : bv ? 1 : 0;
    return av.localeCompare(bv, undefined, { numeric: true }) || a.key.localeCompare(b.key);
  });
}
export function cardSummary(c: WorkCard): string {
  return [RELATIONS[c.relation], c.view === 'any' ? '全部状态（已解决项近30天）' : c.view === 'due' ? '3天内到期 / 已逾期' : WORK_VIEWS[c.view],
    ...c.stages.map(s => STAGES.find(stage => stage.id === s)!.name), ...c.types,
    c.priority, c.version === NO_VERSION ? '未设置版本' : c.version, c.text ? `包含“${c.text}”` : '',
    c.dueFrom ? `到期 ≥ ${c.dueFrom}` : '', c.dueTo ? `到期 ≤ ${c.dueTo}` : '',
  ].filter(Boolean).join(' · ');
}
export function needsProjectIssues(cards: WorkbenchCard[]): boolean { return cards.some(c => !isWidget(c) && c.relation === 'all'); }
export interface LegacyWorkView { id: string; name: string; prefs: { view: WorkView; text: string; version: string } }
export function validLegacyViews(value: unknown): value is LegacyWorkView[] {
  return Array.isArray(value) && value.every(v => v && typeof v.id === 'string' && typeof v.name === 'string' && !!v.name.trim() && v.prefs && Object.hasOwn(WORK_VIEWS, v.prefs.view) && typeof v.prefs.text === 'string' && typeof v.prefs.version === 'string');
}
export function cardFromLegacy(v: LegacyWorkView): WorkCard { return newCard({ title: v.name.slice(0, 40), ...v.prefs }); }
