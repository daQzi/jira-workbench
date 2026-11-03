// 检查发行包只含应用文件，并通过内置 Node 验证首次启动和本地设置 API。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const target = process.argv[2];
if (!/^(mac|win|linux)-(arm64|x64)$/.test(target || '')) throw new Error('请传入打包目标');
const mac = target.startsWith('mac-');
const root = path.resolve('release', target, mac ? 'Jira工作台.app/Contents/Resources' : `Jira工作台-${target}`);
const app = path.join(root, 'app');
const runtime = mac ? path.join(root, 'node') : path.join(root, 'runtime', target.startsWith('win-') ? 'node.exe' : 'node');
assert.ok(existsSync(runtime), '缺少内置 Node');
assert.ok(existsSync(path.join(path.dirname(runtime), 'NODE-LICENSE.txt')), '缺少 Node 许可');
assert.ok(existsSync(path.join(app, 'dist', 'index.html')), '缺少前端');
assert.deepEqual(readdirSync(app).sort(), (target.startsWith('win-') ? ['dist', 'icon.ico', 'package.json', 'server'] : ['dist', 'package.json', 'server']).sort());
assert.ok(readdirSync(path.join(app, 'server')).every((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')));

const nativePlatform = mac ? 'darwin' : target.startsWith('win-') ? 'win32' : 'linux';
const canRunRuntime = process.platform === nativePlatform && process.arch === target.split('-')[1];
const temp = mkdtempSync(path.join(os.tmpdir(), 'wb-package-'));
const source = `
  import assert from 'node:assert/strict';
  import { startServer, stopServer } from ${JSON.stringify(pathToFileURL(path.join(app, 'server/index.mjs')).href)};
  const { url } = await startServer({ jiraBaseUrl: '', llm: {}, port: 0, serveDist: true, distDir: ${JSON.stringify(path.join(app, 'dist'))}, settingsFile: ${JSON.stringify(path.join(temp, 'settings.json'))} });
  try {
    const settings = await (await fetch(url + '/api/settings')).json();
    assert.equal(settings.jiraBaseUrl, '');
    assert.equal(settings.llmBaseUrl, '');
    assert.equal(settings.llmModel, '');
    assert.equal(settings.llmKeySet, false);
    assert.equal((await fetch(url)).status, 200);
    const login = await fetch(url + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'test', password: 'test' }) });
    assert.equal(login.status, 400);
    assert.match(JSON.stringify(await login.json()), /连接设置/);
    const saved = await fetch(url + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ jiraBaseUrl: 'https://jira.example.com', llmBaseUrl: '', llmModel: '', llmApiKey: '' }) });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).jiraBaseUrl, 'https://jira.example.com');
  } finally { await stopServer(); }
`;
try {
  if (!canRunRuntime) console.log('交叉构建：使用构建机 Node 验证应用；目标运行时需在对应架构实机验证。');
  const child = spawn(canRunRuntime ? runtime : process.execPath, ['--input-type=module', '-e', source], { cwd: temp, stdio: 'inherit' });
  const timeout = setTimeout(() => child.kill(), 30_000);
  try {
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`打包冒烟失败：${code}`)));
    });
  } finally { clearTimeout(timeout); }
} finally { rmSync(temp, { recursive: true, force: true }); }
console.log(`${target} 发行包检查通过`);
