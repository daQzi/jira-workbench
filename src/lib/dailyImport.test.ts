import { describe, expect, it } from 'vitest';
import {
  CONTACT_FIELD, checkSubtasks, dailyTotals, draftsFromLlm, fieldSlots, mechanicalSplit, missingRequired, parseDailyRules, pieceValues, resplit,
  scheduleDates, taskErrors, type DraftOptions, type LlmTask,
} from './dailyImport';
import type { CreateMetaType } from './api';

// 2026-10-27 是周二
const o: DraftOptions = { date: '2026-10-27', defaultProject: 'AGENT', maxHours: 8, schedule: 'backward' };

describe('拆分与排期', () => {
  it('按上限机械切分', () => {
    expect(mechanicalSplit(20, 8)).toEqual([8, 8, 4]);
    expect(mechanicalSplit(8, 8)).toEqual([8]);
    expect(mechanicalSplit(16, 8)).toEqual([8, 8]);
    expect(mechanicalSplit(0.5, 8)).toEqual([0.5]);
  });

  it('往前排跳过周末，最后一条落在日报当天', () => {
    expect(scheduleDates('2026-10-27', 3, 'backward')).toEqual(['2026-10-23', '2026-10-26', '2026-10-27']);
    expect(scheduleDates('2026-10-30', 2, 'forward')).toEqual(['2026-10-30', '2026-11-02']);
    // 日报当天是周六：当天保留
    expect(scheduleDates('2026-10-31', 2, 'backward')).toEqual(['2026-10-30', '2026-10-31']);
  });

  it('子任务校验：超上限、合计不符、缺工时', () => {
    expect(checkSubtasks(12, [{ title: 'a', hours: 4 }, { title: 'b', hours: 8 }], 8)).toBeNull();
    expect(checkSubtasks(12, [{ title: 'a', hours: 3 }, { title: 'b', hours: 9 }], 8)).toMatch('超过');
    expect(checkSubtasks(12, [{ title: 'a', hours: 4 }, { title: 'b', hours: 4 }], 8)).toMatch('不一致');
    expect(checkSubtasks(12, [{ title: 'a', hours: null }, { title: 'b', hours: 4 }], 8)).toMatch('缺少');
  });
});

describe('规则解析', () => {
  it('识别工时、父需求、项目，跳过日期与标题行', () => {
    const r = parseDailyRules(
      ['2026-10-27 日报', '今日工作总结：', '1. 对接医保结算接口联调 6h #YLZHXT-123', '- 排查线上对账数据问题（2小时）', '权限模块改造 1.5d [zhbz]', '开会 半天', '整理文档'].join('\n'),
      o,
    );
    expect(r.map((t) => [t.title, t.project, t.parentKey, t.pieces.map((p) => p.hours)])).toEqual([
      ['对接医保结算接口联调', 'YLZHXT', 'YLZHXT-123', [6]],
      ['排查线上对账数据问题', 'AGENT', null, [2]],
      ['权限模块改造', 'ZHBZ', null, [8, 4]],
      ['开会', 'AGENT', null, [4]],
      ['整理文档', 'AGENT', null, [null]],
    ]);
    expect(r[2].pieces.map((p) => [p.title, p.date])).toEqual([
      ['权限模块改造（1/2）', '2026-10-26'],
      ['权限模块改造（2/2）', '2026-10-27'],
    ]);
    expect(r[4].hoursSource).toBe('missing');
    expect(taskErrors(r[4], 8)).toEqual(['缺少工时']);
  });

  it('工时取行尾那段，标题中的数字不受影响', () => {
    const [t] = parseDailyRules('二期 3 个接口改造 2d 4h', o);
    expect(t.title).toBe('二期 3 个接口改造');
    expect(t.pieces.map((p) => p.hours)).toEqual([8, 8, 4]);
  });
});

