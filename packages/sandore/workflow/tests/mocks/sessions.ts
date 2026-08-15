/**
 * 内存 mock sessions（测试专用，非发布面）。
 *
 * 提供 `create`/`get`/`list` 等价语义；返回的 `FakeSession` 记录 `append` 的
 * 事件（type + data）。以 `ctx.provide('sessions', …)` 注入。
 * @module @deepseek-ai/dsh-sandore-workflow/tests/mocks/sessions
 */

/** 记录 append 事件的最小 Session 形状。 */
export class FakeSession {
  readonly events: Array<{ type: string; data: unknown }> = [];

  append(type: string, data: unknown): { type: string; seq: number; time: number; data: unknown } {
    this.events.push({ type, data });
    return { type, seq: this.events.length - 1, time: Date.now(), data };
  }
}

/** 内存 mock SessionStore：`create` 返回新的 `FakeSession` 并登记。 */
export class FakeSessionStore {
  private readonly sessions = new Map<string, FakeSession>();
  private counter = 0;

  create(id?: string): FakeSession {
    const session = new FakeSession();
    const key = id ?? `session-${++this.counter}`;
    this.sessions.set(key, session);
    return session;
  }

  get(id: string): FakeSession | undefined {
    return this.sessions.get(id);
  }

  list(): FakeSession[] {
    return [...this.sessions.values()];
  }
}
