import { describe, expect, it } from 'vitest';
import { loadLastProject, parseHash, pickProject, saveLastProject, toHash } from './route';

describe('route', () => {
  it('解析项目、页面和问题', () => {
    expect(parseHash('#/AGENT/board?issue=AGENT-1')).toEqual({ project: 'AGENT', page: 'board', issue: 'AGENT-1' });
    expect(parseHash('#/AGENT')).toEqual({ project: 'AGENT', page: 'me', issue: null });
    expect(parseHash('#/ALL/hours')).toEqual({ project: null, page: 'hours', issue: null });
    // 全部项目下不能看需求树等项目页面
    expect(parseHash('#/ALL/tree')).toEqual({ project: null, page: 'me', issue: null });
  });

  it('旧地址和空地址：项目待补', () => {
    expect(parseHash('')).toEqual({ project: undefined, page: 'me', issue: null });
    expect(parseHash('#/hours?issue=A-1')).toEqual({ project: undefined, page: 'hours', issue: 'A-1' });
  });

  it('toHash 往返', () => {
    for (const h of ['#/AGENT/tree', '#/ALL/hours', '#/YLZHXT/me?issue=YLZHXT-9']) {
      const r = parseHash(h);
      expect(toHash({ project: r.project ?? null, page: r.page, issue: r.issue })).toBe(h);
    }
    expect(toHash({ project: null, page: 'board', issue: null })).toBe('#/ALL/me');
  });

  it('上次项目：不记 ALL；选择顺序', () => {
    const m = new Map<string, string>();
    const kv = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    saveLastProject('AGENT', kv);
    saveLastProject(null, kv);
    expect(loadLastProject(kv)).toBe('AGENT');
    const ps = [{ key: 'A' }, { key: 'B' }, { key: 'AGENT' }];
    expect(pickProject(ps, 'AGENT', () => false)).toBe('AGENT');
    expect(pickProject(ps, 'GONE', (k) => k === 'B')).toBe('B');
    expect(pickProject(ps, null, () => false)).toBe('A');
    expect(pickProject([], null, () => true)).toBeNull();
  });
});
