// 冒烟测试（只读）：需先启动代理，凭据通过环境变量传入，不落盘
//   JIRA_USER=xxx JIRA_PASS=xxx npm run smoke
const BASE = process.env.WB_URL || 'http://127.0.0.1:8787';
const { JIRA_USER, JIRA_PASS } = process.env;
if (!JIRA_USER || !JIRA_PASS) {
  console.error('请设置 JIRA_USER / JIRA_PASS 环境变量');
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
  return { status: res.status, body: await res.json().catch(() => null) };
}
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

check('未登录访问被拒', (await call('GET', '/api/jira/project')).status === 401);
const login = await call('POST', '/api/login', { username: JIRA_USER, password: JIRA_PASS });
check('登录', login.status === 200);
const me = await call('GET', '/api/me');
check('当前用户', me.status === 200 && me.body?.name === JIRA_USER);
const projects = await call('GET', '/api/jira/project');
check('项目列表', projects.status === 200 && Array.isArray(projects.body), `${projects.body?.length} 个`);
const jql = encodeURIComponent('project = YLZHXT AND issuetype = 需求 ORDER BY updated DESC');
const search = await call('GET', `/api/jira/search?jql=${jql}&maxResults=5&fields=summary,issuelinks`);
check('需求搜索', search.status === 200 && typeof search.body?.total === 'number', `total=${search.body?.total}`);
check('路径白名单', (await call('GET', '/api/jira/../auth/1/session')).status !== 200);
check('只读阶段拒绝写', (await call('POST', '/api/jira/issue/AGENT-1/comment', {})).status === 405);
await call('POST', '/api/logout');
check('登出后失效', (await call('GET', '/api/me')).status === 401);
process.exit(checks.every(Boolean) ? 0 : 1);
