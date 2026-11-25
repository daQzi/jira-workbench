// node --test stack/stack.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { defaultConfig, loadConfig, normalizeConfig, saveConfig } from './config.mjs';
import { StackProxy, isStaticAsset, isWebpackChunk, matchPrefix, stripPrefix } from './proxy.mjs';
import { cleanLine } from './logger.mjs';

describe('配置归一化', () => {
  it('归一化前缀、去重、保留未知字段以外的东西', () => {
    const c = normalizeConfig({
      currentEnv: 'nope',
      envs: [
        { id: 'a', target: 'http://h:1/', apiPrefix: 'saas-industry' },
        { id: 'a', target: 'http://h:2', apiPrefix: '/' },
        { id: '', target: 'http://x' },
        { id: 'bad', target: 'not-a-url' },
      ],
      services: [{ id: 's', dir: 'd', port: 1234 }, { dir: '', port: 1 }],
    });
    assert.equal(c.envs.length, 1, '同 id 去重，非法目标被丢弃');
    assert.equal(c.envs[0].target, 'http://h:2');
    assert.equal(c.envs[0].apiPrefix, '', '/ 归一化为空前缀');
    assert.equal(c.currentEnv, 'a', 'currentEnv 不存在时回落到第一个环境');
    assert.equal(c.services.length, 1);
    assert.equal(c.services[0].mode, 'auto');
  });

  it('保存后能原样读回', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wb-stack-cfg-'));
    const file = path.join(dir, 'stack.json');
    const cfg = defaultConfig();
    cfg.currentEnv = cfg.envs[2].id;
    cfg.services[0].autoStart = false;
    saveConfig(cfg, file);
    const back = loadConfig(file).config;
    assert.equal(back.currentEnv, cfg.currentEnv);
    assert.equal(back.services[0].autoStart, false);
    assert.equal(back.envs.length, cfg.envs.length);
  });

  it('坏配置明确报错而不是静默重置', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wb-stack-bad-'));
    const file = path.join(dir, 'stack.json');
    writeFileSync(file, '{ oops');
    assert.throws(() => loadConfig(file), /配置文件格式错误/);
  });
});

describe('规则匹配', () => {
  it('前缀最长优先', () => {
    const list = [{ prefix: '/a', target: '1' }, { prefix: '/a/b', target: '2' }];
    assert.equal(matchPrefix(list, '/a/b/c')?.target, '2');
    assert.equal(matchPrefix(list, '/a/x')?.target, '1');
    assert.equal(matchPrefix(list, '/zzz'), null);
  });

  it('去前缀只在整段匹配时生效', () => {
    assert.equal(stripPrefix('/saas-industry/x', '/saas-industry'), '/x');
    assert.equal(stripPrefix('/saas-industry', '/saas-industry'), '/');
    assert.equal(stripPrefix('/saas-industryX', '/saas-industry'), '/saas-industryX');
    assert.equal(stripPrefix('/x', ''), '/x');
  });

  it('静态资源与 chunk 识别', () => {
    assert.ok(isStaticAsset('/a/b.js'));
    assert.ok(isStaticAsset('/a/b.woff2'));
    assert.ok(!isStaticAsset('/api/query'));
    assert.ok(isWebpackChunk('/vendors-1a2b.js'));
    assert.ok(isWebpackChunk('/src_views_x.css'));
    assert.ok(!isWebpackChunk('/static/external/x.js'));
  });

  it('日志清洗 ANSI 与分块残留', () => {
    const out = cleanLine('\u001b[32m✔ done\u001b[0m\r\n[24;1Hnext\u001b[?25l');
    assert.deepEqual(out, ['✔ done', 'next']);
  });
});

