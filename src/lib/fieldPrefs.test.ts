import { describe, expect, it } from 'vitest';
import { splitFields } from './fieldPrefs';
import type { FieldMetaMap } from './fields';

const meta: FieldMetaMap = {
  summary: { required: true, name: '主题', schema: { type: 'string' } },
  versions: { required: false, name: '影响版本', schema: { type: 'array', items: 'version' } },
  labels: { required: false, name: '标签', schema: { type: 'array', items: 'string' } },
  priority: { required: false, name: '优先级', schema: { type: 'priority' } },
};

describe('splitFields', () => {
  it('隐藏非必填空字段；必填和已填的不隐藏', () => {
    const r = splitFields(['summary', 'versions', 'labels', 'priority'], meta, ['summary', 'versions', 'labels'], (id) => id === 'labels');
    expect(r.shown).toEqual(['summary', 'labels', 'priority']);
    expect(r.folded).toEqual(['versions']);
  });
});
