import type { CreateMetaType } from './api';
import { HIDDEN_CREATE_FIELDS } from './createPlan';
import { inputKind, toJiraValue, type FieldMetaMap, type FormValue } from './fields';
import { parseDuration, parseYmd, ymd, type HourFields } from './hours';

// 日报 → 任务草稿 → 创建计划。
// 大模型只给“建议”（标题、拆分、工时），这里用确定规则兜底：每条不超过上限、子项合计等于总工时、日期落在工作日。
// 校验不过的建议退回机械拆分并给出说明，不会原样提交。

export type HoursSource = 'input' | 'estimated' | 'missing';

/** 大模型（server/llm.mjs sanitizeDraft）返回的单条任务 */
export interface LlmTask {
  title: string;
  hours: number | null;
  hoursSource: 'input' | 'estimated';
  project: string | null;
  parentKey: string | null;
  /** 一线对接人（客户/现场联系人姓名），原文没写为 null */
  contact: string | null;
  sourceLine: string;
  subtasks: { title: string; hours: number | null }[];
}

export interface Piece {
  title: string;
  hours: number | null;
  date: string;
}

export interface DraftTask {
  id: string;
  title: string;
  project: string;
  parentKey: string | null;
  /** 一线对接人；空串 = 不填（有父需求时继承需求的值） */
  contact: string;
  hoursSource: HoursSource;
  source: 'llm' | 'rule';
  sourceLine: string;
  /** 实际要创建的条目；不拆分时只有一条 */
  pieces: Piece[];
  /** 规则兜底等说明，展示在预览里 */
  notes: string[];
}

