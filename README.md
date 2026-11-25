# Jira 研发工作台

TAPD 风格的 Jira 6.0.5 前端。React + Vite 前端，本地 Node 代理持有 Jira 会话（Jira 未开放 CORS）。

## 运行

```bash
npm ci
npm run dev          # 代理 127.0.0.1:8787 + 前端 http://127.0.0.1:5173
# 或
npm run build && npm start   # 单进程 http://127.0.0.1:8787
```

使用 Node.js 26.8.2（见 `.node-version`）。首次启动先在登录页「连接设置」填写自己的 Jira 地址；也可复制 `.env.example` 为 `.env`。

环境变量：`JIRA_BASE_URL`（默认空）、`WB_PORT`、`WB_ALLOW_WRITE=1`（开启写操作，默认关闭）、`WB_WRITE_PROJECTS`（可写项目 key，逗号分隔；未设置时所有项目可写）、`WB_JIRA_CONCURRENCY`（Jira 总并发，默认2，可设1–4；HTTP 与 MCP 共用）。

```bash
npm run dev:write   # 写模式（http://127.0.0.1:5173），仅 AGENT 项目可写
npm run dev:all     # 写模式，按 Jira 权限所有项目可写（会写真实项目数据）
```

写操作只放行：新建问题、编辑字段、改经办人、流转、评论、建/移除链接、上传附件（见 `server/policy.mjs`）；移除链接前代理先查出链接两端再按项目范围校验；不提供删除问题和附件。

## 连接设置

登录页底部「连接设置」可改 Jira 地址、大模型请求地址、大模型 Key、模型 ID，保存后立即生效（见 `server/settings.mjs`）。

- Jira 地址、大模型网关、模型 ID 和 API Key 默认均为空；首次启动自动展开连接设置。只填 Jira 即可使用，大模型未配置时日报使用规则解析。
- 大模型为可选项；配置时请求地址和模型 ID 必须同时填写。已有的本机配置仍会保留。
- 保存位置：桌面版写回 `config.json`，命令行写 `.wb-data/settings.json`（优先于 `.env`），文件权限 0600。
- Key 不下发给页面，只显示末 4 位；留空表示不修改。修改 Jira 地址会清空所有登录。
- 接口只接受本机同源请求（校验 Host 和 Origin），防止其他网页把 Jira 地址改到外部截获密码。

## 记住帐号密码

登录页勾选「记住帐号密码」后，会同时保存账号和密码，登录成功后生效，有效期 90 天。下次会恢复账号，密码留空即可直接登录，也可输入新密码更新。切换账号需要重新输入密码。

- 保存项绑定当前浏览器和 Jira 地址，普通退出登录后保留；「清除保存」立即移除当前浏览器保存的账号和密码。取消勾选则在下次成功登录后更新保存项。
- 密码由本机代理使用 AES-256-GCM 加密保存，不返回给页面，也不写入 localStorage；浏览器只保留 HttpOnly 设备令牌。文件位于会话目录下的 `remembered-login/`，包含 `login.key` 和 `logins.json`，文件权限 0600。密钥与密文同机保存，不等同于系统钥匙串，不能防御可读取本用户目录的程序。
- `WB_SESSION_DIR=off` 关闭登录持久化时，「记住帐号密码」也不可用，仍可正常输入账号密码登录。更换 Jira 地址后不会向新地址发送旧地址保存的密码。

## 从日报新建任务

「我的工时」右上角「＋ 从日报新建」：粘贴每日汇总 → 解析预览（可改标题/项目/所属需求/工时/日期）→ 批量创建。

