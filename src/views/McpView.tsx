import { useState } from 'react';
import { api, type Transition } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useSession } from '../lib/session';
import { copyText } from '../lib/clipboard';
import { Loading, ErrorState } from '../components/States';
import type { McpGrant, McpPolicy, McpStatus } from '../lib/mcpTypes';

type Tab = 'connect' | 'grants' | 'policies' | 'history';
const TABS: Record<Tab, string> = { connect: '服务与连接', grants: 'Agent 授权', policies: '自动完成规则', history: '执行记录' };
const STATE: Record<string,string> = { running:'执行中', completed:'已完成', blocked:'需处理', partial:'部分完成' };

export function McpView() {
  const { toast, me } = useSession();
  const data = useAsync(() => api.mcpStatus(), []);
  const projects = useAsync(() => api.projects(), []);
  const [tab, setTab] = useState<Tab>('connect');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('日报助手');
  const [selected, setSelected] = useState<string[]>([]);
  const [access, setAccess] = useState<'read'|'write'>('read');
  const [roots, setRoots] = useState('');
  const [issued, setIssued] = useState<{ token: string; url: string; grant: McpGrant } | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [error, setError] = useState('');
  const status = data.data;
  async function action(run: () => Promise<unknown>) {
    if(busy)return;
    setBusy(true);setError('');
    try { await run(); data.reload(); } catch(e) {setError((e as Error).message);} finally {setBusy(false);}
  }
  const copy = async (text: string) => { try {await copyText(text);toast('已复制');} catch {toast('复制失败，请手动选择复制','error');} };
  function config(url: string, token: string) {
    return JSON.stringify({mcpServers:{'jira-workbench':{type:'http',url,headers:{Authorization:`Bearer ${token}`}}}},null,2);
  }
  if(!status)return data.error?<ErrorState error={data.error} onRetry={data.reload}/>:<Loading rows={5}/>;
  const waiting = status.grants.filter(g=>g.enabled&&!g.connected).length;
  return (
    <div className="mcp-page">
      <section className="mcp-hero">
        <div>
          <span className="mcp-eyebrow">本机智能体连接</span>
          <h2>让工作记录，自动归档。</h2>
          <p>授权你的 Agent 创建任务、填写每日工时，按指定路线完成状态流转。</p>
          <span className={`mcp-service-state ${status.enabled?'on':''}`}><i/>{status.enabled ? status.running ? `运行中 · ${status.running} 个操作进行中` : '已启用' : '已停用'}</span>
          {!!waiting && <span className="muted"> · {waiting} 个授权等待重新绑定登录</span>}
        </div>
        <button className={`btn ${status.enabled?'':'primary'}`} disabled={busy} onClick={()=>action(()=>api.saveMcpSettings({enabled:!status.enabled,policies:status.policies}))}>{status.enabled?'停用 MCP 服务':'启用 MCP 服务'}</button>
      </section>
      <nav className="mcp-tabs" aria-label="MCP 设置">
        {(Object.keys(TABS) as Tab[]).map(t=><button key={t} aria-selected={tab===t} onClick={()=>{setTab(t);setError('');}}>{TABS[t]}{t==='grants'&&<small>{status.grants.length}</small>}</button>)}
      </nav>
      {error&&<div className="mcp-alert err" role="alert">{error}</div>}
      {data.error&&<ErrorState error={data.error} onRetry={data.reload}/>}
      {!status.persistent&&<div className="mcp-alert">当前为临时存储，服务重启后授权与记录不会保留。正常桌面版使用本机持久存储。</div>}
      {tab==='connect'&&<>
        <section className="mcp-card">
          <h3>连接地址</h3><p className="muted">仅本机可访问，使用独立 Agent Token 验证身份。工作台关闭后服务随之退出。</p>
          <div className="mcp-address"><code>{status.url}</code><button className="btn small" onClick={()=>copy(status.url)}>复制地址</button></div>
          <div className="mcp-facts"><span>传输方式<strong>Streamable HTTP</strong></span><span>当前 Jira 用户<strong>{me.name}</strong></span><span>已授权 Agent<strong>{status.grants.filter(g=>g.enabled).length} 个</strong></span></div>
        </section>
        <section className="mcp-card">
          <h3>三步开始使用</h3>
          <ol className="mcp-steps"><li><b>开启服务</b><span>开启后，工作台会记住设置，下次启动自动恢复。</span></li><li><b>创建 Agent 授权</b><span>选择项目、只读或写入能力，复制一次性 Token 和连接配置。</span></li><li><b>调用每日工作工具</b><span>让 Agent 使用 jira_submit_daily；需要自动完成时先配置工作流路线。</span></li></ol>
          <div className="check-group"><button className="btn" onClick={()=>setTab('grants')}>配置 Agent 授权 →</button><button className="btn" disabled={busy} onClick={()=>action(async()=>{const r=await api.checkMcp();toast(`连接正常 · Jira 用户 ${r.user} · ${r.tools} 个 MCP 工具${r.enabled?'':'（服务尚未启用）'}`);})}>检查 Jira 连接</button></div>
        </section>
        <section className="mcp-card"><h3>兼容连接配置</h3><p>支持 HTTP MCP 的客户端填写上面的地址，并设置 Authorization 请求头。Token 仅在新建授权后显示一次。</p><pre className="mcp-code">{config(status.url,'<新建授权后获得的 Token>')}</pre><p className="muted">客户端配置格式可能不同，请按客户端要求填写 URL 与请求头。仅支持 stdio 时运行随包 server/mcp-stdio.mjs，环境变量设置 WB_MCP_URL、WB_MCP_TOKEN。</p></section>
      </>}
      {tab==='grants'&&<>
        <section className="mcp-card"><h3>新增 Agent 授权</h3><p className="muted">默认只读；允许写入后可创建、修改、流转、添加备注及上传附件，仍受 Jira 本身权限限制。</p>
          <div className="form-grid">
            <label className="field"><span>Agent 名称</span><input className="input" value={name} onChange={e=>setName(e.target.value)} maxLength={80}/></label>
            <label className="field"><span>操作权限</span><select className="select" value={access} onChange={e=>setAccess(e.target.value as 'read'|'write')}><option value="read">只读查询</option><option value="write" disabled={!me.allowWrite}>每日工作录入与写入</option></select></label>
            <div className="field wide"><span>授权项目（至少选择一个）</span><div className="check-group">{projects.data?.map(p=><button className="chip" key={p.key} aria-pressed={selected.includes(p.key)} onClick={()=>setSelected(x=>x.includes(p.key)?x.filter(k=>k!==p.key):[...x,p.key])}>{p.name} <small>{p.key}</small></button>)}</div>{projects.error&&<span className="err">{projects.error.message}</span>}</div>
            <label className="field wide"><span>允许上传附件的目录（可选，每行一个绝对路径）</span><textarea className="input textarea" rows={2} placeholder="不填写则禁止上传本机文件" value={roots} onChange={e=>setRoots(e.target.value)}/></label>
          </div>
          <button className="btn primary" disabled={busy||!name.trim()||!selected.length} onClick={()=>action(async()=>{const r=await api.createMcpGrant({name:name.trim(),projects:selected,access,attachmentRoots:roots.split('\n').map(x=>x.trim()).filter(Boolean)});setIssued(r);})}>创建授权</button>
        </section>
        {issued&&<section className="mcp-card mcp-secret"><h3>保存 {issued.grant.name} 的连接配置</h3><p>Token 仅本次显示；关闭后无法再查看。丢失时请撤销此授权并重新创建。</p><pre className="mcp-code">{config(issued.url,issued.token)}</pre><div className="check-group"><button className="btn primary" onClick={()=>copy(config(issued.url,issued.token))}>复制连接配置</button><button className="btn" onClick={()=>copy(issued.token)}>复制 Token</button><button className="btn ghost" onClick={()=>setIssued(null)}>我已保存，隐藏</button></div></section>}
        <section className="mcp-card"><div className="mcp-section-head"><h3>已授权 Agent</h3><button className="btn small" onClick={data.reload}>刷新</button></div>
          {!status.grants.length&&<p className="muted">尚未添加 Agent。创建后即可复制连接配置。</p>}
          {status.grants.map(g=><div className="mcp-grant" key={g.id}><div><strong>{g.name}</strong><p>{g.projects.join('、')} · {g.access==='write'?'可写入':'只读'} · {g.revoked?'已撤销':!g.enabled?'已停用':g.connected?'登录有效':'需重新绑定'}</p></div><div className="check-group">{!g.revoked&&<><button className="btn small" disabled={busy} onClick={()=>action(()=>api.updateMcpGrant(g.id,{rebind:true}))}>绑定当前登录</button><button className="btn small" disabled={busy} onClick={()=>action(()=>api.updateMcpGrant(g.id,{enabled:!g.enabled}))}>{g.enabled?'停用':'启用'}</button><button className="btn small ghost" disabled={busy} onClick={()=>action(()=>api.revokeMcpGrant(g.id))}>撤销</button></>}</div></div>)}
        </section>
      </>}
      {tab==='policies'&&<PolicyEditor status={status} busy={busy} save={p=>action(()=>api.saveMcpSettings({enabled:status.enabled,policies:p}))} onError={setError}/>}
      {tab==='history'&&<section className="mcp-card"><div className="mcp-section-head"><div><h3>执行记录</h3><p className="muted">查看已创建的问题与失败步骤。Agent 使用 jira_get_operation 查询详情、jira_resume_operation 补齐字段后继续。</p></div><button className="btn small" onClick={data.reload}>刷新记录</button></div>
        {!status.operations.length&&<p className="muted">暂无操作记录。</p>}
        {status.operations.map(op=><div key={op.id} className="mcp-operation"><div className="mcp-section-head"><div><strong>{op.agentName}</strong> <code>{op.tool}</code><p className="muted">{new Date(op.createdAt).toLocaleString()} · {STATE[op.state]??op.state}</p></div><button className="btn small" onClick={()=>setDetail(detail===op.id?null:op.id)}>{detail===op.id?'收起':'查看结果'}</button></div>{detail===op.id&&<pre className="mcp-code">{JSON.stringify({operationId:op.id,result:op.result,entries:op.results,error:op.error},null,2)}</pre>}</div>)}
      </section>}
    </div>
  );
}

