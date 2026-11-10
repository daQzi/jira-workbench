import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTER } from '../components/FilterBar';
import { isDefaultFilter, loadFilter, normalizeFilter, saveFilter } from './filterPrefs';

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe('filterPrefs', () => {
  it('按项目保存与还原，不记关键字', () => {
    const kv = memory();
    saveFilter('A', { ...DEFAULT_FILTER, text: 'xx', stages: ['dev'], onlyMine: true }, kv);
    expect(loadFilter('A', kv)).toEqual({ ...DEFAULT_FILTER, stages: ['dev'], onlyMine: true });
    expect(loadFilter('B', kv)).toEqual(DEFAULT_FILTER);
  });

  it('恢复默认时删除该项目记录', () => {
    const kv = memory();
    saveFilter('A', { ...DEFAULT_FILTER, onlyMine: true }, kv);
    saveFilter('A', DEFAULT_FILTER, kv);
    expect(JSON.parse(kv.m.get('wb.filters.v1')!)).toEqual({});
  });

  it('脏数据收敛为合法值', () => {
    expect(normalizeFilter({ stages: ['dev', 'nope', 1], hideOldClosed: 'x', types: [3, '需求'] })).toEqual({
      ...DEFAULT_FILTER,
      stages: ['dev'],
      types: ['需求'],
    });
    expect(normalizeFilter(null)).toEqual(DEFAULT_FILTER);
    const kv = memory();
    kv.setItem('wb.filters.v1', '{bad json');
    expect(loadFilter('A', kv)).toEqual(DEFAULT_FILTER);
  });

  it('isDefaultFilter', () => {
    expect(isDefaultFilter(DEFAULT_FILTER)).toBe(true);
    expect(isDefaultFilter({ ...DEFAULT_FILTER, text: ' a ' })).toBe(false);
    expect(isDefaultFilter({ ...DEFAULT_FILTER, hideOldClosed: false })).toBe(false);
    expect(isDefaultFilter({ ...DEFAULT_FILTER, people: [{ name: 'alice', displayName: '小王' }] })).toBe(false);
  });

  it('按项目记住选中的人员，兼容旧筛选和清空操作', () => {
    const kv = memory();
    const people = [{ name: 'alice', displayName: '小王' }, { name: 'bob', displayName: '小李' }];
    saveFilter('A', { ...DEFAULT_FILTER, people }, kv);
    expect(loadFilter('A', kv)).toEqual({ ...DEFAULT_FILTER, people });
    expect(loadFilter('B', kv)).toEqual(DEFAULT_FILTER);
    expect(normalizeFilter({ onlyMine: true })).toEqual({ ...DEFAULT_FILTER, onlyMine: true });
    saveFilter('A', DEFAULT_FILTER, kv);
    expect(loadFilter('A', kv)).toEqual(DEFAULT_FILTER);
  });

  it('迁移旧单人筛选，排除无效账号并收敛互斥条件', () => {
    expect(normalizeFilter({ person: { name: ' alice ', displayName: ' 小王 ', emailAddress: 'private' }, onlyMine: true })).toEqual({
      ...DEFAULT_FILTER, people: [{ name: 'alice', displayName: '小王' }],
    });
    expect(normalizeFilter({ person: { name: 'alice', displayName: 1 } }).people).toEqual([{ name: 'alice', displayName: 'alice' }]);
    for (const person of [null, 'alice', { name: 1 }, { name: ' ' }]) {
      expect(normalizeFilter({ person, onlyMine: true })).toEqual({ ...DEFAULT_FILTER, onlyMine: true });
    }
  });
  it('多人去重清洗、清空与旧单人配置不会混用', () => {
    expect(normalizeFilter({ people: [{ name: ' alice ', displayName: '小王' }, { name: 'alice', displayName: ' 王同学 ' }, null, { name: 'bob' }, { name: '' }], onlyMine: true }).people).toEqual([{ name: 'alice', displayName: '王同学' }, { name: 'bob', displayName: 'bob' }]);
    expect(normalizeFilter({ people: [], person: { name: 'old' }, onlyMine: true })).toEqual({ ...DEFAULT_FILTER, onlyMine: true });
  });
});
