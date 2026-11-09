import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import {
  BASIS_LABEL, buildReport, dateOf, formatHours, hoursOf, MEASURE_LABEL, periodKey, periodsBetween, presetRange, RANGE_LABEL,
  resolveHourFields, type Basis, type Granularity, type HourFields, type HourItem, type HourRow, type Measure, type RangePreset,
} from '../lib/hours';
import { buildJql, quote } from '../lib/jql';
import { STAGES, type StageId } from '../lib/stages';
import { NO_VERSION, versionGroups } from '../lib/versions';
import { useAsync } from '../lib/useAsync';
import { useSession } from '../lib/session';
import type { Issue } from '../lib/types';
import { StatusPill, TypeBadge } from '../components/Badges';
import { Empty, ErrorState, Loading } from '../components/States';
import { StatisticPlans } from '../components/StatisticPlans';
import { scopeKey } from '../lib/management';
import { DailyImportDialog } from '../components/DailyImportDialog';

type Panel = 'cards' | 'chart' | 'table';
type Column = 'project' | 'status' | 'date' | 'periods';
type Who = 'dev' | 'devOrAssignee';

interface HourFilters {
  text: string;
  stages: StageId[];
  priority: string;
  component: string;
  version: string;
  extraJql: string;
}

const EMPTY_FILTERS: HourFilters = { text: '', stages: [], priority: '', component: '', version: '', extraJql: '' };

interface Settings {
  range: RangePreset;
  custom: { from: string; to: string };
  granularity: Granularity;
  basis: Basis;
  measure: Measure;
  who: Who;
  hoursPerDay: number;
  unit: 'h' | 'd';
  panels: Panel[];
  columns: Column[];
  types: string[];
  grouped: boolean;
  excludeRequirementBugs: boolean;
  filtersByProject: Record<string, HourFilters>;
}

const STORE = 'wb.hours.v1';
const DEFAULTS: Settings = {
  range: 'thisMonth',
  custom: presetRange('last30'),
  granularity: 'week',
  basis: 'devDone',
  measure: 'estimate',
  who: 'dev',
  hoursPerDay: 8,
  unit: 'h',
  panels: ['cards', 'chart', 'table'],
  columns: ['project', 'status', 'date', 'periods'],
  types: [],
  grouped: true,
  excludeRequirementBugs: true,
  filtersByProject: {},
};

function normalizeSettings(value:unknown):Settings {
  const x=value&&typeof value==='object'?value as Partial<Settings>:{};
  const list=<T extends string>(v:unknown,allowed:T[],fallback:T[])=>Array.isArray(v)?v.filter((i):i is T=>typeof i==='string'&&allowed.includes(i as T)):fallback;
  const filtersByProject:Settings['filtersByProject']={};
  if(x.filtersByProject&&typeof x.filtersByProject==='object')for(const [key,v]of Object.entries(x.filtersByProject)) {
    if(!v||typeof v!=='object')continue;
    filtersByProject[key]={text:typeof v.text==='string'?v.text:'',stages:list(v.stages,['todo','design','dev','test','done','hold'],[]),priority:typeof v.priority==='string'?v.priority:'',component:typeof v.component==='string'?v.component:'',version:typeof v.version==='string'?v.version:'',extraJql:typeof v.extraJql==='string'?v.extraJql:''};
  }
  const custom=x.custom&&/^\d{4}-\d{2}-\d{2}$/.test(x.custom.from)&&/^\d{4}-\d{2}-\d{2}$/.test(x.custom.to)&&x.custom.from<=x.custom.to?x.custom:DEFAULTS.custom;
  return {...DEFAULTS,range:Object.hasOwn(RANGE_LABEL,String(x.range))?x.range!:DEFAULTS.range,custom,granularity:['day','week','month'].includes(String(x.granularity))?x.granularity!:'week',basis:Object.hasOwn(BASIS_LABEL,String(x.basis))?x.basis!:'devDone',measure:x.measure==='spent'?'spent':'estimate',who:x.who==='devOrAssignee'?'devOrAssignee':'dev',hoursPerDay:typeof x.hoursPerDay==='number'&&Number.isFinite(x.hoursPerDay)?Math.min(24,Math.max(1,x.hoursPerDay)):8,unit:x.unit==='d'?'d':'h',panels:list(x.panels,['cards','chart','table'],DEFAULTS.panels),columns:list(x.columns,['project','status','date','periods'],DEFAULTS.columns),types:list(x.types,['编码任务','BUG及数据问题','其他任务','需求'],[]),grouped:x.grouped!==false,excludeRequirementBugs:x.excludeRequirementBugs!==false,filtersByProject};
}
function loadSettings(): Settings {
  try { return normalizeSettings(JSON.parse(localStorage.getItem(STORE) || 'null')); }
  catch { return DEFAULTS; }
}

