import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, stopServer } from './index.mjs';

const directory=mkdtempSync(path.join(os.tmpdir(),'wb-mcp-test-'));
const meta={summary:{name:'标题',required:true,schema:{type:'string'}},assignee:{name:'经办人',required:false,schema:{type:'user'}},description:{name:'描述',required:false,schema:{type:'string'}},customfield_10204:{name:'开发人员',required:true,schema:{type:'user'}},customfield_1:{name:'开发预估时间',required:true,schema:{type:'string'}},customfield_2:{name:'开发完成日期',required:true,schema:{type:'date'}},customfield_3:{name:'开始开发日期',required:false,schema:{type:'date'}}};
let url, cookie, token, grantId, mockUrl, count=0, commentCount=0, uploadCount=0, transitionCount=0;
let failTransition=false;
let holdCreate=null, notifyCreate=null, failComment=false, multiStep=false;
const issues=new Map();
const response=(res,body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(body===undefined?'':JSON.stringify(body));};
const mock=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost');
  const raw=[];for await(const c of req)raw.push(c);
  const ct=req.headers['content-type']||'';
  const body=ct.includes('json')?JSON.parse(Buffer.concat(raw).toString()||'null'):null;
  const sub=u.pathname.replace('/rest/api/2/','');
  if(u.pathname==='/rest/auth/1/session'){
    if(req.method==='POST'){res.setHeader('Set-Cookie','JSESSIONID=fake; Path=/');return response(res,{name:'alice'});}
    return response(res,{name:'alice'});
  }
  if(sub==='mypermissions')return response(res,{permissions:{}});
  if(sub==='field')return response(res,Object.entries(meta).map(([id,m])=>({id,name:m.name,custom:id.startsWith('customfield_'),schema:m.schema})));
  if(sub==='project')return response(res,[{id:'1',key:'AGENT',name:'测试项目'},{id:'2',key:'OTHER',name:'其他项目'}]);
  if(sub==='project/AGENT')return response(res,{id:'1',key:'AGENT',name:'测试项目',components:[],versions:[],issueTypes:[{id:'1',name:'其他任务'}]});
  if(sub==='priority')return response(res,[]);
  if(sub==='issueLinkType')return response(res,{issueLinkTypes:[]});
  if(sub==='issue/createmeta')return response(res,{projects:[{key:'AGENT',issuetypes:[{id:'1',name:'其他任务',fields:meta},{id:'2',name:'需求',fields:meta}]}]});
  if(sub==='search')return response(res,{issues:[...issues.values()],total:issues.size,startAt:0,maxResults:30});
  if(sub==='issue'&&req.method==='POST') {
    count++;
    if (holdCreate) { notifyCreate?.(); await holdCreate; }
    const key=`AGENT-${count}`;
    const type=body.fields.issuetype.id==='2'?'需求':'其他任务';
    issues.set(key,{id:String(count),key,fields:{...body.fields,project:{key:'AGENT'},issuetype:{id:body.fields.issuetype.id,name:type},status:{id:'1',name:'新增'}}});
    return response(res,{id:String(count),key},201);
  }
  const m=sub.match(/^issue\/(AGENT-\d+)(?:\/(.*))?$/);
  if(m) {
    const issue=issues.get(m[1]);if(!issue)return response(res,{errorMessages:['不存在']},404);
    if(m[2]==='transitions') {
      if(req.method==='GET' && multiStep)return response(res,{transitions:issue.fields.status.name==='新增'?[{id:'11',name:'开始',to:{id:'3',name:'处理中'},fields:{}}]:issue.fields.status.name==='处理中'?[{id:'21',name:'完成',to:{id:'2',name:'关闭'},fields:{}}]:[]});
      if(req.method==='GET')return response(res,{transitions:issue.fields.status.name==='新增'?[{id:'21',name:'完成',to:{id:'2',name:'关闭'},fields:{resolution:{name:'解决结果',required:true,schema:{type:'resolution'},allowedValues:[{id:'1',name:'完成'}]}}}]:[]});
      if(failTransition)return response(res,{errorMessages:['暂时无权限']},403);
      transitionCount++;
      if(multiStep && body.transition.id==='11'){issue.fields.status={id:'3',name:'处理中'};return response(res,undefined,204);}
      issue.fields.status={id:'2',name:'关闭'};issue.fields.resolution=body.fields.resolution;issue.fields.resolutiondate='2026-11-09T10:00:00+0800';return response(res,undefined,204);
    }
    if(m[2]==='comment'){commentCount++;if(failComment)return response(res,{errorMessages:['响应可能丢失']},502);return response(res,{id:String(commentCount)},201);}
    if(m[2]==='attachments'){uploadCount++;return response(res,[{id:String(uploadCount),filename:'test.txt'}],201);}
    if(m[2]==='editmeta')return response(res,{fields:meta});
    if(req.method==='PUT'){Object.assign(issue.fields,body.fields);return response(res,undefined,204);}
    return response(res,issue);
  }
  return response(res,{errorMessages:[`mock 未实现 ${req.method} ${sub}`]},404);
});
async function manage(method,sub,body) {
 const r=await fetch(url+sub,{method,headers:{Cookie:cookie,'Content-Type':'application/json',Origin:url},...(body?{body:JSON.stringify(body)}:{})});
 return {status:r.status,body:await r.json()};
}
async function connect(t=token){const c=new Client({name:'test-agent',version:'1'});await c.connect(new StreamableHTTPClientTransport(new URL(url+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${t}`}}}));return c;}
const policy={id:'daily',projectKey:'AGENT',typeName:'其他任务',targetStatus:'关闭',requireResolution:true,steps:[{from:'新增',transitionId:'21',to:'关闭',fields:{resolution:'1'}}]};
const daily={requestId:'daily-1',workDate:'2026-11-09',entries:[{entryId:'one',projectKey:'AGENT',typeName:'其他任务',summary:'接口联调',hours:6,completion:'complete',policyId:'daily',comment:'已完成验证'},{entryId:'two',projectKey:'AGENT',typeName:'其他任务',summary:'现场支持',hours:2,completion:'complete',policyId:'daily'}]};

beforeAll(async()=>{
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));mockUrl=`http://127.0.0.1:${mock.address().port}`;
 ({url}=await startServer({jiraBaseUrl:mockUrl,port:0,allowWrite:true,writeProjects:['AGENT'],settingsFile:path.join(directory,'settings.json'),sessionDir:path.join(directory,'sessions'),serveDist:true,distDir:path.resolve('dist')}));
 const r=await fetch(url+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'alice',password:'fake'})});cookie=r.headers.get('set-cookie').split(';')[0];
});
afterAll(async()=>{await stopServer();await new Promise(r=>mock.close(r));rmSync(directory,{recursive:true,force:true});});

