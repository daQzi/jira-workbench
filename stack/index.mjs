// 联调栈入口：配置 + 服务编排 + 反向代理，对上层暴露 start/stop/status 与 /api/stack/* 处理器。
// 工作台（server/index.mjs）在启动时挂载；也可 `node stack/server.mjs` 独立运行。
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { defaultConfigPath, loadConfig, normalizeConfig, saveConfig } from './config.mjs';
import { ServiceManager, checkPort } from './services.mjs';
import { StackProxy, lanAddress } from './proxy.mjs';

const MAX_BODY = 512 * 1024;

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const json = (res, status, body) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
};
const fail = (res, status, message) => json(res, status, { error: message });

export class StackManager {
  constructor({ configPath, onLog } = {}) {
    this.configPath = configPath || defaultConfigPath();
    this.onLog = onLog;
    const loaded = loadConfig(this.configPath);
    this.config = loaded.config;
    this.configCreated = loaded.created;
    // listeners/logs 必须先于 ServiceManager：其构造时可能立刻产生日志回调
    this.logs = [];
    this.listeners = new Set();
    this.services = new ServiceManager({ config: this.config, onLog: (id, line) => this.log(id, line) });
    this.services.sync();
    this.proxy = new StackProxy({
      getConfig: () => this.config,
      getService: (id) => this.services.snapshot(id),
      onLog: (line) => this.log('proxy', line),
    });
    // 首次运行落盘默认配置（此时依赖已就绪）
    if (loaded.created) {
      try {
        this.config = saveConfig(this.config, this.configPath);
      } catch (e) {
        this.log('proxy', `[config] 初始配置写入失败：${e.message}`);
      }
    }
  }

  log(id, line) {
    const row = { at: Date.now(), id, line: String(line) };
    this.logs.push(row);
    if (this.logs.length > 600) this.logs.splice(0, this.logs.length - 600);
    for (const fn of this.listeners) {
      try {
        fn(row);
      } catch {
        /* 订阅方异常不影响主流程 */
      }
    }
    this.onLog?.(id, row.line);
  }

  persist() {
    try {
      this.config = saveConfig(this.config, this.configPath);
      this.services.setConfig(this.config);
      return true;
    } catch (e) {
      this.log('proxy', `[config] 保存失败：${e.message}`);
      throw e;
    }
  }

  async start({ autoStart = true } = {}) {
    const cfg = this.config;
    if (cfg.proxy.autoStartOnLaunch && autoStart) {
      try {
        await this.proxy.start();
      } catch (e) {
        this.log('proxy', `[proxy] 代理启动失败：${e.message}`);
      }
      if (cfg.proxy.autoStartServices) {
        const ids = await this.services.startAutoServices();
        if (ids.length) this.log('proxy', `[proxy] 已自动拉起：${ids.join(', ')}`);
      }
    }
    return this.status();
  }

  async stop() {
    await this.services.stopAll();
    await this.proxy.stop().catch(() => {});
  }

  status() {
    const cfg = this.config;
    const env = cfg.envs.find((e) => e.id === cfg.currentEnv) || null;
    return {
      configPath: this.configPath,
      savedAt: Date.now(),
      proxy: this.proxy.status(),
      env,
      envs: cfg.envs,
      services: this.services.snapshotAll(),
      servicesRoot: cfg.servicesRoot,
      settings: cfg.proxy,
      localDebug: cfg.localDebug,
      localApis: cfg.localApis,
      mocks: cfg.mocks,
      staticFiles: cfg.staticFiles,
      lanAddress: lanAddress(),
      logs: this.logs.slice(-200),
    };
  }

  /** 直接可用性探测：端口、目录、package.json */
  async inspectService(input) {
    const dir = path.isAbsolute(input.dir) ? input.dir : path.resolve(this.config.servicesRoot || '.', input.dir);
    const pkgFile = path.join(dir, 'package.json');
    let pkg = null;
    let pkgError = '';
    try {
      pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    } catch (e) {
      pkgError = e.code === 'ENOENT' ? 'package.json 不存在' : e.message;
    }
    const port = Number(input.port) || 0;
    return {
      dir,
      dirExists: existsSync(dir),
      hasPackage: !!pkg,
      pkgError,
      scripts: pkg?.scripts ? Object.keys(pkg.scripts) : [],
      hasNodeModules: existsSync(path.join(dir, 'node_modules')),
      port,
      portInUse: port ? await checkPort(port, '127.0.0.1') : false,
    };
  }

