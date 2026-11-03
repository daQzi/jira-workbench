import { useCallback, useState } from 'react';
import { api, type Transition } from './api';
import { useSession } from './session';
import { TransitionDialog } from '../components/TransitionDialog';

interface Target {
  key: string;
  summary: string;
  status: string;
  current?: Record<string, unknown>;
}

/**
 * 统一的流转入口：无字段的流转直接执行，有字段的弹窗补填。
 * 看板拖拽、详情按钮共用。
 */
export function useTransition(onChanged: () => void) {
  const { toast } = useSession();
  const [pending, setPending] = useState<{ target: Target; transition: Transition } | null>(null);

  const run = useCallback(
    async (target: Target, transition: Transition) => {
      if (transition.fields && Object.keys(transition.fields).length) {
        setPending({ target, transition });
        return;
      }
      try {
        await api.doTransition(target.key, transition.id);
        toast(`${target.key} → ${transition.to.name}`);
        onChanged();
      } catch (e) {
        toast(`${target.key} 流转失败：${(e as Error).message}`, 'error');
      }
    },
    [toast, onChanged],
  );

  const dialog = pending ? (
    <TransitionDialog
      issueKey={pending.target.key}
      summary={pending.target.summary}
      fromStatus={pending.target.status}
      transition={pending.transition}
      current={pending.target.current}
      onClose={() => setPending(null)}
      onDone={() => {
        setPending(null);
        onChanged();
      }}
    />
  ) : null;

  return { run, dialog, loadTransitions: api.transitions };
}
