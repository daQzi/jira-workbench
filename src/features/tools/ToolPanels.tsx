import { useState, type SetStateAction } from 'react';
import { copyText } from '../../lib/clipboard';
import { useSession } from '../../lib/session';
import { decodeBase64, diffLines, encodeBase64, formatTimestamp, toTimestamp, type ToolData } from './model';

export function NotesPanel({ data, save }: { data: ToolData; save: (update: SetStateAction<ToolData>) => boolean }) {
  const { toast } = useSession();
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState(''); const [color, setColor] = useState<'yellow' | 'blue' | 'green'>('yellow');
  const [deleting, setDeleting] = useState<string | null>(null);
  const notes = [...data.notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated.localeCompare(a.updated));
  const edit = (id: string) => { const note = data.notes.find(n => n.id === id); if (note) { setEditing(id); setText(note.text); setColor(note.color); } };
  const submit = () => {
    if (!text.trim()) return;
    const now = new Date().toISOString();
    if (!save(d => ({ ...d, notes: editing ? d.notes.map(n => n.id === editing ? { ...n, text: text.trim(), color, updated: now } : n) : [...d.notes, { id: crypto.randomUUID(), text: text.trim(), color, pinned: false, updated: now }] }))) return;
    setEditing(null); setText('');
  };
  return <>
    <div className="note-editor"><textarea className="input textarea" aria-label="便签内容" maxLength={10000} value={text} onChange={e => setText(e.target.value)} placeholder="记录临时想法、会议结论或稍后处理的事…" rows={3}/><div className="note-editor-foot"><div className="note-colors" aria-label="便签颜色">{(['yellow', 'blue', 'green'] as const).map(c => <button key={c} type="button" className={`note-color ${c}`} aria-label={`便签${{ yellow: '黄色', blue: '蓝色', green: '绿色' }[c]}`} aria-pressed={color === c} onClick={() => setColor(c)}/>)}</div><button className="btn primary small" disabled={!text.trim()} onClick={submit}>{editing ? '保存便签' : '添加便签'}</button>{editing && <button className="btn small ghost" onClick={() => { setEditing(null); setText(''); }}>取消编辑</button>}</div></div>
    {!notes.length ? <div className="tool-empty"><strong>还没有便签</strong><span>写在上方，刷新后仍会保留在本机。</span></div> : <div className="note-list">{notes.map(n => <article className={`note ${n.color}`} key={n.id}><div className="note-actions"><button className="icon-btn" aria-label={`${n.pinned ? '取消置顶' : '置顶'}便签`} title={n.pinned ? '取消置顶' : '置顶'} onClick={() => save(d => ({ ...d, notes: d.notes.map(x => x.id === n.id ? { ...x, pinned: !x.pinned, updated: new Date().toISOString() } : x) }))}>⌖</button><button className="icon-btn" aria-label="编辑便签" onClick={() => edit(n.id)}>编辑</button><button className="icon-btn" aria-label="复制便签" onClick={async () => { try { await copyText(n.text); toast('已复制便签'); } catch { toast('复制失败', 'error'); } }}>复制</button>{deleting === n.id ? <><button className="text-btn danger" onClick={() => { if (save(d => ({ ...d, notes: d.notes.filter(x => x.id !== n.id) }))) setDeleting(null); }}>确认删除</button><button className="icon-btn" onClick={() => setDeleting(null)}>取消</button></> : <button className="icon-btn" aria-label="删除便签" onClick={() => setDeleting(n.id)}>删除</button>}</div><p>{n.text}</p><small>{new Date(n.updated).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></article>)}</div>}
  </>;
}

export function TodosPanel({ data, save }: { data: ToolData; save: (update: SetStateAction<ToolData>) => boolean }) {
  const [text, setText] = useState(''); const [showDone, setShowDone] = useState(true); const [deleting, setDeleting] = useState<string | null>(null);
  const todos = data.todos.filter(t => showDone || !t.done).sort((a, b) => Number(a.done) - Number(b.done) || b.created.localeCompare(a.created));
  const add = () => { if (!text.trim()) return; if (save(d => ({ ...d, todos: [...d.todos, { id: crypto.randomUUID(), text: text.trim(), done: false, created: new Date().toISOString() }] }))) setText(''); };
  return <>
    <div className="todo-add"><input className="input" aria-label="待办内容" value={text} maxLength={200} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); add(); } }} placeholder="例如：整理今天的发布说明"/><button type="button" className="btn primary" onClick={add} disabled={!text.trim()}>添加</button></div>
    <div className="tool-panel-meta"><span>待完成 {data.todos.filter(t => !t.done).length} 项</span><label><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)}/>显示已完成</label></div>
    {!todos.length ? <div className="tool-empty"><strong>{showDone ? '还没有个人待办' : '没有待完成事项'}</strong><span>这里仅记录本机待办，不会创建 Jira 问题。</span></div> : <ul className="todo-list">{todos.map(t => <li key={t.id} className={t.done ? 'done' : ''}><label><input type="checkbox" checked={t.done} onChange={e => save(d => ({ ...d, todos: d.todos.map(x => x.id === t.id ? { ...x, done: e.target.checked, completed: e.target.checked ? new Date().toISOString() : undefined } : x) }))}/><span>{t.text}</span></label><span className="todo-date">{t.done && t.completed ? `完成于 ${new Date(t.completed).toLocaleDateString('zh-CN')}` : new Date(t.created).toLocaleDateString('zh-CN')}</span>{deleting === t.id ? <span className="todo-confirm"><button className="text-btn danger" onClick={() => { if (save(d => ({ ...d, todos: d.todos.filter(x => x.id !== t.id) }))) setDeleting(null); }}>确认删除</button><button className="icon-btn" onClick={() => setDeleting(null)}>取消</button></span> : <button className="icon-btn" aria-label={`删除待办 ${t.text}`} onClick={() => setDeleting(t.id)}>删除</button>}</li>)}</ul>}
  </>;
}

