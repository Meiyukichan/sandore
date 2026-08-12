/**
 * 会话管理测试（test/session.test.ts）
 *
 * 覆盖 plan.json session-01 的 8 条 acceptance criteria：
 *   1. create() 后台启动 query()，捕获 system/init 的 session_id 后 resolve SessionV2Info
 *      （含 id/projectID/time/title/location/cost/tokens，location.directory=cwd）
 *   2. create({ agent }) 将 agent 透传给 query() options 且 SessionV2Info 含该值；init 超时 reject
 *   3. messages() 返回 SessionMessagesResponse{data, cursor}，data 为 SessionMessage 数组
 *   4. prompt() push SDKUserMessage 并返回 SessionInputAdmitted（id 以 msg_ 开头）；不存在会话抛 SessionNotFoundError
 *   5. interrupt() 调用 Query.interrupt()；空闲会话为 no-op
 *   6. wait() 在会话空闲后 resolve；超时抛 TimeoutError
 *   7. 后台 Map 会话间状态隔离，并发会话互不影响
 *   8. close() 关闭 Query、事件通道结束并从 Map 移除
 *
 * 测试采用依赖注入：SessionManager 构造接收 queryFn / getSessionMessagesFn，
 * 以可控的 FakeQuery 模拟 Claude SDK 的 query()（AsyncGenerator + interrupt/close）。
 */
import type {
  GetSessionMessagesOptions,
  SDKMessage,
  SDKUserMessage,
  SessionMessage as SDKStoredMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { SessionManager } from '../src/session';
import type { SessionMessagesOptions, SessionPromptInput } from '../src/session';
import { SessionNotFoundError, TimeoutError } from '../src/session-state';
import type { QueryFactory, QueryLike, SessionQueryOptions } from '../src/session-state';
import type {
  GlobalEvent,
  SessionInputAdmitted,
  SessionMessagesResponse,
  SessionV2Info,
} from '../src/types';

// ---------------------------------------------------------------------------
// 测试工具：构造 SDKMessage（SDK 联合类型字段极多，仅关心子集，故集中断言）
// ---------------------------------------------------------------------------

/** 构造 system/init 消息（session_id 捕获点）。 */
function initMessage(sessionId: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    uuid: crypto.randomUUID(),
    cwd: '/tmp/project',
    model: 'sonnet',
    permissionMode: 'default',
    claude_code_version: '0.3.226',
    apiKeySource: 'user',
    tools: [],
    mcp_servers: [],
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
  } as unknown as SDKMessage;
}

/** 构造 system/session_state_changed 消息（wait/interrupt 的状态依据）。 */
function stateMessage(sessionId: string, state: 'idle' | 'running' | 'requires_action'): SDKMessage {
  return {
    type: 'system',
    subtype: 'session_state_changed',
    state,
    session_id: sessionId,
    uuid: crypto.randomUUID(),
  } as unknown as SDKMessage;
}

/** 构造 result（success）消息（回合结束，wait 的补充判据）。 */
function resultMessage(sessionId: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    stop_reason: 'end_turn',
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  } as unknown as SDKMessage;
}

