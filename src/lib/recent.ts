// 最近打开过的问题（本机 localStorage），给 ⌘K 跳转面板用。
const STORE = 'wb.recent.v1';
export const RECENT_MAX = 12;

export interface RecentIssue {
  key: string;
  summary: string;
  type: string;
  status: string;
}

type KV = Pick<Storage, 'getItem' | 'setItem'>;
const storage = (): KV | null => (typeof localStorage === 'undefined' ? null : localStorage);

export function loadRecent(kv: KV | null = storage()): RecentIssue[] {
  try {
    const v = JSON.parse(kv?.getItem(STORE) || '[]');
    if (!Array.isArray(v)) return [];
    return v
      .filter((x) => x && typeof x.key === 'string' && typeof x.summary === 'string')
      .map((x) => ({ key: x.key, summary: x.summary, type: String(x.type ?? ''), status: String(x.status ?? '') }))
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** 放到最前并去重，超出上限的丢掉 */
export function pushRecent(list: RecentIssue[], item: RecentIssue): RecentIssue[] {
  return [item, ...list.filter((x) => x.key !== item.key)].slice(0, RECENT_MAX);
}

export function rememberIssue(item: RecentIssue, kv: KV | null = storage()) {
  if (!kv) return;
  try {
    kv.setItem(STORE, JSON.stringify(pushRecent(loadRecent(kv), item)));
  } catch {
    /* 存储不可用时只是没有「最近查看」 */
  }
}
