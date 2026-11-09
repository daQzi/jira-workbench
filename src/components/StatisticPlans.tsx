import { useState } from 'react';
import { loadLocal, saveLocal } from '../lib/management';
import { useSession } from '../lib/session';

export function StatisticPlans<T>({store,value,normalize,onApply}:{store:string;value:T;normalize:(x:unknown)=>T;onApply:(x:T)=>void}) {
 const {toast}=useSession();
 type Plan={id:string;name:string;value:T};
 const valid=(v:unknown):v is Plan[]=>Array.isArray(v)&&v.every(p=>typeof p?.id==='string'&&typeof p.name==='string'&&p.value&&typeof p.value==='object');
 const [state,setState]=useState(()=>({store,plans:loadLocal<Plan[]>(store,[],valid)}));
 const plans=state.store===store?state.plans:loadLocal<Plan[]>(store,[],valid);
 const [name,setName]=useState('');const [selected,setSelected]=useState('');
 function save(plans:Plan[]){setState({store,plans});if(!saveLocal(store,plans))toast('无法保存统计方案','error');}
 return <div className="saved-views"><select className="select" aria-label="已保存统计方案" value={plans.some(p=>p.id===selected)?selected:''} onChange={e=>{setSelected(e.target.value);const p=plans.find(p=>p.id===e.target.value);if(p)onApply(normalize(p.value));}}><option value="">选择统计方案</option>{plans.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><input className="input" aria-label="统计方案名称" placeholder="例如：本月开发工时" value={name} maxLength={40} onChange={e=>setName(e.target.value)}/><button className="btn small" disabled={!name.trim()} onClick={()=>{const p={id:crypto.randomUUID(),name:name.trim(),value};save([...plans.filter(x=>x.name!==p.name),p].slice(-20));setSelected(p.id);setName('');}}>保存统计方案</button>{plans.some(p=>p.id===selected)&&<button className="btn small ghost" onClick={()=>{save(plans.filter(p=>p.id!==selected));setSelected('');}}>删除统计方案</button>}</div>;
}
