import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, setUnauthorizedListener, type Me } from './lib/api';
import { useCachedAsync } from './lib/requestCache';
import { ThemeToggle } from './components/ThemeToggle';
import { SessionProvider, useSession } from './lib/session';
import { CreateDialog, type CreateTarget } from './components/CreateDialog';
import type { Project } from './lib/types';
import { Login } from './components/Login';
import { FilterBar, DEFAULT_FILTER, type FilterState } from './components/FilterBar';
import { IssueDrawer } from './components/IssueDrawer';
import { ErrorState, Loading } from './components/States';
import { TreeView } from './views/TreeView';
import { BoardView } from './views/BoardView';
import { MyWorkView } from './views/MyWorkView';
import { sharedView } from './components/SavedViews';
import { ReviewView } from './views/ReviewView';
import { VersionView } from './views/VersionView';
import { NotificationsView } from './views/NotificationsView';
import { McpView } from './views/McpView';
import { HoursView } from './views/HoursView';
import { TypeBadge } from './components/Badges';
import { loadFilter, saveFilter } from './lib/filterPrefs';
import { CommandPalette } from './components/CommandPalette';
import { ProjectSwitcher } from './components/ProjectSwitcher';
import { isValidVersion } from './lib/versions';
import { loadLastProject, parseHash, pickProject, PROJECT_PAGES, saveLastProject, toHash, type Page, type Route } from './lib/route';

function useRoute(): [Route, (patch: Partial<Route>) => void] {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const update = useCallback((patch: Partial<Route>) => {
    const cur = parseHash(location.hash);
    const next = { ...cur, ...patch };
    const hash = toHash({ project: next.project ?? null, page: next.page, issue: next.issue });
    // 补全旧地址/空地址时不留历史记录，避免「后退」回到无项目的地址又被补回来
    if (cur.project === undefined) history.replaceState(null, '', hash), setRoute(parseHash(hash));
    else location.hash = hash;
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
      <Workspace
        onLogout={async () => {
          await api.logout().catch(() => {});
          setAuthState('out');
        }}
      />
    </SessionProvider>
  );
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const PAGE_LABEL: Record<Page, string> = { me: '我的工作台', hours: '我的工时', tree: '需求树', flat: '全部问题', board: '看板', mcp: 'MCP 服务', review: '工时检查与汇总', versions: '版本进展', notifications: '通知中心' };
const NAV: { label: string; pages: Page[] }[] = [
  { label: '个人', pages: ['me', 'hours', 'review', 'notifications'] },
  { label: '项目', pages: ['tree', 'flat', 'board', 'versions'] },
  { label: '设置', pages: ['mcp'] },
];

function Workspace({ onLogout }: { onLogout: () => void }) {
  const { me, bump, canWriteProject } = useSession();
  const [route, go] = useRoute();
  const [creating, setCreating] = useState<CreateTarget | null>(null);
  const [palette, setPalette] = useState(false);
  const projects = useCachedAsync<Project[]>('projects', signal => api.projects(signal), []);

  // 地址里没写项目（首次打开、旧地址）：补成上次的项目
  useEffect(() => {
    if (route.project !== undefined || !projects.data) return;
    go({ project: pickProject(projects.data, loadLastProject(), canWriteProject) });
  }, [route.project, projects.data, go, canWriteProject]);
  // 当前项目 = 全局维度；null 是「全部项目」
  const pk = route.project ?? null;
  useEffect(() => saveLastProject(pk), [pk]);

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
    if (!writable || route.page === 'mcp') return;
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
  // 切项目：保留当前页面（全部项目下没有项目页面时回到工作台），关掉详情
  const switchProject = useCallback(
    (key: string | null) => go({ project: key, page: key === null && PROJECT_PAGES.includes(route.page) ? 'me' : route.page, issue: null }),
    [go, route.page],
  );
  const current = projects.data?.find((p) => p.key === pk);
  const projectPage = PROJECT_PAGES.includes(route.page);
  const scopeText = pk ? current?.name.replace(/^\d+-/, '') ?? pk : '全部项目';

  if (route.project === undefined) {
    return projects.error ? <ErrorState error={projects.error} onRetry={projects.reload} /> : <div className="state">正在加载项目…</div>;
  }

  return (
    <div className="app">
      <nav className="sidebar" aria-label="导航">
        <div className="brand">
          研发工作台
          <small>
            Jira 6 · {!me.allowWrite ? '只读' : me.writeProjects.length ? `可写 ${me.writeProjects.join(',')}` : '读写'}
          </small>
        </div>
        <ProjectSwitcher projects={projects.data} current={pk} onPick={switchProject} canWrite={canWriteProject} />
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
                    onClick={() => go({ page: p, issue: null })}
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
          {!projectPage && route.page !== 'mcp' && writable && (
            <div className="topbar-actions">
              <NewButton onCreate={createIn} />
            </div>
          )}
        </header>

        {projectPage && route.page !== 'versions' && pk && (
          <FilterBar
            value={filter}
            onChange={setFilter}
            components={project.data?.components ?? []}
            versions={project.data?.versions}
            showStages
            showTypes={route.page !== 'tree'}
          >
            {writable ? (
              <NewButton onCreate={createIn} defaultType={route.page === 'tree' ? '需求' : undefined} />
            ) : (
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
            )}
          </FilterBar>
        )}

        <div className="content" style={projectPage ? undefined : { paddingTop: 16 }}>
          {route.page === 'mcp' && <McpView />}
          {route.page === 'review' && <ReviewView projectKey={pk} onOpen={openIssue}/>}
          {route.page === 'versions' && pk && <VersionView key={pk} projectKey={pk} onOpen={openIssue}/>}
          {route.page === 'notifications' && <NotificationsView projectKey={pk} onOpen={openIssue} onMcp={()=>go({page:'mcp',issue:null})}/>}
          {route.page === 'me' && <MyWorkView projectKey={pk} onOpen={openIssue} />}
          {route.page === 'hours' && <HoursView projectKey={pk} onOpen={openIssue} />}
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
        </div>
      </main>

      {route.issue && (
        <IssueDrawer
          issueKey={route.issue}
          jiraBaseUrl={me.jiraBaseUrl}
          currentProject={pk}
          onSwitchProject={(key) => go({ project: key, issue: route.issue })}
          onOpen={openIssue}
          onClose={closeIssue}
          onCreate={setCreating}
        />
      )}
      {palette && (
        <CommandPalette
          projects={projects.data ?? []}
          currentProject={pk}
          onOpenIssue={openIssue}
          onOpenProject={switchProject}
          onClose={() => setPalette(false)}
        />
      )}
      {creating && (
        <CreateDialog
          target={creating}
          onClose={() => setCreating(null)}
          onCreated={() => bump()}
        />
      )}
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
        ＋ 新建{defaultType ? defaultType : ''}
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
