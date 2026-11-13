import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, setUnauthorizedListener, type Me } from './lib/api';
import { useCachedAsync } from './lib/requestCache';
import { ThemeToggle } from './components/ThemeToggle';
import { SessionProvider, useSession } from './lib/session';
import type { CreateTarget } from './components/CreateDialog';
import type { Project } from './lib/types';
import { Login } from './components/Login';
import { FilterBar, DEFAULT_FILTER, type FilterState } from './components/FilterBar';
import { ErrorState, Loading } from './components/States';
import { useWorkbenchMotion } from './features/scene/useWorkbenchMotion';
import { MyWorkView } from './views/MyWorkView';
import { sharedView } from './components/SavedViews';
import { TypeBadge } from './components/Badges';
import { loadFilter, saveFilter } from './lib/filterPrefs';
import { ToolsProvider, useTools } from './features/tools/useTools';
import { CommandPalette } from './components/CommandPalette';
import { ProjectSwitcher } from './components/ProjectSwitcher';
import { isValidVersion } from './lib/versions';
import { loadLastProject, parseHash, pickProject, PROJECT_PAGES, saveLastProject, toHash, type Page, type Route } from './lib/route';

const TreeView = lazy(() => import('./views/TreeView').then(m => ({ default: m.TreeView })));
const BoardView = lazy(() => import('./views/BoardView').then(m => ({ default: m.BoardView })));
const HoursWorkspace = lazy(() => import('./views/HoursWorkspace').then(m => ({ default: m.HoursWorkspace })));
const VersionView = lazy(() => import('./views/VersionView').then(m => ({ default: m.VersionView })));
const NotificationsView = lazy(() => import('./views/NotificationsView').then(m => ({ default: m.NotificationsView })));
const McpView = lazy(() => import('./views/McpView').then(m => ({ default: m.McpView })));
const IssueDrawer = lazy(() => import('./components/IssueDrawer').then(m => ({ default: m.IssueDrawer })));
const CreateDialog = lazy(() => import('./components/CreateDialog').then(m => ({ default: m.CreateDialog })));
const Toolbox = lazy(() => import('./features/tools/Toolbox').then(m => ({ default: m.Toolbox })));

interface BackTarget { hash: string; steps: number }
interface NavigationHistory { workbench?: BackTarget; cardList?: BackTarget }

function useRoute(): [Route, (patch: Partial<Route>) => void] {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => {
      const parsed = parseHash(location.hash);
      if (/^#\/?(?:review|[^/?]+\/review)(?:[?]|$)/.test(location.hash) && parsed.project !== undefined) {
        history.replaceState(null, '', toHash({ ...parsed, project: parsed.project }));
      }
      setRoute(parsed);
    };
    on();
    window.addEventListener('hashchange', on);
    window.addEventListener('popstate', on);
    return () => { window.removeEventListener('hashchange', on); window.removeEventListener('popstate', on); };
  }, []);
  const update = useCallback((patch: Partial<Route>) => {
    const cur = parseHash(location.hash);
    const next = { ...cur, ...patch };
    const hash = toHash({ ...next, project: next.project ?? null });
    if (hash === location.hash) return;
    const previous: NavigationHistory = history.state ?? {};
    const sameWorkbench = cur.page === 'me' && next.page === 'me' && cur.project === next.project;
    const closingCard = sameWorkbench && !!cur.card && !next.card && !next.issue;
    const closingCardIssue = sameWorkbench && !!cur.card && cur.card === next.card && !!cur.issue && !next.issue;
    const back = closingCard ? previous.workbench : closingCardIssue ? previous.cardList : undefined;
    // 只回到由本页记录的入口，直接打开的链接使用 replace，避免返回到站外或形成返回循环。
    if (back?.hash === hash && Number.isSafeInteger(back.steps) && back.steps > 0) {
      history.go(-back.steps);
      return;
    }
    const replace = cur.project === undefined || closingCard || closingCardIssue;
    const state: NavigationHistory = {};
    if (sameWorkbench && next.card) {
      const advance = (target: BackTarget): BackTarget => ({ ...target, steps: target.steps + (replace ? 0 : 1) });
      if (!cur.card && !cur.issue) state.workbench = { hash: toHash({ ...cur, project: cur.project ?? null }), steps: 1 };
      else if (previous.workbench) state.workbench = advance(previous.workbench);
      if (next.issue && cur.card === next.card) {
        if (!cur.issue) state.cardList = { hash: toHash({ ...cur, project: cur.project ?? null }), steps: 1 };
        else if (previous.cardList) state.cardList = advance(previous.cardList);
      }
    }
    // 补全旧地址/空地址时不留历史记录，避免「后退」回到无项目的地址又被补回来
    if (replace) history.replaceState(state, '', hash);
    else history.pushState(state, '', hash);
    setRoute(parseHash(hash));
  }, []);
  return [route, update];
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [authState, setAuthState] = useState<'checking' | 'out' | 'in' | 'offline'>('checking');

  const checkAuth = useCallback(async () => {
    try {
      setMe(await api.me());
      setAuthState('in');
    } catch (e) {
      setAuthState(e instanceof ApiError && e.status === 401 ? 'out' : 'offline');
    }
  }, []);

  useEffect(() => {
    checkAuth();
    setUnauthorizedListener(() => setAuthState('out'));
    return () => setUnauthorizedListener(null);
  }, [checkAuth]);

  if (authState === 'checking') return <div className="state">正在连接…</div>;
  if (authState === 'offline')
    return <ErrorState error={new Error('无法连接本地代理，请确认已执行 npm run dev')} onRetry={checkAuth} />;
  if (authState === 'out' || !me) return <Login onDone={checkAuth} />;
  return (
    <SessionProvider me={me}>
      <ToolsProvider key={`${me.jiraBaseUrl}:${me.name}`}>
      <Workspace
        onLogout={async () => {
          await api.logout().catch(() => {});
          setAuthState('out');
        }}
      />
      </ToolsProvider>
    </SessionProvider>
  );
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const PAGE_LABEL: Record<Page, string> = { me: '我的工作台', hours: '我的工时', tree: '需求树', flat: '全部问题', board: '看板', mcp: 'MCP 服务', versions: '版本进展', notifications: '通知中心' };
const NAV: { label: string; pages: Page[] }[] = [
  { label: '个人', pages: ['me', 'hours', 'notifications'] },
  { label: '项目', pages: ['tree', 'flat', 'board', 'versions'] },
  { label: '设置', pages: ['mcp'] },
];

