import { describe, expect, it, vi } from 'vitest';
import { ReactiveState } from './reactive-state.ts';

/**
 * ReactiveState 新语义（纯显式 flush，无自动调度）：
 * - set/update 只更新内存最新值，不自动 persist（避免微任务并发乱序）
 * - flush() 立即持久化当前最新值并等待完成（关键路径）
 */
describe('ReactiveState', () => {
  it('get current 返回初始值', () => {
    const rs = new ReactiveState({ a: 1 }, async () => {});
    expect(rs.current).toEqual({ a: 1 });
  });

  it('set current 立即更新 current 但不自动 persist', () => {
    const persist = vi.fn(async () => {});
    const rs = new ReactiveState({ a: 1 }, persist);
    rs.current = { a: 2 };
    expect(rs.current).toEqual({ a: 2 });
    expect(persist).not.toHaveBeenCalled();
  });

  it('flush 立即持久化当前值并等待完成', async () => {
    const persist = vi.fn(async () => {});
    const rs = new ReactiveState({ a: 1 }, persist);
    rs.current = { a: 2 };
    await rs.flush();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ a: 2 });
  });

  it('flush 在赋值后落盘最新值（多次赋值只写最后一次 flush 的值）', async () => {
    const persist = vi.fn(async () => {});
    const rs = new ReactiveState({ a: 1 }, persist);
    rs.current = { a: 2 };
    rs.current = { a: 3 };
    rs.current = { a: 4 };
    // 三次赋值都不自动 persist；flush 写最新 { a: 4 }
    expect(persist).not.toHaveBeenCalled();
    await rs.flush();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ a: 4 });
  });

  it('update 函数式更新内存值（不自动 persist）', () => {
    const persist = vi.fn(async () => {});
    const rs = new ReactiveState({ count: 0 }, persist);
    rs.update(current => ({ count: current.count + 1 }));
    expect(rs.current).toEqual({ count: 1 });
    expect(persist).not.toHaveBeenCalled();
  });

  it('onError 兜底捕获 flush 的 persist 异常', async () => {
    const error = new Error('persist failed');
    const onError = vi.fn();
    const rs = new ReactiveState({ a: 1 }, async () => { throw error; }, onError);
    await rs.flush();
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('forcePersist 等价 flush（立即持久化当前值）', async () => {
    const persist = vi.fn(async () => {});
    const rs = new ReactiveState({ a: 1 }, persist);
    rs.current = { a: 2 };
    rs.forcePersist();
    await rs.flush();
    expect(persist).toHaveBeenCalledWith({ a: 2 });
  });
});
