// 桌面端入口（macOS / Windows / Linux 通用）：启动本地代理并托管 dist，
// 再用本机 Chrome / Edge 的应用窗口打开；窗口关闭后代理随之退出。
// 配置文件：
//   macOS   ~/Library/Application Support/JiraWorkbench/config.json
//   Windows %APPDATA%\JiraWorkbench\config.json
//   Linux   ~/.config/JiraWorkbench/config.json
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_JIRA_BASE_URL, startServer, stopServer } from './index.mjs';
import { DEFAULT_LLM, jiraOrDefault } from './settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM = process.platform;
const HOME = os.homedir();
const SUPPORT =
  PLATFORM === 'darwin'
    ? path.join(HOME, 'Library', 'Application Support', 'JiraWorkbench')
    : PLATFORM === 'win32'
      ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'JiraWorkbench')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'JiraWorkbench');
const CONFIG = path.join(SUPPORT, 'config.json');
// 固定端口：浏览器本地存储（字段设置、工时面板）按端口区分，换端口会丢
const PORT = 18787;
const URL_ = `http://127.0.0.1:${PORT}/`;

// 日志写到配置目录（Windows 隐藏窗口启动、macOS 从访达启动时都看不到控制台）
mkdirSync(SUPPORT, { recursive: true });
const LOG = path.join(SUPPORT, 'run.log');
for (const level of ['log', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => {
    orig(...a);
    try {
      appendFileSync(LOG, `${new Date().toISOString()} ${a.map(String).join(' ')}\n`);
    } catch {
      /* 日志失败不影响运行 */
    }
  };
}

const DEFAULTS = { jiraBaseUrl: DEFAULT_JIRA_BASE_URL, allowWrite: true, writeProjects: [] };
// 日报拆分用的大模型（OpenAI 兼容）；登录页「连接设置」可改，保存到 config.json 的 llm；apiKey 也可用环境变量 WB_LLM_API_KEY
const LLM_DEFAULTS = { ...DEFAULT_LLM, apiKey: '', timeoutMs: 60000, maxHoursPerTask: 8, promptExtra: '' };

function loadConfig() {
  mkdirSync(SUPPORT, { recursive: true });
  if (!existsSync(CONFIG)) writeFileSync(CONFIG, JSON.stringify({ ...DEFAULTS, llm: LLM_DEFAULTS }, null, 2) + '\n', { mode: 0o600 });
  try {
    const c = JSON.parse(readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, ''));
    const llm = { ...LLM_DEFAULTS, ...(c.llm && typeof c.llm === 'object' ? c.llm : {}) };
    if (!llm.apiKey) llm.apiKey = process.env.WB_LLM_API_KEY || '';
    // 配置里可能有 Key：只允许当前用户读写
    if (PLATFORM !== 'win32') {
      try {
        chmodSync(CONFIG, 0o600);
      } catch {
        /* 权限调整失败不影响启动 */
      }
    }
    return {
      llm,
      jiraBaseUrl: jiraOrDefault(c.jiraBaseUrl),
      allowWrite: c.allowWrite !== false,
      writeProjects: Array.isArray(c.writeProjects) ? c.writeProjects.map((x) => String(x).toUpperCase()) : [],
    };
  } catch (e) {
    throw new Error(`配置文件格式错误：${CONFIG}（${e.message}）`);
  }
}

function browserArgs() {
  return [`--app=${URL_}`, `--user-data-dir=${path.join(SUPPORT, 'browser')}`, '--no-first-run', '--no-default-browser-check', '--window-size=1440,900'];
}

/** 按平台找 Chromium 系浏览器的可执行文件 */
function findBrowser() {
  if (PLATFORM === 'win32') {
    const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
    const rel = [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'], // Win10/11 自带
    ];
    for (const r of rel) for (const root of roots) {
      const p = path.join(root, ...r);
      if (existsSync(p)) return p;
    }
    return null;
  }
  if (PLATFORM === 'linux') {
    const names = ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'chromium', 'chromium-browser'];
    for (const dir of (process.env.PATH || '').split(path.delimiter)) for (const n of names) {
      const p = path.join(dir, n);
      if (existsSync(p)) return p;
    }
    return null;
  }
  return null; // macOS 走 LaunchServices，见 openWindow
}

