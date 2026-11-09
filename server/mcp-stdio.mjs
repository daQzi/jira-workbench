// 仅支持 stdio 的 MCP 客户端使用此桥接器；业务及身份仍由工作台负责。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const token=process.env.WB_MCP_TOKEN;
const url=new URL(process.env.WB_MCP_URL||'http://127.0.0.1:18787/mcp');
if(!token||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('请配置本机 WB_MCP_URL 和 WB_MCP_TOKEN');
const client=new Client({name:'jira-workbench-stdio',version:'0.1.2'});
await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
const server=new Server({name:'jira-workbench',version:'0.1.2'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,()=>client.listTools());
server.setRequestHandler(CallToolRequestSchema,({params})=>client.callTool(params));
await server.connect(new StdioServerTransport());
process.stdin.on('end',()=>Promise.all([client.close(),server.close()]).then(()=>process.exit(0)));
