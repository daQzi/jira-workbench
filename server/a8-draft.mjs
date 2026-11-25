// A8 工时「推送草稿」：把已确认的工时条目写入 A8，保存为草稿（不发送审批）。
//
// 链路对照 auto-okr 的 a8_service.py：
//   newColl（拿 summaryId / bodyType / matchRequestToken）
//   -> createOrEdit（拿表单模板 content / view / 首行）
//   -> 子表增删（addOrDelDataSubBean）+ 新行绑定任务（getFormRelationDatas + dealSelectedRelationData）
//   -> saveOrUpdate
//   -> collaboration.do?method=saveDraft（endSaveDraft(...) 才算成功）
//
// 与 auto-okr 的差别：工时条目来自本工作台的 Jira 草稿，任务归属沿用 A8 模板首行，
// 不再按「工作类别 -> 任务类型」映射；模板本身就决定了项目与任务。
import { normalizeA8Url } from './a8.mjs';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 表单主表/子表字段名来自 A8「工时报告」模板，换模板时由 createOrEdit 返回值决定，
// 这里只固定 A8 端约定俗成的几处：子表名、总工时/总体内容字段。
const SON_TABLE = 'formson_0472';
const FIELD_SUMMARY = 'field0004'; // 工时总体内容
const FIELD_TOTAL = 'field0028'; // 本次填报总工时
const FIELD_DATE = 'field0049'; // 工时日期
const FIELD_HOURS = 'field0053'; // 投入工时
const FIELD_DAY_HOURS = 'field0127'; // 当日已投入工时
const FIELD_MANDAY = 'field0152'; // 投入人天
const FIELD_DESC = 'field0064'; // 工时描述
const FIELD_JOBTYPE = 'field0134'; // 任务类型
const HOURS_OF_DAY = 8;

// saveDraft 的流程默认值（取自 auto-okr 的 DEFAULT_SUBMIT_FLOW_OPTIONS）
const SUBMIT_OPTIONS = {
  processTermType: '0',
  processTermTypeText: '自动终止',
  importantLevel: '1',
  importantLevelText: '普通',
  deadlineTemplate: '2880',
  deadlineTemplateText: '2天',
  colPigeonhole: '1',
  colPigeonholeText: '无',
  advanceRemind: '0',
  advanceRemindText: '无',
  remindInterval: '2880',
};

function fail(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

function text(res) {
  return res.text();
}

/** 从 HTML 片段里抽 `<input id=... value=...>`，返回 id -> value */
function inputValues(block) {
  const out = {};
  const re = /<input\b[^>]*>/gi;
  let m;
  while ((m = re.exec(block))) {
    const id = /\bid=["']([^"']*)["']/.exec(m[0])?.[1];
    if (!id) continue;
    const value = /\bvalue=["']([^"']*)["']/i.exec(m[0])?.[1];
    out[id] = value === undefined ? '' : value;
  }
  return out;
}

/** 取 `<div id="anchor">…</div>` 的完整片段（按同名标签做括号配对） */
function blockById(html, id) {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) return '';
  const start = html.lastIndexOf('<', at);
  const tag = /^<([a-zA-Z0-9]+)/.exec(html.slice(start))?.[1];
  if (!tag) return '';
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'gi');
  re.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('</')) {
      depth--;
      if (depth === 0) return html.slice(start, m.index + m[0].length);
    } else {
      depth++;
    }
  }
  return html.slice(start);
}

async function postJson(base, cookie, path, payload, referer) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
      ...(referer ? { Referer: referer } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45_000),
  });
  const raw = await res.text();
  if (res.status === 401 || /__LOGOUT/.test(raw)) throw fail('A8 登录状态已失效，请重新登录', 401);
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw fail(`A8 返回的不是 JSON（HTTP ${res.status}）：${raw.slice(0, 160)}`);
  }
  return json;
}

/** A8 统一响应：{code:0, data:{success:1, code:'200', message, data}} */
function unwrap(json, what) {
  const d = json?.data;
  if (!d) throw fail(`${what}失败：A8 返回结构异常`);
  if (String(d.success) !== '1') {
    throw fail(`${what}失败：${d.message || `success=${d.success} code=${d.code}`}`);
  }
  return d.data;
}

function formReferer(base, rightId, templateId) {
  return (
    `${base}/seeyon/common/cap4/template/display/pc/form/dist/index.html` +
    `?_r=v&type=create&rightId=${rightId}&moduleId=${templateId}` +
    '&subState=&isSubFlow=false&moduleType=1&sourceType=&sourceId=&nocache=1'
  );
}

