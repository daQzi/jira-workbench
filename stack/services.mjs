// 本地前端服务编排：按端口拉起/停止各前端 dev server，维护状态机与日志环形缓冲。
// 只管理自己拉起的子进程；端口被别的程序占用时标记为 external，不去杀。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { resolveServiceDir } from './config.mjs';
import { cleanLine } from './logger.mjs';

const IS_WIN = process.platform === 'win32';
const LOG_LIMIT = 600;
const KILL_GRACE_MS = 4000;

/** 不带引号的 argv → 命令行（Windows 走 cmd /c） */
function quoteWin(s) {
  return /[\s"^&|<>]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

export function checkPort(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: Number(port), host });
    let done = false;
    const finish = (inUse) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function pkgHasScript(dir, script) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return typeof pkg?.scripts?.[script] === 'string';
  } catch {
    return false;
  }
}

/** 找 npm 可执行文件：PATH 优先，其次是 node 同目录 */
export function findNpm() {
  const exe = IS_WIN ? 'npm.cmd' : 'npm';
  const dirs = [...(process.env.PATH || '').split(path.delimiter), path.dirname(process.execPath)];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, exe);
    if (existsSync(p)) return p;
  }
  return null;
}

/** 没有 npm 时，直接用项目自身 node_modules/.bin 跑脚本命令 */
function scriptCommand(dir, script) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const cmd = pkg?.scripts?.[script];
    return typeof cmd === 'string' && cmd.trim() ? cmd : null;
  } catch {
    return null;
  }
}

export class ServiceManager extends EventEmitter {
  constructor({ config, onLog } = {}) {
    super();
    this.config = config;
    this.entries = new Map();
    this.onLog = onLog;
    this.stoppingAll = false;
  }

  setConfig(config) {
    this.config = config;
    this.sync();
  }

  /** 配置变更后对齐运行时条目：新增/删除/端口变化 */
  sync() {
    const wanted = new Set(this.config.services.map((s) => s.id));
    for (const [id, entry] of this.entries) {
      if (!wanted.has(id)) this.stop(id, { force: true });
    }
    for (const svc of this.config.services) {
      const cur = this.entries.get(svc.id);
      if (!cur) {
        this.entries.set(svc.id, {
          id: svc.id,
          state: 'stopped',
          child: null,
          pid: null,
          startedAt: null,
          readyAt: null,
          exitCode: null,
          error: '',
          logs: [],
          external: false,
          generation: 0,
          readyTimer: null,
        });
      } else if (cur.child && cur.port !== svc.port) {
        // 端口改了但进程还在跑：先停，避免占着老端口
        this.stop(svc.id, { force: true });
      }
      const entry = this.entries.get(svc.id);
      entry.port = svc.port;
    }
  }

  service(id) {
    return this.config.services.find((s) => s.id === id) || null;
  }

  entry(id) {
    if (!this.entries.has(id)) this.sync();
    return this.entries.get(id) || null;
  }

  log(id, line) {
    const e = this.entry(id);
    if (!e) return;
    for (const one of cleanLine(line)) {
      // webpack 的进度行会刷屏：同一服务只保留最新一条
      const isProgress = /^\[\d+%\]\s*(building|sealing)/.test(one);
      if (isProgress && /^\[\d+%\]\s*(building|sealing)/.test(e.logs[e.logs.length - 1] || '')) {
        e.logs[e.logs.length - 1] = one;
        this.emit('log', { id, line: one, replace: true });
        this.onLog?.(id, one);
        continue;
      }
      e.logs.push(one);
      if (e.logs.length > LOG_LIMIT) e.logs.splice(0, e.logs.length - LOG_LIMIT);
      this.emit('log', { id, line: one });
      this.onLog?.(id, one);
    }
  }

  setState(id, state, patch = {}) {
    const e = this.entry(id);
    if (!e) return;
    e.state = state;
    Object.assign(e, patch);
    this.emit('state', { id, state, ...patch });
    this.emit('change');
  }

