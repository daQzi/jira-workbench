// 联调栈控制台：无框架，直接操作 DOM；通过 /api/stack/* 与 SSE 实时同步。
const API = '/api/stack';
const STATE_TEXT = {
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  error: '异常',
  external: '端口占用',
};

const state = {
  status: null,
  tab: 'all', // all | 代理 | 服务 id
  expanded: new Set(),
  busy: new Set(),
  editing: null,
  toasts: [],
  sse: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    // 只接受 Node / 字符串 / 数字；undefined、null、false、true 都跳过（防止把返回值当文本渲染）
    if (c === null || c === undefined || c === false || c === true) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
};

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `请求失败（HTTP ${res.status}）`);
  return data;
}

function toast(msg, kind = 'ok') {
  const id = Math.random().toString(36).slice(2);
  state.toasts.push({ id, msg, kind });
  renderToasts();
  setTimeout(() => {
    state.toasts = state.toasts.filter((t) => t.id !== id);
    renderToasts();
  }, kind === 'error' ? 5200 : 2200);
}

function renderToasts() {
  let box = $('.toasts');
  if (!box) document.body.append((box = el('div', { class: 'toasts' })));
  box.replaceChildren(...state.toasts.map((t) => el('div', { class: `toast ${t.kind}` }, t.msg)));
}

async function act(key, run, okMsg) {
  if (state.busy.has(key)) return;
  state.busy.add(key);
  render();
  try {
    const next = await run();
    // 服务端多数接口直接返回 status 本体（没有 status 字段），两种形态都要认，
    // 否则保存后界面要等 SSE / 手动刷新才更新
    const state_ = next?.status ?? (next && Array.isArray(next.services) && next.proxy ? next : null);
    if (state_) applyStatus(state_);
    if (okMsg) toast(okMsg);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.busy.delete(key);
    render();
  }
}

const busy = (key) => state.busy.has(key);

function openDialog(next) {
  state.editing = next;
  render();
}

function closeDialog() {
  state.editing = null;
  render();
}

// ---------- 时间 ----------
const clock = (ts) => {
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
};
const relTime = (ts) => {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
};

// ---------- 数据 ----------
function applyStatus(status) {
  state.status = status;
  if (state.tab !== 'all' && state.tab !== 'proxy' && !status.services.some((s) => s.id === state.tab)) state.tab = 'all';
}

async function refresh() {
  try {
    applyStatus(await api('GET', '/status'));
    document.getElementById('app')?.removeAttribute('aria-busy');
    render();
  } catch (e) {
    document.getElementById('app').innerHTML = `<div class="boot">无法连接联调栈：${e.message}</div>`;
  }
}

function connectEvents() {
  if (state.sse) state.sse.close();
  const sse = new EventSource(`${API}/events`);
  state.sse = sse;
  sse.addEventListener('status', (ev) => {
    try {
      applyStatus(JSON.parse(ev.data));
      // 弹窗里正在输入时不要重建 DOM，否则焦点丢失
      if (!state.editing) render();
    } catch {
      /* ignore */
    }
  });
  sse.addEventListener('log', (ev) => {
    try {
      const row = JSON.parse(ev.data);
      if (!state.status) return;
      state.status.logs = [...(state.status.logs || []), { at: row.at, id: row.id, line: row.line }].slice(-400);
      appendLogRow(row);
    } catch {
      /* ignore */
    }
  });
  sse.onerror = () => {
    sse.close();
    setTimeout(connectEvents, 2000);
  };
}

// ---------- 渲染 ----------
function render() {
  const root = document.getElementById('app');
  if (!root || !state.status) return;
  const st = state.status;
  const scrollTop = $('.stack-scroll')?.scrollTop ?? 0;
  const logBox = $('.log-panel');
  const logBottom = logBox ? logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 40 : true;

  root.className = 'stack-app';
  // 日志栏必须是 .stack-main 的第二列，放到 root 下会变成第三行（右侧留空、日志挤在底部）
  // 注意：replaceChildren(null) 会插入字符串 "null"，必须先过滤
  root.replaceChildren(...[renderTop(st), renderMain(st), state.editing ? renderDialog() : null].filter(Boolean));

  const scroll = $('.stack-scroll');
  if (scroll) scroll.scrollTop = scrollTop;
  const box = $('.log-panel');
  if (box) {
    box.scrollTop = logBottom ? box.scrollHeight : box.scrollTop;
  }
}

