// 写操作白名单策略。单独成文件便于单元测试（server/policy.test.mjs）。
// 只开放工作台需要的写接口。DELETE 只有：移除问题链接、删除评论、删除附件；不提供删除问题。
// 评论/附件的编辑删除，index.mjs 会先确认它确实属于路径/参数里的问题，再按该问题的项目做范围校验。

const KEY = '([A-Za-z][A-Za-z0-9]+-\\d+)';

const WRITE_ROUTES = [
  // 新建问题；创建时可带 update.issuelinks 挂父需求
  { method: 'POST', re: /^issue$/, targets: (_m, body) => ({ projects: [body?.fields?.project?.key ?? null], keys: linkKeysOfCreate(body) }) },
  { method: 'PUT', re: new RegExp(`^issue/${KEY}$`), targets: (m) => ({ keys: [m[1]] }) },
  { method: 'PUT', re: new RegExp(`^issue/${KEY}/assignee$`), targets: (m) => ({ keys: [m[1]] }) },
  { method: 'POST', re: new RegExp(`^issue/${KEY}/transitions$`), targets: (m) => ({ keys: [m[1]] }) },
  { method: 'POST', re: new RegExp(`^issue/${KEY}/comment$`), targets: (m) => ({ keys: [m[1]] }) },
  // 编辑/删除评论（Jira 再按 EDIT/DELETE_OWN|ALL_COMMENTS 权限校验）
  { method: 'PUT', re: new RegExp(`^issue/${KEY}/comment/(\\d+)$`), targets: (m) => ({ keys: [m[1]] }) },
  { method: 'DELETE', re: new RegExp(`^issue/${KEY}/comment/(\\d+)$`), targets: (m) => ({ keys: [m[1]] }) },
  // 删除附件：路径只有附件 id，body 由 index.mjs 校验归属后传入 { issueKey }
  { method: 'DELETE', re: /^attachment\/(\d+)$/, targets: (_m, body) => ({ keys: [body?.issueKey ?? null] }) },
  // 附件上传（multipart，由 index.mjs 单独转发，body 为 null）
  { method: 'POST', re: new RegExp(`^issue/${KEY}/attachments$`), targets: (m) => ({ keys: [m[1]] }) },
  { method: 'POST', re: /^issueLink$/, targets: (_m, body) => ({ keys: [body?.inwardIssue?.key ?? null, body?.outwardIssue?.key ?? null] }) },
  // 移除链接：路径只有链接 id，body 由 index.mjs 先查出链接两端再传入，按两端项目做范围校验
  { method: 'DELETE', re: /^issueLink\/(\d+)$/, targets: (_m, body) => ({ keys: [body?.inwardIssue?.key ?? null, body?.outwardIssue?.key ?? null] }) },
];

export function linkDeleteId(method, sub) {
  const m = method === 'DELETE' ? sub.match(/^issueLink\/(\d+)$/) : null;
  return m ? m[1] : null;
}

/**
 * 需要先确认归属的写操作：评论（路径带问题编号）和附件删除（问题编号放在 ?issueKey=）。
 * @returns {null | {kind: 'comment'|'attachment', key: string|null, id: string}}
 */
export function ownedTarget(method, sub, query) {
  const c = (method === 'PUT' || method === 'DELETE') && sub.match(new RegExp(`^issue/${KEY}/comment/(\\d+)$`));
  if (c) return { kind: 'comment', key: c[1].toUpperCase(), id: c[2] };
  const a = method === 'DELETE' && sub.match(/^attachment\/(\d+)$/);
  if (a) {
    const key = query?.get?.('issueKey') ?? null;
    return { kind: 'attachment', key: key && new RegExp(`^${KEY}$`).test(key) ? key.toUpperCase() : null, id: a[1] };
  }
  return null;
}

export function isAttachmentUpload(method, sub) {
  return method === 'POST' && new RegExp(`^issue/${KEY}/attachments$`).test(sub);
}

// 附件文件代理：只允许 /secure/attachment/<id>/<name> 与 /secure/thumbnail/<id>/<name>
const FILE_RE = /^(attachment|thumbnail)\/(\d+)\/([^/]+)$/;
const INLINE_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);

export function parseFilePath(sub) {
  const m = sub.match(FILE_RE);
  return m ? { kind: m[1], id: m[2], name: m[3] } : null;
}

/** 附件从本站源下发，非图片一律强制下载，防止 HTML/SVG 附件在本站执行脚本 */
export function fileResponseHeaders(contentType, filename) {
  const ct = (contentType || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const inline = INLINE_IMAGE.has(ct);
  return {
    'Content-Type': inline ? ct : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'private, max-age=3600',
  };
}

function linkKeysOfCreate(body) {
  const links = body?.update?.issuelinks;
  if (!Array.isArray(links)) return [];
  return links.flatMap((l) => [l?.add?.inwardIssue?.key, l?.add?.outwardIssue?.key]).filter(Boolean);
}

export function projectOfKey(key) {
  return String(key).split('-')[0].toUpperCase();
}

/**
 * @param {{allowWrite: boolean, writeProjects: string[]}} cfg
 * @returns {null | {status: number, msg: string}} null 表示放行
 */
export function checkWrite(cfg, method, sub, body) {
  if (!cfg.allowWrite) return { status: 405, msg: '写操作未开启（需 WB_ALLOW_WRITE=1）' };
  for (const r of WRITE_ROUTES) {
    if (r.method !== method) continue;
    const m = sub.match(r.re);
    if (!m) continue;
    const t = r.targets(m, body);
    if ((t.projects ?? []).some((p) => !p) || (t.keys ?? []).some((k) => k === null)) {
      return { status: 400, msg: '请求缺少项目或问题编号' };
    }
    const projects = [...(t.projects ?? []), ...(t.keys ?? []).map(projectOfKey)].map((p) => String(p).toUpperCase());
    if (cfg.writeProjects.length) {
      const bad = [...new Set(projects.filter((p) => !cfg.writeProjects.includes(p)))];
      if (bad.length) {
        return { status: 403, msg: `当前只允许写入项目 ${cfg.writeProjects.join(',')}，已拒绝 ${bad.join(',')}` };
      }
    }
    return null;
  }
  return { status: 403, msg: `不允许的写接口：${method} ${sub}` };
}
