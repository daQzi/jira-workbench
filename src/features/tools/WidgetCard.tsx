import type { SetStateAction } from 'react';
import { NotesPanel, TodosPanel } from './ToolPanels';
import type { ToolData } from './model';
export function WidgetCard({ kind, data, save }: { kind: 'notes' | 'todos'; data: ToolData; save: (update: SetStateAction<ToolData>) => boolean }) {
  return <div className="widget-card-content">{kind === 'notes' ? <NotesPanel data={data} save={save}/> : <TodosPanel data={data} save={save}/>}</div>;
}
