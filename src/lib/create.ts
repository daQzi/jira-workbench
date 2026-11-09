import { api } from './api';
import { issueLinkBody } from './links';
import { planCreate, type CreateInput } from './createPlan';
export * from './createPlan';

export interface CreateResult {
  key: string;
  /** 问题已建成功、但后续步骤（补建链接/上传附件）失败的说明 */
  warnings: string[];
}

export async function submitCreate(input: CreateInput, files?: File[]): Promise<CreateResult> {
  const plan = planCreate(input);
  if (plan.missing.length || plan.unsupported.length) {
    throw new Error(`缺少必填项：${[...plan.missing, ...plan.unsupported].join('、')}`);
  }
  const created = await api.createIssue(plan.body);
  const warnings: string[] = [];
  {
    for (const l of plan.afterLinks) {
      try {
        await api.addLink(issueLinkBody(created.key, l));
      } catch (e) {
        // 问题已建成功，链接失败不能吞掉，要明确告诉用户
        warnings.push(`关联 ${l.key} 失败：${(e as Error).message}`);
      }
    }
  }
  if (files?.length) {
    try {
      await api.uploadAttachments(created.key, files);
    } catch (e) {
      warnings.push(`附件上传失败：${(e as Error).message}`);
    }
  }
  return { key: created.key, warnings };
}

/** 多行粘贴批量新建：每行一个标题，去掉空行和列表符号 */
export function parseBatchTitles(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
    .filter(Boolean);
}

export const CHILD_TYPES = ['编码任务', 'BUG及数据问题', '其他任务'];