describe.sequential('内置 HTTP MCP 与模拟 Jira 全流程',()=>{
 it('默认关闭；管理接口必须网页登录，Agent Token 不代替管理会话',async()=>{
  expect((await fetch(url+'/mcp',{method:'POST'})).status).toBe(503);
  expect((await fetch(url+'/api/mcp/status')).status).toBe(401);
  const state=await manage('GET','/api/mcp/status');expect(state.body.enabled).toBe(false);
  expect((await manage('POST','/api/mcp/check',{})).body.user).toBe('alice');
 });
 it('开启并创建项目受限的 Agent，Token 仅返回一次且数据库无明文',async()=>{
  expect((await manage('PUT','/api/mcp/settings',{enabled:true,policies:[policy]})).status).toBe(200);
  const r=await manage('POST','/api/mcp/grants',{name:'日报助手',projects:['AGENT'],access:'write',attachmentRoots:[directory]});
  expect(r.status).toBe(201);token=r.body.token;grantId=r.body.grant.id;
  const state=await manage('GET','/api/mcp/status');expect(JSON.stringify(state.body)).not.toContain(token);expect(JSON.stringify(state.body)).not.toContain(cookie.split('=')[1]);
  const fs=await import('node:fs');expect(fs.readFileSync(path.join(directory,'mcp.sqlite')).includes(Buffer.from(token))).toBe(false);
  expect((await fetch(url+'/api/mcp/status',{headers:{Authorization:`Bearer ${token}`}})).status).toBe(401);
 });
 it('官方客户端完成握手、列工具、查询；阻止越权及非法来源',async()=>{
  const c=await connect();
  try {
   expect((await c.listTools()).tools.some(t=>t.name==='jira_submit_daily')).toBe(true);
   expect((await c.callTool({name:'jira_get_context',arguments:{}})).structuredContent.user).toBe('alice');
   const r=await c.callTool({name:'jira_search_issues',arguments:{projectKey:'OTHER'}});expect(r.isError).toBe(true);expect(r.structuredContent.code).toBe('FORBIDDEN_PROJECT');
  }finally{await c.close();}
  expect((await fetch(url+'/mcp',{method:'POST',headers:{Origin:'https://evil.test',Authorization:`Bearer ${token}`}})).status).toBe(403);
 });
 it('日报预览不写；两条共8h自动创建、填字段、备注、完成并读回核验',async()=>{
  const c=await connect();try {
   const preview=await c.callTool({name:'jira_submit_daily',arguments:{...daily,mode:'preview'}});expect(preview.isError).toBe(false);expect(count).toBe(0);
   const r=await c.callTool({name:'jira_submit_daily',arguments:daily});expect(r.isError).toBe(false);expect(r.structuredContent.state).toBe('completed');
   expect(r.structuredContent.result.entries).toHaveLength(2);expect(count).toBe(2);expect(transitionCount).toBe(2);expect(commentCount).toBe(1);
   for(const i of issues.values()){expect(i.fields.status.name).toBe('关闭');expect(i.fields.customfield_2).toBe('2026-11-09');expect(i.fields.customfield_10204.name).toBe('alice');}
  }finally{await c.close();}
 });
 it('同 requestId 重试不重复创建；改内容则返回冲突',async()=>{
  const c=await connect();try{
   const r=await c.callTool({name:'jira_submit_daily',arguments:daily});expect(r.structuredContent.state).toBe('completed');expect(count).toBe(2);
   const conflict=await c.callTool({name:'jira_submit_daily',arguments:{...daily,entries:[{...daily.entries[0],hours:5}]}});expect(conflict.structuredContent.code).toBe('IDEMPOTENCY_CONFLICT');
  }finally{await c.close();}
 });
 it('创建成功后流转失败，恢复时只继续流转，不重建或重复备注',async()=>{
  const c=await connect();try{
   failTransition=true;
   const a={...daily,requestId:'daily-fail',entries:[daily.entries[0]]};
   const r=await c.callTool({name:'jira_submit_daily',arguments:a});expect(r.structuredContent.state).toBe('partial');expect(count).toBe(3);
   failTransition=false;
   const resumed=await c.callTool({name:'jira_resume_operation',arguments:{operationId:r.structuredContent.id}});expect(resumed.structuredContent.state).toBe('completed');expect(count).toBe(3);expect(commentCount).toBe(2);
  }finally{await c.close();failTransition=false;}
 });
 it('附件仅允许授权目录；普通字段更新校验 editmeta',async()=>{
  writeFileSync(path.join(directory,'test.txt'),'test');
  const c=await connect();try{
   expect((await c.callTool({name:'jira_upload_attachment',arguments:{requestId:'file-1',issueKey:'AGENT-1',path:path.join(directory,'test.txt')}})).isError).toBe(false);expect(uploadCount).toBe(1);
   const denied=await c.callTool({name:'jira_upload_attachment',arguments:{requestId:'file-outside',issueKey:'AGENT-1',path:path.resolve('package.json')}});expect(denied.structuredContent.error.code).toBe('FILE_OUTSIDE_ALLOWED_ROOT');
   const r=await c.callTool({name:'jira_update_issue',arguments:{requestId:'edit-1',issueKey:'AGENT-1',fields:{summary:'更新后的标题'}}});expect(r.isError).toBe(false);expect(issues.get('AGENT-1').fields.summary).toBe('更新后的标题');
  }finally{await c.close();}
 });
 it('并发相同写请求共享操作，只发送一次评论；未知写入结果不会因续跑重复发出',async()=>{
  const c=await connect(),d=await connect();try{
   const params={name:'jira_add_comment',arguments:{requestId:'concurrent-comment',issueKey:'AGENT-1',body:'并发仅写一次'}};
   const before=commentCount;
   const [a,b]=await Promise.all([c.callTool(params),d.callTool(params)]);
   expect(a.structuredContent.id).toBe(b.structuredContent.id);expect(commentCount).toBe(before+1);
   failComment=true;
   const unknown=await c.callTool({name:'jira_add_comment',arguments:{requestId:'unknown-comment',issueKey:'AGENT-1',body:'不要盲重发'}});
   expect(unknown.structuredContent.error.code).toBe('UNKNOWN_OUTCOME');
   const n=commentCount;failComment=false;
   const resumed=await c.callTool({name:'jira_resume_operation',arguments:{operationId:unknown.structuredContent.id}});
   expect(resumed.structuredContent.error.code).toBe('UNKNOWN_OUTCOME');expect(commentCount).toBe(n);
  }finally{failComment=false;await c.close();await d.close();}
 });
 it('服务停用等待已发创建结束，后续流转暂停；重启启用后显式续跑不重建',async()=>{
  const c=await connect();
  let release;holdCreate=new Promise(r=>{release=r;});
  const started=new Promise(r=>{notifyCreate=r;});
  try {
   const task=c.callTool({name:'jira_submit_daily',arguments:{...daily,requestId:'pause-daily',entries:[{...daily.entries[1],entryId:'pause',comment:undefined}]}});
   await started;
   await manage('PUT','/api/mcp/settings',{enabled:false,policies:[policy]});
   const beforeTransitions=transitionCount;release();holdCreate=null;notifyCreate=null;
   const r=await task;expect(r.structuredContent.state).toBe('partial');expect(transitionCount).toBe(beforeTransitions);
   const before=count;
   await manage('PUT','/api/mcp/settings',{enabled:true,policies:[policy]});
   const resumed=await c.callTool({name:'jira_resume_operation',arguments:{operationId:r.structuredContent.id}});
   expect(resumed.structuredContent.state).toBe('completed');expect(count).toBe(before);
  }finally{release();holdCreate=null;notifyCreate=null;await c.close();}
 });
 it('多步自动流转每一步重新查询 Jira 状态，按配置到达最终状态',async()=>{
  const p={...policy,id:'multi',requireResolution:false,steps:[{from:'新增',transitionId:'11',to:'处理中',fields:{}},{from:'处理中',transitionId:'21',to:'关闭',fields:{}}]};
  await manage('PUT','/api/mcp/settings',{enabled:true,policies:[policy,p]});
  multiStep=true;
  issues.set('AGENT-99',{id:'99',key:'AGENT-99',fields:{summary:'多步示例',project:{key:'AGENT'},issuetype:{id:'1',name:'其他任务'},status:{id:'1',name:'新增'}}});
  const c=await connect();try{
   const n=transitionCount;
   const r=await c.callTool({name:'jira_complete_issue',arguments:{requestId:'multi-step',issueKey:'AGENT-99',policyId:'multi'}});
   expect(r.structuredContent.state).toBe('completed');expect(transitionCount).toBe(n+2);expect(issues.get('AGENT-99').fields.status.name).toBe('关闭');
  }finally{multiStep=false;await c.close();await manage('PUT','/api/mcp/settings',{enabled:true,policies:[policy]});}
 });
 it('只读授权不列写工具且服务端拒绝写入',async()=>{
  const r=await manage('POST','/api/mcp/grants',{name:'只读助手',projects:['AGENT'],access:'read',attachmentRoots:[]});
  const c=await connect(r.body.token);try{expect((await c.listTools()).tools.some(t=>t.name==='jira_create_issue')).toBe(false);expect((await c.callTool({name:'jira_add_comment',arguments:{requestId:'read-write',issueKey:'AGENT-1',body:'不应写'}})).isError).toBe(true);}finally{await c.close();}
 });
 it('重启保存开关、授权和操作幂等；停用拒绝新连接，重新启用不重放',async()=>{
  await stopServer();({url}=await startServer({jiraBaseUrl:mockUrl,port:0,allowWrite:true,writeProjects:['AGENT'],settingsFile:path.join(directory,'settings.json'),sessionDir:path.join(directory,'sessions')}));
  const c=await connect();try{const r=await c.callTool({name:'jira_submit_daily',arguments:daily});expect(r.structuredContent.state).toBe('completed');expect(count).toBe(4);}finally{await c.close();}
  await manage('PUT','/api/mcp/settings',{enabled:false,policies:[policy]});expect((await fetch(url+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${token}`}})).status).toBe(503);
  await manage('PUT','/api/mcp/settings',{enabled:true,policies:[policy]});expect(count).toBe(4);
  await manage('DELETE',`/api/mcp/grants/${grantId}`);expect((await fetch(url+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${token}`}})).status).toBe(403);
 });
});
