import { api, type CreateMetaType } from './api';

// createmeta 很大且很少变化，按项目缓存（失败不缓存）
const cache = new Map<string, Promise<CreateMetaType[]>>();

export function getCreateMeta(projectKey: string): Promise<CreateMetaType[]> {
  let p = cache.get(projectKey);
  if (!p) {
    p = api.createMeta(projectKey).catch((e) => {
      cache.delete(projectKey);
      throw e;
    });
    cache.set(projectKey, p);
  }
  return p;
}
