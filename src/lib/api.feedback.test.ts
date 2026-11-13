import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { requestActivity } from './requestActivity';

afterEach(() => { vi.unstubAllGlobals(); expect(requestActivity()).toEqual({ reads: 0, writes: 0 }); });

describe('行内保存反馈', () => {
  it('局部保存不锁全页，同一写请求仍然只提交一次', async () => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    const first = api.editIssue('AA-1', { summary: '修改' }, { feedback: 'local' });
    const second = api.editIssue('AA-1', { summary: '修改' }, { feedback: 'local' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(requestActivity()).toEqual({ reads: 0, writes: 0 });
    release(new Response(null, { status: 204 }));
    await Promise.all([first, second]);
  });
  it('默认保存继续使用全页保护，失败后释放并允许重试', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ errorMessages: ['保存失败'] }), { status: 500 })).mockResolvedValueOnce(new Response(null, { status: 204 })));
    const saving = api.editIssue('AA-2', { summary: '修改' });
    expect(requestActivity().writes).toBe(1);
    await expect(saving).rejects.toThrow('保存失败');
    expect(requestActivity().writes).toBe(0);
    await api.editIssue('AA-2', { summary: '修改' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