- 解析：配置了大模型时由模型识别任务与工时、超过单条上限（默认 8h）按内容拆分；模型不可用时自动退回规则解析（每行一项，行内 `6h`/`0.5d`/`半天`，`#ABC-12` 挂父需求，`[ABC]` 指定项目）。
- 校验：模型结果只作建议，子任务超上限或合计不等于总工时时退回按上限机械拆分；拆出的多条按工作日排（默认截止日报当天往前排）。
- 一线对接人（`customfield_11201`，单行文本，填客户方/现场联系人姓名）：大模型或规则（行内写「对接人：姓名」）识别后写入；留空时挂了需求的会继承需求的值。YLZHXT 的「编码任务」没有这个字段，只提示不写入。详情侧栏在该类型有此字段时显示并可点击修改。
- 写入：每条默认「其他任务」，经办人/开发人员=自己，开发预估时间=该条工时，开始/完成开发日期=该条日期，与工时统计口径一致；挂「需求」按子项 blocks，其余编号按 Relates。近 14 天自己建过的同名问题默认跳过。
- 大模型配置（OpenAI 兼容，Key 只在本地代理内使用）：命令行读项目根目录 `.env`（已 gitignore）的 `WB_LLM_BASE_URL`、`WB_LLM_MODEL`、`WB_LLM_API_KEY`，可选 `WB_LLM_TIMEOUT_MS`、`WB_LLM_MAX_HOURS`、`WB_LLM_PROMPT_EXTRA`；桌面版用 config.json 的 `llm` 对象（`baseUrl`、`model`、`apiKey`、`timeoutMs`、`maxHoursPerTask`、`promptExtra`）。见 `server/llm.mjs`、`src/lib/dailyImport.ts`。

## 常用操作

- 当前项目是全局维度：左上角切换，工作台、工时、需求树、看板都只查这个项目；地址形如 `#/AGENT/hours`，上次的项目会记住。下拉底部「全部项目」用于跨项目看工作台和工时。
- `⌘K / Ctrl+K`：全局跳转。输入完整编号精确查找并可直接打开，可跨项目；纯数字先查精确编号和标题，再按编号连续片段匹配最近更新的最多 1000 条，范围不足时明确提示。标题按连续片段模糊匹配，不依赖 Jira 中文分词，忽略英文字母大小写；空格分隔的多个片段需同时包含，只展示标题真正命中的结果。标题和至少 3 位数字的编号索引按账号、Jira 地址、项目隔离缓存 5 分钟，后台串行读取；编号索引直接复用已读取的问题，不再生成编号区间查询。全部项目下需先选择具体项目才能按纯数字查询编号。输入项目名可切换，空输入显示最近查看；新搜索等待期间不使用上次关键词的候选。
- 详情抽屉里标题、描述、优先级、人员、模块、开发预估时间/日期等点击即改（以 Jira editmeta 返回的可编辑字段为准）。
- 列表行悬停「复制」得到 `编号 标题`，⇧ 点击或抽屉里「复制链接」连 Jira 链接一起复制。
- 项目筛选条件按项目记在本机，「清空筛选」恢复默认；搜索关键字不记忆。
- 版本按 Jira「影响版本」（`versions` / JQL `affectedVersion`）处理，本 Jira 的修复版本基本为空。列表有版本列；筛选栏有全部版本下拉（未发布/已发布/已归档分组，含「未设置版本」）和最近要发布的 3 个版本快捷按钮；工作台支持把影响版本等筛选条件保存为任务清单卡片，项目仍在左上角统一切换。见 `src/lib/versions.ts`。
- 登录状态加密保存，重启后免登录（空闲 8 小时或 Jira 会话失效后仍需重新登录）。命令行模式存在项目下 `.wb-data/`（`WB_SESSION_DIR` 可改，`=off` 关闭），桌面版存在配置目录 `session/`；文件权限 0600，退出登录即删除会话，主动勾选的账号密码记忆另行保留。

## 工作管理与效率

