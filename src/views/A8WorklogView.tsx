import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type A8Config, type A8PushResult, type A8Template, type A8TemplateProbe, type A8WorklogEntry } from '../lib/api';
import {
  entriesText, entryProblems, MAX_HOURS_PER_DAY, missingDays, monthOf, monthRange, shiftMonth, totalHours, weekdayLabel,
} from '../lib/a8';
import { useSession } from '../lib/session';
import { copyText } from '../lib/clipboard';
import { ErrorState, Loading } from '../components/States';

/** 描述框跟随内容自动增高（.input 固定 30px 高，需按 scrollHeight 覆盖） */
function AutoTextarea({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(240, el.scrollHeight + 2)}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className="input textarea a8-desc"
      value={value}
      aria-label={label}
      placeholder="补写当天的工作内容"
      onChange={(ev) => onChange(ev.target.value)}
    />
  );
}

/**
 * A8 工时补全：先查 A8 未填写工日，再按当月我的 Jira 任务让已配置模型生成草稿。
 * 只生成草稿，不直接写 A8；用户可逐条改，再复制到 A8 填报。
 */
export function A8WorklogView() {
  const { toast } = useSession();
  const [config, setConfig] = useState<A8Config | null>(null);
  const [configError, setConfigError] = useState('');
  const [editing, setEditing] = useState(false);
  const [month, setMonth] = useState(() => monthOf(new Date()));
  const [days, setDays] = useState<{ date: string; weekend: boolean }[] | null>(null);
  const [querying, setQuerying] = useState(false);
  const [queryError, setQueryError] = useState('');
  const [entries, setEntries] = useState<A8WorklogEntry[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');
  const [generateNote, setGenerateNote] = useState('');
  const [templates, setTemplates] = useState<A8Template[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [probe, setProbe] = useState<A8TemplateProbe | null>(null);
  const [templatesError, setTemplatesError] = useState('');
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState('');
  const [pushed, setPushed] = useState<A8PushResult | null>(null);
  const range = monthRange(month);

  useEffect(() => {
    let alive = true;
    api.a8Config().then(
      (c) => {
        if (!alive) return;
        setConfig(c);
        setTemplateId(c.templateId || '');
      },
      (e: Error) => alive && setConfigError(e.message),
    );
    return () => {
      alive = false;
    };
  }, []);

  // 换月后旧结果不再对应当前区间，直接清空
  useEffect(() => {
    setDays(null);
    setEntries(null);
    setQueryError('');
    setGenerateError('');
    setGenerateNote('');
  }, [month]);

  async function queryMissing() {
    setQuerying(true);
    setQueryError('');
    setEntries(null);
    try {
      const r = await api.a8Unfilled({ start: range.from, end: range.to });
      setDays(missingDays(r.dates, range.from, range.to));
    } catch (e) {
      setQueryError(e instanceof ApiError ? e.message : String((e as Error).message));
      setDays(null);
    } finally {
      setQuerying(false);
    }
  }

  async function generate() {
    if (!days?.length) return;
    setGenerating(true);
    setGenerateError('');
    setGenerateNote('');
    try {
      const r = await api.a8WorklogDraft({
        start: range.from,
        end: range.to,
        month,
        dates: days.map((d) => d.date),
        hoursPerDay: config?.llm.maxHoursPerTask || 8,
      });
      setEntries(r.entries);
      setGenerateNote(
        r.message
          ? r.message
          : `${r.model || '模型'} 生成 ${r.entries.length} 条，用时 ${((r.elapsedMs || 0) / 1000).toFixed(1)}s` +
              (r.failedBatches ? `；${r.failedBatches} 批失败（多为超时），对应日期留空` : '') +
              (r.incomplete ? '；有日期未生成描述，已标红，请补写后再复制' : ''),
      );
    } catch (e) {
      setGenerateError(e instanceof ApiError ? e.message : String((e as Error).message));
    } finally {
      setGenerating(false);
    }
  }

  async function loadTemplates() {
    setLoadingTemplates(true);
    setTemplatesError('');
    try {
      const r = await api.a8Templates();
      setTemplates(r.templates);
      if (!templateId && r.current) setTemplateId(r.current);
    } catch (e) {
      setTemplatesError(e instanceof ApiError ? e.message : String((e as Error).message));
    } finally {
      setLoadingTemplates(false);
    }
  }

  /** 选模板后立刻探测：让用户先看到「会填进哪个项目/任务」，再决定推不推 */
  async function pickTemplate(id: string) {
    setTemplateId(id);
    setProbe(null);
    setPushError('');
    setPushed(null);
    if (!id) return;
    try {
      setProbe(await api.a8ProbeTemplate(id));
    } catch (e) {
      setPushError(e instanceof ApiError ? e.message : String((e as Error).message));
    }
  }

  async function pushDraft() {
    if (!entries || !templateId || badCount) return;
    setPushing(true);
    setPushError('');
    setPushed(null);
    try {
      const r = await api.a8PushDraft({
        templateId,
        summary: `工时填报 ${range.from} ~ ${range.to}`,
        entries: entries.map((e) => ({
          activityDate: e.activityDate,
          jobType: e.jobType,
          hours: e.hours,
          description: e.description,
          jiraKeys: e.jiraKeys,
        })),
      });
      setPushed(r);
      toast(`已推送 ${r.days} 天到 A8 草稿`);
    } catch (e) {
      setPushError(e instanceof ApiError ? e.message : String((e as Error).message));
    } finally {
      setPushing(false);
    }
  }

  const problems = useMemo(() => (entries ?? []).map((e) => entryProblems(e)), [entries]);
  const badCount = problems.filter((p) => p.length).length;

  function patch(date: string, next: Partial<A8WorklogEntry>) {
    setEntries((list) => list?.map((e) => (e.activityDate === date ? { ...e, ...next } : e)) ?? list);
  }

  async function copyAll() {
    if (!entries) return;
    try {
      await copyText(entriesText(entries));
      toast(`已复制 ${entries.length} 天工时`);
    } catch {
      toast('复制失败，请手动选择文本', 'error');
    }
  }

  if (configError) return <ErrorState error={new Error(`读取 A8 配置失败：${configError}`)} onRetry={() => location.reload()} />;
  if (!config) return <Loading rows={4} />;

  return (
    <div className="a8-page">
      <div className="workspace-intro">
        <div>
          <h2>工时补全</h2>
          <p>从 A8 查询未填写工日，再按当月我的 Jira 任务生成草稿；只生成文本，不写入 A8。</p>
        </div>
        <div className="check-group">
          <button className="btn" onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label="上个月">
            ←
          </button>
          <input
            className="input a8-month"
            type="month"
            value={month}
            max={monthOf(new Date())}
            aria-label="工时月份"
            onChange={(e) => e.target.value && setMonth(e.target.value)}
          />
          <button className="btn" onClick={() => setMonth((m) => shiftMonth(m, 1))} disabled={month >= monthOf(new Date())} aria-label="下个月">
            →
          </button>
        </div>
      </div>

      <section className={`a8-card${config.configured ? ' is-ready' : ''}`}>
        <div className="a8-card-head">
          <div>
            <h3>A8 连接</h3>
            <p className="muted">
              {config.configured
                ? `${config.username} @ ${config.url}${config.cookieSet ? '（使用浏览器 Cookie）' : ''}`
                : '尚未配置。账号密码加密保存在本机，只由本地代理使用。'}
            </p>
          </div>
          <div className="check-group">
            {config.configured && <button className="btn" onClick={() => setEditing((v) => !v)}>{editing ? '收起' : '修改'}</button>}
            {!config.configured && <button className="btn primary" onClick={() => setEditing(true)}>开始配置</button>}
          </div>
        </div>
        {(editing || !config.configured) && (
          <A8ConfigForm
            config={config}
            onCancel={config.configured ? () => setEditing(false) : undefined}
            onSaved={(next) => {
              setConfig(next);
              setEditing(false);
              toast('A8 配置已保存');
            }}
          />
        )}
      </section>

      <section className="a8-card">
        <div className="a8-card-head">
          <div>
            <h3>1. 查询未填写工日</h3>
            <p className="muted">
              {month} 整月（{range.from} ~ {range.to}）
              {days && ` · ${days.length} 天未填`}
            </p>
          </div>
          <button className="btn primary" disabled={!config.configured || querying} onClick={queryMissing}>
            {querying ? '查询中…' : '查询未填工日'}
          </button>
        </div>
        {!config.configured && <p className="muted">请先完成 A8 连接配置。</p>}
        {queryError && <ErrorState error={new Error(queryError)} onRetry={queryMissing} />}
        {days && !days.length && <p className="a8-ok">本月没有未填写的工作日。</p>}
        {!!days?.length && (
          <div className="a8-days">
            {days.map((d) => (
              <span key={d.date} className={`chip a8-day${d.weekend ? ' weekend' : ''}`} title={d.weekend ? '周末（A8 仍返回未填）' : undefined}>
                <b>{d.date.slice(5)}</b>
                {weekdayLabel(d.date)}
              </span>
            ))}
          </div>
        )}
      </section>

      {!!days?.length && (
        <section className="a8-card">
          <div className="a8-card-head">
            <div>
              <h3>2. 生成工时草稿</h3>
              <p className="muted">
                读取 {month} 内指派或开发人员是我的 Jira 任务，交给当前配置的模型（{config.llm.model || '未配置'}）生成。
              </p>
            </div>
            <button className="btn primary" disabled={generating || !config.llm.enabled} onClick={generate}>
              {generating ? '生成中…' : entries ? '重新生成' : '生成草稿'}
            </button>
          </div>
          {!config.llm.enabled && (
            <p className="muted">未配置大模型，请在登录页「连接设置」填写模型地址、模型 ID 与 Key。</p>
          )}
          {generateError && <ErrorState error={new Error(generateError)} onRetry={generate} />}
          {generateNote && <p className="a8-note">{generateNote}</p>}
        </section>
      )}

      {entries && (
        <section className="a8-card">
          <div className="a8-card-head">
            <div>
              <h3>3. 确认并复制</h3>
              <p className="muted">
                共 {entries.length} 天 · {totalHours(entries)}h
                {badCount ? ` · ${badCount} 条待修正` : ' · 校验通过'}
              </p>
            </div>
            <div className="check-group">
              <button className="btn" onClick={copyAll} disabled={badCount > 0}>复制全部</button>
            </div>
          </div>
          <div className="a8-table-wrap">
            <table className="a8-table">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>类型</th>
                  <th className="num">工时</th>
                  <th>工作描述</th>
                  <th>Jira</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => {
                  const p = problems[i];
                  return (
                    <tr key={e.activityDate} className={p.length ? 'invalid' : undefined}>
                      <td className="mono">
                        {e.activityDate.slice(5)}
                        <small className="muted"> {weekdayLabel(e.activityDate)}</small>
                      </td>
                      <td>开发</td>
                      <td className="num">
                        <input
                          className="input a8-hours"
                          type="number"
                          min={0.5}
                          max={MAX_HOURS_PER_DAY}
                          step={0.5}
                          value={e.hours}
                          aria-label={`${e.activityDate} 工时`}
                          onChange={(ev) => patch(e.activityDate, { hours: Number(ev.target.value) })}
                        />
                      </td>
                      <td>
                        <AutoTextarea
                          value={e.description}
                          label={`${e.activityDate} 工作描述`}
                          onChange={(v) => patch(e.activityDate, { description: v })}
                        />
                        {p.length > 0 && <small className="err">{p.join(' · ')}</small>}
                      </td>
                      <td className="mono a8-keys" title={e.jiraKeys.join(', ')}>
                        {e.jiraKeys.length ? e.jiraKeys.join(', ') : <span className="muted">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted a8-foot">
            草稿仅供手工填进 A8。提交前请核对：同一天工时合计不超过 {MAX_HOURS_PER_DAY}h，描述与真实工作一致。
          </p>

          <div className="a8-push">
            <div className="a8-push-head">
              <div>
                <h4>直接推送为 A8 草稿</h4>
                <p className="muted">
                  勾选模板后把上面的工时写进 A8 并存为草稿（不会发送审批，可在 A8「待发事项」里再改再发）。
                </p>
              </div>
              <button className="btn" onClick={loadTemplates} disabled={!config.configured || loadingTemplates}>
                {loadingTemplates ? '读取中…' : templates.length ? '刷新模板' : '读取 A8 模板'}
              </button>
            </div>

            {templatesError && <p className="err" role="alert">{templatesError}</p>}

            {!!templates.length && (
              <div className="a8-push-form">
                <label className="field">
                  <span>工时模板</span>
                  <select className="input" value={templateId} onChange={(e) => pickTemplate(e.target.value)}>
                    <option value="">请选择模板</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </label>
                {probe && (
                  <div className="a8-probe">
                    <span className="chip">项目：{probe.project.name || '—'} {probe.project.code && <small>{probe.project.code}</small>}</span>
                    <span className="chip">任务：{probe.task || '—'}</span>
                    <span className="chip">任务类型：{probe.jobType || '—'}</span>
                  </div>
                )}
                {!!probe?.warnings?.length && (
                  <ul className="a8-warn">
                    {probe.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {pushError && <p className="err" role="alert">{pushError}</p>}
            {pushed && (
              <p className="a8-ok">
                已保存 A8 草稿：{pushed.days} 天 / {pushed.hours}h，标题「{pushed.subject || '—'}」。
                到 A8「待发事项」里可以核对并发送。
              </p>
            )}

            <div className="check-group">
              <button
                className="btn primary"
                disabled={pushing || !templateId || badCount > 0}
                onClick={pushDraft}
                title={badCount ? '请先修正标红的条目' : '写入 A8 并保存为草稿'}
              >
                {pushing ? '推送中…' : `推送 ${entries.length} 天到 A8 草稿`}
              </button>
              {badCount > 0 && <span className="muted">有 {badCount} 条待修正，修正后才能推送。</span>}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function A8ConfigForm({ config, onSaved, onCancel }: { config: A8Config; onSaved: (c: A8Config) => void; onCancel?: () => void }) {
  const [url, setUrl] = useState(config.url);
  const [username, setUsername] = useState(config.username);
  const [password, setPassword] = useState('');
  const [cookie, setCookie] = useState('');
  const [templateId, setTemplateId] = useState(config.templateId || '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');

  async function save() {
    setBusy(true);
    setError('');
    setResult('');
    try {
      const next = await api.a8SaveConfig({
        url: url.trim(), username: username.trim(), password, browserCookie: cookie.trim(), templateId,
      });
      setPassword('');
      setCookie('');
      onSaved(next);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setError('');
    setResult('');
    try {
      const r = await api.a8Test();
      setResult(`连接成功：${r.username} @ ${r.url}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="a8-config">
      <div className="form-grid">
        <label className="field wide">
          <span>地址</span>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://pp.bosssoft.com.cn:28101" />
        </label>
        <label className="field">
          <span>A8 账号</span>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </label>
        <label className="field">
          <span>密码</span>
          <input
            className="input"
            type="password"
            value={password}
            autoComplete="new-password"
            placeholder={config.passwordSet ? '已保存，留空则不修改' : '请输入密码'}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="field wide">
          <span>浏览器 Cookie（可选，账号有图形验证码时使用）</span>
          <textarea
            className="input textarea"
            rows={2}
            value={cookie}
            placeholder={config.cookieSet ? '已保存，留空则沿用；填写则改用 Cookie 登录' : 'JSESSIONID=...'}
            onChange={(e) => setCookie(e.target.value)}
          />
        </label>
        <label className="field">
          <span>A8 工时模板 ID（可选，留空则每次在页面上选）</span>
          <input
            className="input mono"
            value={templateId}
            placeholder="如 17242926994870"
            onChange={(e) => setTemplateId(e.target.value.trim())}
          />
        </label>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      {result && <p className="a8-ok">{result}</p>}
      <div className="check-group a8-config-actions">
        <button className="btn primary" disabled={busy || !url.trim() || !username.trim()} onClick={save}>
          {busy ? '处理中…' : '保存'}
        </button>
        <button className="btn" disabled={busy || !config.configured} onClick={test} title="使用已保存的账号登录一次 A8">
          测试已保存配置
        </button>
        {onCancel && <button className="btn ghost" disabled={busy} onClick={onCancel}>取消</button>}
      </div>
      <p className="muted a8-foot">密码与 Cookie 以 AES-256-GCM 加密保存在本机配置目录，页面与接口都不会返回明文。</p>
    </div>
  );
}
