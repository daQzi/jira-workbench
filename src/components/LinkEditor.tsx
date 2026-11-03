import { useEffect, useState } from 'react';
import { CHILD_OPTION, linkOptions, type LinkOption, type PendingLink } from '../lib/links';
import { CHILD_TYPES } from '../lib/create';
import { getLinkTypes } from '../lib/linkTypes';
import type { Issue } from '../lib/types';
import { TypeBadge } from './Badges';
import { IssuePicker } from './IssuePicker';

export interface PendingLinkView extends PendingLink {
  label: string;
  summary: string;
  typeName: string;
}

interface Props {
  projectKey: string;
  value: PendingLinkView[];
  onChange: (v: PendingLinkView[]) => void;
  /** 已占用的问题（如父需求），不再出现在搜索结果里 */
  exclude?: string[];
  /** 新建的是需求：额外提供「子项」关系，把已有任务挂到它下面 */
  asParent?: boolean;
}

const CHILD_PICK: LinkOption = { id: 'child', type: CHILD_OPTION.type, dir: CHILD_OPTION.dir, label: '子项', hint: '把已有的编码任务 / BUG / 其他任务挂到这个需求下面' };

/** 新建表单里的「关联问题」：先选关系，再搜索问题，可添加多条 */
export function LinkEditor({ projectKey, value, onChange, exclude = [], asParent = false }: Props) {
  const [options, setOptions] = useState<LinkOption[]>([]);
  const [optId, setOptId] = useState('Relates:out');
  const [error, setError] = useState('');
  useEffect(() => {
    getLinkTypes().then(
      (t) => setOptions(linkOptions(t)),
      (e: Error) => setError(e.message),
    );
  }, []);
  const all = asParent ? [CHILD_PICK, ...options] : options;
  const opt = all.find((o) => o.id === optId) ?? all.find((o) => o.id === 'Relates:out') ?? all[0];
  const add = (i: Issue) => {
    if (!opt) return;
    if (value.some((v) => v.key === i.key && v.option.type === opt.type && v.option.dir === opt.dir)) return;
    onChange([...value, { option: { type: opt.type, dir: opt.dir }, key: i.key, label: opt.label, summary: i.fields.summary, typeName: i.fields.issuetype.name }]);
  };
  return (
    <div className="link-editor">
      <div className="link-editor-row">
        <select className="select" aria-label="关系类型" value={opt?.id ?? ''} onChange={(e) => setOptId(e.target.value)} disabled={!options.length}>
          {all.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <IssuePicker projectKey={projectKey} types={opt?.id === 'child' ? CHILD_TYPES : undefined} exclude={[...exclude, ...value.map((v) => v.key)]} placeholder="搜索要关联的问题（编号或标题）" onPick={add} />
      </div>
      {opt?.hint && <span className="field-hint">{opt.hint}</span>}
      {error && <span className="err">链接类型加载失败：{error}</span>}
      {value.length > 0 && (
        <ul className="pending-links">
          {value.map((v, i) => (
            <li key={`${v.option.type}:${v.option.dir}:${v.key}`}>
              <span className="rel">{v.label}</span>
              <TypeBadge type={v.typeName} />
              <span className="mono muted">{v.key}</span>
              <span className="summary">{v.summary}</span>
              <button type="button" className="x-btn" aria-label={`移除关联 ${v.key}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
