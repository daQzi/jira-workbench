import { useEffect, useState } from 'react';
import { prefersReducedMotion, readMotion, readSceneMode, sceneAllowed, webglAvailable, type MotionPreference, type SceneMode } from './settings';

/** 登录页无会话也可用；保存仅代表本机外观设置。 */
export function SceneSettings({ compact = false }: { compact?: boolean }) {
  const [mode, setMode] = useState(readSceneMode); const [motion, setMotion] = useState(readMotion);
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const [webgl] = useState(webglAvailable);
  useEffect(() => { const m = window.matchMedia('(prefers-reduced-motion: reduce)'); const change = () => setReduced(m.matches); m.addEventListener('change', change); return () => m.removeEventListener('change', change); }, []);
  useEffect(() => { const change = () => { setMode(readSceneMode()); setMotion(readMotion()); }; window.addEventListener('wb-visual-settings', change); return () => window.removeEventListener('wb-visual-settings', change); }, []);
  useEffect(() => { document.documentElement.dataset.motion = motion === 'reduced' || reduced ? 'reduce' : 'normal'; }, [motion, reduced]);
  function chooseMode(value: SceneMode) { setMode(value); try { localStorage.setItem('wb.scene.v1', value); } catch { /* 设置仅影响外观 */ } window.dispatchEvent(new Event('wb-visual-settings')); }
  function chooseMotion(value: MotionPreference) { setMotion(value); try { localStorage.setItem('wb.motion.v1', value); } catch { /* 设置仅影响外观 */ } window.dispatchEvent(new Event('wb-visual-settings')); }
  return <section className={`scene-settings${compact ? ' compact' : ''}`} aria-label="界面动效设置"><div><strong>界面动效</strong><small>默认轻动效；不读取业务数据</small></div><label><span>过渡动画</span><select className="select" aria-label="过渡动画" value={motion} onChange={e => chooseMotion(e.target.value as MotionPreference)}><option value="normal">轻动效</option><option value="reduced">减少动画</option></select></label><label><span>3D 场景</span><select className="select" aria-label="3D 场景" value={mode} onChange={e => chooseMode(e.target.value as SceneMode)}><option value="auto">自动（推荐）</option><option value="on">始终开启</option><option value="off">关闭</option></select></label><p role="status">{!webgl ? '当前环境无 WebGL，将使用静态图形。' : mode === 'off' ? '3D 已关闭，不影响工作台使用。' : sceneAllowed(mode, reduced, webgl) ? '登录页轨道与工具箱星图已启用，页面隐藏时暂停。' : '系统已启用减少动态效果，3D 默认停用。'}</p></section>;
}
