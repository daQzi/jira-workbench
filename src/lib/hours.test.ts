import { describe, expect, it } from 'vitest';
import { buildReport, dateOf, parseDuration, periodKey, periodsBetween, presetRange, resolveHourFields, type HourItem } from './hours';
import type { Issue } from './types';
import { hoursJql } from '../views/HoursView';
import { NO_VERSION } from './versions';

describe('parseDuration', () => {
  it('常见写法', () => {
    expect(parseDuration('6h')).toBe(6);
    expect(parseDuration('0.5d')).toBe(4);
    expect(parseDuration('2d 4h')).toBe(20);
    expect(parseDuration('1w')).toBe(40);
    expect(parseDuration('30m')).toBe(0.5);
    expect(parseDuration('4小时')).toBe(4);
    expect(parseDuration('1天')).toBe(8);
    expect(parseDuration('3')).toBe(3);
    expect(parseDuration('0h')).toBe(0);
    expect(parseDuration('1d', 7)).toBe(7);
  });
  it('无法识别返回 null', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('约三天')).toBeNull();
    expect(parseDuration('3天左右')).toBeNull();
    expect(parseDuration(null)).toBeNull();
  });
});

describe('区间与周期', () => {
  const now = new Date(2026, 9, 27); // 周二
  it('本周从周一开始', () => {
    expect(presetRange('thisWeek', now)).toEqual({ from: '2026-10-26', to: '2026-11-01' });
    expect(presetRange('lastMonth', now)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });
  it('周 key 为周一', () => {
    expect(periodKey('2026-11-01', 'week')).toBe('2026-10-26');
    expect(periodKey('2026-10-26', 'month')).toBe('2026-10');
  });
  it('补齐空周期', () => {
    const ps = periodsBetween('2026-10-01', '2026-10-31', 'week');
    expect(ps[0].key).toBe('2026-09-28');
    expect(ps).toHaveLength(5);
    expect(periodsBetween('2026-01-15', '2026-03-02', 'month').map((p) => p.key)).toEqual(['2026-01', '2026-02', '2026-03']);
  });
});

describe('字段解析', () => {
  it('同名字段按名称优先级收集', () => {
    const f = resolveHourFields([
      { id: 'customfield_10218', name: '预估时间', custom: true, schema: { type: 'string' } },
      { id: 'customfield_11133', name: '开发预估时间', custom: true, schema: { type: 'string' } },
      { id: 'customfield_11124', name: '开发完成日期', custom: true, schema: { type: 'date' } },
      { id: 'timespent', name: '耗费时间', custom: false },
    ]);
    expect(f.estimate).toEqual(['customfield_11133', 'customfield_10218']);
    expect(f.devDone).toEqual(['customfield_11124']);
  });
  it('日期取第一个有值字段；datetime 转本地日期', () => {
    const f = { estimate: [], devStart: [], devDone: ['customfield_1', 'customfield_2'] };
    const i = mk('A-1', '编码任务', { customfield_2: '2026-10-20', created: '2026-10-01T23:30:00.000+0800' });
    expect(dateOf(i, f, 'devDone')).toBe('2026-10-20');
    expect(dateOf(i, f, 'created')).toBe('2026-10-01');
  });
  it('没有开发完成日期时按解决日期兜底', () => {
    const f = { estimate: [], devStart: [], devDone: ['customfield_1'] };
    const i = mk('A-2', '其他任务', { resolutiondate: '2026-10-28T10:51:52.883+0800' });
    expect(dateOf(i, f, 'devDone')).toBe('2026-10-28');
    expect(dateOf(mk('A-3', '其他任务'), f, 'devDone')).toBeNull();
  });
});

function mk(key: string, type: string, extra: Record<string, unknown> = {}, parent?: string): Issue {
  return {
    id: key,
    key,
    fields: {
      summary: `S ${key}`,
      status: { id: '1', name: '开发中' },
      issuetype: { id: '1', name: type },
      issuelinks: parent
        ? [
            {
              id: 'l',
              type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
              outwardIssue: { id: 'p', key: parent, fields: { summary: `父 ${parent}`, status: { id: '1', name: '开发中' }, issuetype: { id: '9', name: '需求' } } },
            },
          ]
        : [],
      ...extra,
    },
  };
}
const item = (issue: Issue, hours: number | null, period = '2026-10-26'): HourItem => ({ issue, hours, date: period, period });

describe('buildReport', () => {
  it('子项挂到父需求下，父需求不在结果中也补一行', () => {
    const r = buildReport([item(mk('A-2', '编码任务', {}, 'A-1'), 4), item(mk('A-3', '编码任务', {}, 'A-1'), 2, '2026-10-19'), item(mk('A-9', '编码任务'), 1)]);
    expect(r.rows.map((x) => x.key)).toEqual(['A-1', 'A-9']);
    expect(r.rows[0]).toMatchObject({ summary: '父 A-1', total: 6, own: null, byPeriod: { '2026-10-26': 4, '2026-10-19': 2 } });
    expect(r.total).toBe(7);
    expect(r.counted).toBe(3);
  });
  it('需求自身也在结果里时，有子项则不重复计入', () => {
    const r = buildReport([item(mk('A-1', '需求'), 10), item(mk('A-2', '编码任务', {}, 'A-1'), 4)]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].own?.hours).toBe(10);
    expect(r.rows[0].total).toBe(4);
    expect(r.total).toBe(4);
  });
  it('没有工时的计数但不计入', () => {
    const r = buildReport([item(mk('A-5', '编码任务'), null)]);
    expect(r.noHours).toBe(1);
    expect(r.total).toBe(0);
  });
});

