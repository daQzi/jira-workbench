import { useEffect, useMemo, useState } from 'react';
import { api, type CreateMetaType } from '../lib/api';
import { CHILD_TYPES, orderedFieldIds, parseBatchTitles, planCreate, submitCreate } from '../lib/create';
import { inheritFields, submitToForm, type FormValue } from '../lib/fields';
import { getCreateMeta } from '../lib/metaCache';
import { useSession } from '../lib/session';
import { FieldInput } from './FieldInput';
import { Modal } from './Modal';
import { TypeBadge } from './Badges';
import { ErrorState, Loading } from './States';
import { IssuePicker } from './IssuePicker';
import { LinkEditor, type PendingLinkView } from './LinkEditor';
import { AttachmentDrop, filesFromClipboard } from './AttachmentDrop';
import { PARENT_ISSUE_TYPES } from '../lib/tree';
import { hiddenFields, saveHiddenFields, splitFields } from '../lib/fieldPrefs';
import { isEmpty } from '../lib/fields';
import type { Project } from '../lib/types';

export interface CreateTarget {
  /** 为空时在表单里选项目（如从「我的工作台」新建） */
  projectKey: string | null;
  /** 默认问题类型名 */
  typeName?: string;
  /** 在需求下新建子项 */
  parent?: { key: string; summary: string; fields?: Record<string, unknown> } | null;
  /** 预填标题（快速添加回退到完整表单时） */
  summary?: string;
}

interface Props {
  target: CreateTarget;
  onClose: () => void;
  onCreated: (keys: string[]) => void;
}

