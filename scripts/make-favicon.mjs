// 生成站点图标：墨蓝圆角底 + 橙色折角 + 白色 J（与工作台「工程台账」配色一致）。
// 纯 Node 画像素，不依赖图形库；同时产出 SVG（现代浏览器）与 PNG/ICO（兼容与桌面快捷方式）。
// 用法：node scripts/make-favicon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public');

const NAVY = [34, 52, 77];
const NAVY_DEEP = [24, 38, 57];
const ORANGE = [226, 86, 31];
const PAPER = [247, 242, 232];

/** 圆角矩形判定 */
const inRound = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

/** 到线段的距离（用于画等宽笔画） */
function segDist(x, y, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / len2));
  return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
}

/** 到圆弧的距离（角度用屏幕坐标，0=右，90=下，180=左） */
function arcDist(x, y, cx, cy, r, fromDeg, toDeg) {
  const ang = (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
  const norm = (a) => (a < 0 ? a + 360 : a);
  const a = norm(ang);
  if (a >= fromDeg && a <= toDeg) return Math.abs(Math.hypot(x - cx, y - cy) - r);
  const pt = (deg) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];
  const [x0, y0] = pt(fromDeg);
  const [x1, y1] = pt(toDeg);
  return Math.min(Math.hypot(x - x0, y - y0), Math.hypot(x - x1, y - y1));
}

/** 在 1024 坐标系里画一个像素，返回 [r,g,b,a] */
function shade(px, py) {
  const x = px + 0.5;
  const y = py + 0.5;
  if (!inRound(x, y, 48, 48, 976, 976, 210)) return null;
  // 左上到右下的轻微渐变，小尺寸下不至于死板
  const t = (x + y) / 2048;
  let c = [
    Math.round(NAVY[0] + (NAVY_DEEP[0] - NAVY[0]) * t),
    Math.round(NAVY[1] + (NAVY_DEEP[1] - NAVY[1]) * t),
    Math.round(NAVY[2] + (NAVY_DEEP[2] - NAVY[2]) * t),
  ];
  // 右上角橙色折角，像翻起的台账纸角（大一些，小尺寸下也有辨识度）
  if (x > 640 && y < 360 && x - 640 > 360 - y) c = ORANGE;

  // J：竖干 + 底部半圆钩 + 左侧向上收尾，统一笔画宽度，小尺寸下仍可辨认
  const half = 60;
  const stroke = Math.min(
    segDist(x, y, 600, 320, 600, 610),
    arcDist(x, y, 500, 610, 100, 0, 180),
    segDist(x, y, 400, 610, 400, 460),
  );
  if (stroke <= half) c = PAPER;

  // 底部橙色基准线，暗示「工时 / 台账」
  if (inRound(x, y, 330, 862, 700, 892, 15)) c = ORANGE;
  return [...c, 255];
}

function render(S) {
  const px = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const c = shade((x * 1024) / S, (y * 1024) / S);
      if (!c) continue;
      const i = (y * S + x) * 4;
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
      px[i + 3] = c[3];
    }
  return px;
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
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** ICO 内嵌 PNG（Vista 起支持，Chrome/Edge 均可用） */
function makeIco(sizes) {
  const imgs = sizes.map((s) => encodePng(render(s), s));
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

/** 与上面像素绘制同构的矢量版本（按 1024 画布） */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Jira 工作台">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#22344d"/><stop offset="1" stop-color="#182639"/>
    </linearGradient>
    <clipPath id="card"><rect x="48" y="48" width="928" height="928" rx="210"/></clipPath>
  </defs>
  <g clip-path="url(#card)">
    <rect x="48" y="48" width="928" height="928" fill="url(#bg)"/>
    <path d="M640 48h336v312z" fill="#e2561f"/>
    <path d="M600 320V610A100 100 0 0 1 400 610V460" fill="none" stroke="#f7f2e8" stroke-width="120" stroke-linecap="round"/>
    <rect x="330" y="862" width="370" height="30" rx="15" fill="#e2561f"/>
  </g>
</svg>
`;

mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'favicon.svg'), SVG);
writeFileSync(path.join(OUT, 'favicon-32.png'), encodePng(render(32), 32));
writeFileSync(path.join(OUT, 'apple-touch-icon.png'), encodePng(render(180), 180));
writeFileSync(path.join(OUT, 'favicon.ico'), makeIco([16, 32, 48]));
console.log('已生成 public/favicon.svg、favicon.ico、favicon-32.png、apple-touch-icon.png');
