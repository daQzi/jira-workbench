import { describe, expect, it } from 'vitest';
import type { Version } from './types';
import { isValidVersion, NO_VERSION, quickVersions, shortDate, versionGroups, versionNames } from './versions';
import { buildJql } from './jql';
import { normalizeFilter } from './filterPrefs';
import { versionCounts } from '../views/MyWorkView';
import type { Issue } from './types';

const v = (name: string, extra: Partial<Version> = {}): Version => ({ id: name, name, ...extra });
const NOW = Date.parse('2026-10-27T08:00:00Z');

describe('versions', () => {
  const all = [
    v('v2.0.3.9', { releaseDate: '2026-09-30' }),
    v('v2.0.3.10', { releaseDate: '2026-10-31' }),
    v('v2.0.3.10（补丁）', { releaseDate: '2026-11-04' }),
    v('v2.0.3.11', { releaseDate: '2026-11-30' }),
    v('智能体v1.1'),
    v('旧版', { released: true, archived: true, releaseDate: '2026-03-01' }),
    v('已发', { released: true, releaseDate: '2026-10-01' }),
  ];

  it('快捷版本：最近要发的未发布版本优先，过期太久和无日期的靠后', () => {
    expect(quickVersions(all, 3, NOW).map((x) => x.name)).toEqual(['v2.0.3.10', 'v2.0.3.10（补丁）', 'v2.0.3.11']);
    expect(quickVersions(all, 10, NOW).map((x) => x.name)).toEqual([
      'v2.0.3.10', 'v2.0.3.10（补丁）', 'v2.0.3.11', 'v2.0.3.9', '智能体v1.1',
    ]);
    expect(quickVersions(undefined)).toEqual([]);
  });

  it('下拉分组', () => {
    const g = versionGroups(all);
    expect(g.map((x) => x.label)).toEqual(['未发布', '已发布', '已归档']);
    expect(g[0].items[0].name).toBe('v2.0.3.9');
    expect(g[0].items.at(-1)!.name).toBe('智能体v1.1');
  });

  it('JQL：版本名转义，未设置走 is EMPTY', () => {
    expect(buildJql({ project: 'A', version: 'v2"x' }, '')).toBe('project = "A" AND affectedVersion = "v2\\"x"');
    expect(buildJql({ version: NO_VERSION }, '')).toBe('affectedVersion is EMPTY');
  });

  it('记忆的版本失效时忽略', () => {
    expect(isValidVersion('', all)).toBe(true);
    expect(isValidVersion(NO_VERSION, undefined)).toBe(true);
    expect(isValidVersion('v2.0.3.10', all)).toBe(true);
    expect(isValidVersion('不存在', all)).toBe(false);
    expect(normalizeFilter({ version: 3 }).version).toBe('');
    expect(normalizeFilter({ version: 'v1' }).version).toBe('v1');
  });

  it('工具函数', () => {
    expect(shortDate('2026-10-31')).toBe('10-31');
    expect(shortDate('bad')).toBe('');
    expect(versionNames([{ name: 'a' }, {}, null])).toEqual(['a']);
    expect(versionNames(undefined)).toEqual([]);
  });

  it('工作台版本统计', () => {
    const issue = (names: string[]) => ({ fields: { versions: names.map((name) => ({ name })) } }) as unknown as Issue;
    expect(versionCounts([issue(['a']), issue(['a'])])).toEqual([]);
    expect(versionCounts([issue(['a']), issue(['b']), issue(['a']), issue([])])).toEqual([['a', 2], ['b', 1], [NO_VERSION, 1]]);
  });
});
