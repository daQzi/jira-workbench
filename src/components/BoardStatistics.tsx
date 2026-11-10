import { useMemo, useState } from 'react';
import { chartCounts, peopleCounts, kindMatches, ownerOf, OWNER_ROLES, ISSUE_KINDS, unmappedCount, UNASSIGNED, type OwnerRole, type IssueKind, type PersonCount } from '../lib/board';
import type { BoardStats } from '../lib/useBoardData';
import { Modal } from './Modal';
import { ManagementTable } from './ManagementTable';

interface Props { data?: BoardStats; open: boolean; onToggle: () => void; onOpen: (key: string) => void; scope: string; stale: boolean; onRetry: () => void }
function readRole(scope: string): OwnerRole { try { const value = localStorage.getItem(`wb.board.role:${scope}`); if (value && value in OWNER_ROLES) return value as OwnerRole; } catch { /* 仅影响偏好 */ } return 'assignee'; }

export function BoardStatistics({ data, open, onToggle, onOpen, scope, stale, onRetry }: Props) {
  const [role, setRole] = useState<OwnerRole>(() => readRole(scope));
  const [right, setRight] = useState<'task' | 'bug'>('task');
  const [detail, setDetail] = useState<{ person: PersonCount; kind: IssueKind } | null>(null);
  const issues = data?.issues ?? [];
  const all = useMemo(() => peopleCounts(issues, role), [issues, role]);
  const colors = new Map(all.map(p => p.name).filter(n => n !== UNASSIGNED).sort().map((name, index) => [name, `hsl(${(245 + index * 137.508) % 360} 48% var(--chart-lightness))`]));
  colors.set('__others__', 'var(--chart-6)'); colors.set(UNASSIGNED, 'var(--ink-3)');
  const selection = detail ? issues.filter(i => kindMatches(i, detail.kind) && detail.person.members.includes(ownerOf(i, role).name)) : [];
  const unknown = unmappedCount(issues);
  const partial = !data?.complete;
  const kinds: IssueKind[] = ['requirement', 'coding', 'other', 'bug'];
  return <section className="board-statistics" aria-label="人员分布统计">
    <div className="board-statistics-head">
      <div><h2>人员分布 <span className="muted">按问题数量</span></h2><p className="muted">跟随上方筛选 · 需求、任务分别计算占比 · 按{OWNER_ROLES[role]}唯一归属</p></div>
      <div className="board-statistics-controls">
        {open && <label>归属口径 <select className="select" aria-label="统计归属口径" value={role} onChange={e => {
          const next = e.target.value as OwnerRole; setRole(next); setDetail(null); try { localStorage.setItem(`wb.board.role:${scope}`, next); } catch { /* 不影响统计 */ }
        }}>{Object.entries(OWNER_ROLES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>}
        <button className="btn small ghost" aria-expanded={open} onClick={onToggle}>{open ? '收起统计' : '展开统计'}</button>
      </div>
    </div>
    {open && <>
      <div className="board-statistics-progress" role="status">
        {!data ? '等待卡片首屏，随后加载统计…' : data.loading ? `正在补齐统计 ${issues.length} / ${data.total || '…'} 项` : data.error ? `统计同步失败：${data.error}` : data.complete ? `已统计 ${issues.length} 项` : `已加载 ${issues.length} / ${data.total} 项，统计不完整，请缩小版本或其他筛选范围`}
        {(data?.loading || partial || stale) && <span className="muted"> · 当前图表基于已加载结果{stale ? '，缓存正在核对' : ''}</span>}
        {data?.error && <button className="text-btn" onClick={onRetry}>重新同步</button>}
      </div>
      {!data?.issues.length && (!data || data.loading) ? <div className="board-chart-skeleton" aria-label="统计加载中"><div className="skeleton"/><div className="skeleton"/></div> : <>
        <div className="board-charts">
          <Distribution title="需求分布" label="需求" counts={peopleCounts(issues, role, 'requirement')} colors={colors} onPick={person => setDetail({ person, kind: 'requirement' })} />
          <Distribution title={right === 'task' ? '任务分布' : 'Bug 分布'} label={ISSUE_KINDS[right]} counts={peopleCounts(issues, role, right)} colors={colors} onPick={person => setDetail({ person, kind: right })}>
            <select className="select" aria-label="右侧统计类型" value={right} onChange={e => setRight(e.target.value as 'task' | 'bug')}><option value="task">编码任务＋其他任务</option><option value="bug">Bug 及数据问题</option></select>
          </Distribution>
        </div>
        <div className="board-statistics-note muted">任务包含编码任务和其他任务，Bug 单列；父需求与子任务各计一项，数量占比不代表工时。{unknown > 0 && ` 含 ${unknown} 项未映射阶段的事项。`}</div>
        <details className="board-person-table"><summary>展开全员对照明细</summary><div className="board-person-table-scroll"><table><thead><tr><th>人员</th>{kinds.map(kind => <th key={kind}>{ISSUE_KINDS[kind]}</th>)}<th>合计</th></tr></thead><tbody>{all.map(person => <tr key={person.name}><th><span data-full-text={`${person.displayName}（${person.name === UNASSIGNED ? '对应字段未设置' : person.name}）`}>{person.displayName}</span></th>{kinds.map(kind => {
          const count = issues.filter(i => kindMatches(i, kind) && ownerOf(i, role).name === person.name).length;
          return <td key={kind}><button className="text-btn" disabled={!count} aria-label={`查看${person.displayName}的${ISSUE_KINDS[kind]} ${count} 项`} onClick={() => setDetail({ person, kind })}>{count}</button></td>;
        })}<td>{person.count}</td></tr>)}</tbody></table></div></details>
      </>}
    </>}
    {detail && <Modal width={1100} title={`${detail.person.displayName} · ${ISSUE_KINDS[detail.kind]} ${selection.length} 项`} onClose={() => setDetail(null)}>
      <p className="muted">按{OWNER_ROLES[role]}精确匹配 · 沿用看板筛选{partial ? ' · 当前统计未完整，仅展示已加载结果' : ''}{stale ? ' · 当前为缓存结果' : ''}</p>
      <ManagementTable issues={selection} scope="board-statistics" readOnly onOpen={key => { setDetail(null); onOpen(key); }}/>
    </Modal>}
  </section>;
}
function Distribution({ title, label, counts, colors, onPick, children }: { title: string; label: string; counts: PersonCount[]; colors: Map<string, string>; onPick: (person: PersonCount) => void; children?: React.ReactNode }) {
  const groups = chartCounts(counts), total = counts.reduce((sum, p) => sum + p.count, 0);
  let angle = -Math.PI / 2;
  const segments = groups.map(person => {
    const start = angle; angle += person.count / total * Math.PI * 2;
    const end = angle - (angle - start >= Math.PI * 2 ? .00001 : 0);
    const point = (a: number, r: number) => `${100 + Math.cos(a) * r},${100 + Math.sin(a) * r}`;
    const large = end - start > Math.PI ? 1 : 0;
    return { person, d: `M${point(start, 82)} A82,82 0 ${large} 1 ${point(end, 82)} L${point(end, 57)} A57,57 0 ${large} 0 ${point(start, 57)} Z` };
  });
  const share = (person: PersonCount) => `${(person.count / total * 100).toFixed(1).replace(/\.0$/, '')}%`;
  return <section className="board-distribution" aria-label={title}><header><h3>{title}</h3>{children}</header><div className="board-distribution-body">
    <svg viewBox="0 0 200 200" role="img" aria-label={`${title}，共 ${total} 项，${groups.map(p => `${p.displayName} ${p.count} 项`).join('，')}`}>
      {!total && <circle cx="100" cy="100" r="70" fill="none" stroke="var(--line-2)" strokeWidth="24"/>}
      {segments.map(({ person, d }) => <path key={person.name} d={d} fill={colors.get(person.name)} data-full-text={`${person.displayName}${person.name.startsWith('__') ? '' : `（${person.name}）`} · ${person.count} 项 · ${share(person)}`} onClick={() => onPick(person)}/>)}
      <text x="100" y="100" textAnchor="middle" className="board-donut-total">{total}</text><text x="100" y="126" textAnchor="middle" className="board-donut-label">{total ? label : '暂无数据'}</text>
    </svg>
    <div className="board-chart-legend">{groups.length ? groups.map(person => <button key={person.name} aria-label={`查看${person.displayName}的${label} ${person.count} 项`} onClick={() => onPick(person)}>
      <i style={{ background: colors.get(person.name) }}/><span data-full-text={`${person.displayName}${person.name.startsWith('__') ? '' : `（${person.name}）`}`}>{person.displayName}{counts.some(other => other.name !== person.name && other.displayName === person.displayName) && `（${person.name}）`}</span><b>{person.count}</b><small>{share(person)}</small>
    </button>) : <p className="muted">当前筛选下没有{label}</p>}</div>
  </div></section>;
}
