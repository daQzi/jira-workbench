import { describe, expect, it } from 'vitest';
import { buildMessages, extractJson, sanitizeDraft } from './llm.mjs';

describe('大模型返回处理', () => {
  it('从代码块和说明文字里提取 JSON', () => {
    expect(extractJson('```json\n{"tasks":[]}\n```\n合计 12h')).toEqual({ tasks: [] });
    expect(extractJson('好的：{"tasks":[{"title":"a}b"}]} 以上')).toEqual({ tasks: [{ title: 'a}b' }] });
    expect(() => extractJson('无法拆分')).toThrow('没有返回 JSON');
    expect(() => extractJson('{"tasks":[')).toThrow('不完整');
  });

  it('结构清洗：非法值置空，空标题丢弃', () => {
    const r = sanitizeDraft({
      tasks: [
        { title: ' 联调 ', hours: '6', hoursSource: 'input', project: 'agent', parentKey: 'ylzhxt-1', subtasks: [{ title: 'x', hours: -1 }, { title: '' }] },
        { title: '', hours: 2 },
        { title: '估算', hours: 'abc', project: 'a b', parentKey: 'drop table' },
      ],
    });
    expect(r).toEqual([
      { title: '联调', hours: 6, hoursSource: 'input', project: 'AGENT', parentKey: 'YLZHXT-1', contact: null, sourceLine: '', subtasks: [{ title: 'x', hours: null }] },
      { title: '估算', hours: null, hoursSource: 'estimated', project: null, parentKey: null, contact: null, sourceLine: '', subtasks: [] },
    ]);
    expect(() => sanitizeDraft({})).toThrow('tasks');
  });

  it('提示词带上限与团队补充要求', () => {
    const [sys, user] = buildMessages({ text: '日报', date: '2026-10-27', defaultProject: 'AGENT', projects: ['AGENT'] }, 6, '按前后端拆');
    expect(sys.content).toContain('不超过 6');
    expect(sys.content).toContain('按前后端拆');
    expect(user.content).toContain('默认项目：AGENT');
  });
});