function renderTop(st) {
  const running = st.proxy.running;
  const env = st.env;
  return el(
    'header',
    { class: 'stack-top' },
    el('h1', {}, '联调栈', el('small', {}, `${env ? env.label : '未选择环境'} · ${env ? env.target : ''}`)),
    el('span', { class: 'grow' }),
    el(
      'div',
      { class: 'top-actions' },
      el(
        'label',
        { class: 'switch', title: '工作台启动/退出时，自动拉起/清理代理' },
        el('input', {
          type: 'checkbox',
          checked: st.settings.autoStartOnLaunch,
          onChange: (e) => act('auto', () => api('PUT', '/settings', { proxy: { autoStartOnLaunch: e.target.checked } }), '启动策略已保存'),
        }),
        '随工作台启停',
      ),
      el(
        'label',
        { class: 'switch', title: '代理启动时，自动拉起勾选了「随代理启动」的前端服务' },
        el('input', {
          type: 'checkbox',
          checked: st.settings.autoStartServices,
          onChange: (e) => act('auto2', () => api('PUT', '/settings', { proxy: { autoStartServices: e.target.checked } }), '服务策略已保存'),
        }),
        '自动拉起服务',
      ),
      running
        ? el('button', { class: 'btn', disabled: busy('proxy') || undefined, onClick: () => act('proxy', () => api('POST', '/proxy/stop'), '代理已停止') }, '■ 停止代理')
        : el('button', { class: 'btn primary', disabled: busy('proxy') || undefined, onClick: () => act('proxy', () => api('POST', '/proxy/start'), '代理已启动') }, '▶ 启动代理'),
      running
        ? el('button', { class: 'btn', disabled: busy('proxy2') || undefined, onClick: () => act('proxy2', () => api('POST', '/proxy/restart'), '代理已重启') }, '↻ 重启')
        : null,
    ),
  );
}

function renderMain(st) {
  return el(
    'main',
    { class: 'stack-main' },
    el('div', { class: 'stack-scroll' }, renderProxy(st), renderEnvs(st), renderServices(st), renderConfig(st)),
    renderSide(st),
  );
}

function renderProxy(st) {
  const p = st.proxy;
  return el(
    'section',
    { class: `card proxy-card${p.running ? ' is-running' : ''}` },
    el(
      'div',
      { class: 'card-head' },
      el('span', { class: `dot ${p.running ? 'running' : 'stopped'}` }),
      el('h2', {}, '反向代理'),
      el('span', { class: `state-label ${p.running ? 'running' : 'stopped'}` }, p.running ? `已监听 ${p.port}` : '未启动'),
      el('span', { class: 'grow' }),
      el('span', { class: 'hint' }, p.running ? `已处理 ${p.requestCount} 个请求 · 运行 ${relTime(p.startedAt)}` : '启动后可直接访问环境站点'),
    ),
    el(
      'div',
      { class: 'card-body' },
      el(
        'div',
        { class: 'proxy-row' },
        el(
          'div',
          { class: 'url-box' },
          el('code', { title: p.urls.local || '' }, p.urls.local || '（启动后显示访问地址）'),
          el('button', { class: 'btn small', disabled: !p.urls.local || undefined, onClick: () => copy(p.urls.local) }, '复制'),
          el('button', { class: 'btn small ghost', disabled: !p.urls.local || undefined, onClick: () => window.open(p.urls.local, '_blank') }, '打开'),
        ),
      ),
      st.lanAddress && p.urls.lan
        ? el('div', { class: 'url-box', style: 'margin-top:8px' }, el('code', { title: p.urls.lan }, p.urls.lan), el('button', { class: 'btn small', onClick: () => copy(p.urls.lan) }, '复制内网'))
        : null,
      el(
        'div',
        { class: 'facts' },
        el('span', {}, '环境', el('b', {}, st.env?.label || '未选择')),
        el('span', {}, '目标', el('b', {}, st.env?.target || '-')),
        el('span', {}, 'API 前缀', el('b', {}, st.env?.apiPrefix || '（无）')),
        el('span', {}, '账号', el('b', {}, st.env?.account || '—')),
        el('span', {}, '监听', el('b', {}, `${p.host}:${p.port}`)),
      ),
    ),
  );
}

