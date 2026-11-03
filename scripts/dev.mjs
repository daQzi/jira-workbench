// 同时启动本地代理与 Vite，任一退出则全部退出
import { spawn } from 'node:child_process';

const procs = [
  spawn(process.execPath, ['server/index.mjs'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];
const stopAll = (code = 0) => {
  for (const p of procs) if (p.exitCode === null) p.kill('SIGTERM');
  process.exit(code);
};
for (const p of procs) p.on('exit', (code) => stopAll(code ?? 0));
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
