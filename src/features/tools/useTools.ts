import { useState, type SetStateAction } from 'react';
import { saveLocal } from '../../lib/management';
import { useSession } from '../../lib/session';
import { loadWorkbench } from '../../lib/workbenchBackup';
import type { ToolData } from './model';

export function useTools() {
  const { me, toast } = useSession();
  const [store] = useState(() => `wb.tools.v1:${me.jiraBaseUrl}:${me.name}:*`);
  const [data, setData] = useState(() => loadWorkbench(me.jiraBaseUrl, me.name).tools);
  function save(update: SetStateAction<ToolData>) {
    const next = typeof update === 'function' ? update(data) : update;
    if (!saveLocal(store, next)) { toast('无法保存本机工具数据，请检查存储空间', 'error'); return false; }
    setData(next); return true;
  }
  return { data, save, replace: setData };
}