/** 刷新一次宏任务队列，让后台 query 泵的异步迭代推进。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// FakeQuery：可控的 QueryLike 实现，模拟 Claude SDK query() 的 AsyncGenerator
// ---------------------------------------------------------------------------

class FakeQuery implements QueryLike {
  /** 输入流迭代器（query() 的 prompt 生成器），供测试验证 push 的消息形状。 */
  private readonly inputIterator: AsyncIterator<SDKUserMessage>;

  private readonly queue: SDKMessage[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<SDKMessage, void>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private ended = false;

  /** 记录 interrupt() 被调用的次数。 */
  readonly interrupt = vi.fn(async () => ({ still_queued: [] as string[] }));

  /** 记录 close() 被调用的次数。 */
  readonly close = vi.fn(() => {
    this.ended = true;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.resolve({ value: undefined, done: true });
  });

  constructor(prompt: AsyncIterable<SDKUserMessage>) {
    this.inputIterator = prompt[Symbol.asyncIterator]();
  }

  /** 向查询输出流 push 一条 SDKMessage（模拟 CLI 产出）。 */
  pushMessage(message: SDKMessage): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      // 有待处理的 next() 等待者：直接投递，不入队（避免队列残留重复投递）。
      waiter.resolve({ value: message, done: false });
      return;
    }
    this.queue.push(message);
  }

  /** 终止查询流（模拟 query() 自然完成）。 */
  end(): void {
    this.ended = true;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.resolve({ value: undefined, done: true });
  }

  /** 使查询输出流抛出错误（模拟 query() 异常终止）。 */
  fail(error: unknown): void {
    this.ended = true;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }

  /** 从输入流（prompt 生成器）读取一条用户消息；无消息时挂起。 */
  async readInput(): Promise<SDKUserMessage | undefined> {
    const result = await this.inputIterator.next();
    return result.done ? undefined : result.value;
  }

  next(): Promise<IteratorResult<SDKMessage, void>> {
    if (this.queue.length > 0) {
      return Promise.resolve({ value: this.queue.shift()!, done: false });
    }
    if (this.ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  return(): Promise<IteratorResult<SDKMessage, void>> {
    this.end();
    return Promise.resolve({ value: undefined, done: true });
  }

  throw(error: unknown): Promise<IteratorResult<SDKMessage, void>> {
    return Promise.reject(error);
  }

  [Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    return this;
  }
}

// ---------------------------------------------------------------------------
// 测试夹具：创建注入 queryFn / getSessionMessagesFn 的 SessionManager
// ---------------------------------------------------------------------------

interface SessionHarness {
  manager: SessionManager;
  fakes: FakeQuery[];
  get fake(): FakeQuery;
  get lastQueryOptions(): SessionQueryOptions | undefined;
}

function createHarness(options?: {
  initTimeoutMs?: number;
  getMessages?: (sessionId: string, options?: GetSessionMessagesOptions) => Promise<SDKStoredMessage[]>;
}): SessionHarness {
  const fakes: FakeQuery[] = [];
  let lastQueryOptions: SessionQueryOptions | undefined;
  const queryFn: QueryFactory = (params) => {
    lastQueryOptions = params.options;
    const fake = new FakeQuery(params.prompt);
    fakes.push(fake);
    return fake;
  };
  const manager = new SessionManager({
    cwd: '/tmp/project',
    initTimeoutMs: options?.initTimeoutMs ?? 1000,
    queryFn,
    getSessionMessagesFn: options?.getMessages,
  });
  return {
    manager,
    fakes,
    get fake() {
      return fakes[fakes.length - 1] as FakeQuery;
    },
    get lastQueryOptions() {
      return lastQueryOptions;
    },
  };
}

/** 便捷：提供 firstMessage 创建会话并等待 init resolve（init 推送到最新创建的 fake）。 */
async function createSession(
  harness: SessionHarness,
  options?: { agent?: string },
): Promise<SessionV2Info> {
  const promise = harness.manager.create({ ...options, firstMessage: 'hello' });
  harness.fake.pushMessage(initMessage('ses-1'));
  return promise;
}

function createPromptInput(text: string): SessionPromptInput {
  return { prompt: { text } };
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

describe('session.create（Create session）', () => {
  it('后台启动 query()，捕获 system/init 的 session_id 后 resolve SessionV2Info', async () => {
    const harness = createHarness();
    const session = await createSession(harness);

    expect(session.id).toBe('ses-1');
    expect(session.location.directory).toBe('/tmp/project');
    expect(session.projectID).toBeTypeOf('string');
    expect(session.time.created).toBeTypeOf('string');
    expect(session.time.updated).toBeTypeOf('string');
    expect(session.title).toBeTypeOf('string');
    expect(session.cost).toEqual({});
    expect(session.tokens).toEqual({});
  });

  it('query() 以流式输入模式启动（options 含 includePartialMessages/cwd）', async () => {
    const harness = createHarness();
    await createSession(harness);

    expect(harness.lastQueryOptions).toMatchObject({
      cwd: '/tmp/project',
      includePartialMessages: true,
    });
  });

  it('create({ agent }) 将 agent 透传 query() options 且 SessionV2Info 含该值', async () => {
    const harness = createHarness();
    const session = await createSession(harness, { agent: 'general-purpose' });

    expect(harness.lastQueryOptions?.agent).toBe('general-purpose');
    expect(session.agent).toBe('general-purpose');
  });

  it('system/init 在超时时间内未到达时 reject 抛出超时错误', async () => {
    const harness = createHarness({ initTimeoutMs: 30 });

    await expect(harness.manager.create({ firstMessage: 'hello' })).rejects.toMatchObject({
      _tag: 'TimeoutError',
    });
    await expect(harness.manager.create({ firstMessage: 'hello' })).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });

  it('projectID 将非 ASCII 路径段按 %XX 转码', async () => {
    const harness = createHarness();
    const promise = harness.manager.create({
      location: { directory: '/tmp/中文项目' },
      firstMessage: 'hello',
    });
    harness.fake.pushMessage(initMessage('ses-1'));

    const session = await promise;

    // 中=中 文=文 项=项 目=目（单代码单元 -> %XX 大写十六进制）。
    expect(session.projectID).toBe('tmp-%4E2D%6587%9879%76EE');
  });

  it('create({ firstMessage }) 将该消息调度为首条用户消息并捕获真实 session_id', async () => {
    const harness = createHarness();
    const promise = harness.manager.create({ firstMessage: 'hello' });

    // firstMessage 已作为首条输入入队，CLI 读取后即触发 init。
    const pushed = await harness.fake.readInput();
    expect(pushed?.message.content).toBe('hello');
    harness.fake.pushMessage(initMessage('ses-real-1'));

    const session = await promise;
    expect(session.id).toBe('ses-real-1');

    // 会话已 created：后续 prompt 立即用真实 session_id。
    const admitted = await harness.manager.prompt('ses-real-1', createPromptInput('hi'));
    expect(admitted.sessionID).toBe('ses-real-1');
  });

  it('create 无 firstMessage 返回占位 id（ses_ 前缀）且会话处于 pending', async () => {
    const harness = createHarness();
    const session = await harness.manager.create({});

    expect(session.id).toMatch(/^ses_/);
    expect(harness.manager.getPhase(session.id)).toBe('pending');
  });

  it('prompt 触发 init 后会话转 created，后续 prompt 用真实 id', async () => {
    const harness = createHarness();
    const placeholder = await harness.manager.create({});
    expect(harness.manager.getPhase(placeholder.id)).toBe('pending');

    // 首个 prompt 入队后 CLI 读取，触发 init → 捕获真实 session_id。
    const admitting = harness.manager.prompt(placeholder.id, createPromptInput('hello'));
    const pushed = await harness.fake.readInput();
    expect(pushed?.message.content).toBe('hello');
    harness.fake.pushMessage(initMessage('ses-real-1'));

    const admitted = await admitting;
    expect(admitted.sessionID).toBe('ses-real-1');
    // 占位 id 在 created 后仍为有效别名，解析到真实会话。
    expect(harness.manager.getPhase(placeholder.id)).toBe('created');
    expect(harness.manager.getPhase('ses-real-1')).toBe('created');

    // 后续 prompt 返回真实 session_id。
    const second = await harness.manager.prompt('ses-real-1', createPromptInput('hi'));
    expect(second.sessionID).toBe('ses-real-1');
  });

  it('pending 状态下 prompt 超时（init 未捕获）抛 TimeoutError', async () => {
    const harness = createHarness({ initTimeoutMs: 30 });
    const placeholder = await harness.manager.create({});

    await expect(harness.manager.prompt(placeholder.id, createPromptInput('hi'))).rejects.toMatchObject(
      { _tag: 'TimeoutError' },
    );
    await expect(harness.manager.prompt(placeholder.id, createPromptInput('hi'))).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });
});

describe('session.messages（Read session messages）', () => {
  const storedMessages: SDKStoredMessage[] = [
    {
      type: 'user',
      uuid: 'uuid-user-1',
      session_id: 'ses-1',
      message: { role: 'user', content: 'hello' },
      parent_tool_use_id: null,
      parent_agent_id: null,
    },
    {
      type: 'assistant',
      uuid: 'uuid-assistant-1',
      session_id: 'ses-1',
      message: {
        id: 'msg-1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', id: 'block-1', text: 'hi there' }],
      },
      parent_tool_use_id: null,
      parent_agent_id: null,
    },
    {
      type: 'system',
      uuid: 'uuid-system-1',
      session_id: 'ses-1',
      message: { type: 'compact_boundary', text: 'compacted' },
      parent_tool_use_id: null,
      parent_agent_id: null,
    },
  ];

  it('返回 SessionMessagesResponse{data, cursor}，data 为 SessionMessage 数组', async () => {
    const harness = createHarness({ getMessages: async () => storedMessages });
    await createSession(harness);

    const response: SessionMessagesResponse = await harness.manager.messages('ses-1');

    expect(response.data).toHaveLength(3);
    expect(response.data[0]).toMatchObject({ id: 'msg_uuid-user-1', type: 'user', text: 'hello' });
    expect(response.data[1]).toMatchObject({
      id: 'msg_uuid-assistant-1',
      type: 'assistant',
      content: [{ type: 'text', id: 'block-1', text: 'hi there' }],
    });
    expect(response.data[2]).toMatchObject({
      id: 'msg_uuid-system-1',
      type: 'system',
      text: 'compacted',
    });
    expect(response.cursor).toEqual({});
  });

  it('getSessionMessages 调用传入 includeSystemMessages: true（确保 system 消息不被过滤）', async () => {
    const getMessages = vi.fn(async () => storedMessages);
    const harness = createHarness({ getMessages });
    await createSession(harness);

    await harness.manager.messages('ses-1');

    expect(getMessages).toHaveBeenCalledWith('ses-1', {
      dir: '/tmp/project',
      limit: undefined,
      offset: 0,
      includeSystemMessages: true,
    });
  });

  it('limit + cursor 分页：返回最多 limit 条，cursor.next 编码 offset 可用于下一页', async () => {
    const all = Array.from({ length: 12 }, (_, i) => ({
      type: 'user' as const,
      uuid: `uuid-${i}`,
      session_id: 'ses-1',
      message: { role: 'user' as const, content: `msg ${i}` },
      parent_tool_use_id: null,
      parent_agent_id: null,
    }));
    const getMessages = vi.fn(async (_id: string, options?: GetSessionMessagesOptions) => {
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? all.length;
      return all.slice(offset, offset + limit);
    });
    const harness = createHarness({ getMessages });
    await createSession(harness);

    const page1 = await harness.manager.messages('ses-1', { limit: 10 });

    expect(page1.data).toHaveLength(10);
    expect(page1.cursor.next).toBe('offset:10');
    expect(page1.cursor.previous).toBeUndefined();
    expect(getMessages).toHaveBeenCalledWith('ses-1', {
      dir: '/tmp/project',
      limit: 11,
      offset: 0,
      includeSystemMessages: true,
    });

    const page2 = await harness.manager.messages('ses-1', { limit: 10, cursor: 'offset:10' });

    expect(page2.data).toHaveLength(2);
    expect(page2.cursor.next).toBeUndefined();
    expect(page2.cursor.previous).toBe('offset:0');
    expect(getMessages).toHaveBeenLastCalledWith('ses-1', {
      dir: '/tmp/project',
      limit: 11,
      offset: 10,
      includeSystemMessages: true,
    });
  });

  it('order: desc 反转消息顺序', async () => {
    const harness = createHarness({ getMessages: async () => storedMessages });
    await createSession(harness);

    const response = await harness.manager.messages('ses-1', { order: 'desc' });

    expect(response.data.map((m) => m.id)).toEqual([
      'msg_uuid-system-1',
      'msg_uuid-assistant-1',
      'msg_uuid-user-1',
    ]);
  });

  it('占位别名调用 messages() 时 getSessionMessagesFn 收到真实 session_id', async () => {
    const getMessages = vi.fn(async () => storedMessages);
    const harness = createHarness({ getMessages });
    const placeholder = await harness.manager.create({});

    const admitting = harness.manager.prompt(placeholder.id, createPromptInput('hello'));
    const pushed = await harness.fake.readInput();
    expect(pushed?.message.content).toBe('hello');
    harness.fake.pushMessage(initMessage('ses-real-1'));
    await admitting;

    await harness.manager.messages(placeholder.id);

    // 占位 id 是 ses_<uuid> 伪 id，须解析为真实 Claude session_id 再调 getSessionMessages。
    expect(getMessages).toHaveBeenCalledWith(
      'ses-real-1',
      expect.objectContaining({ dir: '/tmp/project', includeSystemMessages: true }),
    );
  });
});

