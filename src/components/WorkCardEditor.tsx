import { useState } from 'react';
import type { Issue } from '../lib/types';
import type { HourFields } from '../lib/hours';
import { STAGES } from '../lib/stages';
import { NO_VERSION, versionNames } from '../lib/versions';
import { WORK_VIEWS } from '../lib/management';
import { RELATIONS, selectCardIssues, type WorkCard } from '../lib/workCards';
import { Modal } from './Modal';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';

export function WorkCardEditor({ card, issues, hourFields, user, canPreviewAll, projectKey, onSave, onClose }: {
  card: WorkCard; issues: Issue[]; hourFields: HourFields; user: string; canPreviewAll: boolean; projectKey: string | null;
  onSave: (card: WorkCard) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState(card);
  const [error, setError] = useState('');
  const options = useAsync(async signal => {
    const [priorities, project] = await Promise.all([api.priorities(signal), projectKey ? api.project(projectKey, signal) : Promise.resolve(null)]);
    return { priorities, project };
  }, [projectKey]);
  function set(patch: Partial<WorkCard>) { setDraft(d => ({ ...d, ...patch })); setError(''); }
  const types = [...new Set(['需求', '编码任务', 'BUG及数据问题', '其他任务', ...issues.map(i => i.fields.issuetype.name), ...draft.types])];
  const priorities = [...new Set([...(options.data?.priorities.map(p => p.name) ?? []), ...issues.map(i => i.fields.priority?.name ?? ''), draft.priority].filter(Boolean))];
  const versions = [...new Set([...(options.data?.project?.versions?.map(v => v.name) ?? []), ...issues.flatMap(i => versionNames(i.fields.versions)), draft.version].filter(v => v && v !== NO_VERSION))].sort();
  function submit() {
    if (!draft.title.trim()) { setError('请填写卡片名称'); return; }
    if (draft.dueFrom && draft.dueTo && draft.dueFrom > draft.dueTo) { setError('到期开始日期不能晚于结束日期'); return; }
    onSave({ ...draft, title: draft.title.trim() });
  }
  return <Modal title="配置工作台卡片" onClose={onClose} width={680} footer={<>
    {error && <span className="err" role="alert">{error}</span>}
    <button className="btn" onClick={onClose}>取消</button><button className="btn primary" onClick={submit}>保存并固定</button>
  </>}>
    <>{options.error && <p className="management-notice" role="alert">选项加载失败：{options.error.message}。暂显示已加载问题中的选项。<button className="btn small" onClick={options.reload}>重试</button></p>}<form className="form-grid work-card-form" onSubmit={e => { e.preventDefault(); submit(); }}>
      <label className="field"><span>卡片名称</span><input aria-label="卡片名称" className="input" value={draft.title} required maxLength={40} onChange={e => set({ title: e.target.value })}/></label>
      <label className="field"><span>人员范围</span><select aria-label="人员范围" className="select" value={draft.relation} onChange={e => set({ relation: e.target.value as WorkCard['relation'] })}>{Object.entries(RELATIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="field wide"><span>工作条件</span><select aria-label="工作条件" className="select" value={draft.view} onChange={e => set({ view: e.target.value as WorkCard['view'] })}><option value="any">全部（已解决项仅近30天）</option><option value="due">临期与逾期</option>{Object.entries(WORK_VIEWS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <fieldset className="field wide work-card-checks"><legend>阶段（不选为全部；与工作条件同时满足）</legend><div className="check-group">{STAGES.map(s => <label key={s.id}><input type="checkbox" checked={draft.stages.includes(s.id)} onChange={e => set({ stages: e.target.checked ? [...draft.stages, s.id] : draft.stages.filter(x => x !== s.id) })}/>{s.name}</label>)}</div></fieldset>
      <fieldset className="field wide work-card-checks"><legend>问题类型（不选为全部）</legend><div className="check-group">{types.map(t => <label key={t}><input type="checkbox" checked={draft.types.includes(t)} onChange={e => set({ types: e.target.checked ? [...draft.types, t] : draft.types.filter(x => x !== t) })}/>{t}</label>)}</div></fieldset>
      <label className="field"><span>优先级</span><select aria-label="优先级" className="select" value={draft.priority} onChange={e => set({ priority: e.target.value })}><option value="">全部优先级</option>{priorities.map(p => <option key={p}>{p}</option>)}</select></label>
      <label className="field"><span>影响版本</span><select aria-label="影响版本" className="select" value={draft.version} onChange={e => set({ version: e.target.value })}><option value="">全部影响版本</option><option value={NO_VERSION}>未设置版本</option>{versions.map(v => <option key={v}>{v}</option>)}</select></label>
      <label className="field wide"><span>标题或编号包含</span><input aria-label="标题或编号包含" className="input" value={draft.text} maxLength={100} onChange={e => set({ text: e.target.value })} placeholder="留空为不限"/></label>
      <label className="field"><span>到期开始日期</span><input aria-label="到期开始日期" className="input" type="date" value={draft.dueFrom} onChange={e => set({ dueFrom: e.target.value })}/></label>
      <label className="field"><span>到期结束日期</span><input aria-label="到期结束日期" className="input" type="date" value={draft.dueTo} onChange={e => set({ dueTo: e.target.value })}/></label>
      <label className="field"><span>卡片排序</span><select aria-label="卡片排序" className="select" value={draft.sort} onChange={e => set({ sort: e.target.value as WorkCard['sort'] })}><option value="updated">最近更新优先</option><option value="due">到期时间优先</option><option value="priority">优先级顺序（Jira ID 升序）</option></select></label>
      <label className="field"><span>显示条数</span><select aria-label="显示条数" className="select" value={draft.limit} onChange={e => set({ limit: Number(e.target.value) })}>{[3, 5, 8, 10].map(n => <option key={n} value={n}>{n} 条</option>)}</select></label>
      <label className="field"><span>卡片宽度</span><select aria-label="卡片宽度" className="select" value={draft.width} onChange={e => set({ width: Number(e.target.value) as WorkCard['width'] })}><option value={1}>1 / 4 行</option><option value={2}>半行</option><option value={3}>3 / 4 行</option><option value={4}>整行</option></select></label>
      <p className="work-card-preview wide" role="status">{draft.relation === 'all' && !canPreviewAll ? '保存后查询当前项目内所有人；当前预览仅加载了与我相关的数据。' : `当前已加载数据匹配 ${selectCardIssues(issues, draft, hourFields, user).length} 条。`} 卡片跟随左上角的项目切换。</p>
    </form></>
  </Modal>;
}