export interface DraftOptions {
  date: string;
  defaultProject: string;
  maxHours: number;
  /** 拆出的多条从日报日期往前排（默认）还是往后排 */
  schedule: 'backward' | 'forward';
  hoursPerDay?: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const PROJECT_TAG_RE = /\[([A-Za-z][A-Za-z0-9]+)\]/;
// 一线对接人：必须写出「对接人」三个字，避免把「对接医保接口」这类描述误当人名
const CONTACT_RE = /[（(]?\s*(?:一线)?对接人\s*[:：]?\s*([\u4e00-\u9fa5·]{2,6}|[A-Za-z][A-Za-z .]{0,20}[A-Za-z])\s*[)）]?/;
// 工时片段：6h / 1.5d / 2d 4h / 30m / 4小时
const HOURS_RE = /(?:\d+(?:\.\d+)?\s*(?:w|周|d|天|h|小时|时|m|分钟|分)(?![A-Za-z])\s*)+/gi;
// 纯日期 / 标题行：2026-10-27、10月27日 日报、今日工作总结
const DATE_LINE_RE = /^[\s#*]*(?:\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}[-/.月]\d{1,2}日?)[\s:：]*(?:工作)?(?:日报|周[一二三四五六日天])?[\s:：]*$/;
const HEADER_RE = /^[\s#*]*(?:今日|今天|本日)?(?:工作)?(?:日报|总结|汇总|完成情况|工作内容)[\s:：]*$/;
let seq = 0;
const nextId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

/** 按上限机械切分：20h / 8 -> [8, 8, 4] */
export function mechanicalSplit(hours: number, max: number): number[] {
  if (!(hours > 0) || !(max > 0)) return [];
  const out: number[] = [];
  let left = round2(hours);
  while (left > max + 1e-9) {
    out.push(max);
    left = round2(left - max);
  }
  if (left > 0) out.push(left);
  return out;
}

const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/**
 * n 条依次落在的日期。backward：最后一条在日报当天，前面的往前排工作日；forward：从当天往后排。
 * 日报当天即使是周末也保留（加班），其余跳过周末。
 */
export function scheduleDates(date: string, n: number, mode: DraftOptions['schedule']): string[] {
  const anchor = parseYmd(date);
  const out = [anchor];
  let cur = anchor;
  const step = mode === 'backward' ? -1 : 1;
  while (out.length < n) {
    cur = addDays(cur, step);
    if (!isWeekend(cur)) out.push(cur);
  }
  return (mode === 'backward' ? out.reverse() : out).map(ymd);
}

const clip = (s: string, max = 200) => (s.length > max ? s.slice(0, max) : s);

function piecesFor(title: string, hours: number | null, parts: { title: string; hours: number }[] | null, o: DraftOptions): Piece[] {
  if (hours === null) return [{ title: clip(title), hours: null, date: o.date }];
  const list =
    parts ??
    mechanicalSplit(hours, o.maxHours).map((h, i, all) => ({ title: all.length > 1 ? `${title}（${i + 1}/${all.length}）` : title, hours: h }));
  const dates = scheduleDates(o.date, list.length, o.schedule);
  return list.map((p, i) => ({ title: clip(p.title), hours: p.hours, date: dates[i] }));
}

/** 校验大模型给的子任务；不合规时返回原因 */
export function checkSubtasks(hours: number, subs: { title: string; hours: number | null }[], max: number): string | null {
  if (subs.some((s) => s.hours === null)) return '子任务缺少工时';
  if (subs.some((s) => (s.hours as number) > max + 1e-9)) return `子任务超过 ${max}h`;
  const sum = round2(subs.reduce((a, s) => a + (s.hours as number), 0));
  if (Math.abs(sum - hours) > 0.01) return `子任务合计 ${sum}h 与总工时 ${hours}h 不一致`;
  return null;
}

/** 大模型结果 → 草稿（带规则校验与兜底） */
export function draftsFromLlm(tasks: LlmTask[], o: DraftOptions): DraftTask[] {
  return tasks.map((t) => {
    const notes: string[] = [];
    const hours = t.hours !== null && t.hours > 0 ? round2(t.hours) : null;
    let parts: { title: string; hours: number }[] | null = null;
    if (hours !== null && hours > o.maxHours) {
      const bad = t.subtasks.length < 2 ? '未给出拆分' : checkSubtasks(hours, t.subtasks, o.maxHours);
      if (bad) notes.push(`大模型拆分不合规（${bad}），已按 ${o.maxHours}h 机械拆分`);
      else parts = t.subtasks.map((s) => ({ title: `${t.title}-${s.title}`, hours: round2(s.hours as number) }));
    }
    if (hours === null) notes.push('没有工时，请补充');
    return {
      id: nextId(),
      title: clip(t.title),
      project: (t.project || (t.parentKey ? t.parentKey.split('-')[0] : '') || o.defaultProject).toUpperCase(),
      parentKey: t.parentKey,
      contact: t.contact ?? '',
      hoursSource: hours === null ? 'missing' : t.hoursSource,
      source: 'llm',
      sourceLine: t.sourceLine,
      pieces: piecesFor(t.title, hours, parts, o),
      notes,
    };
  });
}

/** 不用大模型时的规则解析：每行一个任务，工时写在行内（6h / 0.5d），可带 #ABC-12 父需求、[ABC] 项目 */
export function parseDailyRules(text: string, o: DraftOptions): DraftTask[] {
  const out: DraftTask[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || DATE_LINE_RE.test(line) || HEADER_RE.test(line)) continue;
    let rest = line.replace(/^\s*(?:[-*•·]|\d+[.、)]|[（(]\d+[)）])\s*/, '');
    const keyM = rest.match(KEY_RE);
    const parentKey = keyM ? keyM[1] : null;
    if (keyM) rest = rest.replace(new RegExp(`#?${keyM[1]}`), ' ');
    const projM = rest.match(PROJECT_TAG_RE);
    if (projM) rest = rest.replace(projM[0], ' ');
    const contactM = rest.match(CONTACT_RE);
    if (contactM) rest = rest.replace(contactM[0], ' ');
    let hours: number | null = null;
    if (/半天/.test(rest)) {
      hours = (o.hoursPerDay ?? 8) / 2;
      rest = rest.replace(/[（(]?\s*半天\s*[)）]?/, ' ');
    } else {
      // 取最后一个工时片段（标题里可能有数字，工时一般写在行尾）
      const ms = [...rest.matchAll(HOURS_RE)];
      const m = ms[ms.length - 1];
      if (m) {
        hours = parseDuration(m[0], o.hoursPerDay ?? 8);
        rest = rest.slice(0, m.index) + ' ' + rest.slice((m.index ?? 0) + m[0].length);
      }
    }
    const title = rest
      .replace(/[（(]\s*[)）]/g, '')
      .replace(/\s*(?:耗时|用时|工时)[:：]?\s*$/, '')
      .replace(/[\s,，;；:：、]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) continue;
    out.push({
      id: nextId(),
      title: clip(title),
      project: (projM?.[1] || (parentKey ? parentKey.split('-')[0] : '') || o.defaultProject).toUpperCase(),
      parentKey,
      contact: contactM?.[1].trim() ?? '',
      hoursSource: hours === null ? 'missing' : 'input',
      source: 'rule',
      sourceLine: line,
      pieces: piecesFor(title, hours, null, o),
      notes: hours === null ? ['没有识别到工时，请补充'] : [],
    });
  }
  return out;
}

/** 预览里改了总工时 / 点“重新拆分”时，按上限机械重排 */
export function resplit(t: DraftTask, hours: number | null, o: DraftOptions): DraftTask {
  const src: HoursSource = hours === null ? 'missing' : t.hoursSource === 'missing' ? 'input' : t.hoursSource;
  return { ...t, hoursSource: src, pieces: piecesFor(t.title, hours, null, o), notes: [] };
}

export const taskHours = (t: DraftTask) => round2(t.pieces.reduce((a, p) => a + (p.hours ?? 0), 0));

/** 阻止提交的问题（预览里标红） */
export function taskErrors(t: DraftTask, max: number): string[] {
  const errs: string[] = [];
  if (!t.title.trim()) errs.push('标题为空');
  if (!t.project) errs.push('未选项目');
  t.pieces.forEach((p, i) => {
    const label = t.pieces.length > 1 ? `第 ${i + 1} 条` : '';
    if (!p.title.trim()) errs.push(`${label}标题为空`);
    if (p.hours === null || !(p.hours > 0)) errs.push(`${label}缺少工时`);
    else if (p.hours > max + 1e-9) errs.push(`${label}超过 ${max}h`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) errs.push(`${label}日期无效`);
  });
  return errs;
}

/** 同一天合计超过每日工时只提示，不拦截（加班是真实情况） */
export function dailyTotals(tasks: DraftTask[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const t of tasks) for (const p of t.pieces) if (p.hours) m[p.date] = round2((m[p.date] ?? 0) + p.hours);
  return m;
}

export interface FieldSlots {
  estimate?: string;
  devStart?: string;
  devDone?: string;
  developer?: string;
  /** 一线对接人字段 id；该项目+类型没有这个字段时为空（如 YLZHXT 的编码任务） */
  contact?: string;
  timetracking?: boolean;
}

export const DEVELOPER_FIELD = 'customfield_10204';
/** 一线对接人：单行文本字段（不是用户选择器），填的是客户方/现场联系人姓名 */
export const CONTACT_FIELD = 'customfield_11201';

/** 该项目+类型里能落工时统计的字段（同名字段在不同项目是不同 id） */
export function fieldSlots(type: CreateMetaType, hf: HourFields): FieldSlots {
  const pick = (ids: string[]) => ids.find((id) => type.fields[id]);
  return {
    estimate: pick(hf.estimate),
    devStart: pick(hf.devStart),
    devDone: pick(hf.devDone),
    developer: type.fields[DEVELOPER_FIELD] ? DEVELOPER_FIELD : undefined,
    contact: type.fields[CONTACT_FIELD] ? CONTACT_FIELD : undefined,
    timetracking: !!type.fields.timetracking,
  };
}

/** 统计会漏算的情况，提示在预览里 */
export function slotWarnings(s: FieldSlots): string[] {
  const w: string[] = [];
  if (!s.estimate) w.push('没有「开发预估时间」字段，工时统计不会计入');
  if (!s.devDone) w.push('没有「开发完成日期」字段，默认口径下按解决日期计入，需完成（关闭）后才统计');
  if (!s.developer) w.push('没有「开发人员」字段，默认口径下不会计入');
  return w;
}

export const formatH = (h: number) => `${round2(h)}h`;

/** 单条的表单值：标题、经办人/开发人员=我、开发预估时间、开始/完成日期=当天、一线对接人 */
export function pieceValues(s: FieldSlots, me: string, piece: Piece, hasAssignee: boolean, contact = ''): Record<string, FormValue> {
  const v: Record<string, FormValue> = { summary: piece.title.trim() };
  if (s.contact && contact.trim()) v[s.contact] = contact.trim();
  if (hasAssignee) v.assignee = me;
  if (s.developer) v[s.developer] = me;
  if (piece.hours) {
    if (s.estimate) v[s.estimate] = formatH(piece.hours);
    else if (s.timetracking) v.timetracking = formatH(piece.hours);
  }
  if (s.devStart) v[s.devStart] = piece.date;
  if (s.devDone) v[s.devDone] = piece.date;
  return v;
}

// ---------- 提交前的必填检查 ----------

/** 还缺的必填字段 id（已填值和继承值都算有值）；不支持的字段单列，需去 Jira 处理 */
export function missingRequired(meta: FieldMetaMap, values: Record<string, FormValue | undefined>, inherited: Record<string, unknown> = {}) {
  const missing: string[] = [];
  const unsupported: string[] = [];
  for (const [id, m] of Object.entries(meta)) {
    if (!m.required || HIDDEN_CREATE_FIELDS.includes(id) || inherited[id] !== undefined) continue;
    if (!inputKind(id, m)) unsupported.push(id);
    else if (toJiraValue(id, m, values[id]) === undefined) missing.push(id);
  }
  return { missing, unsupported };
}
