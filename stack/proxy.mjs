// 反向代理核心：把 proxy-common.js 的硬编码规则改写成运行时可切换的规则表。
// 匹配优先级（与原文件一致）：Mock > 本地接口映射 > 本地静态文件 > /static/external >
//   webpack chunk > /static > 各服务路由（静态转本地、接口转环境）> 兜底转环境
import http from 'node:http';
import https from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from './logger.mjs';

const STATIC_RE = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map)$/i;
const CHUNK_RE = /^\/(src_|vendors-|node_modules_|app\.|chunk\.).*\.(js|css|map)$/i;
const HMR_RE = /^\/(sockjs-node|ws\/|hot-update|__webpack_hmr|@vite|__vite)/i;
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

export const isStaticAsset = (p) => STATIC_RE.test(p || '');
export const isWebpackChunk = (p) => CHUNK_RE.test(p || '');

export function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a && a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

/** 最长前缀优先 */
export function matchPrefix(list, p) {
  let best = null;
  for (const item of list || []) {
    if (item?.enabled === false) continue;
    if (item?.prefix && p.startsWith(item.prefix) && (!best || item.prefix.length > best.prefix.length)) best = item;
  }
  return best;
}

/** 去掉开头的 prefix；没命中则原样返回 */
export function stripPrefix(p, prefix) {
  if (!prefix) return p;
  if (p === prefix) return '/';
  if (!p.startsWith(prefix + '/')) return p;
  return p.slice(prefix.length);
}

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

export class StackProxy {
  /**
   * @param {{getConfig: () => object, getService: (id: string) => object | null, onLog?: (line: string) => void}} opts
   */
  constructor({ getConfig, getService, onLog } = {}) {
    this.getConfig = getConfig;
    this.getService = getService;
    this.log = createLogger({ onLog, limit: 200 });
    this.server = null;
    this.host = '127.0.0.1';
    this.port = 30000;
    this.startedAt = null;
    this.requestCount = 0;
    this.lastRequests = [];
  }

  currentEnv(cfg = this.getConfig()) {
    return cfg.envs.find((e) => e.id === cfg.currentEnv) || cfg.envs[0] || null;
  }

  record(req, target, note = '') {
    this.requestCount++;
    this.lastRequests.push({ at: Date.now(), method: req.method, path: req.url || '/', target, note });
    if (this.lastRequests.length > 80) this.lastRequests.shift();
    this.log.push(`${req.method} ${req.url}${note ? ' · ' + note : ''} → ${target}`);
  }

  urls(cfg = this.getConfig(), env = this.currentEnv(cfg)) {
    if (!env || !this.server) return { local: '', lan: '' };
    const base = `${env.apiPrefix}/`;
    const hash = `#/${env.loginPath || 'login'}`;
    return {
      local: `http://127.0.0.1:${this.port}${base}${hash}`,
      lan: `http://${lanAddress()}:${this.port}${base}${hash}`,
    };
  }

  status() {
    const cfg = this.getConfig();
    const env = this.currentEnv(cfg);
    return {
      running: !!this.server,
      host: this.host,
      port: this.port,
      startedAt: this.startedAt,
      requestCount: this.requestCount,
      env,
      urls: this.urls(cfg, env),
      recent: this.lastRequests.slice(-30),
      logs: this.log.list(120),
    };
  }

