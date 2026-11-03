// 日报拆分：调用 OpenAI 兼容的大模型，把日报文本转成结构化任务草稿。
// 这里只做“调用 + JSON 提取 + 结构清洗”；工时上限、合计一致性等业务规则在前端 src/lib/dailyImport.ts 校验，
// 不合规的结果会被退回机械拆分或标红，不会直接写 Jira。API Key 只在本进程内使用，不下发给浏览器。

const MAX_TEXT = 20_000;
const MAX_TASKS = 60;
const MAX_SUBTASKS = 20;

/** @type {{baseUrl: string, model: string, apiKey: string, timeoutMs: number, maxHoursPerTask: number, promptExtra: string}} */
let cfg = { baseUrl: '', model: '', apiKey: '', timeoutMs: 60_000, maxHoursPerTask: 8, promptExtra: '' };

export function configureLlm(opts = {}) {
  cfg = {
    baseUrl: String(opts.baseUrl || '').replace(/\/+$/, ''),
    model: String(opts.model || ''),
    apiKey: String(opts.apiKey || ''),
    timeoutMs: Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60_000,
    maxHoursPerTask: Number(opts.maxHoursPerTask) > 0 ? Number(opts.maxHoursPerTask) : 8,
    promptExtra: String(opts.promptExtra || ''),
  };
}

/** 给前端的公开信息（不含 Key） */
export function llmStatus() {
  return { enabled: !!(cfg.baseUrl && cfg.model && cfg.apiKey), model: cfg.model, maxHoursPerTask: cfg.maxHoursPerTask };
}

export function buildMessages({ text, date, defaultProject, projects = [] }, max = cfg.maxHoursPerTask, extra = cfg.promptExtra) {
  const system = [
    '你是研发团队的工时助手，把用户的日报整理成 Jira 任务。只输出一个 JSON 对象，不要输出解释或代码块标记。',
    '规则：',
    '1. 每个独立的工作项一条 task；忽略问候语、日期标题、总结性空话。',
    '2. sourceLine 原样复制该任务所在的原文那一行（不改字）。',
    '3. 原文写了工时的，hours 按原文换算成小时（1d/1天=8h，1w=40h），hoursSource="input"；原文没写的，按内容给出合理估计，hoursSource="estimated"。',
    `4. hours 大于 ${max} 时，按实际工作内容拆成 subtasks（如设计/编码/联调/自测），每条 hours 不超过 ${max}，subtasks 的 hours 之和必须等于 hours；hours 不超过 ${max} 时 subtasks 为 []。`,
    '5. 原文出现 Jira 编号（形如 ABC-123）时放入 parentKey，否则为 null；出现 [项目KEY] 时放入 project，否则为 null。',
    '6. 原文写了一线对接人/对接人（客户方或现场的联系人姓名）时放入 contact，只写姓名；没写为 null。不要把开发人员、测试人员或日报作者当成对接人。',
    '7. title 简洁明确，不超过 40 个字，不包含工时、编号、日期。subtasks 的 title 只写这一步做什么。',
    '输出格式：{"tasks":[{"title":"","hours":0,"hoursSource":"input","project":null,"parentKey":null,"contact":null,"sourceLine":"","subtasks":[{"title":"","hours":0}]}]}',
    extra ? `团队补充要求：${extra}` : '',
  ].filter(Boolean).join('\n');
  const user = [
    // 内部网关会注入自己的 system 提示并弱化我们的 system 消息（已实测模型会反问“要做什么”），
    // 所以任务说明在 user 消息里再完整给一遍
    '请按下面的规则处理日报，直接输出 JSON，不要提问、不要解释。',
    system,
    '',
    `日报日期：${date || '未知'}`,
    defaultProject ? `默认项目：${defaultProject}` : '',
    projects.length ? `可用项目：${projects.join(', ')}` : '',
    '日报内容：',
    '"""',
    text,
    '"""',
  ].filter((x) => x !== '').join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 模型常把 JSON 包在 ```json 代码块里或附带说明文字：取第一个 { 到与之配对的 } */
export function extractJson(content) {
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

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};
const KEY_RE = /^[A-Za-z][A-Za-z0-9]+-\d+$/;
const PROJECT_RE = /^[A-Za-z][A-Za-z0-9]+$/;

/** 结构清洗：只保留约定字段，类型不对的置空；不做业务判断 */
export function sanitizeDraft(obj) {
  const tasks = Array.isArray(obj?.tasks) ? obj.tasks : null;
  if (!tasks) throw new Error('模型返回缺少 tasks 数组');
  return tasks
    .slice(0, MAX_TASKS)
    .map((t) => {
      const project = str(t?.project, 30);
      const parentKey = str(t?.parentKey, 40);
      const contact = str(t?.contact, 30);
      return {
        title: str(t?.title, 200),
        hours: num(t?.hours),
        hoursSource: t?.hoursSource === 'input' ? 'input' : 'estimated',
        project: PROJECT_RE.test(project) ? project.toUpperCase() : null,
        parentKey: KEY_RE.test(parentKey) ? parentKey.toUpperCase() : null,
        contact: contact && !/^(?:null|无|空|-)$/i.test(contact) ? contact : null,
        sourceLine: str(t?.sourceLine, 500),
        subtasks: (Array.isArray(t?.subtasks) ? t.subtasks : [])
          .slice(0, MAX_SUBTASKS)
          .map((x) => ({ title: str(x?.title, 200), hours: num(x?.hours) }))
          .filter((x) => x.title),
      };
    })
    .filter((t) => t.title);
}

/**
 * @param {{text: string, date?: string, defaultProject?: string, projects?: string[]}} input
 */
export async function splitDaily(input) {
  if (!llmStatus().enabled) throw Object.assign(new Error('未配置大模型（baseUrl / model / apiKey）'), { status: 503 });
  const text = typeof input?.text === 'string' ? input.text.trim() : '';
  if (!text) throw Object.assign(new Error('日报内容为空'), { status: 400 });
  if (text.length > MAX_TEXT) throw Object.assign(new Error(`日报内容过长（上限 ${MAX_TEXT} 字）`), { status: 413 });
  const started = Date.now();
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: buildMessages({
        text,
        date: str(input.date, 10),
        defaultProject: str(input.defaultProject, 30),
        projects: Array.isArray(input.projects) ? input.projects.map((p) => str(p, 30)).filter(Boolean).slice(0, 50) : [],
      }),
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    throw Object.assign(new Error(`大模型调用失败：${String(msg).slice(0, 200)}`), { status: 502 });
  }
  const content = body?.choices?.[0]?.message?.content;
  let tasks;
  try {
    tasks = sanitizeDraft(extractJson(content));
  } catch (e) {
    throw Object.assign(new Error(`大模型返回无法解析：${e.message}`), { status: 502 });
  }
  return { tasks, model: cfg.model, elapsedMs: Date.now() - started };
}
