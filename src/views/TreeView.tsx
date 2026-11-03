import { Fragment, useMemo, useState } from 'react';
import { api, fetchByKeys, LIST_FIELDS } from '../lib/api';
import { buildJql } from '../lib/jql';
import { CLOSED_STATUSES } from '../lib/stages';
import { childLinks, childProgress, parentOf, resolveChildren } from '../lib/tree';
import { relativeTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { useSession } from '../lib/session';
import type { Issue } from '../lib/types';
import { Person, Priority, ProgressBar, TypeBadge, VersionTags } from '../components/Badges';
import { AssigneeCell, StatusMenu } from '../components/InlineEdit';
import { QuickAdd } from '../components/QuickAdd';
import { Empty, ErrorState, Loading } from '../components/States';
import { CopyIssueButton } from '../components/CopyIssue';
import type { FilterState } from '../components/FilterBar';
import type { CreateTarget } from '../components/CreateDialog';

const PAGE_SIZE = 50;
const COLS = 8;

interface Props {
  projectKey: string;
  filter: FilterState;
  mode: 'tree' | 'flat';
  selectedKey: string | null;
  onOpen: (key: string) => void;
  onCreate: (t: CreateTarget) => void;
}

interface PageData {
  total: number;
  issues: Issue[];
  children: Map<string, Issue>;
}

export function TreeView({ projectKey, filter, mode, selectedKey, onOpen, onCreate }: Props) {
  const { version, bump, canWriteProject } = useSession();
  const writable = canWriteProject(projectKey);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 正在快速添加子项的需求
  const [adding, setAdding] = useState<string | null>(null);
  const filterKey = JSON.stringify([projectKey, filter, mode]);
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    // 筛选条件变化时回到第一页
    setLastFilterKey(filterKey);
    setPage(0);
  }

  const jql = useMemo(
    () =>
      buildJql({
        project: projectKey,
        types: mode === 'tree' ? ['需求'] : filter.types,
        component: filter.component,
        version: filter.version,
        text: filter.text,
        stages: filter.stages,
        onlyMine: filter.onlyMine,
        recentClosedDays: filter.hideOldClosed ? 30 : undefined,
        closedStatuses: CLOSED_STATUSES,
      }),
    [projectKey, filter, mode],
  );

  const { data, error, loading, reload } = useAsync<PageData>(
    async (signal) => {
      const r = await api.search(jql, { startAt: page * PAGE_SIZE, maxResults: PAGE_SIZE, fields: LIST_FIELDS }, signal);
      // 树模式下一次性补齐本页所有子项的完整字段（链接里没有经办人等）
      const childKeys = mode === 'tree' ? r.issues.flatMap((i) => childLinks(i).map((c) => c.key)) : [];
      const children = childKeys.length ? await fetchByKeys(childKeys, signal) : new Map();
      return { total: r.total, issues: r.issues, children };
    },
    [jql, page, mode, version],
  );

  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  const toggle = (key: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const allExpanded = data.issues.every((i) => !childLinks(i).length || expanded.has(i.key));
  const toggleAll = () =>
    setExpanded(allExpanded ? new Set() : new Set(data.issues.filter((i) => childLinks(i).length).map((i) => i.key)));
  const startAdd = (key: string) => {
    setExpanded((s) => new Set(s).add(key));
    setAdding(key);
  };

  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  return (
    <div style={{ opacity: loading ? 0.6 : 1, transition: 'opacity .15s' }}>
      {error && <div className="banner">刷新失败：{error.message}</div>}
      {writable && mode === 'tree' && page === 0 && (
        <div className="quick-row">
          <QuickAdd
            projectKey={projectKey}
            typeName="需求"
            placeholder="＋ 快速新建需求：输入标题回车"
            onCreated={bump}
            onNeedForm={(summary) => onCreate({ projectKey, typeName: '需求', summary })}
          />
        </div>
      )}
      {data.issues.length === 0 ? (
        <Empty text="没有符合条件的问题" />
      ) : (
        <table className="tree-table">
          <thead>
            <tr>
              <th className="title-th">
                {mode === 'tree' ? (
                  <button className="chip" style={{ height: 22 }} onClick={toggleAll}>
                    {allExpanded ? '全部收起' : '全部展开'}
                  </button>
                ) : (
                  '标题'
                )}
              </th>
              <th>状态</th>
              <th className="hide-sm">{mode === 'tree' ? '子项进度' : '所属需求'}</th>
              <th>经办人</th>
              <th className="hide-sm">开发人员</th>
              <th className="hide-sm">版本</th>
              <th className="hide-sm">优先级</th>
              <th className="hide-sm">更新</th>
            </tr>
          </thead>
          <tbody>
            {data.issues.map((issue, idx) => {
              const kids = mode === 'tree' ? resolveChildren(issue, data.children) : [];
              const open = expanded.has(issue.key);
              const isStory = issue.fields.issuetype.name === '需求';
              return (
                <Fragment key={issue.key}>
                  <Row
                    issue={issue}
                    delay={idx}
                    selected={selectedKey === issue.key}
                    onOpen={onOpen}
                    onChanged={bump}
                    toggle={kids.length ? { open, onToggle: () => toggle(issue.key), count: kids.length } : undefined}
                    onAddChild={writable && isStory ? () => startAdd(issue.key) : undefined}
                    extra={
                      mode === 'tree' ? (
                        <ProgressBar {...childProgress(issue)} />
                      ) : (
                        <ParentCell issue={issue} onOpen={onOpen} />
                      )
                    }
                    showSpacer={mode === 'tree'}
                  />
                  {open &&
                    kids.map((k) => (
                      <Row key={k.key} issue={k} child selected={selectedKey === k.key} onOpen={onOpen} onChanged={bump} extra={null} />
                    ))}
                  {adding === issue.key && (
                    <tr className="child add-row">
                      <td colSpan={COLS} className="title-td">
                        <div className="add-child">
                          <QuickAdd
                            projectKey={projectKey}
                            typeName="编码任务"
                            parent={{ key: issue.key, fields: issue.fields }}
                            placeholder="输入子任务标题回车（编码任务，继承模块等字段），Esc 取消"
                            autoFocus
                            onCreated={bump}
                            onCancel={() => setAdding(null)}
                            onNeedForm={(summary) =>
                              onCreate({ projectKey, typeName: '编码任务', parent: { key: issue.key, summary: issue.fields.summary }, summary })
                            }
                          />
                          <button
                            className="btn"
                            onClick={() => onCreate({ projectKey, parent: { key: issue.key, summary: issue.fields.summary } })}
                          >
                            完整表单 / 批量 / 其他类型
                          </button>
                          <button className="btn ghost" onClick={() => setAdding(null)}>
                            完成
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="table-foot">
        <span>
          共 {data.total} 条{mode === 'tree' ? '需求' : ''}
          {loading && ' · 加载中…'}
        </span>
        {pages > 1 && (
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>
              上一页
            </button>
            <span className="mono">
              {page + 1} / {pages}
            </span>
            <button className="btn" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
              下一页
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

function ParentCell({ issue, onOpen }: { issue: Issue; onOpen: (k: string) => void }) {
  const p = parentOf(issue);
  if (!p) return <span className="muted">-</span>;
  return (
    <button
      className="link-btn mono"
      title={p.fields.summary}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(p.key);
      }}
    >
      {p.key}
    </button>
  );
}

interface RowProps {
  issue: Issue;
  child?: boolean;
  delay?: number;
  selected: boolean;
  onOpen: (key: string) => void;
  onChanged: () => void;
  onAddChild?: () => void;
  toggle?: { open: boolean; onToggle: () => void; count: number };
  extra: React.ReactNode;
  showSpacer?: boolean;
}

function Row({ issue, child, delay = 0, selected, onOpen, onChanged, onAddChild, toggle, extra, showSpacer }: RowProps) {
  const f = issue.fields;
  return (
    <tr
      className={`row${child ? ' child' : ''}${selected ? ' selected' : ''}`}
      style={{ animationDelay: `${Math.min(delay, 20) * 15}ms` }}
      onClick={() => onOpen(issue.key)}
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && onOpen(issue.key)}
    >
      <td className="title-td">
        <div className="title-cell">
          {toggle ? (
            <button
              className="toggle"
              aria-expanded={toggle.open}
              aria-label={toggle.open ? '收起子项' : '展开子项'}
              onClick={(e) => {
                e.stopPropagation();
                toggle.onToggle();
              }}
            >
              ▶
            </button>
          ) : (
            !child && showSpacer && <span className="toggle-spacer" />
          )}
          <TypeBadge type={f.issuetype.name} />
          <span className="mono muted issue-key">{issue.key}</span>
          <span className="summary" title={f.summary}>
            {f.summary}
          </span>
          {toggle && <span className="child-count">{toggle.count}</span>}
          <span className="row-actions">
          <CopyIssueButton issueKey={issue.key} summary={f.summary} />
          {onAddChild && (
            <button
              className="row-action"
              title="新建子项"
              aria-label={`在 ${issue.key} 下新建子项`}
              onClick={(e) => {
                e.stopPropagation();
                onAddChild();
              }}
            >
              ＋子项
            </button>
          )}
          </span>
        </div>
      </td>
      <td>
        <StatusMenu issue={issue} onChanged={onChanged} />
      </td>
      <td className="hide-sm">{extra}</td>
      <td>
        <AssigneeCell issue={issue} onChanged={onChanged} />
      </td>
      <td className="hide-sm">
        <Person user={f.customfield_10204} placeholder="-" />
      </td>
      <td className="hide-sm">
        <VersionTags versions={f.versions} />
      </td>
      <td className="hide-sm">
        <Priority name={f.priority?.name} />
      </td>
      <td className="hide-sm muted" title={f.updated}>
        {relativeTime(f.updated)}
      </td>
    </tr>
  );
}
