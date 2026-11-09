import { describe,expect,it } from 'vitest';
import { blockers,csvCell,dueSoon,finished,matchesView,overdue,hoursProblems } from './management';
import { workReport } from './workReport';
import { changedNotice,noticesFor,snapshot } from './notifications';
import { validateBulkValue } from './bulk';
import { normalizeList } from './listPrefs';
import type { Issue,IssueLink } from './types';
const hf={estimate:['customfield_1'],devDone:['customfield_2'],devStart:['customfield_3']};
const issue=(key:string,extra:Record<string,unknown>={}):Issue=>({id:key,key,fields:{summary:key,status:{id:'1',name:'开发中'},issuetype:{id:'1',name:'编码任务'},customfield_10204:{name:'alice'},customfield_1:'4h',customfield_2:'2026-11-09',...extra}});
const link=(dir:'inwardIssue'|'outwardIssue',type='编码任务',status='开发中'):IssueLink=>({id:'l',type:{name:'Blocks',inward:'is blocked by',outward:'blocks'},[dir]:{id:'2',key:'A-2',fields:{summary:'关联',issuetype:{id:'1',name:type},status:{id:'1',name:status}}}});
describe('管理规则与报表口径',()=>{
 it('未完成逾期/临期按本地日期比较，已解决项不提醒',()=>{
  expect(overdue(issue('A-1',{duedate:'2026-11-08'}),'2026-11-09')).toBe(true);
  expect(dueSoon(issue('A-1',{duedate:'2026-11-12'}),'2026-11-09')).toBe(true);
  expect(dueSoon(issue('A-1',{duedate:'2026-11-13'}),'2026-11-09')).toBe(false);
  const done=issue('A-1',{duedate:'2026-11-08',resolution:{id:'1'}});expect(finished(done)).toBe(true);expect(overdue(done,'2026-11-09')).toBe(false);
 });
 it('父子 Blocks 不当作阻塞，入向未完成依赖才算',()=>{
  expect(blockers(issue('A-1',{issuetype:{name:'需求',id:'9'},issuelinks:[link('inwardIssue')]}))).toHaveLength(0);
  expect(blockers(issue('A-1',{issuelinks:[link('outwardIssue','需求')]}))).toHaveLength(0);
  expect(blockers(issue('A-1',{issuelinks:[link('inwardIssue')]}))).toHaveLength(1);
  expect(blockers(issue('A-1',{issuelinks:[link('inwardIssue','编码任务','关闭')]}))).toHaveLength(0);
 });
 it('今日任务依日期判断，测试视图必须测试人员为当前用户',()=>{
  expect(matchesView(issue('A-1',{customfield_3:'2026-11-09'}),'today',hf,'alice','2026-11-09')).toBe(true);
  expect(matchesView(issue('A-1'),'today',hf,'alice','2026-11-09')).toBe(false);
  expect(matchesView(issue('A-1',{status:{name:'测试中'},customfield_10401:{name:'bob'}}),'test',hf,'alice')).toBe(false);
 });
 it('检查缺字段、无效工时和日期兜底',()=>{
  expect(hoursProblems(issue('A-1',{customfield_1:'约4h左右',customfield_2:null,customfield_10204:null}),hf)).toHaveLength(3);
  expect(hoursProblems(issue('A-1',{customfield_2:null,resolutiondate:'2026-11-09T10:00:00+0800'}),hf)).toEqual([]);
 });
 it('工作汇总与现有报表一致：父需求不重复、关联Bug排除、日期过滤',()=>{
  const parent=issue('A-2',{issuetype:{id:'9',name:'需求'},customfield_1:'20h'});
  const child=issue('A-3',{issuelinks:[link('outwardIssue','需求')]});
  const bug=issue('A-4',{issuetype:{id:'3',name:'BUG及数据问题'},issuelinks:[link('outwardIssue','需求')]});
  const past=issue('A-5',{customfield_2:'2026-10-01'});
  const r=workReport([parent,child,bug,past],hf,'2026-11-09','2026-11-09');
  expect(r.report.total).toBe(4);expect(r.report.counted).toBe(1);expect(r.report.excludedBugs).toBe(1);expect(r.text).toContain('A-3');expect(r.text).not.toContain('A-5');
  expect(workReport([parent,child,bug],hf,'2026-11-09','2026-11-09',false).report.total).toBe(8);
 });
 it('CSV 引号换行正确并阻止 Excel 公式执行',()=>{
  expect(csvCell('=SUM(1,2)')).toBe('"\'=SUM(1,2)"');expect(csvCell('a"b\nc')).toBe('"a""b\nc"');
 });
 it('通知变化只报告读取后变化，已读ID随新状态更新',()=>{
  const old=issue('A-1'),next=issue('A-1',{status:{id:'2',name:'关闭'},updated:'2026-11-09T12:00:00Z'});
  expect(changedNotice(old,snapshot(old))).toBeNull();expect(changedNotice(next,snapshot(old))?.detail).toContain('开发中 → 关闭');
  expect(noticesFor([issue('A-1',{duedate:'2026-11-08'})],hf,'2026-11-09')[0].kind).toBe('overdue');
 });
 it('批量输入拒绝无效数字、日期、失效选项和跨父级级联选项',()=>{
  expect(()=>validateBulkValue({name:'工作量',schema:{type:'number'},required:false},'abc')).toThrow('有效数字');
  expect(()=>validateBulkValue({name:'日期',schema:{type:'date'},required:false},'2026-02-30')).toThrow('日期无效');
  expect(()=>validateBulkValue({name:'优先级',schema:{type:'priority'},required:false,allowedValues:[{id:'1'}]},'2')).toThrow('不允许');
  expect(()=>validateBulkValue({name:'级联',schema:{type:'option',custom:'com.atlassian.jira.plugin.system.customfieldtypes:cascadingselect'},required:false,allowedValues:[{id:'1',children:[{id:'2'}]}]},['1','3'])).toThrow('不匹配');
 });
 it('列表配置清除未知列、去重、限制宽度和排序',()=>{
  expect(normalizeList({columns:['status','bad','status'],widths:{title:5,due:9999},sort:'bad'})).toMatchObject({columns:['status'],widths:{title:240,due:700},sort:'updated'});
 });
});
