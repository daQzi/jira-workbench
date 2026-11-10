/** 会话内只读缓存：只服务经过登录校验的 GET，退出即清空；MCP 写入后立即失效。 */
export function createReadCache({ clock = Date.now } = {}) {
  let cache = new Map();
  let reads = 0;
  let deduplicated = 0;
  let saved = 0;
  function get(sid, path, ttlMs, load) {
    const key = `${sid}\0${path}`;
    const existing = cache.get(key);
    if (existing && existing.expiresAt > clock()) {
      reads++;
      if (existing.settled) saved++;
      else deduplicated++;
      return existing.promise;
    }
    reads++;
    const entry = { expiresAt: clock() + ttlMs, settled: false, promise: null };
    entry.promise = Promise.resolve().then(load).then(value => {
      entry.settled = true;
      if (cache.size > 1200) cache.delete(cache.keys().next().value);
      return value;
    }, error => {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    });
    cache.set(key, entry);
    return entry.promise;
  }
  return {
    get,
    clear: () => { cache.clear(); reads = deduplicated = saved = 0; },
    stats: () => ({ reads, deduplicated, saved }),
    clearSession: sid => { for (const key of cache.keys()) if (key.startsWith(`${sid}\0`)) cache.delete(key); },
  };
}
export function readTtl(path) {
  const route = path.split('?')[0];
  if (route === 'project') return 60_000;
  if (route.startsWith('project/') || route === 'field' || route === 'priority' || route === 'issueLinkType') return 300_000;
  if (route.startsWith('issue/') && /\/(editmeta|transitions)$/.test(route)) return 30_000;
  if (route === 'search' || /^issue\/[^/]+$/.test(route)) return 20_000;
  return 0;
}
