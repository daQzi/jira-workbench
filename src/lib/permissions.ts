// 评论/附件的编辑删除权限：按 Jira 的「自己的 / 所有的」两级权限判断。
// 最终仍以 Jira 接口为准，这里只决定按钮是否显示。

export type Perms = Record<string, boolean>;

// Jira 6.0 的键名是 COMMENT_EDIT_OWN 这种写法（已实测 /mypermissions），新版本是 EDIT_OWN_COMMENTS，两种都认
const has = (p: Perms, jira6: string, modern: string) => !!p[jira6] || !!p[modern];

const isMine = (author: { name?: string } | undefined, me: string) => !!author?.name && author.name === me;

export function canEditComment(p: Perms, author: { name?: string } | undefined, me: string): boolean {
  return has(p, 'COMMENT_EDIT_ALL', 'EDIT_ALL_COMMENTS') || (has(p, 'COMMENT_EDIT_OWN', 'EDIT_OWN_COMMENTS') && isMine(author, me));
}

export function canDeleteComment(p: Perms, author: { name?: string } | undefined, me: string): boolean {
  return has(p, 'COMMENT_DELETE_ALL', 'DELETE_ALL_COMMENTS') || (has(p, 'COMMENT_DELETE_OWN', 'DELETE_OWN_COMMENTS') && isMine(author, me));
}

export function canDeleteAttachment(p: Perms, author: { name?: string } | undefined, me: string): boolean {
  return has(p, 'ATTACHMENT_DELETE_ALL', 'DELETE_ALL_ATTACHMENTS') || (has(p, 'ATTACHMENT_DELETE_OWN', 'DELETE_OWN_ATTACHMENTS') && isMine(author, me));
}
