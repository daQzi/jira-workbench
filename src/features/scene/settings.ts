export type SceneMode = 'off' | 'auto' | 'on';
export type MotionPreference = 'normal' | 'reduced';
export function readSceneMode(): SceneMode { try { const value = localStorage.getItem('wb.scene.v1'); return value === 'off' || value === 'on' ? value : 'auto'; } catch { return 'auto'; } }
export function sceneAllowed(mode: SceneMode, reduced: boolean, webgl: boolean): boolean { return mode === 'on' || mode === 'auto' && !reduced && webgl; }
export function readMotion(): MotionPreference { try { return localStorage.getItem('wb.motion.v1') === 'reduced' ? 'reduced' : 'normal'; } catch { return 'normal'; } }
export function prefersReducedMotion() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
export function webglAvailable(): boolean {
  try { const canvas = document.createElement('canvas'); return !!(canvas.getContext('webgl2') || canvas.getContext('webgl')); } catch { return false; }
}
