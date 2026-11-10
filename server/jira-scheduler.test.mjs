import { describe, expect, it } from 'vitest';
import { createJiraScheduler, readProjects, writeProjects } from './jira-scheduler.mjs';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
describe('Jira 统一队列', () => {
  it('限制总并发，后台只有一路，交互优先于未启动的补页', async () => {
    const scheduler = createJiraScheduler({ concurrency: 2 });
    const gates = Array.from({ length: 4 }, deferred), started = [];
    const run = (id, priority) => scheduler.run(async () => { started.push(id); await gates[id].promise; }, { priority });
    const bg1 = run(0, 2), bg2 = run(1, 2), read = run(2, 1), write = run(3, 0);
    await tick(); expect(started).toEqual([0, 2]); expect(scheduler.stats().active).toBe(2);
    gates[2].resolve(); await read; await tick(); expect(started).toEqual([0, 2, 3]);
    gates[0].resolve(); gates[3].resolve(); await Promise.all([bg1, write]); await tick(); expect(started).toEqual([0, 2, 3, 1]);
    gates[1].resolve(); await bg2; expect(scheduler.stats().peak).toBe(2);
  });
  it('排队的旧查询可取消，不进入 Jira；队列有界', async () => {
    const scheduler = createJiraScheduler({ concurrency: 1, maxQueue: 1 }), gate = deferred();
    const first = scheduler.run(() => gate.promise), ctrl = new AbortController(); let ran = false;
    const second = scheduler.run(() => { ran = true; }, { signal: ctrl.signal });
    await expect(scheduler.run(() => {})).rejects.toMatchObject({ status: 503 });
    ctrl.abort(); await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    gate.resolve(); await first; expect(ran).toBe(false);
  });
});
describe('项目失效范围', () => {
  const search = jql => `/rest/api/2/search?${new URLSearchParams({ jql })}`;
  it('识别项目顶层约束，跨项目 OR 使用保守失效', () => {
    expect(readProjects(search('project = "AA" AND (assignee = "a" OR cf[10204] = "a") ORDER BY updated DESC'))).toEqual(['AA']);
    expect(readProjects(search('project = "AA" OR assignee = "b"'))).toBe(null);
    expect(readProjects(search('assignee = currentUser()'))).toBe(null);
    expect(readProjects('/rest/api/2/issue/AA-1/transitions')).toEqual(['AA']);
    expect(readProjects('/rest/api/2/project/AA')).toEqual([]);
  });
  it('跨项目链接同时失效两端，未知操作使用保守范围', () => {
    expect(writeProjects('/rest/api/2/issueLink', { inwardIssue: { key: 'AA-1' }, outwardIssue: { key: 'BB-1' } })).toEqual(['AA', 'BB']);
    expect(writeProjects('/rest/api/2/attachment/1')).toBe(null);
  });
});
