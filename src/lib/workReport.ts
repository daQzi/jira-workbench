import { buildReport, dateOf, hoursOf, periodKey, type HourFields } from './hours';
import { hoursProblems } from './management';
import type { Issue } from './types';
export function workReport(issues:Issue[],hf:HourFields,from:string,to:string,excludeBugs=true) {
  const items=issues.map(issue=>({issue,hours:hoursOf(issue,hf,{measure:'estimate',basis:'devDone',hoursPerDay:8}),date:dateOf(issue,hf,'devDone')})).filter(it=>it.date&&it.date>=from&&it.date<=to).map(it=>({...it,period:periodKey(it.date!,'day')}));
  const report=buildReport(items,{grouped:true,excludeRequirementBugs:excludeBugs});
  const counted=report.rows.flatMap(r=>r.children.length?r.children:r.own?[r.own]:[]);
  const lines=[`工作汇总 ${from} ~ ${to}`,`合计 ${report.total}h · 计入 ${report.counted} 项${report.excludedBugs?` · 排除关联需求 Bug ${report.excludedBugs} 项`:''}`, ...report.rows.flatMap(r=>{
    const rows=r.children.length?r.children:r.own?[r.own]:[];
    return [r.children.length?`\n${r.key} ${r.summary} · ${r.total}h`:'',...rows.map(it=>`- ${it.issue.key} ${it.issue.fields.summary} · ${it.date} · ${it.hours===null?'未填工时':`${it.hours}h`} · ${it.issue.fields.status.name}`)];
  })];
  return {report,counted,text:lines.join('\n'),issues:items.map(i=>i.issue)};
}
export function auditHours(issues:Issue[],hf:HourFields) {return issues.filter(i=>i.fields.issuetype.name!=='需求').map(issue=>({issue,problems:hoursProblems(issue,hf)})).filter(i=>i.problems.length);}
