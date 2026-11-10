import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createReadCache, readTtl } from './read-cache.mjs';
test('相同请求合并，成功后短期复用，失败不缓存', async () => {
  let now = 1000, loads = 0;
  const cache = createReadCache({ clock: () => now });
  const load = async () => { loads++; return { issues: [loads] }; };
  const [a,b] = await Promise.all([cache.get('one', 'search', 20_000, load), cache.get('one', 'search', 20_000, load)]);
  assert.equal(loads, 1); assert.deepEqual(a,b); await cache.get('one', 'search', 20_000, load); assert.equal(loads, 1);
  assert.deepEqual(cache.stats(), { reads: 3, deduplicated: 1, saved: 1 });
  now += 20_001; await cache.get('one', 'search', 20_000, load); assert.equal(loads, 2);
  await assert.rejects(cache.get('one', 'bad', 20_000, async () => { throw Error('offline'); }));
  await assert.rejects(cache.get('one', 'bad', 20_000, async () => { throw Error('offline'); }));
});
test('会话隔离，退出与写后清空都不能读到旧数据', async () => {
  const cache = createReadCache(); let loads = 0;
  const load = async () => ++loads;
  await cache.get('one', 'project', 60_000, load); await cache.get('two', 'project', 60_000, load); assert.equal(loads, 2);
  cache.clearSession('one'); await cache.get('one', 'project', 60_000, load); await cache.get('two', 'project', 60_000, load); assert.equal(loads, 3);
  cache.clear(); await cache.get('two', 'project', 60_000, load); assert.equal(loads, 4);
});
test('缓存只覆盖明确白名单，权限、人员和附件始终直连', () => {
  assert.equal(readTtl('field'), 300_000); assert.equal(readTtl('project/AA'), 300_000); assert.equal(readTtl('issue/AA-1?fields=summary'), 20_000);
  assert.equal(readTtl('mypermissions?issueKey=AA-1'), 0); assert.equal(readTtl('user/assignable/search?username=a'), 0); assert.equal(readTtl('attachment/1'), 0);
});