function renderEnvs(st) {
  return el(
    'section',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el('h2', {}, '环境'),
      el('span', { class: 'hint' }, '点击即切换，代理无需重启'),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn small', onClick: () => openDialog({ kind: 'envs' }) }, '编辑环境'),
    ),
    el(
      'div',
      { class: 'card-body' },
      el(
        'div',
        { class: 'env-grid' },
        ...st.envs.map((env) =>
          el(
            'button',
            {
              class: 'env-item',
              'aria-pressed': st.env?.id === env.id ? 'true' : 'false',
              disabled: busy(`env:${env.id}`) || undefined,
              onClick: () =>
                act(
                  `env:${env.id}`,
                  () => api('PUT', '/env', { id: env.id }),
                  `已切换到 ${env.label}`,
                ),
            },
            el('strong', {}, env.label),
            el('span', { title: env.target }, env.target.replace(/^https?:\/\//, '')),
            el('span', { class: 'tag' }, env.apiPrefix || '无前缀'),
          ),
        ),
      ),
    ),
  );
}

function renderServices(st) {
  const runningCount = st.services.filter((s) => s.state === 'running').length;
  return el(
    'section',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el('h2', {}, '本地前端服务'),
      el('span', { class: `state-label ${runningCount ? 'running' : 'stopped'}` }, `${runningCount} / ${st.services.length} 运行中`),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn small primary', onClick: () => openDialog({ kind: 'service', data: blankService(st) }) }, '＋ 新增服务'),
    ),
    el(
      'div',
      { class: 'card-body' },
      st.services.length
        ? el('div', { class: 'svc-list' }, ...st.services.map((s) => renderService(s)))
        : el('p', { class: 'muted' }, '还没有服务，点右上角「新增服务」。'),
      el(
        'p',
        { class: 'hint', style: 'margin:10px 0 0' },
        `服务根目录：${st.servicesRoot || '（未设置，按绝对路径）'} · 配置：${st.configPath}`,
      ),
    ),
  );
}

function renderService(s) {
  const expanded = state.expanded.has(s.id);
  const busyKey = `svc:${s.id}`;
  const starting = s.state === 'starting';
  const toggle = () => {
    if (expanded) state.expanded.delete(s.id);
    else state.expanded.add(s.id);
    render();
  };
  return el(
    'div',
    { class: `svc state-${s.state} ${s.state === 'stopping' ? 'stopping' : ''} ${starting ? 'starting' : ''}` },
    el(
      'div',
      { class: 'svc-head' },
      starting ? el('span', { class: 'spinner' }) : el('span', { class: `dot ${s.state}` }),
      el(
        'div',
        { class: 'svc-title' },
        el('strong', {}, s.name),
        el('span', { class: 'port' }, String(s.port)),
        el('span', { class: 'dir', title: `${s.absDir}` }, s.dir),
        el('span', { class: `state-label ${s.state}` }, STATE_TEXT[s.state] || s.state),
        starting ? el('span', { class: 'pulse-text' }, '正在启动') : null,
        s.state === 'running' && s.readyAt ? el('span', { class: 'hint' }, `就绪于 ${clock(s.readyAt)}`) : null,
        s.state === 'external' ? el('span', { class: 'hint' }, '非工作台启动') : null,
      ),
      el(
        'div',
        { class: 'svc-actions' },
        s.state === 'running' || s.state === 'starting'
          ? el('button', { class: 'btn small danger', disabled: busy(busyKey) || undefined, onClick: () => act(busyKey, () => api('POST', `/services/${s.id}/stop`), `${s.name} 已停止`) }, '停止')
          : el('button', { class: 'btn small ok', disabled: busy(busyKey) || undefined || s.state === 'stopping', onClick: () => act(busyKey, () => api('POST', `/services/${s.id}/start`), `${s.name} 启动命令已下发`) }, '启动'),
        el('button', { class: 'btn small ghost', disabled: busy(busyKey) || undefined, onClick: () => act(busyKey, () => api('POST', `/services/${s.id}/restart`), `${s.name} 已重启`) }, '重启'),
        el('button', { class: 'btn small ghost', onClick: toggle }, expanded ? '收起日志' : '日志'),
        el('button', { class: 'btn small ghost', onClick: () => openDialog({ kind: 'service', data: { ...s } }) }, '设置'),
        el('button', { class: 'btn small ghost danger', disabled: busy(busyKey) || undefined, onClick: () => removeService(s) }, '删除'),
      ),
    ),
    s.error ? el('div', { class: 'svc-error' }, s.error) : null,
    expanded ? renderServiceLogs(s) : null,
  );
}

function renderServiceLogs(s) {
  const logs = (state.status.logs || []).filter((l) => l.id === s.id).slice(-200);
  return el(
    'div',
    { class: 'svc-logs', id: `logs-${s.id}` },
    logs.length
      ? logs.map((l) => el('div', { class: /error|失败|Error|ERROR/.test(l.line) ? 'err' : '' }, l.line))
      : el('div', { class: 'muted' }, '暂无日志（启动后会在这里实时输出）'),
  );
}