describe('大模型结果校验', () => {
  const base: LlmTask = { title: '权限模块改造', hours: 12, hoursSource: 'input', project: null, parentKey: null, contact: null, sourceLine: '', subtasks: [] };

  it('合规的拆分按内容保留', () => {
    const [t] = draftsFromLlm([{ ...base, subtasks: [{ title: '模型设计', hours: 4 }, { title: '编码', hours: 6 }, { title: '联调', hours: 2 }] }], o);
    expect(t.pieces.map((p) => [p.title, p.hours])).toEqual([
      ['权限模块改造-模型设计', 4],
      ['权限模块改造-编码', 6],
      ['权限模块改造-联调', 2],
    ]);
    expect(t.notes).toEqual([]);
  });

  it('不合规的拆分退回机械拆分并说明', () => {
    const [t] = draftsFromLlm([{ ...base, subtasks: [{ title: 'a', hours: 10 }, { title: 'b', hours: 2 }] }], o);
    expect(t.pieces.map((p) => p.hours)).toEqual([8, 4]);
    expect(t.notes[0]).toMatch('机械拆分');
    const [u] = draftsFromLlm([base], o);
    expect(u.pieces.map((p) => p.hours)).toEqual([8, 4]);
  });

  it('不超上限时忽略多余的子任务；项目由父需求推断', () => {
    const [t] = draftsFromLlm([{ ...base, hours: 6, parentKey: 'YLZHXT-9', hoursSource: 'estimated', subtasks: [{ title: 'x', hours: 3 }] }], o);
    expect(t.pieces).toHaveLength(1);
    expect(t.project).toBe('YLZHXT');
    expect(t.hoursSource).toBe('estimated');
  });

  it('改总工时后重新拆分', () => {
    const [t] = draftsFromLlm([{ ...base, hours: null }], o);
    expect(t.hoursSource).toBe('missing');
    const r = resplit(t, 10, o);
    expect(r.pieces.map((p) => p.hours)).toEqual([8, 2]);
    expect(r.hoursSource).toBe('input');
  });

  it('单日合计', () => {
    const ts = parseDailyRules('a 6h\nb 4h', o);
    expect(dailyTotals(ts)).toEqual({ '2026-10-27': 10 });
  });
});

describe('字段落位', () => {
  const type: CreateMetaType = {
    id: '9',
    name: '其他任务',
    fields: {
      summary: { required: true, name: '主题', schema: { type: 'string', system: 'summary' } },
      assignee: { required: false, name: '经办人', schema: { type: 'user', system: 'assignee' } },
      customfield_10204: { required: false, name: '开发人员', schema: { type: 'user', custom: 'x:userpicker' } },
      customfield_20001: { required: false, name: '开发预估时间', schema: { type: 'string', custom: 'x:textfield' } },
      customfield_20002: { required: false, name: '开发完成日期', schema: { type: 'date', custom: 'x:datepicker' } },
      components: { required: true, name: '模块', schema: { type: 'array', items: 'component' }, allowedValues: [{ id: '7', name: 'M' }] },
      project: { required: true, name: '项目', schema: { type: 'project' } },
    },
  };
  const hf = { estimate: ['customfield_10999', 'customfield_20001'], devStart: [], devDone: ['customfield_20002'] };

  it('按项目里存在的同名字段填工时与日期', () => {
    const s = fieldSlots(type, hf);
    expect(s).toMatchObject({ estimate: 'customfield_20001', devDone: 'customfield_20002', developer: 'customfield_10204' });
    expect(pieceValues(s, 'zhang', { title: ' 联调 ', hours: 6, date: '2026-10-27' }, true)).toEqual({
      summary: '联调', assignee: 'zhang', customfield_10204: 'zhang', customfield_20001: '6h', customfield_20002: '2026-10-27',
    });
  });

  it('必填检查：继承值算已填，project 等上下文字段不算', () => {
    expect(missingRequired(type.fields, { summary: 'x' })).toEqual({ missing: ['components'], unsupported: [] });
    expect(missingRequired(type.fields, { summary: 'x' }, { components: [{ id: '7' }] }).missing).toEqual([]);
    expect(missingRequired(type.fields, { summary: 'x', components: ['7'] }).missing).toEqual([]);
  });
});

describe('一线对接人', () => {
  const o = { date: '2026-10-28', defaultProject: 'YLZHXT', maxHours: 8, schedule: 'backward' as const };
  it('规则解析：识别「对接人：姓名」并从标题去掉；「对接医保接口」不误判', () => {
    const r = parseDailyRules('1. 处理报销单打印问题 3h 对接人：张三\n2. 对接医保结算接口联调 6h\n3. 现场问题排查（一线对接人 李四四） 2h', o);
    expect(r.map((t) => [t.title, t.contact])).toEqual([
      ['处理报销单打印问题', '张三'],
      ['对接医保结算接口联调', ''],
      ['现场问题排查', '李四四'],
    ]);
  });

  it('只在该类型有字段时写入', () => {
    const piece = { title: 'x', hours: 1, date: '2026-10-28' };
    expect(pieceValues({ contact: CONTACT_FIELD }, 'me', piece, false, ' 张三 ')[CONTACT_FIELD]).toBe('张三');
    expect(pieceValues({}, 'me', piece, false, '张三')[CONTACT_FIELD]).toBeUndefined();
    expect(pieceValues({ contact: CONTACT_FIELD }, 'me', piece, false, '')[CONTACT_FIELD]).toBeUndefined();
  });

  it('大模型结果带入对接人', () => {
    const [t] = draftsFromLlm([{ title: 'a', hours: 2, hoursSource: 'input', project: null, parentKey: null, contact: '王五', sourceLine: '', subtasks: [] }], o);
    expect(t.contact).toBe('王五');
  });
});