describe('Bug 工时统计条件', () => {
  const options = { excludeRequirementBugs: true };

  it('仅排除关联父需求的 Bug，保留独立 Bug 和其他子任务', () => {
    const r = buildReport([
      item(mk('A-2', 'BUG及数据问题', {}, 'A-1'), 3),
      item(mk('A-3', '编码任务', {}, 'A-1'), 4),
      item(mk('A-4', '其他任务', {}, 'A-1'), 2),
      item(mk('A-5', 'BUG及数据问题'), 1),
    ], options);
    expect(r).toMatchObject({ total: 7, counted: 3, noHours: 0, excludedBugs: 1, byPeriod: { '2026-10-26': 7 } });
    expect(r.rows[0].children.map((c) => c.issue.key)).toEqual(['A-3', 'A-4']);
    expect(r.rows[1].key).toBe('A-5');
  });

  it('全部计入时恢复原有汇总', () => {
    const r = buildReport([
      item(mk('A-1', '需求'), 10),
      item(mk('A-2', 'BUG及数据问题', {}, 'A-1'), 3),
      item(mk('A-3', '编码任务', {}, 'A-1'), 4),
    ], { excludeRequirementBugs: false });
    expect(r).toMatchObject({ total: 7, counted: 2, excludedBugs: 0 });
  });

  it('平铺仍按原始关联排除 Bug，保留问题链接且不按父需求分组', () => {
    const bug = mk('A-2', 'Bug', {}, 'A-1');
    const task = mk('A-3', '编码任务', {}, 'A-1');
    const r = buildReport([item(bug, 3), item(task, 4)], { ...options, grouped: false });
    expect(r).toMatchObject({ total: 4, counted: 1, excludedBugs: 1 });
    expect(r.rows.map((row) => row.key)).toEqual(['A-3']);
    expect(r.rows[0].children).toEqual([]);
    expect(task.fields.issuelinks).toHaveLength(1);
    expect(buildReport([item(bug, 3), item(task, 4)], { grouped: false }).total).toBe(7);
  });

  it('普通关联、反向 blocks 和指向非需求的 blocks 不视作父需求', () => {
    const related = mk('A-2', 'BUG及数据问题', {}, 'A-1');
    related.fields.issuelinks![0].type.name = 'Relates';
    const reversed = mk('A-3', 'BUG及数据问题', {}, 'A-1');
    const link = reversed.fields.issuelinks![0];
    link.inwardIssue = link.outwardIssue;
    delete link.outwardIssue;
    const other = mk('A-4', 'BUG及数据问题', {}, 'A-5');
    other.fields.issuelinks![0].outwardIssue!.fields.issuetype.name = '编码任务';
    const r = buildReport([item(related, 1), item(reversed, 2), item(other, 3)], options);
    expect(r).toMatchObject({ total: 6, counted: 3, excludedBugs: 0 });
  });

  it('排除的 Bug 不进入未填工时数，也不留下空父需求行', () => {
    const r = buildReport([item(mk('A-2', '缺陷', {}, 'A-1'), null)], options);
    expect(r).toMatchObject({ rows: [], total: 0, counted: 0, noHours: 0, excludedBugs: 1, byPeriod: {} });
  });

  it('只排除 Bug 子项时，需求自身仍按无子项的现有口径计入', () => {
    const r = buildReport([item(mk('A-1', '需求'), 8), item(mk('A-2', 'BUG及数据问题', {}, 'A-1'), 3)], options);
    expect(r).toMatchObject({ total: 8, counted: 1, excludedBugs: 1 });
    expect(r.rows[0].own?.issue.key).toBe('A-1');
  });
});

