// 版本（Jira「影响版本」versions 字段）：本 Jira 的项目都用影响版本做迭代，修复版本基本为空
import type { Version } from './types';

/** 筛选值：空串 = 不限，NO_VERSION = 未设置版本，其他 = 版本名 */
export const NO_VERSION = '__none__';

const DAY = 86400000;

const byDate = (a: Version, b: Version) => (a.releaseDate || '9999').localeCompare(b.releaseDate || '9999');

/**
 * 快捷版本：未发布、未归档的版本，按发布日期排序，优先最近要发的（含过期不超过 14 天的）。
 * 没有日期的排在最后；最多 limit 个。
 */
export function quickVersions(all: Version[] | undefined, limit = 4, now = Date.now()): Version[] {
  const open = (all ?? []).filter((v) => !v.released && !v.archived).sort(byDate);
  const from = new Date(now - 14 * DAY).toISOString().slice(0, 10);
  const soon = open.filter((v) => v.releaseDate && v.releaseDate >= from);
  const rest = open.filter((v) => !soon.includes(v));
  return [...soon, ...rest].slice(0, limit);
}

/** 下拉分组：未发布（按日期）/ 已发布 / 已归档（都按日期倒序） */
export function versionGroups(all: Version[] | undefined): { label: string; items: Version[] }[] {
  const list = all ?? [];
  const desc = (a: Version, b: Version) => byDate(b, a);
  return [
    { label: '未发布', items: list.filter((v) => !v.released && !v.archived).sort(byDate) },
    { label: '已发布', items: list.filter((v) => v.released && !v.archived).sort(desc) },
    { label: '已归档', items: list.filter((v) => v.archived).sort(desc) },
  ].filter((g) => g.items.length);
}

/** 版本筛选在当前项目里是否还有效（版本被删除/改名后忽略记忆的值） */
export function isValidVersion(value: string, all: Version[] | undefined): boolean {
  return !value || value === NO_VERSION || !!all?.some((v) => v.name === value);
}

/** 发布日期短格式 MM-DD；没有或格式异常时返回空串 */
export function shortDate(d?: string): string {
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(5) : '';
}

/** 问题上的版本名 */
export function versionNames(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((v) => (v as { name?: string })?.name).filter((n): n is string => !!n) : [];
}
