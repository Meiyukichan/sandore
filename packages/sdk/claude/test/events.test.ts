/**
 * 事件系统测试（test/events.test.ts）
 *
 * 覆盖 plan.json event-01 的归一化映射与事件流验收口径：
 *   1. init→session.created（properties 含 sessionID + info）
 *   2. text_delta→message.part.delta（field:'text'）
 *   3. input_json_delta→message.part.delta（field:'tool_input'）
 *   4. assistant 每个内容块→message.part.updated（part: TextPart|ToolPart）
 *   5. result success→session.next.step.ended（finish/cost/tokens）
 *   6. result error→session.error
 *   7. session_state_changed idle→session.idle
 *   8. 无对应类型的 SDKMessage 静默跳过
 *   9. GlobalEvent 信封结构（payload.id 以 evt_ 开头）
 *  10. sessionEvents：for await 消费、create 后订阅仍回放 session.created、流在最终事件后正常终止
 *  11. global.event：按 directory 过滤、省略时用客户端 cwd
 *
 * 测试沿用 session.test.ts 的依赖注入惯例：SessionManager 注入 queryFn（FakeQuery），
 * GlobalEventManager 直接订阅其事件通道。
 */
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

/**
 * BetaRawMessageStreamEvent 的测试别名：SDK 联合的内部类型（claude-agent-sdk 未公开导出），
 * 经 SDKPartialAssistantMessage.event 提取。
 */
type BetaRawMessageStreamEvent = Extract<SDKMessage, { type: 'stream_event' }>['event'];

import { GlobalEventManager } from '../src/events';
import { SessionManager } from '../src/session';
import type { QueryFactory, QueryLike, SessionQueryOptions } from '../src/session-state';
import type { GlobalEvent } from '../src/types';

// ---------------------------------------------------------------------------
// 测试工具：构造 SDKMessage（SDK 联合类型字段极多，仅关心子集，故集中断言）
// ---------------------------------------------------------------------------

/** 构造 system/init 消息（session.created 的事件源）。 */
function initMessage(sessionId: string, cwd: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    uuid: crypto.randomUUID(),
    cwd,
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

/** 构造 system/session_state_changed 消息（idle→session.idle）。 */
function stateMessage(sessionId: string, state: 'idle' | 'running' | 'requires_action'): SDKMessage {
  return {
    type: 'system',
    subtype: 'session_state_changed',
    state,
    session_id: sessionId,
    uuid: crypto.randomUUID(),
  } as unknown as SDKMessage;
}

/** 构造 stream_event 消息（text_delta / input_json_delta 等流式子事件）。 */
function streamEventMessage(
  sessionId: string,
  event: BetaRawMessageStreamEvent,
): SDKMessage {
  return {
    type: 'stream_event',
    event,
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  } as unknown as SDKMessage;
}

/** 构造 assistant 完整消息（message.part.updated 的事件源）；messageId 缺省时用 msg_01abc。 */
function assistantMessage(
  sessionId: string,
  content: Array<Record<string, unknown>>,
  messageId = 'msg_01abc',
): SDKMessage {
  return {
    type: 'assistant',
    message: {
      id: messageId,
      content,
      model: 'sonnet',
      stop_reason: 'end_turn',
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: sessionId,
    timestamp: '2026-08-12T00:00:00.000Z',
  } as unknown as SDKMessage;
}

/** 构造 result success 消息（session.next.step.ended 的事件源）。 */
function resultSuccessMessage(sessionId: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    stop_reason: 'end_turn',
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 0.05,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  } as unknown as SDKMessage;
}

/** 构造 result error 消息（session.error 的事件源）。 */
function resultErrorMessage(sessionId: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_max_turns',
    is_error: true,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 5,
    stop_reason: 'max_turns',
    total_cost_usd: 0.02,
    usage: { input_tokens: 100, output_tokens: 50 },
    modelUsage: {},
    permission_denials: [],
    errors: ['reached max turns'],
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  } as unknown as SDKMessage;
}

/** 构造无对应 GlobalEvent 的消息（如 hook_started），验证静默跳过。 */
function hookStartedMessage(sessionId: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'hook_started',
    hook_event_name: 'PreToolUse',
    hook_id: 'hook-1',
    tool_use_id: 'toolu_01',
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  } as unknown as SDKMessage;
}

