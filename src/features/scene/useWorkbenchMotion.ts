import { useEffect, useState } from 'react';
import { readMotion, prefersReducedMotion } from './settings';
export function useWorkbenchMotion() {
  const [reduced, setReduced] = useState(() => readMotion() === 'reduced' || prefersReducedMotion());
  useEffect(() => { const media = window.matchMedia('(prefers-reduced-motion: reduce)'); const update = () => setReduced(readMotion() === 'reduced' || media.matches); media.addEventListener('change', update); window.addEventListener('wb-visual-settings', update); return () => { media.removeEventListener('change', update); window.removeEventListener('wb-visual-settings', update); }; }, []);
  useEffect(() => { document.documentElement.dataset.motion = reduced ? 'reduce' : 'normal'; }, [reduced]);
  return reduced;
}
