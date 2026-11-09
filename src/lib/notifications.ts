import { blockers, dueDate, dueSoon, finished, hoursProblems, overdue } from './management';
import type { HourFields } from './hours';
import type { Issue } from './types';
export interface Notice {id:string;key?:string;kind:'overdue'|'soon'|'blocked'|'hours'|'change'|'mcp';title:string;detail:string;time?:string}
export interface Snapshot {status:string;assignee:string;versions:string;updated:string}
export function snapshot(i:Issue):Snapshot{return {status:i.fields.status.name,assignee:i.fields.assignee?.name??'',versions:JSON.stringify(i.fields.versions??[]),updated:i.fields.updated??''};}
export function noticesFor(issues:Issue[],hf:HourFields,today:string):Notice[] {
 const out:Notice[]=[];
 for(const i of issues){
  const add=(kind:Notice['kind'],detail:string)=>out.push({id:`${kind}:${i.key}:${kind==='hours'?detail:kind==='blocked'?blockers(i).map(b=>b.key).sort().join(','):dueDate(i)}`,key:i.key,kind,title:`${i.key} ${i.fields.summary}`,detail,time:i.fields.updated});
  if(overdue(i,today))add('overdue',`已逾期 · 到期 ${dueDate(i)}`);else if(dueSoon(i,today))add('soon',`近3天到期 · ${dueDate(i)}`);
  if(!finished(i)&&blockers(i).length)add('blocked',`等待 ${blockers(i).map(b=>b.key).join('、')}`);
  if(i.fields.issuetype.name!=='需求'&&hoursProblems(i,hf).length)add('hours',hoursProblems(i,hf).join(' · '));
 }
 return out;
}
export function changedNotice(i:Issue,old:Snapshot):Notice|null {
 const next=snapshot(i),changes:string[]=[];
 if(next.status!==old.status)changes.push(`状态：${old.status} → ${next.status}`);
 if(next.assignee!==old.assignee)changes.push(`经办人：${old.assignee||'未分配'} → ${next.assignee||'未分配'}`);
 if(next.versions!==old.versions)changes.push('影响版本已变化');
 return changes.length?{id:`change:${i.key}:${next.updated}:${JSON.stringify(next)}`,key:i.key,kind:'change',title:`${i.key} ${i.fields.summary}`,detail:changes.join(' · '),time:next.updated}:null;
}