  async start() {
    if (this.server) return this.status();
    const cfg = this.getConfig();
    this.host = cfg.proxy.host || '127.0.0.1';
    const wanted = Number(cfg.proxy.port);
    this.port = Number.isInteger(wanted) && wanted >= 0 ? wanted : 30000;
    this.server = http.createServer((req, res) => {
      Promise.resolve()
        .then(() => this.handle(req, res))
        .catch((e) => {
          this.log.push(`[error] ${req.method} ${req.url} · ${e.message}`);
          if (!res.headersSent) sendText(res, 502, `代理错误：${e.message}`);
          else res.end();
        });
    });
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.server.keepAliveTimeout = 65000;
    this.server.headersTimeout = 66000;
    await new Promise((resolve, reject) => {
      const onErr = (e) => reject(e);
      this.server.once('error', onErr);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', onErr);
        this.startedAt = Date.now();
        const env = this.currentEnv();
        this.log.push(`代理已启动 http://${this.host}:${this.port} → ${env?.target ?? '未选择环境'}`);
        resolve();
      });
    });
    return this.status();
  }

  async stop() {
    if (!this.server) return this.status();
    const s = this.server;
    this.server = null;
    this.startedAt = null;
    await new Promise((resolve) => {
      s.close(() => resolve());
      setTimeout(() => {
        try {
          s.closeAllConnections?.();
        } catch {
          /* ignore */
        }
        resolve();
      }, 2000).unref?.();
    });
    this.log.push('代理已停止');
    return this.status();
  }

  async handle(req, res) {
    const cfg = this.getConfig();
    const env = this.currentEnv(cfg);
    if (!env) return sendText(res, 503, '尚未选择代理环境');
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const raw = url.pathname;
    const prefix = env.apiPrefix || '';
    // 带前缀、不带前缀都认，换环境/HMR 刷新都不会 404
    const p = stripPrefix(raw, prefix);

    // 1) Mock 精确命中
    const mock = cfg.mocks.find((m) => m.enabled !== false && (m.path === raw || m.path === p));
    if (mock) {
      this.record(req, 'mock', mock.path);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(mock.body ?? {}));
    }

    // 2) 本地接口映射（最长前缀），转发时去掉环境前缀
    const localApi = matchPrefix(cfg.localApis, raw) || matchPrefix(cfg.localApis, p);
    if (localApi) {
      this.record(req, localApi.target, '本地接口');
      return this.forward(req, res, localApi.target, p + url.search);
    }

    // 3) 本地静态文件
    const staticHit = cfg.staticFiles.find((s) => s.enabled !== false && (s.path === raw || s.path === p));
    if (staticHit && existsSync(staticHit.file)) {
      this.record(req, staticHit.file, '本地文件');
      return this.serveFile(res, staticHit.file);
    }

    // 4) /static/external：静态资源转运营环境，其余转当前环境
    //    与原脚本一致：静态资源转 yy 时要摘掉环境前缀（yy 只认 /static/external/...），
    //    非静态则保留原始路径交给环境。yy 上没有的资源回落当前环境（yy 是旧版本，缺字体库）。
    const extBare = stripPrefix(raw, prefix);
    if (extBare === '/static/external' || extBare.startsWith('/static/external/')) {
      const isAsset = isStaticAsset(extBare);
      const yy = cfg.envs.find((e) => e.id === 'yy');
      const target = isAsset ? yy?.target || env.target : env.target;
      this.record(req, target, isAsset ? 'external 静态' : 'external');
      const fallback = isAsset && target !== env.target ? env.target : null;
      return this.forward(req, res, target, (isAsset ? extBare : raw) + url.search, fallback ? { fallbackTarget: fallback, fallbackPath: prefix + extBare + url.search } : undefined);
    }

    // 5) webpack chunk：优先转本地运行中的服务
    if (isWebpackChunk(p)) {
      const svc = this.runningService(cfg);
      if (svc) {
        this.record(req, svc.target, `chunk → ${svc.name}`);
        return this.forward(req, res, svc.target, p + url.search);
      }
    }

    // 6) 根路径 /static：转本地运行中的服务
    //    原脚本是 app.use('/static')，只匹配裸的 /static；带 /saas-industry 前缀的走环境兜底
    if (raw === '/static' || raw.startsWith('/static/')) {
      const svc = this.runningService(cfg);
      if (svc) {
        this.record(req, svc.target, `${raw} → ${svc.name}`);
        return this.forward(req, res, svc.target, raw + url.search);
      }
      this.record(req, env.target, '/static 无本地服务');
      return this.forward(req, res, env.target, raw + url.search);
    }

    // 7) 各服务路由
    const hit = this.matchService(cfg, p) || this.matchService(cfg, raw);
    if (hit) {
      const { service, svc } = hit;
      if (service.mode !== 'remote' && (service.mode === 'local' || isStaticAsset(p))) {
        if (svc.state === 'running') {
          this.record(req, svc.target, `${service.name} · 本地`);
          return this.forward(req, res, svc.target, stripPrefix(p, service.route) + url.search);
        }
        // 本地没起：静态资源回落环境，避免白屏
        this.record(req, env.target, `${service.name} 未运行，回落环境`);
        return this.forward(req, res, env.target, prefix + p + url.search);
      }
      this.record(req, env.target, `${service.name} · 接口`);
      return this.forward(req, res, env.target, prefix + p + url.search);
    }

    // 8) 兜底：转环境，保留前缀（站点本身挂在 /saas-industry 下）
    this.record(req, env.target, '环境');
    return this.forward(req, res, env.target, prefix + p + url.search);
  }

  runningService(cfg) {
    for (const s of cfg.services) {
      const snap = this.getService?.(s.id);
      if (snap && snap.state === 'running') return { name: snap.name, target: `http://127.0.0.1:${snap.port}` };
    }
    return null;
  }

  matchService(cfg, p) {
    let best = null;
    for (const service of cfg.services) {
      if (!service.enabled || !service.route) continue;
      if (p === service.route || p.startsWith(service.route + '/')) {
        if (!best || service.route.length > best.length) best = service;
      }
    }
    if (!best) return null;
    const snap = this.getService?.(best.id);
    return {
      service: best,
      svc: snap
        ? { ...snap, target: `http://127.0.0.1:${snap.port}` }
        : { state: 'stopped', name: best.name, target: `http://127.0.0.1:${best.port}` },
    };
  }

  serveFile(res, file) {
    try {
      const buf = readFileSync(file);
      res.writeHead(200, { 'Content-Type': mimeOf(file), 'Cache-Control': 'no-store' });
      res.end(buf);
    } catch (e) {
      sendText(res, 404, `文件读取失败：${e.message}`);
    }
  }

  /**
   * 转发到上游。
   * @param {string} target 目标基地址
   * @param {string} outPath 相对路径（含 query）
   * @param {{fallbackTarget: string, fallbackPath: string}} [opt] 上游 404 时改投（仅 GET/HEAD，避免写操作重放）
   */
  forward(req, res, target, outPath, opt) {
    let base;
    try {
      base = new URL(target);
    } catch {
      return sendText(res, 500, `目标地址不合法：${target}`);
    }
    const isHttps = base.protocol === 'https:';
    const method = req.method || 'GET';
    // 404 回落只对只读方法生效：写请求重放可能产生副作用
    const canFallback = !!opt?.fallbackTarget && (method === 'GET' || method === 'HEAD');
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    headers.host = base.host;
    const upstream = (isHttps ? https : http).request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || (isHttps ? 443 : 80),
        method,
        path: base.pathname.replace(/\/+$/, '') + (outPath.startsWith('/') ? outPath : '/' + outPath),
        headers,
        rejectUnauthorized: false,
      },
      (up) => {
        if (canFallback && up.statusCode === 404) {
          up.resume();
          this.log.push(`[fallback] ${req.url} 404 @ ${target} → ${opt.fallbackTarget}`);
          // 用 GET 重投（HEAD 保持 HEAD），不再二次回落
          return this.forward(req, res, opt.fallbackTarget, opt.fallbackPath);
        }
        const h = {};
        for (const [k, v] of Object.entries(up.headers)) if (!HOP_HEADERS.has(k.toLowerCase())) h[k] = v;
        if (h['set-cookie']) h['set-cookie'] = up.headers['set-cookie'].map((c) => c.replace(/;\s*Domain=[^;]*/i, ''));
        res.writeHead(up.statusCode || 502, up.statusMessage || undefined, h);
        up.pipe(res);
      },
    );
    upstream.on('error', (e) => {
      this.log.push(`[error] ${req.method} ${req.url} → ${target} · ${e.message}`);
      if (!res.headersSent) sendText(res, 502, `代理错误：${e.message}`);
      else res.end();
    });
    req.pipe(upstream);
  }

  /** HMR / WebSocket：本地服务在跑就走本地，否则走环境 */
  handleUpgrade(req, socket, head) {
    const cfg = this.getConfig();
    const env = this.currentEnv(cfg);
    if (!env) return socket.destroy();
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const p = stripPrefix(url.pathname, env.apiPrefix || '');
    const hit = this.matchService(cfg, p) || this.matchService(cfg, url.pathname);
    const toLocal = hit?.svc?.state === 'running' && (HMR_RE.test(p) || hit.service.mode === 'local');
    const target = new URL(toLocal ? hit.svc.target : env.target);
    const isHttps = target.protocol === 'https:';
    const headers = { ...req.headers, host: target.host };
    for (const k of HOP_HEADERS) if (k !== 'upgrade') delete headers[k];
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade || 'websocket';
    const upstream = (isHttps ? https : http).request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      method: 'GET',
      path: url.pathname + url.search,
      headers,
      rejectUnauthorized: false,
    });
    upstream.on('upgrade', (up, upSocket, upHead) => {
      const lines = [`HTTP/1.1 101 ${up.statusMessage || 'Switching Protocols'}`];
      for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upHead?.length) socket.write(upHead);
      upSocket.pipe(socket).pipe(upSocket);
      upSocket.on('error', () => socket.destroy());
      socket.on('error', () => upSocket.destroy());
    });
    upstream.on('error', () => socket.destroy());
    if (head?.length) upstream.write(head);
    upstream.end();
  }
}
