import { api } from './api';
import type { LinkTypeDef } from './links';

// 链接类型和字段定义几乎不变，会话内缓存（失败不缓存）
let linkTypes: Promise<LinkTypeDef[]> | null = null;
export function getLinkTypes(): Promise<LinkTypeDef[]> {
  if (!linkTypes) linkTypes = api.linkTypes().catch((e) => ((linkTypes = null), Promise.reject(e)));
  return linkTypes;
}
