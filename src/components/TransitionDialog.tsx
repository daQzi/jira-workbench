import { useMemo, useState } from 'react';
import { api, type Transition } from '../lib/api';
import { buildFields, fromJiraValue, inputKind, type FormValue } from '../lib/fields';
import { useSession } from '../lib/session';
import { FieldInput } from './FieldInput';
import { Modal } from './Modal';
import { StatusPill } from './Badges';

interface Props {
  issueKey: string;
  summary: string;
  fromStatus: string;
  transition: Transition;
  /** 当前字段值，用于预填（如经办人） */
  current?: Record<string, unknown>;
  onClose: () => void;
  onDone: () => void;
}

/** 流转需要填写字段时弹出；必填的 Jira 字段强校验，不允许跳过 */
export function TransitionDialog({ issueKey, summary, fromStatus, transition, current, onClose, onDone }: Props) {
  const { me, toast } = useSession();
  const meta = useMemo(() => transition.fields ?? {}, [transition]);
  const [values, setValues] = useState<Record<string, FormValue | undefined>>(() => {
    const init: Record<string, FormValue | undefined> = {};
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    for (const [id, m] of Object.entries(meta)) {
      const pre = current ? fromJiraValue(id, m, current[id]) : undefined;
      if (pre !== undefined) init[id] = pre;
      // 流转里的日期一般是“开始/完成日期”，默认今天
      else if (inputKind(id, m) === 'date') init[id] = ymd;
      // 关闭时的解决结果默认「已修复」，避免误选成「重复」等
      else if (id === 'resolution') {
        const fixed = m.allowedValues?.find((v) => v.name === '已修复' || v.name === 'Fixed' || v.id === '1');
        if (fixed) init[id] = fixed.id;
      }
    }
    return init;
  });
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showInvalid, setShowInvalid] = useState(false);

  const plan = buildFields(meta, values);
  const missing = new Set([...plan.missing, ...plan.unsupported]);

  async function submit() {
    if (missing.size) {
      setShowInvalid(true);
      setError(
        plan.unsupported.length
          ? `${plan.unsupported.join('、')} 暂不支持在这里填写，请在 Jira 中流转`
          : `请填写：${[...missing].join('、')}`,
      );
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.doTransition(issueKey, transition.id, plan.fields);
      if (comment.trim()) {
        try {
          await api.addComment(issueKey, comment.trim());
        } catch (e) {
          toast(`状态已变更，但评论保存失败：${(e as Error).message}`, 'error');
        }
      }
      toast(`${issueKey} → ${transition.to.name}`);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={
        <>
          {transition.name} <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>{issueKey}</span>
        </>
      }
      onClose={onClose}
      width={560}
      footer={
        <>
          <span className="err" role="alert">
            {error}
          </span>
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? '提交中…' : '确认流转'}
          </button>
        </>
      }
    >
      <p className="flow-line">
        <span className="summary">{summary}</span>
        <span>
          <StatusPill status={fromStatus} /> → <StatusPill status={transition.to.name} />
        </span>
      </p>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {Object.entries(meta).map(([id, m]) => (
          <FieldInput
            key={id}
            id={id}
            meta={m}
            value={values[id]}
            issueKey={issueKey}
            invalid={showInvalid && missing.has(m.name)}
            hint={id === 'assignee' && values.assignee === me.name ? '当前为你' : undefined}
            onChange={(v) => setValues((s) => ({ ...s, [id]: v }))}
          />
        ))}
        <div className="field wide">
          <label className="field-label" htmlFor="tr-comment">
            评论 <span className="field-hint">可选</span>
          </label>
          <textarea id="tr-comment" className="input textarea" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
