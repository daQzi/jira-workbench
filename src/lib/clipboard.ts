// 复制问题引用：「KEY 标题」，可附 Jira 链接，方便贴到群聊/日报。

export function issueRef(key: string, summary: string, jiraBaseUrl?: string): string {
  const head = `${key} ${summary.trim()}`;
  return jiraBaseUrl ? `${head}\n${jiraBaseUrl.replace(/\/+$/, '')}/browse/${key}` : head;
}

/** 优先用 Clipboard API；不可用（非安全上下文等）时退回 execCommand */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      return await navigator.clipboard.writeText(text);
    } catch {
      /* 继续走兜底 */
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('浏览器拒绝了剪贴板访问');
}
