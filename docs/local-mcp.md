# Jira 工作台内置 MCP 使用说明

本功能已在本地实现。服务只监听本机回环地址，随工作台启动和退出。默认关闭，不需单独部署。未配置自动完成路线时可以查询、新建、修改和单步流转；自动完成必须先配置对应项目+类型的策略。

## 启动与设置

源码运行：使用仓库指定 Node 26.8.2，`npm ci` 后执行 `npm run dev`；编译模式执行 `npm run build && npm start`。这两个入口会自动构建共享业务模块。不要跳过预构建而直接执行 server/index.mjs。

1. 在工作台登录 Jira，进入侧栏“设置 → MCP 服务”。
2. 开启服务，查看实际连接地址。桌面版通常是 `http://127.0.0.1:18787/mcp`；源码版使用配置端口，开发代理还可以同源访问 `/mcp`。
3. 在“Agent 授权”创建独立授权，选择项目、只读/写入能力。默认只读。写入还受工作台 WB_ALLOW_WRITE、项目白名单及 Jira 用户权限限制。
4. 保存一次性显示的 Token/连接配置。Token 不会再次返回；丢失时撤销后重建。不要把 Token 写入项目仓库或分享给其他人。
5. 需要上传附件时给该 Agent 配置允许的本机绝对目录；未配置则禁止读取本机文件上传。上限每个文件 20MB。
6. 在“自动完成规则”输入已有示例问题编号，读取其当前可用流转，添加路线步骤并保存策略。这个配置动作只读取示例任务，不替它流转。每个项目+类型分别配置。

## 连接客户端

支持 Streamable HTTP 的 MCP 客户端配置示例（不同客户端字段可能不同）：

```json
{
  "mcpServers": {
    "jira-workbench": {
      "type": "http",
      "url": "http://127.0.0.1:18787/mcp",
      "headers": { "Authorization": "Bearer <在工作台创建的Token>" }
    }
  }
}
```

仅支持 stdio 的客户端：使用 Node 运行随包 `server/mcp-stdio.mjs`，通过环境变量 `WB_MCP_URL`、`WB_MCP_TOKEN` 传入连接配置。源码版路径为仓库下 server/mcp-stdio.mjs；桌面包里是 app/server/mcp-stdio.mjs，Node 使用包内运行时。需填写各电脑实际绝对路径，不是安装到系统 PATH 的命令。桥接器只转接工作台，不另建 Jira 登录。

## 工具

只读：`jira_get_context`、`jira_search_issues`、`jira_get_issue`、`jira_get_schema`、`jira_get_transitions`、`jira_get_operation`。

写入：`jira_create_issue`、`jira_update_issue`、`jira_transition_issue`、`jira_add_comment`、`jira_upload_attachment`、`jira_link_issue`、`jira_complete_issue`、`jira_submit_daily`、`jira_resume_operation`。

- 调用前用 get_context 读取项目授权及完成策略，用 get_schema 查询实际类型/必填字段。
- fields 按字段 ID 填表单值：普通字符串、用户名、选项 ID、字符串数组；不是直接拼 Jira REST 对象。必填项不够时返回 schema 和缺失原因。
- 新建需求/编码任务/其他任务共用 jira_create_issue 的 typeName，不依赖固定类型 ID。
- 状态只能通过当前允许的 transitionId 或已配置完成策略修改。
- 查询仅限授权项目；关联需两端项目均被授权；跨项目关系摘要会按读取授权裁剪。
- 更新已有任务的状态或修改字段不自动关闭其父需求。

## 每日工作记录

由 Agent 明确给出日期、小时数及工作是否完成。MCP 不估算工时、不自动改排到前几天、不自动运行定时任务。由调用方自行决定何时提交。

