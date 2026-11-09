import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { useManagementData } from '../lib/useManagementData';
import { useAsync } from '../lib/useAsync';
import { loadLocal, saveLocal, scopeKey } from '../lib/management';
import { changedNotice, noticesFor, snapshot, type Notice, type Snapshot } from '../lib/notifications';
import { ymd } from '../lib/hours';
import { Loading, ErrorState } from '../components/States';

interface Cache {read:string[];snapshots:Record<string,Snapshot>;changes:Notice[]}
export function NotificationsView({projectKey,onOpen,onMcp}:{projectKey:string|null;onOpen:(k:string)=>void;onMcp:()=>void}){
 const {me}=useSession();const key=`wb.inbox.v1:${scopeKey(me.jiraBaseUrl,me.name,projectKey)}`;
 const valid=(x:unknown):x is Cache=>!!x&&typeof x==='object'&&Array.isArray((x as Cache).read)&&Array.isArray((x as Cache).changes)&&typeof(x as Cache).snapshots==='object'&&!!(x as Cache).snapshots;
 const initial=()=>loadLocal<Cache>(key,{read:[],snapshots:{},changes:[]},valid);
 const [cache,setCache]=useState<{key:string;value:Cache}>(()=>({key,value:initial()}));
 const current=cache.key===key?cache.value:initial();
 const [kind,setKind]=useState('all');const [unread,setUnread]=useState(false);
 const data=useManagementData(projectKey);const mcp=useAsync(()=>api.mcpStatus(),[]);
 useEffect(()=>{
  if(!data.data)return;
  const before=loadLocal<Cache>(key,{read:[],snapshots:{},changes:[]},valid);
  const changes=[...before.changes];const snapshots={...before.snapshots};
  for(const i of data.data.issues){const old=before.snapshots[i.key];if(old&&typeof old.status==='string'){const n=changedNotice(i,old);if(n&&!changes.some(x=>x.id===n.id))changes.unshift(n);}snapshots[i.key]=snapshot(i);}
  const value={...before,changes:changes.slice(0,200),snapshots:Object.fromEntries(Object.entries(snapshots).slice(-1500))};
  setCache({key,value});saveLocal(key,value);
 },[data.data,key]);
 useEffect(()=>{const refresh=()=>{if(!document.hidden){data.reload();mcp.reload();}};const timer=setInterval(refresh,60000);window.addEventListener('focus',refresh);return()=>{clearInterval(timer);window.removeEventListener('focus',refresh);};},[projectKey]);
 if(!data.data)return data.error?<ErrorState error={data.error} onRetry={data.reload}/>:<Loading/>;
 const alerts=noticesFor(data.data.issues,data.data.hourFields,ymd(new Date()));
 const failed=(mcp.data?.operations??[]).filter(op=>['partial','blocked'].includes(op.state)).map(op=>({id:`mcp:${op.id}:${op.updatedAt}`,kind:'mcp' as const,title:`${op.agentName} · ${op.tool}`,detail:op.error?.message??'部分步骤未完成，请到 MCP 执行记录查看',time:op.updatedAt}));
 const all:Notice[]=[...alerts,...current.changes,...failed];
 const read=new Set(current.read);
 function mark(ids:string[]){const value={...current,read:[...new Set([...current.read,...ids])].slice(-3000)};setCache({key,value});saveLocal(key,value);}
 const filtered=all.filter(n=>(kind==='all'||n.kind===kind)&&(!unread||!read.has(n.id)));
 return <>
  <div className="workspace-intro"><div><h2>通知中心 <small>{all.filter(n=>!read.has(n.id)).length} 条未读</small></h2><p>聚合当前个人范围的风险事项及本机 MCP 失败记录。页面打开时每60秒更新，首次打开建立变化基线。</p></div><button className="btn" onClick={()=>{data.reload();mcp.reload();}}>刷新</button></div>
  <div className="management-notice">变化提醒比较本机两次读取的状态、经办人和版本；不追溯首次读取前的变更，也不包含全部评论/附件事件。已读只表示看过提醒，不代表问题已解决。</div>
  {(data.error||mcp.error)&&<ErrorState error={(data.error??mcp.error)!} onRetry={()=>{data.reload();mcp.reload();}}/>}
  {data.data.total>data.data.issues.length&&<div className="management-notice">当前仅分析前 {data.data.issues.length}/{data.data.total} 项，提醒可能不完整。</div>}
  <div className="saved-views"><select className="select" aria-label="通知类型" value={kind} onChange={e=>setKind(e.target.value)}>{Object.entries({all:'全部类型',overdue:'逾期',soon:'临期',blocked:'阻塞',hours:'工时异常',change:'事项变化',mcp:'Agent 执行失败'}).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select><label><input type="checkbox" checked={unread} onChange={e=>setUnread(e.target.checked)}/>只看未读</label><button className="btn small" onClick={()=>mark(filtered.map(n=>n.id))}>当前结果全部已读</button></div>
  <div className="inbox-list">{filtered.map(n=><article key={n.id} className={read.has(n.id)?'read':''}><button className="inbox-content" onClick={()=>{mark([n.id]);if(n.key)onOpen(n.key);else onMcp();}}><span className={`notice-dot ${n.kind}`}/><div><strong>{n.title}</strong><p>{n.detail}</p><small>{n.time?new Date(n.time).toLocaleString():'当前风险'}</small></div></button><button className="btn small ghost" disabled={read.has(n.id)} onClick={()=>mark([n.id])}>{read.has(n.id)?'已读':'标为已读'}</button></article>)}{!filtered.length&&<p className="state">没有符合条件的通知</p>}</div>
 </>;
}