function Workspace({ onLogout }: { onLogout: () => void }) {
  const { me, bump, canWriteProject } = useSession();
  useWorkbenchMotion();
  const tools = useTools();
  const [route, go] = useRoute();
  const [creating, setCreating] = useState<CreateTarget | null>(null);
  const [palette, setPalette] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const mobileToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!mobileNav) return;
    const outside = (event: PointerEvent) => { if (!sidebar.current?.contains(event.target as Node)) setMobileNav(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMobileNav(false); mobileToggle.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [mobileNav]);
  const projects = useCachedAsync<Project[]>('projects', signal => api.projects(signal), []);

  // 地址里没写项目（首次打开、旧地址）：补成上次的项目
  useEffect(() => {
    if (route.project !== undefined || !projects.data) return;
    go({ project: pickProject(projects.data, loadLastProject(), canWriteProject) });
  }, [route.project, projects.data, go, canWriteProject]);
  // 当前项目 = 全局维度；null 是「全部项目」
  const pk = route.project ?? null;
  useEffect(() => saveLastProject(pk), [pk]);
  useEffect(() => setMobileNav(false), [route.page, pk]);

  // ⌘K / Ctrl+K：全局跳转（输入框里也生效，对话框打开时不抢）
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (document.querySelector('.modal-mask:not(.palette-mask)')) return;
      e.preventDefault();
      setPalette((v) => !v);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  // 「全部项目」下新建时在表单里选项目
  const writable = pk ? canWriteProject(pk) : me.allowWrite;
  const createIn = useCallback(
    (typeName?: string) => setCreating({ projectKey: pk, typeName }),
    [pk],
  );

  // 快捷键 C：新建（输入框内不触发）
  useEffect(() => {
    if (!writable || !['tree', 'flat'].includes(route.page)) return;
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key !== 'c' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (el.closest('input,textarea,select,[contenteditable]') || document.querySelector('.modal-mask')) return;
      e.preventDefault();
      createIn(route.page === 'tree' ? '需求' : undefined);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [writable, createIn, route.page]);
  // 筛选条件按项目记忆（localStorage），切项目时换成该项目上次的条件
  const [filterOf, setFilterOf] = useState(() => ({ project: pk, filter: sharedView()?.filter ?? initialFilter(pk) }));
  if (filterOf.project !== pk) setFilterOf({ project: pk, filter: initialFilter(pk) });
  const savedFilter = filterOf.project === pk ? filterOf.filter : initialFilter(pk);
  const setFilter = useCallback(
    (f: FilterState) => {
      setFilterOf({ project: pk, filter: f });
      if (pk) saveFilter(pk, f);
    },
    [pk],
  );
  const project = useCachedAsync(`project:${pk ?? '*'}`, signal => pk ? api.project(pk, signal) : Promise.resolve(null), [pk]);

  // 记住的模块/版本在项目里已不存在时忽略，避免 JQL 报错
  let filter = savedFilter;
  if (project.data && filter.component && !project.data.components?.some((c) => c.name === filter.component)) filter = { ...filter, component: '' };
  if (project.data && !isValidVersion(filter.version, project.data.versions)) filter = { ...filter, version: '' };

  const openIssue = useCallback((key: string) => go({ issue: key }), [go]);
  const closeIssue = useCallback(() => go({ issue: null }), [go]);
  const changeCard = useCallback((card: string | null) => go({ card, issue: null }), [go]);
  // 切项目：保留当前页面（全部项目下没有项目页面时回到工作台），关掉详情
  const switchProject = useCallback(
    (key: string | null) => go({ project: key, page: key === null && PROJECT_PAGES.includes(route.page) ? 'me' : route.page, issue: null, card: null }),
    [go, route.page],
  );
  const current = projects.data?.find((p) => p.key === pk);
  const projectPage = PROJECT_PAGES.includes(route.page);
  const scopeText = pk ? current?.name.replace(/^\d+-/, '') ?? pk : '全部项目';

  if (route.project === undefined) {
    return projects.error ? <ErrorState error={projects.error} onRetry={projects.reload} /> : <div className="state">正在加载项目…</div>;
  }

  return (
    <div className={`app${mobileNav ? ' nav-open' : ''}`}>
      <nav ref={sidebar} className="sidebar" aria-label="导航">
        <div className="brand">
          研发工作台
          <small>
            Jira 6 · {!me.allowWrite ? '只读' : me.writeProjects.length ? `可写 ${me.writeProjects.join(',')}` : '读写'}
          </small>
        </div>
        <ProjectSwitcher projects={projects.data} current={pk} onPick={switchProject} canWrite={canWriteProject} />
        <button ref={mobileToggle} className="btn mobile-nav-toggle" aria-label={mobileNav ? '收起导航' : '展开导航'} aria-expanded={mobileNav} aria-controls="workspace-navigation" onClick={() => setMobileNav(open => !open)}>{mobileNav ? '收起' : '菜单'} ☰</button>
        <div id="workspace-navigation" className="sidebar-navigation">
        <button className="side-jump" onClick={() => setPalette(true)} title="快速跳转（⌘K / Ctrl+K）">
          <span>跳转到问题…</span>
          <kbd>{IS_MAC ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        {NAV.map((g) => (
          <div key={g.label}>
            <div className="side-label">{g.label}</div>
            <div className="side-nav">
              {g.pages.map((p) => {
                const disabled = pk === null && PROJECT_PAGES.includes(p);
                return (
                  <button
                    key={p}
                    aria-current={route.page === p}
                    disabled={disabled}
                    title={disabled ? '请先选择具体项目' : undefined}
                    onClick={() => { go({ page: p, issue: null, card: null }); setMobileNav(false); }}
                  >
                    {PAGE_LABEL[p]}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {projects.error && <span className="muted">项目加载失败</span>}
        <div className="side-foot">
          <ThemeToggle /><span>{me.name}</span>
          <button onClick={onLogout}>退出</button>
        </div>
        </div>
      </nav>

      <main className="main">
        <header className="topbar">
          <div className="title-block">
            <h1>{PAGE_LABEL[route.page]}</h1>
            <div className="sub">
              <span className="scope-tag">{route.page === 'mcp' ? '本机设置' : scopeText}</span>
              {route.page === 'me' && '我参与的事项、临期风险与最近完成工作'}
              {route.page === 'hours' && '开发人员是我的问题，按时间统计（按父需求分组）'}
              {projectPage && '父子关系按「子项 blocks 需求」识别'}
            </div>
          </div>

        </header>

        {projectPage && route.page !== 'versions' && pk && (
          <FilterBar
            projectKey={pk}
            value={filter}
            onChange={setFilter}
            components={project.data?.components ?? []}
            versions={project.data?.versions}
            showStages
            showTypes={route.page !== 'tree'}
          >
            {writable && route.page === 'tree' ? (
              <button className="btn primary" title="快捷键 C" onClick={() => createIn('需求')}>＋ 新建需求</button>
            ) : writable && route.page === 'flat' ? (
              <NewButton onCreate={createIn} />
            ) : !writable ? (
              <span
                className="muted readonly-tag"
                title={
                  me.allowWrite
                    ? `你在 Jira 里有权限；工作台出于安全只开放了 ${me.writeProjects.join(',')} 的写入（WB_WRITE_PROJECTS）`
                    : '工作台以只读模式启动（未设置 WB_ALLOW_WRITE=1）'
                }
              >
                工作台未开放此项目写入
              </span>
            ) : null}
          </FilterBar>
        )}

        <div className="content" style={projectPage ? undefined : { paddingTop: 16 }}>
          <Suspense fallback={<Loading rows={6}/>}>
          {route.page === 'mcp' && <McpView />}
          {route.page === 'hours' && <HoursWorkspace key={pk ?? '*'} projectKey={pk} onOpen={openIssue} tab={route.tab === 'review' ? 'review' : 'report'} onTabChange={tab => go({ tab: tab === 'review' ? 'review' : null })} />}
          {route.page === 'versions' && pk && <VersionView key={pk} projectKey={pk} onOpen={openIssue}/>}
          {route.page === 'notifications' && <NotificationsView projectKey={pk} onOpen={openIssue} onMcp={()=>go({page:'mcp',issue:null})}/>}
          {route.page === 'me' && <MyWorkView projectKey={pk} onOpen={openIssue} cardId={route.card ?? null} onCardChange={changeCard} />}
          {projectPage && pk && project.error && <ErrorState error={project.error} onRetry={project.reload} />}
          {projectPage && pk && !project.error && !project.data && <Loading />}
          {projectPage && pk && project.data && (route.page === 'tree' || route.page === 'flat') && (
            <TreeView
              projectKey={pk}
              filter={filter}
              mode={route.page === 'flat' ? 'flat' : 'tree'}
              selectedKey={route.issue}
              onOpen={openIssue}
              onCreate={setCreating}
              onFilterChange={setFilter}
            />
          )}
          {projectPage && pk && project.data && route.page === 'board' && <BoardView projectKey={pk} filter={filter} onOpen={openIssue} />}
          </Suspense>
        </div>
      </main>

      <Suspense fallback={<div className="drawer-loading" role="status">正在打开…</div>}>
      {route.issue && (
        <IssueDrawer
          issueKey={route.issue}
          jiraBaseUrl={me.jiraBaseUrl}
          currentProject={pk}
          onSwitchProject={(key) => go({ project: key, issue: route.issue, card: null })}
          onOpen={openIssue}
          onClose={closeIssue}
          onCreate={setCreating}
        />
      )}
      </Suspense>
      {palette && (
        <CommandPalette
          projects={projects.data ?? []}
          currentProject={pk}
          onOpenIssue={openIssue}
          onOpenProject={switchProject}
          onClose={() => setPalette(false)}
        />
      )}
      <Suspense fallback={null}>{route.page === 'me' && <Toolbox data={tools.data} save={tools.save}/>}</Suspense>
      <Suspense fallback={<div className="drawer-loading" role="status">正在打开表单…</div>}>
      {creating && (
        <CreateDialog
          target={creating}
          onClose={() => setCreating(null)}
          onCreated={() => bump()}
        />
      )}
      </Suspense>
    </div>
  );
}

const NEW_TYPES = [
  { name: '需求', key: '1' },
  { name: '编码任务', key: '2' },
  { name: 'BUG及数据问题', key: '3' },
  { name: '其他任务', key: '4' },
];

/** 新建按钮：主按钮按当前视图默认类型，下拉直接选类型 */
function NewButton({ onCreate, defaultType }: { onCreate: (typeName?: string) => void; defaultType?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return close();
      const t = NEW_TYPES.find((x) => x.key === e.key);
      if (t) {
        e.preventDefault();
        close();
        onCreate(t.name);
      }
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onCreate]);
  return (
    <span className="split">
      <button className="btn primary" title="快捷键 C" onClick={() => onCreate(defaultType)}>
        ＋ 新建{defaultType ?? '问题'}
      </button>
      <button
        className="btn primary caret-btn"
        aria-label="选择新建类型"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ▾
      </button>
      {open && (
        <div className="pop" role="menu">
          {NEW_TYPES.map((t) => (
            <button key={t.name} role="menuitem" onClick={() => onCreate(t.name)}>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <TypeBadge type={t.name} /> {t.name}
              </span>
              <kbd>{t.key}</kbd>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

function initialFilter(project: string | null): FilterState {
  return project ? loadFilter(project) : DEFAULT_FILTER;
}
