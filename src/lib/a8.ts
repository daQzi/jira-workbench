import { ymd } from './hours';

// A8 工时补全用到的纯函数：月份区间、工作日、草稿校验。

export function monthOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** 月份 → [本月 1 日, 本月最后一天] */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  return { from: `${month}-01`, to: ymd(new Date(y, m, 0)) };
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  return monthOf(new Date(y, m - 1 + delta, 1));
}

export function isWeekday(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(y, m - 1, d).getDay();
  return day !== 0 && day !== 6;
}

/** 区间内的工作日（升序） */
export function workdaysBetween(from: string, to: string): string[] {
  const [fy, fm, fd] = from.split('-').map(Number);
  const out: string[] = [];
  for (let d = new Date(fy, fm - 1, fd); ymd(d) <= to; d.setDate(d.getDate() + 1)) {
    const s = ymd(d);
    if (isWeekday(s)) out.push(s);
  }
  return out;
}

/** 缺失日期：A8 返回的未填日期里，落在区间内的部分（升序去重） */
export function missingDays(unfilled: string[], from: string, to: string): { date: string; weekend: boolean }[] {
  return [...new Set(unfilled)]
    .filter((d) => d >= from && d <= to && /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .map((date) => ({ date, weekend: !isWeekday(date) }));
}

export const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function weekdayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAY_LABEL[new Date(y, m - 1, d).getDay()];
}

export interface DraftEntry {
  activityDate: string;
  jobType: string;
  hours: number;
  description: string;
  jiraKeys: string[];
}

export const MAX_HOURS_PER_DAY = 12;

/** 单条草稿的问题；空数组表示可提交 */
export function entryProblems(entry: DraftEntry): string[] {
  const out: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.activityDate)) out.push('日期无效');
  if (!Number.isFinite(entry.hours) || entry.hours <= 0) out.push('工时需大于 0');
  else if (entry.hours > MAX_HOURS_PER_DAY) out.push(`工时不能超过 ${MAX_HOURS_PER_DAY}h`);
  else if (!Number.isInteger(entry.hours * 2)) out.push('工时需为 0.5 的整数倍');
  if (!entry.description.trim()) out.push('描述为空');
  else if (entry.description.trim().length < 8) out.push('描述过短');
  return out;
}

export function totalHours(entries: DraftEntry[]): number {
  return Math.round(entries.reduce((n, e) => n + (Number.isFinite(e.hours) ? e.hours : 0), 0) * 10) / 10;
}

/** 复制到 A8 手工填写 / 聊天工具时用的纯文本 */
export function entriesText(entries: DraftEntry[]): string {
  return entries
    .map((e) => `${e.activityDate} ${weekdayLabel(e.activityDate)}\t${e.jobType}\t${e.hours}h\t${e.description}`)
    .join('\n');
}
