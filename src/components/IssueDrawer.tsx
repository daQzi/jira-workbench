import { useEffect, useMemo, useRef, useState } from 'react';
import { useDialogFocus } from '../lib/useDialogFocus';
import { api, fetchByKeys, fileUrl, type Transition } from '../lib/api';
import { useSession } from '../lib/session';
import { useTransition } from '../lib/useTransition';
import { AssigneeCell } from './InlineEdit';
import type { CreateTarget } from './CreateDialog';
import { childLinkIds, childLinks, childProgress, otherLinks, parentLinks, resolveChildren } from '../lib/tree';
import { fieldText, formatDateTime, relativeTime, sanitizeHtml, userName } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import type { Attachment, Issue, IssueDetail, LinkedIssue } from '../lib/types';
import { IssuePicker } from './IssuePicker';
import { AttachmentDrop, filesFromClipboard, formatSize } from './AttachmentDrop';
import { issueLinkBody, linkOptions, relationLabel, type LinkOption } from '../lib/links';
import { getLinkTypes } from '../lib/linkTypes';
import { CHILD_TYPES } from '../lib/create';
import { Person, Priority, ProgressBar, StatusPill, TypeBadge } from './Badges';
import { ErrorState, Loading } from './States';
import { EditableField } from './EditableField';
import { useCopyIssue } from './CopyIssue';
import { rememberIssue } from '../lib/recent';
import type { FieldMetaMap } from '../lib/fields';
import { canDeleteAttachment, canDeleteComment, canEditComment, type Perms } from '../lib/permissions';
import type { Comment } from '../lib/types';

interface Props {
  issueKey: string;
  jiraBaseUrl: string;
  /** 当前全局项目；打开的问题不属于它时提示并可一键切换 */
  currentProject?: string | null;
  onSwitchProject?: (key: string) => void;
  onOpen: (key: string) => void;
  onClose: () => void;
  onCreate: (t: CreateTarget) => void;
}

// 没有值也在侧栏露出（可编辑时），方便补工时相关字段
const ALWAYS_SHOW = new Set(['开发预估时间', '预估时间', '开始开发日期', '开发完成日期', '到期日']);

// 侧栏单独展示的字段，不在“其他字段”里重复
const SIDE_FIELDS = new Set([
  'summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'components', 'created', 'updated',
  'issuelinks', 'description', 'comment', 'project', 'customfield_10204', 'customfield_10401', 'customfield_10400',
  'attachment', 'worklog', 'watches', 'votes', 'progress', 'aggregateprogress', 'timetracking', 'lastViewed',
  'workratio', 'customfield_11100', 'customfield_11101', 'customfield_11201',
]);

export function IssueDrawer({ issueKey, jiraBaseUrl, currentProject = null, onSwitchProject, onOpen, onClose, onCreate }: Props) {
  const { version } = useSession();
  const [tab, setTab] = useState<'comments' | 'history'>('comments');
  const { data, error, loading, reload } = useAsync<IssueDetail>(
    signal => api.issue(issueKey, signal),
    [issueKey, version],
  );

  const drawerRef = useRef<HTMLElement>(null);
  useDialogFocus(drawerRef, () => { if (!document.querySelector('.modal-mask, .lightbox')) onClose(); });
  const issue = data?.key === issueKey ? data : null;
  const related = useAsync(async signal => {
    if (!issue) return null;
    const keys = childLinks(issue).map(c => c.key);
    return { issue, full: keys.length ? await fetchByKeys(keys, signal) : new Map<string, Issue>() };
  }, [issue]);
  const children = issue ? resolveChildren(issue, related.data?.issue === issue ? related.data.full : new Map()) : [];

  // 记入「最近查看」，供 ⌘K 面板使用
  useEffect(() => {
    if (!issue) return;
    const f = issue.fields;
    rememberIssue({ key: issue.key, summary: f.summary, type: f.issuetype.name, status: f.status.name });
  }, [issue]);

  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <aside ref={drawerRef} tabIndex={-1} className="drawer" role="dialog" aria-modal="true" aria-label={`问题 ${issueKey}`}>
        {!issue ? (
          <div style={{ padding: 20 }}>
            {error ? <ErrorState error={error} onRetry={reload} /> : <Loading rows={10} />}
          </div>
        ) : (
          <>
          {error && <div className="banner" role="alert">刷新失败：{error.message}<button className="text-btn" onClick={reload}>重试</button></div>}
          {loading && <div className="drawer-sync" role="status">正在同步最新详情…</div>}
          <DrawerContent
            key={issueKey}
            issue={issue}
            children={children}
            childrenLoading={related.loading || related.data?.issue !== issue}
            childrenError={related.error}
            onRetryChildren={related.reload}
            jiraBaseUrl={jiraBaseUrl}
            currentProject={currentProject}
            onSwitchProject={onSwitchProject}
            onOpen={onOpen}
            onClose={onClose}
            onCreate={onCreate}
            tab={tab}
            setTab={setTab}
          />
          </>
        )}
      </aside>
    </>
  );
}

