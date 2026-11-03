import { useEffect, useRef, useState } from 'react';
import { api, type Transition } from '../lib/api';
import { useSession } from '../lib/session';
import { useTransition } from '../lib/useTransition';
import type { Issue } from '../lib/types';
import { Person, StatusPill } from './Badges';
import { UserPicker } from './UserPicker';

function useClickOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, [open, close]);
  return ref;
}

/** 点击状态弹出可用流转；只列出 Jira 工作流允许的目标 */
export function StatusMenu({ issue, onChanged }: { issue: Issue; onChanged: () => void }) {
  const { canWriteIssue } = useSession();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Transition[] | null>(null);
  const [error, setError] = useState('');
  const close = () => setOpen(false);
  const ref = useClickOutside(open, close);
  const { run, dialog } = useTransition(onChanged);
  const writable = canWriteIssue(issue.key);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setList(null);
    setError('');
    api.transitions(issue.key).then(
      (t) => alive && setList(t),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [open, issue.key]);

  if (!writable) return <StatusPill status={issue.fields.status.name} />;
  return (
    <div className="pop-wrap" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className="pill-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="变更状态">
        <StatusPill status={issue.fields.status.name} />
        <span className="caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="pop" role="menu">
          {error && <div className="pop-empty err">{error}</div>}
          {!list && !error && <div className="pop-empty">加载中…</div>}
          {list?.length === 0 && <div className="pop-empty">当前状态下你没有可执行的流转（可能需要是经办人）</div>}
          {list?.map((t) => (
            <button
              key={t.id}
              role="menuitem"
              onClick={() => {
                close();
                run({ key: issue.key, summary: issue.fields.summary, status: issue.fields.status.name, current: issue.fields }, t);
              }}
            >
              <StatusPill status={t.to.name} />
              {t.fields && Object.keys(t.fields).length > 0 && <span className="muted">需填写</span>}
            </button>
          ))}
        </div>
      )}
      {dialog}
    </div>
  );
}

/** 行内改经办人 */
export function AssigneeCell({ issue, onChanged }: { issue: Issue; onChanged: () => void }) {
  const { canWriteIssue, toast } = useSession();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = () => setEditing(false);
  const ref = useClickOutside(editing, close);
  const current = (issue.fields.assignee as { name?: string } | null)?.name ?? '';

  if (!canWriteIssue(issue.key)) return <Person user={issue.fields.assignee} />;
  if (!editing) {
    return (
      <button
        className="cell-btn"
        title="修改经办人"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
      >
        <Person user={issue.fields.assignee} />
      </button>
    );
  }
  const save = async (name: string) => {
    if (!name || name === current) return close();
    setBusy(true);
    try {
      await api.editIssue(issue.key, { assignee: { name } });
      toast(`${issue.key} 经办人 → ${name}`);
      close();
      onChanged();
    } catch (e) {
      toast(`修改经办人失败：${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div ref={ref} onClick={(e) => e.stopPropagation()} style={{ minWidth: 160, opacity: busy ? 0.5 : 1 }}>
      <UserPicker label="经办人" value={current} onChange={() => {}} onPick={save} onCancel={close} issueKey={issue.key} autoFocus />
    </div>
  );
}