- 「我的工作台」增加今日待办、逾期/临期、阻塞、待补工时、未关联需求、最近完成等视图，可命名保存。
- 「全部问题」和管理列表可选列、调宽/顺序、排序、多选批量编辑、流转、备注及挂父需求；执行前预览，逐条反馈；支持 CSV 导出和列表视图链接。
- 「我的工作台」卡片配置、顺序、宽高、隐藏与删除自动保存在本机；支持撤销删除、便签/个人待办卡片，以及布局与个人数据的 JSON 备份/导入。右下角工具箱提供便签、待办、时间戳、Base64、JSON 和文本对比，默认全部本地处理，不上传第三方。
- 「新建工作项」卡片提供需求、任务（编码任务）、其他任务三个入口，沿用左上角项目。卡片可拖拽、缩放、隐藏或删除，也可从卡片库重新添加；升级时仅补入一次，保留原有布局，满20张时不自动添加。
- 新建表单可勾选「这项工作已完成，创建后直接完成」（默认关闭，仅单条）。首次使用按项目和类型配置真实 Jira 流转路线；网页与 MCP 共用规则，网页无需启用 MCP。执行顺序为创建、补建关联、上传附件、按路线流转并读回核验。失败保留已建编号，可补填字段继续，刷新或重启后从新建表单找回；写入结果不确定时不重复提交。只流转当前工作项，历史开发完成日期仍按表单填写。规则按 Jira 地址隔离，操作记录按地址和用户隔离，保存在本机 SQLite。
- 「工时检查与汇总」生成日报/周报文本、CSV，并列出缺人员/工时/日期的问题；「我的工时」支持命名统计方案。
- 「A8 工时补全」（侧栏「个人」）对接 A8 协同工时系统：查询整月未填写工日 → 读取当月指派/开发人员是我的 Jira 任务 → 由当前配置的大模型按天生成工时描述，确认后可复制，也可直接推送为 A8 草稿。
- 界面支持轻动效/减少动画与可关闭 3D：登录页工作轨道、工具箱“工作星图”（可暂停、拖动旋转），按需懒加载 Three.js；系统减少动效或 WebGL 不可用时回退静态图。卡片标题使用跟手拖拽与平滑换位，支持键盘排序及 Esc 取消。见 [视觉动效说明](docs/design/workbench-motion.md)。
- 「看板」支持搜索勾选多位人员并统一应用，按版本等条件查看需求/任务/Bug 人员分布，切经办/开发/测试归属，点击图表查看明细；统计后台串行补齐，最多1000条，部分结果明确提示。相同范围60秒内复用快照，逐列加载，手动刷新可绕过缓存。见 [看板取数说明](docs/design/board-cache-and-loading.md)。
- 被省略的子项、关联问题、卡片和列表文字可悬停看全文，提示浮层可选择复制。
- 「版本进展」按影响版本展示完成度和交付风险；「通知中心」聚合临期、工时异常、事项变化和 MCP 失败，可标为已读。

数据范围、统计口径、批量处理规则及本地通知限制见 [工作管理使用说明](docs/work-management.md)。

## A8 工时补全

侧栏「个人 → A8 工时补全」。实现对照 auto-okr 的 A8 接入（`A8LoginUtils` / `A8Client.get_unfilled_workdays`），用 Node 原生能力重写，不引入 Python 依赖。

- 连接配置：A8 地址、账号、密码（或浏览器 `JSESSIONID` Cookie）。密码密文与 CryptoJS `DES.encrypt(明文, _SecuritySeed)` 完全一致（OpenSSL `Salted__` + 3DES-CBC，EVP_BytesToKey/MD5 派生密钥），由 `server/a8.mjs` 的 `encryptA8Password` 生成，已与 CryptoJS 实测互解。
- 未填工日：调用 A8「工作日工时未填报查询」报表（`rest/cap4/report/.../query/...`），返回区间内未填日期；登录态失效会自动重新登录一次，查询失败直接报错，不会伪装成「没有缺失」。
- 草稿生成：读取当月 `assignee` 或开发人员（`cf[10204]`）是我的 Jira 任务，交当前配置的大模型按天生成 `{日期, 工时, 描述, 关联编号}`；每 5 天一批调用，避免 60s 超时；编号必须来自 Jira 真实结果，描述中的「关联任务：编号」会被移除，编号单独列示。
- 校验与复制：工时需为 0.5 的整数倍且不超过 12h，描述为空或过短会标红；全部通过才能「复制全部」，得到可直接粘进 A8 的纯文本。
- 推送 A8 草稿（`server/a8-draft.mjs`）：先读取「协同模板」列表，选中模板会探测出它对应的项目/任务与 A8 提示（项目结项工时余额、填报期冻结等），确认后按天写入子表并保存为草稿。链路为 `newColl → createOrEdit → addOrDelDataSubBean → getFormRelationDatas/dealSelectedRelationData → saveOrUpdate → collaboration.do?method=saveDraft`，以返回的 `endSaveDraft(...)` 判定成功。
  - 只存草稿，**不发送审批**；推送后到 A8「待发事项」里核对再发送。同一日期只允许一条，避免 A8 出现重复行。
  - 任务归属沿用所选模板首行的项目/任务（A8 的任务选择器需要完整前端上下文，无法在脚本里稳定复现），任务类型也随模板；换项目/任务就换模板。
  - 写接口 `POST /api/a8/push` 需要登录本工作台，且只接受本机同源请求。