describe('工时自定义条件 JQL', () => {
  const settings: Parameters<typeof hoursJql>[0] = {
    range: 'thisMonth', custom: { from: '2026-11-01', to: '2026-11-30' }, granularity: 'week',
    basis: 'devDone', measure: 'estimate', who: 'dev', hoursPerDay: 8, unit: 'h',
    panels: [], columns: [], types: [], grouped: true, excludeRequirementBugs: true, filtersByProject: {},
  };
  const fields = { estimate: [], devStart: [], devDone: ['customfield_2'] };
  const filters = { text: '登录+修复', stages: ['dev', 'done'] as const, priority: '高"优先级', component: '平台', version: 'v1', extraJql: 'labels = "加班" OR labels = "支持"' };

  it('所有筛选与项目、人员、日期取交集，补充条件中的 OR 被括号包裹', () => {
    const jql = hoursJql({ ...settings, filtersByProject: { TEST: { ...filters, stages: [...filters.stages] } } }, fields, settings.custom, 'TEST');
    for (const clause of ['project = "TEST"', 'cf[10204] = currentUser()', 'cf[2] >= "2026-11-01"', 'component = "平台"', 'affectedVersion = "v1"', 'summary ~ "登录 修复"', 'status in ("开发中", "联调中", "处理中", "产品验证通过", "关闭")', 'priority = "高\\"优先级"', '(labels = "加班" OR labels = "支持")']) {
      expect(jql).toContain(clause);
    }
    expect(jql).toMatch(/ ORDER BY updated DESC$/);
  });

  it('编号精确查找、未设置版本和实际工时条件', () => {
    const jql = hoursJql({ ...settings, measure: 'spent', filtersByProject: { '*': { ...filters, stages: [], text: 'test-12', version: NO_VERSION, extraJql: '' } } }, fields, settings.custom);
    expect(jql).toContain('key = "TEST-12"');
    expect(jql).toContain('affectedVersion is EMPTY');
    expect(jql).toContain('timespent > 0');
    expect(jql).not.toContain('status in');
  });

  it('项目切换不沿用其他项目的新增筛选条件', () => {
    const jql = hoursJql({ ...settings, filtersByProject: { TEST: { ...filters, stages: [] } } }, fields, settings.custom, 'OTHER');
    expect(jql).not.toContain('affectedVersion');
    expect(jql).not.toContain('priority =');
    expect(jql).not.toContain('labels =');
    expect(jql).toContain('project = "OTHER"');
  });
});
