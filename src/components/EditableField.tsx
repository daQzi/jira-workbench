import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { editValue, fromJiraValue, inputKind, type FieldMeta, type FormValue } from '../lib/fields';
import { useSession } from '../lib/session';
import { FieldInput } from './FieldInput';
import { UserPicker } from './UserPicker';

interface Props {
  issueKey: string;
  id: string;
  /** 来自 editmeta；没有时（无权限/加载中/字段不可编辑）只读展示 */
  meta: FieldMeta | undefined;
  raw: unknown;
  children: ReactNode;
  onSaved: () => void;
  /** 展示区的外观：块级（描述、长文本）或行内（侧栏字段） */
  block?: boolean;
  className?: string;
  /** 由外部触发进入编辑（如描述区的「编辑」按钮） */
  editing?: boolean;
  onEditingChange?: (v: boolean) => void;
}

// 选中即保存的控件；日期、级联在输入过程中会多次触发 change，仍按「保存」或回车
const INSTANT = new Set(['select']);

/** 点击即改：展示值 → 对应的 Jira 字段控件，保存后刷新问题 */
export function EditableField({ issueKey, id, meta, raw, children, onSaved, block, className = '', editing: ctrl, onEditingChange }: Props) {
  const { toast } = useSession();
  const [own, setOwn] = useState(false);
  const editing = ctrl ?? own;
  const setEditing = (v: boolean) => (onEditingChange ? onEditingChange(v) : setOwn(v));
  const kind = meta ? inputKind(id, meta) : null;
  const [value, setValue] = useState<FormValue | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const saving = useRef(false);

  useEffect(() => {
    if (editing && meta) setValue(fromJiraValue(id, meta, raw));
    // 只在进入编辑时取一次当前值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  useEffect(() => {
    if (!editing) return;
    // 进入编辑后聚焦第一个控件
    ref.current?.querySelector<HTMLElement>('input:not(.sr-only),select,textarea')?.focus();
  }, [editing]);

  if (!meta || !kind) return <>{children}</>;

  const save = async (next: FormValue | undefined = value) => {
    if (saving.current) return;
    const r = editValue(id, meta, raw, next);
    if (r.kind === 'unchanged') return setEditing(false);
    if (r.kind === 'error') return toast(r.msg, 'error');
    saving.current = true;
    setBusy(true);
    try {
      await api.editIssue(issueKey, { [id]: r.value }, { feedback: 'local' });
      toast(`已更新「${meta.name}」`);
      setEditing(false);
      onSaved();
    } catch (e) {
      toast(`保存「${meta.name}」失败：${(e as Error).message}`, 'error');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  if (!editing) {
    // 用 div/span 而不是 button：描述里有链接、段落等块级内容，不能嵌进 button
    const Tag = block ? 'div' : 'span';
    return (
      <Tag
        role="button"
        tabIndex={0}
        className={`edit-trigger${block ? ' block' : ''} ${className}`}
        title={`点击修改${meta.name}`}
        aria-label={`修改${meta.name}`}
        onClick={(e) => {
          // 选中文字（如复制标题）时不进入编辑
          if (window.getSelection()?.toString()) return;
          // 描述里的链接照常可点
          if ((e.target as HTMLElement).closest('a')) return;
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
            e.preventDefault();
            setEditing(true);
          }
        }}
      >
        {children}
      </Tag>
    );
  }

  const multiline = kind === 'textarea';
  return (
    <div
      ref={ref}
      className={`inline-edit${block ? ' block' : ''}`}
      aria-busy={busy}
      style={{ opacity: busy ? 0.6 : 1 }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (!saving.current) setEditing(false);
        } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && kind !== 'user' && (!multiline || e.metaKey || e.ctrlKey)) {
          // 用户选择框自己处理回车（选中即保存）
          e.preventDefault();
          save();
        }
      }}
    >
      <fieldset className="inline-edit-controls" disabled={busy}>
      {kind === 'user' ? (
        <UserPicker
          label={meta.name}
          value={typeof value === 'string' ? value : ''}
          onChange={setValue}
          onPick={(name) => save(name)}
          onCancel={() => setEditing(false)}
          issueKey={issueKey}
        />
      ) : (
        <FieldInput
          id={id}
          meta={meta}
          value={value}
          issueKey={issueKey}
          onChange={(v) => {
            setValue(v);
            if (INSTANT.has(kind)) save(v);
          }}
        />
      )}
      <div className="inline-edit-actions">
        <button type="button" className="btn primary small" disabled={busy} onClick={() => save()}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" className="btn small" disabled={busy} onClick={() => setEditing(false)}>
          取消
        </button>
        <span className="muted">{multiline ? '⌘/Ctrl+Enter 保存' : kind === 'user' ? '选中即保存' : INSTANT.has(kind) ? '选择即保存' : 'Enter 保存'} · Esc 取消</span>
      </div>
      </fieldset>
    </div>
  );
}
