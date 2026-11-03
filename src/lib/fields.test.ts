import { describe, expect, it } from 'vitest';
import { buildFields, editValue, fromJiraValue, inheritFields, inputKind, toJiraDateTime, toJiraValue, type FieldMeta } from './fields';

const CT = 'com.atlassian.jira.plugin.system.customfieldtypes:';
const f = (schema: FieldMeta['schema'], extra: Partial<FieldMeta> = {}): FieldMeta => ({ required: false, name: 'x', schema, ...extra });

describe('inputKind', () => {
  it('按 schema 选控件', () => {
    expect(inputKind('summary', f({ type: 'string', system: 'summary' }))).toBe('text');
    expect(inputKind('description', f({ type: 'string' }))).toBe('textarea');
    expect(inputKind('customfield_11135', f({ type: 'string', custom: `${CT}textarea` }))).toBe('textarea');
    expect(inputKind('customfield_10202', f({ type: 'string', custom: `${CT}select` }, { allowedValues: [{ id: '1' }] }))).toBe('select');
    expect(inputKind('assignee', f({ type: 'user' }))).toBe('user');
    expect(inputKind('components', f({ type: 'array', items: 'component' }, { allowedValues: [] }))).toBe('multiselect');
    expect(inputKind('customfield_10700', f({ type: 'array', items: 'string', custom: `${CT}labels` }))).toBe('labels');
    expect(inputKind('customfield_11130', f({ type: 'string', custom: `${CT}cascadingselect` }, { allowedValues: [] }))).toBe('cascade');
    expect(inputKind('customfield_11130', f({ type: 'string', custom: `${CT}cascadingselect` }))).toBeNull();
    expect(inputKind('attachment', f({ type: 'array', items: 'attachment' }))).toBeNull();
  });
});

describe('toJiraValue', () => {
  it('转换为 REST 结构', () => {
    expect(toJiraValue('assignee', f({ type: 'user' }), '王志伟')).toEqual({ name: '王志伟' });
    expect(toJiraValue('resolution', f({ type: 'resolution' }, { allowedValues: [{ id: '1' }] }), '1')).toEqual({ id: '1' });
    expect(toJiraValue('components', f({ type: 'array', items: 'component' }, { allowedValues: [] }), ['10', '11'])).toEqual([
      { id: '10' },
      { id: '11' },
    ]);
    expect(toJiraValue('labels', f({ type: 'array', items: 'string' }), 'a, b  c')).toEqual(['a', 'b', 'c']);
    expect(toJiraValue('customfield_10218', f({ type: 'string' }), '  2d ')).toBe('2d');
    expect(toJiraValue('x', f({ type: 'string' }), '   ')).toBeUndefined();
  });

  it('级联选择', () => {
    const m = f({ type: 'string', custom: `${CT}cascadingselect` }, { allowedValues: [] });
    expect(toJiraValue('c', m, ['1', '2'])).toEqual({ id: '1', child: { id: '2' } });
    expect(toJiraValue('c', m, ['1'])).toEqual({ id: '1' });
    expect(toJiraValue('c', m, ['', ''])).toBeUndefined();
    expect(fromJiraValue('c', m, { id: '1', child: { id: '2' } })).toEqual(['1', '2']);
  });

  it('日期时间带时区', () => {
    expect(toJiraDateTime('2026-10-26T09:30', 480)).toBe('2026-10-26T09:30:00.000+0800');
  });
});

describe('fromJiraValue', () => {
  it('预填当前值', () => {
    expect(fromJiraValue('assignee', f({ type: 'user' }), { name: 'a' })).toBe('a');
    expect(fromJiraValue('components', f({ type: 'array', items: 'component' }, { allowedValues: [] }), [{ id: '5' }])).toEqual(['5']);
    expect(fromJiraValue('d', f({ type: 'datetime' }), '2026-10-26T09:30:00.000+0800')).toBe('2026-10-26T09:30');
  });
});

describe('buildFields', () => {
  it('收集缺失和不支持的必填项', () => {
    const meta = {
      summary: f({ type: 'string' }, { required: true, name: '主题' }),
      components: f({ type: 'array', items: 'component' }, { required: true, name: '模块', allowedValues: [] }),
      customfield_11130: f({ type: 'string', custom: `${CT}cascadingselect` }, { required: true, name: '医疗子产品模块' }),
      priority: f({ type: 'priority' }, { allowedValues: [{ id: '3' }] }),
    };
    const r = buildFields(meta, { summary: '标题', priority: '3' });
    expect(r.fields).toEqual({ summary: '标题', priority: { id: '3' } });
    expect(r.missing).toEqual(['模块']);
    expect(r.unsupported).toEqual(['医疗子产品模块']);
  });
});

describe('inheritFields', () => {
  it('只继承子项可填的字段，并转换为提交结构', () => {
    const childMeta = {
      components: f({ type: 'array', items: 'component' }, { allowedValues: [] }),
      customfield_11130: f({ type: 'string', custom: `${CT}cascadingselect` }, { allowedValues: [] }),
      customfield_10400: f({ type: 'user' }),
      priority: f({ type: 'priority' }, { allowedValues: [] }),
    };
    const parent = {
      components: [{ id: '101', name: '01-综合收费' }],
      customfield_11130: { id: '9', value: '02', child: { id: '19', value: '收入' } },
      customfield_10400: { name: 'pm', displayName: 'PM' },
      customfield_11138: '不在子项 createmeta 里',
      priority: null,
    };
    expect(inheritFields(parent, childMeta)).toEqual({
      components: [{ id: '101' }],
      customfield_11130: { id: '9', child: { id: '19' } },
      customfield_10400: { name: 'pm' },
    });
  });
});

describe('editValue', () => {
  const text = f({ type: 'string' }, { name: '主题', operations: ['set'] });
  it('未变化不提交', () => {
    expect(editValue('summary', text, 'abc', ' abc ')).toEqual({ kind: 'unchanged' });
    expect(editValue('x', f({ type: 'string' }), null, '')).toEqual({ kind: 'unchanged' });
  });
  it('修改与清空', () => {
    expect(editValue('summary', text, 'abc', 'abd')).toEqual({ kind: 'set', value: 'abd' });
    expect(editValue('d', f({ type: 'date' }), '2026-10-01', '')).toEqual({ kind: 'set', value: null });
    const comps = f({ type: 'array', items: 'component' }, { allowedValues: [] });
    expect(editValue('components', comps, [{ id: '1' }], [])).toEqual({ kind: 'set', value: [] });
  });
  it('必填不能清空；不支持 set 的报错', () => {
    expect(editValue('summary', { ...text, required: true }, 'abc', '').kind).toBe('error');
    expect(editValue('x', f({ type: 'string' }, { operations: ['add'] }), 'a', 'b').kind).toBe('error');
  });
});
