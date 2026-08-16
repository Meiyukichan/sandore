/**
 * 内存 mock sessions（测试专用，非发布面）。
 *
 * 提供 `create`/`get`/`list` 等价语义；返回的 `FakeSession` 记录 `append` 的
 * 事件（type + data）。以 `ctx.provide('sessions', …)` 注入。
 * @module @deepseek-ai/dsh-sandore-workflow/tests/mocks/sessions
 */

/** 记录 append 事件的最小 Session 形状（含 `seq`/`time` 包络，供 revert 安全边界计算）。 */
export interface FakeSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
}

/** 记录 append 事件的最小 Session 形状。 */
export class FakeSession {
  readonly events: FakeSessionEvent[] = [];

  append(type: string, data: unknown): FakeSessionEvent {
    const event: FakeSessionEvent = { type, seq: this.events.length, time: Date.now(), data };
    this.events.push(event);
    return event;
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

  /** 从源会话复制到 boundary（含端点，省略=全量）前缀，登记为新的子会话。 */
  fork(source: string, boundary?: number, childSessionId?: string): FakeSession {
    const sourceSession = this.sessions.get(source);
    const forked = new FakeSession();
    if (sourceSession !== undefined) {
      const end = boundary === undefined ? sourceSession.events.length - 1 : boundary;
      forked.events.push(...sourceSession.events.slice(0, end + 1));
    }
    const key = childSessionId ?? `session-${++this.counter}`;
    this.sessions.set(key, forked);
    return forked;
  }
}
