import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setUnauthorizedListener } from './api';

const user = { name: 'zhang', displayName: '张同事' };
function mockResponses(...responses: { body: unknown; status?: number }[]) {
  const fetcher = vi.fn();
  for (const { body, status = 200 } of responses) fetcher.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
afterEach(() => { setUnauthorizedListener(null); vi.unstubAllGlobals(); });

describe('Jira 6 人员搜索兼容', () => {
  it('通用搜索包含停用人员；有结果时不再查询，中文参数保留', async () => {
    const fetcher = mockResponses({ body: [user] });
    expect((await api.filterUsers('AA', ' 张同事 ')).users).toEqual([user]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = new URL(fetcher.mock.calls[0][0], 'http://local');
    expect(url.pathname).toBe('/api/jira/user/search');
    expect(url.searchParams.get('username')).toBe('张同事');
    expect(url.searchParams.get('includeInactive')).toBe('true');
  });

  it.each([200, 403, 404, 405])('通用接口 HTTP %i 空结果或受限后使用 picker 的 query 参数和 users 响应', async status => {
    const fetcher = mockResponses({ body: status === 200 ? [] : { errorMessages: ['受限'] }, status }, { body: { users: [user], total: 1 } });
    expect((await api.filterUsers('AA', '张')).users).toEqual([user]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const url = new URL(fetcher.mock.calls[1][0], 'http://local');
    expect(url.pathname).toBe('/api/jira/user/picker');
    expect(url.searchParams.get('query')).toBe('张');
    expect(url.searchParams.has('username')).toBe(false);
  });

  it('两个目录无结果后查询当前项目可分配人员，明确说明范围', async () => {
    const ctrl = new AbortController();
    const fetcher = mockResponses({ body: [] }, { body: { users: [] } }, { body: [user, user] });
    expect(await api.filterUsers('BB', 'zhang', ctrl.signal)).toEqual({ users: [user], note: expect.stringContaining('项目可分配人员') });
    const url = new URL(fetcher.mock.calls[2][0], 'http://local');
    expect(url.searchParams.get('project')).toBe('BB');
    expect(url.searchParams.get('username')).toBe('zhang');
    for (const call of fetcher.mock.calls) expect(call[1].signal).toBe(ctrl.signal);
  });

  it('空输入只加载项目建议人员', async () => {
    const fetcher = mockResponses({ body: [user] });
    await api.filterUsers('AA', '');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toContain('user/assignable/search?');
    expect(fetcher.mock.calls[0][0]).toContain('project=AA');
  });

  it('登录失效触发原有会话处理且不继续尝试其他接口', async () => {
    const dispatchEvent = vi.fn(); vi.stubGlobal('window', { dispatchEvent });
    const ended = vi.fn(); setUnauthorizedListener(ended);
    const fetcher = mockResponses({ body: { errorMessages: ['会话过期'] }, status: 401 });
    await expect(api.filterUsers('AA', '张')).rejects.toBeInstanceOf(ApiError);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(ended).toHaveBeenCalledOnce();
  });

  it('网络故障和服务失败不伪装为无匹配', async () => {
    const fetcher = mockResponses({ body: { errorMessages: ['Jira 忙'] }, status: 503 });
    await expect(api.filterUsers('AA', '张')).rejects.toThrow('Jira 忙');
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockRejectedValueOnce(new TypeError('网络不可用'));
    await expect(api.filterUsers('AA', '张')).rejects.toThrow('网络不可用');
  });

  it('无效响应明确报错，不返回假空列表', async () => {
    mockResponses({ body: { users: [user] } });
    await expect(api.filterUsers('AA', '张')).rejects.toThrow('返回格式异常');
  });

  it('全部受限时展示失败；部分可用但为空时说明结果不完整', async () => {
    mockResponses(...[403, 404, 403].map(status => ({ status, body: { errorMessages: ['无法访问'] } })));
    await expect(api.filterUsers('AA', '张')).rejects.toThrow('人员搜索不可用');
    mockResponses({ body: [], status: 200 }, { body: {}, status: 403 }, { body: [] });
    expect(await api.filterUsers('AA', '张')).toEqual({ users: [], note: expect.stringContaining('结果可能不完整') });
  });

  it('取消的查询不启动后续兼容接口', async () => {
    const ctrl = new AbortController();
    const fetcher = vi.fn().mockImplementation(async () => { ctrl.abort(); return new Response('[]'); });
    vi.stubGlobal('fetch', fetcher);
    await expect(api.filterUsers('AA', '张', ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