function renderConfig(st) {
  const onCount = (list) => (list || []).filter((x) => x.enabled !== false).length;
  const ruleLine = (m, prefix, text) => {
    const on = m.enabled !== false;
    return el(
      'div',
      { class: 'log-line', style: on ? '' : 'opacity:.45' },
      el('span', { class: 'svc-tag' }, prefix),
      el('span', {}, text),
      on ? null : el('span', { class: 'hint', style: 'margin-left:8px' }, '已停用'),
    );
  };
  return el(
    'section',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el('h2', {}, '代理与本地联调'),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn small', onClick: () => openDialog({ kind: 'rules', data: JSON.parse(JSON.stringify({ localApis: st.localApis, mocks: st.mocks, staticFiles: st.staticFiles })) }) }, '编辑规则'),
      el('button', { class: 'btn small', onClick: () => openDialog({ kind: 'proxy' }) }, '端口设置'),
    ),
    el(
      'div',
      { class: 'card-body' },
      el(
        'div',
        { class: 'facts', style: 'margin-top:0' },
        el('span', {}, '本地接口映射', el('b', {}, `${onCount(st.localApis)} / ${st.localApis.length}`)),
        el('span', {}, 'Mock 接口', el('b', {}, `${onCount(st.mocks)} / ${st.mocks.length}`)),
        el('span', {}, '本地静态文件', el('b', {}, `${onCount(st.staticFiles)} / ${st.staticFiles.length}`)),
        el('span', { class: 'hint' }, '（启用 / 总数）'),
      ),
      st.localApis.length
        ? el('div', { style: 'margin-top:10px' }, ...st.localApis.map((m) => ruleLine(m, m.prefix, `→ ${m.target}`)))
        : el('p', { class: 'hint', style: 'margin:8px 0 0' }, '没有本地接口映射：所有接口都走当前环境。'),
      st.mocks.length
        ? el('div', { style: 'margin-top:6px' }, ...st.mocks.map((m) => ruleLine(m, m.path, '→ mock JSON')))
        : null,
      st.staticFiles.length
        ? el('div', { style: 'margin-top:6px' }, ...st.staticFiles.map((m) => ruleLine(m, m.path, `→ ${m.file}`)))
        : null,
    ),
  );
}

function renderSide(st) {
  const tabs = [{ id: 'all', label: '全部' }, { id: 'proxy', label: '代理' }, ...st.services.map((s) => ({ id: s.id, label: s.name }))];
  const tabId = state.tab === 'proxy' ? 'proxy' : state.tab;
  const logs = (st.logs || []).filter((l) => tabId === 'all' || l.id === tabId).slice(-300);
  return el(
    'aside',
    { class: 'stack-side' },
    el(
      'div',
      { class: 'side-head' },
      el('h2', {}, '实时日志'),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn small ghost', onClick: () => act('clear', async () => { await api('DELETE', '/logs'); return { status: await api('GET', '/status') }; }, '日志已清空') }, '清空'),
    ),
    el('div', { class: 'log-tabs' }, ...tabs.map((t) => el('button', { 'aria-selected': state.tab === t.id ? 'true' : 'false', onClick: () => { state.tab = t.id; render(); } }, t.label))),
    el(
      'div',
      { class: 'log-panel' },
      logs.length
        ? logs.map((l) => el('div', { class: 'log-line' }, el('time', {}, clock(l.at)), el('span', { class: 'svc-tag' }, state.tab === 'all' ? l.id : ''), el('span', {}, l.line)))
        : el('div', { class: 'muted' }, '暂无日志'),
    ),
  );
}

function appendLogRow(row) {
  const box = $('.log-panel');
  if (!box) return;
  const tabId = state.tab === 'proxy' ? 'proxy' : state.tab;
  if (tabId !== 'all' && tabId !== row.id) return;
  // 代理日志在「代理」标签下也显示
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const lineOf = (r) => el('div', { class: 'log-line' }, el('time', {}, clock(r.at)), el('span', { class: 'svc-tag' }, state.tab === 'all' ? r.id : ''), el('span', {}, r.line));
  if (row.replace && box.lastElementChild) box.lastElementChild.replaceWith(lineOf(row));
  else box.append(lineOf(row));
  if (nearBottom) box.scrollTop = box.scrollHeight;
  const svcLog = $(`#logs-${row.id}`);
  if (svcLog) {
    const text = el('div', { class: /error|失败|Error|ERROR/.test(row.line) ? 'err' : '' }, row.line);
    if (row.replace && svcLog.lastElementChild) svcLog.lastElementChild.replaceWith(text);
    else svcLog.append(text);
  }
}

