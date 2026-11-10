import type { ReactNode } from 'react';
import { stageOf } from '../lib/stages';
import { userName } from '../lib/format';
import { versionNames } from '../lib/versions';

const TYPE_SHORT: Record<string, string> = {
  需求: '需求',
  编码任务: '任务',
  BUG及数据问题: '缺陷',
  其他任务: '其他',
};

export function TypeBadge({ type }: { type: string }) {
  return (
    <span className={`type-badge type-${type}`} title={type}>
      {TYPE_SHORT[type] ?? type}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const stage = stageOf(status);
  return (
    <span className={`status-pill stage-${stage ?? 'unknown'}`} title={stage ? undefined : '未归入看板阶段的状态'}>
      {status}
    </span>
  );
}

export function Priority({ name }: { name?: string }) {
  if (!name) return <span className="muted">-</span>;
  return <span className={`prio prio-${name}`}>{name}</span>;
}

/** 影响版本标签；多个时显示前 max 个，其余收进 +N（悬停看全部） */
export function VersionTags({ versions, max = 2, empty = <span className="muted">-</span> }: { versions: unknown; max?: number; empty?: ReactNode }) {
  const names = versionNames(versions);
  if (!names.length) return <>{empty}</>;
  const more = names.length - max;
  return (
    <span className="version-tags" data-full-text={names.join('\n')}>
      {names.slice(0, max).map((n) => (
        <span key={n} className="version-tag">
          {n}
        </span>
      ))}
      {more > 0 && <span className="version-tag more">+{more}</span>}
    </span>
  );
}

export function Person({ user, placeholder = '未分配' }: { user: unknown; placeholder?: string }) {
  const name = userName(user);
  if (!name) return <span className="muted">{placeholder}</span>;
  return (
    <span className="person" title={name}>
      <span className="avatar" aria-hidden="true">
        {name.slice(-2)}
      </span>
      {name}
    </span>
  );
}

export function ProgressBar({ done, total }: { done: number; total: number }) {
  if (!total) return <span className="muted">-</span>;
  const pct = Math.round((done / total) * 100);
  return (
    <span className="progress" title={`子项完成 ${done}/${total}`}>
      <span className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${pct}%` }} />
      </span>
      {done}/{total}
    </span>
  );
}
