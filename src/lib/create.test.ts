import { describe, expect, it } from 'vitest';
import { orderedFieldIds, parseBatchTitles, planCreate } from './create';
import type { CreateMetaType } from './api';

const type: CreateMetaType = {
  id: '3',
  name: '编码任务',
  fields: {
    project: { required: true, name: '项目', schema: { type: 'project' } },
    issuetype: { required: true, name: '问题类型', schema: { type: 'issuetype' } },
    description: { required: false, name: '描述', schema: { type: 'string', system: 'description' } },
    summary: { required: true, name: '主题', schema: { type: 'string', system: 'summary' } },
    components: { required: true, name: '模块', schema: { type: 'array', items: 'component' }, allowedValues: [{ id: '7', name: 'M' }] },
    issuelinks: { required: false, name: '链接的问题', schema: { type: 'array', items: 'issuelinks' } },
  },
};

describe('planCreate', () => {
  it('普通新建：校验必填', () => {
    const p = planCreate({ projectKey: 'AGENT', type, values: { summary: 'x' } });
    expect(p.missing).toEqual(['模块']);
    expect(p.body.fields).toEqual({ summary: 'x', project: { key: 'AGENT' }, issuetype: { id: '3' } });
    expect(p.body.update).toBeUndefined();
  });

  it('子任务：继承父需求模块并随创建挂 Blocks 链接', () => {
    const p = planCreate({
      projectKey: 'AGENT',
      type,
      values: { summary: '子任务' },
      parent: { key: 'AGENT-1', fields: { components: [{ id: '7', name: 'M' }] } },
    });
    expect(p.missing).toEqual([]);
    expect(p.body.fields.components).toEqual([{ id: '7' }]);
    expect(p.body.update).toEqual({
      issuelinks: [{ add: { type: { name: 'Blocks' }, outwardIssue: { key: 'AGENT-1' } } }],
    });
    expect(p.afterLinks).toEqual([]);
  });

  it('多条关联：父需求随创建提交，其余创建后补建（Jira 6.0 只接受 1 条）', () => {
    const p = planCreate({
      projectKey: 'AGENT',
      type,
      values: { summary: 's', components: ['7'] },
      parent: { key: 'AGENT-1', fields: {} },
      links: [
        { option: { type: 'Relates', dir: 'out' }, key: 'AGENT-2' },
        { option: { type: 'Blocks', dir: 'out' }, key: 'AGENT-1' },
      ],
    });
    expect((p.body.update as { issuelinks: unknown[] }).issuelinks).toHaveLength(1);
    expect(p.afterLinks).toEqual([{ option: { type: 'Relates', dir: 'out' }, key: 'AGENT-2' }]);
  });

  it('没有父需求时第一条普通关联随创建提交', () => {
    const p = planCreate({ projectKey: 'AGENT', type, values: { summary: 's', components: ['7'] }, links: [{ option: { type: 'Relates', dir: 'out' }, key: 'AGENT-2' }] });
    expect(p.body.update).toEqual({ issuelinks: [{ add: { type: { name: 'Relates' }, outwardIssue: { key: 'AGENT-2' } } }] });
  });

  it('表单值覆盖继承值', () => {
    const p = planCreate({
      projectKey: 'AGENT',
      type: { ...type, fields: { ...type.fields, components: { ...type.fields.components, allowedValues: [{ id: '7' }, { id: '8' }] } } },
      values: { summary: 's', components: ['8'] },
      parent: { key: 'AGENT-1', fields: { components: [{ id: '7' }] } },
    });
    expect(p.body.fields.components).toEqual([{ id: '8' }]);
  });
});

describe('orderedFieldIds', () => {
  it('常用字段在前，隐藏上下文字段', () => {
    expect(orderedFieldIds(type)).toEqual(['summary', 'components', 'description']);
  });
});

describe('parseBatchTitles', () => {
  it('去掉空行和列表符号', () => {
    expect(parseBatchTitles('1. 甲\n\n- 乙\n  * 丙 \n2、丁\n戊')).toEqual(['甲', '乙', '丙', '丁', '戊']);
  });
});
