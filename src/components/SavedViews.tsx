import { useState } from 'react';
import type { FilterState } from './FilterBar';
import { normalizeFilter } from '../lib/filterPrefs';
import { normalizeList, type ListPrefs } from '../lib/listPrefs';
import { loadLocal, saveLocal } from '../lib/management';
import { copyText } from '../lib/clipboard';
import { useSession } from '../lib/session';
interface View {id:string;name:string;filter:FilterState;list:ListPrefs}
export function SavedViews({store,filter,list,onApply}:{store:string;filter:FilterState;list:ListPrefs;onApply:(filter:FilterState,list:ListPrefs)=>void}) {
 const {toast}=useSession();
 const [views,setViews]=useState<View[]>(()=>loadLocal<View[]>(store,[],(v):v is View[]=>Array.isArray(v)&&v.every(x=>x&&typeof x.id==='string'&&typeof x.name==='string'&&x.filter&&x.list)));
 const [name,setName]=useState('');const [selected,setSelected]=useState('');
 function save(next:View[]){setViews(next);if(!saveLocal(store,next))toast('无法保存视图','error');}
 return <div className="saved-views"><label>已保存视图<select className="select" value={selected} onChange={e=>{setSelected(e.target.value);const v=views.find(v=>v.id===e.target.value);if(v)onApply({...normalizeFilter(v.filter),text:v.filter.text??''},normalizeList(v.list));}}><option value="">选择视图</option>{views.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label><input className="input" aria-label="视图名称" placeholder="保存当前筛选和列布局" maxLength={40} value={name} onChange={e=>setName(e.target.value)}/><button className="btn small" disabled={!name.trim()} onClick={()=>{const v={id:crypto.randomUUID(),name:name.trim(),filter,list};save([...views.filter(x=>x.name!==v.name),v].slice(-30));setSelected(v.id);setName('');}}>保存视图</button>{selected&&<button className="btn small ghost" onClick={()=>{save(views.filter(v=>v.id!==selected));setSelected('');}}>删除视图</button>}<button className="btn small" onClick={async()=>{const url=new URL(location.href);const [route,query='']=url.hash.slice(1).split('?');const q=new URLSearchParams(query);q.set('view',JSON.stringify({filter,list}));url.hash=`${route}?${q}`;try{await copyText(url.toString());toast('已复制视图链接（接收者仍需具备 Jira 权限）');}catch{toast('复制失败','error');}}}>复制筛选链接</button></div>;
}
export function sharedView():{filter:FilterState;list:ListPrefs}|null {
 try{const q=new URLSearchParams(location.hash.split('?')[1]??'');const v=JSON.parse(q.get('view')??'null');return v?.filter&&v?.list?{filter:{...normalizeFilter(v.filter),text:typeof v.filter.text==='string'?v.filter.text:''},list:normalizeList(v.list)}:null;}catch{return null;}
}
