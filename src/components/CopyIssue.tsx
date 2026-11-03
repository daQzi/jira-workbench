import { useCallback } from 'react';
import { copyText, issueRef } from '../lib/clipboard';
import { useSession } from '../lib/session';

/** 复制「KEY 标题」（withLink 时附 Jira 链接），结果用 toast 提示 */
export function useCopyIssue() {
  const { me, toast } = useSession();
  return useCallback(
    async (key: string, summary: string, withLink = false) => {
      try {
        await copyText(issueRef(key, summary, withLink ? me.jiraBaseUrl : undefined));
        toast(withLink ? `已复制 ${key} 标题和链接` : `已复制 ${key} ${summary.slice(0, 20)}`);
      } catch (e) {
        toast(`复制失败：${(e as Error).message}`, 'error');
      }
    },
    [me.jiraBaseUrl, toast],
  );
}

/** 行内小按钮：点击复制编号+标题，⇧ 点击连链接一起复制 */
export function CopyIssueButton({ issueKey, summary, className = 'row-action' }: { issueKey: string; summary: string; className?: string }) {
  const copy = useCopyIssue();
  return (
    <button
      className={className}
      title="复制编号和标题（⇧ 点击连同链接）"
      aria-label={`复制 ${issueKey} 编号和标题`}
      onClick={(e) => {
        e.stopPropagation();
        copy(issueKey, summary, e.shiftKey);
      }}
    >
      复制
    </button>
  );
}
