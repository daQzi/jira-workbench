import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { prefersReducedMotion, readMotion, readSceneMode, sceneAllowed, webglAvailable } from './settings';
const CanvasScene = lazy(() => import('./OrbitCanvas'));

export function StaticOrbit({ compact = false }: { compact?: boolean }) {
  return <svg className={`static-orbit${compact ? ' compact' : ''}`} viewBox="0 0 400 300" role="img" aria-label="静态工作轨道"><ellipse cx="200" cy="155" rx="150" ry="58" fill="none" stroke="currentColor" opacity=".18"/><ellipse cx="200" cy="155" rx="104" ry="103" fill="none" stroke="currentColor" opacity=".16" transform="rotate(-35 200 155)"/><circle cx="200" cy="155" r="38" fill="currentColor" opacity=".16"/><circle cx="200" cy="155" r="26" fill="currentColor" opacity=".4"/><rect x="64" y="120" width="37" height="37" rx="10" fill="#8594ff" transform="rotate(-15 82 139)"/><path d="m311 134 20 31-39 0z" fill="#edbb73"/><circle cx="250" cy="62" r="17" fill="#83cfb5"/><rect x="163" y="221" width="40" height="40" rx="20" fill="none" stroke="#e59b91" strokeWidth="10"/></svg>;
}
export function OrbitScene({ compact = false, paused = false, children }: { compact?: boolean; paused?: boolean; children?: ReactNode }) {
  const [mode, setMode] = useState(readSceneMode); const [motion, setMotion] = useState(readMotion);
  const [reduced, setReduced] = useState(prefersReducedMotion); const [webgl] = useState(webglAvailable); const [failed, setFailed] = useState(false);
  const [inView, setInView] = useState(true); const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const listener = () => { setMode(readSceneMode()); setMotion(readMotion()); }; window.addEventListener('wb-visual-settings', listener); return () => window.removeEventListener('wb-visual-settings', listener); }, []);
  useEffect(() => { const m = window.matchMedia('(prefers-reduced-motion: reduce)'); const listener = () => setReduced(m.matches); m.addEventListener('change', listener); return () => m.removeEventListener('change', listener); }, []);
  useEffect(() => { const observer = new IntersectionObserver(entries => setInView(entries[0]?.isIntersecting ?? true)); if (ref.current) observer.observe(ref.current); return () => observer.disconnect(); }, []);
  const enabled = sceneAllowed(mode, reduced || motion === 'reduced', webgl) && !failed;
  return <div className={`orbit-scene${compact ? ' compact' : ''}${enabled ? ' is-3d' : ''}`} ref={ref} aria-label="工作轨道场景">{enabled ? <Suspense fallback={<StaticOrbit compact={compact}/>}><CanvasScene paused={paused || !inView} compact={compact} onError={() => setFailed(true)}/></Suspense> : <StaticOrbit compact={compact}/>} {children}</div>;
}
