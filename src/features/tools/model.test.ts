import { describe, expect, it } from 'vitest';
import { decodeBase64, diffLines, encodeBase64, formatTimestamp, toTimestamp, validTools } from './model';
import { defaultCards, isWidget, newWidget, validCards } from '../../lib/workCards';
import { validBackup } from '../../lib/workbenchBackup';

describe('工作台本机数据与工具', () => {
  it('200px 高度通过读取校验，隐藏卡片和本机组件保留', () => {
    const card = { ...defaultCards()[0], height: 200, hidden: true };
    const widget = newWidget('notes'); expect(isWidget(widget)).toBe(true);
    expect(validCards([card, widget])).toBe(true);
    expect(validCards([{ ...card, height: 199 }])).toBe(false);
    expect(validCards([{ ...widget, widget: 'unknown' }])).toBe(false);
    expect(validCards([widget, widget])).toBe(false);
  });
  it('便签、待办和备份严格校验，不接收密钥或任意结构', () => {
    const tools = { notes: [{ id: '1', text: '中文便签', color: 'yellow' as const, pinned: true, updated: new Date().toISOString() }], todos: [{ id: '2', text: '整理', done: false, created: new Date().toISOString() }] };
    expect(validTools(tools)).toBe(true);
    expect(validTools({ ...tools, notes: [{ ...tools.notes[0], color: 'url()' }] })).toBe(false);
    expect(validBackup({ format: 'jira-workbench-backup', version: 1, cards: [], tools })).toBe(true);
    expect(validBackup({ format: 'jira-workbench-backup', version: 1, cards: [], tools, token: 'secret' })).toBe(false);
  });
  it('时间戳支持秒、毫秒和本机日期，错误明确', () => {
    expect(formatTimestamp('0')).toContain('1970'); expect(formatTimestamp('1000')).toContain('1970');
    expect(toTimestamp('1970-01-01T08:00')).toBe(0);
    expect(() => formatTimestamp('today')).toThrow('只支持数字'); expect(() => toTimestamp('bad')).toThrow('格式不正确');
  });
  it('Base64 保留中文，JSON 与文本对比不做外部请求', () => {
    expect(decodeBase64(encodeBase64('你好 Jira'))).toBe('你好 Jira');
    expect(() => decodeBase64('bad!')).toThrow();
    expect(diffLines('甲\n乙', '甲\n丙')).toEqual([{ type: 'same', text: '甲' }, { type: 'remove', text: '乙' }, { type: 'add', text: '丙' }]);
    expect(diffLines('甲', '甲')).toEqual([{ type: 'same', text: '甲' }]);
    expect(() => diffLines('a\n'.repeat(1001), 'b\n'.repeat(1001))).toThrow('分段对比');
  });
});
