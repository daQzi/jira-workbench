import { useState } from 'react';
import { api } from '../lib/api';
import { dateOf, presetRange, resolveHourFields, ymd, type RangePreset } from '../lib/hours';
import { MINE_CLAUSE, quote } from '../lib/jql';
import { MANAGEMENT_FIELDS, downloadCsv, searchPages } from '../lib/management';
import { auditHours, workReport } from '../lib/workReport';
import { useAsync } from '../lib/useAsync';
import { useSession } from '../lib/session';
import { copyText } from '../lib/clipboard';
import { ErrorState, Loading } from '../components/States';
import { ManagementTable } from '../components/ManagementTable';

export function ReviewView({projectKey,onOpen}:{projectKey:string|null;onOpen:(k:string)=>void}) {
  const {version,toast}=useSession();
  const [preset,setPreset]=useState<RangePreset>('thisWeek');
  const [custom,setCustom]=useState(presetRange('thisWeek'));
  const range=presetRange(preset,new Date(),custom);
  const [exclude,setExclude]=useState(true);const [tab,setTab]=useState<'report'|'audit'>('report');
  const data=useAsync(async signal=>{
    const hf=resolveHourFields(await api.fields());
    const fields=[...MANAGEMENT_FIELDS,...hf.estimate,...hf.devDone,...hf.devStart,'timespent'];
    const base=`${projectKey?`project = ${quote(projectKey)} AND `:''}${MINE_CLAUSE}`;
    // 日期落在区间的工作 + 未结束/近期更新的异常项，检查与汇总的数据范围明确分开。
    const dFields=hf.devDone.map(id=>`cf[${id.slice('customfield_'.length)}]`);
    const after=new Date(`${range.to}T12:00:00`);after.setDate(after.getDate()+1);
    const dated=[...dFields.map(f=>`(${f} >= ${quote(range.from)} AND ${f} <= ${quote(range.to)})`),`(resolved >= ${quote(range.from)} AND resolved < ${quote(ymd(after))})`].join(' OR ');
    const [period,audit]=await Promise.all([searchPages(`${projectKey?`project = ${quote(projectKey)} AND `:''}cf[10204] = currentUser() AND (${dated}) ORDER BY updated DESC`,fields,signal),searchPages(`${base} AND (resolution is EMPTY OR updated >= -30d) ORDER BY updated DESC`,fields,signal)]);
    return {hf,period,audit,scope:JSON.stringify([projectKey,range.from,range.to])};
  },[projectKey,version,range.from,range.to]);
  if(!data.data || data.data.scope!==JSON.stringify([projectKey,range.from,range.to]))return data.error?<ErrorState error={data.error} onRetry={data.reload}/>:<Loading/>;
  const {hf,period,audit}=data.data;
  const output=workReport(period.issues,hf,range.from,range.to,exclude);
  const anomalies=auditHours(audit.issues,hf);
  const undated=anomalies.filter(a=>!dateOf(a.issue,hf,'devDone')).length;
  return <div className="review-page">
    <div className="workspace-intro"><div><h2>工时检查与工作汇总</h2><p>按开发预估时间和开发完成/解决日期汇总，不写入 Jira 原生 worklog。</p></div><button className="btn" onClick={data.reload}>刷新</button></div>
    <div className="check-group"><button className="chip" onClick={()=>{setCustom({from:ymd(new Date()),to:ymd(new Date())});setPreset('custom');}}>今日</button>{(['thisWeek','lastWeek','thisMonth','lastMonth','custom']as RangePreset[]).map(p=><button className="chip" key={p} aria-pressed={preset===p} onClick={()=>setPreset(p)}>{({thisWeek:'本周',lastWeek:'上周',thisMonth:'本月',lastMonth:'上月',custom:'自定义'} as Partial<Record<RangePreset,string>>)[p]}</button>)}{preset==='custom'&&<><input aria-label="汇总开始日期" type="date" className="input" value={custom.from} max={custom.to} onChange={e=>e.target.value&&setCustom(c=>({...c,from:e.target.value}))}/><input aria-label="汇总结束日期" type="date" className="input" value={custom.to} min={custom.from} onChange={e=>e.target.value&&setCustom(c=>({...c,to:e.target.value}))}/></>}<label><input type="checkbox" checked={exclude} onChange={e=>setExclude(e.target.checked)}/>排除关联需求的 Bug</label></div>
    {data.error&&<ErrorState error={data.error} onRetry={data.reload}/>}
    {(period.total>period.issues.length||audit.total>audit.issues.length)&&<div className="management-notice">数据超过1000条上限，汇总/异常检查仅基于已加载结果，请缩小项目或日期范围。</div>}
    <div className="report-stats"><div><b>{output.report.total}h</b><span>{range.from} ~ {range.to}</span></div><div><b>{output.report.counted}</b><span>计入工作项</span></div><div><b>{anomalies.length}</b><span>待补全项（未结束或近30天更新）</span></div><div><b>{undated}</b><span>无统计日期，无法归属报表区间</span></div></div>
    <div className="check-group"><button className="chip" aria-pressed={tab==='report'} onClick={()=>setTab('report')}>日报 / 周报汇总</button><button className="chip" aria-pressed={tab==='audit'} onClick={()=>setTab('audit')}>工时完整性检查</button></div>
    {tab==='report'?<>
      <div className="management-notice">本页汇总开发人员是我的工作，与“我的工时”默认人员口径一致。有子项的需求只计子项；{output.report.excludedBugs} 个关联 Bug 已排除。可在“我的工时”设置具体人员口径。</div>
      <div className="check-group report-actions"><button className="btn primary" onClick={async()=>{try{await copyText(output.text);toast('已复制工作汇总');}catch{toast('复制失败，请从文本框手动复制','error');}}}>复制工作汇总</button><button className="btn" onClick={()=>downloadCsv(`工作汇总-${range.from}-${range.to}.csv`,[['编号','标题','日期','工时','状态'],...output.counted.map(it=>[it.issue.key,it.issue.fields.summary,it.date,it.hours,it.issue.fields.status.name])])}>导出汇总 CSV</button></div>
      <textarea className="input textarea report-output" aria-label="工作汇总文本" readOnly value={output.text} rows={12}/>
      <ManagementTable issues={output.counted.map(it=>it.issue)} onOpen={onOpen} scope={`report:${projectKey??'*'}`} onChanged={data.reload}/>
    </>:<><p className="muted">点击问题打开详情补填；若项目类型没有相关字段，需调整类型或配置。未填日期项无法判断属于哪一天，不会悄悄计入报表。</p><div className="audit-list">{anomalies.map(a=><button key={a.issue.key} onClick={()=>onOpen(a.issue.key)}><span className="mono">{a.issue.key}</span><strong>{a.issue.fields.summary}</strong><span className="err">{a.problems.join(' · ')}</span></button>)}{!anomalies.length&&<p className="state">当前检查范围没有缺失工时字段</p>}</div><ManagementTable issues={anomalies.map(a=>a.issue)} onOpen={onOpen} scope={`audit:${projectKey??'*'}`} onChanged={data.reload}/></>}
  </div>;
}
