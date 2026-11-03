import { parentOf } from './tree';
import type { FieldDef, Issue } from './types';

// 个人工时统计。数据来源（已在本 Jira 实测）：
// - 实际登记工时（worklog/timespent）几乎没人填，主要数据是各项目的「开发预估时间 / 预估时间」文本字段（如 6h、0.5d）
// - 同名字段在不同项目是不同的 customfield，按名称收集候选 id，取第一个有值的

export type Measure = 'estimate' | 'spent';
export type Basis = 'devDone' | 'devStart' | 'created' | 'updated';
export type Granularity = 'day' | 'week' | 'month';

export const BASIS_LABEL: Record<Basis, string> = {
  devDone: '开发完成日期',
  devStart: '开始开发日期',
  created: '创建时间',
  updated: '更新时间',
};
export const MEASURE_LABEL: Record<Measure, string> = { estimate: '开发预估时间', spent: 'Jira 登记工时' };

export interface HourFields {
  estimate: string[];
  devStart: string[];
  devDone: string[];
}

const NAMES = {
  estimate: ['开发预估时间', '预估时间'],
  devStart: ['开始开发日期'],
  devDone: ['开发完成日期'],
};

/** 按字段名收集各项目的候选 customfield id；名称靠前的优先 */
export function resolveHourFields(defs: FieldDef[]): HourFields {
  const pick = (names: string[], type: string) =>
    names.flatMap((n) => defs.filter((d) => d.custom && d.name === n && (!d.schema || d.schema.type === type)).map((d) => d.id));
  return {
    estimate: pick(NAMES.estimate, 'string'),
    devStart: pick(NAMES.devStart, 'date'),
    devDone: pick(NAMES.devDone, 'date'),
  };
}

const UNIT_RE = /(\d+(?:\.\d+)?)\s*(w|周|d|天|h|小时|时|m|分钟|分)?/gi;

/** "2d 4h" / "0.5d" / "6h" / "30m" / "4小时" / "4" → 小时；无法解析返回 null */
export function parseDuration(text: unknown, hoursPerDay = 8, daysPerWeek = 5): number | null {
  if (typeof text !== 'string' && typeof text !== 'number') return null;
  const s = String(text).trim();
  if (!s) return null;
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(UNIT_RE)) {
    const n = Number(m[1]);
    const u = (m[2] ?? 'h').toLowerCase();
    matched = true;
    if (u === 'w' || u === '周') total += n * hoursPerDay * daysPerWeek;
    else if (u === 'd' || u === '天') total += n * hoursPerDay;
    else if (u === 'm' || u === '分钟' || u === '分') total += n / 60;
    else total += n;
  }
  // 剩余部分若含其他非空白字符，视为无法识别，避免把 "约3天左右" 之类误算
  const rest = s.replace(UNIT_RE, '').replace(/[\s,，+]/g, '');
  return matched && !rest ? Math.round(total * 100) / 100 : null;
}

function firstValue(issue: Issue, ids: string[]): unknown {
  for (const id of ids) {
    const v = issue.fields[id];
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return undefined;
}

export interface HourSettings {
  measure: Measure;
  basis: Basis;
  hoursPerDay: number;
}

export function hoursOf(issue: Issue, f: HourFields, s: HourSettings): number | null {
  if (s.measure === 'spent') {
    const sec = issue.fields.timespent;
    return typeof sec === 'number' && sec > 0 ? Math.round((sec / 3600) * 100) / 100 : null;
  }
  return parseDuration(firstValue(issue, f.estimate), s.hoursPerDay);
}

/** 统计口径对应的日期（YYYY-MM-DD，本地时区） */
export function dateOf(issue: Issue, f: HourFields, basis: Basis): string | null {
  const raw =
    basis === 'created'
      ? issue.fields.created
      : basis === 'updated'
        ? issue.fields.updated
        : // 部分类型（如 YLZHXT 其他任务）没有开发完成日期字段，按解决日期兜底
          (firstValue(issue, f[basis]) ?? (basis === 'devDone' ? issue.fields.resolutiondate : undefined));
  if (typeof raw !== 'string' || !raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : ymd(d);
}

// ---------- 日期与区间 ----------

const p2 = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));

export type RangePreset = 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth' | 'last30' | 'last90' | 'thisYear' | 'custom';
export const RANGE_LABEL: Record<RangePreset, string> = {
  thisWeek: '本周', lastWeek: '上周', thisMonth: '本月', lastMonth: '上月',
  last30: '近 30 天', last90: '近 90 天', thisYear: '今年', custom: '自定义',
};

