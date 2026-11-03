import { useState } from 'react';
import { api, LIST_FIELDS } from '../lib/api';
import { MINE_CLAUSE, quote } from '../lib/jql';
import { STAGES, stageOf, type StageId } from '../lib/stages';
import { relativeTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { useSession } from '../lib/session';
import type { Issue, SearchResult } from '../lib/types';
import { StatusPill, TypeBadge } from '../components/Badges';
import { NO_VERSION, versionNames } from '../lib/versions';
import { Empty, ErrorState, Loading } from '../components/States';
import { CopyIssueButton } from '../components/CopyIssue';

const ACTIVE_STAGES: StageId[] = ['todo', 'design', 'dev', 'test'];
const ACTIVE_STATUSES = STAGES.filter((s) => ACTIVE_STAGES.includes(s.id)).flatMap((s) => s.statuses);
const statusList = `(${ACTIVE_STATUSES.map((s) => `"${s}"`).join(', ')})`;

// 我是经办人/开发人员/测试人员，且未结束；projectKey 为空时跨项目
const jqlOf = (projectKey: string | null) =>
  `${projectKey ? `project = ${quote(projectKey)} AND ` : ''}${MINE_CLAUSE} AND status in ${statusList} ORDER BY priority ASC, updated DESC`;

type Quick = 'all' | 'urgent' | 'bug';
const QUICK: Record<Quick, (i: Issue) => boolean> = {
  all: () => true,
  urgent: (i) => i.fields.priority?.name === '特急',
  bug: (i) => i.fields.issuetype.name === 'BUG及数据问题',
};
// 每组默认只显示前几条，避免某一阶段几十条把页面撑得很长
const FOLD_AT = 6;
const VER_CHIPS = 5;

export function MyWorkView({ projectKey, onOpen }: { projectKey: string | null; onOpen: (key: string) => void }) {
  const { version } = useSession();
  const [quick, setQuick] = useState<Quick>('all');
  // 版本快捷筛选（只在当前结果里过滤，不重新查询）；切项目时清掉
  const [ver, setVer] = useState({ project: projectKey, name: '' });
  const verName = ver.project === projectKey ? ver.name : '';
  const [open, setOpen] = useState<Set<StageId>>(new Set());
  const { data, error, reload } = useAsync<SearchResult>(
    (signal) => api.search(jqlOf(projectKey), { maxResults: 200, fields: [...LIST_FIELDS, 'project'] }, signal),
    [version, projectKey],
  );
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (!data.issues.length) return <Empty text={projectKey ? `在 ${projectKey} 手上没有进行中的问题` : '手上没有进行中的问题'} />;

  const verOf = (i: Issue) => versionNames(i.fields.versions);
  const byVersion = (i: Issue) => !verName || (verName === NO_VERSION ? !verOf(i).length : verOf(i).includes(verName));
  const shown = data.issues.filter((i) => QUICK[quick](i) && byVersion(i));
  const verCounts = versionCounts(data.issues);
  // 版本多时只把条数最多的几个做成按钮，其余收进下拉；选中的版本始终显示为按钮
  const verChips = verCounts.slice(0, VER_CHIPS);
  const picked = verCounts.find(([n]) => n === verName);
  if (picked && !verChips.includes(picked)) verChips.push(picked);
  const verMore = verCounts.filter((x) => !verChips.includes(x));
  const groups = new Map<StageId, Issue[]>(ACTIVE_STAGES.map((s) => [s, []]));
  for (const issue of shown) {
    const st = stageOf(issue.fields.status.name);
    if (st && groups.has(st)) groups.get(st)!.push(issue);
  }
  const urgent = data.issues.filter(QUICK.urgent).length;
  const bugs = data.issues.filter(QUICK.bug).length;
  const pick = (q: Quick) => setQuick((cur) => (cur === q && q !== 'all' ? 'all' : q));
  const toggle = (sid: StageId) => setOpen((o) => (o.has(sid) ? new Set([...o].filter((x) => x !== sid)) : new Set([...o, sid])));

  const stats: { q: Quick; n: number; label: string; color?: string }[] = [
    { q: 'all', n: data.total, label: '进行中' },
    { q: 'urgent', n: urgent, label: '特急', color: 'var(--danger)' },
    { q: 'bug', n: bugs, label: '缺陷' },
  ];

  return (
    <>
      <div className="stat-row" role="group" aria-label="快速筛选">
        {stats.map((x, i) => (
          <button
            key={x.q}
            className="stat stat-btn"
            aria-pressed={quick === x.q}
            disabled={x.n === 0 && x.q !== 'all'}
            title={x.q === 'all' ? '显示全部' : quick === x.q ? '再点一次取消筛选' : `只看${x.label}`}
            style={{ animationDelay: `${i * 60}ms` }}
            onClick={() => pick(x.q)}
          >
            <b style={x.color ? { color: x.color } : undefined}>{x.n}</b>
            <span>{x.label}</span>
          </button>
        ))}
        {data.total > data.issues.length && <div className="banner">仅统计前 {data.issues.length} 条</div>}
      </div>
      {verCounts.length > 0 && (
        <div className="desk-versions" role="group" aria-label="按版本筛选">
          <span className="muted">版本</span>
          {verChips.map(([name, n]) => (
            <button
              key={name}
              className="chip chip-version"
              aria-pressed={verName === name}
              title={verName === name ? '再点一次取消' : `只看${name === NO_VERSION ? '未设置版本' : name}`}
              onClick={() => setVer({ project: projectKey, name: verName === name ? '' : name })}
            >
              {name === NO_VERSION ? '未设置' : name}
              <small>{n}</small>
            </button>
          ))}
          {verMore.length > 0 && (
            <select
              className={`select select-sm${verMore.some(([n]) => n === verName) ? ' is-set' : ''}`}
              aria-label="更多版本"
              value={verMore.some(([n]) => n === verName) ? verName : ''}
              onChange={(e) => setVer({ project: projectKey, name: e.target.value })}
            >
              <option value="">更多 {verMore.length} 个版本…</option>
              {verMore.map(([name, n]) => (
                <option key={name} value={name}>
                  {name === NO_VERSION ? '未设置版本' : name}（{n}）
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {shown.length === 0 && <Empty text="没有符合条件的问题" />}
      <div className="desk">
        {ACTIVE_STAGES.map((sid, i) => {
          const items = groups.get(sid)!;
          // 筛选后没有内容的阶段直接隐藏，减少空卡片
          if ((quick !== 'all' || verName) && items.length === 0) return null;
          const expanded = open.has(sid);
          const visible = expanded ? items : items.slice(0, FOLD_AT);
          return (
            <section className="desk-group" key={sid} style={{ animationDelay: `${i * 70}ms` }}>
              <h3>
                <span className={`stage-${sid}`}>
                  <span style={{ color: 'var(--ink)' }}>{STAGES.find((s) => s.id === sid)!.name}</span>
                </span>
                <span className="mono muted">{items.length}</span>
              </h3>
              {items.length === 0 && <div className="desk-empty">无</div>}
              <div className={expanded ? 'desk-items expanded' : 'desk-items'}>
                {visible.map((issue) => (
                  <div className="desk-row" key={issue.key}>
                    <button className="desk-item" onClick={() => onOpen(issue.key)}>
                      <TypeBadge type={issue.fields.issuetype.name} />
                      <span className="mono muted">{issue.key}</span>
                      <span className="summary" title={[issue.fields.summary, ...verOf(issue).map((n) => `版本：${n}`)].join('\n')}>
                        {issue.fields.summary}
                      </span>
                      <StatusPill status={issue.fields.status.name} />
                      <span className="muted desk-time">{relativeTime(issue.fields.updated)}</span>
                    </button>
                    <CopyIssueButton issueKey={issue.key} summary={issue.fields.summary} className="row-action desk-copy" />
                  </div>
                ))}
              </div>
              {items.length > FOLD_AT && (
                <button className="desk-more" aria-expanded={expanded} onClick={() => toggle(sid)}>
                  {expanded ? '收起' : `展开其余 ${items.length - FOLD_AT} 条`}
                </button>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

/** 手上问题涉及的版本及条数，按条数倒序；未设置版本的放最后 */
export function versionCounts(issues: Issue[]): [string, number][] {
  const m = new Map<string, number>();
  let none = 0;
  for (const i of issues) {
    const names = versionNames(i.fields.versions);
    if (!names.length) none++;
    for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
  }
  const list = [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // 只有一种情况（全部同版本或全都没设）时不需要筛选
  if (list.length + (none ? 1 : 0) < 2) return [];
  return none ? [...list, [NO_VERSION, none]] : list;
}