/** 构造 user 消息（tool_result carrier）：content 含 tool_result 块（tool_use_id 关联），模拟真实 Claude 返回。 */
function userToolResultMessage(
  sessionId: string,
  toolUseId: string,
  content: string,
  isError: boolean,
): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError },
      ],
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  } as unknown as SDKMessage;
}

/** 刷新一次宏任务队列，让后台 query 泵的异步迭代推进。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** 消费 AsyncIterable<GlobalEvent> 直到流结束，返回全部事件。 */
async function collectEvents(
  iterable: AsyncIterable<GlobalEvent>,
): Promise<GlobalEvent[]> {
  const result: GlobalEvent[] = [];
  for await (const event of iterable) {
    result.push(event);
  }
  return result;
}

/**
 * 便捷：并发启动会话事件流消费（订阅在 push/end 之前注册，保证收到回放与终止信号），
 * push 消息后结束会话（query 自然终止），返回归一化后的全部事件。
 * 注意订阅必须早于 fake.end()：query 自然结束会触发 SessionManager 从 Map 清理会话，
 * 且事件通道关闭仅对已注册订阅者发送终止信号。
 */
async function readSessionEvents(
  harness: EventsHarness,
  push: (fake: FakeQuery) => void,
  sessionId = 'ses-1',
): Promise<GlobalEvent[]> {
  const seen: GlobalEvent[] = [];
  const consumer = (async () => {
    for await (const event of harness.events.sessionEvents(sessionId)) {
      seen.push(event);
    }
  })();
  push(harness.fake);
  await flush();
  harness.fake.end();
  await flush();
  await flush();
  await consumer;
  return seen;
}

// ---------------------------------------------------------------------------
// FakeQuery：可控的 QueryLike 实现（沿用 session.test.ts 的惯例）
// ---------------------------------------------------------------------------

class FakeQuery implements QueryLike {
  private readonly inputIterator: AsyncIterator<SDKUserMessage>;

