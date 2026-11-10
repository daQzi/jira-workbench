import { useEffect, useState } from 'react';
import type { Issue } from '../lib/types';
import { COLUMNS, DEFAULT_LIST, readList, writeList, type Column, type ListPrefs } from '../lib/listPrefs';
import { downloadCsv, dueDate, overdue, scopeKey } from '../lib/management';
import { useSession } from '../lib/session';
import { parentOf } from '../lib/tree';
import { userName } from '../lib/format';
import { versionNames } from '../lib/versions';
import { StatusPill, TypeBadge } from './Badges';
import { BulkEditDialog } from './BulkEditDialog';

function value(i: Issue, c: Column) {
  const f=i.fields;
  switch(c){
    case 'status':return f.status.name;
    case 'parent':return parentOf(i)?.key??'';
    case 'assignee':return userName(f.assignee);
    case 'developer':return userName(f.customfield_10204);
    case 'version':return versionNames(f.versions).join('、');
    case 'priority':return f.priority?.name??'';
    case 'due':return dueDate(i)??'';
    case 'created':case 'updated':return typeof f[c]==='string'?(f[c] as string).slice(0,10):'';
  }
}
export function ManagementTable({issues,onOpen,scope='tasks',onChanged,serverSort=false,onSort,profile,onProfile,readOnly=false}: {
  readOnly?:boolean;issues:Issue[];onOpen:(key:string)=>void;scope?:string;onChanged?:()=>void;serverSort?:boolean;onSort?:(p:ListPrefs)=>void;profile?:ListPrefs;onProfile?:(p:ListPrefs)=>void;
}) {
  const {me,canWriteIssue,bump,toast}=useSession();
  const store=`wb.list.v1:${scopeKey(me.jiraBaseUrl,me.name,scope)}`;
  const [saved,setSaved]=useState<{key:string;value:ListPrefs}>(()=>({key:store,value:readList(store)}));
  const prefs=profile??(saved.key===store?saved.value:readList(store));
  const [config,setConfig]=useState(false);
  const [selected,setSelected]=useState<Set<string>>(new Set());
  const [bulk,setBulk]=useState<Issue[]|null>(null);
  const keys=issues.map(i=>i.key).join(',');
  useEffect(()=>setSelected(new Set()),[keys,store]);
  function set(p:ListPrefs){setSaved({key:store,value:p});if(!writeList(store,p))toast('无法保存本机列表设置','error');onProfile?.(p);onSort?.(p);}
  const sorted=serverSort?issues:[...issues].sort((a,b)=>{
    const field=prefs.sort;
    const av=field==='key'?a.key:field==='due'?dueDate(a):field==='priority'?a.fields.priority?.id:a.fields[field];
    const bv=field==='key'?b.key:field==='due'?dueDate(b):field==='priority'?b.fields.priority?.id:b.fields[field];
    if(!av||!bv)return av?-1:bv?1:0;
    return String(av).localeCompare(String(bv),undefined,{numeric:true})*(prefs.direction==='asc'?1:-1);
  });
  const writable=issues.filter(i=>!readOnly&&canWriteIssue(i.key));
  function move(c:Column,step:number){const arr=[...prefs.columns],index=arr.indexOf(c),to=index+step;if(to<0||to>=arr.length)return;[arr[index],arr[to]]=[arr[to],arr[index]];set({...prefs,columns:arr});}
  const all=writable.length>0&&writable.every(i=>selected.has(i.key));
  return <>
    {bulk&&<BulkEditDialog issues={bulk} onClose={()=>setBulk(null)} onDone={()=>{setSelected(new Set());bump();onChanged?.();}}/>}
    <div className="management-table-tools">
      <span className="muted">{issues.length} 条{!serverSort?' · 排序与导出作用于当前已加载结果':''}</span>
      <span className="grow"/>
      <select className="select" aria-label="列表排序" value={prefs.sort} onChange={e=>set({...prefs,sort:e.target.value as ListPrefs['sort']})}>{Object.entries({updated:'更新时间',due:'到期日',priority:'优先级',key:'编号',created:'创建时间'}).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select>
      <button className="btn small" onClick={()=>set({...prefs,direction:prefs.direction==='asc'?'desc':'asc'})}>{prefs.direction==='asc'?'升序 ↑':'降序 ↓'}</button>
      <button className="btn small" aria-expanded={config} onClick={()=>setConfig(v=>!v)}>列设置</button>
      <button className="btn small" disabled={!issues.length} onClick={()=>downloadCsv(`问题列表-${new Date().toISOString().slice(0,10)}.csv`,[['编号','标题',...prefs.columns.map(c=>COLUMNS[c])],...sorted.map(i=>[i.key,i.fields.summary,...prefs.columns.map(c=>value(i,c))])])}>导出当前结果 CSV</button>
    </div>
    {config&&<div className="list-config"><div className="check-group">{(Object.keys(COLUMNS)as Column[]).map(c=><button className="chip" key={c} aria-pressed={prefs.columns.includes(c)} onClick={()=>set({...prefs,columns:prefs.columns.includes(c)?prefs.columns.filter(x=>x!==c):[...prefs.columns,c]})}>{COLUMNS[c]}</button>)}<button className="btn small ghost" onClick={()=>set({...DEFAULT_LIST})}>恢复默认列</button></div><div className="column-widths"><label>标题宽度<input type="number" min={240} max={700} value={prefs.widths.title??360} onChange={e=>set({...prefs,widths:{...prefs.widths,title:Math.min(700,Math.max(240,Number(e.target.value)||360))}})}/></label>{prefs.columns.map((c,index)=><div key={c}><label>{COLUMNS[c]}<input aria-label={`${COLUMNS[c]}列宽`} type="number" min={90} max={700} value={prefs.widths[c]??120} onChange={e=>set({...prefs,widths:{...prefs.widths,[c]:Math.min(700,Math.max(90,Number(e.target.value)||120))}})}/></label><button className="btn small" disabled={!index} aria-label={`${COLUMNS[c]}左移`} onClick={()=>move(c,-1)}>←</button><button className="btn small" disabled={index===prefs.columns.length-1} aria-label={`${COLUMNS[c]}右移`} onClick={()=>move(c,1)}>→</button></div>)}</div></div>}
    {!!selected.size&&<div className="selection-bar"><strong>已选 {selected.size} 项</strong><button className="btn primary small" disabled={selected.size>50} onClick={()=>setBulk(issues.filter(i=>selected.has(i.key)))}>批量处理</button><button className="btn small ghost" onClick={()=>setSelected(new Set())}>取消选择</button>{selected.size>50&&<span className="err">每次最多50项</span>}</div>}
    <div className="management-table-scroll"><table className="tree-table management-table"><colgroup>{!readOnly&&<col style={{width:42}}/>}<col style={{width:prefs.widths.title??360}}/>{prefs.columns.map(c=><col key={c} style={{width:prefs.widths[c]??120}}/>)}</colgroup><thead><tr>{!readOnly&&<th><input type="checkbox" aria-label="选择当前结果中所有可写问题" checked={all} disabled={!writable.length} onChange={e=>setSelected(e.target.checked?new Set(writable.map(i=>i.key)):new Set())}/></th>}<th>问题</th>{prefs.columns.map(c=><th key={c}>{COLUMNS[c]}</th>)}</tr></thead><tbody>{sorted.map(i=><tr className={`row${selected.has(i.key)?' selected':''}`} key={i.key} onClick={()=>onOpen(i.key)}>{!readOnly&&<td onClick={e=>e.stopPropagation()}><input type="checkbox" aria-label={`选择 ${i.key}`} disabled={readOnly||!canWriteIssue(i.key)} checked={selected.has(i.key)} onChange={e=>setSelected(s=>{const n=new Set(s);if(e.target.checked)n.add(i.key);else n.delete(i.key);return n;})}/></td>}<td className="title-td"><button className="management-title" onClick={e=>{e.stopPropagation();onOpen(i.key);}}><TypeBadge type={i.fields.issuetype.name}/><span className="mono muted">{i.key}</span><span data-full-text={i.fields.summary}>{i.fields.summary}</span></button></td>{prefs.columns.map(c=><td key={c} className={c==='due'&&overdue(i)?'err':''}>{c==='status'?<StatusPill status={i.fields.status.name}/>:value(i,c)||'—'}</td>)}</tr>)}</tbody></table></div>
    {!issues.length&&<p className="state">没有符合条件的问题</p>}
  </>;
}
