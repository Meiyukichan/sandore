/**
 * 响应式状态包装器。
 *
 * 只负责「安全地持有最新值」+「显式 flush 落盘」。不做自动调度——
 * 持久化由业务代码的 `persistState`（→ flush）显式触发，避免微任务并发乱序。
 * 这样 `active.state = {...}` 赋值后，紧随的 `await persistState` 同步写当前值，
 * 与改造前的「显式 persistState 立即写库」语义完全一致。
 */
export class ReactiveState<T extends object> {
  private latest: T;

  constructor(
    initial: T,
    private readonly persist: (state: T) => Promise<void>,
    private readonly onError?: (error: unknown) => void,
  ) {
    this.latest = initial;
  }

  /** 读取当前状态（同步，零开销）。 */
  get current(): T {
    return this.latest;
  }

  /** 替换状态（仅更新内存最新值，不自动持久化——由显式 flush 落盘）。 */
  set current(next: T) {
    this.latest = next;
  }

  /** 批量更新（函数式，避免中间态暴露）。 */
  update(fn: (current: T) => T): void {
    this.latest = fn(this.latest);
  }

  /**
   * 立即持久化当前值并等待完成（关键路径）。
   * 同步捕获 latest → persist → await 完成，返回即落盘。
   */
  async flush(): Promise<void> {
    const snapshot = this.latest;
    try {
      await this.persist(snapshot);
    } catch (error) {
      this.onError?.(error);
    }
  }

  /** 兼容旧接口：等价 flush（无自动调度语义）。 */
  forcePersist(): void {
    void this.flush();
  }
}
