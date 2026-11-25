import { describe, expect, it } from 'vitest';
import { cleanEntriesForTest } from './a8-draft.mjs';

describe('A8 草稿推送入参', () => {
  it('工时按 0.5 取整校验，日期必须有效', () => {
    expect(() => cleanEntriesForTest([{ activityDate: '2026-11-03', hours: 7.2, description: '写接口' }])).toThrow(
      /0\.5/,
    );
    expect(() => cleanEntriesForTest([{ activityDate: '2026/11/03', hours: 8, description: '写接口' }])).toThrow(
      /日期格式/,
    );
  });

  it('描述为空或工时非正数时拒绝', () => {
    expect(() => cleanEntriesForTest([{ activityDate: '2026-11-03', hours: 8, description: '   ' }])).toThrow(
      /描述为空/,
    );
    expect(() => cleanEntriesForTest([{ activityDate: '2026-11-03', hours: 0, description: '写接口' }])).toThrow(
      /大于 0/,
    );
  });

  it('同一天出现两条时拒绝，避免 A8 两行重复', () => {
    expect(() =>
      cleanEntriesForTest([
        { activityDate: '2026-11-03', hours: 4, description: '写接口' },
        { activityDate: '2026-11-03', hours: 4, description: '改 bug' },
      ]),
    ).toThrow(/两条/);
  });

  it('保留模板任务类型，缺省时回填', () => {
    const out = cleanEntriesForTest(
      [{ activityDate: '2026-11-03', hours: 8, description: '写接口', jobTypeId: '-1' }],
      '-9',
    );
    expect(out[0].jobTypeId).toBe('-1');
    const fallback = cleanEntriesForTest([{ activityDate: '2026-11-03', hours: 8, description: '写接口' }], '-9');
    expect(fallback[0].jobTypeId).toBe('-9');
  });
});
