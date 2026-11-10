import { api } from './api';
import { resolveHourFields } from './hours';
import { MANAGEMENT_FIELDS, personalJql, searchPages } from './management';
import { useAsync } from './useAsync';
import { useSession } from './session';
import { quote } from './jql';

export function useManagementData(projectKey: string | null, everyone = false) {
  const { version } = useSession();
  const state = useAsync(async signal => {
    const defs = resolveHourFields(await api.fields());
    const jql = everyone
      ? `${projectKey ? `project = ${quote(projectKey)} AND ` : ''}(resolution is EMPTY OR resolved >= -30d) ORDER BY updated DESC`
      : personalJql(projectKey);
    const result = await searchPages(jql, [...MANAGEMENT_FIELDS, ...defs.estimate, ...defs.devStart, ...defs.devDone], signal);
    return { ...result, hourFields: defs, projectKey, everyone };
  }, [projectKey, version, everyone]);
  return { ...state, data: state.data?.projectKey === projectKey && state.data.everyone === everyone ? state.data : null };
}
