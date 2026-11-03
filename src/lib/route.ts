// 路由写在 hash 里：#/<项目|ALL>/<页面>?issue=KEY，刷新/分享可还原。
// 当前项目是全局维度，所有页面都按它查询；ALL 表示跨项目（只有个人页面可用）。
export type Page = 'me' | 'hours' | 'tree' | 'flat' | 'board';
export const PAGES: Page[] = ['me', 'hours', 'tree', 'flat', 'board'];
/** 只能在具体项目下使用的页面 */
export const PROJECT_PAGES: Page[] = ['tree', 'flat', 'board'];
export const ALL = 'ALL';

export interface Route {
  /** 具体项目；null = 全部项目；undefined = 地址里没写（旧地址或首次打开），需补上 */
  project: string | null | undefined;
  page: Page;
  issue: string | null;
}

const isPage = (s: string | undefined): s is Page => !!s && (PAGES as string[]).includes(s);

export function parseHash(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const [a, b] = path.split('/').map((x) => (x ? decodeURIComponent(x) : x));
  const issue = new URLSearchParams(query).get('issue');
  // 旧地址 #/me、#/hours：页面保留，项目待补
  if (!a || isPage(a)) return { project: undefined, page: isPage(a) ? a : 'me', issue };
  const project = a.toUpperCase() === ALL ? null : a;
  let page: Page = isPage(b) ? b : 'me';
  if (project === null && PROJECT_PAGES.includes(page)) page = 'me';
  return { project, page, issue };
}

export function toHash(r: { project: string | null; page: Page; issue: string | null }): string {
  const page = r.project === null && PROJECT_PAGES.includes(r.page) ? 'me' : r.page;
  const base = `#/${r.project === null ? ALL : encodeURIComponent(r.project)}/${page}`;
  return r.issue ? `${base}?issue=${encodeURIComponent(r.issue)}` : base;
}

// ---------- 上次使用的项目 ----------
const STORE = 'wb.project.v1';
type KV = Pick<Storage, 'getItem' | 'setItem'>;
const storage = (): KV | null => (typeof localStorage === 'undefined' ? null : localStorage);

export function loadLastProject(kv: KV | null = storage()): string | null {
  try {
    const v = kv?.getItem(STORE);
    return v && v !== ALL ? v : null;
  } catch {
    return null;
  }
}

/** 只记具体项目：「全部项目」只是临时查看，下次打开仍回到上次的项目 */
export function saveLastProject(project: string | null, kv: KV | null = storage()) {
  if (!project || !kv) return;
  try {
    kv.setItem(STORE, project);
  } catch {
    /* 忽略 */
  }
}

/** 地址里没写项目时用哪个：上次的（仍存在）> 第一个可写的 > 第一个 */
export function pickProject(projects: { key: string }[], last: string | null, writable: (k: string) => boolean): string | null {
  if (last && projects.some((p) => p.key === last)) return last;
  return projects.find((p) => writable(p.key))?.key ?? projects[0]?.key ?? null;
}
