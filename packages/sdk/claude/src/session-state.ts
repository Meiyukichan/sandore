/**
 * 会话后台状态封装（SessionState）—— @meiyukichan/claude-sdk 适配层（session-01）
 *
 * 每个会话封装四要素（design.md D2）：
 *   1. Query 句柄 —— Claude SDK query() 返回的一体化 AsyncGenerator；
 *   2. 流式输入队列 —— push/yield 模式（蓝本 scripts/conversation.ts），由 prompt() 控制 yield；
 *   3. SDKMessage 事件通道 —— 原始 SDKMessage 回放型广播通道（归一化为 GlobalEvent 由 event-01 负责）；
 *   4. 后台 query 泵 —— 后台启动 query({ prompt: 输入队列, options: { includePartialMessages, cwd, agent, model } })，
 *      消费首条 system/init 消息捕获 session_id（带超时保护）。
 *
 * 会话状态机：starting → running / requires_action → idle（收到 session_state_changed idle 或 result 回合结束），
 * close() 后进入 ended。生命周期阶段 phase：pending（create 已返回未捕获 init）→ created（init 捕获，design.md D2.1）。
 */
import type {
  SDKControlInterruptResponse,
  SDKMessage,
  SDKSessionStateChangedMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  SessionNotFoundError as SessionNotFoundErrorShape,
  TimeoutError as TimeoutErrorShape,
} from './types';

/** 会话状态值（starting=init 前；running=执行中；idle=空闲；requires_action=等待用户输入；ended=已关闭）。 */
export type SessionStateValue = 'starting' | 'idle' | 'running' | 'requires_action' | 'ended';

/** 会话生命周期阶段（design.md D2.1）：pending=create 已返回但未捕获真实 session_id；created=已捕获（首个 prompt 触发 init 后）。 */
export type SessionPhase = 'pending' | 'created';

/** query() options 的适配层子集（透传给 Claude SDK Options）。 */
export interface SessionQueryOptions {
  cwd?: string;
  agent?: string;
  model?: string;
  includePartialMessages?: boolean;
}

/**
 * Query 的最小接口（Claude SDK Query 的结构子集）。
 * SDK Query extends AsyncGenerator<SDKMessage, void> 且含 interrupt/close，
 * 结构上可赋给本接口；测试可用简化实现注入。
 */
export interface QueryLike {
  next(...args: [] | [unknown]): Promise<IteratorResult<SDKMessage, void>>;
  return(value?: unknown): Promise<IteratorResult<SDKMessage, void>>;
  throw(error?: unknown): Promise<IteratorResult<SDKMessage, void>>;
  [Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void>;
  interrupt(): Promise<SDKControlInterruptResponse | undefined>;
  close(): void;
}

/** 创建 Query 的工厂（依赖注入点，默认 Claude SDK query）。 */
export type QueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: SessionQueryOptions;
}) => QueryLike;

/** 超时错误（Error 子类，兼容 types.ts 的 TimeoutError 判别联合）。 */
export class TimeoutError extends Error implements TimeoutErrorShape {
  readonly _tag = 'TimeoutError' as const;
  readonly timeoutMs?: number;

  constructor(message: string, timeoutMs?: number) {
    super(message);
    this.timeoutMs = timeoutMs;
    this.name = 'TimeoutError';
  }
}

/** 会话不存在错误（Error 子类，兼容 types.ts 的 SessionNotFoundError 判别联合）。 */
export class SessionNotFoundError extends Error implements SessionNotFoundErrorShape {
  readonly _tag = 'SessionNotFoundError' as const;
  readonly sessionID: string;

  constructor(sessionID: string, message?: string) {
    super(message ?? `session not found: ${sessionID}`);
    this.sessionID = sessionID;
    this.name = 'SessionNotFoundError';
  }
}

const DEFAULT_INIT_TIMEOUT_MS = 30_000;

/** SessionState 构造参数。 */
export interface SessionStateOptions {
  /** 会话工作目录（客户端 cwd）。 */
  cwd: string;
  /** agent 名称，透传给 query() options。 */
  agent?: string;
  /** 模型 ID，透传给 query() options.model。 */
  model?: string;
  /** system/init 捕获超时毫秒数。 */
  initTimeoutMs?: number;
  /** 创建 Query 的工厂（默认 Claude SDK query）。 */
  queryFn: QueryFactory;
  /** init 捕获回调（create() 借此注册 Map）。 */
  onInit?: (sessionId: string) => void;
  /** 后台 query 泵出错回调（避免未处理拒绝）。 */
  onError?: (error: unknown) => void;
  /** close() 后回调（create() 借此从 Map 清理）。 */
  onClose?: () => void;
}

