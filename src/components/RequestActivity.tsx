import { useEffect, useState, useSyncExternalStore } from 'react';
import { requestActivity, subscribeRequestActivity } from '../lib/requestActivity';

/** 短请求不闪屏；写入由接口边界统一去重，界面上再阻止其他点击和键盘操作。 */
export function RequestActivity() {
  const pending = useSyncExternalStore(subscribeRequestActivity, requestActivity);
  const [, setNow] = useState(() => Date.now());
  const [shownAt, setShownAt] = useState<number | null>(null);
  const active = pending.reads + pending.writes > 0;
  useEffect(() => {
    if (!active) {
      setShownAt(null);
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => {
    if (!pending.writes) return;
    const lock = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener('keydown', lock, true);
    return () => document.removeEventListener('keydown', lock, true);
  }, [pending.writes]);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setShownAt(Date.now()), pending.writes ? 150 : 350);
    return () => clearTimeout(timer);
  }, [active, pending.writes > 0]);

  if (!active || shownAt === null) return null;
  if (pending.writes) {
    return (
      <div className="request-write-mask" role="status" aria-live="polite" aria-label="正在提交，请勿重复操作">
        <div className="request-write-card">
          <div className="request-orbit" aria-hidden="true"><span /><i /></div>
          <strong>正在提交</strong>
          <span>请稍候，完成后会自动继续</span>
          <div className="request-progress" aria-hidden="true"><i /></div>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="request-top-progress" aria-hidden="true"><i /></div>
      <div className="request-read-status" role="status" aria-live="polite">
        <span className="request-pulse" aria-hidden="true" />
        正在同步 Jira 数据
      </div>
    </>
  );
}
