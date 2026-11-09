import { api } from './api';
import { resolveHourFields } from './hours';
import { MANAGEMENT_FIELDS, personalJql, searchPages } from './management';
import { useAsync } from './useAsync';
import { useSession } from './session';

export function useManagementData(projectKey: string | null) {
  const { version }=useSession();
  const state = useAsync(async signal=>{
    const defs=resolveHourFields(await api.fields());
    const result=await searchPages(personalJql(projectKey),[...MANAGEMENT_FIELDS,...defs.estimate,...defs.devStart,...defs.devDone],signal);
    return {...result,hourFields:defs,projectKey};
  },[projectKey,version]);
  return {...state,data:state.data?.projectKey===projectKey?state.data:null};
}
