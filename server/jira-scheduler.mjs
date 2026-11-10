/** 所有 Jira 请求共用的有限队列；槽位覆盖响应体读取，后台最多占一路。 */
export function createJiraScheduler({ concurrency = 2, maxQueue = 100 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Jira 并发必须为1–4');
  let active = 0, background = 0, peak = 0;
  const queue = [];
  function pump() {
    while (active < concurrency) {
      const now = Date.now();
      queue.sort((a, b) => (a.priority === 2 && now - a.at > 5000 ? 1 : a.priority) - (b.priority === 2 && now - b.at > 5000 ? 1 : b.priority) || a.at - b.at);
      const index = queue.findIndex(item => item.priority !== 2 || background < 1);
      if (index < 0) return;
      const item = queue.splice(index, 1)[0];
      item.signal?.removeEventListener('abort', item.abort);
      active++; if (item.priority === 2) background++;
      peak = Math.max(peak, active);
      Promise.resolve().then(() => { item.signal?.throwIfAborted(); return item.load(); }).then(item.resolve, item.reject).finally(() => {
        active--; if (item.priority === 2) background--; pump();
      });
    }
  }
  return {
    run(load, { signal, priority = 1 } = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (queue.length >= maxQueue) return Promise.reject(Object.assign(new Error('Jira 请求队列已满，请稍后重试'), { status: 503 }));
      return new Promise((resolve, reject) => {
        const item = { load, signal, priority, resolve, reject, at: Date.now(), abort: null };
        item.abort = () => { const index = queue.indexOf(item); if (index >= 0) queue.splice(index, 1); reject(signal.reason); };
        signal?.addEventListener('abort', item.abort, { once: true });
        queue.push(item); pump();
      });
    },
    stats: () => ({ active, queued: queue.length, peak }),
  };
}

/** 可明确判断项目才缩小失效范围；无法判断的查询始终保守失效。 */
export function readProjects(path) {
  const url = new URL(path, 'http://local');
  const issue = url.pathname.match(/\/issue\/([A-Za-z][A-Za-z0-9]+)-\d+/);
  if (issue) return [issue[1].toUpperCase()];
  if (!url.pathname.endsWith('/search')) return [];
  const jql = url.searchParams.get('jql') || '';
  // 仅收窄由工作台生成的、以 project = 开头且后续没有 OR 的查询。
  const match = jql.match(/^project = "([A-Za-z][A-Za-z0-9_]*)"(?: AND | ORDER BY |$)/);
  if (!match) return null;
  let depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < jql.length; index++) {
    const char = jql[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && quoted) { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (!depth && /^\bOR\b/i.test(jql.slice(index)) && !/\w/.test(jql[index - 1] || '')) return null;
  }
  return [match[1].toUpperCase()];
}
export function writeProjects(path, body) {
  const issue = path.match(/\/issue\/([A-Za-z][A-Za-z0-9]+)-\d+/);
  const keys = [body?.inwardIssue?.key, body?.outwardIssue?.key, ...(body?.update?.issuelinks || []).flatMap(link => [link?.add?.inwardIssue?.key, link?.add?.outwardIssue?.key])];
  const projects = [issue?.[1], body?.fields?.project?.key, ...keys.filter(Boolean).map(key => key.split('-')[0])].filter(Boolean).map(p => p.toUpperCase());
  return projects.length ? [...new Set(projects)] : null;
}
