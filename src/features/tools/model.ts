import type { Note, Todo } from '../../lib/workCards';
export interface ToolData { notes: Note[]; todos: Todo[] }
export const defaultTools = (): ToolData => ({ notes: [], todos: [] });
const id = (x: unknown) => !!x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string' && !!(x as { id: string }).id;
export function validTools(x: unknown): x is ToolData {
  if (!x || typeof x !== 'object') return false;
  const d = x as ToolData;
  return Array.isArray(d.notes) && d.notes.length <= 100 && d.notes.every(n => id(n) && typeof n.text === 'string' && n.text.length <= 10000 && ['yellow', 'blue', 'green'].includes(n.color) && typeof n.pinned === 'boolean' && typeof n.updated === 'string')
    && Array.isArray(d.todos) && d.todos.length <= 200 && d.todos.every(t => id(t) && typeof t.text === 'string' && t.text.length <= 200 && typeof t.done === 'boolean' && typeof t.created === 'string' && (t.completed === undefined || typeof t.completed === 'string'));
}
export function formatTimestamp(input: string): string {
  const value = input.trim(); if (!value) throw new Error('请输入 Unix 时间戳（秒或毫秒）');
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error('时间戳只支持数字');
  const n = Number(value); if (!Number.isFinite(n)) throw new Error('时间戳超出范围');
  const ms = Math.abs(n) < 1e11 ? n * 1000 : n; const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) throw new Error('时间戳超出可转换范围');
  return `${date.toLocaleString('zh-CN', { hour12: false })}\nUTC：${date.toISOString()}`;
}
export function toTimestamp(input: string): number {
  if (!input.trim()) throw new Error('请选择日期时间');
  const ms = new Date(input).getTime(); if (!Number.isFinite(ms)) throw new Error('日期时间格式不正确'); return Math.floor(ms / 1000);
}
export function encodeBase64(input: string): string { return btoa(String.fromCharCode(...new TextEncoder().encode(input))); }
export function decodeBase64(input: string): string { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(input.trim()), c => c.charCodeAt(0))); }
export interface DiffLine { type: 'same' | 'add' | 'remove'; text: string }
/** 行级 LCS 对比，限制输入避免大文本占用界面。 */
export function diffLines(before: string, after: string): DiffLine[] {
  if (before.length + after.length > 100000) throw new Error('对比文本合计不能超过 10 万字符');
  const a = before.split('\n'), b = after.split('\n');
  if (a.length * b.length > 1_000_000) throw new Error('文本行数过多，请分段对比');
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = []; let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i++] }); j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: 'remove', text: a[i++] });
    else out.push({ type: 'add', text: b[j++] });
  }
  return [...out, ...a.slice(i).map(text => ({ type: 'remove' as const, text })), ...b.slice(j).map(text => ({ type: 'add' as const, text }))];
}
