import { describe, expect, it } from 'vitest';
import { sceneAllowed } from './settings';
describe('3D 场景开关', () => {
  it('自动模式尊重减少动效和 WebGL', () => { expect(sceneAllowed('auto', false, true)).toBe(true); expect(sceneAllowed('auto', true, true)).toBe(false); expect(sceneAllowed('auto', false, false)).toBe(false); });
  it('关闭始终禁用；显式开启仍需渲染器实际成功并处理错误边界', () => { expect(sceneAllowed('off', false, true)).toBe(false); expect(sceneAllowed('on', true, true)).toBe(true); });
});
