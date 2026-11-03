import { describe, expect, it } from 'vitest';
import { createLinkUpdates, dedupeLinks, issueLinkBody, linkOptions, PARENT_OPTION, relationLabel } from './links';

const TYPES = [
  { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  { name: 'Relates', inward: 'relates to', outward: 'relates to' },
];

describe('links', () => {
  it('Relates 排第一且只有一个方向', () => {
    const o = linkOptions(TYPES);
    expect(o[0].id).toBe('Relates:out');
    expect(o.filter((x) => x.type === 'Relates')).toHaveLength(1);
    expect(o.map((x) => x.id)).toEqual(['Relates:out', 'Blocks:out', 'Blocks:in']);
    expect(o.map((x) => x.label)).toEqual(['相关', '卡住它', '被它卡住']);
    expect(o.every((x) => x.hint)).toBe(true);
  });

  it('通俗说法：已知类型翻译，未知类型用 Jira 原文', () => {
    expect(relationLabel('Blocks', 'in', 'is blocked by')).toBe('被它卡住');
    expect(relationLabel('Custom', 'out', 'tests')).toBe('tests');
  });

  it('新建时父需求作为 outwardIssue（子项 blocks 父）', () => {
    expect(createLinkUpdates([{ option: PARENT_OPTION, key: 'A-1' }])).toEqual([
      { add: { type: { name: 'Blocks' }, outwardIssue: { key: 'A-1' } } },
    ]);
    expect(createLinkUpdates([{ option: { type: 'Blocks', dir: 'in' }, key: 'A-2' }])[0].add).toHaveProperty('inwardIssue');
  });

  it('issueLink 请求体方向与 linkChild 一致', () => {
    expect(issueLinkBody('A-9', { option: PARENT_OPTION, key: 'A-1' })).toEqual({
      type: { name: 'Blocks' },
      inwardIssue: { key: 'A-9' },
      outwardIssue: { key: 'A-1' },
    });
    expect(issueLinkBody('A-1', { option: { type: 'Blocks', dir: 'in' }, key: 'A-9' })).toMatchObject({
      inwardIssue: { key: 'A-9' },
      outwardIssue: { key: 'A-1' },
    });
  });

  it('去重', () => {
    const l = { option: { type: 'Relates', dir: 'out' as const }, key: 'A-1' };
    expect(dedupeLinks([l, { ...l }])).toHaveLength(1);
  });
});

import { namePasted } from '../components/AttachmentDrop';
describe('粘贴文件命名', () => {
  it('通用名改为带时间戳的截图名，正常文件名保留', () => {
    const now = new Date(2026, 9, 27, 9, 5, 3);
    expect(namePasted(new File(['x'], 'clipboard.png', { type: 'image/png' }), now).name).toMatch(/^截图_20261027_090503_\w{3}\.png$/);
    expect(namePasted(new File(['x'], 'image.png', { type: 'image/png' }), now).name).toMatch(/^截图_/);
    expect(namePasted(new File(['x'], '需求说明.docx', { type: 'application/msword' }), now).name).toBe('需求说明.docx');
  });
});