describe('代理转发', () => {
  let upstream;
  let seen = [];
  let fallback;
  let fallbackSeen = [];
  before(async () => {
    upstream = http.createServer((req, res) => {
      seen.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: req.url }));
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    // 只提供部分资源，用来验证「运营 404 → 回落当前环境」
    fallback = http.createServer((req, res) => {
      fallbackSeen.push(req.url);
      if (req.url.includes('missing')) {
        res.writeHead(404);
        return res.end('nope');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: req.url }));
    });
    await new Promise((r) => fallback.listen(0, '127.0.0.1', r));
  });
  after(() => {
    upstream.close();
    upstream.closeAllConnections?.();
    fallback.close();
    fallback.closeAllConnections?.();
  });

  const upstreamUrl = () => `http://127.0.0.1:${upstream.address().port}`;

  async function withProxy(cfg, run) {
    const proxy = new StackProxy({ getConfig: () => cfg, getService: () => null });
    cfg.proxy.port = 0;
    await proxy.start();
    const port = proxy.server.address().port;
    try {
      return await run({ port, proxy });
    } finally {
      await proxy.stop();
    }
  }

  const baseCfg = () => {
    const cfg = defaultConfig();
    cfg.envs = [{ id: 'e', label: 'e', target: upstreamUrl(), apiPrefix: '/saas-industry', port: 0, loginPath: 'login', account: '' }];
    cfg.currentEnv = 'e';
    cfg.services = [];
    cfg.localApis = [];
    cfg.mocks = [];
    cfg.staticFiles = [];
    return cfg;
  };

  it('兜底转发保留环境前缀（站点自身挂在 /saas-industry 下）', async () => {
    seen = [];
    await withProxy(baseCfg(), async ({ port }) => {
      const r = await fetch(`http://127.0.0.1:${port}/saas-industry/api/user/list?page=1`);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { url: '/saas-industry/api/user/list?page=1' });
    });
  });

  it('Mock 精确命中直接返回，不打上游', async () => {
    seen = [];
    const cfg = baseCfg();
    cfg.mocks = [{ path: '/saas-industry/tax/user', body: { ok: 1 } }];
    await withProxy(cfg, async ({ port }) => {
      const r = await fetch(`http://127.0.0.1:${port}/saas-industry/tax/user`);
      assert.deepEqual(await r.json(), { ok: 1 });
      assert.equal(seen.length, 0);
    });
  });

  it('本地接口映射最长前缀优先', async () => {
    seen = [];
    const cfg = baseCfg();
    cfg.localApis = [
      { prefix: '/saas-industry/smart', target: upstreamUrl() },
      { prefix: '/saas-industry/smart/voucher', target: upstreamUrl() },
    ];
    await withProxy(cfg, async ({ port }) => {
      await fetch(`http://127.0.0.1:${port}/saas-industry/smart/voucher/x`);
      assert.equal(seen[0], '/smart/voucher/x', '转发前去掉环境前缀');
    });
  });

  it('停用的规则不参与匹配，回落环境', async () => {
    seen = [];
    const cfg = baseCfg();
    cfg.localApis = [{ prefix: '/saas-industry/smart', target: upstreamUrl(), enabled: false }];
    cfg.mocks = [{ path: '/saas-industry/mock/off', body: { ok: 0 }, enabled: false }];
    await withProxy(cfg, async ({ port }) => {
      const r = await fetch(`http://127.0.0.1:${port}/saas-industry/smart/x`);
      assert.equal(r.status, 200);
      assert.equal(seen[0], '/saas-industry/smart/x', '停用后走环境兜底，保留完整路径');
      const m = await fetch(`http://127.0.0.1:${port}/saas-industry/mock/off`);
      assert.deepEqual(await m.json(), { url: '/saas-industry/mock/off' }, '停用的 mock 不返回固定 JSON');
    });
  });

  it('规则默认视为启用，显式 false 才停用', async () => {
    const c = normalizeConfig({
      localApis: [
        { prefix: '/a', target: 'http://h:1' },
        { prefix: '/b', target: 'http://h:2', enabled: false },
      ],
      mocks: [{ path: '/m', body: {} }],
      staticFiles: [{ path: '/s.js', file: 'C:/s.js' }],
    });
    assert.deepEqual(c.localApis.map((x) => x.enabled), [true, false]);
    assert.equal(c.mocks[0].enabled, true);
    assert.equal(c.staticFiles[0].enabled, true);
  });

  it('服务未运行：静态资源回落环境且保留前缀，不白屏不 404', async () => {
    seen = [];
    const cfg = baseCfg();
    cfg.services = [{ id: 's', name: 's', dir: 'x', port: 1, route: '/certificate', enabled: true, autoStart: false, script: 'serve', args: [], mode: 'auto', env: {} }];
    await withProxy(cfg, async ({ port }) => {
      const r = await fetch(`http://127.0.0.1:${port}/saas-industry/certificate/index.js`);
      assert.equal(r.status, 200);
      assert.equal(seen[0], '/saas-industry/certificate/index.js');
    });
  });

  // 回归：带 API 前缀的 /static 请求曾被误判为「根 /static」，转到本地 8888 后 404，整页白屏
  it('带环境前缀的 /static 不转本地，走环境', async () => {
    seen = [];
    const cfg = baseCfg();
    const services = new Map([['s', { id: 's', name: 's', state: 'running', port: 1 }]]);
    cfg.services = [{ id: 's', name: 's', dir: 'x', port: 1, route: '/certificate', enabled: true, autoStart: false, script: 'serve', args: [], mode: 'auto', env: {} }];
    const proxy = new StackProxy({ getConfig: () => cfg, getService: (id) => services.get(id) });
    cfg.proxy.port = 0;
    cfg.proxy.host = '127.0.0.1';
    await proxy.start();
    const port = proxy.server.address().port;
    try {
      await fetch(`http://127.0.0.1:${port}/saas-industry/static/js/index.abc.js`);
      assert.equal(seen[0], '/saas-industry/static/js/index.abc.js', '应原样转给环境');
    } finally {
      await proxy.stop();
    }
  });

  // 回归：yy 环境缺字体库，/static/external 的静态资源 404 时要回落当前环境
  it('external 静态在 yy 上 404 时回落当前环境', async () => {
    seen = [];
    fallbackSeen = [];
    const cfg = baseCfg();
    cfg.envs = [
      { id: 'e', label: 'e', target: upstreamUrl(), apiPrefix: '/saas-industry', port: 0, loginPath: 'login', account: '' },
      { id: 'yy', label: 'yy', target: `http://127.0.0.1:${fallback.address().port}`, apiPrefix: '', port: 0, loginPath: 'login', account: '' },
    ];
    cfg.currentEnv = 'e';
    await withProxy(cfg, async ({ port }) => {
      const r = await fetch(`http://127.0.0.1:${port}/saas-industry/static/external/font/missing.css`);
      assert.equal(r.status, 200, 'yy 404 后应回落环境并成功');
      assert.equal(fallbackSeen[0], '/static/external/font/missing.css', 'yy 只认不带前缀的路径');
      assert.equal(seen[0], '/saas-industry/static/external/font/missing.css');
    });
  });

  it('external 静态在 yy 上存在时直接用 yy', async () => {
    seen = [];
    fallbackSeen = [];
    const cfg = baseCfg();
    cfg.envs = [
      { id: 'e', label: 'e', target: upstreamUrl(), apiPrefix: '/saas-industry', port: 0, loginPath: 'login', account: '' },
      { id: 'yy', label: 'yy', target: `http://127.0.0.1:${fallback.address().port}`, apiPrefix: '', port: 0, loginPath: 'login', account: '' },
    ];
    cfg.currentEnv = 'e';
    await withProxy(cfg, async ({ port }) => {
      await fetch(`http://127.0.0.1:${port}/saas-industry/static/external/formily/core.js`);
      assert.deepEqual(fallbackSeen, ['/static/external/formily/core.js']);
      assert.equal(seen.length, 0, '不需要回落到环境');
    });
  });
});
