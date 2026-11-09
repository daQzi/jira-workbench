import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { quote } from '../lib/jql';
import { blockers, finished, overdue, searchPages, MANAGEMENT_FIELDS } from '../lib/management';
import { childLinks } from '../lib/tree';
import { NO_VERSION, versionGroups } from '../lib/versions';
import { useAsync } from '../lib/useAsync';
import { useSession } from '../lib/session';
import { copyText } from '../lib/clipboard';
import { ManagementTable } from '../components/ManagementTable';
import { ErrorState, Loading } from '../components/States';
import type { Issue } from '../lib/types';

type Risk='all'|'open'|'bugs'|'overdue'|'unassigned'|'blocked';
export function VersionView({projectKey,onOpen}:{projectKey:string;onOpen:(k:string)=>void}) {
 const {version,toast}=useSession();
 const [selected,setSelected]=useState('');const [risk,setRisk]=useState<Risk>('open');
 const project=useAsync(()=>api.project(projectKey),[projectKey]);
 useEffect(()=>{setSelected('');setRisk('open');},[projectKey]);
 const versions=project.data?.key===projectKey?project.data.versions??[]:[];
 const actual=selected||(versions.find(v=>!v.archived&&!v.released)?.name??versions[0]?.name??NO_VERSION);
 const data=useAsync(async signal=>{const result=await searchPages(`project = ${quote(projectKey)} AND ${actual===NO_VERSION?'affectedVersion is EMPTY':`affectedVersion = ${quote(actual)}`} ORDER BY updated DESC`,MANAGEMENT_FIELDS,signal);return {...result,scope:`${projectKey}:${actual}`};},[projectKey,actual,version]);
 if(!project.data||project.data.key!==projectKey||!data.data||data.data.scope!==`${projectKey}:${actual}`)return project.error||data.error?<ErrorState error={(project.error??data.error)!} onRetry={()=>{project.reload();data.reload();}}/>:<Loading/>;
 const issues=data.data.issues,open=issues.filter(i=>!finished(i)),done=issues.length-open.length;
 const rules:Record<Risk,(i:Issue)=>boolean>={all:()=>true,open:i=>!finished(i),bugs:i=>!finished(i)&&/bug|缺陷/i.test(i.fields.issuetype.name),overdue:i=>overdue(i),unassigned:i=>!finished(i)&&!i.fields.assignee,blocked:i=>!finished(i)&&blockers(i).length>0};
 const titles:Record<Risk,string>={all:'所有事项',open:'未完成',bugs:'未关闭 Bug',overdue:'已逾期',unassigned:'未分配',blocked:'被阻塞'};
 const summary=[`版本进展：${projectKey} / ${actual===NO_VERSION?'未设置影响版本':actual}`,`已完成 ${done}/${issues.length} · ${issues.length?Math.round(done/issues.length*100):0}%`,...(['open','bugs','overdue','unassigned','blocked']as Risk[]).map(k=>`${titles[k]}：${issues.filter(rules[k]).length}`),...open.map(i=>`- ${i.key} ${i.fields.summary} · ${i.fields.status.name}`)].join('\n');
 const versionInfo=versions.find(v=>v.name===actual);
 return <>
  <div className="workspace-intro"><div><h2>版本进展与交付检查</h2><p>按 Jira 影响版本汇总；风险清单用于辅助检查，不代表自动判定可以发布。</p></div><button className="btn" onClick={data.reload}>刷新</button></div>
  <div className="saved-views"><select className="select" aria-label="进展影响版本" value={actual} onChange={e=>setSelected(e.target.value)}><option value={NO_VERSION}>未设置影响版本</option>{versionGroups(versions).map(g=><optgroup key={g.label} label={g.label}>{g.items.map(v=><option key={v.id} value={v.name}>{v.name}</option>)}</optgroup>)}</select><span className="muted">{versionInfo?.releaseDate?`计划发布日期 ${versionInfo.releaseDate}`:'未设置计划发布日期'} · {versionInfo?.released?'已发布':'未发布'}</span><button className="btn small" onClick={async()=>{try{await copyText(summary);toast('已复制版本进展');}catch{toast('复制失败','error');}}}>复制版本进展</button></div>
  {(data.error||project.error)&&<ErrorState error={(data.error??project.error)!} onRetry={data.reload}/>}
  {data.data.total>issues.length&&<div className="management-notice">版本共 {data.data.total} 项，当前仅加载 {issues.length} 项，以下完成比例和风险数不是全量。</div>}
  <div className="version-progress"><div><strong>{done}<small> / {issues.length} 项完成</small></strong><span>{issues.length?Math.round(done/issues.length*100):0}%</span></div><progress max={Math.max(1,issues.length)} value={done}/><p className="muted">需求、任务和 Bug 按问题计数，不按工时加权；没有阻塞项也不等于已完成验收。</p></div>
  <div className="work-view-grid">{(Object.keys(titles)as Risk[]).map(k=><button className={`work-view${risk===k?' active':''}`} key={k} aria-pressed={risk===k} onClick={()=>setRisk(k)}><span>{titles[k]}</span><b>{issues.filter(rules[k]).length}</b></button>)}</div>
  <details className="requirement-progress"><summary>需求及子项进度（链接反映当前状态，可能跨版本）</summary>{issues.filter(i=>i.fields.issuetype.name==='需求').map(i=>{const kids=childLinks(i);return <button key={i.key} onClick={()=>onOpen(i.key)}><span>{i.key} {i.fields.summary}</span><span>{kids.filter(k=>finished({fields:k.fields}as Issue)).length}/{kids.length} 子项完成</span></button>;})}</details>
  <ManagementTable issues={issues.filter(rules[risk])} onOpen={onOpen} scope={`version:${projectKey}`} onChanged={data.reload}/>
 </>;
}
