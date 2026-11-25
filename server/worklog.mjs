// A8 工时补全：按缺失工作日 + 当月 Jira 任务，让已配置的模型生成每日工时条目。
// 只生成草稿，不写 A8；生成结果由页面确认后再人工提交。
import { completeJson, llmConfigured } from './llm.mjs';

const MAX_DATES = 31;
const MAX_ISSUES = 120;
const MAX_HOURS_PER_DAY = 12;
/** 单次模型调用的天数上限：15 天一次容易超过 60s 超时，分批更稳 */
const BATCH_DATES = 5;

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]+-\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function issueLine(it) {
  const parts = [`${it.key}`, `[${it.type}]`, it.summary];
  if (it.status) parts.push(`(${it.status})`);
  if (it.updated) parts.push(`更新 ${it.updated.slice(0, 10)}`);
  return `- ${parts.join(' ')}`;
}

/**
 * @param {{dates: string[], issues: {key:string,summary:string,type:string,status?:string,updated?:string}[], hoursPerDay?: number, promptExtra?: string}} input
 */
export function buildWorklogMessages({ dates, issues, hoursPerDay = 8, promptExtra = '' }) {
  const dateText = dates.map((d) => `- ${d}`).join('\n');
  const issueText = issues.map(issueLine).join('\n') || '- （本月没有查到指派给我的 Jira 任务）';
  const system = [
    '你是研发团队的工时填报助手，根据当月实际处理的 Jira 任务，为缺失的工作日生成 A8 工时草稿。只输出一个 JSON 对象，不要解释、不要代码块标记。',
    '规则：',
    '1. 只为列出的缺失日期生成条目，每个日期恰好一条，不要新增其它日期。',
    `2. hours 默认 ${hoursPerDay}，按半天（0.5）取整，且不超过 ${MAX_HOURS_PER_DAY}；确实需要拆分工作内容时，在 description 里用 1、2、3 分点描述，仍只输出一条。`,
    '3. jobType 固定为「开发」。',
    '4. description 用日常工作语言，说明当天做了什么、结果如何（80~260 字），不要写日期、工时和标题式套话，也不要在描述里罗列 Jira 编号（编号只放进 jiraKeys）。',
    '5. 只能引用上面列出的 Jira 编号；没有合适的任务就不要写编号，严禁编造编号、项目名或成果。',
    '6. 同一个月内不同日期的工作内容要有区别，按任务更新时间和主题合理分摊；优先选择更新日期接近当天的任务。',
    '7. jiraKeys 是 description 中用到的编号数组，没有则为 []。',
    '输出格式：{"entries":[{"activityDate":"YYYY-MM-DD","jobType":"开发","hours":8,"description":"","jiraKeys":[]}]}',
    promptExtra ? `团队补充要求：${promptExtra}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const user = [
    '请按下面的规则生成工时草稿，直接输出 JSON，不要提问、不要解释。',
    system,
    '',
    '## 缺失的工作日',
    dateText,
    '',
    '## 当月 Jira 任务',
    issueText,
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function extractJson(content) {
  const s = String(content ?? '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  if (start < 0) throw new Error('模型没有返回 JSON');
  let depth = 0;
  let inStr = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(body.slice(start, i + 1));
  }
  throw new Error('模型返回的 JSON 不完整');
}

const round10 = (n) => Math.round(n * 10) / 10;

/** 结构清洗：只保留缺失日期、每日期一条、编号必须真实存在。 */
export function sanitizeEntries(obj, dates, issues, hoursPerDay = 8) {
  const list = Array.isArray(obj?.entries) ? obj.entries : Array.isArray(obj?.tasks) ? obj.tasks : null;
  if (!list) throw new Error('模型返回缺少 entries 数组');
  const missing = new Set(dates);
  const known = new Set(issues.map((i) => i.key.toUpperCase()));
  const byDate = new Map();
  for (const raw of list.slice(0, MAX_DATES * 2)) {
    const date = str(raw?.activityDate ?? raw?.activity_date ?? raw?.date, 10);
    if (!DATE_RE.test(date) || !missing.has(date) || byDate.has(date)) continue;
    const rawHours = Number(raw?.hours ?? raw?.costHours ?? raw?.cost_hours);
    const hours = Number.isFinite(rawHours) && rawHours > 0
      ? Math.min(MAX_HOURS_PER_DAY, Math.max(0.5, Math.round(rawHours * 2) / 2))
      : Math.min(MAX_HOURS_PER_DAY, Math.max(0.5, hoursPerDay));
    // 空描述保留为空：页面会标红要求补写，避免把「日常工作」这类占位内容直接带进 A8
    // 编号已经在 jiraKeys 里单独展示，正文里的编号去掉，避免复制到 A8 时重复
    const description = str(raw?.description, 800)
      .replace(/\s*关联任务[：:]\s*[A-Za-z][A-Za-z0-9_]+-\d+(?:\s*[、,，]\s*[A-Za-z][A-Za-z0-9_]+-\d+)*\s*。?/g, '')
      .trim();
    const keys = (Array.isArray(raw?.jiraKeys ?? raw?.jira_keys) ? raw.jiraKeys ?? raw.jira_keys : [])
      .map((k) => String(k).trim().toUpperCase())
      .filter((k) => KEY_RE.test(k) && known.has(k));
    byDate.set(date, {
      activityDate: date,
      jobType: '开发',
      hours: round10(hours),
      description,
      jiraKeys: [...new Set(keys)],
    });
  }
  return dates.map((d) => byDate.get(d) ?? {
    activityDate: d,
    jobType: '开发',
    hours: Math.min(MAX_HOURS_PER_DAY, Math.max(0.5, hoursPerDay)),
    description: '',
    jiraKeys: [],
  });
}

/**
 * 生成工时草稿。issues 为当月 Jira 任务（已裁剪字段）。
 */
export async function generateWorklog({ dates, issues, hoursPerDay = 8, promptExtra = '' }) {
  if (!llmConfigured()) throw Object.assign(new Error('未配置大模型（baseUrl / model / apiKey）'), { status: 503 });
  const safeDates = (Array.isArray(dates) ? dates : []).filter((d) => DATE_RE.test(String(d))).slice(0, MAX_DATES);
  if (!safeDates.length) throw Object.assign(new Error('没有需要补填的工作日'), { status: 400 });
  const safeIssues = (Array.isArray(issues) ? issues : [])
    .filter((i) => i && typeof i.key === 'string' && typeof i.summary === 'string')
    .slice(0, MAX_ISSUES)
    .map((i) => ({
      key: str(i.key, 40).toUpperCase(),
      summary: str(i.summary, 300),
      type: str(i.type, 40) || '任务',
      status: str(i.status, 40),
      updated: str(i.updated, 30),
    }))
    .filter((i) => KEY_RE.test(i.key));

  const batches = [];
  for (let i = 0; i < safeDates.length; i += BATCH_DATES) batches.push(safeDates.slice(i, i + BATCH_DATES));

  let entries = [];
  let model = '';
  let elapsedMs = 0;
  let failed = 0;
  let lastError = null;
  for (const batch of batches) {
    const out = await completeJson(
      buildWorklogMessages({ dates: batch, issues: safeIssues, hoursPerDay, promptExtra }),
      { temperature: 0.4 },
    ).catch((e) => {
      // 某一批失败（多为超时）不丢整批结果：其余批次照常返回，失败的日期交给页面补写
      lastError = e;
      failed++;
      return null;
    });
    if (!out) {
      // 失败的批次补空条目：页面能看出缺了哪几天，也方便手工补写
      entries = entries.concat(sanitizeEntries({ entries: [] }, batch, safeIssues, hoursPerDay));
      continue;
    }
    model = out.model;
    elapsedMs += out.elapsedMs;
    let part;
    try {
      part = sanitizeEntries(extractJson(out.content), batch, safeIssues, hoursPerDay);
    } catch (e) {
      lastError = e;
      failed++;
      entries = entries.concat(sanitizeEntries({ entries: [] }, batch, safeIssues, hoursPerDay));
      continue;
    }
    entries = entries.concat(part);
  }
  if (failed === batches.length) {
    throw Object.assign(new Error(lastError?.message || '大模型返回无法解析'), {
      status: lastError?.status || (lastError?.name === 'TimeoutError' ? 504 : 502),
    });
  }
  entries.sort((a, b) => a.activityDate.localeCompare(b.activityDate));
  return {
    entries,
    model,
    elapsedMs,
    issues: safeIssues,
    incomplete: entries.some((e) => !e.description),
    ...(failed ? { failedBatches: failed } : {}),
  };
}
