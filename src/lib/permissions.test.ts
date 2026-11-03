import { describe, expect, it } from 'vitest';
import { canDeleteAttachment, canDeleteComment, canEditComment } from './permissions';

describe('评论/附件权限', () => {
  const me = 'wzw';
  const mine = { name: 'wzw' };
  const other = { name: 'x' };
  it('只有「自己的」权限时只能操作自己的', () => {
    const p = { EDIT_OWN_COMMENTS: true, DELETE_OWN_COMMENTS: true, DELETE_OWN_ATTACHMENTS: true };
    expect(canEditComment(p, mine, me)).toBe(true);
    expect(canEditComment(p, other, me)).toBe(false);
    expect(canDeleteComment(p, other, me)).toBe(false);
    expect(canDeleteAttachment(p, mine, me)).toBe(true);
    expect(canDeleteAttachment(p, undefined, me)).toBe(false);
  });
  it('「所有的」权限可操作他人的；无权限都不行', () => {
    const p = { EDIT_ALL_COMMENTS: true, DELETE_ALL_COMMENTS: true, DELETE_ALL_ATTACHMENTS: true };
    expect(canEditComment(p, other, me)).toBe(true);
    expect(canDeleteComment(p, other, me)).toBe(true);
    expect(canDeleteAttachment(p, other, me)).toBe(true);
    expect(canEditComment({}, mine, me)).toBe(false);
  });
  it('兼容 Jira 6.0 的键名', () => {
    const p = { COMMENT_EDIT_OWN: true, COMMENT_DELETE_ALL: true, ATTACHMENT_DELETE_OWN: true };
    expect(canEditComment(p, mine, me)).toBe(true);
    expect(canEditComment(p, other, me)).toBe(false);
    expect(canDeleteComment(p, other, me)).toBe(true);
    expect(canDeleteAttachment(p, other, me)).toBe(false);
    expect(canDeleteAttachment(p, mine, me)).toBe(true);
  });
});
