import { useState } from 'react';
import { submitCreate } from '../lib/create';
import { getCreateMeta } from '../lib/metaCache';
import { useSession } from '../lib/session';

interface Props {
  projectKey: string;
  typeName: string;
  parent?: { key: string; fields: Record<string, unknown> } | null;
  placeholder: string;
  onCreated: (key: string) => void;
  /** 有必填项缺失时，带着标题打开完整表单 */
  onNeedForm: (summary: string) => void;
  autoFocus?: boolean;
  onCancel?: () => void;
}

/** 输入标题回车即建；必填项能继承就继承，否则转完整表单 */
export function QuickAdd({ projectKey, typeName, parent, placeholder, onCreated, onNeedForm, autoFocus, onCancel }: Props) {
  const { me, toast } = useSession();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const summary = text.trim();
    if (!summary || busy) return;
    setBusy(true);
    try {
      const types = await getCreateMeta(projectKey);
      const type = types.find((t) => t.name === typeName);
      if (!type) throw new Error(`项目 ${projectKey} 不能新建「${typeName}」`);
      const values = { summary, ...(type.fields.assignee ? { assignee: me.name } : {}) };
      try {
        const r = await submitCreate({ projectKey, type, values, parent });
        setText('');
        toast(`已创建 ${r.key}`);
        r.warnings.forEach((w) => toast(`${r.key} ${w}`, 'error'));
        onCreated(r.key);
      } catch (e) {
        if ((e as Error).message.startsWith('缺少必填项')) {
          onNeedForm(summary);
          setText('');
        } else throw e;
      }
    } catch (e) {
      toast(`创建失败：${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <input
      className="input quick-add"
      aria-label={placeholder}
      placeholder={busy ? '创建中…' : placeholder}
      value={text}
      disabled={busy}
      autoFocus={autoFocus}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          submit();
        } else if (e.key === 'Escape') {
          setText('');
          onCancel?.();
        }
      }}
    />
  );
}
