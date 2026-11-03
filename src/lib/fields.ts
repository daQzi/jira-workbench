// Jira createmeta / editmeta / transitions 字段元数据，以及表单值 -> Jira REST 值的转换。

export interface AllowedValue {
  id: string;
  name?: string;
  value?: string;
  children?: AllowedValue[];
}

export interface FieldSchema {
  type: string;
  items?: string;
  system?: string;
  custom?: string;
}

export interface FieldMeta {
  required: boolean;
  name: string;
  schema: FieldSchema;
  allowedValues?: AllowedValue[];
  operations?: string[];
}

export type FieldMetaMap = Record<string, FieldMeta>;

/** 表单内部值：文本 / 选项 id / 用户名 / id 数组 */
export type FormValue = string | string[];

export type InputKind = 'text' | 'textarea' | 'user' | 'date' | 'datetime' | 'select' | 'multiselect' | 'cascade' | 'number' | 'estimate' | 'labels';

const CT = 'com.atlassian.jira.plugin.system.customfieldtypes:';

/** 字段对应的输入控件；不支持的返回 null（界面提示去 Jira 填写） */
export function inputKind(id: string, meta: FieldMeta): InputKind | null {
  const { type, items, custom } = meta.schema;
  if (id === 'timetracking') return 'estimate';
  // 级联选择：表单值为 [父选项 id, 子选项 id?]
  if (custom === `${CT}cascadingselect`) return meta.allowedValues ? 'cascade' : null;
  if (custom === `${CT}textarea` || id === 'description' || id === 'environment') return 'textarea';
  switch (type) {
    case 'user':
      return 'user';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'number':
      return 'number';
    case 'priority':
    case 'resolution':
    case 'option':
    case 'version':
    case 'component':
      return meta.allowedValues ? 'select' : null;
    case 'string':
      return meta.allowedValues ? 'select' : 'text';
    case 'array':
      if (items === 'string') return 'labels';
      if ((items === 'component' || items === 'version' || items === 'option') && meta.allowedValues) return 'multiselect';
      return null;
    default:
      return null;
  }
}

export function optionLabel(v: AllowedValue): string {
  return v.name ?? v.value ?? v.id;
}

export function isEmpty(v: FormValue | undefined): boolean {
  return v === undefined || (Array.isArray(v) ? v.filter(Boolean).length === 0 : v.trim() === '');
}

/** datetime-local（本地时间）转 Jira 6 接受的 2026-10-26T10:00:00.000+0800 */
export function toJiraDateTime(local: string, offsetMinutes = -new Date().getTimezoneOffset()): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
  const base = local.length === 16 ? `${local}:00` : local.slice(0, 19);
  return `${base}.000${off}`;
}

/** 表单值转 REST 值；空值返回 undefined（不提交） */
export function toJiraValue(id: string, meta: FieldMeta, v: FormValue | undefined): unknown {
  if (isEmpty(v)) return undefined;
  const kind = inputKind(id, meta);
  const s = Array.isArray(v) ? v : v!.trim();
  switch (kind) {
    case 'text':
    case 'textarea':
    case 'date':
      return s;
    case 'datetime':
      return toJiraDateTime(s as string);
    case 'number':
      return Number(s);
    case 'user':
      return { name: s };
    case 'estimate':
      return { originalEstimate: s };
    case 'labels':
      return (s as string)
        .split(/[\s,，]+/)
        .map((x) => x.trim())
        .filter(Boolean);
    case 'select':
      return { id: s };
    case 'multiselect':
      return (Array.isArray(s) ? s : [s]).map((id) => ({ id }));
    case 'cascade': {
      const [pid, cid] = Array.isArray(s) ? s : [s];
      return cid ? { id: pid, child: { id: cid } } : { id: pid };
    }
    default:
      return undefined;
  }
}

/** 当前问题字段值转表单值，用于预填 */
export function fromJiraValue(id: string, meta: FieldMeta, raw: unknown): FormValue | undefined {
  if (raw === null || raw === undefined) return undefined;
  const kind = inputKind(id, meta);
  const r = raw as Record<string, unknown>;
  switch (kind) {
    case 'text':
    case 'textarea':
    case 'number':
      return String(raw);
    case 'date':
      return String(raw).slice(0, 10);
    case 'datetime':
      return String(raw).slice(0, 16);
    case 'user':
      return typeof r.name === 'string' ? r.name : undefined;
    case 'estimate':
      return typeof r.originalEstimate === 'string' ? r.originalEstimate : undefined;
    case 'labels':
      return Array.isArray(raw) ? raw.join(' ') : undefined;
    case 'select':
      return typeof r.id === 'string' ? r.id : undefined;
    case 'multiselect':
      return Array.isArray(raw) ? raw.map((x) => String((x as { id: string }).id)) : undefined;
    case 'cascade': {
      const o = raw as { id?: string; child?: { id?: string } };
      if (!o.id) return undefined;
      return o.child?.id ? [String(o.id), String(o.child.id)] : [String(o.id)];
    }
    default:
      return undefined;
  }
}

