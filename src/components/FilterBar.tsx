import { useEffect, useState } from 'react';
import { STAGES, type StageId } from '../lib/stages';
import type { NamedRef, Version } from '../lib/types';
import { isDefaultFilter } from '../lib/filterPrefs';
import { NO_VERSION, quickVersions, shortDate, versionGroups } from '../lib/versions';

export interface FilterState {
  text: string;
  component: string;
  /** 影响版本名；NO_VERSION = 未设置版本 */
  version: string;
  stages: StageId[];
  onlyMine: boolean;
  hideOldClosed: boolean;
  types: string[];
}

export const DEFAULT_FILTER: FilterState = {
  text: '',
  component: '',
  version: '',
  stages: [],
  onlyMine: false,
  hideOldClosed: true,
  types: [],
};

export const ALL_TYPES = ['需求', '编码任务', 'BUG及数据问题', '其他任务'];

interface Props {
  value: FilterState;
  onChange: (v: FilterState) => void;
  components: NamedRef[];
  versions?: Version[];
  showStages?: boolean;
  showTypes?: boolean;
  children?: React.ReactNode;
}

export function FilterBar({ value, onChange, components, versions, showStages = true, showTypes = false, children }: Props) {
  // 关键字输入防抖，避免每个字都发一次 JQL
  const [text, setText] = useState(value.text);
  useEffect(() => setText(value.text), [value.text]);
  useEffect(() => {
    if (text === value.text) return;
    const t = setTimeout(() => onChange({ ...value, text }), 350);
    return () => clearTimeout(t);
  }, [text, value, onChange]);

  const toggleIn = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  return (
    <div className="toolbar">
      <input
        className="input"
        type="search"
        placeholder="搜索标题或输入编号，如 YLZHXT-123"
        aria-label="搜索"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {components.length > 0 && (
        <select
          className="select"
          aria-label="模块"
          value={value.component}
          onChange={(e) => onChange({ ...value, component: e.target.value })}
        >
          <option value="">全部模块</option>
          {components.map((c) => (
            <option key={c.id} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      )}
      {!!versions?.length && <VersionFilter value={value.version} versions={versions} onChange={(version) => onChange({ ...value, version })} />}
      {showTypes &&
        ALL_TYPES.map((t) => (
          <button
            key={t}
            className="chip"
            aria-pressed={value.types.includes(t)}
            onClick={() => onChange({ ...value, types: toggleIn(value.types, t) })}
          >
            {t}
          </button>
        ))}
      {showStages &&
        STAGES.map((s) => (
          <button
            key={s.id}
            className="chip"
            aria-pressed={value.stages.includes(s.id)}
            title={s.statuses.join('、')}
            onClick={() => onChange({ ...value, stages: toggleIn(value.stages, s.id) })}
          >
            {s.name}
          </button>
        ))}
      <button className="chip" aria-pressed={value.onlyMine} onClick={() => onChange({ ...value, onlyMine: !value.onlyMine })}>
        只看我的
      </button>
      <button
        className="chip"
        aria-pressed={value.hideOldClosed}
        title="隐藏 30 天前就已结束的问题"
        onClick={() => onChange({ ...value, hideOldClosed: !value.hideOldClosed })}
      >
        隐藏历史已结束
      </button>
      {!isDefaultFilter({ ...value, text }) && (
        <button
          className="chip chip-clear"
          title="恢复默认筛选（筛选条件按项目自动记住）"
          onClick={() => {
            setText('');
            onChange({ ...DEFAULT_FILTER });
          }}
        >
          ✕ 清空筛选
        </button>
      )}
      <span className="grow" />
      {children}
    </div>
  );
}

/** 版本：下拉可选全部版本（按未发布/已发布/已归档分组），旁边放最近要发布的几个做快捷切换 */
function VersionFilter({ value, versions, onChange }: { value: string; versions: Version[]; onChange: (v: string) => void }) {
  const quick = quickVersions(versions, 3);
  const groups = versionGroups(versions);
  return (
    <span className="version-filter" role="group" aria-label="版本">
      <select
        className={`select${value ? ' is-set' : ''}`}
        aria-label="版本"
        title="按影响版本筛选"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">全部版本</option>
        <option value={NO_VERSION}>未设置版本</option>
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.items.map((v) => (
              <option key={v.id} value={v.name}>
                {v.name}
                {shortDate(v.releaseDate) ? `（${shortDate(v.releaseDate)}）` : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {quick.map((v) => (
        <button
          key={v.id}
          className="chip chip-version"
          aria-pressed={value === v.name}
          title={`${v.name}${v.releaseDate ? ` · 计划 ${v.releaseDate} 发布` : ''}${v.description ? `\n${v.description}` : ''}\n再点一次取消`}
          onClick={() => onChange(value === v.name ? '' : v.name)}
        >
          {v.name}
          {shortDate(v.releaseDate) && <small>{shortDate(v.releaseDate)}</small>}
        </button>
      ))}
    </span>
  );
}
