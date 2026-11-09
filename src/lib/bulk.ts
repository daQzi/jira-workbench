import { inputKind, type FieldMeta, type FormValue } from './fields';

/** 批量写路径强校验；不能把无法转换的数值或失效选项提交给 Jira。 */
export function validateBulkValue(meta: FieldMeta, value: FormValue | undefined): void {
  if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) return;
  const kind = inputKind('', meta);
  if (kind === 'number' && (Array.isArray(value) || !Number.isFinite(Number(value)))) throw new Error(`「${meta.name}」必须是有效数字`);
  if (kind === 'date' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) !== value)) throw new Error(`「${meta.name}」日期无效`);
  if (meta.allowedValues) {
    if (kind === 'cascade') {
      const [parent,child] = Array.isArray(value) ? value : [value];
      const selected = meta.allowedValues.find(v=>v.id===parent);
      if (!selected || (child && !selected.children?.some(v=>v.id===child))) throw new Error(`「${meta.name}」上下级选项不匹配`);
    } else if ((Array.isArray(value) ? value : [value]).some(v=>!meta.allowedValues!.some(o=>o.id===v))) throw new Error(`「${meta.name}」包含不允许的选项`);
  }
}