// ---------- 弹窗 ----------
function blankService(st) {
  return {
    id: '',
    name: '',
    dir: '',
    port: st.services.some((s) => s.port === 8890) ? 8891 : 8890,
    route: '/',
    enabled: true,
    autoStart: false,
    script: 'serve',
    args: ['--port', '{port}'],
    mode: 'auto',
    env: {},
    readyTimeoutMs: 240000,
    startTimeoutMs: 240000,
    checks: [],
  };
}

function renderDialog() {
  const { kind, data } = state.editing;
  const close = closeDialog;
  const head = (title) => el('div', { class: 'dialog-head' }, el('h3', {}, title), el('span', { class: 'grow' }), el('button', { class: 'btn small ghost', onClick: close }, '✕'));

  if (kind === 'service') return renderServiceDialog(data, head, close);
  if (kind === 'proxy') return renderProxyDialog(head, close);
  if (kind === 'envs') return renderEnvsDialog(head, close);
  if (kind === 'rules') return renderRulesDialog(data, head, close);
  return null;
}

function field(label, input, wide) {
  return el('label', { class: `field${wide ? ' wide' : ''}` }, el('span', {}, label), input);
}

const envToText = (env) => Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
const parseEnvText = (text) =>
  Object.fromEntries(
    String(text || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf('=');
        return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1)] : [l, ''];
      }),
  );