export function presetRange(p: RangePreset, now = new Date(), custom?: { from: string; to: string }): { from: string; to: string } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (p) {
    case 'thisWeek': {
      const m = mondayOf(today);
      return { from: ymd(m), to: ymd(addDays(m, 6)) };
    }
    case 'lastWeek': {
      const m = addDays(mondayOf(today), -7);
      return { from: ymd(m), to: ymd(addDays(m, 6)) };
    }
    case 'thisMonth':
      return { from: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), to: ymd(new Date(today.getFullYear(), today.getMonth() + 1, 0)) };
    case 'lastMonth':
      return { from: ymd(new Date(today.getFullYear(), today.getMonth() - 1, 1)), to: ymd(new Date(today.getFullYear(), today.getMonth(), 0)) };
    case 'last30':
      return { from: ymd(addDays(today, -29)), to: ymd(today) };
    case 'last90':
      return { from: ymd(addDays(today, -89)), to: ymd(today) };
    case 'thisYear':
      return { from: `${today.getFullYear()}-01-01`, to: `${today.getFullYear()}-12-31` };
    case 'custom':
      return custom ?? { from: ymd(addDays(today, -29)), to: ymd(today) };
  }
}

export interface Period {
  key: string;
  label: string;
  from: string;
  to: string;
}

export function periodKey(date: string, g: Granularity): string {
  if (g === 'day') return date;
  if (g === 'month') return date.slice(0, 7);
  return ymd(mondayOf(parseYmd(date)));
}

/** 区间内全部周期（含没有数据的），用于画连续的趋势 */
export function periodsBetween(from: string, to: string, g: Granularity): Period[] {
  const out: Period[] = [];
  const end = parseYmd(to);
  let cur = g === 'week' ? mondayOf(parseYmd(from)) : g === 'month' ? new Date(parseYmd(from).getFullYear(), parseYmd(from).getMonth(), 1) : parseYmd(from);
  for (let guard = 0; cur <= end && guard < 400; guard++) {
    let next: Date;
    let label: string;
    if (g === 'day') {
      next = addDays(cur, 1);
      label = `${cur.getMonth() + 1}/${cur.getDate()}`;
    } else if (g === 'week') {
      next = addDays(cur, 7);
      label = `${cur.getMonth() + 1}/${cur.getDate()} 周`;
    } else {
      next = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      label = `${cur.getFullYear() % 100}年${cur.getMonth() + 1}月`;
    }
    out.push({ key: periodKey(ymd(cur), g), label, from: ymd(cur), to: ymd(addDays(next, -1)) });
    cur = next;
  }
  return out;
}

// ---------- 父子汇总 ----------

export interface HourItem {
  issue: Issue;
  hours: number | null;
  date: string | null;
  period: string | null;
}

export interface HourRow {
  key: string;
  summary: string;
  typeName: string;
  status?: string;
  /** 行本身是否在统计结果里（父需求可能只是因为子项被带出来） */
  own: HourItem | null;
  children: HourItem[];
  /** 计入合计的工时：有子项时只算子项，避免与需求自身预估重复 */
  total: number;
  byPeriod: Record<string, number>;
}

export interface HourReport {
  rows: HourRow[];
  total: number;
  byPeriod: Record<string, number>;
  counted: number;
  /** 有日期但没有工时的问题数 */
  noHours: number;
}

const add = (m: Record<string, number>, k: string | null, v: number) => {
  if (k) m[k] = Math.round(((m[k] ?? 0) + v) * 100) / 100;
};

/**
 * 按父需求分组。规则：
 * - 子项（编码任务等）挂到其父需求下；父需求不在结果里时用链接里的摘要补一行
 * - 需求本身也在结果里且有子项时，需求自身的预估只展示、不计入合计（子项已拆分）
 */
export function buildReport(items: HourItem[]): HourReport {
  const rows = new Map<string, HourRow>();
  const order: string[] = [];
  const rowFor = (key: string, summary: string, typeName: string, status?: string) => {
    let r = rows.get(key);
    if (!r) {
      r = { key, summary, typeName, status, own: null, children: [], total: 0, byPeriod: {} };
      rows.set(key, r);
      order.push(key);
    }
    return r;
  };
  for (const it of items) {
    const parent = parentOf(it.issue);
    if (parent) {
      rowFor(parent.key, parent.fields.summary, parent.fields.issuetype.name, parent.fields.status.name).children.push(it);
    } else {
      const f = it.issue.fields;
      const r = rowFor(it.issue.key, f.summary, f.issuetype.name, f.status.name);
      r.own = it;
      r.summary = f.summary;
    }
  }
  const report: HourReport = { rows: [], total: 0, byPeriod: {}, counted: 0, noHours: 0 };
  for (const key of order) {
    const r = rows.get(key)!;
    const counted = r.children.length ? r.children : r.own ? [r.own] : [];
    for (const it of counted) {
      if (it.hours === null) {
        report.noHours++;
        continue;
      }
      r.total = Math.round((r.total + it.hours) * 100) / 100;
      add(r.byPeriod, it.period, it.hours);
      add(report.byPeriod, it.period, it.hours);
      report.counted++;
    }
    report.total = Math.round((report.total + r.total) * 100) / 100;
    r.children.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    report.rows.push(r);
  }
  report.rows.sort((a, b) => b.total - a.total);
  return report;
}

export function formatHours(h: number | null | undefined, hoursPerDay = 8, unit: 'h' | 'd' = 'h'): string {
  if (h === null || h === undefined) return '-';
  if (unit === 'd') return `${Math.round((h / hoursPerDay) * 100) / 100}d`;
  return `${Math.round(h * 10) / 10}h`;
}