/** 协同模板列表：只返回 A8「协同模板」分类下的模板 */
export async function listA8Templates(cfg, cookie) {
  const base = normalizeA8Url(cfg.url);
  const url = `${base}/seeyon/template/template.do?method=templateChoose&category=1,2,66&accountId=`;
  const res = await fetch(url, {
    headers: { Cookie: cookie, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  const html = await text(res);
  if (!html) throw fail('获取 A8 模板列表失败：返回内容为空');
  if (/__LOGOUT/.test(html)) throw fail('A8 登录状态已失效，请重新登录', 401);
  const m = /\$\.ctx\.fillmaps\s*=\s*(\{[\s\S]*?\});/.exec(html);
  if (!m) throw fail('获取 A8 模板列表失败：无法解析模板数据，A8 版本可能已变更');
  let tree;
  try {
    tree = JSON.parse(m[1]).tree || [];
  } catch (e) {
    throw fail(`获取 A8 模板列表失败：${e.message}`);
  }
  let categoryId = null;
  const children = new Map();
  for (const node of tree) {
    if (node.pId) {
      if (!children.has(node.pId)) children.set(node.pId, []);
      children.get(node.pId).push(node);
    }
    if (node.name === '协同模板') categoryId = node.id;
  }
  if (!categoryId) throw fail('获取 A8 模板列表失败：未找到「协同模板」分类');
  return (children.get(categoryId) || []).map((t) => ({ id: String(t.id), name: String(t.name) }));
}

/**
 * 打开发起页，解析 saveDraft 需要的隐藏字段。
 * 每次推送都要重新调用：summaryId 是一次性的流程实例 ID。
 */
async function openNewCollab(base, cookie, templateId) {
  const url = `${base}/seeyon/collaboration/collaboration.do?method=newColl&from=templateNewColl&templateId=${templateId}`;
  const res = await fetch(url, {
    headers: { Cookie: cookie, 'User-Agent': USER_AGENT, Referer: `${base}/seeyon/main.do?method=main` },
    signal: AbortSignal.timeout(30_000),
  });
  const html = await text(res);
  if (/__LOGOUT/.test(html)) throw fail('A8 登录状态已失效，请重新登录', 401);
  const pick = (re, name) => {
    const m = re.exec(html);
    if (!m) throw fail(`打开 A8 工时表单失败：未找到 ${name}，模板 ${templateId} 可能无权限或已被删除`);
    return m[1];
  };
  const rightId = /rightId=([0-9.\-_]+)/.exec(html)?.[1];
  if (!rightId) throw fail(`打开 A8 工时表单失败：模板 ${templateId} 没有可用的表单视图权限`);
  return {
    rightId,
    summaryId: pick(/var\s+summaryId\s*=\s*"([0-9-]+)"/, 'summaryId'),
    bodyType: pick(/var\s+bodyType\s*=\s*'([^']+)'/, 'bodyType'),
    formAppId: pick(/var\s+formAppid\s*=\s*'([0-9-]+)'/, 'formAppid'),
    matchRequestToken: pick(/var\s+matchRequestToken\s*=\s*'([^']+)'/, 'matchRequestToken'),
    workflow: inputValues(blockById(html, 'workflow_definition')),
    colMain: inputValues(blockById(html, 'colMainData')),
    commentDeal: inputValues(blockById(html, 'comment_deal')),
  };
}

async function createOrEdit(base, cookie, templateId, rightId) {
  const json = await postJson(
    base,
    cookie,
    '/seeyon/rest/cap4/form/createOrEdit',
    {
      _r: 'v',
      type: 'create',
      rightId,
      moduleId: templateId,
      subState: '',
      isSubFlow: 'false',
      moduleType: '1',
      sourceType: '',
      sourceId: '',
      nocache: '1',
      // 不带 operateType 时 A8 返回 success=3「您无权操作」，必须显式给 0 + forceDb
      operateType: '0',
      forceDb: true,
    },
    formReferer(base, rightId, templateId),
  );
  const data = unwrap(json, '读取 A8 工时表单');
  if (!data?.content?.contentDataId) throw fail('读取 A8 工时表单失败：返回缺少 contentDataId');
  if (!Array.isArray(data.views) || !data.views.length) {
    throw fail(`模板 ${templateId} 没有配置视图，无法填报`);
  }
  return data;
}

/** 子表行：把 createOrEdit 的 fieldInfo 结构压平成「值」 */
function rowsFromTemplate(data) {
  const table = (data.tableInfo?.formson || []).find((t) => t.tableName === SON_TABLE);
  if (!table) throw fail(`A8 模板里没有工时子表 ${SON_TABLE}，请换一个模板`);
  const items = table.pageData?.items || [];
  if (!items.length) throw fail('A8 模板的工时子表没有初始行，无法作为填报底稿');
  return items.map((it) => {
    const row = { id: it.recordId, groupSort: it.groupSort };
    for (const [k, v] of Object.entries(it)) {
      if (k === 'recordId' || k === 'groupSort') continue;
      row[k] = v?.value ?? '';
    }
    return row;
  });
}

function mainFromTemplate(data) {
  const info = data.tableInfo?.formmain?.fieldInfo || {};
  const out = {};
  for (const [k, v] of Object.entries(info)) out[k] = v?.value ?? '';
  return out;
}

/** 模板首行的项目/任务/任务类型，用于在页面上先给用户看 */
export function describeTemplate(data) {
  const row = rowsFromTemplate(data)[0];
  const raw = (data.tableInfo?.formson || []).find((t) => t.tableName === SON_TABLE)?.pageData?.items?.[0] || {};
  const info = data.tableInfo?.formmain?.fieldInfo || {};
  const show = (k) => String(info[k]?.showValue ?? info[k]?.value ?? '');
  // field0106 是 A8 的项目结项/工时余额提示，field0052 是填报期冻结提示，都要显式告诉用户
  const warnings = ['field0106', 'field0052'].map(show).filter(Boolean);
  return {
    project: { name: show('field0003'), code: show('field0020'), status: show('field0044') },
    task: row.field0012 || '',
    jobType: String(raw[FIELD_JOBTYPE]?.showValue || row[FIELD_JOBTYPE] || ''),
    warnings,
  };
}

function buildEntity(ctx, rows) {
  const c = ctx.data.content;
  const view = ctx.data.views[0];
  const main = mainFromTemplate(ctx.data);
  return {
    content: {
      ...c,
      isMerge: '1',
      NeedCheckRule: '0',
      needCheckRule: '0',
      NeedSn: '0',
      needSn: '0',
      NeedCheckCustom: '1',
      needCheckCustom: '1',
      checkNull: '0',
      moduleTemplateId: ctx.templateId,
      moduleId: ctx.collab.summaryId,
      rightId: view.rightId,
      viewId: view.viewId,
      SaveType: '5',
      saveType: '5',
      OptType: 'saveAs',
      optType: 'saveAs',
    },
    formmain_0471: main,
    formson_0472: rows,
    pageInfo: { formson_0472: { page: 1, size: 20, filterFields: [], sortFields: [] } },
    attachments: [],
  };
}

/** 复制首行做新行底稿：保留项目/任务/任务类型，其余清空由调用方覆盖 */
function cloneRow(src, id) {
  const row = { id, groupSort: src.groupSort };
  for (const [k, v] of Object.entries(src)) {
    if (k === 'id' || k === 'groupSort') continue;
    row[k] = v;
  }
  return row;
}

async function addRow(base, cookie, ctx, entity, preRecordId) {
  const view = ctx.data.views[0];
  const json = await postJson(
    base,
    cookie,
    '/seeyon/rest/cap4/form/addOrDelDataSubBean',
    {
      formId: ctx.collab.formAppId,
      formMasterId: ctx.data.content.contentDataId,
      preRecordId,
      rightId: view.rightId,
      recordIds: [''],
      tableName: SON_TABLE,
      type: 'add',
      mergeData: entity,
    },
    formReferer(base, view.rightId, ctx.templateId),
  );
  const d = unwrap(json, '新增工时行');
  const added = d?.tableData?.[SON_TABLE]?.add || [];
  if (!added.length || !added[0].recordId) throw fail('新增工时行失败：未返回新行 ID');
  return String(added[0].recordId);
}

/**
 * 新行要绑定到模板首行的同一任务，否则保存时任务字段为空。
 * relationShipId 取自首行 field0012 的 relationData。
 */
async function bindRowTask(base, cookie, ctx, entity, rowId) {
  const view = ctx.data.views[0];
  const first = ctx.data.tableInfo.formson.find((t) => t.tableName === SON_TABLE).pageData.items[0];
  let rel = first?.field0012?.relationData;
  if (typeof rel === 'string') {
    try {
      rel = JSON.parse(rel);
    } catch {
      rel = null;
    }
  }
  if (!rel?.relationShipId) throw fail('A8 模板首行缺少任务关联关系，无法自动绑定任务');

  const referer = formReferer(base, view.rightId, ctx.templateId);
  const got = await postJson(
    base,
    cookie,
    '/seeyon/rest/cap4/form/getFormRelationDatas',
    {
      conditions: [],
      fromDataId: ctx.data.content.contentDataId,
      fromRecordId: rowId,
      fromRelationAttr: 'field0012',
      isInit: '1',
      isMainSelecter: '0',
      page: 1,
      relationShipId: rel.relationShipId,
      selectedMasterDataId: '',
      templateId: ctx.data.content.contentTemplateId,
      mergeData: entity,
    },
    referer,
  );
  if (String(got?.data?.code) !== '2000') {
    throw fail(`读取 A8 任务关联失败：${got?.data?.message || got?.data?.code}`);
  }
  const datas = got?.data?.data || [];
  if (!datas.length) {
    throw fail('当前账号在 A8 里没有可填报的任务，请先在 A8 维护项目团队/任务授权');
  }

  const bound = await postJson(
    base,
    cookie,
    '/seeyon/rest/cap4/form/dealSelectedRelationData',
    {
      fromDataId: ctx.data.content.contentDataId,
      fromRecordId: rowId,
      formRightId: view.rightId,
      mergeData: entity,
      relationShipId: rel.relationShipId,
      selectDatas: datas,
      selectRecordIds: { [SON_TABLE]: rowId },
    },
    referer,
  );
  unwrap(bound, '绑定工时行任务');
}

async function deleteRow(base, cookie, ctx, entity, recordId) {
  const view = ctx.data.views[0];
  const json = await postJson(
    base,
    cookie,
    '/seeyon/rest/cap4/form/addOrDelDataSubBean',
    {
      formId: ctx.collab.formAppId,
      formMasterId: ctx.data.content.contentDataId,
      preRecordId: recordId,
      rightId: view.rightId,
      recordIds: [recordId],
      tableName: SON_TABLE,
      type: 'delete',
      mergeData: entity,
    },
    formReferer(base, view.rightId, ctx.templateId),
  );
  unwrap(json, '删除多余工时行');
}

function roundDate(value) {
  const s = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw fail(`工时日期格式不正确：${s}`, 400);
  return s;
}

function cleanEntry(entry, fallbackJobTypeId) {
  const activityDate = roundDate(entry.activityDate ?? entry.activity_date);
  const hours = Number(entry.hours ?? entry.costHours ?? entry.cost_hours);
  if (!Number.isFinite(hours) || hours <= 0) throw fail(`${activityDate} 的工时必须大于 0`, 400);
  if (!Number.isInteger(hours * 2)) throw fail(`${activityDate} 的工时必须为 0.5 的倍数`, 400);
  if (hours > 24) throw fail(`${activityDate} 的工时不能超过 24h`, 400);
  const description = String(entry.description ?? '').trim();
  if (!description) throw fail(`${activityDate} 的工作描述为空`, 400);
  return {
    activityDate,
    hours,
    description: description.slice(0, 2000),
    jobTypeId: String(entry.jobTypeId || fallbackJobTypeId || ''),
  };
}

/** 校验并规整待推送条目；同一天只允许一条，避免 A8 出现重复行 */
export function normalizeEntries(entries, fallbackJobTypeId) {
  const cleaned = (Array.isArray(entries) ? entries : []).map((e) => cleanEntry(e, fallbackJobTypeId));
  const seen = new Set();
  for (const e of cleaned) {
    if (seen.has(e.activityDate)) throw fail(`${e.activityDate} 出现了两条工时，请先合并`, 400);
    seen.add(e.activityDate);
  }
  return cleaned;
}

/** 测试用别名：不导出内部 fail 结构 */
export function cleanEntriesForTest(entries, fallbackJobTypeId = '') {
  return normalizeEntries(entries, fallbackJobTypeId);
}

/**
 * 把若干天的工时写入 A8 草稿。
 * @returns {{summaryId:string, contentId:string, contentDataId:string, subject:string, days:number, hours:number}}
 */
export async function pushA8Draft(cfg, cookie, { templateId, entries, summary }) {
  if (!templateId) throw fail('请先选择 A8 工时模板', 400);
  const list = (Array.isArray(entries) ? entries : []).slice(0, 62);
  if (!list.length) throw fail('没有可推送的工时', 400);

  const base = normalizeA8Url(cfg.url);
  const collab = await openNewCollab(base, cookie, templateId);
  const ctx = { templateId, collab, data: null };
  ctx.data = await createOrEdit(base, cookie, templateId, collab.rightId);

  const templateRows = rowsFromTemplate(ctx.data);
  const firstRow = templateRows[0];
  const jobTypeId = firstRow[FIELD_JOBTYPE];

  const cleaned = normalizeEntries(list, jobTypeId);
  const dayTotal = cleaned.reduce((n, e) => n + e.hours, 0);

  // 先用模板行铺底，再把多余的删掉、不够的加上
  let rows = templateRows.map((r) => cloneRow(r, r.id));
  let entity = buildEntity(ctx, rows);

  while (rows.length > cleaned.length) {
    const extra = rows[rows.length - 1];
    await deleteRow(base, cookie, ctx, entity, extra.id);
    rows = rows.slice(0, -1);
    entity = buildEntity(ctx, rows);
  }
  while (rows.length < cleaned.length) {
    const id = await addRow(base, cookie, ctx, entity, rows[rows.length - 1].id);
    entity = buildEntity(ctx, [...rows, cloneRow(firstRow, id)]);
    await bindRowTask(base, cookie, ctx, entity, id);
    rows = [...rows, cloneRow(firstRow, id)];
  }

  const totalByDay = new Map();
  for (const e of cleaned) totalByDay.set(e.activityDate, (totalByDay.get(e.activityDate) || 0) + e.hours);

  rows = rows.map((row, i) => {
    const e = cleaned[i];
    return {
      ...row,
      [FIELD_DATE]: e.activityDate,
      [FIELD_HOURS]: String(e.hours),
      [FIELD_DAY_HOURS]: String(totalByDay.get(e.activityDate) || e.hours),
      [FIELD_MANDAY]: String(Math.ceil((e.hours / HOURS_OF_DAY) * 100) / 100),
      [FIELD_DESC]: e.description,
      ...(e.jobTypeId ? { [FIELD_JOBTYPE]: e.jobTypeId } : {}),
    };
  });
  entity = buildEntity(ctx, rows);
  entity.formmain_0471[FIELD_TOTAL] = String(dayTotal);
  if (summary) entity.formmain_0471[FIELD_SUMMARY] = String(summary).slice(0, 500);

  // 加锁：A8 要求先声明占用这次新建流程
  const lockUrl =
    `${base}/seeyon/ajax.do?method=ajaxAction&managerName=colManager` +
    `&rnd=${Math.floor(Math.random() * 1e9)}`;
  const lockRes = await fetch(lockUrl, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body:
      'managerMethod=checkAffairAndLock4NewColJson&arguments=' +
      encodeURIComponent(JSON.stringify([collab.summaryId, 'false'])),
    signal: AbortSignal.timeout(30_000),
  });
  if (lockRes.status >= 400) throw fail(`A8 表单加锁失败（HTTP ${lockRes.status}）`);

  const view = ctx.data.views[0];
  const saved = await postJson(
    base,
    cookie,
    '/seeyon/rest/cap4/form/saveOrUpdate',
    entity,
    formReferer(base, view.rightId, templateId),
  );
  const savedData = unwrap(saved, '保存 A8 工时表单');
  const savedContent = savedData?.content || {};

  // 提交草稿
  const workflow = { ...collab.workflow };
  const colMain = { ...collab.colMain };
  const commentDeal = { ...collab.commentDeal };
  for (const k of ['toReGo', 'workflow_last_input']) if (!workflow[k]) workflow[k] = 'false';
  workflow.toReGo = '';
  workflow.workflow_last_input = '';
  workflow.workflow_node_condition_input = '';

  if (!colMain.saveAsFlag) colMain.saveAsFlag = 'saveAsDraft';
  colMain.formRecordid = ctx.data.content.contentDataId;
  colMain.contentSaveId = String(savedContent.id || '');
  colMain.contentDataId = String(ctx.data.content.contentDataId);
  colMain.contentTemplateId = String(ctx.data.content.contentTemplateId || '');
  colMain.contentRightId = String(view.rightId || '');
  colMain.contentZWID = String(savedContent.id || '');
  colMain.bodyType = collab.bodyType;
  Object.assign(colMain, {
    processTermType: SUBMIT_OPTIONS.processTermType,
    processTermType_select: SUBMIT_OPTIONS.processTermType,
    processTermType_text: SUBMIT_OPTIONS.processTermTypeText,
    processTermTypeCheck: null,
    importantLevel: SUBMIT_OPTIONS.importantLevel,
    importantLevel_select: SUBMIT_OPTIONS.importantLevel,
    importantLevel_text: SUBMIT_OPTIONS.importantLevelText,
    deadlineTemplate: SUBMIT_OPTIONS.deadlineTemplate,
    deadlineTemplate_select: SUBMIT_OPTIONS.deadlineTemplate,
    deadlineTemplate_text: SUBMIT_OPTIONS.deadlineTemplateText,
    colPigeonhole: SUBMIT_OPTIONS.colPigeonhole,
    colPigeonhole_select: SUBMIT_OPTIONS.colPigeonhole,
    colPigeonhole_text: SUBMIT_OPTIONS.colPigeonholeText,
    advanceRemind: SUBMIT_OPTIONS.advanceRemind,
    advanceRemind_select: SUBMIT_OPTIONS.advanceRemind,
    advanceRemind_text: SUBMIT_OPTIONS.advanceRemindText,
    remindInterval: SUBMIT_OPTIONS.remindInterval,
    mergeIgnoreCommentRequired: null,
    mergeContentLast: null,
    mergeAttitudeLast: null,
    mergeAttitudeDefault: null,
    canStartMerge: null,
    canEdit: null,
    canAnyDealMerge: null,
    radiopart: null,
    canPreDealMerge: null,
    canTrackWorkFlow: '0',
  });
  // 草稿没有截止时间时，A8 用「隐藏值 + 1 天」兜底
  const hidden = String(colMain.deadLineDateTimeHidden || '').trim();
  if (!colMain.deadLineDateTime && hidden) {
    const d = new Date(hidden.replace(' ', 'T'));
    if (!Number.isNaN(d.getTime())) {
      d.setDate(d.getDate() + 1);
      const p = (n) => String(n).padStart(2, '0');
      colMain.deadLineDateTime =
        `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
        `${p(d.getHours())}:${p(d.getMinutes())}`;
    }
  }
  commentDeal.moduleId = collab.summaryId;
  commentDeal.content_coll = '';

  const mapData = {
    workflow_definition: workflow,
    assDocDomain: [],
    attFileDomain: [],
    colMainData: colMain,
    comment_deal: commentDeal,
  };
  const curTemId = colMain.curTemId || templateId;
  const res = await fetch(`${base}/seeyon/collaboration/collaboration.do?method=saveDraft`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${base}/seeyon/collaboration/collaboration.do?method=newColl&templateId=${curTemId}&from=templateNewColl`,
      Origin: base,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    body: 'CSRFTOKEN=&_json_params=' + encodeURIComponent(JSON.stringify(mapData)),
    signal: AbortSignal.timeout(90_000),
  });
  const html = await res.text();
  if (/__LOGOUT/.test(html)) throw fail('A8 登录状态已失效，请重新登录', 401);

  const alert = /alert\(['"]([^'"]+)['"]\)/.exec(html);
  if (alert) throw fail(`A8 拒绝保存草稿：${alert[1]}`);

  // 与 auto-okr 的判据一致：body 里出现任何文本都算失败（A8 成功时返回空 body）
  const bodyText = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (bodyText) throw fail(`A8 返回错误：${bodyText.slice(0, 300)}`);

  const end = /endSaveDraft\('([^']*)','([^']*)','([^']*)','([^']*)'\)/.exec(html);
  return {
    templateId,
    summaryId: end?.[1] || collab.summaryId,
    contentId: end?.[2] || String(savedContent.id || ''),
    contentDataId: end?.[3] || String(ctx.data.content.contentDataId || ''),
    subject: end?.[4] || '',
    days: cleaned.length,
    hours: dayTotal,
  };
}

/** 只读探测：给页面展示「这个模板会填到哪个项目/任务」 */
export async function probeA8Template(cfg, cookie, templateId) {
  const base = normalizeA8Url(cfg.url);
  const collab = await openNewCollab(base, cookie, templateId);
  const data = await createOrEdit(base, cookie, templateId, collab.rightId);
  const info = describeTemplate(data);
  return { templateId, ...info };
}
