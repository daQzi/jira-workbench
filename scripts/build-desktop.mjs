// 轻量多平台桌面包：官方 Node 运行时 + 代理源码 + dist，窗口用本机 Chrome / Edge 的应用模式。
// 不依赖 Electron；macOS 原生外壳在 macOS 编译，Windows/Linux 复用系统浏览器。
//   npm run desktop                       # 默认只打本机：mac-arm64
//   npm run desktop -- win-x64 linux-x64  # 其他平台（Windows/Linux 尚未实机验证）
// 产物在 release/：
//   mac-arm64 / mac-x64   Jira工作台.app（zip）
//   win-x64 / win-arm64   文件夹 + 「Jira工作台.vbs」双击启动（zip）
//   linux-x64             文件夹 + jira-workbench.sh（tar.gz）
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'release');
const CACHE = path.join(OUT, '.cache');
const NAME = 'Jira工作台';
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
// 开发、CI 和内置运行时使用同一版本，避免包随构建机器变化。
const NODE_VER = `v${readFileSync(path.join(ROOT, '.node-version'), 'utf8').trim()}`;
const ALL = ['mac-arm64', 'mac-x64', 'win-x64', 'win-arm64', 'linux-x64'];
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const hostTarget = `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}`;
const targets = wanted.length ? wanted : [hostTarget];
for (const t of targets) if (!ALL.includes(t)) throw new Error(`未知平台 ${t}，可选：${ALL.join(' ')}`);
if (targets.some((t) => t.startsWith('mac')) && process.platform !== 'darwin') throw new Error('macOS 原生外壳需要在 macOS 上构建');

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
mkdirSync(CACHE, { recursive: true });

console.log('构建前端');
run(process.execPath, ['node_modules/typescript/bin/tsc', '-b']);
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
const png = makeIconPng();

for (const t of targets) {
  console.log(`\n== ${t}`);
  if (t.startsWith('mac')) buildMac(t);
  else if (t.startsWith('win')) buildWin(t);
  else buildLinux(t);
}
console.log('\n完成，产物在', OUT);

// ---------- 公共 ----------

var sums = null;

/** 应用本体：server（不含测试）+ dist + ESM 标记 */
function copyApp(dest) {
  mkdirSync(path.join(dest, 'server'), { recursive: true });
  cpSync(path.join(ROOT, 'dist'), path.join(dest, 'dist'), { recursive: true });
  for (const f of readdirSync(path.join(ROOT, 'server'))) {
    if (f.endsWith('.mjs') && !f.endsWith('.test.mjs')) cpSync(path.join(ROOT, 'server', f), path.join(dest, 'server', f));
  }
  writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ type: 'module', private: true, version: pkg.version }) + '\n');
}

/** 下载官方 Node 并按 SHASUMS256 校验，返回解压出的 node 可执行文件路径 */
function fetchNode(os, arch) {
  const ext = os === 'win' ? 'zip' : os === 'linux' ? 'tar.xz' : 'tar.gz';
  const base = `node-${NODE_VER}-${os === 'mac' ? 'darwin' : os}-${arch}`;
  const file = path.join(CACHE, `${base}.${ext}`);
  if (!existsSync(file)) run('curl', ['-fL', '--retry', '2', '-o', file, `https://nodejs.org/dist/${NODE_VER}/${base}.${ext}`]);
  sums ??= execFileSync('curl', ['-fsL', `https://nodejs.org/dist/${NODE_VER}/SHASUMS256.txt`]).toString();
  const want = sums.split('\n').find((l) => l.trim().endsWith(`  ${base}.${ext}`))?.split(/\s+/)[0];
  const got = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (!want || want !== got) {
    rmSync(file, { force: true });
    throw new Error(`${base}.${ext} 校验失败（期望 ${want}，实际 ${got}），已删除缓存，请重试`);
  }
  const inner = os === 'win' ? `${base}/node.exe` : `${base}/bin/node`;
  const outFile = path.join(CACHE, inner);
  if (!existsSync(outFile) || !existsSync(path.join(CACHE, base, 'LICENSE'))) {
    if (os === 'win' && process.platform === 'win32') {
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:WB_ARCHIVE -DestinationPath $env:WB_DEST -Force'], {
        env: { ...process.env, WB_ARCHIVE: file, WB_DEST: CACHE },
      });
    } else if (os === 'win') run('unzip', ['-oq', file, '-d', CACHE]);
    else run('tar', ['-xf', file, '-C', CACHE, inner, `${base}/LICENSE`]);
  }
  cpSync(path.join(CACHE, base, 'LICENSE'), path.join(path.dirname(outFile), 'NODE-LICENSE.txt'));
  return outFile;
}