const PANEL_LABEL: Record<Panel, string> = { cards: '汇总卡片', chart: '趋势图', table: '明细表' };
const COLUMN_LABEL: Record<Column, string> = { project: '项目', status: '状态', date: '统计日期', periods: '按周期分列' };
const GRAN_LABEL: Record<Granularity, string> = { day: '按日', week: '按周', month: '按月' };
const TYPES = ['编码任务', 'BUG及数据问题', '其他任务', '需求'];
const MAX_ISSUES = 1000;
const MAX_PERIOD_COLS = 14;

const FIELDS_BASE = ['summary', 'status', 'issuetype', 'project', 'issuelinks', 'created', 'updated', 'resolutiondate', 'timespent', 'customfield_10204', 'assignee'];

function whoClause(who: Who) {
  return who === 'dev' ? 'cf[10204] = currentUser()' : '(cf[10204] = currentUser() OR assignee = currentUser())';
}

function cf(id: string) {
  return id.startsWith('customfield_') ? `cf[${id.slice('customfield_'.length)}]` : id;
}

/** 日期口径落到 JQL，减少拉取量；同名字段在多个项目各有 id，用 OR 合并 */
export function hoursJql(s: Settings, f: HourFields, range: { from: string; to: string }, projectKey: string | null = null): string {
  const parts = [whoClause(s.who)];
  if (projectKey) parts.unshift(`project = ${quote(projectKey)}`);
  if (s.types.length) parts.push(`issuetype in (${s.types.map(quote).join(', ')})`);
  const between = (field: string) => `(${field} >= ${quote(range.from)} AND ${field} <= ${quote(range.to)})`;
  if (s.basis === 'created' || s.basis === 'updated') {
    // datetime 字段：上界取次日 0 点
    parts.push(`(${s.basis} >= ${quote(range.from)} AND ${s.basis} < ${quote(nextDay(range.to))})`);
  } else {
    const ids = f[s.basis].map(cf);
    const own = ids.map(between);
    // 开发完成口径：没填/没有该字段的已解决问题按解决日期归属（与 dateOf 一致）
    if (s.basis === 'devDone') {
      const empty = ids.map((id) => `${id} is EMPTY`);
      own.push(`(resolved >= ${quote(range.from)} AND resolved < ${quote(nextDay(range.to))}${empty.length ? ` AND ${empty.join(' AND ')}` : ''})`);
    }
    parts.push(own.length ? `(${own.join(' OR ')})` : 'key = "NONE-0"');
  }
  const filters = s.filtersByProject[projectKey ?? '*'] ?? EMPTY_FILTERS;
  const filterClause = buildJql({ text: filters.text, stages: filters.stages, component: filters.component, version: filters.version }, '');
  if (filterClause) parts.push(filterClause);
  if (filters.priority) parts.push(`priority = ${quote(filters.priority)}`);
  if (filters.extraJql.trim()) parts.push(`(${filters.extraJql.trim()})`);
  if (s.measure === 'spent') parts.push('timespent > 0');
  return `${parts.join(' AND ')} ORDER BY updated DESC`;
}

