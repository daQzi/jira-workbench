// 联调栈配置：读写 %APPDATA%\JiraWorkbench\stack.json（独立运行时为 ~/.wb-stack/config.json）。
// 所有可变项都在这里归一化，界面只提交“想改什么”，不直接碰文件。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_VERSION = 1;

/** 与原 proxy-common.js 一致的环境清单；apiPrefix / port 按环境区分 */
export const DEFAULT_ENVS = [
  {
    id: 'zhsf',
    label: '综合收费',
    target: 'http://172.18.166.122:30000',
    apiPrefix: '/test-industry-02',
    port: 30000,
    loginPath: 'login',
    account: '000356/001/123@admin',
  },
  { id: '184', label: '184', target: 'http://172.18.163.184:30000', apiPrefix: '/saas-industry', port: 30000, loginPath: 'login', account: '' },
  { id: '92', label: '92', target: 'http://172.18.163.92:30000', apiPrefix: '/saas-industry', port: 30000, loginPath: 'login', account: '000048/fy002/123@admin' },
  { id: '138', label: '138', target: 'http://172.18.163.138:30000', apiPrefix: '/saas-industry', port: 30000, loginPath: 'login', account: '005340/15396005467/123@admin' },
  { id: '52', label: '52', target: 'http://172.18.163.52:30000', apiPrefix: '/saas-industry', port: 30000, loginPath: 'zhfw', account: '120012/test001/123@admin' },
  { id: 'srmyy', label: '省人民医院', target: 'http://api.srmyy.com:30000', apiPrefix: '/saas-industry', port: 30000, loginPath: 'login', account: '' },
  { id: 'cqzy', label: '重庆中医院', target: 'https://dzpz.cqszyyhlzk.cn:34789', apiPrefix: '/saas-industry', port: 30000, loginPath: 'login', account: '' },
  { id: 'yy', label: '运营', target: 'http://172.18.166.122:31776', apiPrefix: '', port: 31776, loginPath: 'login', account: 'admin/Admin@1999!!!' },
];

/** 原 watchPortList / projectMap 里的 8 个前端；默认只自动拉起证书管理（与原配置一致） */
export const DEFAULT_SERVICES = [
  { id: 'certificate', name: '证书管理', dir: 'bosssoft-certificate-management-ui', port: 8888, route: '/certificate', enabled: true, autoStart: true },
  { id: 'reimburse', name: '报销前端', dir: 'tax-reimburse-frontend', port: 9999, route: '/reimburse-frontend', enabled: false, autoStart: false, script: 'serve' },
  { id: 'acquiring', name: '收单前端', dir: 'wisdom-acquiring-frontend', port: 8889, route: '/acquiring-frontend', enabled: false, autoStart: false, script: 'dev' },
  { id: 'sysconfig', name: '系统配置', dir: 'tax-sys-config-frontend', port: 7777, route: '/openapi', enabled: false, autoStart: false, script: 'dev' },
  { id: 'zhsf', name: '综合收费前端', dir: 'saas-zhsf-frontend', port: 7779, route: '/zhsf', enabled: false, autoStart: false, script: 'serve' },
  { id: 'procurement', name: '采购协同', dir: 'tax-procurement-collaboration-frontend', port: 9095, route: '/procurement-collaboration-frontend', enabled: false, autoStart: false, script: 'serve' },
  { id: 'digital', name: '数字服务平台', dir: 'tax-digital-service-platform-frontend', port: 9090, route: '/bsTaxFrontend', enabled: false, autoStart: false, script: 'dev' },
  { id: 'finance', name: '财务协同', dir: 'saas-finance-cooperate-industry-frontend', port: 7778, route: '/intelAccount', enabled: false, autoStart: false, script: 'serve' },
  { id: 'usercenter', name: '用户中心前端', dir: 'saas-user-center-industry-frontend', port: 8089, route: '/user-center', enabled: true, autoStart: false, script: 'dev' },
];

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    proxy: {
      host: '0.0.0.0',
      port: 30000,
      autoStartOnLaunch: true,
      autoStartServices: true,
      launchPath: '',
    },
    envs: DEFAULT_ENVS.map((e) => ({ ...e })),
    currentEnv: '52',
    servicesRoot: 'D:\\project\\bosssoft-medicine',
    services: DEFAULT_SERVICES.map((s) => ({
      ...s,
      script: s.script || 'serve',
      args: ['--port', '{port}'],
      mode: 'auto', // auto=静态资源转本地、接口走环境；local=全部转本地；remote=全部走环境
      env: {},
      readyTimeoutMs: 240000,
      startTimeoutMs: 240000,
      checks: [],
    })),
    localDebug: { enabled: false, target: '', paths: [] },
    localApis: [],
    mocks: [],
    staticFiles: [],
    /** npm 找不到时使用的 Node 可执行文件（工作台会注入内置 runtime/node.exe） */
    nodePath: process.env.WB_STACK_NODE || '',
  };
}

