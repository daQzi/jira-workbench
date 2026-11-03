import { describe, expect, it } from 'vitest';
import { buildJql, isIssueKey, quote } from './jql';

describe('quote', () => {
  it('转义引号和反斜杠', () => {
    expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

describe('buildJql', () => {
  it('组合项目/类型/模块并排序', () => {
    expect(buildJql({ project: 'YLZHXT', types: ['需求'], component: '01-综合收费' })).toBe(
      'project = "YLZHXT" AND issuetype in ("需求") AND component = "01-综合收费" ORDER BY updated DESC',
    );
  });

  it('问题编号走 key 精确匹配', () => {
    expect(isIssueKey('ylzhxt-123')).toBe(true);
    expect(buildJql({ text: 'ylzhxt-123' }, '')).toBe('key = "YLZHXT-123"');
  });

  it('关键字去掉 Lucene 特殊字符，防止 JQL 报错', () => {
    expect(buildJql({ text: '导出(excel) "报错"*' }, '')).toBe('summary ~ "导出 excel 报错"');
    expect(buildJql({ text: '  ***  ' }, '')).toBe('');
  });

  it('阶段展开为状态集合', () => {
    expect(buildJql({ stages: ['dev'] }, '')).toBe('status in ("开发中", "联调中", "处理中")');
  });

  it('近期已完成过滤', () => {
    expect(buildJql({ recentClosedDays: 30, closedStatuses: ['关闭'] }, '')).toBe(
      '(status not in ("关闭") OR updated >= -30d)',
    );
  });
});
