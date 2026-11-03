// 新建表单字段显示配置：按「项目:问题类型」记住用户隐藏的字段（存本机 localStorage）。
// 默认全部显示（即 Jira 当前配置的新建字段）；必填字段不能隐藏。
import type { FieldMetaMap } from './fields';

const STORE = 'wb.createFields.v1';

type Prefs = Record<string, string[]>;

function read(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) || '{}');
    return v && typeof v === 'object' ? (v as Prefs) : {};
  } catch {
    return {};
  }
}

export const prefKey = (projectKey: string, typeName: string) => `${projectKey}:${typeName}`;

export function hiddenFields(projectKey: string, typeName: string): string[] {
  const v = read()[prefKey(projectKey, typeName)];
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

export function saveHiddenFields(projectKey: string, typeName: string, ids: string[]) {
  const all = read();
  if (ids.length) all[prefKey(projectKey, typeName)] = ids;
  else delete all[prefKey(projectKey, typeName)];
  localStorage.setItem(STORE, JSON.stringify(all));
}

/** 拆分显示/收起的字段：必填项总是显示，有值的也显示（避免藏起已填内容） */
export function splitFields(ids: string[], meta: FieldMetaMap, hidden: string[], filled: (id: string) => boolean) {
  const shown: string[] = [];
  const folded: string[] = [];
  for (const id of ids) {
    if (!hidden.includes(id) || meta[id]?.required || filled(id)) shown.push(id);
    else folded.push(id);
  }
  return { shown, folded };
}