- 配置保存：`a8.json` + `a8.json.key`（AES-256-GCM），与 `config.json` 同目录；页面与接口只返回「已配置 / 末位掩码」，不下发密码和 Cookie。仅接受本机同源请求。

## 内置 MCP 服务

侧栏「设置 → MCP 服务」管理启用/停用、Agent 授权、自动完成路线和执行记录。默认停用，仅本机可连。Agent 使用独立 Token 调用查询、新建、更新、流转、备注、附件及「每日工时创建并完成」；权限同时受授权项目、工作台写入范围和 Jira 权限限制。

启用后在页面创建授权并复制一次性连接配置；自动完成前先按项目+类型配置真实流转路线。每日工作入口 `jira_submit_daily`，失败后 `jira_resume_operation` 复用已创建任务续跑。详见 [本地 MCP 使用说明](docs/local-mcp.md)。本机 SQLite 保存设置、授权摘要和操作步骤；桌面包内置 SDK 和 stdio 桥接器，随工作台启停。

## 轻量桌面版与 GitHub 自动打包

沿用现有轻量方案，内置 Node 运行时 + 本地代理 + 编译后的前端，不打包 Electron 或 Chromium。打包脚本只复制 `dist/`、`server/*.mjs`（排除测试）、打包后的 MCP 服务/桥接器和最小 package.json，不包含 `.env`、会话、个人配置或 node_modules；内置 Node 随包保留许可文件。

| 平台 | 产物 | 窗口与依赖 |
| --- | --- | --- |
| macOS Apple 芯片 | `jira-workbench-<版本>-mac-arm64.zip` | 解压 `.app`，Swift + 系统 WKWebView |
| macOS Intel | `jira-workbench-<版本>-mac-x64.zip` | 解压 `.app`，Swift + 系统 WKWebView |
| Windows x64 | `jira-workbench-<版本>-win-x64.zip` | 解压后双击 `Jira工作台.vbs`，系统 Edge/Chrome 应用窗口 |
| Windows ARM64 | `jira-workbench-<版本>-win-arm64.zip` | 同上，内置 ARM64 Node；需 ARM64 Windows 实机验证 |

```bash
npm run desktop                       # 默认构建当前平台和架构
npm run desktop -- mac-arm64           # Apple 芯片 Mac + Xcode Command Line Tools
npm run desktop -- mac-x64             # 推荐 Intel Mac runner 构建
npm run desktop -- win-x64 win-arm64   # 可在 macOS 或 Windows 打包
node scripts/verify-desktop.mjs mac-arm64  # 发行目录与本地 API 冒烟
```

产物在 `release/`。Node 版本固定在 `.node-version`，下载官方运行时并按 SHASUMS256 校验；升级版本时需同步验证开发、CI 和打包。macOS 最低版本取 Swift 外壳要求（12）与该 Node 版本官方要求的较高值。Windows 需要 Windows 10/11 和 Edge/Chrome；没有浏览器时尝试打开系统默认浏览器。

macOS 当前为 ad-hoc 签名，未做 Apple 开发者签名和公证，下载后可能被 Gatekeeper 拦截，需要在系统设置「隐私与安全性」中允许打开。Windows 启动脚本未做发行签名，企业策略可能限制 VBS；可用 `调试启动.cmd` 查看日志和报错。这里交付的是免安装压缩包。

固定端口 18787。macOS 关闭窗口后退出代理，Windows 跟随独立浏览器进程退出；若使用默认浏览器兜底，代理保留运行以供页面访问。

本机配置、日志位置：

