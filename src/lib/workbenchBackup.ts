import { loadLocal, saveLocal, scopeKey } from './management';
import { validCards, type WorkbenchCard } from './workCards';
import { defaultTools, validTools, type ToolData } from '../features/tools/model';

/** 本机工作台备份：仅保存个人布局和工具内容，不包含 Jira 会话、任务内容或密码。 */
export interface WorkbenchBackup { format: 'jira-workbench-backup'; version: 1; cards: WorkbenchCard[]; tools: ToolData }
export function loadWorkbench(baseUrl: string, user: string): { cards: WorkbenchCard[] | null; tools: ToolData } {
  const scope = scopeKey(baseUrl, user, null);
  return {
    cards: loadLocal<WorkbenchCard[] | null>(`wb.workCards.v2:${scope}`, null, (v): v is WorkbenchCard[] | null => validCards(v)),
    tools: loadLocal(`wb.tools.v1:${scope}`, defaultTools(), validTools),
  };
}
export function makeBackup(cards: WorkbenchCard[], tools: ToolData): WorkbenchBackup { return { format: 'jira-workbench-backup', version: 1, cards, tools }; }
export function validBackup(value: unknown): value is WorkbenchBackup {
  const b = value as Partial<WorkbenchBackup> | null;
  return !!b && Object.keys(b).length === 4 && b.format === 'jira-workbench-backup' && b.version === 1 && validCards(b.cards) && validTools(b.tools);
}
export function saveWorkbench(baseUrl: string, user: string, cards: WorkbenchCard[], tools: ToolData): boolean {
  const scope = scopeKey(baseUrl, user, null);
  if (!validCards(cards) || !validTools(tools)) return false;
  return saveLocal(`wb.workCards.v2:${scope}`, cards) && saveLocal(`wb.tools.v1:${scope}`, tools);
}

export function downloadBackup(cards: WorkbenchCard[], tools: ToolData) {
  const blob = new Blob([JSON.stringify(makeBackup(cards, tools), null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = `jira-workbench-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function readBackup(file: File): Promise<WorkbenchBackup> {
  if (file.size > 1_000_000) throw new Error('备份文件不能超过 1 MB');
  const data: unknown = JSON.parse(await file.text());
  if (!validBackup(data)) throw new Error('备份格式或内容不正确，请选择本工作台导出的 JSON 文件');
  return data;
}