describe('session.prompt（Send message）', () => {
  it('向该会话输入队列 push SDKUserMessage 并返回 SessionInputAdmitted', async () => {
    const harness = createHarness();
    await createSession(harness);

    const admitted: SessionInputAdmitted = await harness.manager.prompt(
      'ses-1',
      createPromptInput('hello'),
    );

    expect(admitted.sessionID).toBe('ses-1');
    expect(admitted.prompt).toEqual({ text: 'hello' });
    expect(admitted.delivery).toBe('queue');
    expect(admitted.id).toMatch(/^msg_/);
    expect(admitted.timeCreated).toBeTypeOf('string');
    // firstMessage 占用 seq 0，首个 prompt 从 1 起。
    expect(admitted.admittedSeq).toBe(1);

    const pushed = await harness.fake.readInput();
    expect(pushed).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      parent_tool_use_id: null,
    });
  });

  it('admittedSeq 在会话内自增', async () => {
    const harness = createHarness();
    await createSession(harness);

    expect((await harness.manager.prompt('ses-1', createPromptInput('first'))).admittedSeq).toBe(1);
    expect((await harness.manager.prompt('ses-1', createPromptInput('second'))).admittedSeq).toBe(2);
  });

  it('向不存在的会话发送消息抛 SessionNotFoundError', async () => {
    const harness = createHarness();

    await expect(
      harness.manager.prompt('ses-nonexistent', createPromptInput('hi')),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(
      harness.manager.prompt('ses-nonexistent', createPromptInput('hi')),
    ).rejects.toMatchObject({ _tag: 'SessionNotFoundError', sessionID: 'ses-nonexistent' });
  });
});