function copyRuntime(os, arch, dest) {
  const node = fetchNode(os, arch);
  cpSync(node, dest);
  cpSync(path.join(path.dirname(node), 'NODE-LICENSE.txt'), path.join(path.dirname(dest), 'NODE-LICENSE.txt'));
}

function archOf(t) {
  return t.split('-')[1];
}

// ---------- macOS ----------

function buildMac(t) {
  const arch = archOf(t);
  const dir = path.join(OUT, t);
  const APP = path.join(dir, `${NAME}.app`);
  rmSync(dir, { recursive: true, force: true });
  const C = path.join(APP, 'Contents');
  const RES = path.join(C, 'Resources');
  mkdirSync(path.join(C, 'MacOS'), { recursive: true });
  copyApp(path.join(RES, 'app'));
  copyRuntime('mac', arch, path.join(RES, 'node'));
  chmodSync(path.join(RES, 'node'), 0o755);

  // 主程序是原生 Swift 外壳（自带 WKWebView 窗口 + Dock 图标），后台拉起内置 Node 代理
  run('swiftc', [
    '-O', '-target', `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos12.0`,
    '-framework', 'Cocoa', '-framework', 'WebKit',
    '-o', path.join(C, 'MacOS', 'JiraWorkbench'), path.join(ROOT, 'scripts', 'mac', 'main.swift'),
  ]);

  writeFileSync(
    path.join(C, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>${NAME}</string>
  <key>CFBundleDisplayName</key><string>${NAME}</string>
  <key>CFBundleIdentifier</key><string>local.jira-workbench</string>
  <key>CFBundleVersion</key><string>${pkg.version}</string>
  <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
  <key>CFBundleExecutable</key><string>JiraWorkbench</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHumanReadableCopyright</key><string>内部工具 · Jira 6 研发工作台</string>
</dict></plist>
`,
  );
  makeIcns(path.join(RES, 'icon.icns'));
  // ad-hoc 签名：Apple 芯片上未签名的程序无法运行；没有开发者证书，同事首次打开需右键 → 打开
  run('codesign', ['--force', '--deep', '--sign', '-', APP]);
  const zip = path.join(OUT, `${pkg.name}-${pkg.version}-${t}.zip`);
  rmSync(zip, { force: true });
  run('ditto', ['-c', '-k', '--keepParent', APP, zip]);
}

// ---------- Windows ----------

function buildWin(t) {
  const arch = archOf(t);
  const top = `${NAME}-${t}`;
  const dir = path.join(OUT, t, top);
  rmSync(path.join(OUT, t), { recursive: true, force: true });
  mkdirSync(path.join(dir, 'runtime'), { recursive: true });
  copyApp(path.join(dir, 'app'));
  copyRuntime('win', arch, path.join(dir, 'runtime', 'node.exe'));
  writeFileSync(path.join(dir, 'app', 'icon.ico'), makeIco());

  // 双击 .vbs：无黑色命令行窗口地启动 node；.cmd 作为备用（会显示控制台，便于看报错）
  const vbs = `' Jira 工作台启动器：隐藏窗口运行内置 Node
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run """" & dir & "\\runtime\\node.exe"" """ & dir & "\\app\\server\\desktop.mjs""", 0, False
`;
  writeFileSync(path.join(dir, `${NAME}.vbs`), '\uFEFF' + vbs.replace(/\n/g, '\r\n'), 'utf16le');
  const cmd = `@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0app\\server\\desktop.mjs"\r\nif errorlevel 1 pause\r\n`;
  writeFileSync(path.join(dir, '调试启动.cmd'), cmd);
  // 创建桌面快捷方式（带图标）
  const shortcut = `' 在桌面创建「Jira工作台」快捷方式
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set lnk = sh.CreateShortcut(sh.SpecialFolders("Desktop") & "\\${NAME}.lnk")
lnk.TargetPath = sh.ExpandEnvironmentStrings("%WINDIR%") & "\\System32\\wscript.exe"
lnk.Arguments = """" & dir & "\\${NAME}.vbs"""
lnk.WorkingDirectory = dir
lnk.IconLocation = dir & "\\app\\icon.ico"
lnk.Save
MsgBox "已在桌面创建「${NAME}」快捷方式", 64, "${NAME}"
`;
  writeFileSync(path.join(dir, '创建桌面快捷方式.vbs'), '\uFEFF' + shortcut.replace(/\n/g, '\r\n'), 'utf16le');
  writeFileSync(
    path.join(dir, '使用说明.txt'),
    `${NAME} ${pkg.version}（Windows ${arch}）\r\n\r\n` +
      `1. 把整个文件夹解压到固定位置（如 D:\\${NAME}），不要在压缩包里直接运行。\r\n` +
      `2. 双击「${NAME}.vbs」启动，会打开 Edge/Chrome 的独立窗口。\r\n` +
      `3. 想要桌面图标：双击「创建桌面快捷方式.vbs」。\r\n` +
      `4. 启动没反应：双击「调试启动.cmd」查看报错；日志在 %APPDATA%\\JiraWorkbench\\run.log。\r\n` +
      `5. 修改 Jira 地址或写入范围：编辑 %APPDATA%\\JiraWorkbench\\config.json 后重启。\r\n` +
      `   writeProjects 留空 [] 表示所有项目可写；如 ["AGENT"] 表示只允许写 AGENT。\r\n\r\n` +
      `需要 Windows 10/11（自带 Edge）。首次运行若出现 SmartScreen 提示，点「更多信息 → 仍要运行」。\r\n`,
  );
  const zip = path.join(OUT, `${pkg.name}-${pkg.version}-${t}.zip`);
  rmSync(zip, { force: true });
  // -X 去掉 mac 扩展属性；zip 里中文文件名用 UTF-8（Win10 1903+ 资源管理器可正常显示）
  if (process.platform === 'win32') {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath $env:WB_SOURCE -DestinationPath $env:WB_ARCHIVE -CompressionLevel Optimal'], {
      env: { ...process.env, WB_SOURCE: dir, WB_ARCHIVE: zip },
    });
  } else run('zip', ['-qrX', zip, top], { cwd: path.join(OUT, t) });
}

