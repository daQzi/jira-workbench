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
  });
});