function renderServiceDialog(s, head, close) {
  const form = {
    ...s,
    argsText: (s.args || []).join(' '),
    envText: envToText(s.env),
    checksText: (s.checks || []).join('\n'),
  };
  // 表单是普通对象：输入后必须手动同步「保存」按钮的禁用态，否则按钮会一直保持创建时的状态
  let saveBtn = null;
  const syncSave = () => {
    if (saveBtn) saveBtn.disabled = Boolean(busy('dialog') || !form.dir || !form.port);
  };
  const set = (k, v) => {
    form[k] = v;
    // 写回弹窗数据：act() 会重绘一次，不写回的话输入框会跳回旧值
    if (k === 'argsText') s.args = v.split(/\s+/).filter(Boolean);
    else if (k === 'checksText') s.checks = v.split('\n').map((x) => x.trim()).filter(Boolean);
    else if (k === 'envText') s.env = parseEnvText(v);
    else s[k] = v;
    syncSave();
  };
  const inspectBox = el('div', { class: 'hint' }, '保存前可先检查目录与端口。');
  const save = () =>
    act(
      'dialog',
      async () => {
        const payload = {
          id: form.id || undefined,
          name: form.name || form.dir,
          dir: form.dir,
          port: Number(form.port),
          route: form.route,
          enabled: !!form.enabled,
          autoStart: !!form.autoStart,
          script: form.script || 'serve',
          args: form.argsText.split(/\s+/).filter(Boolean),
          mode: form.mode,
          env: Object.fromEntries(
            form.envText
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .map((l) => {
                const i = l.indexOf('=');
                return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1)] : [l, ''];
              }),
          ),
          readyTimeoutMs: Number(form.readyTimeoutMs) || 240000,
          startTimeoutMs: Number(form.startTimeoutMs) || 240000,
          checks: form.checksText.split('\n').map((x) => x.trim()).filter(Boolean),
        };
        const next = form.id ? await api('PUT', `/services/${form.id}`, payload) : await api('POST', '/services', payload);
        close();
        return next;
      },
      form.id ? '服务已更新' : '服务已添加',
    );
  const saveBtnNode = el(
    'button',
    {
      class: 'btn primary',
      disabled: busy('dialog') || !form.dir || !form.port ? '' : undefined,
      onClick: save,
    },
    busy('dialog') ? '保存中…' : '保存',
  );
  saveBtn = saveBtnNode;

  return el(
    'div',
    { class: 'mask', onClick: (e) => e.target === e.currentTarget && close() },
    el(
      'div',
      { class: 'dialog' },
      head(form.id ? `设置 · ${form.name}` : '新增服务'),
      el(
        'div',
        { class: 'dialog-body' },
        el(
          'div',
          { class: 'form-grid' },
          field('名称', el('input', { class: 'input', value: form.name, placeholder: '如 证书管理', onInput: (e) => set('name', e.target.value) })),
          field('目录（相对服务根目录或绝对路径）', el('input', { class: 'input mono', value: form.dir, placeholder: 'bosssoft-certificate-management-ui', onInput: (e) => set('dir', e.target.value) })),
          field('端口', el('input', { class: 'input', type: 'number', value: form.port, onInput: (e) => set('port', e.target.value) })),
          field('路由前缀（静态资源走本地）', el('input', { class: 'input mono', value: form.route, placeholder: '/certificate', onInput: (e) => set('route', e.target.value) })),
          field('npm 脚本', el('input', { class: 'input mono', value: form.script, placeholder: 'serve / dev', onInput: (e) => set('script', e.target.value) })),
          field('脚本参数（{port} 会替换为端口）', el('input', { class: 'input mono', value: form.argsText, placeholder: '--port {port}', onInput: (e) => set('argsText', e.target.value) })),
          field(
            '静态资源策略',
            el(
              'select',
              { class: 'input', onChange: (e) => set('mode', e.target.value) },
              el('option', { value: 'auto', selected: form.mode === 'auto' ? '' : undefined }, '自动：静态资源转本地，接口转环境'),
              el('option', { value: 'local', selected: form.mode === 'local' ? '' : undefined }, '全部转本地'),
              el('option', { value: 'remote', selected: form.mode === 'remote' ? '' : undefined }, '全部转环境'),
            ),
          ),
          field('启动超时（秒）', el('input', { class: 'input', type: 'number', value: Math.round(form.startTimeoutMs / 1000), onInput: (e) => set('startTimeoutMs', Number(e.target.value) * 1000) })),
          el(
            'div',
            { class: 'field wide' },
            el('label', { class: 'switch', style: 'color:var(--ink-2)' }, el('input', { type: 'checkbox', checked: form.autoStart, onChange: (e) => set('autoStart', e.target.checked) }), '随代理自动启动'),
            el('label', { class: 'switch', style: 'color:var(--ink-2)' }, el('input', { type: 'checkbox', checked: form.enabled, onChange: (e) => set('enabled', e.target.checked) }), '启用（参与代理路由）'),
          ),
          field('环境变量（每行 KEY=VALUE）', el('textarea', { class: 'input', rows: 3, value: form.envText, onInput: (e) => set('envText', e.target.value) }), true),
        ),
        inspectBox,
      ),
      el(
        'div',
        { class: 'dialog-foot' },
        el(
          'button',
          {
            class: 'btn',
            onClick: async () => {
              try {
                const r = await api('GET', `/services/${encodeURIComponent(form.id || `inspect-${Date.now()}`)}/inspect`).catch(async () => {
                  // 新服务还没有 id：用临时检查接口
                  return null;
                });
                const info = r || (await postInspect(form));
                inspectBox.className = '';
                inspectBox.replaceChildren(
                  el('div', {}, info.dirExists ? '✔ 目录存在' : '✘ 目录不存在', ` ${info.dir}`),
                  el('div', {}, info.hasPackage ? `✔ package.json 脚本：${info.scripts.join(', ') || '（无）'}` : `✘ ${info.pkgError}`),
                  el('div', {}, info.hasNodeModules ? '✔ 已安装依赖' : '⚠ 未发现 node_modules，需要先安装依赖'),
                  el('div', {}, info.portInUse ? `⚠ 端口 ${info.port} 已被占用` : `✔ 端口 ${info.port} 空闲`),
                );
                inspectBox.className = info.dirExists && info.hasPackage ? 'hint' : 'err';
              } catch (e) {
                inspectBox.className = 'err';
                inspectBox.textContent = e.message;
              }
            },
          },
          '检查目录',
        ),
        el('button', { class: 'btn ghost', onClick: close }, '取消'),
        saveBtnNode,
      ),
    ),
  );
}

async function postInspect(form) {
  // 没有 id 的新服务：走通用检查（复用现有 inspect，参数放在 query）
  const q = new URLSearchParams({ dir: form.dir, port: String(form.port) });
  return api('GET', `/inspect?${q}`);
}