  private readonly queue: SDKMessage[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<SDKMessage, void>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private ended = false;

  readonly interrupt = async () => ({ still_queued: [] as string[] });

  readonly close = () => {
    this.ended = true;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.resolve({ value: undefined, done: true });
  };

  constructor(prompt: AsyncIterable<SDKUserMessage>) {
    this.inputIterator = prompt[Symbol.asyncIterator]();
  }

  pushMessage(message: SDKMessage): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value: message, done: false });
      return;
    }
    this.queue.push(message);
  }

  end(): void {
    this.ended = true;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.resolve({ value: undefined, done: true });
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
// 测试夹具：创建注入 queryFn 的 SessionManager + GlobalEventManager
// ---------------------------------------------------------------------------

interface EventsHarness {
  manager: SessionManager;
  events: GlobalEventManager;
  fakes: FakeQuery[];
  cwd: string;
  get fake(): FakeQuery;
  get lastQueryOptions(): SessionQueryOptions | undefined;
}

function createHarness(options?: { cwd?: string }): EventsHarness {
  const cwd = options?.cwd ?? '/projects/myapp';
  const fakes: FakeQuery[] = [];
  let lastQueryOptions: SessionQueryOptions | undefined;
  const queryFn: QueryFactory = (params) => {
    lastQueryOptions = params.options;
    const fake = new FakeQuery(params.prompt);
    fakes.push(fake);
    return fake;
  };
  const manager = new SessionManager({ cwd, initTimeoutMs: 1000, queryFn });
  const events = new GlobalEventManager({ sessions: manager, cwd });
  return {
    manager,
    events,
    fakes,
    cwd,
    get fake() {
      return fakes[fakes.length - 1] as FakeQuery;
    },
    get lastQueryOptions() {
      return lastQueryOptions;
    },
  };
}

/** 创建会话并注册到 GlobalEventManager（回放 init 后 resolve）。 */
async function createSession(harness: EventsHarness, sessionId = 'ses-1'): Promise<void> {
  const promise = harness.manager.create({});
  harness.fake.pushMessage(initMessage(sessionId, harness.cwd));
  const session = await promise;
  harness.events.registerSession(session.id, session.location.directory);
}

// ---------------------------------------------------------------------------
// 归一化映射
// ---------------------------------------------------------------------------

describe('SDKMessage → GlobalEvent 归一化映射', () => {
  it('init → session.created：properties 含 sessionID + info，payload.id 以 evt_ 开头', async () => {
    const harness = createHarness();
    await createSession(harness);
    const seen = await readSessionEvents(harness, (fake) => {
      fake.pushMessage(stateMessage('ses-1', 'idle'));
    });

    const created = seen.find((ev) => ev.payload.type === 'session.created');
    expect(created).toBeDefined();
    expect(created!.payload.id).toMatch(/^evt_/);
    expect(created!.directory).toBe('/projects/myapp');
    expect(created!.payload.properties.sessionID).toBe('ses-1');
    const info = created!.payload.properties.info as Record<string, unknown>;
    expect(info.id).toBe('ses-1');
    expect((info.location as Record<string, unknown>).directory).toBe('/projects/myapp');
  });

  it('text_delta → message.part.delta：field 为 text，delta 为增量文本', async () => {
    const harness = createHarness();
    await createSession(harness);
    const seen = await readSessionEvents(harness, (fake) => {
      fake.pushMessage(
        streamEventMessage('ses-1', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hel' },
        }),
      );
    });

    const delta = seen.find((ev) => ev.payload.type === 'message.part.delta');
    expect(delta).toBeDefined();
    const props = delta!.payload.properties;
    expect(props.sessionID).toBe('ses-1');
    expect(props.field).toBe('text');
    expect(props.delta).toBe('hel');
    expect(props.messageID).toMatch(/^msg_/);
    expect(props.partID).toMatch(/^prt/);
  });

  it('message_start 捕获 messageID、content_block_start 捕获 partID（跨消息状态）', async () => {
    const harness = createHarness();
    await createSession(harness);
    const seen = await readSessionEvents(harness, (fake) => {
      fake.pushMessage(
        streamEventMessage(
          'ses-1',
          {
            type: 'message_start',
            message: { id: 'msg_01stream' },
          } as unknown as BetaRawMessageStreamEvent,
        ),
      );
      fake.pushMessage(
        streamEventMessage(
          'ses-1',
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '', citations: null },
          } as unknown as BetaRawMessageStreamEvent,
        ),
      );
      fake.pushMessage(
        streamEventMessage('ses-1', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hi' },
        }),
      );
    });

    const delta = seen.find((ev) => ev.payload.type === 'message.part.delta');
    const props = delta!.payload.properties;
    expect(props.messageID).toBe('msg_01stream');
    expect(props.partID).toBe('prt_0');
  });

  it('input_json_delta → message.part.delta：field 为 tool_input，delta 为 partial_json', async () => {
    const harness = createHarness();
    await createSession(harness);
    const seen = await readSessionEvents(harness, (fake) => {
      fake.pushMessage(
        streamEventMessage('ses-1', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"cmd":' },
        }),
      );
    });

    const delta = seen.find((ev) => ev.payload.type === 'message.part.delta');
    expect(delta).toBeDefined();
    expect(delta!.payload.properties.field).toBe('tool_input');
    expect(delta!.payload.properties.delta).toBe('{"cmd":');
  });

  it('assistant 每个内容块 → 一条 message.part.updated（part 为 TextPart）', async () => {
    const harness = createHarness();
    await createSession(harness);
    const seen = await readSessionEvents(harness, (fake) => {
      fake.pushMessage(
        assistantMessage('ses-1', [
          { type: 'text', text: 'hello there' },
          { type: 'text', text: 'second block' },
        ]),
      );
    });

    const updated = seen.filter((ev) => ev.payload.type === 'message.part.updated');
    expect(updated).toHaveLength(2);
    for (const ev of updated) {
      expect(ev.payload.properties.sessionID).toBe('ses-1');
      expect(typeof ev.payload.properties.time).toBe('number');
    }
    const part0 = updated[0]!.payload.properties.part as Record<string, unknown>;
    expect(part0.type).toBe('text');
    expect(part0.text).toBe('hello there');
    expect(part0.id).toMatch(/^prt/);
    expect(part0.messageID).toBe('msg_01abc');
    const part1 = updated[1]!.payload.properties.part as Record<string, unknown>;
    expect(part1.type).toBe('text');
    expect(part1.text).toBe('second block');
  });

  it('assistant tool_use → running 态 part；tool_result 更新为 completed 态（含 output，真实匹配 Claude 返回）', async () => {
    const harness = createHarness();
    await createSession(harness);
    const seen = await readSessionEvents(harness, (fake) => {
      // assistant 产出 tool_use → running 态 part。
      fake.pushMessage(
        assistantMessage('ses-1', [
          { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' } },
        ]),
      );
      // 后续 user 消息携带 tool_result（tool_use_id 匹配）→ 更新同 partID 为 completed + output。
      fake.pushMessage(
        userToolResultMessage('ses-1', 'toolu_01', 'file1.txt\nfile2.txt', false),
      );
    });

    const updated = seen.filter((ev) => ev.payload.type === 'message.part.updated');
    expect(updated).toHaveLength(2);
    // 第一条：running 态（input + title + time.start，无 output）。
    const runningPart = updated[0]!.payload.properties.part as Record<string, unknown>;
    expect(runningPart.type).toBe('tool');
    expect(runningPart.callID).toBe('toolu_01');
    expect(runningPart.tool).toBe('Bash');
    expect(runningPart.state).toMatchObject({ status: 'running', input: { command: 'ls' } });
    expect(runningPart.id).toMatch(/^prt/);
    // 第二条：completed 态（同 partID，含 output/title/time.end）。
    const completedPart = updated[1]!.payload.properties.part as Record<string, unknown>;
    expect(completedPart.id).toBe(runningPart.id);
    expect(completedPart.callID).toBe('toolu_01');
    expect(completedPart.tool).toBe('Bash');
    expect(completedPart.state).toMatchObject({
      status: 'completed',
      input: { command: 'ls' },
      output: 'file1.txt\nfile2.txt',
    });
    expect((completedPart.state as Record<string, unknown>).time).toMatchObject({ end: expect.any(Number) });
    // M1：工具入参移入 metadata（ToolPart schema additionalProperties:false，无 input 字段）。
    expect(runningPart.metadata).toEqual({ input: { command: 'ls' } });
    expect('input' in runningPart).toBe(false);
  });

  it('流式 delta 与 assistant 完整消息的 partID 一致（按 content 块序号关联，消费方可合并）', async () => {
    const harness = createHarness();
    await createSession(harness);
    const seen = await readSessionEvents(harness, (fake) => {
      fake.pushMessage(
        streamEventMessage(
          'ses-1',
          {
            type: 'message_start',
            message: { id: 'msg_01' },
          } as unknown as BetaRawMessageStreamEvent,
        ),
      );
      fake.pushMessage(
        streamEventMessage(
          'ses-1',
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '', citations: null },
          } as unknown as BetaRawMessageStreamEvent,
        ),
      );
      fake.pushMessage(
        streamEventMessage('ses-1', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello ' },
        }),
      );
      fake.pushMessage(
        streamEventMessage(
          'ses-1',
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {} },
          } as unknown as BetaRawMessageStreamEvent,
        ),
      );
      fake.pushMessage(
        streamEventMessage('ses-1', {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"cmd":' },
        }),
      );
      fake.pushMessage(
        assistantMessage(
          'ses-1',
          [
            { type: 'text', text: 'hello there' },
            { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' } },
          ],
          'msg_01',
        ),
      );
    });

    const deltas = seen.filter((ev) => ev.payload.type === 'message.part.delta');
    const updated = seen.filter((ev) => ev.payload.type === 'message.part.updated');
    expect(deltas).toHaveLength(2);
    expect(updated).toHaveLength(2);

    const textDelta = deltas[0]!.payload.properties;
    const toolDelta = deltas[1]!.payload.properties;
    const textPart = updated[0]!.payload.properties.part as Record<string, unknown>;
    const toolPart = updated[1]!.payload.properties.part as Record<string, unknown>;

    // delta 的 partID 与 updated 的 part.id 一致：消费方以 partID 为键累积 delta，收 updated 后合并。
    expect(textDelta.partID).toBe('prt_0');
    expect(textPart.id).toBe('prt_0');
    expect(toolDelta.partID).toBe('prt_1');
    expect(toolPart.id).toBe('prt_1');
    // messageID 也一致（message_start 与 assistant message 同源）。
    expect(textDelta.messageID).toBe('msg_01');
    expect(textPart.messageID).toBe('msg_01');
    expect(toolDelta.messageID).toBe('msg_01');
    expect(toolPart.messageID).toBe('msg_01');
  });

  it('result success → session.next.step.ended：properties 含 sessionID/finish/cost/tokens', async () => {
    const harness = createHarness();
    await createSession(harness);
    const seen = await readSessionEvents(harness, (fake) => {
      fake.pushMessage(resultSuccessMessage('ses-1'));
    });

    const ended = seen.find((ev) => ev.payload.type === 'session.next.step.ended');
    expect(ended).toBeDefined();
    const props = ended!.payload.properties;
    expect(props.sessionID).toBe('ses-1');
    expect(props.finish).toBe('end_turn');
    expect(props.cost).toBe(0.05);
    expect(props.tokens).toMatchObject({
      input: 100,
      output: 50,
      cache: { read: 20, write: 10 },
    });
  });

  it('result error → session.error：properties 含 sessionID + error', async () => {
    const harness = createHarness();
    await createSession(harness);
    const seen = await readSessionEvents(harness, (fake) => {
      fake.pushMessage(resultErrorMessage('ses-1'));
    });

    const errorEvent = seen.find((ev) => ev.payload.type === 'session.error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.payload.properties.sessionID).toBe('ses-1');
    expect(errorEvent!.payload.properties.error).toBeDefined();
  });

  it('session_state_changed idle → session.idle（properties 仅含 sessionID）', async () => {
    const harness = createHarness();
    await createSession(harness);
    const seen = await readSessionEvents(harness, (fake) => {
      fake.pushMessage(stateMessage('ses-1', 'idle'));
    });

    const idle = seen.find((ev) => ev.payload.type === 'session.idle');
    expect(idle).toBeDefined();
    expect(idle!.payload.properties).toEqual({ sessionID: 'ses-1' });
  });

  it('session_state_changed running / requires_action 无对应事件，静默跳过', async () => {
    const harness = createHarness();
    await createSession(harness);
    const seen = await readSessionEvents(harness, (fake) => {
      fake.pushMessage(stateMessage('ses-1', 'running'));
      fake.pushMessage(stateMessage('ses-1', 'requires_action'));
    });

    const types = seen.map((ev) => ev.payload.type);
    expect(types).toContain('session.created');
    expect(types).not.toContain('session.idle');
  });

  it('无对应类型的 SDKMessage（hook_started / status 等）静默跳过不产出事件', async () => {
    const harness = createHarness();
    await createSession(harness);
    const seen = await readSessionEvents(harness, (fake) => {
      fake.pushMessage(hookStartedMessage('ses-1'));
    });

    // 只回放 init 的 session.created；hook_started 不产出任何事件。
    expect(seen).toHaveLength(1);
    expect(seen[0]!.payload.type).toBe('session.created');
  });

  it('每个 GlobalEvent 符合信封结构：{directory?, payload:{id,type,properties}}', async () => {
    const harness = createHarness();
    await createSession(harness);
    const seen = await readSessionEvents(harness, (fake) => {
      fake.pushMessage(stateMessage('ses-1', 'idle'));
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const ev of seen) {
      expect(ev).toHaveProperty('payload');
      expect(ev.payload).toHaveProperty('id');
      expect(ev.payload).toHaveProperty('type');
      expect(ev.payload).toHaveProperty('properties');
      expect(ev.payload.id).toMatch(/^evt_/);
      expect(typeof ev.payload.type).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// 会话事件流（sessionEvents）
// ---------------------------------------------------------------------------

describe('sessionEvents（会话事件流）', () => {
  it('返回 AsyncIterable<GlobalEvent>，可 for await...of 消费', async () => {
    const harness = createHarness();
    await createSession(harness);
    const seen = await readSessionEvents(harness, (fake) => {
      fake.pushMessage(stateMessage('ses-1', 'idle'));
    });

    expect(seen.map((ev) => ev.payload.type)).toEqual([
      'session.created',
      'session.idle',
    ]);
  });

  it('create() 之后订阅仍收到已回放的 session.created', async () => {
    const harness = createHarness();
    await createSession(harness);
    // init 已缓冲，晚订阅回放 session.created。
    const seen = await readSessionEvents(harness, (fake) => {
      fake.pushMessage(resultSuccessMessage('ses-1'));
    });

    expect(seen.map((ev) => ev.payload.type)).toEqual([
      'session.created',
      'session.next.step.ended',
    ]);
  });

  it('会话 query() 完成后事件流在产出最终事件后正常终止（AsyncIterable return）', async () => {
    const harness = createHarness();
    await createSession(harness);

    const seen: GlobalEvent[] = [];
    let done = false;
    const consumer = (async () => {
      for await (const ev of harness.events.sessionEvents('ses-1')) {
        seen.push(ev);
      }
      done = true;
    })();
    harness.fake.pushMessage(resultSuccessMessage('ses-1'));
    await flush();
    harness.fake.end();
    await flush();
    await flush();
    await consumer;

    expect(done).toBe(true);
    expect(seen.map((ev) => ev.payload.type)).toEqual([
      'session.created',
      'session.next.step.ended',
    ]);
  });

  it('对不存在的会话抛 SessionNotFoundError', () => {
    const harness = createHarness();

    expect(() => harness.events.sessionEvents('ses-nonexistent')).toThrow(/session not found/);
  });

  it('消息流挂起时控制事件（permission.asked）仍被消费（merge 并发拉取）', async () => {
    const harness = createHarness();
    await createSession(harness);
    const canUseTool = harness.lastQueryOptions?.canUseTool;
    expect(canUseTool).toBeDefined();

    const seen: GlobalEvent[] = [];
    const consumer = (async () => {
      for await (const ev of harness.events.sessionEvents('ses-1')) {
        seen.push(ev);
      }
    })();

    // 消息流无新消息（挂起），但控制事件应被独立消费——这是 mergeAsyncIterables 并发拉取的回归锁。
    // （顺序拉取会卡在消息流的 next() 上，永远不消费控制事件。）
    const promise = canUseTool!('Bash', { command: 'ls' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu_1',
      requestId: 'req_1',
    });
    await flush();
    await flush();
    const asked = seen.find((ev) => ev.payload.type === 'permission.asked');
    expect(asked).toBeDefined();
    const requestID = (asked!.payload.properties as Record<string, unknown>).id as string;
    harness.manager.respondPermission('ses-1', { requestID, reply: 'once' });
    await promise;
    await flush();
    harness.fake.end();
    await flush();
    await flush();
    await consumer;

    expect(seen.map((ev) => ev.payload.type)).toContain('permission.asked');
    expect(seen.map((ev) => ev.payload.type)).toContain('session.created');
    expect(seen.map((ev) => ev.payload.type)).toContain('permission.replied');
  });
});

// ---------------------------------------------------------------------------
// 全局事件流（global.event）
// ---------------------------------------------------------------------------

describe('global.event（全局事件流，按 directory 过滤）', () => {
  it('只产出匹配 directory 的事件且 GlobalEvent.directory 等于该值', async () => {
    const harness = createHarness();
    await createSession(harness, 'ses-1');

    const seen: GlobalEvent[] = [];
    const consumer = (async () => {
      for await (const ev of harness.events.global({ directory: '/projects/myapp' })) {
        seen.push(ev);
      }
    })();
    harness.fake.pushMessage(stateMessage('ses-1', 'idle'));
    await flush();
    harness.fake.end();
    await flush();
    await flush();
    harness.events.close();
    await flush();
    await consumer;

    expect(seen.length).toBeGreaterThan(0);
    for (const ev of seen) {
      expect(ev.directory).toBe('/projects/myapp');
    }
    expect(seen.map((ev) => ev.payload.type)).toEqual(['session.created', 'session.idle']);
  });

  it('不匹配 directory 的会话事件不被产出', async () => {
    const harness = createHarness();
    await createSession(harness, 'ses-1');

    const seen: GlobalEvent[] = [];
    const consumer = (async () => {
      for await (const ev of harness.events.global({ directory: '/projects/other' })) {
        seen.push(ev);
      }
    })();
    harness.fake.pushMessage(stateMessage('ses-1', 'idle'));
    await flush();
    harness.fake.end();
    await flush();
    await flush();
    harness.events.close();
    await flush();
    await consumer;

    expect(seen).toEqual([]);
  });

  it('省略 directory 时默认使用客户端 cwd 过滤', async () => {
    const harness = createHarness();
    await createSession(harness, 'ses-1');

    const seen: GlobalEvent[] = [];
    const consumer = (async () => {
      for await (const ev of harness.events.global()) {
        seen.push(ev);
      }
    })();
    harness.fake.pushMessage(stateMessage('ses-1', 'idle'));
    await flush();
    harness.fake.end();
    await flush();
    await flush();
    harness.events.close();
    await flush();
    await consumer;

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.directory).toBe('/projects/myapp');
  });

  it('两个不同 directory 的会话各自产出到对应全局视图', async () => {
    const harness = createHarness();
    await createSession(harness, 'ses-a');
    // 第二个会话使用不同 location.directory。
    const promise = harness.manager.create({ location: { directory: '/projects/other' } });
    harness.fake.pushMessage(initMessage('ses-b', '/projects/other'));
    const sessionB = await promise;
    harness.events.registerSession(sessionB.id, sessionB.location.directory);

    const seenA: GlobalEvent[] = [];
    const seenB: GlobalEvent[] = [];
    const consumerA = (async () => {
      for await (const ev of harness.events.global({ directory: '/projects/myapp' })) {
        seenA.push(ev);
      }
    })();
    const consumerB = (async () => {
      for await (const ev of harness.events.global({ directory: '/projects/other' })) {
        seenB.push(ev);
      }
    })();
    harness.fakes[0].pushMessage(stateMessage('ses-a', 'idle'));
    harness.fakes[1].pushMessage(resultSuccessMessage('ses-b'));
    await flush();
    harness.manager.close('ses-a');
    harness.manager.close('ses-b');
    await flush();
    harness.events.close();
    await flush();
    await consumerA;
    await consumerB;

    expect(seenA.map((ev) => ev.payload.type)).toEqual(['session.created', 'session.idle']);
    expect(seenB.map((ev) => ev.payload.type)).toEqual([
      'session.created',
      'session.next.step.ended',
    ]);
  });

  it('会话关闭后全局注册被清理：同 ID 重开会话可正常注册并投递事件', async () => {
    const harness = createHarness();
    await createSession(harness, 'ses-1');
    // 会话关闭（query 自然终止）：SessionManager 清理会话，feedGlobal 结束时应清理 directories/consuming。
    harness.fake.end();
    await flush();
    await flush();

    // 同 ID 重开会话并重新注册：若旧注册未清理，registerSession 的 consuming 守卫会跳过导致无投递。
    const promise = harness.manager.create({});
    harness.fake.pushMessage(initMessage('ses-1', harness.cwd));
    const session = await promise;
    harness.events.registerSession(session.id, session.location.directory);

    const seen: GlobalEvent[] = [];
    const consumer = (async () => {
      for await (const ev of harness.events.global({ directory: '/projects/myapp' })) {
        seen.push(ev);
      }
    })();
    harness.fake.pushMessage(stateMessage('ses-1', 'idle'));
    await flush();
    harness.fake.end();
    await flush();
    await flush();
    harness.events.close();
    await flush();
    await consumer;

    expect(seen.map((ev) => ev.payload.type)).toEqual(['session.created', 'session.idle']);
  });

  it('close 后全局通道 buffer 释放：晚订阅立即终止且不回放已缓冲事件', async () => {
    const harness = createHarness();
    await createSession(harness, 'ses-1');

    // 先消费一批事件，确认事件已进入全局通道。
    const seen: GlobalEvent[] = [];
    const consumer = (async () => {
      for await (const ev of harness.events.global({ directory: '/projects/myapp' })) {
        seen.push(ev);
      }
    })();
    harness.fake.pushMessage(stateMessage('ses-1', 'idle'));
    await flush();
    harness.fake.end();
    await flush();
    await flush();
    harness.events.close();
    await flush();
    await consumer;
    expect(seen.map((ev) => ev.payload.type)).toEqual(['session.created', 'session.idle']);

    // close 后 buffer 已释放：新订阅立即终止，不回放 close 前缓冲的事件。
    const seen2 = await collectEvents(harness.events.global({ directory: '/projects/myapp' }));
    expect(seen2).toEqual([]);
  });
});