describe('session.interrupt（Interrupt session execution）', () => {
  it('对正在执行的会话调用 Query.interrupt()', async () => {
    const harness = createHarness();
    await createSession(harness);
    harness.fake.pushMessage(stateMessage('ses-1', 'running'));
    await flush();

    await harness.manager.interrupt('ses-1');

    expect(harness.fake.interrupt).toHaveBeenCalledTimes(1);
  });

  it('空闲会话 interrupt 为 no-op（不调用 Query.interrupt、不抛错）', async () => {
    const harness = createHarness();
    await createSession(harness);
    harness.fake.pushMessage(stateMessage('ses-1', 'idle'));
    await flush();

    await harness.manager.interrupt('ses-1');

    expect(harness.fake.interrupt).not.toHaveBeenCalled();
  });
});

describe('session.wait（Wait for session idle）', () => {
  it('会话空闲后 resolve', async () => {
    const harness = createHarness();
    await createSession(harness);

    const waiting = harness.manager.wait('ses-1', { timeout: 500 });
    harness.fake.pushMessage(stateMessage('ses-1', 'idle'));

    await expect(waiting).resolves.toBeUndefined();
  });

  it('收到 result 消息（回合结束）即视为空闲并 resolve', async () => {
    const harness = createHarness();
    await createSession(harness);

    const waiting = harness.manager.wait('ses-1', { timeout: 500 });
    harness.fake.pushMessage(resultMessage('ses-1'));

    await expect(waiting).resolves.toBeUndefined();
  });

  it('已空闲的会话立即 resolve', async () => {
    const harness = createHarness();
    await createSession(harness);
    harness.fake.pushMessage(stateMessage('ses-1', 'idle'));
    await flush();

    await expect(harness.manager.wait('ses-1', { timeout: 500 })).resolves.toBeUndefined();
  });

  it('超时未空闲则 reject 抛超时错误', async () => {
    const harness = createHarness();
    await createSession(harness);

    await expect(harness.manager.wait('ses-1', { timeout: 30 })).rejects.toMatchObject({
      _tag: 'TimeoutError',
    });
    await expect(harness.manager.wait('ses-1', { timeout: 30 })).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });
});

