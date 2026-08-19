/**
 * loop-manager.ts（LoopManager）的单元测试。
 *
 * 覆盖 4 位 hex ID 后缀与 strip 还原、活跃循环/迭代栈、嵌套 loopIteration 路径、
 * checkLoopBreak（maxIterations 硬上限 + breakCondition 两阶段评估 + loopMeta 写入）
 * 与循环迭代上下文注入（in-loop-turn/all-loop-turn env）。
 * @module @deepseek-ai/dsh-sandore-microflow/src/loop-manager.spec
 */
import { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';

import { FakeLlm, textChunks } from '../../workflow/tests/mocks/llm.ts';
import { FakeShell, successResult } from '../../workflow/tests/mocks/shell.ts';
import { FakeSubprocess } from '../../workflow/tests/mocks/subprocess.ts';
import { LoopManager } from './loop-manager.ts';
import type { LoopManagerConfig, LoopNode, LoopState } from './loop-manager.ts';

/** 组装 LoopManager 测试环境（注入 mock llm/shell/subprocess 与空循环状态）。 */
function harness(config: LoopManagerConfig = { defaultTimeoutMs: 60000 }): {
  ctx: Context;
  llm: FakeLlm;
  shell: FakeShell;
  subprocess: FakeSubprocess;
  state: LoopState;
  manager: LoopManager;
} {
  const ctx = new Context();
  const llm = new FakeLlm();
  const shell = new FakeShell();
  const subprocess = new FakeSubprocess();
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('shell', shell);
  ctx.provide('subprocess', subprocess);
  const state: LoopState = { activeLoopStack: [], activeLoopIterationStack: [] };
  return { ctx, llm, shell, subprocess, state, manager: new LoopManager(ctx, config, state) };
}

describe('LoopManager ID suffix', () => {
  it('generates a 4-hex suffix id', () => {
    const { manager } = harness();
    expect(manager.getActualStepId('step-abc')).toMatch(/^step-abc-[0-9a-f]{4}$/);
  });

  it('reuses the same suffix within one iteration and strips it back', () => {
    const { manager } = harness();
    const first = manager.getActualStepId('step-abc');
    const second = manager.getActualStepId('step-abc');
    expect(second).toBe(first);
    expect(manager.stripIdSuffix(first)).toBe('step-abc');
  });

  it('generates a new suffix after incrementing the iteration', () => {
    const { manager } = harness();
    manager.pushActiveLoop('loop-1', 5);
    const first = manager.getActualStepId('step-abc');
    manager.incrementLoopIteration();
    const second = manager.getActualStepId('step-abc');
    expect(second).not.toBe(first);
  });
});

describe('LoopManager iteration stacks', () => {
  it('builds a nested iteration path [1, 2] for nested loops', () => {
    const { manager } = harness();
    manager.pushActiveLoop('outer', 5);
    expect(manager.buildLoopIterationPath()).toEqual([1]);
    manager.pushActiveLoop('inner', 3);
    expect(manager.buildLoopIterationPath()).toEqual([1, 1]);
    manager.incrementLoopIteration();
    expect(manager.buildLoopIterationPath()).toEqual([1, 2]);
  });

  it('pops the iteration stack then the loop stack', () => {
    const { manager } = harness();
    manager.pushActiveLoop('loop-1', 5);
    expect(manager.activeLoopNodeId).toBe('loop-1');
    manager.popActiveLoop();
    expect(manager.activeLoopNodeId).toBeNull();
    expect(manager.buildLoopIterationPath()).toEqual([]);
  });

  it('returns loopTurn 0 and maxIterations 0 outside any loop', () => {
    const { manager } = harness();
    expect(manager.getLoopIterationContext()).toEqual({ loopTurn: 0, loopMaxIterations: 0 });
  });

  it('returns the current iteration and maxIterations inside a loop', () => {
    const { manager } = harness();
    manager.pushActiveLoop('loop-1', 5);
    manager.incrementLoopIteration();
    expect(manager.getLoopIterationContext()).toEqual({ loopTurn: 2, loopMaxIterations: 5 });
  });
});

describe('LoopManager checkLoopBreak', () => {
  it('breaks immediately at the hard maxIterations limit without AI evaluation', async () => {
    const { llm, manager } = harness();
    const node: LoopNode = { id: 'loop-1', loop: { maxIterations: 3 } };
    const outcome = await manager.checkLoopBreak(node, 3);
    expect(outcome.shouldBreak).toBe(true);
    expect(outcome.loopMeta).toBeUndefined();
    expect(llm.calls).toHaveLength(0);
  });

  it('breaks when an agent breakCondition evaluates shouldBreak true and writes loopMeta completed', async () => {
    const { llm, manager } = harness();
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('{"shouldBreak": true}');
    const node: LoopNode = {
      id: 'loop-1',
      loop: {
        maxIterations: 5,
        breakCondition: { type: 'agent', value: { promptText: 'check', providerId: 'p', modelId: 'm' } },
      },
    };

    const outcome = await manager.checkLoopBreak(node, 1, { input: 'in', output: 'out' });

    expect(outcome.shouldBreak).toBe(true);
    expect(outcome.loopMeta?.status).toBe('completed');
    expect(outcome.loopMeta?.result).toBe('{"shouldBreak": true}');
  });

  it('does not break when shouldBreak evaluates false', async () => {
    const { llm, manager } = harness();
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('{"shouldBreak": false}');
    const node: LoopNode = {
      id: 'loop-1',
      loop: {
        maxIterations: 5,
        breakCondition: { type: 'prompt', value: { promptText: 'check', providerId: 'p', modelId: 'm' } },
      },
    };

    const outcome = await manager.checkLoopBreak(node, 1, { input: 'in', output: 'out' });

    expect(outcome.shouldBreak).toBe(false);
  });

  it('breaks when a shell breakCondition stdout matches breakExpectation', async () => {
    const { shell, manager } = harness();
    shell.runHandler = async spec => successResult(spec, 'lint-clean');
    const node: LoopNode = {
      id: 'loop-1',
      loop: {
        maxIterations: 5,
        breakCondition: { type: 'shell', value: { command: 'check' } },
        breakExpectation: 'lint-clean',
      },
    };

    const outcome = await manager.checkLoopBreak(node, 1, { input: 'in', output: 'out' });

    expect(outcome.shouldBreak).toBe(true);
  });

  it('does not break a shell breakCondition without breakExpectation', async () => {
    const { shell, manager } = harness();
    shell.runHandler = async spec => successResult(spec, 'lint-clean');
    const node: LoopNode = {
      id: 'loop-1',
      loop: {
        maxIterations: 5,
        breakCondition: { type: 'shell', value: { command: 'check' } },
      },
    };

    const outcome = await manager.checkLoopBreak(node, 1, { input: 'in', output: 'out' });

    expect(outcome.shouldBreak).toBe(false);
    expect(outcome.loopMeta?.status).toBe('completed');
  });

  it('injects in-loop-turn and all-loop-turn into a shell breakCondition env', async () => {
    const { shell, manager } = harness();
    shell.runHandler = async spec => successResult(spec, 'x');
    manager.pushActiveLoop('loop-1', 5);
    const node: LoopNode = {
      id: 'loop-1',
      loop: {
        maxIterations: 5,
        breakCondition: { type: 'shell', value: { command: 'check ${in-loop-turn}' } },
        breakExpectation: 'x',
      },
    };

    await manager.checkLoopBreak(node, 1, { input: 'in', output: 'out' });

    // breakCondition 统一经 ctx.shell 执行（branch-evaluator 新实现），env 随请求携带。
    expect(shell.specs[0]?.env).toEqual({ 'in-loop-turn': '1', 'all-loop-turn': '5' });
  });
});