  // ---------- HTTP API ----------

  async handle(req, res, url) {
    const sub = url.pathname.replace(/^\/api\/stack\/?/, '');
    const method = req.method || 'GET';
    try {
      if (sub === '' || sub === 'status') {
        if (method !== 'GET') return fail(res, 405, '方法不允许');
        return json(res, 200, this.status());
      }
      if (sub === 'events') return this.streamEvents(req, res);
      // 新增服务前检查目录/端口；dir 为相对路径时按服务根目录解析
      if (sub === 'inspect' && method === 'GET') {
        return json(
          res,
          200,
          await this.inspectService({
            dir: url.searchParams.get('dir') || '',
            port: url.searchParams.get('port') || '',
          }),
        );
      }
      if (sub === 'env' && method === 'PUT') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const id = String(body.id || '');
        if (!this.config.envs.some((e) => e.id === id)) return fail(res, 404, '环境不存在');
        this.config.currentEnv = id;
        this.persist();
        this.log('proxy', `[env] 切换到 ${id} → ${this.config.envs.find((e) => e.id === id)?.target}`);
        return json(res, 200, this.status());
      }
      if (sub === 'envs') return await this.handleEnvs(req, res, method);
      if (sub === 'proxy/start' && method === 'POST') {
        await this.proxy.start();
        return json(res, 200, this.status());
      }
      if (sub === 'proxy/stop' && method === 'POST') {
        await this.proxy.stop();
        return json(res, 200, this.status());
      }
      if (sub === 'proxy/restart' && method === 'POST') {
        await this.proxy.stop();
        await this.proxy.start();
        return json(res, 200, this.status());
      }
      if (sub === 'settings' && method === 'PUT') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const before = { ...this.config.proxy };
        const next = normalizeConfig({ ...this.config, proxy: { ...this.config.proxy, ...body.proxy }, servicesRoot: body.servicesRoot ?? this.config.servicesRoot });
        this.config = next;
        this.persist();
        const portChanged = before.port !== next.proxy.port || before.host !== next.proxy.host;
        if (portChanged && this.proxy.server) {
          await this.proxy.stop();
          await this.proxy.start().catch((e) => this.log('proxy', `[proxy] 重启失败：${e.message}`));
        }
        return json(res, 200, this.status());
      }
      if (sub === 'services' && method === 'POST') return await this.addService(req, res);
    if (sub.startsWith('services/')) {
      const rest = sub.slice('services/'.length);
      if (rest.endsWith('/inspect') && method === 'GET') {
        const id = rest.slice(0, -'/inspect'.length);
        const svc = this.config.services.find((s) => s.id === id);
        if (!svc) return fail(res, 404, '服务不存在');
        return json(res, 200, await this.inspectService(svc));
      }
      return await this.handleService(req, res, rest, method);
    }
      if (sub === 'local-api' && method === 'PUT') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        this.config = normalizeConfig({ ...this.config, localApis: body.localApis ?? [], mocks: body.mocks ?? this.config.mocks, staticFiles: body.staticFiles ?? this.config.staticFiles, localDebug: body.localDebug ?? this.config.localDebug });
        this.persist();
        return json(res, 200, this.status());
      }
      if (sub === 'logs' && method === 'DELETE') {
        this.logs.length = 0;
        this.proxy.log.clear();
        return json(res, 200, { ok: true });
      }
      return fail(res, 404, '未知接口');
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) this.log('proxy', `[api] ${method} ${url.pathname} · ${e.message}`);
      return fail(res, status, e.message);
    }
  }

  async handleEnvs(req, res, method) {
    if (method === 'PUT') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      this.config = normalizeConfig({ ...this.config, envs: body.envs ?? this.config.envs, currentEnv: body.currentEnv ?? this.config.currentEnv });
      this.persist();
      this.log('proxy', '[env] 环境配置已更新');
      return json(res, 200, this.status());
    }
    return fail(res, 405, '方法不允许');
  }

  async addService(req, res) {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!String(body.dir || '').trim()) return fail(res, 400, '请填写服务目录');
    if (!Number(body.port)) return fail(res, 400, '请填写端口');
    // 用归一化逻辑校验单条，同时补齐默认字段
    const one = normalizeConfig({ ...this.config, services: [{ ...body, id: body.id || `svc-${Date.now().toString(36)}` }] }).services[0];
    if (!one) return fail(res, 400, '服务配置不合法（目录 / 端口 / 目标地址）');
    const added = one;
    if (this.config.services.some((s) => s.id === added.id)) return fail(res, 409, `服务 id 重复：${added.id}`);
    if (this.config.services.some((s) => s.port === added.port)) return fail(res, 409, `端口 ${added.port} 已被其他服务使用`);
    this.config = { ...this.config, services: [...this.config.services, added] };
    this.persist();
    this.log('proxy', `[services] 新增 ${added.name}（${added.dir}:${added.port}）`);
    return json(res, 200, this.status());
  }

  async handleService(req, res, rest, method) {
    const [id, action] = rest.split('/');
    const svc = this.config.services.find((s) => s.id === id);
    if (!svc) return fail(res, 404, '服务不存在');

    if (!action && method === 'DELETE') {
      await this.services.stop(id, { force: true });
      this.config = { ...this.config, services: this.config.services.filter((s) => s.id !== id) };
      this.persist();
      this.log('proxy', `[services] 删除 ${svc.name}`);
      return json(res, 200, this.status());
    }
    if (!action && method === 'PUT') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const merged = { ...svc, ...body, id };
      if (body.port !== undefined && Number(body.port) !== svc.port) {
        if (this.config.services.some((s) => s.id !== id && s.port === Number(body.port))) return fail(res, 409, `端口 ${body.port} 已被其他服务使用`);
        await this.services.stop(id, { force: true });
      }
      this.config = normalizeConfig({ ...this.config, services: this.config.services.map((s) => (s.id === id ? merged : s)) });
      this.persist();
      return json(res, 200, this.status());
    }
    if (action === 'start' && method === 'POST') {
      await this.startService(id);
      return json(res, 200, this.status());
    }
    if (action === 'stop' && method === 'POST') {
      await this.services.stop(id);
      return json(res, 200, this.status());
    }
    if (action === 'restart' && method === 'POST') {
      await this.services.restart(id);
      return json(res, 200, this.status());
    }
    if (action === 'logs' && method === 'GET') return json(res, 200, { logs: this.services.logs(id, 300) });
    if (action === 'logs' && method === 'DELETE') {
      const e = this.services.entry(id);
      if (e) e.logs = [];
      return json(res, 200, { logs: [] });
    }
    if (action === 'inspect' && method === 'GET') {
      return json(res, 200, await this.inspectService(svc));
    }
    return fail(res, 405, '方法不允许');
  }

  async startService(id) {
    // 立刻返回 starting 状态，让界面先画「启动中」动画；就绪由 SSE 推送
    return this.services.start(id, { byUser: true });
  }

  /** SSE：状态与日志实时推送 */
  streamEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: status\ndata: ${JSON.stringify(this.status())}\n\n`);
    const push = (row) => res.write(`event: log\ndata: ${JSON.stringify(row)}\n\n`);
    const onChange = () => res.write(`event: status\ndata: ${JSON.stringify(this.status())}\n\n`);
    this.listeners.add(push);
    this.services.on('change', onChange);
    this.services.on('log', ({ id, line }) => {
      /* 服务日志同时走 listeners，这里不重复推 */
      void id;
      void line;
    });
    const timer = setInterval(() => res.write(': ping\n\n'), 15000);
    const close = () => {
      clearInterval(timer);
      this.listeners.delete(push);
      this.services.off('change', onChange);
      try {
        res.end();
      } catch {
        /* ignore */
      }
    };
    req.on('close', close);
    req.on('error', close);
  }
}

export function createStack(opts) {
  return new StackManager(opts);
}

export { defaultConfigPath, loadConfig, saveConfig, normalizeConfig, statSync };