export function CreateDialog({ target: initial, onClose, onCreated }: Props) {
  const { me, toast, canWriteProject } = useSession();
  const [projectKey, setProjectKey] = useState<string | null>(initial.projectKey);
  const [projects, setProjects] = useState<Project[] | null>(null);
  useEffect(() => {
    if (initial.projectKey) return;
    api.projects().then(
      (list) => {
        const ok = list.filter((p) => canWriteProject(p.key));
        setProjects(ok);
        if (ok.length === 1) setProjectKey(ok[0].key);
      },
      (e: Error) => setLoadError(e),
    );
  }, [initial.projectKey, canWriteProject]);
  const target = useMemo(() => ({ ...initial, projectKey: projectKey ?? '' }), [initial, projectKey]);
  // 换项目时清掉项目内的选择（父需求、关联、字段值保留标题和描述）
  useEffect(() => {
    if (initial.projectKey) return;
    setParentRef(null);
    setLinks([]);
    setValues((v) => ({ summary: v.summary, description: v.description }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey]);
  const [types, setTypes] = useState<CreateMetaType[] | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [typeId, setTypeId] = useState('');
  const [values, setValues] = useState<Record<string, FormValue | undefined>>({ summary: target.summary });
  // 父需求：从需求下新建时固定；普通新建时可在表单里选
  const [parentRef, setParentRef] = useState<{ key: string; summary: string } | null>(target.parent ? { key: target.parent.key, summary: target.parent.summary } : null);
  const [parentFields, setParentFields] = useState<Record<string, unknown> | null>(target.parent?.fields ?? null);
  const [parentError, setParentError] = useState('');
  const [links, setLinks] = useState<PendingLinkView[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [batch, setBatch] = useState(false);
  const [batchText, setBatchText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showInvalid, setShowInvalid] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!target.projectKey) return;
    let alive = true;
    setTypes(null);
    getCreateMeta(target.projectKey).then(
      (t) => {
        if (!alive) return;
        const allowed = target.parent ? t.filter((x) => CHILD_TYPES.includes(x.name)) : t;
        setTypes(allowed);
        const def = allowed.find((x) => x.name === (target.typeName ?? (target.parent ? '编码任务' : '需求'))) ?? allowed[0];
        setTypeId(def?.id ?? '');
      },
      (e: Error) => alive && setLoadError(e),
    );
    return () => {
      alive = false;
    };
  }, [target, nonce]);

  // 选中父需求后取其字段用于继承
  useEffect(() => {
    if (!parentRef) {
      setParentFields(null);
      return;
    }
    if (target.parent?.fields && parentRef.key === target.parent.key) return;
    let alive = true;
    setParentFields(null);
    setParentError('');
    api.issue(parentRef.key).then(
      (i) => alive && setParentFields(i.fields as Record<string, unknown>),
      (e: Error) => alive && setParentError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [parentRef, target.parent]);

  const type = types?.find((t) => t.id === typeId) ?? null;
  const isParentType = !!type && PARENT_ISSUE_TYPES.includes(type.name);
  // 需求本身不挂父需求
  const effectiveParent = isParentType ? null : parentRef;
  const parent = effectiveParent && parentFields ? { key: effectiveParent.key, fields: parentFields } : null;
  const parentLoading = !!effectiveParent && !parentFields && !parentError;

  // 切换类型/选中父需求时：保留新类型里仍存在的已填字段，空字段用父需求继承值补齐，经办人默认自己
  useEffect(() => {
    if (!type) return;
    setValues((prev) => {
      const next: Record<string, FormValue | undefined> = { summary: prev.summary, description: prev.description };
      for (const [id, v] of Object.entries(prev)) if (type.fields[id] && v !== undefined && v !== '') next[id] = v;
      if (parent) {
        const inh = inheritFields(parent.fields, type.fields);
        for (const [id, v] of Object.entries(inh)) if (next[id] === undefined || next[id] === '' || (Array.isArray(next[id]) && !next[id]!.length)) next[id] = submitToForm(id, type.fields[id], v);
      }
      if (type.fields.assignee && !next.assignee) next.assignee = me.name;
      return next;
    });
    setShowInvalid(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, parentFields, me.name]);

  const fieldIds = useMemo(() => (type ? orderedFieldIds(type) : []), [type]);
  // 字段显示配置：默认显示 Jira 当前配置的全部新建字段，可按项目+类型隐藏不常用的
  const [hidden, setHidden] = useState<string[]>([]);
  const [showFolded, setShowFolded] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  useEffect(() => {
    if (type) setHidden(hiddenFields(target.projectKey, type.name));
    setShowFolded(false);
  }, [type, target.projectKey]);
  const { shown, folded } = type ? splitFields(fieldIds, type.fields, hidden, (id) => !isEmpty(values[id])) : { shown: [], folded: [] };
  const visibleIds = showFolded ? fieldIds : shown;
  const toggleHidden = (id: string) => {
    const next = hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id];
    setHidden(next);
    saveHiddenFields(target.projectKey, type!.name, next);
  };
  const titles = batch ? parseBatchTitles(batchText) : [];

  const plan = type
    ? planCreate({
        projectKey: target.projectKey,
        type,
        values: batch ? { ...values, summary: titles[0] ?? '' } : values,
        parent,
        links,
      })
    : null;
  const missingNames = new Set([...(plan?.missing ?? []), ...(plan?.unsupported ?? [])]);

  async function submit(again: boolean) {
    if (!type || !plan || busy) return;
    if (parentLoading) {
      setError('正在读取父需求，请稍候');
      return;
    }
    if (missingNames.size) {
      setShowInvalid(true);
      setError(`请填写：${[...missingNames].join('、')}`);
      return;
    }
    setBusy(true);
    setError('');
    const list = batch ? titles : [String(values.summary ?? '').trim()];
    const done: string[] = [];
    const warnings: string[] = [];
    try {
      // 逐条串行创建，失败即停，已建成功的如实报告
      for (const summary of list) {
        const r = await submitCreate(
          { projectKey: target.projectKey, type, values: { ...values, summary }, parent, links },
          // 批量时附件只挂第一条，避免重复上传
          done.length === 0 ? files : undefined,
        );
        done.push(r.key);
        r.warnings.forEach((w) => warnings.push(`${r.key} 已创建，但${w}`));
      }
    } catch (e) {
      setError(`${done.length ? `已创建 ${done.join('、')}；` : ''}第 ${done.length + 1} 条失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
    if (done.length) {
      onCreated(done);
      warnings.forEach((w) => toast(w, 'error'));
      if (done.length === list.length) {
        toast(`已创建 ${done.length === 1 ? done[0] : `${done.length} 条`}`);
        if (again) {
          setValues((v) => ({ ...v, summary: '', description: '' }));
          setBatchText('');
          setFiles([]);
        } else {
          onClose();
        }
      } else if (batch) {
        // 去掉已成功的行，方便重试剩余部分
        setBatchText(titles.slice(done.length).join('\n'));
      }
    }
  }

  const title = !initial.projectKey ? (
    '新建'
  ) : target.parent ? (
    <>
      新建子项 <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>→ {target.parent.key} {target.parent.summary.slice(0, 30)}</span>
    </>
  ) : (
    `新建 · ${target.projectKey}`
  );

  return (
    <Modal
      title={title}
      onClose={onClose}
      busy={busy}
      width={760}
      footer={
        type && (
          <>
            <span className="err" role="alert">
              {error}
            </span>
            <button className="btn" disabled={busy} onClick={() => submit(true)}>
              创建并继续
            </button>
            <button className="btn primary" disabled={busy} onClick={() => submit(false)}>
              {busy ? '创建中…' : batch ? `创建 ${titles.length} 条` : '创建'}
            </button>
          </>
        )
      }
    >
      {!initial.projectKey && (
        <div className="field wide project-pick">
          <span className="field-label">项目</span>
          {projects === null ? (
            <span className="muted">加载项目…</span>
          ) : projects.length === 0 ? (
            <span className="muted">当前没有开放写入的项目（工作台写入白名单为空或未开启写模式）</span>
          ) : (
            <div className="check-group" role="radiogroup" aria-label="项目">
              {projects.map((p) => (
                <button type="button" key={p.key} role="radio" aria-checked={p.key === projectKey} aria-pressed={p.key === projectKey} className="chip" onClick={() => setProjectKey(p.key)}>
                  {p.name.replace(/^\d+-/, '')} <span className="mono muted">{p.key}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {loadError && <ErrorState error={loadError} onRetry={() => { setLoadError(null); setNonce((n) => n + 1); }} />}
      {!loadError && !types && target.projectKey && <Loading rows={5} />}
      {types && types.length === 0 && <p className="muted">当前账号在该项目没有可新建的问题类型</p>}
      {type && (!target.parent || parent || parentError) && (
        <form
          className="form-grid"
          onPaste={(e) => {
            // 表单内任意位置粘贴截图/文件即加入附件；纯文本照常粘贴
            const pasted = filesFromClipboard(e);
            if (!pasted.length) return;
            e.preventDefault();
            setFiles((f) => [...f, ...pasted]);
            toast(`已添加 ${pasted.length} 个附件`);
          }}
          onSubmit={(e) => {
            e.preventDefault();
            submit(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit(false);
            }
          }}
        >
          <div className="field wide">
            <span className="field-label">类型</span>
            <div className="check-group" role="radiogroup" aria-label="问题类型">
              {types!.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  role="radio"
                  aria-checked={t.id === typeId}
                  className="chip"
                  aria-pressed={t.id === typeId}
                  onClick={() => setTypeId(t.id)}
                >
                  <TypeBadge type={t.name} /> {t.name}
                </button>
              ))}
              <span className="grow" />
              <label className="chip" aria-pressed={batch} title="每行一个标题，其余字段共用">
                <input type="checkbox" className="sr-only" checked={batch} onChange={(e) => setBatch(e.target.checked)} />
                批量（每行一条）
              </label>
            </div>
          </div>

          {!isParentType && (
            <div className="field wide">
              <span className="field-label">
                所属需求
                <span className="field-hint">子项 blocks 需求；选中后自动继承模块、优先级等字段</span>
              </span>
              {parentRef ? (
                <div className="parent-chip">
                  <TypeBadge type="需求" />
                  <span className="mono muted">{parentRef.key}</span>
                  <span className="summary">{parentRef.summary}</span>
                  {parentLoading && <span className="muted">读取中…</span>}
                  {parentError && <span className="err">读取失败：{parentError}</span>}
                  {!target.parent && (
                    <button type="button" className="x-btn" aria-label="移除所属需求" onClick={() => setParentRef(null)}>
                      ✕
                    </button>
                  )}
                </div>
              ) : (
                <IssuePicker
                  projectKey={target.projectKey}
                  types={PARENT_ISSUE_TYPES}
                  placeholder="搜索需求编号或标题（可不选）"
                  onPick={(i) => setParentRef({ key: i.key, summary: i.fields.summary })}
                />
              )}
            </div>
          )}
          <div className="field wide">
            <span className="field-label">
              关联问题
              <span className="field-hint">{isParentType ? '可直接挂已有的编码任务/BUG/其他任务为子项，可加多条' : '需求、编码任务、其他任务都能关联，可加多条'}</span>
            </span>
            <LinkEditor projectKey={target.projectKey} value={links} onChange={setLinks} exclude={effectiveParent ? [effectiveParent.key] : []} asParent={isParentType} />
          </div>
          <div className="field-bar wide">
            <span className="muted">
              字段 {shown.length}/{fieldIds.length}
              {folded.length > 0 && !showFolded && <>，已收起 {folded.length} 个</>}
            </span>
            <span className="grow" />
            {folded.length > 0 && (
              <button type="button" className="btn ghost sm" onClick={() => setShowFolded((v) => !v)}>
                {showFolded ? '只看常用' : `展开收起的 ${folded.length} 个`}
              </button>
            )}
            <button type="button" className="btn ghost sm" aria-expanded={configuring} onClick={() => setConfiguring((v) => !v)}>
              ⚙ 字段设置
            </button>
          </div>
          {configuring && (
            <div className="field-config wide" role="group" aria-label="选择要显示的字段">
              <p className="field-hint">
                勾选在「{type.name}」新建表单里显示的字段（{target.projectKey}，仅保存在本机）。必填字段始终显示。
              </p>
              <div className="check-group">
                {fieldIds.map((id) => {
                  const m = type.fields[id];
                  const on = m.required || !hidden.includes(id);
                  return (
                    <label key={id} className="chip" aria-pressed={on} title={m.required ? '必填，不能隐藏' : undefined}>
                      <input type="checkbox" className="sr-only" checked={on} disabled={m.required} onChange={() => toggleHidden(id)} />
                      {id === 'summary' ? '标题' : m.name}
                      {m.required && <span className="req">*</span>}
                    </label>
                  );
                })}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn ghost sm" onClick={() => { setHidden([]); saveHiddenFields(target.projectKey, type.name, []); }}>
                  恢复为 Jira 默认（全部显示）
                </button>
                <button type="button" className="btn ghost sm" onClick={() => { const next = fieldIds.filter((id) => !type.fields[id].required); setHidden(next); saveHiddenFields(target.projectKey, type.name, next); }}>
                  只留必填
                </button>
              </div>
            </div>
          )}
          {visibleIds.map((id) => {
            const meta = type.fields[id];
            if (id === 'summary' && batch) {
              return (
                <div className={`field wide${showInvalid && !titles.length ? ' invalid' : ''}`} key={id}>
                  <label className="field-label" htmlFor="batch-titles">
                    标题<span className="req">*</span>
                    <span className="field-hint">每行一条，共 {titles.length} 条</span>
                  </label>
                  <textarea
                    id="batch-titles"
                    className="input textarea"
                    rows={6}
                    autoFocus
                    value={batchText}
                    onChange={(e) => setBatchText(e.target.value)}
                    placeholder={'从 Excel 或文档里直接粘贴\n每行会创建一条'}
                  />
                </div>
              );
            }
            return (
              <FieldInput
                key={id}
                id={id}
                meta={id === 'summary' ? { ...meta, name: '标题' } : meta}
                value={values[id]}
                project={target.projectKey}
                invalid={showInvalid && missingNames.has(meta.name)}
                hint={parent && values[id] !== undefined && inheritFields(parent.fields, { [id]: meta })[id] !== undefined ? '继承自父需求' : undefined}
                onChange={(v) => setValues((s) => ({ ...s, [id]: v }))}
              />
            );
          })}
          <div className="field wide">
            <span className="field-label">
              附件<span className="field-hint">{batch ? '批量模式下只挂到第一条' : '创建成功后自动上传'}</span>
            </span>
            <AttachmentDrop files={files} onChange={setFiles} disabled={busy} />
          </div>
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  );
}
