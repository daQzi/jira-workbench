let reads = 0;
let writes = 0;
let snapshot = { reads, writes };
const listeners = new Set<() => void>();

function publish() {
  snapshot = { reads, writes };
  listeners.forEach((notify) => notify());
}

export function subscribeRequestActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function requestActivity() {
  return snapshot;
}

/** 接口边界统一登记请求；写请求结束之前由全局界面锁定操作。 */
export async function trackRequest<T>(run: () => Promise<T>, write = false): Promise<T> {
  if (write) writes++;
  else reads++;
  publish();
  try {
    return await run();
  } finally {
    if (write) writes--;
    else reads--;
    publish();
  }
}
