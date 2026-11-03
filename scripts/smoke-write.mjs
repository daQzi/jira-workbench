// 写路径冒烟测试：只在 WB_WRITE_PROJECTS 限定的测试项目里建数据，标题带 [测试] 前缀。
//   代理需以 WB_ALLOW_WRITE=1 WB_WRITE_PROJECTS=AGENT 启动
//   JIRA_USER=xxx JIRA_PASS=xxx TEST_PROJECT=AGENT npm run smoke:write
// 本账号无删除权限，测试数据会保留，可在 Jira 里按 summary ~ "[测试]" 查到。
const BASE = process.env.WB_URL || 'http://127.0.0.1:8787';
const { JIRA_USER, JIRA_PASS } = process.env;
const P = process.env.TEST_PROJECT || 'AGENT';
const GUARD = process.env.GUARD_PROJECT || 'YLZHXT';
if (!JIRA_USER || !JIRA_PASS) {
  console.error('请设置 JIRA_USER / JIRA_PASS');
  process.exit(2);
}
let cookie = '';
async function call(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const t = await res.text();
  let d = null;
  try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  return { status: res.status, body: d };
}
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  return ok;
};
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

await call('POST', '/api/login', { username: JIRA_USER, password: JIRA_PASS });
const me = await call('GET', '/api/me');
if (!check('写开关与范围', me.body?.allowWrite && me.body.writeProjects.includes(P), JSON.stringify(me.body?.writeProjects))) process.exit(1);

// 1. 范围外写入被代理拦截（不会到达 Jira）
const guard = await call('POST', '/api/jira/issue', { fields: { project: { key: GUARD }, issuetype: { name: '需求' }, summary: '[测试] 不应创建' } });
check(`${GUARD} 写入被拦截`, guard.status === 403, guard.body?.errorMessages?.[0]);
const guard2 = await call('PUT', `/api/jira/issue/${GUARD}-1`, { fields: { summary: 'x' } });
check(`${GUARD} 编辑被拦截`, guard2.status === 403);
const del = await call('DELETE', `/api/jira/issue/${P}-1`);
check('删除接口不可用', del.status === 403);

// 2. 新建需求 + 带父链接新建子任务（与前端 planCreate 相同的请求结构）
const story = await call('POST', '/api/jira/issue', {
  fields: { project: { key: P }, issuetype: { name: '需求' }, summary: `[测试] 冒烟-父需求 ${stamp}`, assignee: { name: JIRA_USER } },
});
check('新建需求', story.status === 201, story.body?.key);
const task = await call('POST', '/api/jira/issue', {
  fields: { project: { key: P }, issuetype: { name: '编码任务' }, summary: `[测试] 冒烟-子任务 ${stamp}`, assignee: { name: JIRA_USER } },
  update: { issuelinks: [{ add: { type: { name: 'Blocks' }, outwardIssue: { key: story.body?.key } } }] },
});
check('新建子任务（带父链接）', task.status === 201, task.body?.key);
const bug = await call('POST', '/api/jira/issue', {
  fields: { project: { key: P }, issuetype: { name: 'BUG及数据问题' }, summary: `[测试] 冒烟-缺陷 ${stamp}` },
});
check('新建缺陷', bug.status === 201, bug.body?.key);
const link = await call('POST', '/api/jira/issueLink', { type: { name: 'Blocks' }, inwardIssue: { key: bug.body?.key }, outwardIssue: { key: story.body?.key } });
check('已有问题挂为子项', link.status === 201);

// 3. 父子关系从需求侧可见（与 tree.ts 的识别规则一致）
const s = await call('GET', `/api/jira/issue/${story.body?.key}?fields=issuelinks`);
const kids = (s.body?.fields?.issuelinks ?? []).filter((l) => l.type.name === 'Blocks' && l.inwardIssue).map((l) => l.inwardIssue.key);
check('需求下识别到 2 个子项', kids.includes(task.body?.key) && kids.includes(bug.body?.key), kids.join(','));

// 4. 流转（含必填字段）
const tr = await call('GET', `/api/jira/issue/${task.body?.key}/transitions?expand=transitions.fields`);
const toDev = tr.body?.transitions?.find((t) => t.to.name === '开发中');
check('获取可用流转', !!toDev, tr.body?.transitions?.map((t) => t.to.name).join(','));
const today = new Date().toISOString().slice(0, 10);
const doTr = await call('POST', `/api/jira/issue/${task.body?.key}/transitions`, {
  transition: { id: toDev?.id },
  fields: { customfield_10218: '1d', customfield_10215: today },
});
check('流转到 开发中（带字段）', doTr.status === 204, doTr.status !== 204 ? JSON.stringify(doTr.body) : '');
const after = await call('GET', `/api/jira/issue/${task.body?.key}?fields=status,customfield_10215`);
check('状态已更新', after.body?.fields?.status?.name === '开发中', `${after.body?.fields?.status?.name} 开始开发日期=${after.body?.fields?.customfield_10215}`);

// 5. 改经办人 + 评论
const ed = await call('PUT', `/api/jira/issue/${bug.body?.key}`, { fields: { assignee: { name: JIRA_USER } } });
check('修改经办人', ed.status === 204);
const cm = await call('POST', `/api/jira/issue/${task.body?.key}/comment`, { body: '冒烟测试评论' });
check('添加评论', cm.status === 201);

await call('POST', '/api/logout');
console.log(`\n本次测试数据：${[story.body?.key, task.body?.key, bug.body?.key].filter(Boolean).join(' ')}`);
process.exit(results.every(Boolean) ? 0 : 1);
