/**
 * 模型管理测试（test/model.test.ts）
 *
 * 覆盖 plan.json event-01 的 model.list() 验收口径：
 *   1. 返回 { location, data }，data 为 ModelV2Info[]（含 id/providerID/name/status）；
 *      location.directory 等于客户端 cwd
 *   2. 指定 { location: { directory } } 时返回其值
 *   3. 无会话时惰性初始化控制 Query（query({ prompt: 空 AsyncIterable, options: { cwd } })），
 *      复用其 supportedModels()，不 yield 用户消息
 *   4. ModelInfo→ModelV2Info 映射：value→id、displayName→name、providerID='anthropic'、
 *      status='active'
 *   5. resolvedModel 保留在 variants
 *   6. 控制 Query 缓存（重复 list() 复用）与 close() 关闭
 *
 * 测试沿用依赖注入惯例：ModelManager 注入 queryFn，以可控 FakeModelQuery 模拟 supportedModels()。
 */
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ModelManager } from '../src/model';
import type { QueryFactory, QueryLike } from '../src/session-state';
import type { ModelListResponse } from '../src/types';

// ---------------------------------------------------------------------------
// FakeModelQuery：可控的 QueryLike + supportedModels 实现
// ---------------------------------------------------------------------------

class FakeModelQuery implements QueryLike {
  /** 记录 close() 被调用的次数。 */
  readonly close = vi.fn(() => {});

  /** 记录 interrupt() 被调用的次数。 */
  readonly interrupt = vi.fn(async () => ({ still_queued: [] as string[] }));

  /** supportedModels 的可控实现（控制 Query 惰性创建，模型列表在构造时注入）。 */
  readonly supportedModels = vi.fn(
    async (): Promise<Array<Record<string, unknown>>> => this.models,
  );

  private readonly models: Array<Record<string, unknown>>;

  constructor(models?: Array<Record<string, unknown>>) {
    this.models = models ?? [];
  }

  next(): Promise<IteratorResult<SDKMessage, void>> {
    return Promise.resolve({ value: undefined, done: true });
  }

  return(): Promise<IteratorResult<SDKMessage, void>> {
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
// 测试夹具：创建注入 queryFn 的 ModelManager
// ---------------------------------------------------------------------------

interface ModelHarness {
  manager: ModelManager;
  fakes: FakeModelQuery[];
  get fake(): FakeModelQuery;
  lastParams: { prompt: AsyncIterable<SDKUserMessage>; options?: { cwd?: string } } | undefined;
}

function createHarness(options?: {
  cwd?: string;
  models?: Array<Record<string, unknown>>;
}): ModelHarness {
  const cwd = options?.cwd ?? '/projects/myapp';
  const models = options?.models;
  const fakes: FakeModelQuery[] = [];
  let lastParams: { prompt: AsyncIterable<SDKUserMessage>; options?: { cwd?: string } } | undefined;
  const queryFn: QueryFactory = (params) => {
    lastParams = params;
    const fake = new FakeModelQuery(models);
    fakes.push(fake);
    return fake;
  };
  const manager = new ModelManager({ cwd, queryFn });
  return {
    manager,
    fakes,
    get fake() {
      return fakes[fakes.length - 1] as FakeModelQuery;
    },
    get lastParams() {
      return lastParams;
    },
  };
}

/** 常见模型列表（含 resolvedModel 与不含两种情形）。 */
const sampleModels = [
  {
    value: 'sonnet',
    displayName: 'Claude Sonnet',
    description: 'Balanced intelligence and speed',
    resolvedModel: 'claude-sonnet-5',
  },
  {
    value: 'opus',
    displayName: 'Claude Opus',
    description: 'Maximum intelligence',
  },
];

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

describe('model.list（List models）', () => {
  it('返回 { location, data }，data 为 ModelV2Info 数组，location.directory 等于 cwd', async () => {
    const harness = createHarness({ models: sampleModels });

    const response: ModelListResponse = await harness.manager.list();

    expect(response.location.directory).toBe('/projects/myapp');
    expect(response.location.project.directory).toBe('/projects/myapp');
    expect(response.location.project.id).toBeTypeOf('string');
    expect(response.data).toHaveLength(2);
    expect(response.data[0]).toMatchObject({
      id: 'sonnet',
      providerID: 'anthropic',
      name: 'Claude Sonnet',
      status: 'active',
    });
    expect(response.data[1]).toMatchObject({
      id: 'opus',
      providerID: 'anthropic',
      name: 'Claude Opus',
      status: 'active',
    });
  });

  it('指定 { location: { directory } } 时返回其值', async () => {
    const harness = createHarness({ models: [] });

    const response = await harness.manager.list({ location: { directory: '/custom/path' } });

    expect(response.location.directory).toBe('/custom/path');
    expect(response.location.project.directory).toBe('/custom/path');
  });

  it('无会话时惰性初始化控制 Query（空 prompt + options.cwd），不 yield 用户消息', async () => {
    const harness = createHarness({ models: [] });

    await harness.manager.list();

    expect(harness.fakes).toHaveLength(1);
    expect(harness.lastParams?.options?.cwd).toBe('/projects/myapp');
    // 控制 Query 的 prompt 为永不产出的空 AsyncIterable：next() 立即 done，不产生对话轮次。
    const iterator = harness.lastParams!.prompt[Symbol.asyncIterator]();
    const next = await iterator.next();
    expect(next.done).toBe(true);
  });

  it('调用 supportedModels() 获取模型列表', async () => {
    const harness = createHarness({ models: sampleModels });

    await harness.manager.list();

    expect(harness.fake.supportedModels).toHaveBeenCalledTimes(1);
  });

  it('控制 Query 惰性缓存：重复 list() 复用同一 Query', async () => {
    const harness = createHarness({ models: [] });

    await harness.manager.list();
    await harness.manager.list();

    expect(harness.fakes).toHaveLength(1);
    expect(harness.fake.supportedModels).toHaveBeenCalledTimes(2);
  });

  it('close() 关闭缓存的控制 Query', async () => {
    const harness = createHarness({ models: [] });

    await harness.manager.list();
    harness.manager.close();

    expect(harness.fake.close).toHaveBeenCalledTimes(1);
  });
});

describe('ModelInfo → ModelV2Info 映射', () => {
  it('value→id、displayName→name、providerID=anthropic、status=active', async () => {
    const harness = createHarness({
      models: [{ value: 'sonnet', displayName: 'Claude Sonnet', description: 'desc' }],
    });

    const response = await harness.manager.list();

    expect(response.data).toHaveLength(1);
    expect(response.data[0]).toEqual({
      id: 'sonnet',
      providerID: 'anthropic',
      name: 'Claude Sonnet',
      status: 'active',
    });
  });

  it('含 resolvedModel 时保留在 variants 供消费者使用', async () => {
    const harness = createHarness({
      models: [
        {
          value: 'sonnet',
          displayName: 'Claude Sonnet',
          description: 'desc',
          resolvedModel: 'claude-sonnet-5',
        },
      ],
    });

    const response = await harness.manager.list();

    expect(response.data[0]!.variants).toBeDefined();
    expect(response.data[0]!.variants).toContainEqual({
      id: 'claude-sonnet-5',
      providerID: 'anthropic',
    });
  });

  it('无 resolvedModel 时 variants 缺省（不产出空数组）', async () => {
    const harness = createHarness({
      models: [{ value: 'opus', displayName: 'Claude Opus', description: 'desc' }],
    });

    const response = await harness.manager.list();

    expect(response.data[0]!.variants).toBeUndefined();
  });
});
