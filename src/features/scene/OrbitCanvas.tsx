import { Canvas, useFrame } from '@react-three/fiber';
import { Component, useEffect, useMemo, useRef, type ReactNode } from 'react';
import * as THREE from 'three';

class SceneBoundary extends Component<{ children: ReactNode; onError: () => void }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.failed ? null : this.props.children; }
}

const COLORS = ['#8594ff', '#83cfb5', '#edbb73', '#e59b91'];
function Orbit({ paused, compact }: { paused: boolean; compact: boolean }) {
  const root = useRef<THREE.Group>(null);
  const geometries = useMemo(() => [new THREE.BoxGeometry(.5, .35, .5), new THREE.IcosahedronGeometry(.3, 0), new THREE.OctahedronGeometry(.34), new THREE.TorusGeometry(.26, .085, 10, 24)], []);
  const materials = useMemo(() => COLORS.map(color => new THREE.MeshStandardMaterial({ color, roughness: .34, metalness: .12 })), []);
  useEffect(() => { root.current?.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.computeBoundingSphere(); }); }, []);
  useFrame((state, delta) => {
    if (!root.current || paused || document.hidden) return;
    root.current.rotation.y += Math.min(delta, .05) * .15;
    root.current.rotation.x = -.18 + state.pointer.y * .05;
    root.current.rotation.z = state.pointer.x * .04;
  });
  return <group ref={root} rotation={[-.18, .35, 0]}>{geometries.map((geometry, i) => <group key={i} rotation={[0, i * Math.PI / 2, 0]} position={[0, 0, 0]}><mesh position={[compact ? 1.75 : 2.3, (i % 2 ? .5 : -.1), 0]} geometry={geometry} material={materials[i]} rotation={[i * .2, i * .3, 0]}/></group>)}<mesh material={materials[0]}><sphereGeometry args={[.65, 24, 24]}/></mesh>{[1.8, 2.35, 2.9].map(radius => <mesh key={radius} rotation={[Math.PI / 2, .25, 0]}><torusGeometry args={[radius, .009, 4, 80]}/><meshBasicMaterial color="#96a5de" transparent opacity={.25}/></mesh>)}</group>;
}
function ContextEvents({ onError }: { onError: () => void }) { useEffect(() => { const canvas = document.querySelector<HTMLCanvasElement>('.orbit-scene.is-3d canvas'); if (!canvas) return; const lost = (event: Event) => { event.preventDefault(); onError(); }; canvas.addEventListener('webglcontextlost', lost); return () => canvas.removeEventListener('webglcontextlost', lost); }, [onError]); return null; }

/** 所有几何、材质与色彩随包本地生成，不读取远程模型/纹理。 */
export default function OrbitCanvas({ paused, compact = false, onError }: { paused: boolean; compact?: boolean; onError: () => void }) {
  return <SceneBoundary onError={onError}><Canvas dpr={[1, 1.5]} frameloop={paused ? 'never' : 'always'} camera={{ position: [0, 1.8, compact ? 7 : 6.5], fov: 42 }} gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }} onCreated={({ gl }) => { gl.setClearColor(0x000000, 0); }} aria-label="需求、任务与工作节奏围绕中心运转的三维轨道" role="img">
    <ambientLight intensity={1.6}/><directionalLight position={[3, 5, 4]} intensity={2}/><directionalLight position={[-4, -1, -2]} intensity={.7}/><Orbit paused={paused} compact={compact}/><ContextEvents onError={onError}/>
  </Canvas></SceneBoundary>;
}