// ---------- Linux ----------

function buildLinux(t) {
  const arch = archOf(t);
  const top = `jira-workbench-${t}`;
  const dir = path.join(OUT, t, top);
  rmSync(path.join(OUT, t), { recursive: true, force: true });
  mkdirSync(path.join(dir, 'runtime'), { recursive: true });
  copyApp(path.join(dir, 'app'));
  copyRuntime('linux', arch, path.join(dir, 'runtime', 'node'));
  chmodSync(path.join(dir, 'runtime', 'node'), 0o755);
  writeFileSync(path.join(dir, 'app', 'icon.png'), png);
  const sh = path.join(dir, 'jira-workbench.sh');
  writeFileSync(sh, `#!/bin/sh\nDIR="$(cd "$(dirname "$0")" && pwd)"\nexec "$DIR/runtime/node" "$DIR/app/server/desktop.mjs" "$@"\n`);
  chmodSync(sh, 0o755);
  const tgz = path.join(OUT, `${pkg.name}-${pkg.version}-${t}.tar.gz`);
  rmSync(tgz, { force: true });
  run('tar', [...(process.platform === 'darwin' ? ['--no-xattrs'] : []), '-czf', tgz, top], { cwd: path.join(OUT, t), env: { ...process.env, COPYFILE_DISABLE: '1' } });
}

// ---------- 图标 ----------

/** 纯 Node 画 1024 图标（橙色圆角方块 + 三列看板） */
function makeIconPng(S = 1024) {
  const px = Buffer.alloc(S * S * 4);
  const inRound = (x, y, x0, y0, x1, y1, rad) => {
    if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
    const cx = Math.min(Math.max(x, x0 + rad), x1 - rad);
    const cy = Math.min(Math.max(y, y0 + rad), y1 - rad);
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
  };
  const cols = [
    [250, 230, 520],
    [440, 230, 700],
    [630, 230, 420],
  ];
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) * 1024 / S;
      const dy = (y + 0.5) * 1024 / S;
      if (!inRound(dx, dy, 100, 100, 924, 924, 190)) continue;
      const t = (dy - 100) / 824;
      let c = [Math.round(232 - 30 * t), Math.round(98 - 40 * t), Math.round(40 - 14 * t)];
      for (const [cx, top, h] of cols) if (inRound(dx, dy, cx, top, cx + 150, top + h, 34)) c = [255, 248, 240];
      const i = (y * S + x) * 4;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  return encodePng(px, S);
}

function encodePng(px, S) {
  const raw = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const v of b) c = table[(c ^ v) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function resized(size) {
  const out = path.join(CACHE, `icon-${size}.png`);
  writeFileSync(out, makeIconPng(size));
  return out;
}

function makeIcns(target) {
  const set = path.join(CACHE, 'icon.iconset');
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    cpSync(resized(s), path.join(set, `icon_${s}x${s}.png`));
    cpSync(resized(s * 2), path.join(set, `icon_${s}x${s}@2x.png`));
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', target]);
}

/** .ico：内嵌 PNG（Vista 起支持） */
function makeIco() {
  const sizes = [16, 32, 48, 256];
  const imgs = sizes.map((s) => readFileSync(resized(s)));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let off = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head[e] = s >= 256 ? 0 : s;
    head[e + 1] = s >= 256 ? 0 : s;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(imgs[i].length, e + 8);
    head.writeUInt32LE(off, e + 12);
    off += imgs[i].length;
  });
  return Buffer.concat([head, ...imgs]);
}