/** 原始 SDKMessage 回放型广播通道：缓冲所有消息，晚订阅者从缓冲回放，close 后流终止。 */
class ReplayChannel<T> {
  private readonly buffer: T[] = [];
  private readonly subscribers = new Set<ReplaySubscriber<T>>();
  private closed = false;

  write(message: T): void {
    if (this.closed) return;
    this.buffer.push(message);
    for (const subscriber of this.subscribers) {
      subscriber.notify();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const subscriber of this.subscribers) {
      subscriber.end();
    }
    this.subscribers.clear();
  }

  async *subscribe(): AsyncGenerator<T> {
    const subscriber = new ReplaySubscriber<T>(this.buffer);
    this.subscribers.add(subscriber);
    try {
      yield* subscriber.iterate();
    } finally {
      this.subscribers.delete(subscriber);
    }
  }
}

/** 单个订阅者：共享通道 buffer、各自持有游标，notify/end 唤醒挂起的迭代。 */
class ReplaySubscriber<T> {
  private readonly buffer: T[];
  private index = 0;
  private ended = false;
  private readonly waiters: Array<() => void> = [];

  constructor(buffer: T[]) {
    this.buffer = buffer;
  }

  notify(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  end(): void {
    this.ended = true;
    this.notify();
  }

  async *iterate(): AsyncGenerator<T> {
    while (true) {
      if (this.index < this.buffer.length) {
        yield this.buffer[this.index++];
      } else if (this.ended) {
        return;
      } else {
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve);
          // 注册后再检查一次，避免 write 与 wait 之间的唤醒竞态。
          if (this.index < this.buffer.length || this.ended) {
            const idx = this.waiters.indexOf(resolve);
            if (idx >= 0) this.waiters.splice(idx, 1);
            resolve();
          }
        });
      }
    }
  }
}

/** 会话后台状态：Query 句柄、流式输入队列、SDKMessage 事件通道与后台 query 泵。 */
export class SessionState {
  private readonly query: QueryLike;
  private readonly channel = new ReplayChannel<SDKMessage>();
  private readonly pending: SDKUserMessage[] = [];
  private readonly initTimeoutMs: number;
  private readonly onInit?: (sessionId: string) => void;
  private readonly onError?: (error: unknown) => void;
  private readonly onClose?: () => void;

  private wake: (() => void) | null = null;
  private closed = false;
  private idle = false;
  private stateValue: SessionStateValue = 'starting';
  private phaseValue: SessionPhase = 'pending';
  private sessionIdValue: string | undefined;
  private messageSeq = 0;
  private error: unknown | undefined;
  private readonly initWaiters: Array<(sessionId: string) => void> = [];
  private readonly idleWaiters: Array<(endError?: unknown) => void> = [];

  constructor(options: SessionStateOptions) {
    this.directory = options.cwd;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.onInit = options.onInit;
    this.onError = options.onError;
    this.onClose = options.onClose;
    this.query = options.queryFn({
      prompt: this.inputQueue(),
      options: {
        cwd: options.cwd,
        agent: options.agent,
        model: options.model,
        includePartialMessages: true,
      },
    });
    void this.pump();
  }

  /** 会话工作目录（create 时的客户端 cwd）。 */
  readonly directory: string;

  /** 会话 ID（init 捕获后回填，否则 undefined）。 */
  get sessionId(): string | undefined {
    return this.sessionIdValue;
  }

  /** 会话当前状态。 */
  get state(): SessionStateValue {
    return this.stateValue;
  }

  /** 会话生命周期阶段：pending=create 已返回但未捕获真实 session_id；created=已捕获。 */
  get phase(): SessionPhase {
    return this.phaseValue;
  }

  /** 会话是否空闲（state=idle 或已收 result / 已关闭）。 */
  get isIdle(): boolean {
    return this.idle;
  }

  /** 后台 query 泵最近一次错误（错误结束后保留，waitForIdle 据此 reject；正常结束为 undefined）。 */
  get lastError(): unknown | undefined {
    return this.error;
  }

  /** SDKMessage 事件通道（回放型）：每次访问返回新订阅。 */
  get events(): AsyncIterable<SDKMessage> {
    return this.channel.subscribe();
  }

  /** 向流式输入队列 push 一条用户消息；返回会话内自增序号（admittedSeq）。 */
  push(message: SDKUserMessage): number {
    this.pending.push(message);
    this.wake?.();
    return this.messageSeq++;
  }

  /** 等待 system/init 捕获 session_id；超时 reject TimeoutError。 */
  waitForInit(): Promise<string> {
    if (this.sessionIdValue !== undefined) {
      return Promise.resolve(this.sessionIdValue);
    }
    return new Promise<string>((resolve, reject) => {
      const onInit = (sessionId: string): void => {
        clearTimeout(timer);
        resolve(sessionId);
      };
      const timer = setTimeout(() => {
        const idx = this.initWaiters.indexOf(onInit);
        if (idx >= 0) this.initWaiters.splice(idx, 1);
        reject(
          new TimeoutError(
            `session init timed out after ${this.initTimeoutMs}ms`,
            this.initTimeoutMs,
          ),
        );
      }, this.initTimeoutMs);
      this.initWaiters.push(onInit);
      if (this.sessionIdValue !== undefined) {
        onInit(this.sessionIdValue);
      }
    });
  }

