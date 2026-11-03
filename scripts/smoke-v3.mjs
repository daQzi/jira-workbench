// 第 3 阶段冒烟：新建时关联（父需求 + Relates）、附件上传/读取、工时查询、范围外拦截。
//   代理需以 npm run dev:write 启动（仅 AGENT 可写）
//   JIRA_USER=xxx JIRA_PASS=xxx PARENT=AGENT-4 RELATE=AGENT-1 npm run smoke:v3
// 只新建 1 条 [测试] 其他任务；本账号无删除权限，数据会保留。
const BASE = process.env.WB_URL || 'http://127.0.0.1:8787';
const { JIRA_USER, JIRA_PASS } = process.env;
const P = process.env.TEST_PROJECT || 'AGENT';
const PARENT = process.env.PARENT || `${P}-4`;
const RELATE = process.env.RELATE || `${P}-1`;
const GUARD = process.env.GUARD_PROJECT || 'YLZHXT';
if (!JIRA_USER || !JIRA_PASS) {
  console.error('请设置 JIRA_USER / JIRA_PASS');
  process.exit(2);
}
let cookie = '';
async function call(method, p, body, raw) {
  const res = await fetch(BASE + p, {
    method,
    headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  let d = buf;
  if (ct.includes('json')) {
    try {
      d = JSON.parse(buf.toString('utf8') || 'null');
    } catch {
      d = buf.toString('utf8');
    }
  }
  return { status: res.status, body: d, headers: res.headers };
}
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  return ok;
};

await call('POST', '/api/login', { username: JIRA_USER, password: JIRA_PASS });
const me = await call('GET', '/api/me');
if (!check('写开关与范围', me.body?.allowWrite && me.body.writeProjects.join() === P, JSON.stringify(me.body?.writeProjects))) process.exit(1);

// 1. 链接类型
const lt = await call('GET', '/api/jira/issueLinkType');
check('读取链接类型', lt.status === 200 && lt.body.issueLinkTypes.some((t) => t.name === 'Relates'));

// 2. 范围外附件上传被拦截（不读取文件、不到达 Jira）
const fd0 = new FormData();
fd0.append('file', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
const g = await call('POST', `/api/jira/issue/${GUARD}-1/attachments`, null, fd0);
check(`${GUARD} 附件上传被拦截`, g.status === 403);
const g2 = await call('POST', '/api/jira/issue', {
  fields: { project: { key: P }, issuetype: { name: '其他任务' }, summary: 'x' },
  update: { issuelinks: [{ add: { type: { name: 'Relates' }, outwardIssue: { key: `${GUARD}-1` } } }] },
});
check(`新建时关联 ${GUARD} 被拦截`, g2.status === 403);

// 3. 新建其他任务：随创建挂父需求 + Relates（与前端 planCreate 相同结构）
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
// REUSE=AGENT-10 时复用已建问题，不再新建（测试数据删不掉，尽量少建）
const created = process.env.REUSE ? { status: 201, body: { key: process.env.REUSE } } : await call('POST', '/api/jira/issue', {
  fields: { project: { key: P }, issuetype: { name: '其他任务' }, summary: `[测试] 新建即关联+附件 ${stamp}`, assignee: { name: JIRA_USER } },
  // Jira 6.0 创建时只接受 1 条链接：父需求随创建提交，其余创建后补建（与前端 planCreate 一致）
  update: { issuelinks: [{ add: { type: { name: 'Blocks' }, outwardIssue: { key: PARENT } } }] },
});
const key = created.body?.key;
if (!check('新建其他任务（随创建挂父需求）', created.status === 201, key ?? JSON.stringify(created.body).slice(0, 300))) process.exit(1);

if (!process.env.REUSE) {
  const rel = await call('POST', '/api/jira/issueLink', { type: { name: 'Relates' }, inwardIssue: { key }, outwardIssue: { key: RELATE } });
  check('创建后补建 Relates', rel.status === 201 || rel.status === 200, String(rel.status));
}

// 4. 附件上传（文本 + 一张 1x1 PNG）
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const fd = new FormData();
fd.append('file', new Blob([png], { type: 'image/png' }), '截图_smoke.png');
fd.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'evil.html');
const up = await call('POST', `/api/jira/issue/${key}/attachments`, null, fd);
check('上传 2 个附件', up.status === 200 && up.body.length === 2, up.status !== 200 ? JSON.stringify(up.body).slice(0, 200) : '');

// 5. 校验链接方向和附件
const iss = await call('GET', `/api/jira/issue/${key}?fields=issuelinks,attachment`);
const links = iss.body.fields.issuelinks;
check('父需求方向正确（子项 blocks 需求）', links.some((l) => l.type.name === 'Blocks' && l.outwardIssue?.key === PARENT));
check('Relates 已建立', links.some((l) => l.type.name === 'Relates' && (l.outwardIssue?.key === RELATE || l.inwardIssue?.key === RELATE)));
const parent = await call('GET', `/api/jira/issue/${PARENT}?fields=issuelinks`);
check('父需求上可见该子项', parent.body.fields.issuelinks.some((l) => l.type.name === 'Blocks' && l.inwardIssue?.key === key));

const atts = iss.body.fields.attachment;
const img = atts.find((a) => a.mimeType === 'image/png');
const html = atts.find((a) => a.filename === 'evil.html');
const fileOf = (u) => u.match(/\/secure\/(attachment|thumbnail)\/(\d+)\/([^/?#]+)/).slice(1).join('/');
if (img) {
  const r = await call('GET', `/api/file/${fileOf(img.content)}`);
  check('图片附件经代理读取并内联显示', r.status === 200 && r.headers.get('content-type') === 'image/png' && r.headers.get('content-disposition').startsWith('inline'));
}
if (html) {
  const r = await call('GET', `/api/file/${fileOf(html.content)}`);
  check('HTML 附件强制下载（不在本站执行）', r.status === 200 && r.headers.get('content-type') === 'application/octet-stream' && r.headers.get('content-disposition').startsWith('attachment'));
}
check('非法文件路径被拒绝', (await call('GET', '/api/file/attachment/1/../../etc')).status === 403);

// 6. 后续再建一条关联（详情页「添加关联」路径）
const l2 = await call('POST', '/api/jira/issueLink', { type: { name: 'Relates' }, inwardIssue: { key }, outwardIssue: { key: `${P}-6` } });
check('详情页添加关联', l2.status === 201 || l2.status === 200, String(l2.status));

// 7. 工时查询（只读，跨项目）：开发完成日期在近 90 天
const fields = (await call('GET', '/api/jira/field')).body;
const done = fields.filter((f) => f.custom && f.name === '开发完成日期').map((f) => `cf[${f.id.slice(12)}]`);
const jql = `cf[10204] = currentUser() AND (${done.map((c) => `${c} >= -90d`).join(' OR ')})`;
const s = await call('GET', `/api/jira/search?jql=${encodeURIComponent(jql)}&maxResults=0`);
check('工时 JQL 可执行', s.status === 200, `近 90 天开发完成 ${s.body?.total} 条`);

console.log(`\n${results.filter(Boolean).length}/${results.length} 通过；新建 ${key}`);
process.exit(results.every(Boolean) ? 0 : 1);
