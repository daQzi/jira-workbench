import { useRef, useState } from 'react';
import { api, type Transition } from '../lib/api';
import { buildFields, editValue, inputKind, type FieldMeta, type FormValue } from '../lib/fields';
import { useAsync } from '../lib/useAsync';
import { useSession } from '../lib/session';
import type { Issue, IssueDetail } from '../lib/types';
import { Modal } from './Modal';
import { FieldInput } from './FieldInput';
import { IssuePicker } from './IssuePicker';
import { Loading, ErrorState } from './States';
import { validateBulkValue } from '../lib/bulk';
import { fieldText } from '../lib/format';
import { parentOf } from '../lib/tree';

type Mode = 'field' | 'transition' | 'comment' | 'parent';
type Result = { key: string; state: 'done' | 'failed' | 'unknown'; message: string };
interface Loaded { issue: IssueDetail; fields: Record<string, FieldMeta>; transitions: Transition[] }
interface Planned { loaded: Loaded; payload: Record<string, unknown>; before: Record<string, unknown>; label: string; transitionId?: string; target?: string; skip?: boolean }
const EXCLUDED = new Set(['project','issuetype','status','reporter','attachment','issuelinks','timetracking']);
const errorText = (e: unknown) => (e as Error).message;

export function BulkEditDialog({ issues, onClose, onDone }: { issues: Issue[]; onClose: () => void; onDone: () => void }) {
  const { canWriteIssue } = useSession();
  const [mode,setMode]=useState<Mode>('field');
  const [field,setField]=useState('');
  const [value,setValue]=useState<FormValue>();
  const [transition,setTransition]=useState('');
  const [flowValues,setFlowValues]=useState<Record<string,FormValue>>({});
  const [comment,setComment]=useState('');
  const [parent,setParent]=useState<Issue|null>(null);
  const [plan,setPlan]=useState<Planned[]|null>(null);
  const [results,setResults]=useState<Result[]>([]);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const locked=useRef(false);
  const data=useAsync(async () => {
    if(issues.length>50)throw new Error('每次最多处理50个问题');
    const loaded: Loaded[]=[];
    // 限制并发，避免旧 Jira 同时收到大量 editmeta 请求。
    for(let i=0;i<issues.length;i+=5) loaded.push(...await Promise.all(issues.slice(i,i+5).map(async i=>{
      if(!canWriteIssue(i.key))throw new Error(`${i.key} 未开放写入`);
      const [issue,meta,transitions]=await Promise.all([api.issue(i.key),api.editMeta(i.key),api.transitions(i.key)]);
      return { issue, fields:meta, transitions };
    })));
    return loaded;
  },[issues.map(i=>i.key).join(',')]);
  const loaded=data.data??[];
  const commonFields=Object.entries(loaded[0]?.fields??{}).filter(([id,m])=>!EXCLUDED.has(id)&&!!inputKind(id,m)&&loaded.every(l=>l.fields[id]&&inputKind(id,l.fields[id])===inputKind(id,m)&&(!l.fields[id].operations||l.fields[id].operations!.includes('set'))));
  const fid=commonFields.some(([id])=>id===field)?field:commonFields[0]?.[0]??'';
  const rawMeta=commonFields.find(([id])=>id===fid)?.[1];
  const intersectMeta = (id: string, m: FieldMeta) => ({ ...m, allowedValues: m.allowedValues?.filter(v=>loaded.every(l=>(l.fields[id]?.allowedValues??[]).some(x=>x.id===v.id))) });
  const meta=rawMeta?intersectMeta(fid,rawMeta):null;
  // ID、流转名、目标状态都一致才允许批量；同 ID 不代表跨工作流同一语义。
  const commonTransitions=(loaded[0]?.transitions??[]).filter(t=>loaded.every(l=>l.transitions.some(x=>x.id===t.id&&x.name===t.name&&x.to.name===t.to.name)));
  const tid=commonTransitions.some(t=>t.id===transition)?transition:commonTransitions[0]?.id??'';
  const selectedTransition=commonTransitions.find(t=>t.id===tid);
  const flowKinds=new Map<string,string|null>();
  let flowCompatible=true;
  for(const l of loaded)for(const [id,m]of Object.entries(l.transitions.find(t=>t.id===tid)?.fields??{})){const kind=inputKind(id,m);if(flowKinds.has(id)&&flowKinds.get(id)!==kind)flowCompatible=false;flowKinds.set(id,kind);}
  const flowMeta: Record<string,FieldMeta>={};
  if(selectedTransition) for(const l of loaded) for(const [id,m] of Object.entries(l.transitions.find(t=>t.id===tid)?.fields??{})) {
    if(flowMeta[id]&&inputKind(id,flowMeta[id])!==inputKind(id,m))continue;
    if(!flowMeta[id])flowMeta[id]=m;
    if(m.allowedValues&&flowMeta[id].allowedValues)flowMeta[id]={...m,required:m.required||flowMeta[id].required,allowedValues:flowMeta[id].allowedValues!.filter(v=>m.allowedValues!.some(x=>x.id===v.id))};
  }
  const reset=()=>{setPlan(null);setError('');};

  async function preview() {
    if(locked.current)return;locked.current=true;setBusy(true);setError('');
    try {
      const out:Planned[]=[];
      if(mode==='parent') {
        if(!parent)throw new Error('请先选择父需求');
        const full=await api.issue(parent.key);
        if(full.fields.issuetype.name!=='需求')throw new Error('父项必须是需求');
        if(!canWriteIssue(parent.key))throw new Error('父需求所在项目未开放写入');
      }
      for(const l of loaded) {
        let payload:Record<string,unknown>={},before:Record<string,unknown>={},label='',skip=false;
        if(mode==='field') {
          if(!meta||!fid)throw new Error('没有共同可编辑字段');
          validateBulkValue(l.fields[fid],value);
          const r=editValue(fid,l.fields[fid],l.issue.fields[fid],value);
          if(r.kind==='error')throw new Error(`${l.issue.key}: ${r.msg}`);
          skip=r.kind==='unchanged';if(r.kind==='set')payload={[fid]:r.value};
          before={[fid]:l.issue.fields[fid]};label=`${meta.name}：${fieldText(l.issue.fields[fid])||'未设置'} → ${value===undefined||value===''?'清空':Array.isArray(value)?value.join('、'):meta.allowedValues?.find(v=>v.id===value)?.name??value}`;
        }else if(mode==='transition') {
          const t=l.transitions.find(t=>t.id===tid&&t.name===selectedTransition?.name&&t.to.name===selectedTransition.to.name);
          if(!t)throw new Error('没有共同可用的流转');
          if(!flowCompatible)throw new Error('流转字段类型不一致，请分组处理');
          for(const [id,v]of Object.entries(flowValues)){if(!t.fields?.[id])continue;validateBulkValue(t.fields[id],v);}
          const p=buildFields(t.fields??{},flowValues);
          if(p.missing.length||p.unsupported.length)throw new Error(`${l.issue.key}: 请补充 ${[...p.missing,...p.unsupported].join('、')}`);
          payload=p.fields;before={status:l.issue.fields.status};label=`${t.name} → ${t.to.name}`;
        }else if(mode==='comment') {
          if(!comment.trim())throw new Error('备注不能为空');payload={body:comment.trim()};label=`添加备注：${comment.trim()}`;
          const p=await api.myPermissions(l.issue.key);if(!p.COMMENT_ISSUE)throw new Error(`${l.issue.key} 无添加备注权限`);
        }else{
          if(!parent||parent.key===l.issue.key||l.issue.fields.issuetype.name==='需求')throw new Error('仅允许将非需求问题挂到其他父需求下');
          const old=parentOf(l.issue);
          if(old&&old.key!==parent.key)throw new Error(`${l.issue.key} 已挂到 ${old.key}，请单独处理更换父需求`);
          skip=old?.key===parent.key;label=`挂到父需求 ${parent.key}`;before={issuelinks:l.issue.fields.issuelinks};
        }
        out.push({loaded:l,payload,before,label,skip,transitionId:mode==='transition'?tid:undefined,target:selectedTransition?.to.name});
      }
      setPlan(out);
    }catch(e){setError(errorText(e));}finally{locked.current=false;setBusy(false);}
  }
  async function execute() {
    if(!plan||locked.current||results.length)return;locked.current=true;setBusy(true);setError('');
    let stop=false;
    try {
      for(const p of plan){
        const key=p.loaded.issue.key;
        if(stop){setResults(r=>[...r,{key,state:'failed',message:'前序请求结果未知，后续未执行'}]);continue;}
        let sent=false;
        try {
          if(!canWriteIssue(key))throw new Error('未开放写入');
          const fresh=await api.issue(key);
          for(const [id,old] of Object.entries(p.before))if(JSON.stringify(fresh.fields[id])!==JSON.stringify(old))throw new Error('相关字段已被其他操作修改，请关闭后重新预览');
          if(p.skip){setResults(r=>[...r,{key,state:'done',message:'值相同，已跳过'}]);continue;}
          if(mode==='field'){
            const m=(await api.editMeta(key))[fid];if(!m)throw new Error('字段已不可编辑');validateBulkValue(m,value);
            const change=editValue(fid,m,fresh.fields[fid],value);if(change.kind==='error')throw new Error(change.msg);if(change.kind==='unchanged'){setResults(r=>[...r,{key,state:'done',message:'已是目标值'}]);continue;}
            sent=true;await api.editIssue(key,{[fid]:change.value});
            const check=await api.issue(key);if(editValue(fid,m,check.fields[fid],value).kind!=='unchanged')throw new Error('接口已返回成功，但读回值不一致，请核对');
          }else if(mode==='transition'){
            const current=(await api.transitions(key)).find(t=>t.id===p.transitionId&&t.name===selectedTransition?.name&&t.to.name===p.target);
            if(!current)throw new Error('流转已不可用，请重新预览');
            for(const [id,v] of Object.entries(flowValues))if(current.fields?.[id])validateBulkValue(current.fields[id],v);
            const checked=buildFields(current.fields??{},flowValues);if(checked.missing.length||checked.unsupported.length)throw new Error('流转必填字段已变化，请重新预览');
            sent=true;await api.doTransition(key,current.id,checked.fields);
            if((await api.issue(key)).fields.status.name!==p.target)throw new Error('流转接口已返回，读回状态不一致，请核对');
          }else if(mode==='comment'){sent=true;await api.addComment(key,comment.trim());}
          else{if(!parent||!canWriteIssue(parent.key))throw new Error('父需求未授权');if((await api.issue(parent.key)).fields.issuetype.name!=='需求')throw new Error('父需求类型已变化');sent=true;await api.linkChild(key,parent.key);}
          setResults(r=>[...r,{key,state:'done',message:'已完成'}]);
        }catch(e){
          const status=(e as {status?:number}).status;
          const uncertain=sent&&(!status||status>=500||status===408);
          if(uncertain)stop=true;
          setResults(r=>[...r,{key,state:uncertain?'unknown':'failed',message:`${uncertain?'结果待核实，勿直接重复提交：':''}${errorText(e)}`}]);
        }
      }
    }finally{locked.current=false;setBusy(false);onDone();}
  }
  return <Modal title={`批量处理 · ${issues.length} 个问题`} onClose={onClose} busy={busy} width={760} footer={<><span className="err" role="alert">{error}</span><button className="btn" disabled={busy} onClick={onClose}>{results.length?'关闭':'取消'}</button>{!results.length&&(plan?<button className="btn primary" disabled={busy} onClick={execute}>确认执行 {plan.filter(p=>!p.skip).length} 项</button>:<button className="btn primary" disabled={busy||!data.data} onClick={preview}>预览变更</button>)}</>}>
    {data.error?<ErrorState error={data.error} onRetry={data.reload}/>:!data.data?<Loading rows={4}/>:<>
      {!plan&&!results.length&&<><div className="check-group">{(['field','transition','comment','parent'] as Mode[]).map(m=><button className="chip" key={m} aria-pressed={mode===m} onClick={()=>{setMode(m);reset();}}>{{field:'修改字段',transition:'流转状态',comment:'添加备注',parent:'挂父需求'}[m]}</button>)}</div>
      <div className="bulk-form">{mode==='field'&&<><label>共同可编辑字段<select className="select" value={fid} onChange={e=>{setField(e.target.value);setValue(undefined);}}>{commonFields.map(([id,m])=><option value={id} key={id}>{m.name}</option>)}</select></label>{meta&&<FieldInput id={fid} meta={meta} value={value} onChange={setValue} issueKey={issues[0].key}/>}<p className="muted">留空表示清空；必填字段不能清空。每条都按 Jira editmeta 单独校验。</p></>}
      {mode==='transition'&&<><select className="select" aria-label="批量目标流转" value={tid} onChange={e=>{setTransition(e.target.value);setFlowValues({});}}>{commonTransitions.map(t=><option key={t.id} value={t.id}>{t.name} → {t.to.name}</option>)}</select>{!commonTransitions.length&&<p className="err">选中的问题没有相同 ID、名称及目标状态的共同流转，请分组选择。</p>}{Object.entries(flowMeta).map(([id,m])=><FieldInput key={id} id={id} meta={m} value={flowValues[id]} onChange={v=>setFlowValues(s=>({...s,[id]:v}))} issueKey={issues[0].key}/>)}</>}
      {mode==='comment'&&<textarea className="input textarea" aria-label="批量备注" rows={5} value={comment} onChange={e=>setComment(e.target.value)}/>}
      {mode==='parent'&&<><IssuePicker projectKey={issues[0].key.split('-')[0]} types={['需求']} exclude={issues.map(i=>i.key)} onPick={setParent} placeholder="选择父需求：输入编号或标题"/>{parent&&<p>父需求：{parent.key} {parent.fields.summary}</p>}</>}</div></>}
      {plan&&!results.length&&<button className="btn small" disabled={busy} onClick={()=>setPlan(null)}>返回修改</button>}
      {plan&&<><p>确认下面的变更后执行。逐条保存，失败不会回滚已经成功的操作。</p><div className="bulk-preview">{plan.map(p=><div key={p.loaded.issue.key}><strong>{p.loaded.issue.key}</strong><span>{p.loaded.issue.fields.summary}</span><p>{p.skip?'无需变更 · ':''}{p.label}</p></div>)}</div></>}
      {!!results.length&&<div role="status"><h4>执行结果 {results.length}/{issues.length}</h4>{results.map(r=><p key={r.key} className={r.state==='done'?'':'err'}>{r.key} · {r.message}</p>)}</div>}
    </>}
  </Modal>;
}
