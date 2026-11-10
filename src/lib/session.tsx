import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { canWrite, type Me } from './api';
import { clearReadCache } from './requestCache';

interface SessionValue {
  me: Me;
  /** 写操作成功后递增，各视图把它放进依赖以重新加载 */
  version: number;
  bump: () => void;
  canWriteProject: (projectKey: string | null | undefined) => boolean;
  canWriteIssue: (issueKey: string) => boolean;
  toast: (msg: string, kind?: 'ok' | 'error') => void;
}

const Ctx = createContext<SessionValue | null>(null);

interface Toast {
  id: number;
  msg: string;
  kind: 'ok' | 'error';
}

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const bump = useCallback(() => { clearReadCache(key => key.startsWith('search:') || key.startsWith('first:')); setVersion((v) => v + 1); }, []);
  const toast = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 2500);
  }, []);
  // macOS 桌面外壳下载附件后会派发此事件（浏览器里不会触发）
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ ok: boolean; name?: string; error?: string }>).detail;
      if (d?.ok) toast(`已下载到「下载」文件夹：${d.name}`);
      else toast(`下载失败：${d?.error ?? '未知错误'}`, 'error');
    };
    window.addEventListener('wb-native-download', on);
    return () => window.removeEventListener('wb-native-download', on);
  }, [toast]);
  const value = useMemo<SessionValue>(
    () => ({
      me,
      version,
      bump,
      toast,
      canWriteProject: (p) => canWrite(me, p),
      canWriteIssue: (k) => canWrite(me, k.split('-')[0]),
    }),
    [me, version, bump, toast],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession 必须在 SessionProvider 内使用');
  return v;
}
