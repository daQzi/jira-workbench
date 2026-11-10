import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import type { AsyncState } from './useAsync';

interface Entry { promise: Promise<unknown>; expires: number; controller: AbortController; consumers: number; settled: boolean }
const cache = new Map<string, Entry>();
export function clearReadCache() { cache.clear(); }
export function readCached<T>(key: string, ttl: number, load: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  const old = cache.get(key);
  if (old && old.expires > Date.now()) return subscribe(old, signal) as Promise<T>;
  const controller = new AbortController();
  const entry: Entry = { expires: Date.now() + ttl, controller, consumers: 0, settled: false, promise: Promise.resolve() as Promise<unknown> };
  entry.promise = load(controller.signal);
  cache.set(key, entry);
  entry.promise.then(() => { entry.settled = true; }, () => { entry.settled = true; });
  entry.promise.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  return subscribe(entry, signal) as Promise<T>;
}

/** 复用共享 Promise，但调用方取消时只取消自己的等待；所有消费者离开才中止底层请求。 */
function subscribe(entry: Entry, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  entry.consumers++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      entry.consumers--;
      if (!entry.consumers && !entry.settled) {
        entry.controller.abort();
        if (cache.size) for (const [key, value] of cache) if (value === entry) cache.delete(key);
      }
    };
    const abort = () => { finish(); reject(new DOMException('aborted', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    entry.promise.then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
  });
}

/** 缓存 key 定义数据身份；deps 变化时旧内容保留并标记后台更新，取消过期请求。 */
export function useCachedAsync<T>(key: string, load: (signal: AbortSignal) => Promise<T>, deps: DependencyList): AsyncState<T> & { reload: () => void } {
  const fn = useRef(load); fn.current = load;
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    setState(s => ({ ...s, loading: true, error: null }));
    readCached(key, 300_000, fn.current, ctrl.signal).then(
      data => !ctrl.signal.aborted && setState({ data, error: null, loading: false }),
      (error: Error) => !ctrl.signal.aborted && setState(s => ({ data: s.data, error, loading: false })),
    );
    return () => ctrl.abort();
  }, [key, ...deps, nonce]);
  const reload = useCallback(() => { clearReadCache(); setNonce(n => n + 1); }, []);
  return { ...state, reload };
}
