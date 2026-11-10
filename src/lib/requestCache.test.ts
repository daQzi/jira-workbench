import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearReadCache, readCached } from './requestCache';
beforeEach(() => clearReadCache());
describe('共享读取缓存', () => {
 it('合并并发请求并短期复用，过期重新读取', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000); const s=new AbortController().signal; let resolve!: (v:string)=>void; const load=vi.fn(()=>new Promise<string>(r=>{resolve=r;}));
  const a=readCached('x',300_000,load,s),b=readCached('x',300_000,load,s);expect(load).toHaveBeenCalledTimes(1);resolve('ok');await expect(a).resolves.toBe('ok');await expect(b).resolves.toBe('ok');
  await expect(readCached('x',300_000,load,s)).resolves.toBe('ok');expect(load).toHaveBeenCalledTimes(1);
  vi.mocked(Date.now).mockReturnValue(302001);const expired=readCached('x',300_000,load,s);expect(load).toHaveBeenCalledTimes(2);resolve('new');await expect(expired).resolves.toBe('new');vi.restoreAllMocks();
 });
 it('失败不缓存，后续可以重试', async () => {
  const s=new AbortController().signal;let n=0;
  await expect(readCached('x',300_000,async()=>{n++;throw Error('offline');},s)).rejects.toThrow('offline');
  await expect(readCached('x',300_000,async()=>{n++;return 'ok';},s)).resolves.toBe('ok');expect(n).toBe(2);
 });
 it('取消一个消费者不影响其他消费者，全部取消才中止底层请求', async () => {
  let resolve!: (v:string)=>void;const pending=new Promise<string>(r=>{resolve=r;});let signal:AbortSignal|undefined;
  const load=(s:AbortSignal)=>{signal=s;return pending;};const a=new AbortController(),b=new AbortController();
  const pa=readCached('x',300_000,load,a.signal),pb=readCached('x',300_000,load,b.signal);a.abort();await expect(pa).rejects.toMatchObject({name:'AbortError'});expect(signal?.aborted).toBe(false);
  resolve('ok');await expect(pb).resolves.toBe('ok');
  const c=new AbortController(),d=new AbortController();const pc=readCached('y',300_000,load,c.signal),pd=readCached('y',300_000,load,d.signal);c.abort();d.abort();await Promise.allSettled([pc,pd]);expect(signal?.aborted).toBe(true);
 });
});