```json
{
  "requestId": "daily-2026-11-09-001",
  "workDate": "2026-11-09",
  "mode": "execute",
  "entries": [
    {
      "entryId": "integration",
      "projectKey": "AGENT",
      "typeName": "其他任务",
      "summary": "完成结算接口联调",
      "hours": 6,
      "completion": "complete",
      "policyId": "daily-complete",
      "comment": "正常及异常流程验证通过"
    },
    {
      "entryId": "support",
      "projectKey": "AGENT",
      "typeName": "其他任务",
      "summary": "现场对账支持",
      "hours": 2,
      "completion": "keep_current"
    }
  ]
}
```

示例项目、策略必须替换成实际配置值。可选 parentKey 挂父需求，attachments 为授权目录下路径数组，fields 补业务特有必填项。每次最多20条，每条工时最大24h。先用 `mode: "preview"` 可检查创建字段而不写 Jira。

首版日报入口创建独立每日工作项。操作已有任务使用 update_issue / complete_issue，不在日报入口隐式覆盖已有任务多日工时。

日报预检要求支持当前工作台的“开发预估时间”“开发人员”字段，并填开发日期。缺少“开发完成日期”时仅支持当天 complete，最终必须通过解决日期读回核验。缺字段、历史日期不能计入、同名字段不唯一或关联需求 Bug 默认被排除时，会明确拒绝或返回未通过统计核验，不能将“创建成功”视为“工时必定可见”。小时数按现有预估字段口径处理，不额外写 Jira worklog。

## 自动完成路线

在设置页通过示例问题读取真实流转，不自动猜测未知路线。每一步配置起始状态、transitionId、目标状态和可选字段；例如 resolution 填选项 ID。若需要多个中间状态，可分别使用处于不同状态的同类示例任务补齐路线。

执行每一步都会重新查询当前可执行流转、检查字段并读回状态。缺权限、路线变化、多候选或超过12步时停止；已到目标则不重复流转。经过测试/验收节点的路线，配置前需确认它符合实际业务。

## 幂等与恢复

- 写入传稳定 requestId，日报每条传稳定 entryId。完全相同请求重复调用返回原执行记录；相同 ID 改内容会被拒绝。
- 已知失败不会因为普通重试自动继续；用 `jira_resume_operation({operationId, fieldsByEntry})` 明确续跑。
- 日报 fieldsByEntry 的键是 entryId；普通操作使用 `issue`。示例：`{"operationId":"…","fieldsByEntry":{"integration":{"customfield_123":"补充值"}}}`。
- 创建、关联、备注、附件和流转逐步记入本机 SQLite。已创建但后续失败时返回编号，续跑不重新创建。
- HTTP 错误或进程中断导致写入结果不确定时，标记 UNKNOWN_OUTCOME 并冻结步骤，禁止自动重发。首版需用户在 Jira 人工核实处理，不提供强制清除未知结果按钮。
- 停用后拒绝新调用，已发 Jira 请求等待返回并落盘，下一步暂停；重新开启不会自动重放。HTTP断开不代表 Jira 操作取消。
- 执行记录可在页面查看，Agent 使用 get_operation 获取详细步骤。首版工具调用同步返回，不包含独立后台作业队列。

## 登录、配置与发行

Token 摘要、开关、完成策略、授权和执行记录保存在本机 `mcp.sqlite`：桌面版在 JiraWorkbench 配置目录，源码版在 .wb-data。SQLite 文件按当前用户私有权限创建；会话继续沿用现有加密存储。

退出登录或 Jira 地址变化后绑定失效，重新登录后在授权列表点击“绑定当前登录”。撤销不可恢复；停用可恢复。关闭 MCP 开关不会删除历史记录。

构建新增 MCP SDK/Zod 运行依赖、esbuild 开发依赖和 Node 自带 SQLite。桌面包把服务端/stdio桥接器打成独立 ESM，不依赖发行用户安装 node_modules。macOS/Windows 的运行时仍与 .node-version 一致。请勿用旧版本 Node 启动新增服务。

本次验证使用模拟 Jira，覆盖官方 MCP 客户端与实际页面完整路径；真实项目的字段、工作流策略和账号权限需要使用者配置后验证。未对真实 Jira 创建测试数据。