function PolicyEditor({status,busy,save,onError}:{status:McpStatus;busy:boolean;save:(p:McpPolicy[])=>void;onError:(s:string)=>void}) {
  const [sample,setSample]=useState('');
  const [loaded,setLoaded]=useState<{projectKey:string;typeName:string;from:string;transitions:Transition[]}|null>(null);
  const [loading,setLoading]=useState(false);
  const [policy,setPolicy]=useState<McpPolicy>({id:'daily-complete',projectKey:'',typeName:'',targetStatus:'',requireResolution:false,steps:[]});
  const [transition,setTransition]=useState('');
  const [stepFields,setStepFields]=useState('{}');
  async function load() {
    setLoading(true);onError('');
    try {
      const k=sample.trim().toUpperCase(),[issue,transitions]=await Promise.all([api.issue(k),api.transitions(k)]);
      if(policy.steps.length && (policy.projectKey!==k.split('-')[0] || policy.typeName!==issue.fields.issuetype.name))throw new Error('路线已有步骤，请使用同一项目、同一类型的示例问题');
      setLoaded({projectKey:k.split('-')[0],typeName:issue.fields.issuetype.name,from:issue.fields.status.name,transitions});setTransition(transitions[0]?.id??'');
      setPolicy(p=>({...p,projectKey:k.split('-')[0],typeName:issue.fields.issuetype.name}));
    }catch(e){onError((e as Error).message);}finally{setLoading(false);}
  }
  function add() {
    const t=loaded?.transitions.find(t=>t.id===transition);if(!t||!loaded)return;
    try {
      const raw=JSON.parse(stepFields);
      if(!raw||Array.isArray(raw)||typeof raw!=='object'||Object.values(raw).some(v=>typeof v!=='string'&&!(Array.isArray(v)&&v.every(x=>typeof x==='string'))))throw new Error('字段必须是“字段 ID: 字符串或字符串数组”的 JSON 对象');
      setPolicy(p=>({...p,targetStatus:t.to.name,steps:[...p.steps.filter(s=>s.from!==loaded.from),{from:loaded.from,transitionId:t.id,to:t.to.name,fields:raw}]}));
    }catch(e){onError((e as Error).message);}
  }
  return <>
    <section className="mcp-card"><h3>配置自动完成路线</h3><p className="muted">使用现有问题读取当前允许的流转，只查询、不修改该问题。每个起始状态添加一步，直到目标状态；只有已完成的实际工作才应授权自动流转。</p>
      <div className="check-group"><input className="input" aria-label="示例问题编号" placeholder="示例问题，如 AGENT-123" value={sample} onChange={e=>setSample(e.target.value)}/><button className="btn" disabled={loading||!sample.trim()} onClick={load}>{loading?'读取中…':'读取可用流转'}</button></div>
      {loaded&&<div className="mcp-policy-builder"><p>{loaded.projectKey} · {loaded.typeName} · 当前状态：<strong>{loaded.from}</strong></p><select className="select" aria-label="策略流转" value={transition} onChange={e=>setTransition(e.target.value)}>{loaded.transitions.map(t=><option key={t.id} value={t.id}>{t.name} → {t.to.name}（{t.id}）</option>)}</select><p className="muted">可选补充字段：按字段 ID 填表单值，例如解决结果填写选项 ID。开发日期可使用日报日期。</p><textarea className="input textarea mono" aria-label="流转补充字段" rows={3} value={stepFields} onChange={e=>setStepFields(e.target.value)}/>{loaded.transitions.find(t=>t.id===transition)?.fields&&<details><summary>查看此流转字段与选项</summary><pre className="mcp-code">{JSON.stringify(loaded.transitions.find(t=>t.id===transition)?.fields,null,2)}</pre></details>}<button className="btn" disabled={!transition} onClick={add}>添加此步到路线</button></div>}
      <div className="form-grid mcp-policy-fields"><label className="field"><span>策略 ID（供 Agent 调用）</span><input className="input" value={policy.id} onChange={e=>setPolicy(p=>({...p,id:e.target.value}))}/></label><label className="field"><span>目标状态（精确名称）</span><input className="input" value={policy.targetStatus} onChange={e=>setPolicy(p=>({...p,targetStatus:e.target.value}))}/></label></div>
      <p className="muted">适用：{policy.projectKey||'待选择'} / {policy.typeName||'待选择'}。新增路线时请使用同一项目、同一类型的问题。</p>
      {policy.steps.map(s=><div className="mcp-route-step" key={s.from}><span>{s.from} <b>→</b> {s.to} <small>流转 {s.transitionId}</small></span><button className="btn small ghost" onClick={()=>setPolicy(p=>({...p,steps:p.steps.filter(x=>x.from!==s.from)}))}>移除</button></div>)}
      <label className="mcp-policy-check"><input type="checkbox" checked={policy.requireResolution} onChange={e=>setPolicy(p=>({...p,requireResolution:e.target.checked}))}/>到达目标时必须存在解决结果</label>
      <button className="btn primary" disabled={busy||!policy.id.trim()||!policy.projectKey||!policy.targetStatus.trim()||!policy.steps.length} onClick={()=>save([...status.policies.filter(p=>p.id!==policy.id),policy])}>保存完成策略</button>
    </section>
    <section className="mcp-card"><h3>已配置策略</h3>{!status.policies.length&&<p className="muted">尚无自动完成策略。Agent 仍可新建任务或执行单步流转。</p>}{status.policies.map(p=><div className="mcp-grant" key={p.id}><div><strong>{p.id}</strong><p>{p.projectKey} · {p.typeName} → {p.targetStatus} · {p.steps.length} 步</p></div><div className="check-group"><button className="btn small" onClick={()=>setPolicy(p)}>编辑</button><button className="btn small ghost" disabled={busy} onClick={()=>save(status.policies.filter(x=>x.id!==p.id))}>移除</button></div></div>)}</section>
  </>;
}
