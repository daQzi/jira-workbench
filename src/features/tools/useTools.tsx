import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type SetStateAction } from 'react';
import { loadLocal, saveLocal, scopeKey } from '../../lib/management';
import { useSession } from '../../lib/session';
import { loadWorkbench } from '../../lib/workbenchBackup';
import { defaultTools, validTools, type ToolData } from './model';

interface ToolsState { data: ToolData; save: (update: SetStateAction<ToolData>) => boolean; replace: (data: ToolData) => void }
const Context = createContext<ToolsState | null>(null);

/** 一个账号只有一份工具状态，卡片、工具箱和导入入口共同订阅。 */
export function ToolsProvider({ children }: { children: ReactNode }) {
  const { me, toast } = useSession();
  const store = `wb.tools.v1:${scopeKey(me.jiraBaseUrl, me.name, null)}`;
  const [data, setData] = useState(() => loadWorkbench(me.jiraBaseUrl, me.name).tools);
  const latest = useRef(data);
  const replace = useCallback((next: ToolData) => { latest.current = next; setData(next); }, []);
  useEffect(() => {
    replace(loadLocal(store, defaultTools(), validTools));
    const sync = (event: StorageEvent) => { if (event.storageArea === localStorage && (event.key === store || event.key === null)) replace(loadLocal(store, defaultTools(), validTools)); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [store, replace]);
  const save = useCallback((update: SetStateAction<ToolData>) => {
    // 写前读取最新持久化数据，避免另一浏览器窗口的保存被旧闭包覆盖。
    const current = loadLocal(store, latest.current, validTools);
    const next = typeof update === 'function' ? update(current) : update;
    if (!validTools(next)) { toast('工具内容超过限制或格式不正确，未保存', 'error'); return false; }
    if (!saveLocal(store, next)) { toast('无法保存本机工具数据，请检查存储空间', 'error'); return false; }
    replace(next); return true;
  }, [store, toast, replace]);
  const value = useMemo(() => ({ data, save, replace }), [data, save, replace]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useTools(): ToolsState {
  const state = useContext(Context);
  if (!state) throw new Error('useTools 必须在 ToolsProvider 内使用');
  return state;
}
