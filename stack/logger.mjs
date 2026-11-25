// 环形日志：内存保留最近 N 条，可选转发给上层（工作台写入 run.log）
// dev server（webpack / vite）会输出大量 ANSI 光标控制与进度条，这里统一清洗。
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\u0007]*\u0007|\x1b[()][A-Z0-9]/g;
// 输出按 chunk 到达，ESC 可能落在上一块末尾：残留的光标码（如 "[24;1H"）也一并清掉
const LEFTOVER_CSI = /\[[0-9;?]{1,12}[A-Za-z]/g;

export function cleanLine(text) {
  return String(text)
    .replace(ANSI, '')
    .replace(LEFTOVER_CSI, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((s) => s.replace(/\s+$/, ''))
    .filter((s) => s.trim());
}

export function createLogger({ onLog, limit = 300 } = {}) {
  const lines = [];
  return {
    push(line) {
      for (const one of cleanLine(line)) {
        lines.push(`${new Date().toISOString()} ${one}`);
        if (lines.length > limit) lines.splice(0, lines.length - limit);
        onLog?.(one);
      }
    },
    list(n = limit) {
      return lines.slice(-n);
    },
    clear() {
      lines.length = 0;
    },
  };
}
