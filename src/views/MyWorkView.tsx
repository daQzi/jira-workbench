import { useState } from 'react';
import { useSession } from '../lib/session';
import type { Issue } from '../lib/types';
import { NO_VERSION, versionNames } from '../lib/versions';
import { ErrorState, Loading } from '../components/States';
import { ManagementTable } from '../components/ManagementTable';
import { WORK_VIEWS, matchesView, loadLocal, saveLocal, scopeKey, dueDate, blockers, type WorkView } from '../lib/management';
import { useManagementData } from '../lib/useManagementData';

interface WorkPrefs { view: WorkView; text: string; version: string }
interface Saved { id:string; name:string; prefs:WorkPrefs }
export function MyWorkView({ projectKey, onOpen }: { projectKey: string | null; onOpen: (key: string) => void }) {
  const {me,toast}=useSession();
  const key=`wb.workViews.v1:${scopeKey(me.jiraBaseUrl,me.name,projectKey)}`;
  const valid=(v:unknown):v is WorkPrefs=>!!v&&typeof v==='object'&&Object.hasOwn(WORK_VIEWS,String((v as WorkPrefs).view))&&typeof(v as WorkPrefs).text==='string'&&typeof(v as WorkPrefs).version==='string';
  const [state,setState]=useState(()=>({key,prefs:loadLocal(key,{view:'active',text:'',version:''} as WorkPrefs,valid)}));
  const prefs=state.key===key?state.prefs:loadLocal(key,{view:'active',text:'',version:''} as WorkPrefs,valid);
  const [saved,setSaved]=useState<{key:string;views:Saved[]}>(()=>({key,views:loadLocal<Saved[]>(`${key}:saved`,[],(v):v is Saved[]=>Array.isArray(v)&&v.every(x=>typeof x?.id==='string'&&typeof x.name==='string'&&valid(x.prefs)))}));
  const views=saved.key===key?saved.views:loadLocal<Saved[]>(`${key}:saved`,[],(v):v is Saved[]=>Array.isArray(v)&&v.every(x=>typeof x?.id==='string'&&typeof x.name==='string'&&valid(x.prefs)));
  const [name,setName]=useState('');
  const data=useManagementData(projectKey);
  const set=(patch:Partial<WorkPrefs>)=>{const next={...prefs,...patch};setState({key,prefs:next});if(!saveLocal(key,next))toast('无法保存工作视图','error');};
  if(!data.data)return data.error?<ErrorState error={data.error} onRetry={data.reload}/>:<Loading/>;
  const {issues,total,hourFields}=data.data;
  const base=issues.filter(i=>(!prefs.text||`${i.key} ${i.fields.summary}`.toLowerCase().includes(prefs.text.toLowerCase()))&&(!prefs.version||(prefs.version===NO_VERSION?!versionNames(i.fields.versions).length:versionNames(i.fields.versions).includes(prefs.version))));
  const shown=base.filter(i=>matchesView(i,prefs.view,hourFields,me.name));
  return <>
    <div className="workspace-intro"><div><h2>把今天需要处理的事情，放在眼前。</h2><p>今日待办按今天到期或今天开始开发判断；已结束事项保留近30天。</p></div><button className="btn" onClick={data.reload}>刷新</button></div>
    {data.error&&<ErrorState error={data.error} onRetry={data.reload}/>}
    {total>issues.length&&<div className="management-notice">共 {total} 项，当前仅加载前 {issues.length} 项；下方数量、筛选与导出基于已加载结果，请切换具体项目缩小范围。</div>}
    <div className="work-view-grid" role="group" aria-label="工作视图">{(Object.keys(WORK_VIEWS)as WorkView[]).map(v=><button key={v} className={`work-view${prefs.view===v?' active':''}`} aria-pressed={prefs.view===v} onClick={()=>set({view:v})}><span>{WORK_VIEWS[v]}</span><b>{base.filter(i=>matchesView(i,v,hourFields,me.name)).length}</b></button>)}</div>
    <div className="saved-views"><input className="input" type="search" aria-label="工作标题或编号" placeholder="标题或编号" value={prefs.text} onChange={e=>set({text:e.target.value})}/><select className="select" aria-label="工作影响版本" value={prefs.version} onChange={e=>set({version:e.target.value})}><option value="">全部影响版本</option><option value={NO_VERSION}>未设置版本</option>{[...new Set(issues.flatMap(i=>versionNames(i.fields.versions)))].sort().map(v=><option key={v}>{v}</option>)}</select><select className="select" aria-label="已保存的工作视图" value="" onChange={e=>{const v=views.find(v=>v.id===e.target.value);if(v)set(v.prefs);}}><option value="">打开保存的视图</option>{views.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select><input className="input" aria-label="工作视图名称" placeholder="为当前工作视图命名" value={name} maxLength={40} onChange={e=>setName(e.target.value)}/><button className="btn small" disabled={!name.trim()} onClick={()=>{const next=[...views.filter(v=>v.name!==name.trim()),{id:crypto.randomUUID(),name:name.trim(),prefs}].slice(-20);setSaved({key,views:next});saveLocal(`${key}:saved`,next);setName('');}}>保存工作视图</button><button className="btn small ghost" onClick={()=>set({view:'active',text:'',version:''})}>恢复默认</button></div>
    {!!views.length&&<details className="saved-manage"><summary>管理已保存视图</summary>{views.map(v=><span key={v.id}>{v.name}<button className="btn small ghost" aria-label={`删除工作视图 ${v.name}`} onClick={()=>{const next=views.filter(x=>x.id!==v.id);setSaved({key,views:next});saveLocal(`${key}:saved`,next);}}>删除</button></span>)}</details>}
    {prefs.view==='blocked'&&<div className="management-notice">仅显示未完成的入向 Blocks 依赖；需求下子项的父子链接不视为阻塞。</div>}
    {prefs.view==='missing'&&<div className="management-notice">按“开发人员、开发预估时间、开发完成/解决日期”检查。字段未配置也会提示，点击问题到详情补填。</div>}
    {(prefs.view==='overdue'||prefs.view==='soon'||prefs.view==='blocked')&&<div className="risk-strip">{shown.slice(0,5).map(i=><button key={i.key} className="chip" onClick={()=>onOpen(i.key)}>{i.key} · {prefs.view==='blocked'?`等待 ${blockers(i).map(b=>b.key).join('、')}`:`到期 ${dueDate(i)}`}</button>)}</div>}
    <ManagementTable issues={shown} onOpen={onOpen} scope={`work:${projectKey??'*'}`} onChanged={data.reload}/>
  </>;
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