/** 独立运行：~/.wb-stack/config.json；工作台内：%APPDATA%\JiraWorkbench\stack.json */
export function defaultConfigPath() {
  if (process.env.WB_STACK_CONFIG) return path.resolve(process.env.WB_STACK_CONFIG);
  if (process.env.WB_STACK_DATA_DIR) return path.join(process.env.WB_STACK_DATA_DIR, 'stack.json');
  const home = os.homedir();
  return path.join(
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
    'wb-stack',
    'config.json',
  );
}

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const bool = (v, fallback = false) => (typeof v === 'boolean' ? v : fallback);
const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function normEnv(raw, i) {
  const id = str(raw?.id).trim();
  const target = str(raw?.target).trim().replace(/\/+$/, '');
  if (!id || !/^https?:\/\//i.test(target)) return null;
  return {
    id,
    label: str(raw?.label).trim() || id,
    target,
    apiPrefix: normalizePrefix(str(raw?.apiPrefix, '/saas-industry')),
    port: num(raw?.port, 30000),
    loginPath: str(raw?.loginPath, 'login').replace(/^\/+/, '') || 'login',
    account: str(raw?.account),
  };
}

/** '' 、'/' 、'saas-industry' 都归一化成 '/saas-industry' 形式 */
function normalizePrefix(v) {
  const s = str(v).trim();
  if (!s || s === '/') return '';
  return '/' + s.replace(/^\/+|\/+$/g, '');
}

function normService(raw, i) {
  const dir = str(raw?.dir).trim();
  if (!dir) return null;
  const id = str(raw?.id).trim() || `svc-${i + 1}`;
  const port = num(raw?.port, 0);
  if (!port) return null;
  const args = Array.isArray(raw?.args) ? raw.args.map((a) => str(a)) : ['--port', '{port}'];
  return {
    id,
    name: str(raw?.name).trim() || dir,
    dir,
    port,
    route: normalizePrefix(str(raw?.route)),
    enabled: bool(raw?.enabled, true),
    autoStart: bool(raw?.autoStart, false),
    script: str(raw?.script, 'dev') || 'dev',
    args,
    mode: ['auto', 'local', 'remote'].includes(raw?.mode) ? raw.mode : 'auto',
    env: raw?.env && typeof raw.env === 'object' && !Array.isArray(raw.env) ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, str(v)])) : {},
    readyTimeoutMs: num(raw?.readyTimeoutMs, 240000),
    startTimeoutMs: num(raw?.startTimeoutMs, 240000),
    checks: Array.isArray(raw?.checks) ? raw.checks.map((c) => str(c)).filter(Boolean) : [],
  };
}

export function normalizeConfig(raw) {
  const base = defaultConfig();
  const c = raw && typeof raw === 'object' ? raw : {};
  const proxy = c.proxy && typeof c.proxy === 'object' ? c.proxy : {};
  const envs = (Array.isArray(c.envs) ? c.envs : base.envs).map(normEnv).filter(Boolean);
  const services = (Array.isArray(c.services) ? c.services : base.services).map(normService).filter(Boolean);
  // 去重：同 id 后者覆盖
  const uniq = (list) => [...new Map(list.map((x) => [x.id, x])).values()];
  const envsU = uniq(envs.length ? envs : base.envs);
  const servicesU = uniq(services);
  const currentEnv = envsU.some((e) => e.id === c.currentEnv) ? c.currentEnv : envsU[0]?.id;
  return {
    version: CONFIG_VERSION,
    proxy: {
      host: str(proxy.host, base.proxy.host) || base.proxy.host,
      port: num(proxy.port, base.proxy.port),
      autoStartOnLaunch: bool(proxy.autoStartOnLaunch, base.proxy.autoStartOnLaunch),
      autoStartServices: bool(proxy.autoStartServices, base.proxy.autoStartServices),
      launchPath: str(proxy.launchPath),
    },
    envs: envsU,
    currentEnv,
    servicesRoot: str(c.servicesRoot, base.servicesRoot).trim(),
    services: servicesU,
    localDebug: {
      enabled: bool(c.localDebug?.enabled, false),
      target: str(c.localDebug?.target).trim().replace(/\/+$/, ''),
      paths: Array.isArray(c.localDebug?.paths) ? c.localDebug.paths.map((p) => str(p).trim()).filter(Boolean) : [],
    },
    localApis: (Array.isArray(c.localApis) ? c.localApis : [])
      .map((x) => ({ prefix: normalizePrefix(x?.prefix), target: str(x?.target).trim().replace(/\/+$/, ''), enabled: bool(x?.enabled, true) }))
      .filter((x) => x.prefix && /^https?:\/\//i.test(x.target)),
    mocks: (Array.isArray(c.mocks) ? c.mocks : [])
      .map((x) => ({ path: str(x?.path).trim(), body: x?.body ?? {}, enabled: bool(x?.enabled, true) }))
      .filter((x) => x.path.startsWith('/')),
    staticFiles: (Array.isArray(c.staticFiles) ? c.staticFiles : [])
      .map((x) => ({ path: str(x?.path).trim(), file: str(x?.file).trim(), enabled: bool(x?.enabled, true) }))
      .filter((x) => x.path.startsWith('/') && x.file),
    nodePath: str(c.nodePath, base.nodePath),
  };
}

export function loadConfig(file = defaultConfigPath()) {
  if (!existsSync(file)) return { file, config: defaultConfig(), created: true };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return { file, config: normalizeConfig(raw), created: false };
  } catch (e) {
    throw Object.assign(new Error(`配置文件格式错误：${file}（${e.message}）`), { code: 'BAD_CONFIG' });
  }
}

export function saveConfig(config, file = defaultConfigPath()) {
  const normalized = normalizeConfig(config);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
  return normalized;
}

export function resolveServiceDir(service, root) {
  if (path.isAbsolute(service.dir)) return service.dir;
  if (!root) return path.resolve(service.dir);
  return path.resolve(root, service.dir);
}