function renderProxyDialog(head, close) {
  const st = state.status;
  const proxy = { ...st.settings };
  const root = { value: st.servicesRoot };
  return el(
    'div',
    { class: 'mask', onClick: (e) => e.target === e.currentTarget && close() },
    el(
      'div',
      { class: 'dialog' },
      head('代理与目录设置'),
      el(
        'div',
        { class: 'dialog-body' },
        el(
          'div',
          { class: 'form-grid' },
          field('监听地址', el('input', { class: 'input mono', value: proxy.host, onInput: (e) => (proxy.host = e.target.value) })),
          field('端口', el('input', { class: 'input', type: 'number', value: proxy.port, onInput: (e) => (proxy.port = Number(e.target.value)) })),
          field('服务根目录', el('input', { class: 'input mono', value: root.value, onInput: (e) => (root.value = e.target.value) }), true),
        ),
        el('p', { class: 'hint' }, '保存端口变更会重启代理；与环境站点通信保持 SSL 校验宽松（内网自签证书）。'),
      ),
      el(
        'div',
        { class: 'dialog-foot' },
        el('button', { class: 'btn ghost', onClick: close }, '取消'),
        el(
          'button',
          {
            class: 'btn primary',
            onClick: () =>
              act(
                'dialog',
                async () => {
                  const next = await api('PUT', '/settings', { proxy, servicesRoot: root.value });
                  close();
                  return next;
                },
                '设置已保存',
              ),
          },
          '保存',
        ),
      ),
    ),
  );
}

function renderEnvsDialog(head, close) {
  const data = JSON.parse(JSON.stringify(state.status.envs));
  const box = el('div', { class: 'form-grid' });
  const draw = () => {
    box.replaceChildren(
      ...data.flatMap((env, i) => [
        field(`环境 ${i + 1} · 名称`, el('input', { class: 'input', value: env.label, onInput: (e) => (env.label = e.target.value) })),
        field('id', el('input', { class: 'input mono', value: env.id, onInput: (e) => (env.id = e.target.value) })),
        field('目标地址', el('input', { class: 'input mono', value: env.target, onInput: (e) => (env.target = e.target.value) }), true),
        field('API 前缀', el('input', { class: 'input mono', value: env.apiPrefix, onInput: (e) => (env.apiPrefix = e.target.value) })),
        field('登录路由', el('input', { class: 'input mono', value: env.loginPath, onInput: (e) => (env.loginPath = e.target.value) })),
        field('账号备注', el('input', { class: 'input', value: env.account || '', onInput: (e) => (env.account = e.target.value) })),
        field('端口（仅记录）', el('input', { class: 'input', type: 'number', value: env.port, onInput: (e) => (env.port = Number(e.target.value)) })),
      ]),
    );
  };
  draw();
  return el(
    'div',
    { class: 'mask', onClick: (e) => e.target === e.currentTarget && close() },
    el(
      'div',
      { class: 'dialog' },
      head('环境列表'),
      el('div', { class: 'dialog-body' }, box, el('div', {}, el('button', { class: 'btn small', onClick: () => { data.push({ id: `env${data.length + 1}`, label: '', target: '', apiPrefix: '/saas-industry', port: 30000, loginPath: 'login', account: '' }); draw(); } }, '＋ 添加环境'))),
      el(
        'div',
        { class: 'dialog-foot' },
        el('button', { class: 'btn ghost', onClick: close }, '取消'),
        el(
          'button',
          {
            class: 'btn primary',
            onClick: () =>
              act(
                'dialog',
                async () => {
                  const next = await api('PUT', '/envs', { envs: data });
                  close();
                  return next;
                },
                '环境已保存',
              ),
          },
          '保存',
        ),
      ),
    ),
  );
}

