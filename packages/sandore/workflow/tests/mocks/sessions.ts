/**
 * 内存 mock sessions（测试专用，非发布面）。
 *
 * 提供 `create`/`get`/`list` 等价语义；返回的 `FakeSession` 记录 `append` 的
 * 事件（type + data）。以 `ctx.provide('sessions', …)` 注入。
 *
 * `create` 支持 DSH `CreateSessionOptions` 的 `seed`/`meta`（fork-session 持久化回退：
 * 从 `sessionPersistence.inspect` 读事件重建 fork 会话）；`FakeSession.deriveMessages`
 * 把事件归一为 LLM `Message[]`（user/assistant 两类；其余事件忽略），供
 * `forkStepSessionMessages` 的持久化回退断言全量历史。
 * @module @deepseek-ai/dsh-sandore-workflow/tests/mocks/sessions
 */
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm';

/** 记录 append 事件的最小 Session 形状（含 `seq`/`time` 包络，供 revert 安全边界计算）。 */
export interface FakeSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
}

/** `sessions.create` 的 seed/meta 选项（对齐 DSH `CreateSessionOptions` 最小面）。 */
export interface FakeCreateSessionOptions {
  readonly seed?: readonly FakeSessionEvent[];
  readonly meta?: { readonly parentSession?: string; readonly seedLength?: number; readonly cwd?: string };
}

/** 记录 append 事件的最小 Session 形状。 */
export class FakeSession {
  readonly events: FakeSessionEvent[] = [];
  /** 会话 id（`sessions.create`/`fork` 时由 store 设置，供 `forkSessionId` 断言）。 */
  id = '';

  append(type: string, data: unknown): FakeSessionEvent {
    const event: FakeSessionEvent = { type, seq: this.events.length, time: Date.now(), data };
    this.events.push(event);
    return event;
  }

  /** 事件日志 → LLM Message[]（user/message、assistant/message 两类；其余事件忽略）。 */
  deriveMessages(): Message[] {
    const messages: Message[] = [];
    for (const event of this.events) {
      if (event.type === 'user/message') {
        const content = (event.data as { content?: readonly ContentBlock[] } | undefined)?.content ?? [];
        messages.push({ id: `msg-${event.seq}`, role: 'user', content: [...content], source: { kind: 'user' } });
      } else if (event.type === 'assistant/message') {
        const message = (event.data as { message?: { content?: readonly ContentBlock[]; source?: unknown } } | undefined)?.message;
        messages.push({
          id: `msg-${event.seq}`,
          role: 'assistant',
          content: [...(message?.content ?? [])],
          source: (message?.source as Message['source']) ?? { kind: 'model', provider: 'mock', model: 'mock' },
        });
      }
    }
    return messages;
  }
}

/**
 * 内存 mock SessionStore：`create` 返回新的 `FakeSession` 并登记。
 *
 * `fork` 忠实模拟 DSH `sessions.fork` 的 OPEN_TURN 校验：boundary 省略（= 末事件 seq）
 * 且末事件落在未闭合 turn 内（最后 turn 边界为 turn/start 而非 turn/end）时抛
 * `OPEN_TURN`，使 retryStep fork 模式的未闭合尾部防御可被集成测试覆盖。
 */
export class FakeSessionStore {
  private readonly sessions = new Map<string, FakeSession>();
  private counter = 0;

  create(id?: string, options?: FakeCreateSessionOptions): FakeSession {
    const session = new FakeSession();
    const key = id ?? `session-${++this.counter}`;
    session.id = key;
    // seed 回放（fork-session 持久化回退：从 inspect 事件重建 fork 会话）。
    for (const event of options?.seed ?? []) {
      session.events.push({ ...event });
    }
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
      const events = sourceSession.events;
      // 对齐 DSH sessions.fork._forkSeed：boundary 省略时取末事件 seq；切片
      // [0, boundary] 内最后 turn 边界若为 turn/start（即切片落在未闭合 turn 内）
      // 则抛 OPEN_TURN。使 retryStep fork 模式的未闭合尾部防御可被集成测试覆盖。
      let resolvedBoundary = boundary;
      if (resolvedBoundary === undefined) {
        const lastEvent = events.at(-1);
        if (lastEvent === undefined) {
          // 空会话：fork 出空会话（对齐 DSH 空 seed）。
          const key = childSessionId ?? `session-${++this.counter}`;
          forked.id = key;
          this.sessions.set(key, forked);
          return forked;
        }
        resolvedBoundary = lastEvent.seq;
      }
      const slice = events.filter(event => event.seq <= resolvedBoundary!);
      let lastTurnBoundaryType: string | undefined;
      for (const event of slice) {
        if (event.type === 'turn/start' || event.type === 'turn/end') {
          lastTurnBoundaryType = event.type;
        }
      }
      if (lastTurnBoundaryType === 'turn/start') {
        throw new Error(`fork boundary for session "${source}" ends inside open turn (OPEN_TURN)`);
      }
      forked.events.push(...slice);
    }
    const key = childSessionId ?? `session-${++this.counter}`;
    forked.id = key;
    this.sessions.set(key, forked);
    return forked;
  }
}