- macOS：`~/Library/Application Support/JiraWorkbench/`。
- Windows：`%APPDATA%\JiraWorkbench\`。
- 配置 `config.json`，日志 `run.log`，会话 `session/`。登录页修改设置立即生效。
- 桌面版沿用当前行为，默认开启写操作，仍受当前 Jira 账号权限限制；`allowWrite: false` 可改为只读，`writeProjects: []` 表示所有项目，指定项目 key 可缩小范围。

GitHub 工作流：

1. `CI`：推送 main 或提交 PR 时运行 `npm ci`、测试、前端构建。
2. `Desktop packages`：在 Actions 页面选择 **Run workflow**，自动生成上述四个压缩包，下载位置为该次运行的 Artifacts（保留 14 天）。macOS 和 Windows 分别在对应系统 runner 构建，并验证包内本地 API；ARM64 Windows 运行时仍需实机验证。
3. 发布版本：先更新 package.json 和 package-lock.json 的版本，提交后推送匹配标签，例如 `git tag v0.1.0 && git push origin v0.1.0`。四个平台构建全部通过后，自动创建 GitHub Release，上传 ZIP 和 `SHA256SUMS.txt`。仓库为私有时，Release 下载也需要仓库权限。

工作流通过 GitHub 自动提供的 `GITHUB_TOKEN` 发布，无需配置个人 Token、Jira 密码或大模型 Key。更新地址、Key 只在用户本机填写。

## 验证

```bash
npm test && npm run typecheck
JIRA_USER=xxx JIRA_PASS=xxx npm run smoke   # 需先启动代理，只读
JIRA_USER=xxx JIRA_PASS=xxx npm run smoke:write   # 需先 dev:write，会在 AGENT 新建 [测试] 数据
JIRA_USER=xxx JIRA_PASS=xxx npm run smoke:v3      # 关联/附件/工时；REUSE=AGENT-10 可复用已有问题不再新建
```

注意：当前账号无 Jira 删除权限，smoke 产生的测试数据无法自动清理，需管理员处理或手动关闭（现有 AGENT-1 ~ AGENT-11）。

## 请求反馈与重复提交

- 接口读取超过 350ms 时显示顶部进度条和同步提示，保留页面骨架屏；短请求不闪屏。
- 写请求显示全局柔和遮罩，禁止点击、键盘操作和关闭提交中的弹窗；相同参数的进行中写请求只发送一次，结束后允许正常重试。

## 约定

- 父子关系：子项（编码任务/BUG/其他任务）`blocks` 需求，见 `src/lib/tree.ts`。Relates 等其他链接只作“关联问题”展示。
- 看板阶段：各工作流状态归并为 6 列，见 `src/lib/stages.ts`；Jira 新增状态需在此登记，未登记状态显示为红色。
- “我的”：经办人 / 开发人员（cf10204）/ 测试人员（cf10401）任一为当前用户。
- 代理只监听 127.0.0.1，按路径白名单转发 `/rest/api/2`，会话 8 小时空闲过期；默认加密持久化，关闭持久化时重启需重新登录。
- 新建即关联：Jira 6.0 创建时 `update.issuelinks` 只能带 1 条（多条 500），优先放父需求，其余创建后用 `issueLink` 补建，失败以 warning 返回，见 `src/lib/create.ts`。
- 附件：上传需 `X-Atlassian-Token: nocheck`，上限 100MB；下载经 `/api/file/(attachment|thumbnail)/<id>/<name>` 代理，仅图片内联，其余强制下载。
- 工时自定义条件：在「统计条件与面板」组合标题/编号、状态、优先级、模块、影响版本（含未设置版本）及补充 JQL，均与当前项目、人员、日期、类型条件取交集；新增条件按项目保存在本机，支持清空。模块和版本在具体项目下提供选项；补充 JQL 只填写条件，不含 ORDER BY。查询失败时显示错误，不展示旧统计结果。
- 我的工时：默认口径为“开发预估时间”按“开发完成日期”归属，没有该字段或未填写时按解决日期兜底（可在自定义面板切换），有子项的需求只累计子项，需求自身预估仅展示；默认排除通过 blocks 挂在父需求下的 Bug（未关联需求的 Bug 仍计入），可在「统计条件与面板 → Bug 工时」切回全部计入，分组和平铺均生效；最多统计 1000 条，见 `src/lib/hours.ts`。
- 新建表单字段：默认展示 Jira createmeta 里该项目+类型的全部字段（含级联选择、版本）；「⚙ 字段设置」可按项目+类型隐藏，存 localStorage `wb.createFields.v1`，必填和已填字段不会被隐藏。
