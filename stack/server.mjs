// 独立运行入口：node stack/server.mjs
// 只用 Node 内置模块，不需要 npm install；配置默认在 ~/.wb-stack/config.json。
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStack } from './index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(HERE, 'ui');
const PORT = Number(process.env.WB_STACK_UI_PORT || 18888);
const HOST = '127.0.0.1';

const stack = createStack({ onLog: () => {} });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

async function serveUi(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.startsWith('/stack-ui/')) rel = rel.slice('/stack-ui'.length);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.resolve(UI_DIR, '.' + rel);
  if (!file.startsWith(UI_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const buf = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('UI 未构建：stack/ui/index.html 不存在');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);
  try {
    if (url.pathname.startsWith('/api/stack/')) return await stack.handle(req, res, url);
    if (existsSync(UI_DIR)) return await serveUi(req, res, url);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('未找到 UI 目录');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(e.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[stack] 控制台 http://${HOST}:${PORT}`);
  stack.start().catch((e) => console.error('[stack] 启动失败：', e.message));
});

let closing = false;
const shutdown = async (code = 0) => {
  if (closing) return;
  closing = true;
  await stack.stop().catch(() => {});
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 3000).unref();
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(0));
process.on('exit', () => {
  void stack.stop();
});
