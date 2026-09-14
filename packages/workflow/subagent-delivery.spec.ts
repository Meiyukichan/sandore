/**
 * subagent-delivery.ts（createChildPromptDelivery）的单元测试：queue 符号通道
 * （HEAD `deliverPrompt` 6 参 / npm rc `queuePrompt` 5 参）解析与优先级、降级
 * followup（mock 兼容）、皆无抛可读错误、signal 缺省。
 * @module @meiyukichan/dsh-sandore/workflow/src/subagent-delivery.spec
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';

import { FakeAgent } from '../tests/mocks/agents.ts';
import { FakeSubagents } from '../tests/mocks/subagents.ts';
import { createChildPromptDelivery } from './subagent-delivery.ts';
import type { Agent, SubagentRuntime } from '../microflow/subagents';

/** 与上游一致的进程稳定符号键（同 subagent-delivery.ts）。 */
const DELIVER_PROMPT = Symbol.for('dsh.subagent.deliverPrompt');
const QUEUE_PROMPT = Symbol.for('dsh.subagent.queuePrompt');

/** 构造最小 parent Agent 桩。 */
function makeParent(): Agent {
  return new FakeAgent('host-1');
}

/**
 * 构造最小 SubagentRuntime 桩：仅实现接缝四方法（本 spec 不触发它们），
 * `extra` 以符号键附加 queue 投递方法 / followup 等。
 */
function makeRuntime(extra: Record<PropertyKey, unknown> = {}): SubagentRuntime {
  return {
    startContinuable: async () => ({ childId: 'child-0', messageId: 'msg-0' }),
    interrupt: () => {},
    listChildren: async () => [],
    start: async () => {
      throw new Error('not used');
    },
    ...extra,
  } as unknown as SubagentRuntime;
}

describe('createChildPromptDelivery（上游 followup 删除后的投递通道封装）', () => {
  it('prefers the HEAD deliverPrompt symbol and passes the queue mode as the last argument', async () => {
    const parent = makeParent();
    const signal = new AbortController().signal;
    const calls: Array<unknown[]> = [];
    const runtime = makeRuntime({
      [DELIVER_PROMPT]: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve('msg-head');
      },
    });

    const delivery = createChildPromptDelivery(runtime);
    const messageId = await delivery(parent, 'child-1', [{ type: 'text', text: 'hi' }], { kind: 'user' }, signal);

    // queue 投递：6 参分发（末位固定 'queue'——独立 FIFO 轮次语义），返回 inbox 消息 id。
    expect(messageId).toBe('msg-head');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([parent, 'child-1', [{ type: 'text', text: 'hi' }], { kind: 'user' }, signal, 'queue']);
  });

  it('invokes the HEAD symbol on the runtime receiver so this-bound implementations work', async () => {
    const parent = makeParent();
    const signal = new AbortController().signal;
    const seen: Array<unknown[]> = [];
    // DSH 真机实现体是 `this.requireContinuations().queuePrompt(…)`（
    // packages/subagent/subagent/src/index.ts）：桩必须**依赖 this**，箭头函数桩会把
    // 「符号方法被解下来裸调 → this === undefined」这个真机缺陷掩盖掉（真机表象：
    // gateway/internal `Cannot read properties of undefined (reading 'requireContinuations')`，
    // run 级 DiscussionInput 的定点发送全部失败）。`this.tail` 读取即绑定探针。
    const runtime = makeRuntime({
      tail: 'queue-token',
      [DELIVER_PROMPT](this: { tail: string }, ...args: unknown[]) {
        seen.push([...args, this.tail]);
        return Promise.resolve('msg-head');
      },
    });

    const delivery = createChildPromptDelivery(runtime);
    const messageId = await delivery(parent, 'child-1', [{ type: 'text', text: 'hi' }], { kind: 'user' }, signal);

    expect(messageId).toBe('msg-head');
    expect(seen).toHaveLength(1);
    // 6 参分发（末位 'queue'）+ 绑定探针尾项。
    expect(seen[0]?.[5]).toBe('queue');
    expect(seen[0]?.[6]).toBe('queue-token');
  });

  it('invokes the npm rc queuePrompt symbol on the runtime receiver too', async () => {
    const parent = makeParent();
    const signal = new AbortController().signal;
    const seen: Array<unknown[]> = [];
    const runtime = makeRuntime({
      tail: 'rc-token',
      [QUEUE_PROMPT](this: { tail: string }, ...args: unknown[]) {
        seen.push([...args, this.tail]);
        return Promise.resolve('msg-rc');
      },
    });

    const delivery = createChildPromptDelivery(runtime);
    const messageId = await delivery(parent, 'child-1', [{ type: 'text', text: 'hi' }], { kind: 'user' }, signal);

    expect(messageId).toBe('msg-rc');
    // 5 参分发 + 绑定探针尾项。
    expect(seen[0]?.[4]).toBe(signal);
    expect(seen[0]?.[5]).toBe('rc-token');
  });

  it('falls through to the npm rc queuePrompt symbol when the HEAD symbol is absent', async () => {
    const parent = makeParent();
    const signal = new AbortController().signal;
    const calls: Array<unknown[]> = [];
    const runtime = makeRuntime({
      [QUEUE_PROMPT]: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve('msg-rc');
      },
    });

    const messageId = await createChildPromptDelivery(runtime)(parent, 'child-2', [{ type: 'text', text: 'yo' }], { kind: 'user' }, signal);

    // 5 参 Queue 分发（无模式位，queueHostSubagentPrompt 的内联等价）。
    expect(messageId).toBe('msg-rc');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([parent, 'child-2', [{ type: 'text', text: 'yo' }], { kind: 'user' }, signal]);
  });

  it('prefers the HEAD symbol when both queue symbols are implemented', async () => {
    const runtime = makeRuntime({
      [DELIVER_PROMPT]: () => Promise.resolve('msg-head'),
      [QUEUE_PROMPT]: () => Promise.resolve('msg-rc'),
    });

    const messageId = await createChildPromptDelivery(runtime)(makeParent(), 'child-3', [] as ContentBlock[], { kind: 'user' }, new AbortController().signal);

    // 通道解析顺序：HEAD 符号优先（本地 dev 实例为 harness workspace 运行时）。
    expect(messageId).toBe('msg-head');
  });

  it('degrades to the legacy followup method for mocks/older hosts and defaults the signal', async () => {
    const parent = makeParent();
    const subagents = new FakeSubagents();

    // FakeSubagents 无 queue 符号 → 结构探测降级 followup（接缝已删除该接口方法）。
    const delivery = createChildPromptDelivery(subagents);
    const messageId = await delivery(parent, 'child-1', [{ type: 'text', text: 'resume' }], { kind: 'user' });

    expect(messageId).toMatch(/^msg-\d+$/);
    expect(subagents.followups).toHaveLength(1);
    expect(subagents.followups[0]?.parent).toBe(parent);
    expect(subagents.followups[0]?.childId).toBe('child-1');
    expect(subagents.followups[0]?.content).toEqual([{ type: 'text', text: 'resume' }]);
    // signal 缺省：降级通道收到 AbortSignal（旧接口 options.signal 非空契约）。
    expect(subagents.followups[0]?.options.source).toEqual({ kind: 'user' });
    expect(subagents.followups[0]?.options.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws a readable error at factory time when no channel exists', () => {
    // 无 queue 符号且无 followup：工厂期 fail loud（避免触发投递时才炸）。
    expect(() => createChildPromptDelivery(makeRuntime())).toThrow(
      'createChildPromptDelivery: no child prompt delivery channel available',
    );
  });
});
