import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { realpath } from 'node:fs/promises';
import { createMcpStore, problem } from './mcp-store.mjs';
import { createToolService, toolDefinitions, policySchema, errorBody } from './mcp-tools.mjs';
import { isLocalRequest } from './settings.mjs';

const grantInput=z.object({name:z.string().trim().min(1).max(80),projects:z.array(z.string().regex(/^[A-Z][A-Z0-9]+$/)).min(1).max(50),access:z.enum(['read','write']),attachmentRoots:z.array(z.string().min(1).max(2000)).max(10).default([])}).strict();
const settingsInput=z.object({enabled:z.boolean(),policies:z.array(policySchema).max(100)}).strict().superRefine((v,ctx)=>{
  if(new Set(v.policies.map(p=>p.id)).size!==v.policies.length)ctx.addIssue({code:'custom',message:'策略 ID 不可重复'});
  for(const p of v.policies)if(new Set(p.steps.map(s=>s.from)).size!==p.steps.length)ctx.addIssue({code:'custom',message:'每个起始状态只能配置一条路线'});
});
const publicGrant=({sid,baseUrl,...g})=>g;
export function createMcpFeature({dir,jira,getSession,getBaseUrl,getWritePolicy,readBody,sendJson}) {
  const store=createMcpStore(dir);
  const active=new Set();
  const config=()=>store.config();
  function check(g,write=false) {
    if(!config().enabled)throw problem('MCP_DISABLED','MCP 服务已停用');
    const latest=store.grant(g.id);
    if(!latest?.enabled)throw problem('AGENT_REVOKED','Agent 授权已停用或撤销');
    if(latest.baseUrl!==getBaseUrl())throw problem('AUTH_REQUIRED','Jira 地址已变化，请在工作台重新绑定');
    const session=getSession(g.sid);
    if(!session || session.user!==g.user)throw problem('AUTH_REQUIRED','Jira 登录已失效，请在工作台重新登录并绑定 Agent');
    if(write && latest.access!=='write')throw problem('READ_ONLY','该 Agent 只有只读权限');
    if(write && !getWritePolicy().allowWrite)throw problem('READ_ONLY','工作台未开启 Jira 写入');
  }
  const tools=createToolService({store,check,jira:async(g,method,sub,body)=>{
    check(g,method!=='GET');
    const session=getSession(g.sid);return jira(session,method,sub,body,g);
  }});
  const parse=async(req)=>{try{return JSON.parse((await readBody(req)).toString('utf8'));}catch{throw problem('INVALID_INPUT','请求不是合法 JSON');}};
  function replyError(res,e) {const status=e instanceof z.ZodError?400:e.code==='AUTH_REQUIRED'?401:e.code==='MCP_DISABLED'?503:403;sendJson(res,status,{errorMessages:[e instanceof z.ZodError?e.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('；'):e.message],code:e.code||'INVALID_INPUT'});}
  function visible(user){return store.grants().filter(g=>g.user===user && g.baseUrl===getBaseUrl());}
  function status(req,user){
    const c=config();const grants=visible(user);
    return {...c,url:`http://${req.headers.host}/mcp`,running:tools.running(),activeRequests:active.size,persistent:!!dir,grants:grants.map(g=>({...publicGrant(g),connected:!!getSession(g.sid)})),operations:grants.flatMap(g=>store.operations(g.id).map(op=>({id:op.id,grantId:op.grantId,agentName:g.name,tool:op.tool,state:op.state,createdAt:op.createdAt,updatedAt:op.updatedAt,error:op.error,result:op.result,results:op.results}))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,100)};
  }
  return {
    async close(){await tools.drain();for(const transport of active)await transport.close();active.clear();store.close();},
    async manage(req,res,url,session) {
      if(!isLocalRequest(req.headers))return sendJson(res,403,{errorMessages:['只允许本机同源管理 MCP']});
      if(!session)return sendJson(res,401,{errorMessages:['请先登录工作台']});
      try {
        if(req.method==='POST' && url.pathname==='/api/mcp/check') {
          await jira(session,'GET','mypermissions');
          return sendJson(res,200,{enabled:config().enabled,user:session.user,tools:toolDefinitions.length,url:`http://${req.headers.host}/mcp`});
        }
        if(req.method==='GET' && url.pathname==='/api/mcp/status')return sendJson(res,200,status(req,session.user));
        if(req.method==='PUT' && url.pathname==='/api/mcp/settings') {
          const input=settingsInput.parse(await parse(req));
          const policy=getWritePolicy();
          if(policy.writeProjects.length && input.policies.some(p=>!policy.writeProjects.includes(p.projectKey)))throw problem('FORBIDDEN_PROJECT','完成策略超出工作台可写项目');
          store.saveConfig(input);return sendJson(res,200,status(req,session.user));
        }
        if(req.method==='POST' && url.pathname==='/api/mcp/grants') {
          const input=grantInput.parse(await parse(req));
          const policy=getWritePolicy();
          if(input.access==='write' && (!policy.allowWrite || (policy.writeProjects.length && input.projects.some(p=>!policy.writeProjects.includes(p)))))throw problem('READ_ONLY','Agent 写入范围超出工作台权限');
          input.projects=[...new Set(input.projects)];
          input.attachmentRoots=await Promise.all(input.attachmentRoots.map(p=>realpath(p)));
          const r=store.createGrant({...input,user:session.user,sid:session.sid,baseUrl:getBaseUrl()});
          return sendJson(res,201,{grant:publicGrant(r.grant),token:r.token,url:`http://${req.headers.host}/mcp`});
        }
        const match=url.pathname.match(/^\/api\/mcp\/grants\/([a-f0-9-]+)$/);
        if(match && ['PUT','DELETE'].includes(req.method)) {
          const g=store.grant(match[1]);if(!g||g.user!==session.user||g.baseUrl!==getBaseUrl())throw problem('NOT_FOUND','授权不存在');
          if(req.method==='DELETE'){g.enabled=false;g.revoked=true;}
          else {
            const a=z.object({enabled:z.boolean().optional(),rebind:z.boolean().optional()}).strict().parse(await parse(req));
            if(g.revoked)throw problem('AGENT_REVOKED','已撤销的授权不可恢复，请新建授权');
            if(a.enabled!==undefined)g.enabled=a.enabled;
            if(a.rebind)g.sid=session.sid;
          }
          store.updateGrant(g);return sendJson(res,200,status(req,session.user));
        }
        sendJson(res,404,{errorMessages:['未知 MCP 管理接口']});
      }catch(e){replyError(res,e);}
    },
    async handle(req,res) {
      if(!isLocalRequest(req.headers))return sendJson(res,403,{errorMessages:['MCP 仅支持本机来源']});
      if(!config().enabled)return sendJson(res,503,{errorMessages:['MCP 服务已停用'],code:'MCP_DISABLED'});
      const token=/^Bearer (\S+)$/.exec(req.headers.authorization||'')?.[1];
      const g=token?store.authenticate(token):null;
      if(!g)return sendJson(res,401,{errorMessages:['缺少或无效的 Agent Token'],code:'UNAUTHORIZED'});
      try {check(g);}catch(e){return replyError(res,e);}
      if(req.method!=='POST')return sendJson(res,405,{errorMessages:['该无状态 MCP 入口仅使用 POST']},{Allow:'POST'});
      const sdk=new McpServer({name:'jira-workbench',version:'0.1.2'},{maxToolInputElements:5000});
      for(const t of toolDefinitions) {
        if(g.access==='read'&&!t.readOnly)continue;
        sdk.registerTool(t.name,{description:t.description,inputSchema:t.schema,annotations:{readOnlyHint:t.readOnly,destructiveHint:false,idempotentHint:true,openWorldHint:true}},async input=>{
          try {
            const result=await tools.call(g,t.name,input);
            const failed=['blocked','partial'].includes(result?.state);
            return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result && typeof result==='object'&&!Array.isArray(result)?result:{result},isError:failed};
          }catch(e){const out=errorBody(e);return {isError:true,content:[{type:'text',text:JSON.stringify(out)}],structuredContent:out};}
        });
      }
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      active.add(transport);
      const close=()=>{active.delete(transport);sdk.close().catch(()=>{});};
      res.on('finish',close);
      try {
        const input=await parse(req);await sdk.connect(transport);await transport.handleRequest(req,res,input);
      }catch(e){if(!res.headersSent)replyError(res,e);else res.end();close();}
    },
  };
}
