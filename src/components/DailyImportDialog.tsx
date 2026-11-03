import { useEffect, useMemo, useState } from 'react';
import { api, type CreateMetaType } from '../lib/api';
import { CHILD_TYPES, submitCreate } from '../lib/create';
import {
  dailyTotals, draftsFromLlm, fieldSlots, missingRequired, parseDailyRules, pieceValues, resplit, slotWarnings, taskErrors, taskHours,
  type DraftOptions, type DraftTask, type Piece,
} from '../lib/dailyImport';
import { inheritFields, type FormValue } from '../lib/fields';
import { parseDuration, ymd, type HourFields } from '../lib/hours';
import { quote } from '../lib/jql';
import { getCreateMeta } from '../lib/metaCache';
import { useSession } from '../lib/session';
import { PARENT_ISSUE_TYPES } from '../lib/tree';
import type { Project } from '../lib/types';
import { FieldInput } from './FieldInput';
import { Modal } from './Modal';

interface Props {
  hourFields: HourFields;
  /** 当前全局项目；有值时只建到这个项目，日报里写的其他项目会被标出 */
  projectKey?: string | null;
  onClose: () => void;
  onCreated: (keys: string[]) => void;
}

interface Prefs {
  defaultProject: string;
  typeName: string;
  maxHours: number;
  schedule: DraftOptions['schedule'];
  useLlm: boolean;
}

const STORE = 'wb.daily.v1';
const DRAFT_STORE = 'wb.daily.text.v1';
const PLACEHOLDER = `直接粘贴今天的汇总，格式随意，例如：
1. 对接医保结算接口联调 6h #YLZHXT-123
2. 排查线上对账数据问题 2h
3. 权限模块改造方案设计与编码 1.5d [AGENT]
4. 处理医院反馈的报销单打印问题 3h 对接人：张三`;

type PieceStatus = { state: 'dup' | 'creating' | 'done' | 'error' | 'skip'; key?: string; msg?: string };
type ProjectMeta = { type: CreateMetaType | null; error?: string };

function loadPrefs(maxDefault: number): Prefs {
  const def: Prefs = { defaultProject: '', typeName: '其他任务', maxHours: maxDefault, schedule: 'backward', useLlm: true };
  try {
    return { ...def, ...JSON.parse(localStorage.getItem(STORE) || 'null') };
  } catch {
    return def;
  }
}

const pid = (t: DraftTask, i: number) => `${t.id}:${i}`;

