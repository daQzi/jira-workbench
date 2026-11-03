import { describe, expect, it } from 'vitest';
import { checkWrite, fileResponseHeaders, isAttachmentUpload, linkDeleteId, ownedTarget, parseFilePath } from './policy.mjs';

const on = { allowWrite: true, writeProjects: ['AGENT'] };

describe('写操作策略', () => {
  it('未开启时一律拒绝', () => {
    expect(checkWrite({ allowWrite: false, writeProjects: [] }, 'POST', 'issue', {})?.status).toBe(405);
  });

  it('白名单项目内放行', () => {
    expect(checkWrite(on, 'POST', 'issue', { fields: { project: { key: 'AGENT' } } })).toBeNull();
    expect(checkWrite(on, 'PUT', 'issue/AGENT-2', {})).toBeNull();
    expect(checkWrite(on, 'POST', 'issue/agent-2/transitions', {})).toBeNull();
    expect(checkWrite(on, 'POST', 'issueLink', { inwardIssue: { key: 'AGENT-3' }, outwardIssue: { key: 'AGENT-1' } })).toBeNull();
  });

  it('项目范围外拒绝，包括通过链接牵涉到的问题', () => {
    expect(checkWrite(on, 'PUT', 'issue/YLZHXT-1', {})?.status).toBe(403);
    expect(checkWrite(on, 'POST', 'issue', { fields: { project: { key: 'YLZHXT' } } })?.status).toBe(403);
    expect(
      checkWrite(on, 'POST', 'issue', {
        fields: { project: { key: 'AGENT' } },
        update: { issuelinks: [{ add: { type: { name: 'Blocks' }, outwardIssue: { key: 'YLZHXT-9' } } }] },
      })?.status,
    ).toBe(403);
    expect(checkWrite(on, 'POST', 'issueLink', { inwardIssue: { key: 'AGENT-3' }, outwardIssue: { key: 'ZHBZ-1' } })?.status).toBe(403);
  });

  it('不允许删除和未登记接口', () => {
    expect(checkWrite(on, 'DELETE', 'issue/AGENT-1', {})?.status).toBe(403);
    expect(checkWrite(on, 'DELETE', 'attachment/123', {})?.status).toBe(400);
    expect(checkWrite(on, 'DELETE', 'attachment/abc', { issueKey: 'AGENT-1' })?.status).toBe(403);
    expect(checkWrite(on, 'PUT', 'project/AGENT', {})?.status).toBe(403);
  });

  it('移除链接按两端项目控制，缺少两端信息时拒绝', () => {
    expect(linkDeleteId('DELETE', 'issueLink/123')).toBe('123');
    expect(linkDeleteId('DELETE', 'issueLink/abc')).toBeNull();
    expect(linkDeleteId('POST', 'issueLink/123')).toBeNull();
    expect(checkWrite(on, 'DELETE', 'issueLink/123', { inwardIssue: { key: 'AGENT-3' }, outwardIssue: { key: 'AGENT-1' } })).toBeNull();
    expect(checkWrite(on, 'DELETE', 'issueLink/123', { inwardIssue: { key: 'AGENT-3' }, outwardIssue: { key: 'YLZHXT-1' } })?.status).toBe(403);
    expect(checkWrite(on, 'DELETE', 'issueLink/123', null)?.status).toBe(400);
  });

  it('附件上传按项目范围控制', () => {
    expect(checkWrite(on, 'POST', 'issue/AGENT-1/attachments', null)).toBeNull();
    expect(checkWrite(on, 'POST', 'issue/YLZHXT-1/attachments', null)?.status).toBe(403);
    expect(isAttachmentUpload('POST', 'issue/AGENT-1/attachments')).toBe(true);
    expect(isAttachmentUpload('POST', 'issue/AGENT-1/comment')).toBe(false);
  });

  it('附件文件路径与响应头', () => {
    expect(parseFilePath('attachment/267708/11.png')).toEqual({ kind: 'attachment', id: '267708', name: '11.png' });
    expect(parseFilePath('attachment/../x')).toBeNull();
    expect(parseFilePath('other/1/a')).toBeNull();
    expect(fileResponseHeaders('image/png', 'a.png')['Content-Disposition']).toMatch(/^inline/);
    const html = fileResponseHeaders('text/html', '页.html');
    expect(html['Content-Type']).toBe('application/octet-stream');
    expect(html['Content-Disposition']).toMatch(/^attachment/);
    expect(fileResponseHeaders('image/svg+xml', 'a.svg')['Content-Type']).toBe('application/octet-stream');
  });

  it('缺字段时 400', () => {
    expect(checkWrite(on, 'POST', 'issue', { fields: {} })?.status).toBe(400);
    expect(checkWrite(on, 'POST', 'issueLink', { inwardIssue: { key: 'AGENT-1' } })?.status).toBe(400);
  });

  it('未限定项目时放行全部项目', () => {
    expect(checkWrite({ allowWrite: true, writeProjects: [] }, 'PUT', 'issue/YLZHXT-1', {})).toBeNull();
  });

  it('评论编辑删除、附件删除按所属问题的项目控制', () => {
    expect(checkWrite(on, 'PUT', 'issue/AGENT-1/comment/10', {})).toBeNull();
    expect(checkWrite(on, 'DELETE', 'issue/AGENT-1/comment/10', null)).toBeNull();
    expect(checkWrite(on, 'DELETE', 'issue/YLZHXT-1/comment/10', null)?.status).toBe(403);
    expect(checkWrite(on, 'DELETE', 'attachment/5', { issueKey: 'AGENT-1' })).toBeNull();
    expect(checkWrite(on, 'DELETE', 'attachment/5', { issueKey: 'YLZHXT-1' })?.status).toBe(403);
    expect(checkWrite(on, 'DELETE', 'attachment/5', { issueKey: null })?.status).toBe(400);
  });

  it('ownedTarget 解析归属目标', () => {
    expect(ownedTarget('PUT', 'issue/agent-1/comment/10', null)).toEqual({ kind: 'comment', key: 'AGENT-1', id: '10' });
    expect(ownedTarget('POST', 'issue/AGENT-1/comment/10', null)).toBeNull();
    expect(ownedTarget('DELETE', 'attachment/5', new URLSearchParams('issueKey=AGENT-1'))).toEqual({ kind: 'attachment', key: 'AGENT-1', id: '5' });
    expect(ownedTarget('DELETE', 'attachment/5', new URLSearchParams('issueKey=bad key'))).toEqual({ kind: 'attachment', key: null, id: '5' });
    expect(ownedTarget('DELETE', 'issue/AGENT-1', null)).toBeNull();
  });
});
