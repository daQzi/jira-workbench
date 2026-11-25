import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWorklogMessages, sanitizeEntries } from './worklog.mjs';

const ISSUES = [
  { key: 'AGENT-12', summary: '登录改造', type: '编码任务', status: '开发中', updated: '2026-11-18T10:00:00.000+0800' },
  { key: 'YLZHXT-9', summary: '对账数据修复', type: 'BUG及数据问题', status: '已完成', updated: '2026-11-11T10:00:00.000+0800' },
];

describe('A8 工时草稿', () => {
  it('提示词包含缺失日期、任务编号与固定规则', () => {
    const [sys, user] = buildWorklogMessages({ dates: ['2026-11-17', '2026-11-18'], issues: ISSUES, hoursPerDay: 8 });
    expect(sys.content).toContain('每个日期恰好一条');
    expect(user.content).toContain('- 2026-11-17');
    expect(user.content).toContain('AGENT-12');
    expect(user.content).toContain('严禁编造编号');
  });

  it('清洗：只保留缺失日期、每日期一条、编号必须真实', () => {
    const out = sanitizeEntries(
      {
        entries: [
          { activityDate: '2026-11-18', hours: 9.3, description: '完成登录改造并自测', jiraKeys: ['agent-12', 'FAKE-1'] },
          { activityDate: '2026-11-18', hours: 4, description: '重复日期被丢弃' },
          { activityDate: '2026-11-17', hours: 0, description: '' },
          { activityDate: '2026-11-30', hours: 8, description: '不在缺失列表' },
        ],
      },
      ['2026-11-17', '2026-11-18'],
      ISSUES,
      8,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ activityDate: '2026-11-17', jobType: '开发', hours: 8, description: '', jiraKeys: [] });
    expect(out[1]).toEqual({
      activityDate: '2026-11-18',
      jobType: '开发',
      hours: 9.5,
      description: '完成登录改造并自测',
      jiraKeys: ['AGENT-12'],
    });
  });

  it('模型漏掉的日期用默认 8 小时占位，交给页面补写', () => {
    const out = sanitizeEntries({ entries: [] }, ['2026-11-17'], ISSUES, 6);
    expect(out[0].hours).toBe(6);
    expect(out[0].description).toBe('');
  });

  it('结构不对时明确报错', () => {
    expect(() => sanitizeEntries({}, ['2026-11-17'], ISSUES)).toThrow('entries');
  });

  it('描述里的「关联任务：编号」被去掉，编号只留在 jiraKeys', () => {
    const out = sanitizeEntries(
      { entries: [{ activityDate: '2026-11-17', hours: 8, description: '完成登录改造并自测通过。关联任务：AGENT-12、YLZHXT-9。', jiraKeys: ['AGENT-12'] }] },
      ['2026-11-17'],
      ISSUES,
    );
    expect(out[0].description).toBe('完成登录改造并自测通过。');
    expect(out[0].jiraKeys).toEqual(['AGENT-12']);
  });
});

describe('A8 工时草稿分批', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('按 5 天一批调用模型，合并结果并按日期排序', async () => {
    const { generateWorklog } = await import('./worklog.mjs');
    const { configureLlm } = await import('./llm.mjs');
    configureLlm({ baseUrl: 'http://llm.test/v1', model: 'm', apiKey: 'k' });
    const dates = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'];
    const calls = [];
    vi.stubGlobal('fetch', async (_url, init) => {
      const body = JSON.parse(init.body);
      const section = body.messages[1].content.split('## 缺失的工作日')[1].split('## 当月 Jira 任务')[0];
      const asked = section.match(/2026-\d\d-\d\d/g);
      calls.push(asked);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ entries: asked.map((d) => ({ activityDate: d, hours: 8, description: `完成 ${d} 的开发与自测` })) }) } }] }), { status: 200 });
    });
    const out = await generateWorklog({ dates, issues: ISSUES, hoursPerDay: 8 });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(5);
    expect(calls[1]).toEqual(['2026-11-09']);
    expect(out.entries.map((e) => e.activityDate)).toEqual(dates);
    expect(out.incomplete).toBe(false);
  });

  it('某批失败时保留其它批次，并给失败日期留空条目', async () => {
    const { generateWorklog } = await import('./worklog.mjs');
    const { configureLlm } = await import('./llm.mjs');
    configureLlm({ baseUrl: 'http://llm.test/v1', model: 'm', apiKey: 'k' });
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n++;
      if (n === 2) throw Object.assign(new Error('大模型响应超时'), { name: 'TimeoutError' });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ entries: [{ activityDate: '2026-11-02', hours: 8, description: '完成登录改造并自测通过' }] }) } }] }), { status: 200 });
    });
    const dates = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'];
    const out = await generateWorklog({ dates, issues: ISSUES, hoursPerDay: 8 });
    expect(out.entries).toHaveLength(6);
    expect(out.failedBatches).toBe(1);
    expect(out.incomplete).toBe(true);
    expect(out.entries.find((e) => e.activityDate === '2026-11-09').description).toBe('');
  });
});
