import { describe, expect, it } from 'vitest';
import { loadRecent, pushRecent, rememberIssue, RECENT_MAX } from './recent';

const item = (n: number) => ({ key: `A-${n}`, summary: `s${n}`, type: '需求', status: '新增' });

describe('recent', () => {
  it('去重置顶并限制条数', () => {
    let list = Array.from({ length: RECENT_MAX }, (_, i) => item(i));
    list = pushRecent(list, item(5));
    expect(list[0].key).toBe('A-5');
    expect(list.filter((x) => x.key === 'A-5')).toHaveLength(1);
    list = pushRecent(list, item(99));
    expect(list).toHaveLength(RECENT_MAX);
    expect(list[0].key).toBe('A-99');
  });

  it('读写 localStorage，坏数据返回空', () => {
    const m = new Map<string, string>();
    const kv = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    rememberIssue(item(1), kv);
    rememberIssue(item(2), kv);
    expect(loadRecent(kv).map((x) => x.key)).toEqual(['A-2', 'A-1']);
    m.set('wb.recent.v1', 'oops');
    expect(loadRecent(kv)).toEqual([]);
  });
});