export function DailyImportDialog({ hourFields, projectKey = null, onClose, onCreated }: Props) {
  const { me, toast, canWriteProject } = useSession();
  const llm = me.llm?.enabled ? me.llm : null;
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(llm?.maxHoursPerTask ?? 8));
  useEffect(() => localStorage.setItem(STORE, JSON.stringify(prefs)), [prefs]);
  const setPref = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setPrefs((p) => ({ ...p, [k]: v }));

  const [text, setText] = useState(() => sessionStorage.getItem(DRAFT_STORE) ?? '');
  useEffect(() => sessionStorage.setItem(DRAFT_STORE, text), [text]);
  const [date, setDate] = useState(() => ymd(new Date()));
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [tasks, setTasks] = useState<DraftTask[] | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseNote, setParseNote] = useState('');
  const [error, setError] = useState('');
  const [metas, setMetas] = useState<Record<string, ProjectMeta>>({});
  const [shared, setShared] = useState<Record<string, Record<string, FormValue | undefined>>>({});
  const [status, setStatus] = useState<Record<string, PieceStatus>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.projects().then(
      (list) => {
        const ok = list.filter((p) => canWriteProject(p.key));
        setProjects(ok);
        setPrefs((p) => (ok.some((x) => x.key === p.defaultProject) ? p : { ...p, defaultProject: ok[0]?.key ?? '' }));
      },
      (e: Error) => setError(`项目加载失败：${e.message}`),
    );
  }, [canWriteProject]);

  const defaultProject = projectKey ?? prefs.defaultProject;
  const opts: DraftOptions = { date, defaultProject, maxHours: prefs.maxHours, schedule: prefs.schedule };

  async function parse() {
    if (!text.trim() || parsing) return;
    if (!defaultProject) return setError('请先选择默认项目');
    if (projectKey && !canWriteProject(projectKey)) return setError(`工作台未开放 ${projectKey} 写入，请切换项目`);
    setParsing(true);
    setError('');
    setParseNote('');
    setStatus({});
    try {
      if (llm && prefs.useLlm) {
        try {
          const r = await api.llmSplit({ text, date, defaultProject, projects: projectKey ? [projectKey] : (projects ?? []).map((p) => p.key) });
          setTasks(draftsFromLlm(r.tasks, opts));
          setParseNote(`${r.model} 解析 ${r.tasks.length} 条，用时 ${(r.elapsedMs / 1000).toFixed(1)}s；拆分结果已按规则校验`);
          return;
        } catch (e) {
          // 大模型不可用不影响录入：退回规则解析，并说明原因
          setParseNote(`大模型不可用（${(e as Error).message}），已改用规则解析`);
        }
      }
      setTasks(parseDailyRules(text, opts));
    } finally {
      setParsing(false);
    }
  }

  // 用到的项目：加载 createmeta，找到目标类型
  const usedProjects = useMemo(() => [...new Set((tasks ?? []).map((t) => t.project).filter(Boolean))], [tasks]);
  useEffect(() => {
    for (const p of usedProjects) {
      if (metas[p]) continue;
      setMetas((m) => ({ ...m, [p]: { type: null } }));
      getCreateMeta(p).then(
        (types) => {
          const type = types.find((t) => t.name === prefs.typeName) ?? null;
          setMetas((m) => ({ ...m, [p]: type ? { type } : { type: null, error: `不能新建「${prefs.typeName}」` } }));
        },
        (e: Error) => setMetas((m) => ({ ...m, [p]: { type: null, error: e.message } })),
      );
    }
  }, [usedProjects, metas, prefs.typeName]);
  // 换类型后重新加载
  useEffect(() => setMetas({}), [prefs.typeName]);

  // 防重复：近 14 天我建的问题里，标题完全相同的默认跳过
  useEffect(() => {
    if (!tasks?.length) return;
    let alive = true;
    const from = ymd(new Date(Date.now() - 14 * 86400_000));
    api
      .search(`reporter = currentUser() AND created >= ${quote(from)} ORDER BY created DESC`, { maxResults: 300, fields: ['summary'] })
      .then((r) => {
        if (!alive) return;
        const seen = new Map(r.issues.map((i) => [i.fields.summary.trim(), i.key]));
        setStatus((s) => {
          const next = { ...s };
          for (const t of tasks)
            t.pieces.forEach((p, i) => {
              const k = pid(t, i);
              const hit = seen.get(p.title.trim());
              if (next[k]?.state === 'done') return;
              if (hit) next[k] = { state: 'dup', key: hit };
              else if (next[k]?.state === 'dup') delete next[k];
            });
          return next;
        });
      })
      .catch(() => {
        /* 查重失败不阻塞，只是不提示 */
      });
    return () => {
      alive = false;
    };
  }, [tasks]);

  const updateTask = (id: string, patch: (t: DraftTask) => DraftTask) => setTasks((ts) => ts && ts.map((t) => (t.id === id ? patch(t) : t)));
  const updatePiece = (t: DraftTask, i: number, patch: Partial<Piece>) =>
    updateTask(t.id, (x) => ({ ...x, pieces: x.pieces.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));

  const errorsOf = (t: DraftTask) => {
    const e = taskErrors(t, prefs.maxHours);
    if (t.project && !canWriteProject(t.project)) e.push(`工作台未开放 ${t.project} 写入`);
    if (projectKey && t.project && t.project !== projectKey) e.push(`不在当前项目 ${projectKey}（切换项目后再建，或改成 ${projectKey}）`);
    if (metas[t.project]?.error) e.push(`${t.project}：${metas[t.project].error}`);
    return e;
  };
  // 填了对接人但该类型没有这个字段：只提示，不拦截
  const contactNote = (t: DraftTask) => {
    const type = metas[t.project]?.type;
    return t.contact.trim() && type && !fieldSlots(type, hourFields).contact ? `${t.project} 的「${prefs.typeName}」没有一线对接人字段，不会写入` : '';
  };
  const totals = tasks ? dailyTotals(tasks) : {};
  const overDays = Object.entries(totals).filter(([, h]) => h > 8);
  const pending = (tasks ?? []).flatMap((t) => t.pieces.map((p, i) => ({ t, p, i }))).filter(({ t, i }) => {
    const s = status[pid(t, i)]?.state;
    return s !== 'done' && s !== 'dup' && s !== 'skip';
  });
  const blocked = (tasks ?? []).filter((t) => errorsOf(t).length);
  const sum = (tasks ?? []).reduce((a, t) => a + taskHours(t), 0);

  async function submit() {
    if (!tasks || busy) return;
    if (blocked.length) return setError(`还有 ${blocked.length} 条需要修正（标红的行）`);
    if (!pending.length) return setError('没有需要创建的条目');
    setBusy(true);
    setError('');
    const created: string[] = [];
    let failed = 0;
    const parents = new Map<string, Promise<{ key: string; type: string; fields: Record<string, unknown> }>>();
    const getParent = (key: string) => {
      if (!parents.has(key)) parents.set(key, api.issue(key).then((i) => ({ key, type: i.fields.issuetype.name, fields: i.fields as Record<string, unknown> })));
      return parents.get(key)!;
    };
    for (const t of tasks) {
      const meta = metas[t.project]?.type;
      // 同一任务拆出的多条：后几条关联到第一条（重试时沿用已建成功的那条）
      let firstKey = t.pieces.map((_, i) => status[pid(t, i)]).find((x) => x?.state === 'done')?.key ?? null;
      for (let i = 0; i < t.pieces.length; i++) {
        const k = pid(t, i);
        const st = status[k]?.state;
        if (st === 'done' || st === 'dup' || st === 'skip') continue;
        const set = (s: PieceStatus) => setStatus((x) => ({ ...x, [k]: s }));
        if (!meta) {
          failed++;
          set({ state: 'error', msg: '项目元数据未加载' });
          continue;
        }
        set({ state: 'creating' });
        try {
          const parent = t.parentKey ? await getParent(t.parentKey) : null;
          // 只有「需求」才按父子挂（子项 blocks 需求）；其他类型挂“相关”，避免工时统计误判父子
          const asParent = parent && PARENT_ISSUE_TYPES.includes(parent.type) ? parent : null;
          const values = { ...shared[t.project], ...pieceValues(fieldSlots(meta, hourFields), me.name, t.pieces[i], !!meta.fields.assignee, t.contact) };
          const inherited = asParent ? inheritFields(asParent.fields, meta.fields) : {};
          const miss = missingRequired(meta.fields, values, inherited);
          if (miss.missing.length || miss.unsupported.length) {
            const names = [...miss.missing, ...miss.unsupported].map((id) => meta.fields[id].name);
            throw new Error(`缺少必填：${names.join('、')}（在上方「${t.project} 共用字段」里填写）`);
          }
          const links = [
            ...(parent && !asParent ? [{ option: { type: 'Relates', dir: 'out' as const }, key: parent.key }] : []),
            // 机械拆分且没有父需求时，后几条与第一条互相关联，便于追溯
            ...(!asParent && firstKey ? [{ option: { type: 'Relates', dir: 'out' as const }, key: firstKey }] : []),
          ];
          const r = await submitCreate({ projectKey: t.project, type: meta, values, parent: asParent ? { key: asParent.key, fields: asParent.fields } : null, links });
          firstKey ??= r.key;
          created.push(r.key);
          set({ state: 'done', key: r.key, msg: r.warnings.join('；') || undefined });
        } catch (e) {
          failed++;
          set({ state: 'error', msg: (e as Error).message });
        }
      }
    }
    setBusy(false);
    if (created.length) {
      onCreated(created);
      toast(`已创建 ${created.length} 条`);
    }
    // 只在全部成功时清掉草稿；失败的保留，可修正后再点创建（已成功的不会重复建）
    if (failed) setError(`${failed} 条失败，修正后可再次点击创建`);
    else if (created.length) sessionStorage.removeItem(DRAFT_STORE);
  }

  // 共用必填字段：每个项目算一次（用示例条目的自动值排除掉已能自动填的字段）
  const sharedNeeds = usedProjects.flatMap((p) => {
    const type = metas[p]?.type;
    if (!type) return [];
    const sample = pieceValues(fieldSlots(type, hourFields), me.name, { title: 'x', hours: 1, date }, !!type.fields.assignee);
    const all = missingRequired(type.fields, { ...sample });
    const ids = [...all.missing, ...all.unsupported];
    return [{ project: p, type, ids, unsupported: all.unsupported, warnings: slotWarnings(fieldSlots(type, hourFields)) }];
  });

  const footer = (
    <>
      <span className="err" role="alert">
        {error}
      </span>
      {tasks && (
        <>
          <span className="muted daily-sum">
            {tasks.length} 项 · {pending.length} 条待建 · 合计 {Math.round(sum * 100) / 100}h
          </span>
          <button className="btn" disabled={busy} onClick={() => setTasks(null)}>
            返回修改
          </button>
          <button className="btn primary" disabled={busy || !pending.length} onClick={submit}>
            {busy ? '创建中…' : `创建 ${pending.length} 条`}
          </button>
        </>
      )}
      {!tasks && (
        <button className="btn primary" disabled={parsing || !text.trim()} onClick={parse}>
          {parsing ? (llm && prefs.useLlm ? '大模型解析中…' : '解析中…') : '解析预览'}
        </button>
      )}
    </>
  );

  return (
    <Modal title="从日报新建任务" onClose={busy ? () => {} : onClose} width={980} footer={footer}>
      <div className="daily-opts">
        <label>
          <span>日报日期</span>
          <input className="input" type="date" value={date} disabled={!!tasks} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
        {projectKey ? (
          <label>
            <span>项目</span>
            <span className="daily-proj mono">{projectKey}</span>
          </label>
        ) : (
        <label>
          <span>默认项目</span>
          <select className="select" value={prefs.defaultProject} disabled={!!tasks} onChange={(e) => setPref('defaultProject', e.target.value)}>
            {projects === null && <option value="">加载中…</option>}
            {projects?.length === 0 && <option value="">没有可写项目</option>}
            {projects?.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name.replace(/^\d+-/, '')} ({p.key})
              </option>
            ))}
          </select>
        </label>
        )}
        <label>
          <span>问题类型</span>
          <select className="select" value={prefs.typeName} disabled={busy} onChange={(e) => setPref('typeName', e.target.value)}>
            {CHILD_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          <span>单条上限（h）</span>
          <input className="input" type="number" min={1} max={24} step={0.5} value={prefs.maxHours} disabled={!!tasks} onChange={(e) => setPref('maxHours', Math.min(24, Math.max(1, Number(e.target.value) || 8)))} />
        </label>
        <label>
          <span>拆出的多条</span>
          <select className="select" value={prefs.schedule} disabled={!!tasks} onChange={(e) => setPref('schedule', e.target.value as Prefs['schedule'])}>
            <option value="backward">往前排工作日（截止日报当天）</option>
            <option value="forward">往后排工作日（从日报当天起）</option>
          </select>
        </label>
        <label className="daily-llm" title={llm ? `模型 ${llm.model}` : '代理未配置大模型（见 README）'}>
          <span>拆分方式</span>
          <span className="check-group">
            <button type="button" className="chip" aria-pressed={!!llm && prefs.useLlm} disabled={!llm || !!tasks} onClick={() => setPref('useLlm', true)}>
              大模型{llm ? '' : '（未配置）'}
            </button>
            <button type="button" className="chip" aria-pressed={!llm || !prefs.useLlm} disabled={!!tasks} onClick={() => setPref('useLlm', false)}>
              规则
            </button>
          </span>
        </label>
      </div>

      {!tasks && (
        <div className="field wide">
          <label className="field-label" htmlFor="daily-text">
            今日汇总
            <span className="field-hint">
              {llm && prefs.useLlm
                ? `由 ${llm.model} 识别任务与工时，超过 ${prefs.maxHours}h 按内容拆分；结果会先给你确认`
                : `每行一项，行内写工时（6h / 0.5d / 半天），可带 #编号 挂父需求、[项目KEY] 指定项目、「对接人：姓名」；超过 ${prefs.maxHours}h 按上限拆分`}
            </span>
          </label>
          <textarea
            id="daily-text"
            className="input textarea"
            rows={12}
            autoFocus
            value={text}
            placeholder={PLACEHOLDER}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                parse();
              }
            }}
          />
          {llm && prefs.useLlm && <span className="field-hint">日报内容会经本地代理发送到内部模型服务 {llm.model}，不会直接写入 Jira。</span>}
        </div>
      )}

      {tasks && (
        <div className="daily-preview">
          {parseNote && <div className="banner daily-banner">{parseNote}</div>}
          {overDays.length > 0 && (
            <div className="banner daily-banner">
              {overDays.map(([d, h]) => `${d} 合计 ${h}h`).join('，')}，超过 8h（不拦截，确认是否属实）
            </div>
          )}
          {sharedNeeds.map((n) => (
            <div key={n.project} className="daily-shared">
              {n.warnings.map((w) => (
                <p key={w} className="err">
                  {n.project} 的「{prefs.typeName}」{w}
                </p>
              ))}
              {n.ids.length > 0 && (
                <>
                  <p className="field-hint">
                    {n.project} 共用字段：以下必填项无法自动填写，所有 {n.project} 条目共用；有所属需求的条目会优先继承需求的值
                  </p>
                  <div className="form-grid">
                    {n.ids
                      .filter((id) => !n.unsupported.includes(id))
                      .map((id) => (
                        <FieldInput
                          key={id}
                          id={id}
                          meta={n.type.fields[id]}
                          value={shared[n.project]?.[id]}
                          project={n.project}
                          onChange={(v) => setShared((s) => ({ ...s, [n.project]: { ...s[n.project], [id]: v } }))}
                        />
                      ))}
                    {n.unsupported.length > 0 && (
                      <p className="err wide">工作台不支持填写：{n.unsupported.map((id) => n.type.fields[id].name).join('、')}，这些条目需要去 Jira 新建</p>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
          {tasks.length === 0 && <p className="muted">没有识别到任务，请返回修改日报内容。</p>}
          <ol className="daily-list">
            {tasks.map((t) => {
              const errs = errorsOf(t);
              const total = taskHours(t);
              return (
                <li key={t.id} className={`daily-task${errs.length ? ' invalid' : ''}`}>
                  <div className="daily-head">
                    <input
                      className="input grow"
                      aria-label="任务标题"
                      value={t.title}
                      disabled={busy}
                      onChange={(e) => updateTask(t.id, (x) => ({ ...x, title: e.target.value, pieces: x.pieces.length === 1 ? [{ ...x.pieces[0], title: e.target.value }] : x.pieces }))}
                    />
                    <select className="select" aria-label="项目" value={t.project} disabled={busy} onChange={(e) => updateTask(t.id, (x) => ({ ...x, project: e.target.value }))}>
                      {!projects?.some((p) => p.key === t.project) && <option value={t.project}>{t.project || '选择项目'}</option>}
                      {(projectKey ? projects?.filter((p) => p.key === projectKey) : projects)?.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.key}
                        </option>
                      ))}
                    </select>
                    <input
                      className="input daily-key"
                      aria-label="所属需求编号"
                      placeholder="所属需求（可空）"
                      value={t.parentKey ?? ''}
                      disabled={busy}
                      onChange={(e) => updateTask(t.id, (x) => ({ ...x, parentKey: e.target.value.trim().toUpperCase() || null }))}
                    />
                    <input
                      className="input daily-contact"
                      aria-label="一线对接人"
                      placeholder="一线对接人"
                      title="写入 Jira「一线对接人」；留空时有所属需求会继承需求上的值"
                      value={t.contact}
                      disabled={busy}
                      onChange={(e) => updateTask(t.id, (x) => ({ ...x, contact: e.target.value }))}
                    />
                    <HoursInput
                      value={t.hoursSource === 'missing' ? null : total}
                      disabled={busy}
                      onCommit={(h) => updateTask(t.id, (x) => resplit(x, h, opts))}
                    />
                    <span className={`tag-soft src-${t.hoursSource}`} title={t.sourceLine}>
                      {t.hoursSource === 'input' ? '原文工时' : t.hoursSource === 'estimated' ? '模型估算' : '缺工时'}
                    </span>
                    <button className="x-btn" aria-label="移除该项" disabled={busy} onClick={() => setTasks((ts) => ts && ts.filter((x) => x.id !== t.id))}>
                      ✕
                    </button>
                  </div>
                  {(t.pieces.length > 1 || status[pid(t, 0)]) && (
                    <ul className="daily-pieces">
                      {t.pieces.map((p, i) => {
                        const st = status[pid(t, i)];
                        return (
                          <li key={i} className={st ? `st-${st.state}` : undefined}>
                            {t.pieces.length > 1 && (
                              <input className="input grow" aria-label={`第 ${i + 1} 条标题`} value={p.title} disabled={busy || st?.state === 'done'} onChange={(e) => updatePiece(t, i, { title: e.target.value })} />
                            )}
                            {t.pieces.length > 1 && (
                              <input
                                className="input daily-h"
                                aria-label={`第 ${i + 1} 条工时`}
                                type="number"
                                min={0.5}
                                step={0.5}
                                value={p.hours ?? ''}
                                disabled={busy || st?.state === 'done'}
                                onChange={(e) => updatePiece(t, i, { hours: Number(e.target.value) || null })}
                              />
                            )}
                            <input className="input daily-date" aria-label={`第 ${i + 1} 条日期`} type="date" value={p.date} disabled={busy || st?.state === 'done'} onChange={(e) => e.target.value && updatePiece(t, i, { date: e.target.value })} />
                            <PieceState st={st} onSkip={(skip) => setStatus((s) => ({ ...s, [pid(t, i)]: skip ? { state: 'skip', key: st?.key } : { state: 'error', msg: '待重试' } }))} />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {(t.notes.length > 0 || errs.length > 0 || !!contactNote(t)) && (
                    <div className="daily-notes">
                      {contactNote(t) && <span className="muted">{contactNote(t)}</span>}
                      {t.notes.map((n) => (
                        <span key={n} className="muted">
                          {n}
                        </span>
                      ))}
                      {errs.map((e) => (
                        <span key={e} className="err">
                          {e}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          <p className="field-hint">
            每条按「{prefs.typeName}」新建：经办人/开发人员为你，开发预估时间为该条工时，开始/完成开发日期为该条日期，一线对接人按识别结果（留空则继承所属需求）；挂「需求」时按子项 blocks 需求，其余编号按“相关”关联。
          </p>
        </div>
      )}
    </Modal>
  );
}

/** 总工时输入：失焦或回车后才重新拆分，避免边输边拆 */
function HoursInput({ value, disabled, onCommit }: { value: number | null; disabled: boolean; onCommit: (h: number | null) => void }) {
  const [v, setV] = useState(value === null ? '' : `${value}h`);
  useEffect(() => setV(value === null ? '' : `${value}h`), [value]);
  const commit = () => {
    const h = parseDuration(v);
    if (h !== value) onCommit(h && h > 0 ? h : null);
  };
  return (
    <input
      className="input daily-h"
      aria-label="总工时"
      placeholder="工时"
      title="改总工时会按上限重新拆分，如 12h / 1.5d"
      value={v}
      disabled={disabled}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}

function PieceState({ st, onSkip }: { st?: PieceStatus; onSkip: (skip: boolean) => void }) {
  if (!st) return <span className="daily-st muted">待创建</span>;
  switch (st.state) {
    case 'creating':
      return <span className="daily-st muted">创建中…</span>;
    case 'done':
      return (
        <span className="daily-st ok" title={st.msg}>
          ✓ {st.key}
          {st.msg && <span className="err"> {st.msg}</span>}
        </span>
      );
    case 'dup':
      return (
        <span className="daily-st warn">
          已存在 {st.key}，跳过
          <button className="btn ghost small" onClick={() => onSkip(false)}>
            仍创建
          </button>
        </span>
      );
    case 'skip':
      return (
        <span className="daily-st muted">
          已跳过
          <button className="btn ghost small" onClick={() => onSkip(false)}>
            恢复
          </button>
        </span>
      );
    case 'error':
      return (
        <span className="daily-st err" title={st.msg}>
          {st.msg === '待重试' ? '待重试' : `失败：${st.msg}`}
          {st.msg !== '待重试' && (
            <button className="btn ghost small" onClick={() => onSkip(true)}>
              跳过
            </button>
          )}
        </span>
      );
  }
}
