import { describe, expect, it } from 'vitest';
import { entriesText, entryProblems, missingDays, monthRange, shiftMonth, totalHours, weekdayLabel, workdaysBetween } from './a8';

describe('A8 工时区间', () => {
  it('月份区间含闰年与 12 月', () => {
    expect(monthRange('2026-11')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(monthRange('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
  });

  it('工作日排除周末，跨月正确', () => {
    expect(workdaysBetween('2026-11-01', '2026-11-08')).toEqual([
      '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06',
    ]);
    expect(workdaysBetween('2026-11-28', '2026-12-01')).toEqual(['2026-11-30', '2026-12-01']);
  });

  it('缺失日期：去重、升序、只留区间内，并标出周末', () => {
    expect(missingDays(['2026-11-06', '2026-11-02', '2026-11-02', '2026-10-31'], '2026-11-01', '2026-11-30')).toEqual([
      { date: '2026-11-02', weekend: false },
      { date: '2026-11-06', weekend: false },
    ]);
    expect(missingDays(['2026-11-07'], '2026-11-01', '2026-11-30')).toEqual([{ date: '2026-11-07', weekend: true }]);
  });

  it('星期标签', () => {
    expect(weekdayLabel('2026-11-20')).toBe('周五');
    expect(weekdayLabel('2026-11-22')).toBe('周日');
  });
});

describe('A8 草稿校验', () => {
  const base = { activityDate: '2026-11-20', jobType: '开发', hours: 8, description: '完成工时补全模块的前后端联调', jiraKeys: ['AGENT-1'] };

  it('合法条目没有提示', () => {
    expect(entryProblems(base)).toEqual([]);
    expect(entryProblems({ ...base, hours: 8.5 })).toEqual([]);
  });

  it('拦截越界工时、非半小时粒度、空描述', () => {
    expect(entryProblems({ ...base, hours: 0 })).toContain('工时需大于 0');
    expect(entryProblems({ ...base, hours: 13 })).toContain('工时不能超过 12h');
    expect(entryProblems({ ...base, hours: 8.3 })).toContain('工时需为 0.5 的整数倍');
    expect(entryProblems({ ...base, description: '  ' })).toContain('描述为空');
    expect(entryProblems({ ...base, description: '联调' })).toContain('描述过短');
  });

  it('合计与复制文本', () => {
    const list = [base, { ...base, activityDate: '2026-11-19', hours: 7.5 }];
    expect(totalHours(list)).toBe(15.5);
    expect(entriesText(list).split('\n')[0]).toBe('2026-11-20 周五\t开发\t8h\t完成工时补全模块的前后端联调');
  });
});
