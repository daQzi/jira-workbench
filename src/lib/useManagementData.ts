import { useEffect, useRef, useState } from 'react';
import type { HourFields } from './hours';
import type { Issue } from './types';
import { MANAGEMENT_FIELDS } from './management';
import { useSession } from './session';
import { clearReadCache, readCached } from './requestCache';
import { managementFields, managementJql, peekManagement, saveManagement, searchCached } from './managementCache';

export interface ManagementData {
  hourFields: HourFields;
  issues: Issue[];
  total: number;
  loadedAt: string;
  complete: boolean;
  /** 首批、后台补页或临时缓存的统计范围 */
  provisional: boolean;
  projectKey: string | null;
  everyone: boolean;
  backgroundLoading: boolean;
  progress: number;
  error: Error | null;
}
export interface ManagementState { data: ManagementData | null; loading: boolean; error: Error | null; reload: () => void }
interface CacheData { key: string; issues: Issue[]; total: number; loadedAt: string; complete: boolean }
const MAX = 1000;
export function useManagementData(projectKey: string | null, everyone = false): ManagementState {
  const { version } = useSession();
  const scope = `${projectKey ?? '*'}:${everyone}`;
  const [nonce, setNonce] = useState(0);
  const cacheRef = useRef(new Map<string, CacheData>());
  const [state, setState] = useState<{ scope: string; value: ManagementState }>({ scope, value: { data: null, loading: true, error: null, reload: () => {} } });
  useEffect(() => {
    let disposed = false;
    const ctrl = new AbortController();
    const cached = cacheRef.current.get(scope) ?? peekManagement(projectKey, everyone);
    const update = (value: ManagementState) => { if (!disposed) setState({ scope, value }); };
    if (cached) update({ data: { ...cached, hourFields: { estimate: [], devStart: [], devDone: [] }, projectKey, everyone, backgroundLoading: true, provisional: true, progress: cached.complete ? 100 : 0, error: null }, loading: false, error: null, reload: () => {} });
    else update({ data: null, loading: true, error: null, reload: () => {} });
    async function load() {
      let warning: Error | null = null;
      try {
        const hfPromise = managementFields(ctrl.signal).catch(e => { warning = e as Error; return { estimate: [], devStart: [], devDone: [] }; });
        const jql = managementJql(projectKey, everyone);
        const fieldsPromise = hfPromise.then(hf => [...new Set([...MANAGEMENT_FIELDS, ...hf.estimate, ...hf.devStart, ...hf.devDone])]);
        const first = await readCached(`first:${jql}`, 20_000, signal => fieldsPromise.then(fields => searchCached(jql, 0, fields, signal)), ctrl.signal);
        const hf = await hfPromise, fields = await fieldsPromise;
        const total = Math.min(MAX, first.total), issues = [...first.issues];
        const loadedAt = new Date().toISOString();
        const publish = (backgroundLoading = true) => update({ data: { hourFields: hf, issues: [...issues], total: first.total, loadedAt, complete: issues.length >= total, projectKey, everyone, backgroundLoading, provisional: backgroundLoading || issues.length < total || !!warning, progress: total ? Math.min(100, Math.round(issues.length / total * 100)) : 100, error: warning }, loading: false, error: warning, reload: () => {} });
        publish();
        while (issues.length < total && !ctrl.signal.aborted) {
          const start = issues.length;
          try {
            const page = await searchCached(jql, start, fields, ctrl.signal);
            issues.push(...page.issues);
            if (!page.issues.length) break;
            publish();
          } catch (e) {
            if (ctrl.signal.aborted || disposed) return;
            warning = e as Error;
            publish(false);
            break;
          }
        }
        if (!disposed && !ctrl.signal.aborted) {
          const complete = issues.length >= total;
          const snapshot = { key: scope, issues, total: first.total, loadedAt, complete };
          cacheRef.current.set(scope, snapshot);
          saveManagement(snapshot);
          publish(false);
        }
      } catch (e) {
        if (!disposed && !ctrl.signal.aborted) {
          if (cached) update({ data: { ...cached, hourFields: { estimate: [], devStart: [], devDone: [] }, projectKey, everyone, backgroundLoading: false, provisional: true, progress: cached.complete ? 100 : 0, error: e as Error }, loading: false, error: e as Error, reload: () => {} });
          else update({ data: null, loading: false, error: e as Error, reload: () => {} });
        }
      }
    }
    void load();
    return () => { disposed = true; ctrl.abort(); };
  }, [projectKey, everyone, version, nonce]);
  const value = state.scope === scope ? state.value : { data: null, loading: true, error: null, reload: () => {} };
  return { ...value, reload: () => { clearReadCache(); setNonce(n => n + 1); } };
}