/** 打开系统默认浏览器（兜底） */
function openDefault() {
  const [cmd, args] =
    PLATFORM === 'win32' ? ['cmd', ['/c', 'start', '', URL_]] : PLATFORM === 'darwin' ? ['open', [URL_]] : ['xdg-open', [URL_]];
  spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
}

/**
 * 打开应用窗口，返回“窗口进程”（退出即视为窗口关闭）；只能用默认浏览器时返回 null。
 * 都用独立的用户目录，窗口不混进日常浏览器，且关闭窗口能被感知。
 */
function openWindow() {
  if (PLATFORM === 'darwin') {
    const name = ['Google Chrome', 'Microsoft Edge', 'Chromium'].find(
      (n) => existsSync(`/Applications/${n}.app`) || existsSync(path.join(HOME, 'Applications', `${n}.app`)),
    );
    if (!name) return openDefault(), null;
    // 经 LaunchServices 拉起：浏览器自动更新不会被记到本应用头上；-W 等待该实例退出
    return spawn('open', ['-n', '-W', '-a', name, '--args', ...browserArgs()], { stdio: 'ignore' });
  }
  const bin = findBrowser();
  if (!bin) return openDefault(), null;
  return spawn(bin, browserArgs(), { stdio: 'ignore', windowsHide: false });
}

async function alreadyRunning() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return (await r.json())?.app === 'jira-workbench';
  } catch {
    return false;
  }
}

function alert(msg) {
  console.error('[desktop]', msg);
  const m = String(msg).replace(/["\r\n]/g, ' ');
  if (PLATFORM === 'darwin') spawn('osascript', ['-e', `display alert "Jira 工作台启动失败" message "${m}"`]);
  else if (PLATFORM === 'win32') spawn('mshta', [`javascript:alert("Jira 工作台启动失败：${m.replace(/\\/g, '\\\\')}");close()`], { windowsHide: true });
  else spawn('notify-send', ['Jira 工作台启动失败', m]).on('error', () => {});
}

// macOS 原生外壳（scripts/mac/main.swift）：窗口由外壳提供，这里只起服务。
// 外壳退出时 stdin 会关闭（含崩溃），据此结束服务，避免留下孤儿进程。
const NATIVE = process.env.WB_SHELL === 'native';

async function main() {
  if (NATIVE) {
    if (await alreadyRunning()) return;
    const cfg = loadConfig();
    await startServer({ ...cfg, port: PORT, serveDist: true, distDir: path.resolve(HERE, '..', 'dist'), sessionDir: path.join(SUPPORT, 'session'), settingsFile: CONFIG });
    const quit = async () => {
      await stopServer();
      process.exit(0);
    };
    process.stdin.on('end', quit).on('error', quit).resume();
    process.on('SIGTERM', quit);
    process.on('SIGINT', quit);
    return;
  }
  if (await alreadyRunning()) {
    // 已有实例在跑：只再开一个窗口
    openWindow();
    return;
  }
  const cfg = loadConfig();
  await startServer({ ...cfg, port: PORT, serveDist: true, distDir: path.resolve(HERE, '..', 'dist'), sessionDir: path.join(SUPPORT, 'session'), settingsFile: CONFIG });
  const win = openWindow();
  if (!win) return; // 默认浏览器模式：代理常驻，直到注销或手动结束 node 进程
  const quit = async (code = 0) => {
    await stopServer();
    process.exit(code);
  };
  const openedAt = Date.now();
  win.on('exit', () => {
    // 几秒内就退出：浏览器把窗口交给了已在运行的同一实例，无法感知关闭，代理保持运行
    if (Date.now() - openedAt < 5000) return console.log('[desktop] 窗口已交给已有浏览器实例，代理保持运行');
    quit(0);
  });
  win.on('error', (e) => {
    console.error('[desktop] 打开窗口失败：', e.message);
    openDefault();
  });
  process.on('SIGTERM', () => quit(0));
  process.on('SIGINT', () => quit(0));
}

main().catch((e) => {
  alert(e.code === 'EADDRINUSE' ? `端口 ${PORT} 被其他程序占用` : e.message);
  process.exitCode = 1;
});
