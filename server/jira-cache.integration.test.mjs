import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, stopServer } from './index.mjs';
const dir = mkdtempSync(path.join(os.tmpdir(), 'wb-cache-test-'));
const hits = new Map(); let url, cookie, token, active = 0, peak = 0, value = 'old', releaseHeld, startedHeld;
const mock = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://local'), key = u.pathname + u.search;
  hits.set(key, (hits.get(key) || 0) + 1);
  const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (u.pathname === '/rest/auth/1/session') { res.setHeader('Set-Cookie', 'JSESSIONID=fake'); return json({ name: 'alice' }); }
  if (u.pathname === '/rest/api/2/issue/AA-1/comment') return json({ id: '1' }, 201);
  if (u.pathname.startsWith('/rest/api/2/project')) return json([{ key: 'AA' }]);
  active++; peak = Math.max(peak, active); const captured = value;
  const done = () => { active--; };
  res.once('close', done);
  if (u.searchParams.get('held') === '1') { startedHeld?.(); await new Promise(resolve => { releaseHeld = resolve; }); }
  if (u.searchParams.get('error') === '1') return json({ errorMessages: ['temporarily unavailable'] }, 503);
  res.writeHead(200, { 'content-type': 'application/json' });
  // 响应头先到，主体稍后结束；并发上限应覆盖主体读取。
  res.write('{"value":');
  await new Promise(resolve => setTimeout(resolve, 30));
  res.end(JSON.stringify(captured) + ',"issues":[],"total":0}');
});
const headers = extra => ({ Cookie: cookie, ...extra });
const search = (jql, extras = {}) => '/api/jira/search?' + new URLSearchParams({ jql, ...extras });
const fetchRead = (sub, extra) => fetch(url + sub, { headers: headers(extra) });
beforeAll(async () => {
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  ({ url } = await startServer({ jiraBaseUrl: `http://127.0.0.1:${mock.address().port}`, port: 0, allowWrite: true, settingsFile: path.join(dir, 'settings.json') }));
  const login = await fetch(url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'fake' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const manage = (sub, body) => fetch(url + sub, { method: 'PUT', headers: headers({ 'Content-Type': 'application/json', Origin: url }), body: JSON.stringify(body) });
  expect((await manage('/api/mcp/settings', { enabled: true, policies: [] })).ok).toBe(true);
  const grant = await fetch(url + '/api/mcp/grants', { method: 'POST', headers: headers({ 'Content-Type': 'application/json', Origin: url }), body: JSON.stringify({ name: 'cache-test', projects: ['AA'], access: 'read', attachmentRoots: [] }) });
  token = (await grant.json()).token;
});
afterAll(async () => { releaseHeld?.(); await stopServer(); await new Promise(resolve => mock.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
it('HTTP慢请求只查询一次并直接等待，成功结果可复用和强制刷新', async () => {
  const sub = search('project = "AA"', { test: 'merge' });
  const responses = await Promise.all(Array.from({ length: 4 }, () => fetchRead(sub)));
  expect(responses.every(r => r.status === 200)).toBe(true);
  await Promise.all(responses.map(r => r.json()));
  expect(hits.get(sub.replace('/api/jira', '/rest/api/2'))).toBe(1);
  await fetchRead(sub); expect(hits.get(sub.replace('/api/jira', '/rest/api/2'))).toBe(1);
  await fetchRead(sub, { 'X-WB-Refresh': '1' }); expect(hits.get(sub.replace('/api/jira', '/rest/api/2'))).toBe(2);
});
it('Jira失败响应不缓存；不同登录会话不共享结果', async () => {
  const sub = search('project = "AA"', { error: '1' });
  expect((await fetchRead(sub)).status).toBe(503); expect((await fetchRead(sub)).status).toBe(503);
  expect(hits.get(sub.replace('/api/jira', '/rest/api/2'))).toBe(2);
  const login = await fetch(url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'fake' }) });
  const second = login.headers.get('set-cookie').split(';')[0];
  const isolated = search('project = "AA"', { test: 'isolation' });
  await fetchRead(isolated); await fetch(url + isolated, { headers: { Cookie: second } });
  expect(hits.get(isolated.replace('/api/jira', '/rest/api/2'))).toBe(2);
});
it('HTTP与MCP共用上限，并且相同身份的查询共用缓存', async () => {
  const c = new Client({ name: 'cache-test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  try {
    const sub = search('project = "AA" ORDER BY updated DESC', { startAt: '0', maxResults: '30', fields: 'summary,status,issuetype,project,assignee,updated' });
    const responses = await Promise.all([fetchRead(sub), c.callTool({ name: 'jira_search_issues', arguments: { projectKey: 'AA' } }), ...Array.from({ length: 5 }, (_, i) => fetchRead(search('project = "AA"', { test: `peak-${i}` }), { 'X-WB-Priority': 'background' }))]);
    expect(responses[0].status).toBe(200); expect(responses[1].isError).not.toBe(true);
    expect(hits.get(sub.replace('/api/jira', '/rest/api/2'))).toBe(1);
    expect(peak).toBeLessThanOrEqual(2);
  } finally { await c.close(); }
});
it('写后仅相关项目失效，旧读取不能晚到覆盖新数据，元数据继续复用', async () => {
  const aa = search('project = "AA"'), bb = search('project = "BB"');
  await fetchRead(bb); await fetchRead('/api/jira/project');
  const beforeBB = (await (await fetch(url + '/api/cache/status?project=BB', { headers: headers() })).json()).revision;
  const gate = new Promise(resolve => { startedHeld = resolve; });
  const old = fetchRead(search('project = "AA"', { held: '1' })); await gate;
  value = 'new';
  const write = await fetch(url + '/api/jira/issue/AA-1/comment', { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ body: 'test' }) });
  expect(write.status).toBe(201); releaseHeld(); expect((await old).status).toBe(409);
  expect((await (await fetchRead(aa)).json()).value).toBe('new');
  await fetchRead(bb); await fetchRead('/api/jira/project');
  expect(hits.get(bb.replace('/api/jira', '/rest/api/2'))).toBe(1);
  expect(hits.get('/rest/api/2/project')).toBe(1);
  expect((await (await fetch(url + '/api/cache/status?project=BB', { headers: headers() })).json()).revision).toBe(beforeBB);
});