export interface ValidationResult {
  fields: Record<string, unknown>;
  missing: string[];
  unsupported: string[];
}

/** 组装提交字段并校验必填；不支持的必填字段单独列出 */
export function buildFields(meta: FieldMetaMap, values: Record<string, FormValue | undefined>, skip: string[] = []): ValidationResult {
  const fields: Record<string, unknown> = {};
  const missing: string[] = [];
  const unsupported: string[] = [];
  for (const [id, m] of Object.entries(meta)) {
    if (skip.includes(id)) continue;
    const kind = inputKind(id, m);
    if (!kind) {
      if (m.required) unsupported.push(m.name);
      continue;
    }
    const val = toJiraValue(id, m, values[id]);
    if (val === undefined) {
      if (m.required) missing.push(m.name);
      continue;
    }
    fields[id] = val;
  }
  return { fields, missing, unsupported };
}

// 新建子项时从父需求继承的字段（存在于子项 createmeta 中才继承）
export const INHERIT_FIELDS = [
  'components', 'priority', 'customfield_11130', 'customfield_11131', 'customfield_11138',
  'customfield_10400', 'customfield_10401', 'customfield_10000', 'customfield_10202', 'versions', 'customfield_11201',
];

/** 把父问题上的原始值转换成可直接提交的 REST 值；级联选择也能原样继承 */
export function rawToSubmit(meta: FieldMeta, raw: unknown): unknown {
  if (raw === null || raw === undefined || (Array.isArray(raw) && raw.length === 0)) return undefined;
  const { type, custom } = meta.schema;
  const ref = (x: unknown) => {
    const o = x as { id?: string; name?: string };
    return o?.id ? { id: String(o.id) } : undefined;
  };
  if (custom === `${CT}cascadingselect`) {
    const o = raw as { id?: string; child?: { id?: string } };
    if (!o.id) return undefined;
    return o.child?.id ? { id: o.id, child: { id: o.child.id } } : { id: o.id };
  }
  if (type === 'user') {
    const n = (raw as { name?: string }).name;
    return n ? { name: n } : undefined;
  }
  if (type === 'array') {
    if (!Array.isArray(raw)) return undefined;
    if (meta.schema.items === 'string') return raw;
    const refs = raw.map(ref).filter(Boolean);
    return refs.length ? refs : undefined;
  }
  if (typeof raw === 'string' || typeof raw === 'number') return raw;
  return ref(raw);
}

export function inheritFields(parentFields: Record<string, unknown>, childMeta: FieldMetaMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of INHERIT_FIELDS) {
    const m = childMeta[id];
    if (!m) continue;
    const v = rawToSubmit(m, parentFields[id]);
    if (v !== undefined) out[id] = v;
  }
  return out;
}

/** 继承来的 REST 值转回表单值，用于在完整表单里预填 */
export function submitToForm(id: string, meta: FieldMeta, v: unknown): FormValue | undefined {
  return fromJiraValue(id, meta, v);
}

export type EditResult = { kind: 'unchanged' } | { kind: 'error'; msg: string } | { kind: 'set'; value: unknown };

/**
 * 行内编辑保存：表单值转 PUT issue 的字段值。
 * 清空非必填字段时显式提交 null（数组字段提交 []），否则 Jira 不会清掉旧值。
 */
export function editValue(id: string, meta: FieldMeta, raw: unknown, next: FormValue | undefined): EditResult {
  const norm = (v: FormValue | undefined) => JSON.stringify(isEmpty(v) ? null : Array.isArray(v) ? v.filter(Boolean) : v!.trim());
  if (norm(fromJiraValue(id, meta, raw)) === norm(next)) return { kind: 'unchanged' };
  if (meta.operations && !meta.operations.includes('set')) return { kind: 'error', msg: `「${meta.name}」不支持直接修改` };
  const value = toJiraValue(id, meta, next);
  if (value !== undefined) return { kind: 'set', value };
  if (meta.required) return { kind: 'error', msg: `「${meta.name}」是必填项，不能清空` };
  return { kind: 'set', value: meta.schema.type === 'array' ? [] : null };
}
