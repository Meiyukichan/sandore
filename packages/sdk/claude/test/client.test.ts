/**
 * 客户端工厂测试（test/client.test.ts）
 *
 * 覆盖 plan.json event-01 的 createClaudeClient({ cwd }) 验收口径：
 *   1. 返回含 session/model/global 三个命名空间的客户端对象，不启动 HTTP 服务器
 *   2. cwd 作为默认 directory（会话创建与全局事件过滤）
 *   3. client.session.create() 创建会话；client.session.events() 返回归一化 AsyncIterable<GlobalEvent>
 *   4. client.model.list() 返回 { location, data }，location.directory 等于客户端 cwd
 *   5. client.global.event() 省略 directory 时默认用客户端 cwd 过滤；指定 directory 时只产出匹配事件
 *   6. close() 关闭全部会话与控制 Query
 *
 * 测试沿用依赖注入惯例：createClaudeClient 注入 queryFn（FakeQuery）。
 */
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createClaudeClient } from '../src/client';
import type { QueryFactory, QueryLike, SessionQueryOptions } from '../src/session-state';
import type { GlobalEvent, SessionV2Info } from '../src/types';

// ---------------------------------------------------------------------------
// 测试工具：构造 SDKMessage
// ---------------------------------------------------------------------------

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

function stateMessage(sessionId: string, state: 'idle' | 'running'): SDKMessage {
  return {
    type: 'system',
    subtype: 'session_state_changed',
    state,
    session_id: sessionId,
    uuid: crypto.randomUUID(),
  } as unknown as SDKMessage;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// FakeQuery：可控的 QueryLike + supportedModels 实现（会话与控制 Query 共用）
// ---------------------------------------------------------------------------

class FakeQuery implements QueryLike {
  private readonly inputIterator: AsyncIterator<SDKUserMessage>;

  private readonly queue: SDKMessage[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<SDKMessage, void>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private ended = false;

  readonly interrupt = vi.fn(async () => ({ still_queued: [] as string[] }));
  readonly close = vi.fn(() => {
    this.ended = true;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.resolve({ value: undefined, done: true });
  });
  readonly supportedModels = vi.fn(
    async (): Promise<Array<Record<string, unknown>>> => this.models,
  );

  private readonly models: Array<Record<string, unknown>>;

  constructor(prompt: AsyncIterable<SDKUserMessage>, models?: Array<Record<string, unknown>>) {
    this.inputIterator = prompt[Symbol.asyncIterator]();
    this.models = models ?? [];
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
// 测试夹具：创建注入 queryFn 的客户端
// ---------------------------------------------------------------------------

interface ClientHarness {
  client: ReturnType<typeof createClaudeClient>;
  fakes: FakeQuery[];
  cwd: string;
  get fake(): FakeQuery;
  get lastQueryOptions(): SessionQueryOptions | undefined;
}

function createHarness(options?: {
  cwd?: string;
  models?: Array<Record<string, unknown>>;
}): ClientHarness {
  const cwd = options?.cwd ?? '/projects/myapp';
  const models = options?.models;
  const fakes: FakeQuery[] = [];
  let lastQueryOptions: SessionQueryOptions | undefined;
  const queryFn: QueryFactory = (params) => {
    lastQueryOptions = params.options;
    const fake = new FakeQuery(params.prompt, models);
    fakes.push(fake);
    return fake;
  };
  const client = createClaudeClient({ cwd, queryFn });
  return {
    client,
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

/** 通过 client.session.create 创建会话（提供 firstMessage，回放 init 后 resolve 真实 id）。 */
async function createClientSession(harness: ClientHarness, sessionId = 'ses-1'): Promise<SessionV2Info> {
  const promise = harness.client.session.create({ firstMessage: 'hello' });
  harness.fake.pushMessage(initMessage(sessionId, harness.cwd));
  return promise;
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

describe('createClaudeClient（客户端工厂）', () => {
  it('返回含 session/model/global 三个命名空间的客户端对象', () => {
    const harness = createHarness();

    expect(harness.client.session).toBeDefined();
    expect(harness.client.model).toBeDefined();
    expect(harness.client.global).toBeDefined();
    expect(typeof harness.client.session.create).toBe('function');
    expect(typeof harness.client.session.messages).toBe('function');
    expect(typeof harness.client.session.prompt).toBe('function');
    expect(typeof harness.client.session.interrupt).toBe('function');
    expect(typeof harness.client.session.wait).toBe('function');
    expect(typeof harness.client.session.events).toBe('function');
    expect(typeof harness.client.model.list).toBe('function');
    expect(typeof harness.client.global.event).toBe('function');
  });

  it('不启动任何 HTTP 服务器（客户端对象不含服务器/监听相关接口）', () => {
    const harness = createHarness();

    expect('listen' in harness.client).toBe(false);
    expect('server' in harness.client).toBe(false);
    expect(Object.keys(harness.client).sort()).toEqual(['close', 'global', 'model', 'session']);
  });

  it('cwd 作为默认 directory：会话创建与 query() options.cwd 均为 cwd', async () => {
    const harness = createHarness();

    const session = await createClientSession(harness);

    expect(session.location.directory).toBe('/projects/myapp');
    expect(harness.lastQueryOptions?.cwd).toBe('/projects/myapp');
    expect(harness.lastQueryOptions?.includePartialMessages).toBe(true);
  });

  it('close() 关闭全部会话事件流与控制 Query', async () => {
    const harness = createHarness({ models: [] });
    await createClientSession(harness);
    await harness.client.model.list();

    harness.client.close();

    // fakes[0] 为会话 query，fakes[1] 为控制 Query：close() 应关闭两者。
    expect(harness.fakes[0].close).toHaveBeenCalledTimes(1);
    expect(harness.fakes[1].close).toHaveBeenCalledTimes(1);
  });
});

describe('client.session（会话命名空间）', () => {
  it('create() 返回 SessionV2Info，events() 返回归一化 AsyncIterable<GlobalEvent>', async () => {
    const harness = createHarness();
    await createClientSession(harness);

    const seen: GlobalEvent[] = [];
    const consumer = (async () => {
      for await (const ev of harness.client.session.events('ses-1')) {
        seen.push(ev);
      }
    })();
    harness.fake.pushMessage(stateMessage('ses-1', 'idle'));
    await flush();
    harness.fake.end();
    await flush();
    await flush();
    await consumer;

    expect(seen.map((ev) => ev.payload.type)).toEqual(['session.created', 'session.idle']);
    expect(seen[0]!.payload.id).toMatch(/^evt_/);
  });

  it('create() 之后订阅 events() 仍收到回放的 session.created', async () => {
    const harness = createHarness();
    await createClientSession(harness);

    const seen: GlobalEvent[] = [];
    const consumer = (async () => {
      for await (const ev of harness.client.session.events('ses-1')) {
        seen.push(ev);
      }
    })();
    harness.fake.pushMessage(stateMessage('ses-1', 'idle'));
    await flush();
    harness.fake.end();
    await flush();
    await flush();
    await consumer;

    expect(seen[0]!.payload.type).toBe('session.created');
  });

  it('create 无 firstMessage（pending）→ prompt 触发 init 后 session.created 使用真实 session_id', async () => {
    const harness = createHarness();
    const placeholder = await harness.client.session.create({});
    expect(placeholder.id).toMatch(/^ses_/);

    // 首个 prompt 入队触发 init → 捕获真实 session_id。
    const admitting = harness.client.session.prompt(placeholder.id, { prompt: { text: 'hello' } });
    harness.fake.pushMessage(initMessage('ses-real-1', harness.cwd));
    const admitted = await admitting;
    expect(admitted.sessionID).toBe('ses-real-1');

    // 占位 id 与真实 id 均能订阅到归一化事件（回放 session.created）。
    const seenPlaceholder: GlobalEvent[] = [];
    const seenReal: GlobalEvent[] = [];
    const consumerPlaceholder = (async () => {
      for await (const ev of harness.client.session.events(placeholder.id)) {
        seenPlaceholder.push(ev);
      }
    })();
    const consumerReal = (async () => {
      for await (const ev of harness.client.session.events('ses-real-1')) {
        seenReal.push(ev);
      }
    })();
    harness.fake.pushMessage(stateMessage('ses-real-1', 'idle'));
    await flush();
    harness.fake.end();
    await flush();
    await flush();
    await consumerPlaceholder;
    await consumerReal;

    const createdPlaceholder = seenPlaceholder.find((ev) => ev.payload.type === 'session.created');
    expect(createdPlaceholder).toBeDefined();
    expect((createdPlaceholder!.payload.properties as { sessionID: string }).sessionID).toBe(
      'ses-real-1',
    );
    expect(createdPlaceholder!.directory).toBe('/projects/myapp');

    const createdReal = seenReal.find((ev) => ev.payload.type === 'session.created');
    expect(createdReal).toBeDefined();
    expect((createdReal!.payload.properties as { sessionID: string }).sessionID).toBe('ses-real-1');
    expect(createdReal!.directory).toBe('/projects/myapp');
  });
});

describe('client.model（模型命名空间）', () => {
  it('list() 返回 { location, data }，location.directory 等于客户端 cwd', async () => {
    const harness = createHarness({
      models: [{ value: 'sonnet', displayName: 'Claude Sonnet', description: 'desc' }],
    });

    const response = await harness.client.model.list();

    expect(response.location.directory).toBe('/projects/myapp');
    expect(response.data).toHaveLength(1);
    expect(response.data[0]).toMatchObject({
      id: 'sonnet',
      providerID: 'anthropic',
      name: 'Claude Sonnet',
      status: 'active',
    });
  });

  it('list() 无会话时惰性初始化控制 Query（D9），不启动会话 query', async () => {
    const harness = createHarness({ models: [] });

    await harness.client.model.list();

    // 只创建了控制 Query（fakes[0]），未创建任何会话。
    expect(harness.fakes).toHaveLength(1);
  });

  it('list({ location: { directory } }) 时返回指定 directory', async () => {
    const harness = createHarness({ models: [] });

    const response = await harness.client.model.list({ location: { directory: '/custom/path' } });

    expect(response.location.directory).toBe('/custom/path');
  });
});

describe('client.global（全局事件命名空间）', () => {
  it('event() 省略 directory 时默认用客户端 cwd 过滤', async () => {
    const harness = createHarness();
    await createClientSession(harness);

    const seen: GlobalEvent[] = [];
    const consumer = (async () => {
      for await (const ev of harness.client.global.event()) {
        seen.push(ev);
      }
    })();
    harness.fake.pushMessage(stateMessage('ses-1', 'idle'));
    await flush();
    harness.fake.end();
    await flush();
    await flush();
    harness.client.close();
    await flush();
    await consumer;

    expect(seen.length).toBeGreaterThan(0);
    for (const ev of seen) {
      expect(ev.directory).toBe('/projects/myapp');
    }
    expect(seen.map((ev) => ev.payload.type)).toEqual(['session.created', 'session.idle']);
  });

  it('event({ directory }) 只产出匹配该 directory 的事件', async () => {
    const harness = createHarness();
    await createClientSession(harness);

    const seen: GlobalEvent[] = [];
    const consumer = (async () => {
      for await (const ev of harness.client.global.event({ directory: '/projects/other' })) {
        seen.push(ev);
      }
    })();
    harness.fake.pushMessage(stateMessage('ses-1', 'idle'));
    await flush();
    harness.fake.end();
    await flush();
    await flush();
    harness.client.close();
    await flush();
    await consumer;

    expect(seen).toEqual([]);
  });
});