describe('session 状态管理与生命周期', () => {
  it('后台 Map 会话间状态隔离，并发会话互不影响', async () => {
    const harness = createHarness();
    await createSession(harness);
    const fakeA = harness.fakes[0];
    // 消费 A 的首条 firstMessage，避免干扰后续只读 A 的断言。
    const aFirst = await fakeA.readInput();
    expect(aFirst?.message.content).toBe('hello');

    const sessionBPromise = harness.manager.create({ firstMessage: 'hi' });
    const fakeB = harness.fakes[1];
    fakeB.pushMessage(initMessage('ses-2'));
    const sessionB = await sessionBPromise;
    await flush();

    expect(sessionB.id).toBe('ses-2');
    // 消费 B 的首条 firstMessage，使 B 输入队列保持为空以便验证隔离。
    const bFirst = await fakeB.readInput();
    expect(bFirst?.message.content).toBe('hi');
    fakeA.pushMessage(stateMessage('ses-1', 'running'));
    await flush();

    // 向会话 A 发送消息不影响 B：B 的输入队列保持为空。
    await harness.manager.prompt('ses-1', createPromptInput('only A'));
    const fromA = await fakeA.readInput();
    expect(fromA?.message.content).toBe('only A');

    let bDelivered = false;
    void fakeB.readInput().then(() => {
      bDelivered = true;
    });
    await flush();
    expect(bDelivered).toBe(false);

    // 清理
    harness.manager.close('ses-1');
    harness.manager.close('ses-2');
    await flush();
  });

  it('close() 关闭 Query、事件通道结束并从 Map 移除', async () => {
    const harness = createHarness();
    await createSession(harness);
    await flush();

    harness.manager.close('ses-1');

    expect(harness.fake.close).toHaveBeenCalledTimes(1);
    await expect(harness.manager.prompt('ses-1', createPromptInput('after close'))).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
    await expect(harness.manager.wait('ses-1', { timeout: 30 })).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it('create 启动超时后清理 SessionState（关闭 Query）', async () => {
    const harness = createHarness({ initTimeoutMs: 30 });

    await expect(harness.manager.create({ firstMessage: 'hi' })).rejects.toBeInstanceOf(TimeoutError);
    expect(harness.fakes[0].close).toHaveBeenCalledTimes(1);
  });

  it('query 流抛错时 wait() reject 该错误而非 resolve 为空闲', async () => {
    const harness = createHarness();
    await createSession(harness);

    const waiting = harness.manager.wait('ses-1', { timeout: 500 });
    // 先让 pump 消费 running 状态并挂起在 next() 上，再抛错，避免竞态。
    harness.fake.pushMessage(stateMessage('ses-1', 'running'));
    await flush();
    harness.fake.fail(new Error('query stream exploded'));

    await expect(waiting).rejects.toThrow('query stream exploded');
  });

  it('query 流自然结束时触发 onClose 并从 Map 清理会话', async () => {
    const harness = createHarness();
    await createSession(harness);
    await flush();

    harness.fake.end();
    await flush();
    await flush();

    await expect(harness.manager.prompt('ses-1', createPromptInput('after end'))).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });
});

describe('session.events（订阅会话事件流）', () => {
  it('events(sessionId) 返回该会话的事件通道（回放型，可订阅既有会话）', async () => {
    const harness = createHarness();
    await createSession(harness);

    const seen: string[] = [];
    const consumer = (async () => {
      for await (const message of harness.manager.events('ses-1')) {
        seen.push(message.type);
      }
    })();
    harness.fake.pushMessage(resultMessage('ses-1'));
    await flush();
    harness.manager.close('ses-1');
    await flush();
    await consumer;

    // 晚订阅仍回放 init 的 system 消息，随后跟结果消息。
    expect(seen).toEqual(['system', 'result']);
  });

  it('events(sessionId) 对不存在的会话抛 SessionNotFoundError', () => {
    const harness = createHarness();

    expect(() => harness.manager.events('ses-nonexistent')).toThrow(SessionNotFoundError);
  });
});

describe('SessionState 事件通道（内部）', () => {
  it('事件通道为回放型：晚订阅仍收到已发生的原始 SDKMessage', async () => {
    const { SessionState } = await import('../src/session-state');

    const fakes: FakeQuery[] = [];
    const state = new SessionState({
      cwd: '/tmp/project',
      queryFn: (params) => {
        const fake = new FakeQuery(params.prompt);
        fakes.push(fake);
        return fake;
      },
    });
    fakes[0].pushMessage(initMessage('ses-evt'));
    await state.waitForInit();

    // 晚订阅：回放已缓冲的 init，再跟随后续消息；close 后流正常终止。
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const message of state.events) {
        seen.push(message.type);
      }
    })();
    fakes[0].pushMessage(resultMessage('ses-evt'));
    await flush();
    state.close();
    await flush();
    await consumer;

    expect(seen).toEqual(['system', 'result']);
  });
});

