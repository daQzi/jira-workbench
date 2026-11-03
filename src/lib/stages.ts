// 把各项目工作流里的细分状态归并为看板阶段列。
// 状态名来自 Jira 实际配置（/rest/api/2/project/{key}/statuses），新增状态需在此补充。
export type StageId = 'todo' | 'design' | 'dev' | 'test' | 'done' | 'hold';

export interface Stage {
  id: StageId;
  name: string;
  statuses: string[];
}

export const STAGES: Stage[] = [
  { id: 'todo', name: '待处理', statuses: ['新增', '重新打开', '需求评估'] },
  {
    id: 'design',
    name: '设计评审',
    statuses: ['产品设计', '产品需求评审', '产品评审通过', '产品评审不通过', '研发设计', '设计评审通过', '设计评审不通过'],
  },
  { id: 'dev', name: '研发中', statuses: ['开发中', '联调中', '处理中'] },
  { id: 'test', name: '测试验证', statuses: ['开发完成', '测试中', '测试通过', '产品验证不通过', '处理完成'] },
  { id: 'done', name: '已完成', statuses: ['产品验证通过', '关闭'] },
  { id: 'hold', name: '暂缓/拒绝', statuses: ['暂缓', '拒绝'] },
];

const STATUS_TO_STAGE = new Map<string, StageId>(
  STAGES.flatMap((s) => s.statuses.map((st) => [st, s.id] as const)),
);

/** 未登记的状态返回 null，由调用方决定展示位置并提示 */
export function stageOf(status: string): StageId | null {
  return STATUS_TO_STAGE.get(status) ?? null;
}

export function stageName(id: StageId): string {
  return STAGES.find((s) => s.id === id)?.name ?? id;
}

/** 子项进度统计口径：已完成阶段或被拒绝都视为结束 */
export function isFinished(status: string): boolean {
  return stageOf(status) === 'done' || status === '拒绝';
}

export function statusesOf(stages: StageId[]): string[] {
  return STAGES.filter((s) => stages.includes(s.id)).flatMap((s) => s.statuses);
}

export const CLOSED_STATUSES = ['关闭', '产品验证通过', '拒绝'];