  async start(id, { byUser = false } = {}) {
    const svc = this.service(id);
    const e = this.entry(id);
    if (!svc || !e) throw Object.assign(new Error('服务不存在'), { status: 404 });
    if (e.state === 'running' || e.state === 'starting') return this.snapshot(id);
    if (e.state === 'stopping') throw Object.assign(new Error('服务正在停止，请稍后重试'), { status: 409 });

    const dir = resolveServiceDir(svc, this.config.servicesRoot);
    if (!existsSync(path.join(dir, 'package.json'))) {
      this.setState(id, 'error', { error: `目录或 package.json 不存在：${dir}`, external: false });
      throw Object.assign(new Error(`目录或 package.json 不存在：${dir}`), { status: 400 });
    }
    if (!existsSync(path.join(dir, 'node_modules'))) {
      this.log(id, `[wb-stack] 警告：${dir} 下没有 node_modules，dev server 可能启动失败`);
    }

    if (await checkPort(svc.port, '127.0.0.1')) {
      this.setState(id, 'external', { external: true, error: `端口 ${svc.port} 已被其他程序占用`, pid: null, child: null });
      this.log(id, `[wb-stack] 端口 ${svc.port} 已被占用，跳过启动；如确需由工作台管理，请先释放该端口`);
      return this.snapshot(id);
    }

    const generation = ++e.generation;
    e.logs = [];
    e.external = false;
    e.exitCode = null;
    e.error = '';
    e.startedAt = Date.now();
    e.readyAt = null;
    this.setState(id, 'starting');
    this.log(id, `[wb-stack] 启动 ${svc.name}（端口 ${svc.port}）${byUser ? '' : ' · 自动'}`);
    this.log(id, `[wb-stack] cwd: ${dir}`);
    this.log(id, `[wb-stack] 执行 ${svc.script} -- ${svc.args.map((a) => a.replace('{port}', svc.port)).join(' ')}`);

    const args = svc.args.map((a) => a.replace('{port}', svc.port));
    const binDir = path.join(dir, 'node_modules', '.bin');
    const env = {
      ...process.env,
      PORT: String(svc.port),
      BROWSER: 'none',
      ...(existsSync(binDir) ? { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` } : {}),
      ...svc.env,
    };
    const npm = findNpm();
    const scriptCmd = npm ? null : scriptCommand(dir, svc.script);
    if (!npm && !scriptCmd) {
      const msg = `找不到 npm，且 package.json 里没有脚本 ${svc.script}`;
      this.setState(id, 'error', { error: msg });
      throw Object.assign(new Error(msg), { status: 400 });
    }
    let child;
    try {
      const cmdline = scriptCmd ? `${scriptCmd} ${args.map(quoteWin).join(' ')}` : null;
      const nodeDir = path.dirname(process.execPath);
      // 内置 runtime 只有 node.exe 没有 npm：把 node 目录放到 PATH 前面，脚本里的 node 才能找到
      env.PATH = `${nodeDir}${path.delimiter}${env.PATH || ''}`;
      if (IS_WIN) {
        const full = cmdline ?? `${npm} run ${svc.script} -- ${args.map(quoteWin).join(' ')}`;
        child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', full], {
          cwd: dir,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } else {
        child = cmdline
          ? spawn('/bin/sh', ['-c', cmdline], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
          : spawn(npm, ['run', svc.script, '--', ...args], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      }
    } catch (err) {
      this.setState(id, 'error', { error: `启动失败：${err.message}` });
      throw err;
    }

    e.child = child;
    e.pid = child.pid ?? null;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => this.log(id, d));
    child.stderr?.on('data', (d) => this.log(id, d));
    child.once('error', (err) => {
      if (e.generation !== generation) return;
      this.setState(id, 'error', { error: `进程错误：${err.message}`, child: null, pid: null });
      this.log(id, `[wb-stack] 进程错误：${err.message}`);
    });
    child.once('exit', (code, signal) => {
      if (e.generation !== generation) return;
      clearTimeout(e.readyTimer);
      e.child = null;
      e.pid = null;
      e.exitCode = code;
      const stoppedByUs = e.state === 'stopping' || this.stoppingAll;
      this.setState(id, stoppedByUs ? 'stopped' : code === 0 ? 'stopped' : 'error', {
        error: stoppedByUs || code === 0 ? '' : `进程退出（${signal || code}）`,
      });
      this.log(id, `[wb-stack] ${svc.name} 已退出（${signal || code}）`);
    });

    this.waitReady(svc, generation).catch(() => {});
    return this.snapshot(id);
  }

  /** 轮询端口，直到 dev server 监听或超时 */
  async waitReady(svc, generation) {
    const e = this.entry(svc.id);
    const deadline = Date.now() + (svc.startTimeoutMs || 240000);
    const started = Date.now();
    clearTimeout(e.readyTimer);
    while (Date.now() < deadline) {
      if (e.generation !== generation || e.state !== 'starting') return;
      if (await checkPort(svc.port, '127.0.0.1')) {
        if (e.generation !== generation || e.state !== 'starting') return;
        this.setState(svc.id, 'running', { readyAt: Date.now(), error: '' });
        this.log(svc.id, `[wb-stack] ${svc.name} 就绪 http://127.0.0.1:${svc.port}（${((Date.now() - started) / 1000).toFixed(1)}s）`);
        return;
      }
      await new Promise((r) => {
        e.readyTimer = setTimeout(r, 500);
      });
    }
    if (e.generation === generation && e.state === 'starting') {
      this.setState(svc.id, 'error', { error: `启动超时（${Math.round((svc.startTimeoutMs || 240000) / 1000)}s）内端口 ${svc.port} 未就绪` });
    }
  }

  async stop(id, { force = false } = {}) {
    const svc = this.service(id);
    const e = this.entry(id);
    if (!svc || !e) return this.snapshot(id);
    clearTimeout(e.readyTimer);
    if (e.state === 'external') {
      this.setState(id, 'stopped', { external: false, error: '' });
      return this.snapshot(id);
    }
    if (!e.child || !e.pid) {
      if (e.state !== 'stopped') this.setState(id, 'stopped', { error: '' });
      return this.snapshot(id);
    }
    this.setState(id, 'stopping');
    this.log(id, `[wb-stack] 停止 ${svc.name}（pid ${e.pid}）`);
    const pid = e.pid;
    const child = e.child;
    e.generation++;
    if (IS_WIN) {
      spawnSync('taskkill', ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])], { stdio: 'ignore', windowsHide: true });
      if (!force) {
        await new Promise((r) => setTimeout(r, KILL_GRACE_MS));
        if (child.exitCode === null && child.signalCode === null) {
          spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        }
      }
    } else {
      try {
        process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        try {
          process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
        } catch {
          /* 已退出 */
        }
      }
    }
    // 等待端口释放，最多 10s
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (!(await checkPort(svc.port, '127.0.0.1'))) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    e.child = null;
    e.pid = null;
    this.setState(id, 'stopped', { error: '' });
    return this.snapshot(id);
  }

  async restart(id) {
    await this.stop(id, { force: true });
    return this.start(id, { byUser: true });
  }

  async startAutoServices() {
    const list = this.config.services.filter((s) => s.enabled && s.autoStart);
    for (const s of list) {
      try {
        await this.start(s.id);
      } catch (e) {
        this.log(s.id, `[wb-stack] 自动启动失败：${e.message}`);
      }
    }
    return list.map((s) => s.id);
  }

  async stopAll() {
    this.stoppingAll = true;
    const ids = [...this.entries.keys()];
    await Promise.all(ids.map((id) => this.stop(id, { force: true }).catch(() => {})));
    this.stoppingAll = false;
  }

  /** 进程树里是否还有我们拉起的进程（用于兜底清理） */
  aliveIds() {
    return [...this.entries.values()].filter((e) => e.child && e.pid).map((e) => e.id);
  }

  snapshot(id) {
    const svc = this.service(id);
    const e = this.entry(id);
    if (!svc || !e) return null;
    return {
      id: svc.id,
      name: svc.name,
      dir: svc.dir,
      absDir: resolveServiceDir(svc, this.config.servicesRoot),
      port: svc.port,
      route: svc.route,
      enabled: svc.enabled,
      autoStart: svc.autoStart,
      script: svc.script,
      args: svc.args,
      mode: svc.mode,
      env: svc.env,
      state: e.state,
      pid: e.pid,
      startedAt: e.startedAt,
      readyAt: e.readyAt,
      exitCode: e.exitCode,
      error: e.error,
      external: e.external,
      url: `http://127.0.0.1:${svc.port}`,
    };
  }

  snapshotAll() {
    return this.config.services.map((s) => this.snapshot(s.id)).filter(Boolean);
  }

  logs(id, limit = 200) {
    const e = this.entry(id);
    return e ? e.logs.slice(-limit) : [];
  }
}

export { pkgHasScript };
