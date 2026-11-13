import { useEffect, useRef, useState } from 'react';
import { Modal } from '../../components/Modal';
import type { ToolData } from './model';
import { Base64Panel, DiffPanel, JsonPanel, NotesPanel, TimestampPanel, TodosPanel } from './ToolPanels';
import { OrbitScene } from '../scene/OrbitScene';
import { SceneSettings } from '../scene/SceneSettings';
import { prefersReducedMotion, readMotion } from '../scene/settings';

export const TOOLS = [
  { id: 'notes', name: '便签', desc: '随手记录，颜色与置顶', icon: '▤' },
  { id: 'todos', name: '个人待办', desc: '本机清单，不创建 Jira 任务', icon: '✓' },
  { id: 'timestamp', name: '时间戳转换', desc: '秒 / 毫秒与本机日期互转', icon: '◷' },
  { id: 'base64', name: 'Base64 编解码', desc: 'UTF-8 文本本地转换', icon: 'Aa' },
  { id: 'json', name: 'JSON 格式化', desc: '校验、格式化与压缩', icon: '{ }' },
  { id: 'diff', name: '文本对比', desc: '逐行显示新增与删除', icon: '±' },
  { id: 'scene', name: '工作星图', desc: '可旋转的小世界，可暂停', icon: '✦' },
  { id: 'settings', name: '界面动效', desc: '轻动效、减少动画与 3D 设置', icon: '◐' },
] as const;
export type ToolId = typeof TOOLS[number]['id'];

export function Toolbox({ data, save }: { data: ToolData; save: Parameters<typeof NotesPanel>[0]['save'] }) {
  const [open, setOpen] = useState(false); const [active, setActive] = useState<ToolId | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false); const [rotation, setRotation] = useState(0); const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => { const m = window.matchMedia('(prefers-reduced-motion: reduce)'); const update = () => setReduced(m.matches); m.addEventListener('change', update); return () => m.removeEventListener('change', update); }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) { setOpen(false); (root.current.querySelector('.toolbox-fab') as HTMLElement | null)?.focus(); } };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', outside); window.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key, true); };
  }, [open]);
  useEffect(() => { if (open) root.current?.querySelector<HTMLButtonElement>('.toolbox-grid button')?.focus(); }, [open]);
  const tool = TOOLS.find(t => t.id === active);
  return <>
    <div className="toolbox-root" ref={root}>
      {open && <section className="toolbox-menu" role="dialog" aria-label="常用工具箱"><header><div><strong>常用工具</strong><span>本机处理 · 内容不发送到第三方</span></div><button className="btn small ghost" aria-label="收起工具箱" onClick={() => setOpen(false)}>×</button></header><div className="toolbox-grid">{TOOLS.map(t => <button key={t.id} onClick={() => { setActive(t.id); setOpen(false); }}><span className="toolbox-icon" aria-hidden="true">{t.icon}</span><span><strong>{t.name}</strong><small>{t.desc}</small></span></button>)}</div><footer>便签与待办仅保存在当前浏览器 / 本机</footer></section>}
      <button className="toolbox-fab" aria-label="常用工具箱" aria-expanded={open} title="常用工具箱" onClick={() => setOpen(v => !v)}><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg><span>工具箱</span></button>
    </div>
    {tool && <Modal title={tool.name} width={tool.id === 'notes' ? 780 : tool.id === 'diff' || tool.id === 'scene' ? 880 : 620} onClose={() => setActive(null)}><div className="tool-panel">{tool.id === 'scene' ? <><div className="tool-scene-controls"><button className="btn small" onClick={() => setPaused(p => !p)}>{paused || reduced || readMotion() === 'reduced' ? '继续旋转' : '暂停旋转'}</button><button className="btn small" onClick={() => setRotation(r => r + 1)}>旋转视角</button><span>拖动场景也可旋转 · {data.notes.length} 条便签 · {data.todos.filter(t => !t.done).length} 项待办</span></div><div className="tool-orbit" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); setRotation(r => r + e.movementX / 100); }} onPointerMove={e => { if (e.buttons === 1) setRotation(r => r + e.movementX / 100); }}><OrbitScene key={rotation} compact paused={paused}><span className="tool-scene-caption">本地工作星图 · 仅作视觉装饰</span></OrbitScene></div></> : tool.id === 'settings' ? <SceneSettings/> : tool.id === 'notes' ? <NotesPanel data={data} save={save}/> : tool.id === 'todos' ? <TodosPanel data={data} save={save}/> : tool.id === 'timestamp' ? <TimestampPanel/> : tool.id === 'base64' ? <Base64Panel/> : tool.id === 'json' ? <JsonPanel/> : <DiffPanel/>}</div></Modal>}
  </>;
}
