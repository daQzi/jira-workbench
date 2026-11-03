import { describe, expect, it } from 'vitest';
import { issueRef } from './clipboard';

describe('issueRef', () => {
  it('编号 + 标题，可附链接', () => {
    expect(issueRef('A-1', ' 修复登录 ')).toBe('A-1 修复登录');
    expect(issueRef('A-1', '修复登录', 'http://jira:8080/')).toBe('A-1 修复登录\nhttp://jira:8080/browse/A-1');
  });
});
