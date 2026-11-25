// 联调栈：同源 iframe 挂 /stack/，复用 stack/ui 一份界面。
// 用 iframe 而不是搬组件，是因为它需要独立滚动/独立快捷键，且与工作台功能无耦合。
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../lib/session';

export function StackView() {
  const { toast } = useSession();
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [full, setFull] = useState(false);

  useEffect(() => {
    if (!loaded) return;
    let alive = true;
    fetch('/api/stack/status', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [loaded]);

  return (
    <div className={`stack-view${full ? ' is-full' : ''}`}>
      <div className="stack-view-bar">
        <span className={`dot-dot${error ? ' err' : ''}`} />
        <strong>联调栈</strong>
        <span className="muted">多环境代理 · 本地前端服务编排，随工作台启停</span>
        <span className="grow" />
        {error ? <span className="err">{error}</span> : null}
        <button className="btn small" onClick={() => frame.current?.contentWindow?.location.reload()}>
          重载
        </button>
        <button className="btn small" onClick={() => window.open('/stack/', '_blank')}>
          新窗口打开
        </button>
        <button className="btn small" onClick={() => setFull((v) => !v)}>
          {full ? '退出全屏' : '全屏'}
        </button>
        <button
          className="btn small"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(`${location.origin}/stack/`);
              toast('已复制联调栈地址');
            } catch {
              toast('复制失败', 'error');
            }
          }}
        >
          复制地址
        </button>
      </div>
      {!loaded && !error ? <div className="state">正在加载联调栈…</div> : null}
      <iframe
        ref={frame}
        className="stack-frame"
        src="/stack/"
        title="联调栈"
        onLoad={() => setLoaded(true)}
        onError={() => setError('联调栈页面加载失败')}
      />
    </div>
  );
}