// 确保 SessionMessagesOptions 等类型引用有效（编译期锚定）。
describe('类型导出', () => {
  it('SessionMessagesOptions 为可构造的类型', () => {
    const options: SessionMessagesOptions = { limit: 10, cursor: 'offset:5', order: 'asc' };
    expect(options).toEqual({ limit: 10, cursor: 'offset:5', order: 'asc' });
  });
});

// ---------------------------------------------------------------------------
// canUseTool 桥接：受限工具 → permission.asked/question.asked 事件 + respond 回复（design.md D2.1 扩展）
// ---------------------------------------------------------------------------

/** 触发 canUseTool 的最小 options（SDK CanUseTool 第三个参数结构子集）。 */
function toolContext(): { signal: AbortSignal; toolUseID: string; requestId: string } {
  return { signal: new AbortController().signal, toolUseID: 'tu_1', requestId: 'req_1' };
}

describe('canUseTool 桥接（权限/问题）', () => {
  it('启用桥接时注入 canUseTool，toolAuth disabled 时不注入', async () => {
    const h1 = createHarness();
    await createSession(h1);
    expect(h1.lastQueryOptions?.canUseTool).toBeDefined();

    const h2 = createHarness();
    const promise = h2.manager.create({ firstMessage: 'hi', toolAuth: 'disabled' });
    h2.fake.pushMessage(initMessage('ses-dis'));
    await promise;
    expect(h2.lastQueryOptions?.canUseTool).toBeUndefined();
  });

  it('受限工具触发 permission.asked，respondPermission once 放行并产出 permission.replied', async () => {
    const h = createHarness();
    const session = await createSession(h);
    const canUseTool = h.lastQueryOptions?.canUseTool;
    expect(canUseTool).toBeDefined();

    const events: GlobalEvent[] = [];
    void (async () => {
      for await (const e of h.manager.controlEvents(session.id)) {
        events.push(e);
      }
    })();

    const promise = canUseTool!('Bash', { command: 'ls' }, toolContext());
    await vi.waitFor(() => {
      expect(events.some((e) => e.payload.type === 'permission.asked')).toBe(true);
    });
    const asked = events.find((e) => e.payload.type === 'permission.asked');
    const props = asked?.payload.properties as Record<string, unknown>;
    const requestID = props.id as string;
    expect(requestID.startsWith('per_')).toBe(true);
    expect(props.sessionID).toBe(session.id);
    expect((props.permission as string).startsWith('Bash(')).toBe(true);

    h.manager.respondPermission(session.id, { requestID, reply: 'once' });
    const result = await promise;
    expect(result?.behavior).toBe('allow');
    await vi.waitFor(() => {
      expect(events.some((e) => e.payload.type === 'permission.replied')).toBe(true);
    });
    const replied = events.find((e) => e.payload.type === 'permission.replied');
    expect((replied?.payload.properties as Record<string, unknown>).reply).toBe('once');
  });

  it('respondPermission reject 拒绝工具（behavior deny）', async () => {
    const h = createHarness();
    const session = await createSession(h);
    const canUseTool = h.lastQueryOptions!.canUseTool!;

    const events: GlobalEvent[] = [];
    void (async () => {
      for await (const e of h.manager.controlEvents(session.id)) {
        events.push(e);
      }
    })();

    const promise = canUseTool('Write', { file_path: '/tmp/a.txt' }, toolContext());
    await vi.waitFor(() => {
      expect(events.some((e) => e.payload.type === 'permission.asked')).toBe(true);
    });
    const asked = events.find((e) => e.payload.type === 'permission.asked');
    const requestID = (asked?.payload.properties as Record<string, unknown>).id as string;
    h.manager.respondPermission(session.id, { requestID, reply: 'reject' });
    const result = await promise;
    expect(result?.behavior).toBe('deny');
  });

  it('AskUserQuestion 触发 question.asked，respondQuestion 返回答案', async () => {
    const h = createHarness();
    const session = await createSession(h);
    const canUseTool = h.lastQueryOptions!.canUseTool!;

    const events: GlobalEvent[] = [];
    void (async () => {
      for await (const e of h.manager.controlEvents(session.id)) {
        events.push(e);
      }
    })();

    const questions = [
      { question: 'Which format?', header: 'Format', options: [{ label: 'A' }, { label: 'B' }] },
    ];
    const promise = canUseTool('AskUserQuestion', { questions }, toolContext());
    await vi.waitFor(() => {
      expect(events.some((e) => e.payload.type === 'question.asked')).toBe(true);
    });
    const asked = events.find((e) => e.payload.type === 'question.asked');
    const props = asked?.payload.properties as Record<string, unknown>;
    const requestID = props.id as string;
    expect(requestID.startsWith('que_')).toBe(true);
    expect(props.sessionID).toBe(session.id);

    h.manager.respondQuestion(session.id, { requestID, answers: { 'Which format?': 'A' } });
    const result = await promise;
    expect(result?.behavior).toBe('allow');
    const updated = (result as { updatedInput?: unknown }).updatedInput as {
      answers: Record<string, unknown>;
    };
    expect(updated.answers).toEqual({ 'Which format?': 'A' });
    await vi.waitFor(() => {
      expect(events.some((e) => e.payload.type === 'question.replied')).toBe(true);
    });
  });

  it('close 时挂起的权限/问题请求被 reject（不悬挂 Promise）', async () => {
    const h = createHarness();
    const session = await createSession(h);
    const canUseTool = h.lastQueryOptions!.canUseTool!;

    const promise = canUseTool('Bash', { command: 'ls' }, toolContext());
    h.manager.close(session.id);
    await expect(promise).rejects.toThrow();
  });

  it('sessionEvents 合并控制事件与归一化事件：同流产出 permission.asked 与 session.created', async () => {
    const h = createHarness();
    const session = await createSession(h);
    const canUseTool = h.lastQueryOptions!.canUseTool!;
    const { GlobalEventManager } = await import('../src/events');
    const gem = new GlobalEventManager({ sessions: h.manager, cwd: '/tmp/project' });
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of gem.sessionEvents(session.id)) {
        seen.push(e.payload.type);
        if (e.payload.type === 'permission.asked') {
          const requestID = (e.payload.properties as Record<string, unknown>).id as string;
          h.manager.respondPermission(session.id, { requestID, reply: 'once' });
        }
      }
    })();
    // 触发一次权限申请（先于消费：回放通道保证事件不丢）。
    const p = canUseTool('Bash', { command: 'ls' }, toolContext());
    await p;
    h.manager.close(session.id);
    await consumer;
    expect(seen).toContain('session.created');
    expect(seen).toContain('permission.asked');
  });
});