function renderRulesDialog(data, head, close) {
  const apis = data.localApis;
  const mocks = data.mocks;
  const statics = data.staticFiles;
  const apisBox = el('div');
  const mocksBox = el('div');
  const staticBox = el('div');
  // 每条规则都带启用开关：停用只是不参与匹配，配置保留在 stack.json 里
  const row = (item, left, right, onDel) => {
    const on = item.enabled !== false;
    const line = el('div', {
      style: `display:flex;gap:6px;margin-bottom:6px;align-items:center${on ? '' : ';opacity:.5'}`,
    });
    const sw = el(
      'label',
      { class: 'switch', title: on ? '已启用' : '已停用', style: 'flex:none' },
      el('input', {
        type: 'checkbox',
        checked: on,
        onChange: (e) => {
          item.enabled = e.target.checked;
          line.style.opacity = e.target.checked ? '' : '.5';
          sw.title = e.target.checked ? '已启用' : '已停用';
        },
      }),
    );
    line.append(sw, left, right, el('button', { class: 'btn small danger', style: 'flex:none', onClick: onDel }, '✕'));
    return line;
  };
  const draw = () => {
    apisBox.replaceChildren(
      ...apis.map((m, i) =>
        row(
          m,
          el('input', { class: 'input mono', value: m.prefix, placeholder: '/saas-industry/xxx', onInput: (e) => (apis[i].prefix = e.target.value) }),
          el('input', { class: 'input mono', value: m.target, placeholder: 'http://127.0.0.1:8080', onInput: (e) => (apis[i].target = e.target.value) }),
          () => { apis.splice(i, 1); draw(); },
        ),
      ),
      el('button', { class: 'btn small', onClick: () => { apis.push({ prefix: '', target: '', enabled: true }); draw(); } }, '＋ 添加映射'),
    );
    mocksBox.replaceChildren(
      ...mocks.map((m, i) =>
        row(
          m,
          el('input', { class: 'input mono', value: m.path, placeholder: '/saas-industry/xxx', onInput: (e) => (mocks[i].path = e.target.value) }),
          el('input', { class: 'input mono', value: JSON.stringify(m.body), onInput: (e) => { try { mocks[i].body = JSON.parse(e.target.value); } catch { /* 输入中 */ } } }),
          () => { mocks.splice(i, 1); draw(); },
        ),
      ),
      el('button', { class: 'btn small', onClick: () => { mocks.push({ path: '', body: {}, enabled: true }); draw(); } }, '＋ 添加 Mock'),
    );
    staticBox.replaceChildren(
      ...statics.map((m, i) =>
        row(
          m,
          el('input', { class: 'input mono', value: m.path, placeholder: '/saas-industry/static/xxx.js', onInput: (e) => (statics[i].path = e.target.value) }),
          el('input', { class: 'input mono', value: m.file, placeholder: 'D:\\path\\file.js', onInput: (e) => (statics[i].file = e.target.value) }),
          () => { statics.splice(i, 1); draw(); },
        ),
      ),
      el('button', { class: 'btn small', onClick: () => { statics.push({ path: '', file: '', enabled: true }); draw(); } }, '＋ 添加文件映射'),
    );
  };
  draw();
  return el(
    'div',
    { class: 'mask', onClick: (e) => e.target === e.currentTarget && close() },
    el(
      'div',
      { class: 'dialog' },
      head('接口 / Mock / 静态文件映射'),
      el(
        'div',
        { class: 'dialog-body' },
        el('div', {}, el('h4', { style: 'margin:0 0 6px' }, '本地接口映射'), el('p', { class: 'hint', style: 'margin:0 0 6px' }, '命中前缀（最长优先）时转到本地后端，转发前会去掉环境 API 前缀。左侧开关可临时停用，不必删除。'), apisBox),
        el('div', {}, el('h4', { style: 'margin:0 0 6px' }, 'Mock 接口'), el('p', { class: 'hint', style: 'margin:0 0 6px' }, '路径精确匹配，直接返回 JSON；停用后该路径回落当前环境。'), mocksBox),
        el('div', {}, el('h4', { style: 'margin:0 0 6px' }, '本地静态文件'), el('p', { class: 'hint', style: 'margin:0 0 6px' }, '路径精确匹配，直接返回本地文件（如替换线上 formily 产物）；停用后回落当前环境。'), staticBox),
      ),
      el(
        'div',
        { class: 'dialog-foot' },
        el('button', { class: 'btn ghost', onClick: close }, '取消'),
        el(
          'button',
          {
            class: 'btn primary',
            onClick: () =>
              act(
                'dialog',
                async () => {
                  const next = await api('PUT', '/local-api', { localApis: apis, mocks, staticFiles: statics });
                  close();
                  return next;
                },
                '规则已保存',
              ),
          },
          '保存',
        ),
      ),
    ),
  );
}

function removeService(s) {
  if (!confirm(`删除服务「${s.name}」？\n只移除配置，不会删除 ${s.dir} 目录里的任何文件。`)) return;
  act(`svc:${s.id}`, () => api('DELETE', `/services/${s.id}`), `${s.name} 已移除`);
}

async function copy(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    window.prompt('请手动复制', text);
  }
}

// ---------- 键盘 ----------
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.editing) {
    state.editing = null;
    render();
  }
});

// ---------- 启动 ----------
const saved = localStorage.getItem('wb.stack.theme');
if (saved === 'dark') document.documentElement.dataset.theme = 'dark';
refresh();
connectEvents();
setInterval(() => {
  // SSE 断开时兜底刷新；连接正常时 SSE 会持续推进状态
  if (!state.sse || state.sse.readyState !== 1) refresh();
}, 5000);
