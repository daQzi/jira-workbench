# 联调栈（stack/）

把 `1start-yitihua/proxy-common.js` 那套「一体化环境代理 + 本地前端启动」改造成可配置、可视化的独立子项目。
纯 Node 内置模块实现（无依赖、无需 `npm install`），既可以被工作台托管，也能单独运行。

## 目录

| 文件 | 职责 |
|---|---|
| `config.mjs` | 配置结构、默认环境/服务、读写与归一化 |
| `services.mjs` | 前端 dev server 编排：启动 / 停止 / 状态机 / 日志 |
| `proxy.mjs` | 反向代理与规则匹配（Mock / 本地接口 / 静态文件 / 服务路由） |
| `index.mjs` | 组合入口 + `/api/stack/*` HTTP 接口 + SSE |
| `server.mjs` | 独立运行入口（自带 UI 静态服务） |
| `ui/` | 控制台页面（原生 HTML/CSS/JS，无构建） |
| `stack.test.mjs` | `node --test` 单测（配置 / 匹配 / 转发） |

## 独立运行

```bash
node stack/server.mjs          # 控制台 http://127.0.0.1:18888
```

- 配置：`~/.wb-stack/config.json`（可用 `WB_STACK_CONFIG` 指到别处）
- 控制台端口：`WB_STACK_UI_PORT`（默认 18888）
- 代理端口：配置里的 `proxy.port`（默认 30000）

## 作为工作台模块

工作台 `server/index.mjs` 启动时会 `createStack()`，并把 `/api/stack/*` 与 `/stack/` 挂在自己的端口上；
`stopServer()` 会先停前端子进程再关服务端，所以「关窗口 = 全部停掉」。

## 配置要点

```jsonc
{
  "proxy": { "host": "0.0.0.0", "port": 30000,
             "autoStartOnLaunch": true,   // 工作台启动时起代理
             "autoStartServices": true }, // 起了代理再拉起 autoStart 的服务
  "currentEnv": "52",
  "envs": [{ "id": "52", "label": "52", "target": "http://172.18.163.52:30000",
             "apiPrefix": "/saas-industry", "loginPath": "zhfw", "account": "..." }],
  "servicesRoot": "D:\\project\\bosssoft-medicine",
  "services": [{
    "id": "certificate", "name": "证书管理",
    "dir": "bosssoft-certificate-management-ui",  // 相对 servicesRoot，也可写绝对路径
    "port": 8888, "route": "/certificate",        // route = 静态资源走本地的前缀
    "script": "serve", "args": ["--port", "{port}"],
    "mode": "auto",                                // auto | local | remote
    "autoStart": true, "enabled": true
  }],
  "localApis": [{ "prefix": "/saas-industry/xxx", "target": "http://127.0.0.1:8080" }],
  "mocks": [{ "path": "/saas-industry/tax/user", "body": { "ok": 1 } }],
  "staticFiles": [{ "path": "/saas-industry/static/x.js", "file": "D:\\x.js" }]
}
```

### 路由优先级（与 `proxy-common.js` 一致）

1. `mocks` 精确路径 → 直接返回 JSON
2. `localApis` 最长前缀 → 本地后端（转发前去掉环境 `apiPrefix`）
3. `staticFiles` 精确路径 → 本地文件
4. `/static/external/*`：静态资源 → 运营环境，其余 → 当前环境
5. webpack chunk / `/static/*` → 运行中的本地服务
6. 各服务 `route`：静态资源 → 本地（未运行则回落环境，避免白屏），接口 → 环境
7. 其余 → 环境（保留 `apiPrefix`，因为站点本身挂在该前缀下）

WebSocket / HMR 走 `upgrade`：本地服务在跑就转本地，否则转环境。

## 状态机

`stopped → starting → running → stopping → stopped`，异常为 `error`；
端口被别的程序占用时为 `external`（只标记，不会去杀别人的进程）。

## 测试

```bash
node --test stack/stack.test.mjs
```