function nextDay(ymdStr: string) {
  const [y, m, d] = ymdStr.split('-').map(Number);
  const n = new Date(y, m - 1, d + 1);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

async function fetchAll(jql: string, fields: string[], signal: AbortSignal): Promise<{ issues: Issue[]; total: number }> {
  const out: Issue[] = [];
  let total = 0;
  for (let start = 0; start < MAX_ISSUES; start += 100) {
    const r = await api.search(jql, { startAt: start, maxResults: 100, fields }, signal);
    total = r.total;
    out.push(...r.issues);
    if (start + 100 >= r.total) break;
  }
  return { issues: out, total };
}

export function HoursView({ projectKey, onOpen }: { projectKey: string | null; onOpen: (key: string) => void }) {
  const { version, me, bump, toast } = useSession();
  const [importing, setImporting] = useState(false);
  const [s, setS] = useState<Settings>(loadSettings);
  const [showConfig, setShowConfig] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 点「未填工时」卡片：表格只看没填工时的问题
  const [onlyMissing, setOnlyMissing] = useState(false);
  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { toast('无法保存工时设置','error'); } }, [s, toast]);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => ({ ...x, [k]: v }));
  const toggleIn = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const filterKey = projectKey ?? '*';
  const filters = s.filtersByProject[filterKey] ?? EMPTY_FILTERS;
  const setFilters = (patch: Partial<HourFilters>) => setS((prev) => ({
    ...prev,
    filtersByProject: { ...prev.filtersByProject, [filterKey]: { ...(prev.filtersByProject[filterKey] ?? EMPTY_FILTERS), ...patch } },
  }));
  const [searchText, setSearchText] = useState(filters.text);
  useEffect(() => setSearchText(filters.text), [filters.text, filterKey]);
  useEffect(() => {
    if (searchText === filters.text) return;
    const timer = setTimeout(() => setFilters({ text: searchText }), 350);
    return () => clearTimeout(timer);
  }, [searchText, filters.text, filterKey]);
  const hasFilters = !!(filters.text || filters.stages.length || filters.priority || filters.component || filters.version || filters.extraJql);
  const project = useAsync(() => projectKey ? api.project(projectKey) : Promise.resolve(null), [projectKey]);
  const priorities = useAsync(() => api.priorities(), []);

  const range = useMemo(() => presetRange(s.range, new Date(), s.custom), [s.range, s.custom]);
  const fieldDefs = useAsync(() => api.fields(), []);
  const hf = useMemo(() => (fieldDefs.data ? resolveHourFields(fieldDefs.data) : null), [fieldDefs.data]);
  const jql = hf ? hoursJql(s, hf, range, projectKey) : null;
  const data = useAsync(
    (signal) =>
      jql && hf
        ? fetchAll(jql, [...FIELDS_BASE, ...hf.estimate, ...hf.devStart, ...hf.devDone], signal)
        : new Promise<never>(() => {}),
    [jql, version],
  );

  const periods = useMemo(() => periodsBetween(range.from, range.to, s.granularity), [range, s.granularity]);
  const report = useMemo(() => {
    if (!data.data || !hf) return null;
    const items: HourItem[] = data.data.issues.map((issue) => {
      const date = dateOf(issue, hf, s.basis);
      return { issue, hours: hoursOf(issue, hf, s), date, period: date ? periodKey(date, s.granularity) : null };
    });
    return buildReport(items, { grouped: s.grouped, excludeRequirementBugs: s.excludeRequirementBugs });
  }, [data.data, hf, s]);

  // 与 buildReport 的计数口径一致：有子项只看子项，否则看自身
  const missingRows = useMemo(() => {
    if (!report) return [];
    return report.rows.flatMap((r) => {
      if (r.children.length) {
        const kids = r.children.filter((c) => c.hours === null);
        return kids.length ? [{ ...r, children: kids, total: 0, byPeriod: {} }] : [];
      }
      return r.own && r.own.hours === null ? [r] : [];
    });
  }, [report]);
  const missingKeys = missingRows.flatMap((r) => (r.children.length ? r.children.map((c) => c.issue.key) : [r.key]));
  const showMissing = onlyMissing && missingRows.length > 0;
  const tableRows = showMissing ? missingRows : report?.rows ?? [];
  const tableExpanded = showMissing ? new Set([...expanded, ...missingRows.filter((r) => r.children.length).map((r) => r.key)]) : expanded;

  const fmt = (h: number | null | undefined) => formatHours(h, s.hoursPerDay, s.unit);
  const showPeriods = s.columns.includes('periods') && periods.length <= MAX_PERIOD_COLS;
  const maxBar = report ? Math.max(1, ...periods.map((p) => report.byPeriod[p.key] ?? 0)) : 1;
  const activePeriods = report ? periods.filter((p) => (report.byPeriod[p.key] ?? 0) > 0).length : 0;

  const error = fieldDefs.error ?? data.error;

  return (
    <div className="hours">
      {importing && hf && <DailyImportDialog hourFields={hf} projectKey={projectKey} onClose={() => setImporting(false)} onCreated={() => bump()} />}
      <StatisticPlans store={`wb.hourPlans.v1:${scopeKey(me.jiraBaseUrl,me.name,projectKey)}`} value={s} normalize={normalizeSettings} onApply={setS}/>
      <div className="hours-bar">
        <div className="check-group" role="group" aria-label="时间范围">
          {(Object.keys(RANGE_LABEL) as RangePreset[]).map((r) => (
            <button key={r} className="chip" aria-pressed={s.range === r} onClick={() => set('range', r)}>
              {RANGE_LABEL[r]}
            </button>
          ))}
          {s.range === 'custom' && (
            <span className="date-range">
              <input className="input" type="date" aria-label="开始日期" value={s.custom.from} max={s.custom.to} onChange={(e) => e.target.value && set('custom', { ...s.custom, from: e.target.value })} />
              <span className="muted">至</span>
              <input className="input" type="date" aria-label="结束日期" value={s.custom.to} min={s.custom.from} onChange={(e) => e.target.value && set('custom', { ...s.custom, to: e.target.value })} />
            </span>
          )}
        </div>
        <div className="check-group" role="group" aria-label="粒度">
          {(Object.keys(GRAN_LABEL) as Granularity[]).map((g) => (
            <button key={g} className="chip" aria-pressed={s.granularity === g} onClick={() => set('granularity', g)}>
              {GRAN_LABEL[g]}
            </button>
          ))}
          <span className="grow" />
          {me.allowWrite && (
            <button className="btn small primary" disabled={!hf} title="粘贴每日汇总，自动拆分并批量新建任务" onClick={() => setImporting(true)}>
              ＋ 从日报新建
            </button>
          )}
          <button className="btn small" aria-expanded={showConfig} onClick={() => setShowConfig((v) => !v)}>
            ⚙ 统计条件与面板
          </button>
        </div>
        {showConfig && (
          <div className="hours-config">
            <div className="cfg-group">
              <span>统计条件（同时满足，同组状态任选其一）</span>
              <div className="check-group">
                <input className="input" type="search" aria-label="工时搜索" placeholder="标题关键字或问题编号" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
                <select className="select" aria-label="工时优先级" value={filters.priority} disabled={priorities.loading || !!priorities.error} onChange={(e) => setFilters({ priority: e.target.value })}>
                  <option value="">全部优先级</option>
                  {filters.priority && !priorities.data?.some((p) => p.name === filters.priority) && <option value={filters.priority}>{filters.priority}</option>}
                  {priorities.data?.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
                </select>
                {projectKey && <>
                  <select className="select" aria-label="工时模块" value={filters.component} disabled={project.loading || !!project.error} onChange={(e) => setFilters({ component: e.target.value })}>
                    <option value="">全部模块</option>
                    {filters.component && !project.data?.components.some((c) => c.name === filters.component) && <option value={filters.component}>{filters.component}（当前不可用）</option>}
                    {project.data?.components.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                  </select>
                  <select className="select" aria-label="工时影响版本" value={filters.version} disabled={project.loading || !!project.error} onChange={(e) => setFilters({ version: e.target.value })}>
                    <option value="">全部影响版本</option>
                    <option value={NO_VERSION}>未设置版本</option>
                    {filters.version && filters.version !== NO_VERSION && !project.data?.versions?.some((v) => v.name === filters.version) && <option value={filters.version}>{filters.version}（当前不可用）</option>}
                    {versionGroups(project.data?.versions).map((g) => <optgroup key={g.label} label={g.label}>{g.items.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}</optgroup>)}
                  </select>
                </>}
                {hasFilters && <button className="btn small ghost" onClick={() => { setSearchText(''); setFilters(EMPTY_FILTERS); }}>清空统计条件</button>}
              </div>
              {(project.error || priorities.error) && <span className="muted">筛选选项加载失败：{(project.error ?? priorities.error)?.message}</span>}
              <div className="check-group" role="group" aria-label="工时状态">
                {STAGES.map((stage) => <button key={stage.id} className="chip" aria-pressed={filters.stages.includes(stage.id)} title={stage.statuses.join('、')} onClick={() => setFilters({ stages: toggleIn(filters.stages, stage.id) })}>{stage.name}</button>)}
                {!filters.stages.length && <span className="muted">不选即全部状态</span>}
              </div>
              <label>
                <span>补充 JQL 条件（可选）</span>
                <input className="input" aria-label="补充 JQL 条件" placeholder={'如 labels = "加班" 或 cf[12345] = "是"，填写后按回车或移出输入框生效'} key={`${filterKey}:${filters.extraJql}`} defaultValue={filters.extraJql} onBlur={(e) => setFilters({ extraJql: e.target.value.trim() })} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
                <span className="muted">与上面的条件取交集，仅填写条件，不含 ORDER BY；语法错误会显示 Jira 返回的原因。</span>
              </label>
            </div>
            <label>
              <span>统计谁</span>
              <select className="select" value={s.who} onChange={(e) => set('who', e.target.value as Who)}>
                <option value="dev">开发人员是我</option>
                <option value="devOrAssignee">开发人员或经办人是我</option>
              </select>
            </label>
            <label>
              <span>工时取值</span>
              <select className="select" value={s.measure} onChange={(e) => set('measure', e.target.value as Measure)}>
                {(Object.keys(MEASURE_LABEL) as Measure[]).map((m) => (
                  <option key={m} value={m}>
                    {MEASURE_LABEL[m]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>按哪个日期归属</span>
              <select className="select" value={s.basis} onChange={(e) => set('basis', e.target.value as Basis)}>
                {(Object.keys(BASIS_LABEL) as Basis[]).map((b) => (
                  <option key={b} value={b}>
                    {BASIS_LABEL[b]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Bug 工时</span>
              <select className="select" value={s.excludeRequirementBugs ? 'exclude' : 'include'} onChange={(e) => set('excludeRequirementBugs', e.target.value === 'exclude')}>
                <option value="exclude">排除关联需求的 Bug</option>
                <option value="include">全部计入</option>
              </select>
              <span className="muted">关联需求指通过 blocks 挂在父需求下。</span>
            </label>
            <label>
              <span>每天工时</span>
              <input className="input" type="number" min={1} max={24} step={0.5} value={s.hoursPerDay} onChange={(e) => set('hoursPerDay', Math.min(24, Math.max(1, Number(e.target.value) || 8)))} />
            </label>
            <label>
              <span>显示单位</span>
              <select className="select" value={s.unit} onChange={(e) => set('unit', e.target.value as 'h' | 'd')}>
                <option value="h">小时</option>
                <option value="d">人天</option>
              </select>
            </label>
            <div className="cfg-group">
              <span>问题类型</span>
              <div className="check-group">
                {TYPES.map((t) => (
                  <button key={t} className="chip" aria-pressed={s.types.includes(t)} onClick={() => set('types', toggleIn(s.types, t))}>
                    {t}
                  </button>
                ))}
                {s.types.length === 0 && <span className="muted">不选即全部</span>}
              </div>
            </div>
            <div className="cfg-group">
              <span>显示</span>
              <div className="check-group">
                {(Object.keys(PANEL_LABEL) as Panel[]).map((p) => (
                  <button key={p} className="chip" aria-pressed={s.panels.includes(p)} onClick={() => set('panels', toggleIn(s.panels, p))}>
                    {PANEL_LABEL[p]}
                  </button>
                ))}
                {(Object.keys(COLUMN_LABEL) as Column[]).filter((c) => !(projectKey && c === 'project')).map((c) => (
                  <button key={c} className="chip" aria-pressed={s.columns.includes(c)} onClick={() => set('columns', toggleIn(s.columns, c))}>
                    {COLUMN_LABEL[c]}
                  </button>
                ))}
                <button className="chip" aria-pressed={s.grouped} onClick={() => set('grouped', !s.grouped)}>
                  按父需求分组
                </button>
              </div>
            </div>
            <div className="cfg-foot">
              <span className="muted">设置保存在本机浏览器，新增统计条件按项目分别记忆。</span>
              <button className="btn small ghost" onClick={() => setS({ ...DEFAULTS, custom: s.custom })}>
                恢复默认
              </button>
            </div>
          </div>
        )}
        <div className="hours-note muted">
          {range.from} ~ {range.to} · {s.who === 'dev' ? '开发人员是我' : '开发人员或经办人是我'} · {MEASURE_LABEL[s.measure]} · 按「{BASIS_LABEL[s.basis]}」归属
          {s.measure === 'estimate' && ' · 有子项的需求只计子项，避免重复'}
          {s.excludeRequirementBugs ? ' · 排除关联需求的 Bug' : ' · Bug 全部计入'}
          {hasFilters && ' · 已启用自定义统计条件'}
          {!!report?.excludedBugs && `（已排除 ${report.excludedBugs} 条）`}
        </div>
      </div>

      {error && <ErrorState error={error} onRetry={data.reload} />}
      {!error && !report && <Loading rows={6} />}
      {!error && report && data.data && (
        <>
          {data.data.total > data.data.issues.length && (
            <div className="banner" style={{ margin: '0 0 10px' }}>
              共 {data.data.total} 条，只统计了前 {data.data.issues.length} 条，请缩小时间范围
            </div>
          )}
          {report.rows.length === 0 ? (
            <Empty text={s.measure === 'spent' ? '该范围内没有登记工时的问题（大部分项目未使用 Jira 工时登记，可切换为「开发预估时间」）' : '该范围内没有符合条件的问题'} />
          ) : (
            <>
              {s.panels.includes('cards') && (
                <div className="stat-row">
                  <div className="stat">
                    <b>{fmt(report.total)}</b>
                    <span>合计</span>
                  </div>
                  <div className="stat" style={{ animationDelay: '60ms' }}>
                    <b>{report.counted}</b>
                    <span>计入问题数</span>
                  </div>
                  <div className="stat" style={{ animationDelay: '120ms' }}>
                    <b>{fmt(activePeriods ? report.total / activePeriods : 0)}</b>
                    <span>每{s.granularity === 'day' ? '日' : s.granularity === 'week' ? '周' : '月'}平均（有数据的）</span>
                  </div>
                  <button
                    className="stat stat-btn"
                    style={{ animationDelay: '180ms' }}
                    disabled={!report.noHours}
                    aria-pressed={showMissing}
                    title={report.noHours ? `${missingKeys.join('、')}\n点击${showMissing ? '显示全部' : '只看这些问题'}` : '没有未填工时的问题'}
                    onClick={() => setOnlyMissing((v) => !v)}
                  >
                    <b style={{ color: report.noHours ? 'var(--warn)' : undefined }}>{report.noHours}</b>
                    <span>{showMissing ? '未填工时 · 点击显示全部' : '未填工时'}</span>
                  </button>
                </div>
              )}
              {s.panels.includes('chart') && (
                <div className="hours-chart" role="img" aria-label="工时趋势">
                  {periods.map((p, i) => {
                    const v = report.byPeriod[p.key] ?? 0;
                    return (
                      <div className="hc-col" key={p.key} title={`${p.from} ~ ${p.to}：${fmt(v)}`}>
                        <span className="hc-val">{v ? fmt(v) : ''}</span>
                        <span className="hc-bar" style={{ height: `${(v / maxBar) * 100}%`, animationDelay: `${i * 25}ms` }} />
                        <span className="hc-label">{p.label}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {showMissing && s.panels.includes('table') && (
                <div className="banner hours-missing">
                  <span>
                    只看未填「{MEASURE_LABEL[s.measure]}」的 {missingKeys.length} 个问题，点击行打开详情补填
                  </span>
                  <button className="btn small" onClick={() => setOnlyMissing(false)}>
                    显示全部
                  </button>
                </div>
              )}
              {s.panels.includes('table') && (
                <HoursTable
                  rows={tableRows}
                  periods={showPeriods ? periods : []}
                  // 选了具体项目时「项目」列没有信息量，不显示
                  columns={projectKey ? s.columns.filter((c) => c !== 'project') : s.columns}
                  expanded={tableExpanded}
                  grouped={s.grouped}
                  onToggle={(k) => setExpanded((e) => (e.has(k) ? new Set([...e].filter((x) => x !== k)) : new Set([...e, k])))}
                  onToggleAll={(open) => setExpanded(open ? new Set(report.rows.filter((r) => r.children.length).map((r) => r.key)) : new Set())}
                  fmt={fmt}
                  onOpen={onOpen}
                  total={showMissing ? 0 : report.total}
                  byPeriod={showMissing ? {} : report.byPeriod}
                />
              )}
              {s.columns.includes('periods') && periods.length > MAX_PERIOD_COLS && s.panels.includes('table') && (
                <p className="muted" style={{ fontSize: 12 }}>
                  周期数超过 {MAX_PERIOD_COLS} 个，明细表不分列；可改为按周/按月。
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

interface TableProps {
  rows: HourRow[];
  periods: { key: string; label: string }[];
  columns: Column[];
  expanded: Set<string>;
  grouped: boolean;
  onToggle: (key: string) => void;
  onToggleAll: (open: boolean) => void;
  fmt: (h: number | null | undefined) => string;
  onOpen: (key: string) => void;
  total: number;
  byPeriod: Record<string, number>;
}

function HoursTable({ rows, periods, columns, expanded, grouped, onToggle, onToggleAll, fmt, onOpen, total, byPeriod }: TableProps) {
  const col = (c: Column) => columns.includes(c);
  const anyKids = rows.some((r) => r.children.length);
  const allOpen = anyKids && rows.every((r) => !r.children.length || expanded.has(r.key));
  const cell = (v: number | undefined) => <td className="num hide-sm">{v ? fmt(v) : <span className="muted">·</span>}</td>;
  return (
    <div className="hours-table-wrap">
      <table className="tree-table hours-table">
        <thead>
          <tr>
            <th className="title-th">
              {grouped && anyKids ? (
                <button className="chip" style={{ height: 22 }} onClick={() => onToggleAll(!allOpen)}>
                  {allOpen ? '全部收起' : '全部展开'}
                </button>
              ) : (
                '问题'
              )}
            </th>
            {col('project') && <th className="hide-sm">项目</th>}
            {col('status') && <th className="hide-sm">状态</th>}
            {col('date') && <th className="hide-sm">统计日期</th>}
            {periods.map((p) => (
              <th key={p.key} className="num hide-sm">
                {p.label}
              </th>
            ))}
            <th className="num">工时</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => {
            const open = expanded.has(r.key);
            const own = r.own;
            return (
              <Fragment key={r.key}>
                <tr className="row" style={{ animationDelay: `${Math.min(idx, 20) * 15}ms` }} onClick={() => onOpen(r.key)}>
                  <td className="title-td">
                    <div className="title-cell">
                      {r.children.length ? (
                        <button
                          className="toggle"
                          aria-expanded={open}
                          aria-label={open ? '收起子项' : '展开子项'}
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggle(r.key);
                          }}
                        >
                          ▶
                        </button>
                      ) : (
                        grouped && anyKids && <span className="toggle-spacer" />
                      )}
                      <TypeBadge type={r.typeName} />
                      <span className="mono muted issue-key">{r.key}</span>
                      <span className="summary" title={r.summary}>
                        {r.summary}
                      </span>
                      {r.children.length > 0 && <span className="child-count">{r.children.length}</span>}
                      {!own && r.children.length > 0 && <span className="tag-soft" title="该需求的开发人员不是你，因子项被带出">关联需求</span>}
                      {own && r.children.length > 0 && own.hours !== null && (
                        <span className="tag-soft" title="需求自身的开发预估，不计入合计">需求预估 {fmt(own.hours)}</span>
                      )}
                    </div>
                  </td>
                  {col('project') && <td className="hide-sm mono muted">{r.key.split('-')[0]}</td>}
                  {col('status') && <td className="hide-sm">{r.status && <StatusPill status={r.status} />}</td>}
                  {col('date') && <td className="hide-sm mono muted">{r.children.length ? '' : own?.date ?? '-'}</td>}
                  {periods.map((p) => (
                    <Fragment key={p.key}>{cell(r.byPeriod[p.key])}</Fragment>
                  ))}
                  <td className="num strong">{r.children.length || own?.hours !== null ? fmt(r.total) : <span className="muted">未填</span>}</td>
                </tr>
                {open &&
                  r.children.map((c) => {
                    const f = c.issue.fields;
                    return (
                      <tr className="row child" key={c.issue.key} onClick={() => onOpen(c.issue.key)}>
                        <td className="title-td">
                          <div className="title-cell">
                            <TypeBadge type={f.issuetype.name} />
                            <span className="mono muted issue-key">{c.issue.key}</span>
                            <span className="summary" title={f.summary}>
                              {f.summary}
                            </span>
                          </div>
                        </td>
                        {col('project') && <td className="hide-sm mono muted">{c.issue.key.split('-')[0]}</td>}
                        {col('status') && (
                          <td className="hide-sm">
                            <StatusPill status={f.status.name} />
                          </td>
                        )}
                        {col('date') && <td className="hide-sm mono muted">{c.date ?? '-'}</td>}
                        {periods.map((p) => (
                          <Fragment key={p.key}>{cell(c.period === p.key && c.hours ? c.hours : undefined)}</Fragment>
                        ))}
                        <td className="num">{c.hours === null ? <span className="muted">未填</span> : fmt(c.hours)}</td>
                      </tr>
                    );
                  })}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td>合计</td>
            {col('project') && <td className="hide-sm" />}
            {col('status') && <td className="hide-sm" />}
            {col('date') && <td className="hide-sm" />}
            {periods.map((p) => (
              <Fragment key={p.key}>{cell(byPeriod[p.key])}</Fragment>
            ))}
            <td className="num strong">{fmt(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
