import { afterEach, describe, expect, it } from 'vitest';
import { requestActivity, subscribeRequestActivity, trackRequest } from './requestActivity';

describe('请求活动跟踪', () => {
  afterEach(() => expect(requestActivity()).toEqual({ reads: 0, writes: 0 }));

  it('并发读取和写入分别计数，全部结束后清零并通知', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const listener = { calls: 0 };
    const unsubscribe = subscribeRequestActivity(() => listener.calls++);
    const read = trackRequest(() => waiting);
    const write = trackRequest(() => waiting, true);
    expect(requestActivity()).toEqual({ reads: 1, writes: 1 });
    release();
    await Promise.all([read, write]);
    expect(requestActivity()).toEqual({ reads: 0, writes: 0 });
    expect(listener.calls).toBe(4); // 读、写各一次开始和一次结束，不合并结束状态以免漏掉加载反馈
    unsubscribe();
  });

  it('失败也释放计数并保留原始错误', async () => {
    const error = new Error('网络失败');
    await expect(trackRequest(() => Promise.reject(error), true)).rejects.toBe(error);
    expect(requestActivity()).toEqual({ reads: 0, writes: 0 });
  });
});
