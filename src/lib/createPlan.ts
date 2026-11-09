import type { CreateMetaType } from './api';
import { buildFields, inheritFields, type FormValue } from './fields';
import { createLinkUpdates, dedupeLinks, PARENT_OPTION, type PendingLink } from './links';

// 表单里不展示的字段：由上下文决定或暂不支持
export const HIDDEN_CREATE_FIELDS = ['project', 'issuetype', 'issuelinks', 'attachment', 'reporter'];

// 常用字段排前面，其余按 createmeta 顺序
const ORDER = ['summary', 'components', 'priority', 'assignee', 'customfield_10204', 'customfield_10401', 'customfield_10400', 'customfield_11201', 'description'];

export function orderedFieldIds(t: CreateMetaType): string[] {
  const ids = Object.keys(t.fields).filter((id) => !HIDDEN_CREATE_FIELDS.includes(id));
  const rank = (id: string) => {
    const i = ORDER.indexOf(id);
    if (i >= 0) return i;
    return t.fields[id].required ? ORDER.length : ORDER.length + 1;
  };
  return ids.map((id, i) => ({ id, i })).sort((a, b) => rank(a.id) - rank(b.id) || a.i - b.i).map((x) => x.id);
}

export interface CreateInput {
  projectKey: string;
  type: CreateMetaType;
  values: Record<string, FormValue | undefined>;
  /** 父需求 key 及其原始字段（用于继承） */
  parent?: { key: string; fields: Record<string, unknown> } | null;
  /** 父子以外的关联（关联/阻塞/被阻塞等），随创建一并提交 */
  links?: PendingLink[];
}

export interface CreatePlan {
  body: { fields: Record<string, unknown>; update?: Record<string, unknown> };
  missing: string[];
  unsupported: string[];
  /** 创建成功后需单独建立的链接 */
  afterLinks: PendingLink[];
}

/** 组装创建请求。父需求字段先继承，再由表单值覆盖；父子链接随创建一并提交（原子） */
export function planCreate({ projectKey, type, values, parent, links = [] }: CreateInput): CreatePlan {
  const inherited = parent ? inheritFields(parent.fields, type.fields) : {};
  const { fields, missing, unsupported } = buildFields(type.fields, values, HIDDEN_CREATE_FIELDS);
  const merged = { ...inherited, ...fields };
  // 继承补齐的必填项不再算缺失
  const stillMissing = missing.filter((name) => {
    const id = Object.keys(type.fields).find((k) => type.fields[k].name === name);
    return !(id && merged[id] !== undefined);
  });
  const stillUnsupported = unsupported.filter((name) => {
    const id = Object.keys(type.fields).find((k) => type.fields[k].name === name);
    return !(id && merged[id] !== undefined);
  });
  const body: CreatePlan['body'] = {
    fields: { ...merged, project: { key: projectKey }, issuetype: { id: type.id } },
  };
  const all = allLinks(parent?.key, links);
  // Jira 6.0 创建接口只接受 1 条 issuelinks（多条直接 500，已实测），
  // 所以第一条（父需求优先）随创建提交，其余创建后逐条补建
  const inline = type.fields.issuelinks ? all.slice(0, 1) : [];
  if (inline.length) body.update = { issuelinks: createLinkUpdates(inline) };
  return { body, missing: stillMissing, unsupported: stillUnsupported, afterLinks: all.slice(inline.length) };
}

function allLinks(parentKey: string | undefined, links: PendingLink[]): PendingLink[] {
  return dedupeLinks([...(parentKey ? [{ option: PARENT_OPTION, key: parentKey }] : []), ...links]);
}