  /** 等待会话空闲（事件驱动）；支持 timeout，超时 reject TimeoutError；错误结束 reject 该错误。 */
  waitForIdle(timeoutMs?: number): Promise<void> {
    if (this.idle) {
      return this.error === undefined ? Promise.resolve() : Promise.reject(this.error);
    }
    return new Promise<void>((resolve, reject) => {
      const onIdle = (endError?: unknown): void => {
        clearTimeout(timer);
        if (endError === undefined) {
          resolve();
        } else {
          reject(endError);
        }
      };
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              const idx = this.idleWaiters.indexOf(onIdle);
              if (idx >= 0) this.idleWaiters.splice(idx, 1);
              reject(new TimeoutError(`session wait timed out after ${timeoutMs}ms`, timeoutMs));
            }, timeoutMs);
      this.idleWaiters.push(onIdle);
      if (this.idle) {
        onIdle(this.error);
      }
    });
  }

  /** 中断当前执行；空闲/未启动/已结束会话为 no-op（不抛错）。 */
  async interrupt(): Promise<void> {
    if (
      this.closed ||
      this.stateValue === 'idle' ||
      this.stateValue === 'starting' ||
      this.stateValue === 'ended'
    ) {
      // 空闲/未启动/已结束会话中断为 no-op。
      return;
    }
    await this.query.interrupt();
  }

  /** 关闭 Query、结束事件通道并触发 onClose 回调。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stateValue = 'ended';
    this.query.close();
    this.wake?.();
    this.idle = true;
    this.notifyIdle();
    this.channel.close();
    this.onClose?.();
  }

  /** 输入队列生成器：永不完结，由 close() 终止。 */
  private async *inputQueue(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      while (this.pending.length === 0) {
        if (this.closed) return;
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = null;
      }
      // pending 非空守卫（LF.ASSERT：while 循环已保证非空）。
      yield this.pending.shift() as SDKUserMessage;
    }
  }

  /** 后台 query 泵：消费 query 输出流，分发到事件通道并更新会话状态。 */
  private async pump(): Promise<void> {
    try {
      for await (const message of this.query) {
        this.channel.write(message);
        this.handleMessage(message);
      }
    } catch (error) {
      // 记录错误并标记错误结束：waitForIdle 据此 reject 而非把出错终止误判为正常空闲。
      this.error = error;
      this.onError?.(error);
    } finally {
      this.handlePumpEnd();
    }
  }

  /** 按 type/subtype 判别分发；未映射的 SDKMessage 类型静默跳过（仅透传事件通道）。 */
  private handleMessage(message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.sessionIdValue = message.session_id;
          // 真实 session_id 捕获后，会话由 pending 转为 created（design.md D2.1）。
          this.phaseValue = 'created';
          this.stateValue = 'running';
          this.notifyInit(message.session_id);
          this.onInit?.(message.session_id);
        } else if (message.subtype === 'session_state_changed') {
          this.handleStateChange(message);
        }
        break;
      case 'result':
        this.handleResult();
        break;
      default:
        // stream_event/assistant/status 等其它消息：本文件仅透传事件通道，状态归一化由 event-01 负责。
        break;
    }
  }

  private handleStateChange(message: SDKSessionStateChangedMessage): void {
    this.stateValue = message.state;
    if (message.state === 'idle') {
      this.idle = true;
      this.notifyIdle();
    } else {
      this.idle = false;
    }
  }

  private handleResult(): void {
    // 回合结束（result 消息，success / error_*）视为空闲。
    this.stateValue = 'idle';
    this.idle = true;
    this.notifyIdle();
  }

  private notifyInit(sessionId: string): void {
    const waiters = this.initWaiters.splice(0);
    for (const waiter of waiters) waiter(sessionId);
  }

  private notifyIdle(endError?: unknown): void {
    const waiters = this.idleWaiters.splice(0);
    for (const waiter of waiters) waiter(endError);
  }

  private handlePumpEnd(): void {
    if (this.closed) return;
    this.closed = true;
    this.stateValue = 'ended';
    this.idle = true;
    // 区分错误结束（reject）与 close/自然结束（resolve）。
    this.notifyIdle(this.error);
    this.wake?.();
    this.channel.close();
    // 与 close() 幂等：closed 守卫保证只触发一次，SessionManager 借此从 Map 清理。
    this.onClose?.();
  }
}
