/**
 * fork-session.ts（forkStepSessionMessages 持久化回退 + forkStepSubagent）的单元测试。
 *
 * 覆盖 `forkStepSessionMessages` 的会话机制核心：
 * - live 优先：源会话在 live store → 维持现有 `sessions.fork`（不重建）
 * - 持久化回退：live 无（子代理 settle 后 live store 已移除）→
 *   `sessionPersistence.inspect` 读完整事件 → 截到最后一个闭合 turn/end →
 *   `sessions.create(合成 id, { seed, meta })` 重建 fork 会话 → `deriveMessages()` 全量历史
 * - 降级：inspect 抛错 / persistence 无 inspect / sessions 未注册 / 无闭合 turn /
 *   空事件 / 空串 → undefined（调用方降级临时会话）
 *
 * 覆盖 `forkStepSubagent`（收尾真 fork）的 setup 注入：
 * - hostAgent 提供时：createAgent options 含 setup；setup 执行后 `composeFrom` 被调且
 *   第二参数 === hostAgent.ctx（对齐 DSH `applyChildComposition` 的 parentCtx 透传）
 * - hostAgent 缺省时：options 不含 setup（向后兼容）
 * - setup 与 seed/meta/agentOptions 共存不互相覆盖
 * @module @meiyukichan/dsh-sandore/microflow/src/fork-session.spec
 */
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

import { FakeAgent, FakeAgentRegistry } from '../tests/mocks/agents.ts';
import { FakeSessionStore } from '../tests/mocks/sessions.ts';
import type { FakeSessionEvent } from '../tests/mocks/sessions.ts';
import { forkStepSessionMessages, forkStepSubagent } from './fork-session.ts';

/** 组装 DSH 形状会话事件（持久化 inspect 的返回：type/seq/time/data 包络）。 */
function event(type: string, seq: number, data: unknown): FakeSessionEvent {
  return { type, seq, time: 0, data };
}

/** 一条闭合 turn 的完整事件流（turn/start + user + assistant + turn/end，seq 0-3）。 */
function closedTurnEvents(): FakeSessionEvent[] {
  return [
    event('turn/start', 0, { turn: 0 }),
    event('user/message', 1, { id: 'u1', content: [{ type: 'text', text: 'do it' }] }),
    event('assistant/message', 2, {
      turn: 0,
      step: 0,
      message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'closed output' }], source: { kind: 'model', provider: 'mock', model: 'mock' } },
    }),
    event('turn/end', 3, { turn: 0, reason: { kind: 'completed' } }),
  ];
}

/** 组装含未闭合尾部的事件流（seq 0-3 闭合 turn 0 + seq 4-5 未闭合 turn 1）。 */
function unclosedTailEvents(): FakeSessionEvent[] {
  return [
    ...closedTurnEvents(),
    event('turn/start', 4, { turn: 1 }),
    event('assistant/message', 5, {
      turn: 1,
      step: 0,
      message: { id: 'm5', role: 'assistant', content: [{ type: 'text', text: 'open output' }], source: { kind: 'model', provider: 'mock', model: 'mock' } },
    }),
  ];
}