interface ContentProps {
  issue: IssueDetail;
  children: Issue[];
  childrenLoading: boolean;
  childrenError: Error | null;
  onRetryChildren: () => void;
  jiraBaseUrl: string;
  currentProject: string | null;
  onSwitchProject?: (key: string) => void;
  onOpen: (key: string) => void;
  onClose: () => void;
  onCreate: (t: CreateTarget) => void;
  tab: 'comments' | 'history';
  setTab: (t: 'comments' | 'history') => void;
}

function DrawerContent({ issue, children, childrenLoading, childrenError, onRetryChildren, jiraBaseUrl, currentProject, onSwitchProject, onOpen, onClose, onCreate, tab, setTab }: ContentProps) {
  const { bump, canWriteIssue } = useSession();
  const writable = canWriteIssue(issue.key);
  const copy = useCopyIssue();
  const [editingDesc, setEditingDesc] = useState(false);
  // 可编辑字段以 editmeta 为准（Jira 按权限和界面方案返回）；拿不到就全部只读
  const { data: editMeta } = useAsync<FieldMetaMap>(
    () => (writable ? api.editMeta(issue.key).catch(() => ({})) : Promise.resolve({})),
    [issue.key, writable, issue.fields.updated],
  );
  const em = editMeta ?? {};
  // 评论/附件的编辑删除按钮按 Jira 权限显示；查询失败时不显示（不猜）
  const { data: perms } = useAsync<Perms>(
    () => (writable ? api.myPermissions(issue.key).catch(() => ({})) : Promise.resolve({})),
    [issue.key, writable],
  );
  const edit = (id: string, children: React.ReactNode, opts: { block?: boolean; className?: string } = {}) => (
    <EditableField issueKey={issue.key} id={id} meta={em[id]} raw={f[id]} onSaved={bump} {...opts}>
      {children}
    </EditableField>
  );
  const projectKey = issue.key.split('-')[0];
  const f = issue.fields;
  const isStory = f.issuetype.name === '需求';
  const parents = parentLinks(issue);
  const others = otherLinks(issue);
  const childIds = childLinkIds(issue);
  const progress = childProgress(issue);
  const description = useMemo(
    () => (issue.renderedFields?.description ? sanitizeHtml(issue.renderedFields.description, jiraBaseUrl) : ''),
    [issue, jiraBaseUrl],
  );
  const comments = issue.renderedFields?.comment?.comments ?? [];
  // 编辑评论需要原始 wiki 文本（renderedFields 里是 HTML）
  const rawComments = new Map(((f.comment as { comments?: Comment[] } | undefined)?.comments ?? []).map((c) => [c.id, c]));
  const histories = [...(issue.changelog?.histories ?? [])].reverse();

  // 自定义字段按 Jira 返回的名称展示，只显示有值的
  const extraFields = Object.entries(f)
    .filter(([id]) => !SIDE_FIELDS.has(id))
    .map(([id, v]) => ({ id, name: issue.names?.[id] ?? id, text: fieldText(v) }))
    .filter((x): x is { id: string; name: string; text: string } => (!!x.text && x.text.length < 2000) || (!x.text && !!em[x.id] && ALWAYS_SHOW.has(x.name)))
    .map((x) => ({ ...x, text: x.text ?? '' }));
  // 可编辑但当前为空的工时相关字段（Jira 不返回空字段时从 editmeta 补）
  for (const [id, m] of Object.entries(em)) {
    if (!SIDE_FIELDS.has(id) && ALWAYS_SHOW.has(m.name) && !extraFields.some((x) => x.id === id)) extraFields.push({ id, name: m.name, text: '' });
  }
  const longFields = extraFields.filter((x) => x.text.length > 60 || x.text.includes('\n'));
  const shortFields = extraFields.filter((x) => !longFields.includes(x));

  return (
    <>
      <header className="drawer-head">
        <div className="crumbs">
          <TypeBadge type={f.issuetype.name} />
          <span className="mono">{issue.key}</span>
          {currentProject && projectKey !== currentProject && (
            <span className="other-proj">
              其他项目 {projectKey}
              {onSwitchProject && (
                <button onClick={() => onSwitchProject(projectKey)} title={`把当前项目切换为 ${projectKey}`}>
                  切换到该项目
                </button>
              )}
            </span>
          )}
          {parents.length > 0 && (
            <span className="crumb-parents">
              {parents.map((p) => (
                <button key={p.key} className="crumb-parent" onClick={() => onOpen(p.key)} data-full-text={`所属需求：${p.key} ${p.fields.summary}`}>
                  <span aria-hidden="true">↑</span>
                  <span className="mono">{p.key}</span>
                  <span className="crumb-summary">{p.fields.summary}</span>
                </button>
              ))}
            </span>
          )}
          <span className="actions">
            <button className="btn" title="复制「编号 标题」，⇧ 点击连同 Jira 链接" onClick={(e) => copy(issue.key, f.summary, e.shiftKey)}>
              复制
            </button>
            <button className="btn" title="复制编号、标题和 Jira 链接" onClick={() => copy(issue.key, f.summary, true)}>
              复制链接
            </button>
            <a className="btn" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }} href={`${jiraBaseUrl}/browse/${issue.key}`} target="_blank" rel="noopener noreferrer">
              在 Jira 打开
            </a>
            <button className="btn" onClick={onClose} aria-label="关闭">
              ✕
            </button>
          </span>
        </div>
        <h2>{edit('summary', f.summary, { block: true })}</h2>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <StatusPill status={f.status.name} />
          {edit('priority', <Priority name={f.priority?.name} />)}
          <span className="muted">更新于 {relativeTime(f.updated)}</span>
        </div>
        {writable && <TransitionBar issue={issue} onChanged={bump} />}
      </header>
      <div className="drawer-body">
        <div className="drawer-main">
          <section className="section">
            <h4>
              描述
              {em.description && !editingDesc && (
                <button className="btn small" onClick={() => setEditingDesc(true)}>
                  编辑
                </button>
              )}
            </h4>
            <EditableField
              issueKey={issue.key}
              id="description"
              meta={em.description}
              raw={f.description}
              onSaved={bump}
              block
              editing={editingDesc}
              onEditingChange={setEditingDesc}
            >
              {description ? (
                <div className="rich" dangerouslySetInnerHTML={{ __html: description }} />
              ) : (
                <p className="muted">{em.description ? '暂无描述，点击添加' : '暂无描述'}</p>
              )}
            </EditableField>
          </section>

          {(children.length > 0 || isStory) && (
            <section className="section">
              <h4>
                子项 <ProgressBar {...progress} />
                {writable && isStory && (
                  <button
                    className="btn small"
                    onClick={() => onCreate({ projectKey, parent: { key: issue.key, summary: f.summary, fields: f } })}
                  >
                    ＋ 新建子项
                  </button>
                )}
              </h4>
              {childrenError ? <div className="banner" role="alert">子项同步失败：{childrenError.message}<button className="text-btn" onClick={onRetryChildren}>重试子项</button></div> : childrenLoading && <p className="muted" role="status">正在补齐子项信息…</p>}
              {children.length === 0 ? (
                <p className="muted">暂无子项</p>
              ) : (
                <div className="link-list">
                  {children.map((c) => (
                    <div className="link-row" key={c.key}>
                      <button className="link-item" onClick={() => onOpen(c.key)}>
                        <TypeBadge type={c.fields.issuetype.name} />
                        <span className="mono muted">{c.key}</span>
                        <span className="summary" data-full-text={`${c.key} ${c.fields.summary}`}>{c.fields.summary}</span>
                        <span style={{ fontSize: 12 }}>{userName(c.fields.assignee) || <span className="muted">未分配</span>}</span>
                        <StatusPill status={c.fields.status.name} />
                      </button>
                      {writable && childIds.get(c.key) && (
                        <Unlink linkId={childIds.get(c.key)!} what={`子项 ${c.key}`} done={`已把 ${c.key} 移出子项`} onDone={bump} />
                      )}
                    </div>
                  ))}
                </div>
              )}
              {writable && isStory && <LinkChild parentKey={issue.key} existing={children.map((c) => c.key)} onLinked={bump} />}
            </section>
          )}

          {(others.length > 0 || writable) && (
            <section className="section">
              <h4>关联问题</h4>
              {others.length > 0 ? (
                <div className="link-list">
                  {others.map(({ linkId, label, type, dir, issue: o }) => (
                    <div className="link-row" key={linkId}>
                      <LinkRow label={relationLabel(type, dir, label)} issue={o} onOpen={onOpen} />
                      {writable && <Unlink linkId={linkId} what={`与 ${o.key} 的关联`} done={`已移除与 ${o.key} 的关联`} onDone={bump} />}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">暂无关联</p>
              )}
              {writable && (
                <AddLink
                  issue={issue}
                  exclude={[issue.key, ...others.map((o) => o.issue.key), ...children.map((c) => c.key), ...parents.map((p) => p.key)]}
                  onLinked={bump}
                />
              )}
            </section>
          )}

          <Attachments issue={issue} writable={writable} perms={writable ? perms ?? {} : {}} onChanged={bump} />

          {longFields.map((x) => (
            <section className="section" key={x.id}>
              <h4>{x.name}</h4>
              {edit(
                x.id,
                <div className="rich" style={{ whiteSpace: 'pre-wrap' }}>
                  {x.text}
                </div>,
                { block: true },
              )}
            </section>
          ))}

          <section className="section">
            <h4>
              <span className="tabs" role="tablist">
                <button role="tab" aria-selected={tab === 'comments'} onClick={() => setTab('comments')}>
                  评论 {comments.length}
                </button>
                <button role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>
                  变更记录 {histories.length}
                </button>
              </span>
            </h4>
            {tab === 'comments' && writable && <CommentBox issueKey={issue.key} onAdded={bump} />}
            {tab === 'comments' &&
              (comments.length ? (
                comments.map((c) => (
                  <CommentItem
                    key={c.id}
                    issueKey={issue.key}
                    comment={c}
                    raw={rawComments.get(c.id)}
                    perms={writable ? perms ?? {} : {}}
                    jiraBaseUrl={jiraBaseUrl}
                    onChanged={bump}
                  />
                ))
              ) : (
                <p className="muted">暂无评论</p>
              ))}
            {tab === 'history' &&
              (histories.length ? (
                histories.map((h) => (
                  <div className="history-item" key={h.id}>
                    <span className="muted">
                      {formatDateTime(h.created)} {userName(h.author)}
                    </span>
                    {h.items.map((it, i) => (
                      <div key={i}>
                        {it.field}：{it.fromString || '空'} → <b>{it.toString || '空'}</b>
                      </div>
                    ))}
                  </div>
                ))
              ) : (
                <p className="muted">暂无变更</p>
              ))}
          </section>
        </div>

        <dl className="drawer-side">
          <SideItem label="经办人">
            <AssigneeCell issue={issue} onChanged={bump} />
          </SideItem>
          <SideItem label="开发人员">{edit('customfield_10204', <Person user={f.customfield_10204} placeholder="-" />)}</SideItem>
          <SideItem label="测试人员">{edit('customfield_10401', <Person user={f.customfield_10401} placeholder="-" />)}</SideItem>
          <SideItem label="产品经理">{edit('customfield_10400', <Person user={f.customfield_10400} placeholder="-" />)}</SideItem>
          {/* 一线对接人是文本字段；该类型有这个字段（有值或可编辑）才显示 */}
          {(typeof f.customfield_11201 === 'string' || em.customfield_11201) && (
            <SideItem label="一线对接人">{edit('customfield_11201', (f.customfield_11201 as string) || <span className="muted">未填写</span>)}</SideItem>
          )}
          <SideItem label="报告人">
            <Person user={f.reporter} placeholder="-" />
          </SideItem>
          <SideItem label="模块">{edit('components', f.components?.map((c) => c.name).join('、') || '-')}</SideItem>
          {shortFields.map((x) => (
            <SideItem key={x.id} label={x.name}>
              {edit(x.id, x.text || <span className="muted">未填写</span>)}
            </SideItem>
          ))}
          <SideItem label="创建">{formatDateTime(f.created)}</SideItem>
          <SideItem label="更新">{formatDateTime(f.updated)}</SideItem>
        </dl>
      </div>
    </>
  );
}

function SideItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function LinkRow({ label, issue, onOpen }: { label: string; issue: LinkedIssue; onOpen: (k: string) => void }) {
  return (
    <button className="link-item" onClick={() => onOpen(issue.key)}>
      <span className="rel">{label}</span>
      <TypeBadge type={issue.fields.issuetype.name} />
      <span className="mono muted">{issue.key}</span>
      <span className="summary" data-full-text={`${issue.key} ${issue.fields.summary}`}>{issue.fields.summary}</span>
      <StatusPill status={issue.fields.status.name} />
    </button>
  );
}

function TransitionBar({ issue, onChanged }: { issue: IssueDetail; onChanged: () => void }) {
  const [list, setList] = useState<Transition[] | null>(null);
  const [error, setError] = useState('');
  const { run, dialog } = useTransition(onChanged);
  const status = issue.fields.status.name;
  useEffect(() => {
    let alive = true;
    setList(null);
    api.transitions(issue.key).then(
      (t) => alive && setList(t),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [issue.key, status]);
  return (
    <div className="transition-bar">
      {error && <span className="err">{error}</span>}
      {list?.length === 0 && <span className="muted">当前没有你可执行的流转（部分流转仅经办人可操作）</span>}
      {list?.map((t) => (
        <button
          key={t.id}
          className="btn small"
          onClick={() => run({ key: issue.key, summary: issue.fields.summary, status, current: issue.fields }, t)}
        >
          {t.name}
          {t.name !== t.to.name && <span className="muted"> → {t.to.name}</span>}
        </button>
      ))}
      {dialog}
    </div>
  );
}

function CommentBox({ issueKey, onAdded }: { issueKey: string; onAdded: () => void }) {
  const { toast } = useSession();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api.addComment(issueKey, text.trim());
      setText('');
      toast('评论已添加');
      onAdded();
    } catch (e) {
      toast(`评论失败：${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="comment-box">
      <textarea
        className="input textarea"
        rows={2}
        aria-label="添加评论"
        placeholder="添加评论，Ctrl/⌘ + Enter 发送"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button className="btn primary small" disabled={busy || !text.trim()} onClick={submit}>
        {busy ? '发送中…' : '发送'}
      </button>
    </div>
  );
}

/** 把已有问题挂为子项（建 Blocks 链接）：搜索当前项目的非需求问题 */
function LinkChild({ parentKey, existing, onLinked }: { parentKey: string; existing: string[]; onLinked: () => void }) {
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const pick = async (target: Issue) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.linkChild(target.key, parentKey);
      toast(`${target.key} 已挂到 ${parentKey}`);
      onLinked();
    } catch (e) {
      toast(`关联失败：${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="link-child">
      <IssuePicker
        projectKey={parentKey.split('-')[0]}
        types={CHILD_TYPES}
        exclude={[parentKey, ...existing]}
        placeholder={busy ? '关联中…' : '挂已有问题为子项：搜索编号或标题'}
        onPick={pick}
      />
    </div>
  );
}

/** 移除链接：点 ✕ 后原地二次确认，只删关系不删问题 */
function Unlink({ linkId, what, done, onDone }: { linkId: string; what: string; done: string; onDone: () => void }) {
  const { toast } = useSession();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 4000);
    return () => clearTimeout(t);
  }, [confirm]);
  if (!confirm) {
    return (
      <button className="x-btn unlink" title={`移除${what}`} aria-label={`移除${what}`} onClick={() => setConfirm(true)}>
        ✕
      </button>
    );
  }
  return (
    <span className="unlink-confirm" role="group" aria-label={`确认移除${what}`}>
      <button
        className="btn sm danger"
        disabled={busy}
        autoFocus
        onClick={async () => {
          setBusy(true);
          try {
            await api.removeLink(linkId);
            toast(done);
            onDone();
          } catch (e) {
            toast(`移除失败：${(e as Error).message}`, 'error');
            setBusy(false);
            setConfirm(false);
          }
        }}
      >
        {busy ? '移除中…' : '移除'}
      </button>
      <button className="btn sm ghost" disabled={busy} onClick={() => setConfirm(false)}>
        取消
      </button>
    </span>
  );
}

/** 添加普通关联：选关系 + 搜索问题，选中即建 */
function AddLink({ issue, exclude, onLinked }: { issue: IssueDetail; exclude: string[]; onLinked: () => void }) {
  const { toast } = useSession();
  const [options, setOptions] = useState<LinkOption[]>([]);
  const [optId, setOptId] = useState('Relates:out');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    getLinkTypes().then((t) => setOptions(linkOptions(t)), (e: Error) => toast(`链接类型加载失败：${e.message}`, 'error'));
  }, [toast]);
  const opt = options.find((o) => o.id === optId) ?? options[0];
  const pick = async (target: Issue) => {
    if (!opt || busy) return;
    setBusy(true);
    try {
      await api.addLink(issueLinkBody(issue.key, { option: opt, key: target.key }));
      toast(`已关联 ${target.key}`);
      onLinked();
    } catch (e) {
      toast(`关联失败：${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="link-editor">
      <div className="link-child">
        <select className="select" aria-label="关系类型" value={opt?.id ?? ''} onChange={(e) => setOptId(e.target.value)}>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <IssuePicker projectKey={issue.key.split('-')[0]} exclude={exclude} placeholder={busy ? '关联中…' : '添加关联：搜索编号或标题'} onPick={pick} />
      </div>
      {opt?.hint && <span className="field-hint">{opt.hint}</span>}
    </div>
  );
}

/** 附件：缩略图/列表，拖拽或粘贴即上传 */
function Attachments({ issue, writable, perms, onChanged }: { issue: IssueDetail; writable: boolean; perms: Perms; onChanged: () => void }) {
  const { toast, me } = useSession();
  const list = ((issue.fields.attachment as Attachment[] | undefined) ?? []).slice().sort((a, b) => b.created.localeCompare(a.created));
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Attachment | null>(null);

  const upload = async (files: File[]) => {
    if (!files.length || busy) return;
    setBusy(true);
    try {
      await api.uploadAttachments(issue.key, files);
      toast(`已上传 ${files.length} 个附件`);
      onChanged();
    } catch (e) {
      toast(`上传失败：${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  // 抽屉打开时，在输入框以外粘贴截图直接上传
  useEffect(() => {
    if (!writable) return;
    const on = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (document.querySelector('.modal-mask')) return;
      if (el?.closest('input,textarea,[contenteditable]') && !e.clipboardData?.files.length) return;
      const files = filesFromClipboard(e);
      if (!files.length) return;
      e.preventDefault();
      upload(files);
    };
    window.addEventListener('paste', on);
    return () => window.removeEventListener('paste', on);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writable, issue.key, busy]);

  return (
    <section className="section">
      <h4>附件 {list.length > 0 && <span className="muted">{list.length}</span>}</h4>
      {list.length > 0 && (
        <ul className="att-grid">
          {list.map((a) => {
            const isImg = a.mimeType.startsWith('image/');
            const href = fileUrl(a.content);
            return (
              <li key={a.id} className="att-card">
                {isImg ? (
                  <button className="att-thumb" onClick={() => setPreview(a)} aria-label={`预览 ${a.filename}`}>
                    <img src={fileUrl(a.thumbnail) ?? href} alt="" loading="lazy" />
                  </button>
                ) : (
                  <a className="att-thumb att-file" href={href} download={a.filename}>
                    {(a.filename.split('.').pop() || '文件').slice(0, 4).toUpperCase()}
                  </a>
                )}
                <a className="att-name" href={href} download={a.filename} title={a.filename}>
                  {a.filename}
                </a>
                <span className="muted">
                  {formatSize(a.size)} · {userName(a.author)} · {relativeTime(a.created)}
                </span>
                {canDeleteAttachment(perms, a.author, me.name) && (
                  <span className="att-del">
                    <ConfirmDelete
                      what={`附件 ${a.filename}`}
                      onConfirm={async () => {
                        await api.deleteAttachment(issue.key, a.id);
                        toast(`已删除附件 ${a.filename}`);
                        onChanged();
                      }}
                    />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {writable ? (
        <AttachmentDrop files={[]} onChange={upload} busy={busy} disabled={busy} hint="拖拽文件到这里或点击上传；抽屉内任意位置 Ctrl/⌘+V 粘贴截图" />
      ) : (
        list.length === 0 && <p className="muted">暂无附件</p>
      )}
      {preview && <AttachmentPreview attachment={preview} onClose={() => setPreview(null)}/>}
    </section>
  );
}

function AttachmentPreview({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose);
  return <div ref={ref} tabIndex={-1} className="lightbox" role="dialog" aria-modal="true" aria-label={attachment.filename} onClick={onClose}>
    <button className="btn" aria-label="关闭图片预览" onClick={onClose}>关闭 ✕</button>
    <img src={fileUrl(attachment.content)} alt={attachment.filename}/>
    <span>{attachment.filename}（点击或 Esc 关闭）</span>
  </div>;
}

/** 删除按钮：点 ✕ 后原地二次确认（4 秒内不确认自动取消），失败时 toast 提示 */
function ConfirmDelete({ what, onConfirm, label = '✕' }: { what: string; onConfirm: () => Promise<void>; label?: string }) {
  const { toast } = useSession();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!confirm || busy) return;
    const t = setTimeout(() => setConfirm(false), 4000);
    return () => clearTimeout(t);
  }, [confirm, busy]);
  if (!confirm) {
    return (
      <button className={label === '✕' ? 'x-btn' : 'text-btn danger'} title={`删除${what}`} aria-label={`删除${what}`} onClick={() => setConfirm(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="unlink-confirm" role="group" aria-label={`确认删除${what}`}>
      <button
        className="btn sm danger"
        disabled={busy}
        autoFocus
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } catch (e) {
            toast(`删除失败：${(e as Error).message}`, 'error');
            setBusy(false);
            setConfirm(false);
          }
        }}
      >
        {busy ? '删除中…' : '确认删除'}
      </button>
      <button className="btn sm ghost" disabled={busy} onClick={() => setConfirm(false)}>
        取消
      </button>
    </span>
  );
}

/** 单条评论：按权限显示编辑/删除；编辑用原始 wiki 文本 */
function CommentItem({
  issueKey,
  comment: c,
  raw,
  perms,
  jiraBaseUrl,
  onChanged,
}: {
  issueKey: string;
  comment: Comment;
  raw: Comment | undefined;
  perms: Perms;
  jiraBaseUrl: string;
  onChanged: () => void;
}) {
  const { me, toast } = useSession();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const canEdit = !!raw && canEditComment(perms, c.author, me.name);
  const canDel = canDeleteComment(perms, c.author, me.name);
  // Jira 编辑后 updated 晚于 created
  const edited = !!raw?.updated && !!raw.created && raw.updated.slice(0, 19) !== raw.created.slice(0, 19);

  const save = async () => {
    const next = text.trim();
    if (!next) return toast('评论内容不能为空', 'error');
    if (next === raw?.body.trim()) return setEditing(false);
    setBusy(true);
    try {
      await api.editComment(issueKey, c.id, next);
      toast('评论已更新');
      setEditing(false);
      onChanged();
    } catch (e) {
      toast(`保存评论失败：${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="comment">
      <div className="meta">
        <span>
          {userName(c.author)} · {formatDateTime(c.created)}
          {edited && (
            <span className="muted" title={`${userName(raw?.updateAuthor)} 于 ${formatDateTime(raw!.updated!)} 编辑`}>
              {' '}
              · 已编辑
            </span>
          )}
        </span>
        {!editing && (canEdit || canDel) && (
          <span className="comment-actions">
            {canEdit && (
              <button
                className="text-btn"
                onClick={() => {
                  setText(raw!.body);
                  setEditing(true);
                }}
              >
                编辑
              </button>
            )}
            {canDel && (
              <ConfirmDelete
                what="这条评论"
                label="删除"
                onConfirm={async () => {
                  await api.deleteComment(issueKey, c.id);
                  toast('评论已删除');
                  onChanged();
                }}
              />
            )}
          </span>
        )}
      </div>
      {editing ? (
        <div className="inline-edit" style={{ opacity: busy ? 0.6 : 1 }}>
          <textarea
            className="input textarea"
            rows={4}
            autoFocus
            aria-label="编辑评论"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setEditing(false);
              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              }
            }}
          />
          <div className="inline-edit-actions">
            <button className="btn primary small" disabled={busy || !text.trim()} onClick={save}>
              {busy ? '保存中…' : '保存'}
            </button>
            <button className="btn small" disabled={busy} onClick={() => setEditing(false)}>
              取消
            </button>
            <span className="muted">⌘/Ctrl+Enter 保存 · Esc 取消 · 支持 Jira wiki 语法</span>
          </div>
        </div>
      ) : (
        <div className="rich" dangerouslySetInnerHTML={{ __html: sanitizeHtml(c.body, jiraBaseUrl) }} />
      )}
    </div>
  );
}
