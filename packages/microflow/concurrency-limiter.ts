/**
 * 全局 Step 级并发上限器（缺陷 10 队列驱动真并发改造）。
 *
 * 设计约束（用户确认）：
 * - **pendingQueue 是 per-microflow 实例**（每个 StageExecutor 自己一个），不是全局队列。
 * - **全局并发上限通过共享 ConcurrencyLimiter 实现**：workflow 读 maxConcurrentSteps 配置 →
 *   创建 limiter → 注入每个 StageExecutor（microflow）。多个并行 StageExecutor 共享同一个
 *   limiter → 全局 Step 并发 ≤ maxConcurrentSteps。
 * - **并发单元是 per-Step**（processCommandNode 跑 subagent/shell/prompt），路由节点不 acquire
 *   （路由节点轻量不跑 subagent，不占槽）。
 *
 * acquire/release 采用 hand-off 信号量模式：release 时若有等待者，直接把槽位移交给下一个
 * 等待者（active 不变），避免 release→decrement + waiter→increment 之间的竞态窗口。
 *
 * @module dsh-sandore/microflow/src/concurrency-limiter
 */

/** 并发上限器接口（acquire 获取槽位 / release 释放槽位）。 */
export interface ConcurrencyLimiter {
  /** 获取一个并发槽位（槽位满时挂起等待，有槽位释放时唤醒）。 */
  acquire(): Promise<void>;
  /** 释放一个并发槽位（若有等待者，直接 hand-off 槽位）。 */
  release(): void;
}

/** 无上限器（maxConcurrentSteps = 0 时使用）：acquire 立即返回。 */
export class UnlimitedLimiter implements ConcurrencyLimiter {
  async acquire(): Promise<void> {
    // 无上限：立即返回。
  }
  release(): void {
    // 无上限：无操作。
  }
}

/** 信号量上限器（maxConcurrentSteps > 0 时使用）：hand-off 模式。 */
export class SemaphoreLimiter implements ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    // 槽位已满：挂起等待。release 时 hand-off 唤醒（active 不变，槽位直接转移）。
    await new Promise<void>(resolve => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    if (this.waiters.length > 0) {
      // hand-off：把槽位直接转移给下一个等待者（active 不变）。
      const next = this.waiters.shift();
      if (next !== undefined) {
        next();
        return;
      }
    }
    // 无等待者：释放槽位。
    this.active -= 1;
  }
}

/** 根据上限值创建合适的 limiter（0 = 无上限，>0 = 信号量）。 */
export function createConcurrencyLimiter(max: number): ConcurrencyLimiter {
  return max > 0 ? new SemaphoreLimiter(max) : new UnlimitedLimiter();
}
