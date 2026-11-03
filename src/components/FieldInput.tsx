import { useId } from 'react';
import { inputKind, optionLabel, type AllowedValue, type FieldMeta, type FormValue } from '../lib/fields';
import { UserPicker } from './UserPicker';

interface Props {
  id: string;
  meta: FieldMeta;
  value: FormValue | undefined;
  onChange: (v: FormValue) => void;
  project?: string;
  issueKey?: string;
  invalid?: boolean;
  hint?: string;
}

/** 按字段元数据渲染输入控件，不支持的字段给出提示 */
export function FieldInput({ id, meta, value, onChange, project, issueKey, invalid, hint }: Props) {
  const kind = inputKind(id, meta);
  const htmlId = useId();
  const str = typeof value === 'string' ? value : '';
  const arr = Array.isArray(value) ? value : [];
  const label = (
    <label htmlFor={htmlId} className="field-label">
      {meta.name}
      {meta.required && <span className="req" aria-label="必填">*</span>}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );

  let control: React.ReactNode;
  switch (kind) {
    case 'textarea':
      control = <textarea id={htmlId} className="input textarea" rows={4} value={str} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'user':
      control = <UserPicker label={meta.name} value={str} onChange={onChange} project={project} issueKey={issueKey} />;
      break;
    case 'date':
      control = <input id={htmlId} className="input" type="date" value={str} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'datetime':
      control = <input id={htmlId} className="input" type="datetime-local" value={str} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'number':
      control = <input id={htmlId} className="input" type="number" value={str} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'estimate':
      control = <input id={htmlId} className="input" placeholder="如 2d 4h" value={str} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'labels':
      control = <input id={htmlId} className="input" placeholder="空格分隔" value={str} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'select':
      control = (
        <select id={htmlId} className="select" value={str} onChange={(e) => onChange(e.target.value)}>
          <option value="">{meta.required ? '请选择' : '不设置'}</option>
          {meta.allowedValues!.map((v) => (
            <option key={v.id} value={v.id}>
              {optionLabel(v)}
            </option>
          ))}
        </select>
      );
      break;
    case 'cascade':
      control = <CascadeSelect id={htmlId} meta={meta} value={arr.length ? arr : str ? [str] : []} onChange={onChange} />;
      break;
    case 'multiselect':
      if (meta.allowedValues!.length > 12) {
        control = <ManySelect id={htmlId} meta={meta} value={arr} onChange={onChange} />;
        break;
      }
      control = (
        <div className="check-group" role="group" aria-labelledby={htmlId}>
          {meta.allowedValues!.length === 0 && <span className="muted">无可选项</span>}
          {meta.allowedValues!.map((v) => (
            <label key={v.id} className="chip" aria-pressed={arr.includes(v.id)}>
              <input
                type="checkbox"
                className="sr-only"
                checked={arr.includes(v.id)}
                onChange={(e) => onChange(e.target.checked ? [...arr, v.id] : arr.filter((x) => x !== v.id))}
              />
              {optionLabel(v)}
            </label>
          ))}
        </div>
      );
      break;
    case 'text':
      control = <input id={htmlId} className="input" value={str} onChange={(e) => onChange(e.target.value)} />;
      break;
    default:
      control = <span className="muted">此字段类型暂不支持，请在 Jira 中填写</span>;
  }

  return (
    <div className={`field${invalid ? ' invalid' : ''}${kind === 'textarea' || (kind === 'multiselect' && meta.allowedValues!.length <= 12) ? ' wide' : ''}`}>
      {label}
      {control}
    </div>
  );
}

/** 级联选择：两个下拉，选父项后才出子项 */
function CascadeSelect({ id, meta, value, onChange }: { id: string; meta: FieldMeta; value: string[]; onChange: (v: FormValue) => void }) {
  const [pid = '', cid = ''] = value;
  const parent = meta.allowedValues!.find((v) => v.id === pid);
  const children = parent?.children ?? [];
  return (
    <div className="cascade">
      <select id={id} className="select" value={pid} onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}>
        <option value="">{meta.required ? '请选择' : '不设置'}</option>
        {meta.allowedValues!.map((v) => (
          <option key={v.id} value={v.id}>
            {optionLabel(v)}
          </option>
        ))}
      </select>
      <select className="select" aria-label={`${meta.name}（下级）`} value={cid} disabled={!children.length} onChange={(e) => onChange(e.target.value ? [pid, e.target.value] : [pid])}>
        <option value="">{children.length ? '下级（可不选）' : '无下级'}</option>
        {children.map((v) => (
          <option key={v.id} value={v.id}>
            {optionLabel(v)}
          </option>
        ))}
      </select>
    </div>
  );
}

interface VersionLike extends AllowedValue {
  released?: boolean;
  archived?: boolean;
}

/** 选项很多时（如版本）：已选做成标签，下拉里按「未发布 / 已发布」分组，已归档的不列出 */
function ManySelect({ id, meta, value, onChange }: { id: string; meta: FieldMeta; value: string[]; onChange: (v: FormValue) => void }) {
  const all = meta.allowedValues as VersionLike[];
  const byId = new Map(all.map((v) => [v.id, v]));
  const rest = all.filter((v) => !value.includes(v.id) && !v.archived);
  const isVersion = all.some((v) => 'released' in v);
  const groups = isVersion
    ? [
        { label: '未发布', items: rest.filter((v) => !v.released) },
        { label: '已发布', items: rest.filter((v) => v.released) },
      ].filter((g) => g.items.length)
    : [{ label: '', items: rest }];
  return (
    <div className="many-select">
      {value.map((v) => (
        <span key={v} className="tag">
          {byId.get(v) ? optionLabel(byId.get(v)!) : v}
          <button type="button" className="x-btn" aria-label={`移除 ${byId.get(v) ? optionLabel(byId.get(v)!) : v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
            ✕
          </button>
        </span>
      ))}
      <select id={id} className="select" value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
        <option value="">{value.length ? '＋ 再加一个' : '选择（可多选）'}</option>
        {groups.map((g) =>
          g.label ? (
            <optgroup key={g.label} label={g.label}>
              {g.items.map((v) => (
                <option key={v.id} value={v.id}>
                  {optionLabel(v)}
                </option>
              ))}
            </optgroup>
          ) : (
            g.items.map((v) => (
              <option key={v.id} value={v.id}>
                {optionLabel(v)}
              </option>
            ))
          ),
        )}
      </select>
    </div>
  );
}