function ToolResult({ text, error }: { text: string; error: string }) { return <div className={`tool-result${error ? ' is-error' : ''}`} role="status">{error || text}</div>; }
export function TimestampPanel() {
  const [stamp, setStamp] = useState(''); const [date, setDate] = useState(''); const [result, setResult] = useState(''); const [error, setError] = useState('');
  const convert = (fn: () => string) => { try { setResult(fn()); setError(''); } catch (e) { setResult(''); setError((e as Error).message); } };
  return <div className="dev-tool"><label className="field"><span>Unix 时间戳（自动识别秒 / 毫秒）</span><div className="tool-inline"><input className="input" aria-label="Unix 时间戳" value={stamp} onChange={e => setStamp(e.target.value)} placeholder="例如 1736568000"/><button className="btn" onClick={() => convert(() => formatTimestamp(stamp))}>转为日期</button></div></label><label className="field"><span>本机日期时间 → Unix 秒</span><div className="tool-inline"><input className="input" type="datetime-local" aria-label="本机日期时间" value={date} onChange={e => setDate(e.target.value)}/><button className="btn" onClick={() => convert(() => String(toTimestamp(date)))}>转为时间戳</button></div></label><ToolResult text={result} error={error}/></div>;
}
export function Base64Panel() {
  const [input, setInput] = useState(''); const [result, setResult] = useState(''); const [error, setError] = useState('');
  const convert = (fn: () => string) => { try { setResult(fn()); setError(''); } catch { setResult(''); setError('Base64 内容无效或不是有效 UTF-8 文本'); } };
  return <div className="dev-tool"><label className="field"><span>文本或 Base64</span><textarea className="input textarea" aria-label="Base64 输入" rows={5} value={input} onChange={e => setInput(e.target.value)}/></label><div className="tool-buttons"><button className="btn" onClick={() => convert(() => encodeBase64(input))}>编码为 Base64</button><button className="btn" onClick={() => convert(() => decodeBase64(input))}>解码 Base64</button></div><label className="field"><span>转换结果</span><textarea className="input textarea mono" aria-label="Base64 结果" rows={5} readOnly value={error || result}/></label></div>;
}
export function JsonPanel() {
  const [input, setInput] = useState(''); const [result, setResult] = useState(''); const [error, setError] = useState('');
  const convert = (compact: boolean) => { try { setResult(JSON.stringify(JSON.parse(input), null, compact ? 0 : 2)); setError(''); } catch (e) { setError(`JSON 格式不正确：${(e as Error).message}`); } };
  return <div className="dev-tool"><label className="field"><span>JSON 输入</span><textarea className="input textarea mono" aria-label="JSON 输入" rows={7} value={input} onChange={e => setInput(e.target.value)} placeholder={'{\n  "project": "Jira"\n}'}/></label><div className="tool-buttons"><button className="btn primary" onClick={() => convert(false)}>校验并格式化</button><button className="btn" onClick={() => convert(true)}>压缩为一行</button></div><label className="field"><span>处理结果</span><textarea className="input textarea mono" aria-label="JSON 结果" rows={9} readOnly value={result}/></label><ToolResult text={result ? '校验通过，仅在本机处理' : ''} error={error}/></div>;
}
export function DiffPanel() {
  const [before, setBefore] = useState(''); const [after, setAfter] = useState(''); const [result, setResult] = useState<ReturnType<typeof diffLines> | null>(null); const [error, setError] = useState('');
  return <div className="dev-tool"><div className="diff-inputs"><label className="field"><span>原文本</span><textarea className="input textarea mono" aria-label="对比原文本" rows={6} value={before} onChange={e => setBefore(e.target.value)}/></label><label className="field"><span>新文本</span><textarea className="input textarea mono" aria-label="对比新文本" rows={6} value={after} onChange={e => setAfter(e.target.value)}/></label></div><button className="btn primary" onClick={() => { try { setResult(diffLines(before, after)); setError(''); } catch (e) { setError((e as Error).message); setResult(null); } }}>比较行差异</button>{error && <ToolResult text="" error={error}/>} {result && <><p className="tool-panel-meta">新增 {result.filter(l => l.type === 'add').length} 行 · 删除 {result.filter(l => l.type === 'remove').length} 行</p><pre className="diff-result" aria-label="文本对比结果">{result.map((l, i) => <div key={i} className={`diff-${l.type}`}>{l.type === 'add' ? '+ ' : l.type === 'remove' ? '- ' : '  '}{l.text || ' '}</div>)}</pre></>}</div>;
}
