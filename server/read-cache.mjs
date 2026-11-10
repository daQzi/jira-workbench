/** 会话隔离：执行中请求共享，成功响应完成后才开始TTL；写后移除旧代次。 */
export function createReadCache({ clock = Date.now, maxEntries = 1200, maxBytes = 32 * 1024 * 1024 } = {}) {
  const cache = new Map();
  let reads = 0, deduplicated = 0, saved = 0;
  function remove(key, entry) { if (cache.get(key) === entry) cache.delete(key); }
  function trim() {
    let bytes = [...cache.values()].reduce((n, e) => n + (e.bytes || 0), 0);
    for (const [key, entry] of cache) {
      if (cache.size <= maxEntries && bytes <= maxBytes) break;
      if (!entry.settled) continue;
      bytes -= entry.bytes || 0; cache.delete(key);
    }
  }
  function subscribe(key, entry, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    entry.consumers++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return false; done = true;
        signal?.removeEventListener('abort', abort); entry.consumers--;
        if (!entry.settled && !entry.consumers) { remove(key, entry); entry.ctrl.abort(); }
        return true;
      };
      const abort = () => { if (finish()) reject(signal.reason); };
      signal?.addEventListener('abort', abort, { once: true });
      entry.promise.then(value => { if (finish()) resolve(value); }, error => { if (finish()) reject(error); });
    });
  }
  return {
    get(sid, path, ttlMs, load, { signal, refresh = false } = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      const key = `${sid}\0${path}`, existing = cache.get(key);
      reads++;
      if (existing && (!existing.settled || (!refresh && existing.expiresAt > clock()))) {
        if (existing.settled) saved++; else deduplicated++;
        return subscribe(key, existing, signal);
      }
      const entry = { path, sid, ctrl: new AbortController(), expiresAt: 0, settled: false, consumers: 0, bytes: 0, promise: null };
      entry.promise = Promise.resolve().then(() => load(entry.ctrl.signal)).then(value => {
        entry.settled = true;
        const success = value?.status === undefined || (value.status >= 200 && value.status < 300 && value.status !== 202 && (value.contentType || '').includes('json'));
        if (success && !entry.ctrl.signal.aborted) {
          entry.expiresAt = clock() + ttlMs; entry.bytes = value?.buf?.length || 0;
          if (value?.status !== undefined) value = { ...value, fetchedAt: clock() };
          trim();
        } else remove(key, entry);
        return value;
      }, error => { entry.settled = true; remove(key, entry); throw error; });
      cache.set(key, entry);
      return subscribe(key, entry, signal);
    },
    invalidate(predicate) { for (const [key, entry] of cache) if (predicate(entry.path, entry.sid)) cache.delete(key); },
    clear() { for (const entry of cache.values()) if (!entry.settled) entry.ctrl.abort(); cache.clear(); reads = deduplicated = saved = 0; },
    stats: () => ({ reads, deduplicated, saved }),
    clearSession(sid) { for (const [key, entry] of cache) if (entry.sid === sid) { if (!entry.settled) entry.ctrl.abort(); cache.delete(key); } },
  };
}
export function readTtl(path) {
  const route = path.split('?')[0];
  if (route === 'project') return 60_000;
  if (route.startsWith('project/') || route === 'field' || route === 'priority' || route === 'issueLinkType') return 300_000;
  // 可用流转是写入前校验，不使用旧缓存。
  if (route.startsWith('issue/') && /\/editmeta$/.test(route)) return 30_000;
  if (route === 'search') return 60_000;
  if (/^issue\/[^/]+$/.test(route)) return 20_000;
  return 0;
}
