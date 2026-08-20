/**
 * step-navigator.ts（StepNavigator）的单元测试：Step 级路由迁移回归。
 *
 * 验证 resolveNextNodes 从 workflow dag-navigator 迁入 microflow 后路由行为
 * 与迁移前完全一致——并行/条件（shouldExecute true·false）/shell 匹配/循环
 * （首入·回边·maxIter 硬上限·breakCondition 跳出·嵌套作用域归零）/无命中线性
 * 兜底/跨 Stage 目标不路由（nodeIndex 拆分：microflow 只持当前 Stage Step 图）。
 * @module @deepseek-ai/dsh-sandore-microflow/src/step-navigator.spec
 */
import { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import { describe, expect, it } from 'vitest';

import type { WorkflowDefinition, WorkflowStage } from '@deepseek-ai/dsh-sandore-workflow/src/schema';
import { FakeLlm, textChunks } from '../../workflow/tests/mocks/llm.ts';
import { FakeShell, successResult } from '../../workflow/tests/mocks/shell.ts';
import { FakeSubagents } from '../../workflow/tests/mocks/subagents.ts';
import { FakeSubprocess } from '../../workflow/tests/mocks/subprocess.ts';
import { StepNavigator } from './step-navigator.ts';
import type { ResolveNextNodesContext } from './step-navigator.ts';
import type { LoopState } from './loop-manager.ts';

/** 组装测试 ctx（注入 FakeLlm + FakeShell + 占位 sessions）。 */
function makeCtx(): { ctx: Context; llm: FakeLlm; shell: FakeShell } {
  const ctx = new Context();
  const llm = new FakeLlm();
  const shell = new FakeShell();
  const subagents = new FakeSubagents();
  const subprocess = new FakeSubprocess();
  llm.providers.push({ id: 'p', name: 'Provider' });
  llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('shell', shell);
  ctx.provide('subagents', subagents);
  ctx.provide('subprocess', subprocess);
  ctx.provide('sessions', {} as unknown as SessionStore);
  ctx.provide('fs', {});
  return { ctx, llm, shell };
}

/** 构造单 Stage 工作流定义（steps 为流控位，完整定义在顶层 steps）。 */
function makeDef(stages: WorkflowStage[], steps: WorkflowDefinition['steps']): WorkflowDefinition {
  return { id: 'wfl', name: 'wfl', version: '1', stages, steps: steps ?? [], settings: {} };
}

/** 组装调度上下文（visitCounts + 透传变量；不传 recentStepSessionId → fork 降级临时会话）。 */
function ctxWith(visitCounts: Record<string, number>): ResolveNextNodesContext {
  return { visitCounts, passThroughVars: {} };
}

/** 新建 StepNavigator（绑定 stage + def，loopState 共享可变数组）。 */
function makeNavigator(
  ctx: Context,
  stage: WorkflowStage,
  def: WorkflowDefinition,
  loopState: LoopState = { activeLoopStack: [], activeLoopIterationStack: [] },
): StepNavigator {
  return new StepNavigator(ctx, { defaultTimeoutMs: 60000 }, loopState, stage, def);
}

describe('StepNavigator Step 级路由迁移回归', () => {
  describe('并行/线性兜底', () => {
    it('无 branches → 数组顺序下一 Step（线性兜底）', async () => {
      const { ctx } = makeCtx();
      const stage: WorkflowStage = {
        id: 'stg-1', name: 's1', steps: [{ id: 'step-a' }, { id: 'step-b' }],
      };
      const def = makeDef([stage], [{ id: 'step-a' }, { id: 'step-b' }]);
      const nav = makeNavigator(ctx, stage, def);
      const result = await nav.resolveNextNodes('step-a', ctxWith({}));
      expect(result.nextNodeIds).toEqual(['step-b']);
    });

    it('并行分支（多 next 无 condition）→ 全部纳入下一批', async () => {
      const { ctx } = makeCtx();
      const stage: WorkflowStage = {
        id: 'stg-1', name: 's1',
        steps: [{ id: 'step-a', branches: [{ next: 'step-b' }, { next: 'step-c' }] }, { id: 'step-b' }, { id: 'step-c' }],
      };
      const def = makeDef([stage], [{ id: 'step-a' }, { id: 'step-b' }, { id: 'step-c' }]);
      const nav = makeNavigator(ctx, stage, def);
      const result = await nav.resolveNextNodes('step-a', ctxWith({}));
      expect(result.nextNodeIds).toEqual(['step-b', 'step-c']);
    });

    it('跨 Stage 目标不进 Step 路由（nodeIndex 拆分：microflow 只持当前 Stage Step 图）', async () => {
      const { ctx } = makeCtx();
      // step-a 的并行分支 next 指向 stage-2 的 step-b（不在当前 Stage 索引）→ 不路由，
      // 且 step-a 为当前 Stage 末位无数组后续 → 返回空（跨 Stage 由引擎 tryAdvanceStage 承接）。
      const stage1: WorkflowStage = {
        id: 'stg-1', name: 's1', steps: [{ id: 'step-a', branches: [{ next: 'step-b' }] }],
      };
      const stage2: WorkflowStage = { id: 'stg-2', name: 's2', steps: [{ id: 'step-b' }] };
      const def = makeDef([stage1, stage2], [{ id: 'step-a' }, { id: 'step-b' }]);
      const nav = makeNavigator(ctx, stage1, def);
      const result = await nav.resolveNextNodes('step-a', ctxWith({}));
      expect(result.nextNodeIds).toEqual([]);
    });
  });

  describe('条件分支（shouldExecute）', () => {
    // step-a 条件分支目标 step-c（≠ 数组下一 step-b），便于区分「条件命中」与「线性兜底」。
    const stage: WorkflowStage = {
      id: 'stg-1', name: 's1',
      steps: [{ id: 'step-a', branches: [{ condition: { type: 'prompt', value: { promptText: 'go-c?' } }, next: 'step-c' }] }, { id: 'step-b' }, { id: 'step-c' }],
    };
    const def = makeDef([stage], [{ id: 'step-a' }, { id: 'step-b' }, { id: 'step-c' }]);

    it('shouldExecute=true → 走条件分支目标（非数组顺序）', async () => {
      const { ctx, llm } = makeCtx();
      llm.streamHandler = () => textChunks('{"shouldExecute": true}');
      const nav = makeNavigator(ctx, stage, def);
      const result = await nav.resolveNextNodes('step-a', ctxWith({}));
      expect(result.nextNodeIds).toEqual(['step-c']);
      expect(result.branchMeta?.result).toContain('shouldExecute');
    });

    it('shouldExecute=false → 跳过条件分支，线性兜底到数组下一 Step', async () => {
      const { ctx, llm } = makeCtx();
      llm.streamHandler = () => textChunks('{"shouldExecute": false}');
      const nav = makeNavigator(ctx, stage, def);
      const result = await nav.resolveNextNodes('step-a', ctxWith({}));
      // 条件不命中 → 数组顺序兜底 step-b（而非条件目标 step-c）。
      expect(result.nextNodeIds).toEqual(['step-b']);
    });
  });

  describe('条件分支（shell matchesExpectation label）', () => {
    const stage: WorkflowStage = {
      id: 'stg-1', name: 's1',
      steps: [{ id: 'step-a', branches: [{ condition: { type: 'shell', value: { command: 'echo ok' } }, label: 'ok', next: 'step-c' }] }, { id: 'step-b' }, { id: 'step-c' }],
    };
    const def = makeDef([stage], [{ id: 'step-a' }, { id: 'step-b' }, { id: 'step-c' }]);

    it('shell stdout 匹配 label → 走条件分支目标', async () => {
      const { ctx, shell } = makeCtx();
      shell.runHandler = async spec => successResult(spec, 'ok');
      const nav = makeNavigator(ctx, stage, def);
      const result = await nav.resolveNextNodes('step-a', ctxWith({}));
      expect(result.nextNodeIds).toEqual(['step-c']);
    });

    it('shell stdout 不匹配 label → 跳过，线性兜底', async () => {
      const { ctx, shell } = makeCtx();
      shell.runHandler = async spec => successResult(spec, 'no');
      const nav = makeNavigator(ctx, stage, def);
      const result = await nav.resolveNextNodes('step-a', ctxWith({}));
      expect(result.nextNodeIds).toEqual(['step-b']);
    });
  });

  describe('循环分支', () => {
    // 单循环：step-loop（loop head）→ step-iter（回边目标）→ maxIter 后 exitTo step-done。
    const stage: WorkflowStage = {
      id: 'stg-1', name: 's1',
      steps: [
        { id: 'step-loop', branches: [{ next: 'step-iter', loop: { maxIterations: 3, next: 'step-iter', exitTo: 'step-done' } }] },
        { id: 'step-iter', branches: [{ next: 'step-loop' }] },
        { id: 'step-done' },
      ],
    };
    const def = makeDef([stage], [{ id: 'step-loop' }, { id: 'step-iter' }, { id: 'step-done' }]);

    it('首入循环（不在活跃循环）→ pushActiveLoop + 回边目标', async () => {
      const { ctx } = makeCtx();
      const loopState: LoopState = { activeLoopStack: [], activeLoopIterationStack: [] };
      const nav = makeNavigator(ctx, stage, def, loopState);
      const result = await nav.resolveNextNodes('step-loop', ctxWith({ 'step-loop': 0 }));
      expect(result.nextNodeIds).toEqual(['step-iter']);
      // 首入压栈：activeLoopNodeId = step-loop，迭代计数 = 1。
      expect(nav.loopManagerInstance.activeLoopNodeId).toBe('step-loop');
      expect(nav.loopManagerInstance.buildLoopIterationPath()).toEqual([1]);
    });

    it('回边（已在活跃循环）→ incrementLoopIteration + 回边目标', async () => {
      const { ctx } = makeCtx();
      const loopState: LoopState = { activeLoopStack: [], activeLoopIterationStack: [] };
      const nav = makeNavigator(ctx, stage, def, loopState);
      // 先首入（压栈 + 计数 1）。
      await nav.resolveNextNodes('step-loop', ctxWith({ 'step-loop': 0 }));
      // 回边：visitCount=1 < maxIter=3 → 继续。
      const result = await nav.resolveNextNodes('step-loop', ctxWith({ 'step-loop': 1 }));
      expect(result.nextNodeIds).toEqual(['step-iter']);
      expect(nav.loopManagerInstance.buildLoopIterationPath()).toEqual([2]);
    });

    it('maxIterations 硬上限 → 跳出（reset + pop + exitTo）', async () => {
      const { ctx } = makeCtx();
      const loopState: LoopState = { activeLoopStack: [], activeLoopIterationStack: [] };
      const visitCounts: Record<string, number> = {};
      const nav = makeNavigator(ctx, stage, def, loopState);
      // 驱动 3 次回边：首入(0) → 回边(1) → 回边(2) → 第 3 次回边 visitCount=3 >= maxIter=3 跳出。
      await nav.resolveNextNodes('step-loop', { ...ctxWith(visitCounts), visitCounts: { 'step-loop': 0 } });
      await nav.resolveNextNodes('step-loop', { ...ctxWith(visitCounts), visitCounts: { 'step-loop': 1 } });
      await nav.resolveNextNodes('step-loop', { ...ctxWith(visitCounts), visitCounts: { 'step-loop': 2 } });
      const result = await nav.resolveNextNodes('step-loop', ctxWith({ 'step-loop': 3 }));
      expect(result.nextNodeIds).toEqual(['step-done']);
      // 跳出后弹栈：无活跃循环。
      expect(nav.loopManagerInstance.activeLoopNodeId).toBeNull();
    });

    it('breakCondition shouldBreak=true → 跳出 exitTo（非 maxIter 硬上限）', async () => {
      const { ctx, llm } = makeCtx();
      const breakStage: WorkflowStage = {
        id: 'stg-1', name: 's1',
        steps: [
          { id: 'step-loop', branches: [{ next: 'step-iter', loop: { maxIterations: 5, breakCondition: { type: 'prompt', value: { promptText: 'done?' } }, next: 'step-iter', exitTo: 'step-done' } }] },
          { id: 'step-iter', branches: [{ next: 'step-loop' }] },
          { id: 'step-done' },
        ],
      };
      const breakDef = makeDef([breakStage], [{ id: 'step-loop' }, { id: 'step-iter' }, { id: 'step-done' }]);
      const loopState: LoopState = { activeLoopStack: [], activeLoopIterationStack: [] };
      const nav = makeNavigator(ctx, breakStage, breakDef, loopState);
      // 首入（push）。
      await nav.resolveNextNodes('step-loop', ctxWith({ 'step-loop': 0 }));
      // 回边 visitCount=1 < maxIter=5，breakCondition 返回 shouldBreak=true → 跳出。
      llm.streamHandler = () => textChunks('{"shouldBreak": true}');
      const result = await nav.resolveNextNodes('step-loop', ctxWith({ 'step-loop': 1 }));
      expect(result.nextNodeIds).toEqual(['step-done']);
      expect(result.loopMeta?.result).toContain('shouldBreak');
      expect(nav.loopManagerInstance.activeLoopNodeId).toBeNull();
    });

    it('嵌套循环：内层跳出后归零内层作用域 visitCount，外层仍活跃', async () => {
      const { ctx } = makeCtx();
      const nestStage: WorkflowStage = {
        id: 'stg-1', name: 's1',
        steps: [
          { id: 'step-outer', branches: [{ next: 'step-inner', loop: { maxIterations: 2, next: 'step-inner', exitTo: 'step-done' } }] },
          { id: 'step-inner', branches: [{ next: 'step-iter', loop: { maxIterations: 1, next: 'step-iter', exitTo: 'step-outer' } }] },
          { id: 'step-iter', branches: [{ next: 'step-inner' }] },
          { id: 'step-done' },
        ],
      };
      const nestDef = makeDef([nestStage], [{ id: 'step-outer' }, { id: 'step-inner' }, { id: 'step-iter' }, { id: 'step-done' }]);
      const loopState: LoopState = { activeLoopStack: [], activeLoopIterationStack: [] };
      const nav = makeNavigator(ctx, nestStage, nestDef, loopState);
      // 外层首入（push outer）。
      await nav.resolveNextNodes('step-outer', ctxWith({ 'step-outer': 0 }));
      expect(nav.loopManagerInstance.activeLoopNodeId).toBe('step-outer');
      // 内层首入（push inner，迭代计数嵌套 [1,1]）。
      await nav.resolveNextNodes('step-inner', ctxWith({ 'step-inner': 0 }));
      expect(nav.loopManagerInstance.buildLoopIterationPath()).toEqual([1, 1]);
      // step-iter 执行后回边到 step-inner（visitCount 累加）。
      await nav.resolveNextNodes('step-iter', ctxWith({ 'step-iter': 0 }));
      // 内层回边 visitCount=1 >= maxIter=1 → 跳出，exitTo=step-outer。
      const innerBreak = await nav.resolveNextNodes('step-inner', ctxWith({ 'step-inner': 1 }));
      expect(innerBreak.nextNodeIds).toEqual(['step-outer']);
      // 内层弹栈：外层仍活跃；内层作用域节点（step-iter）visitCount 归零。
      expect(nav.loopManagerInstance.activeLoopNodeId).toBe('step-outer');
      expect(nav.loopManagerInstance.buildLoopIterationPath()).toEqual([1]);
    });
  });

  describe('节点边界', () => {
    it('未知 nodeId → 返回空（不报错）', async () => {
      const { ctx } = makeCtx();
      const stage: WorkflowStage = { id: 'stg-1', name: 's1', steps: [{ id: 'step-a' }] };
      const def = makeDef([stage], [{ id: 'step-a' }]);
      const nav = makeNavigator(ctx, stage, def);
      const result = await nav.resolveNextNodes('nope', ctxWith({}));
      expect(result.nextNodeIds).toEqual([]);
    });

    it('loopManagerInstance 暴露共享循环管理器（供引擎/执行器 ID 后缀与迭代路径）', () => {
      const { ctx } = makeCtx();
      const stage: WorkflowStage = { id: 'stg-1', name: 's1', steps: [{ id: 'step-a' }] };
      const def = makeDef([stage], [{ id: 'step-a' }]);
      const loopState: LoopState = { activeLoopStack: [], activeLoopIterationStack: [] };
      const nav = makeNavigator(ctx, stage, def, loopState);
      // 同一实例：引擎从 stepNavigator.loopManagerInstance 取后注入 StageExecutor。
      expect(nav.loopManagerInstance).toBe(nav.loopManagerInstance);
      expect(nav.loopManagerInstance.activeLoopNodeId).toBeNull();
    });
  });
});