describe('forkStepSessionMessages（fork-based 判断的会话机制核心）', () => {
  it('uses the live fork path when the source session is still in the live store (no rebuild)', async () => {
    const ctx = new Context();
    const sessions = new FakeSessionStore();
    const source = sessions.create('child-1');
    source.append('user/message', { id: 'u1', content: [{ type: 'text', text: 'do it' }] });
    source.append('assistant/message', {
      turn: 0,
      step: 0,
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'live output' }], source: { kind: 'model', provider: 'mock', model: 'mock' } },
    });
    ctx.provide('sessions', sessions);
    // live 命中时不应触发持久化回退（inspect 若被调说明实现错误）。
    let inspected = false;
    ctx.provide('sessionPersistence', { inspect: async () => { inspected = true; return { meta: {}, events: [] }; } });

    const fork = await forkStepSessionMessages(ctx, 'child-1');

    expect(inspected).toBe(false);
    expect(fork).toBeDefined();
    // fork 返回的会话 id（FakeSessionStore.fork 无 childSessionId → session-N）。
    expect(fork?.forkSessionId).toMatch(/^session-\d+$/);
    // deriveMessages 全量历史（user + assistant）。
    expect(fork?.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(fork?.messages[1]?.content).toEqual([{ type: 'text', text: 'live output' }]);
  });

  it('falls back to persistence: rebuilds a fork session from inspect events and derives the full history', async () => {
    const ctx = new Context();
    const sessions = new FakeSessionStore();
    ctx.provide('sessions', sessions);
    const persisted = closedTurnEvents();
    ctx.provide('sessionPersistence', { inspect: async () => ({ meta: { id: 'child-1' }, events: persisted }) });

    const fork = await forkStepSessionMessages(ctx, 'child-1');

    // 重建 fork 会话：合成 id 为纯 UUID（globalThis.crypto.randomUUID()）。
    expect(fork?.forkSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const recreated = sessions.get(fork!.forkSessionId);
    expect(recreated?.events).toEqual(persisted);
    // deriveMessages 全量历史（user + assistant 均来自持久化事件）。
    expect(fork?.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(fork?.messages[1]?.content).toEqual([{ type: 'text', text: 'closed output' }]);
  });

  it('falls back to persistence with an unclosed tail truncated to the last closed turn/end', async () => {
    const ctx = new Context();
    const sessions = new FakeSessionStore();
    ctx.provide('sessions', sessions);
    ctx.provide('sessionPersistence', { inspect: async () => ({ meta: {}, events: unclosedTailEvents() }) });

    const fork = await forkStepSessionMessages(ctx, 'child-1');

    expect(fork).toBeDefined();
    // seed 截到最后一个闭合 turn/end（seq 0-3）；未闭合 turn 1 的 assistant 不进历史。
    const recreated = sessions.get(fork!.forkSessionId);
    expect(recreated?.events.map(item => item.seq)).toEqual([0, 1, 2, 3]);
    expect(fork?.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(fork?.messages[1]?.content).toEqual([{ type: 'text', text: 'closed output' }]);
  });

  it('passes parentSession/isSeeded meta + inheritedEventCount when rebuilding the fork session from persistence', async () => {
    const ctx = new Context();
    const sessions = new FakeSessionStore();
    ctx.provide('sessions', sessions);
    ctx.provide('sessionPersistence', { inspect: async () => ({ meta: {}, events: closedTurnEvents() }) });

    const fork = await forkStepSessionMessages(ctx, 'child-1');
    expect(fork).toBeDefined();
    // 上游适配：meta 删 seedLength 改 isSeeded，前缀长度移到顶层 inheritedEventCount
    // （= 截断后 seed 数；parentSession = 源会话 id 供路由/反查）。
    expect(sessions.createCalls).toHaveLength(1);
    expect(sessions.createCalls[0]?.options?.meta).toEqual({ parentSession: 'child-1', isSeeded: true });
    expect(sessions.createCalls[0]?.options?.inheritedEventCount).toBe(4);
    // FakeSessionStore.create 的 seed 回放已验证；此处仅断言会话存在。
    expect(sessions.get(fork!.forkSessionId)?.events).toHaveLength(4);
  });

  it('returns undefined when the source has no closed turn at all (only an open turn)', async () => {
    const ctx = new Context();
    ctx.provide('sessions', new FakeSessionStore());
    ctx.provide('sessionPersistence', {
      inspect: async () => ({ meta: {}, events: [event('turn/start', 0, { turn: 0 }), event('assistant/message', 1, { turn: 0, step: 0, message: {} })] }),
    });

    const fork = await forkStepSessionMessages(ctx, 'child-1');

    // 无闭合 turn 可截 → 无法构造 balanced seed → 降级 undefined（不失败）。
    expect(fork).toBeUndefined();
  });

  it('returns undefined when persistence.inspect throws (degrade, no failure)', async () => {
    const ctx = new Context();
    ctx.provide('sessions', new FakeSessionStore());
    ctx.provide('sessionPersistence', { inspect: async () => { throw new Error('persist boom'); } });

    const fork = await forkStepSessionMessages(ctx, 'child-1');

    expect(fork).toBeUndefined();
  });

  it('returns undefined when persistence has no inspect method (optional service)', async () => {
    const ctx = new Context();
    ctx.provide('sessions', new FakeSessionStore());
    ctx.provide('sessionPersistence', {});

    const fork = await forkStepSessionMessages(ctx, 'child-1');

    expect(fork).toBeUndefined();
  });

  it('returns undefined when persistence.inspect returns an empty event list', async () => {
    const ctx = new Context();
    ctx.provide('sessions', new FakeSessionStore());
    ctx.provide('sessionPersistence', { inspect: async () => ({ meta: {}, events: [] }) });

    const fork = await forkStepSessionMessages(ctx, 'child-1');

    expect(fork).toBeUndefined();
  });

  it('returns undefined when the sessions service is not registered', async () => {
    const ctx = new Context();

    const fork = await forkStepSessionMessages(ctx, 'child-1');

    expect(fork).toBeUndefined();
  });

  it('returns undefined for an omitted or empty stepSessionId', async () => {
    const ctx = new Context();
    ctx.provide('sessions', new FakeSessionStore());

    expect(await forkStepSessionMessages(ctx, undefined)).toBeUndefined();
    expect(await forkStepSessionMessages(ctx, '')).toBeUndefined();
  });
});

describe('forkStepSubagent（收尾真 fork：hostAgent setup 注入 + preset 组合）', () => {
  it('passes a setup composing the host preset when hostAgent is provided (composeFrom parentCtx === hostAgent.ctx)', async () => {
    const registry = new FakeAgentRegistry();
    // 自定义 ctx 的宿主主代理：断言 composeFrom 第二参数 === hostAgent.ctx（可识别对象）。
    const hostAgentCtx = { marker: 'host-ctx' };
    const hostAgent = new FakeAgent('host-1', {}, undefined, hostAgentCtx);

    const result = await forkStepSubagent(new Context(), 'child-1', {
      hostAgentId: 'host-1',
      stepId: 'step-a',
      createAgent: options => registry.create(options),
      getEvents: async () => closedTurnEvents(),
      hostAgent,
    });

    expect(result).toBeDefined();
    // createAgent 收到的 options 含 setup（hostAgent 提供时必传）。
    expect(registry.createSetups).toHaveLength(1);
    expect(typeof registry.createSetups[0]).toBe('function');
    // setup 已在 create 时执行（对齐 DSH setupAndPublish 时序）——applyChildComposition
    // 生效：① composeFrom 被调一次，第二参数 === hostAgent.ctx（parentCtx 透传）；
    // ② delegation 运行时上下文声明已注册（name 'subagent:delegation'，order 经
    // getContextOrder('SUBAGENT_DELEGATION') 解析）。
    expect(registry.composeFromCalls).toHaveLength(1);
    expect(registry.composeFromCalls[0]?.parentCtx).toBe(hostAgentCtx);
    expect(registry.composeFromCalls[0]?.agentCtx).toBeDefined();
    expect(registry.systemPromptContexts).toHaveLength(1);
    expect(registry.systemPromptContexts[0]?.agentCtx).toBeDefined();
    expect(registry.systemPromptContexts[0]?.declaration).toEqual({
      name: 'subagent:delegation',
      order: 70,
      text: expect.stringContaining('You are a delegated subagent'),
    });
  });

  it('omits setup when hostAgent is not provided (backward compatible)', async () => {
    const registry = new FakeAgentRegistry();

    const result = await forkStepSubagent(new Context(), 'child-1', {
      hostAgentId: 'host-1',
      stepId: 'step-a',
      createAgent: options => registry.create(options),
      getEvents: async () => closedTurnEvents(),
    });

    // hostAgent 缺省：options 不含 setup（createSetups 记录 undefined），composeFrom 不被调。
    expect(result).toBeDefined();
    expect(registry.createSetups).toEqual([undefined]);
    expect(registry.composeFromCalls).toHaveLength(0);
  });

  it('keeps setup coexisting with seed/meta/agentOptions (no mutual overwrite)', async () => {
    const registry = new FakeAgentRegistry();
    const hostAgent = new FakeAgent('host-1');

    const result = await forkStepSubagent(new Context(), 'child-1', {
      hostAgentId: 'host-1',
      stepId: 'step-a',
      cwd: '/srv/app',
      createAgent: options => registry.create(options),
      // 含未闭合尾部的事件流：seed 截断到最后一个闭合 turn/end（seq 0-3）。
      getEvents: async () => unclosedTailEvents(),
      agentOptions: { provider: 'p', model: 'm' },
      hostAgent,
    });

    expect(result).toBeDefined();
    // setup 与 seed/meta/agentOptions 并存：seed 截断、meta、agentOptions 均不受 setup 注入影响。
    // 上游适配：meta 经上游 childSessionMeta 同语义实现生成（cwd/parentSession 显式覆盖、
    // isSeeded、origin、delegationDepth=宿主深度+1；无 preset 部署无 agentPreset）。
    expect(registry.createSeeds[0]).toHaveLength(4);
    expect(registry.createMetas[0]).toEqual({ cwd: '/srv/app', parentSession: 'host-1', isSeeded: true, origin: 'subagent', delegationDepth: 1 });
    expect(registry.createInheritedEventCounts[0]).toBe(4);
    expect(registry.createdAgents[0]?.options).toEqual({ provider: 'p', model: 'm' });
    // setup 同样就位并执行（composeFrom + delegation 上下文各记录 1 次）。
    expect(registry.createSetups[0]).toBeDefined();
    expect(registry.composeFromCalls).toHaveLength(1);
    expect(registry.systemPromptContexts).toHaveLength(1);
  });
});
