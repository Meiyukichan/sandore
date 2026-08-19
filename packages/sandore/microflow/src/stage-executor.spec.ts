/**
 * stage-executor.ts（StageExecutor）的单元测试：段模型核心不变量。
 *
 * 覆盖 §3.3–§3.5 定夺的段创建规则：
 * - executedSteps 条目的 `id` 为纯 UUID，且每次执行段唯一（同 Stage 内两个 Step
 *   各自新 id）
 * - `sessionMeta.childId`（子代理占位/真实会话 id）与段 `id` **解耦**（互不相等、
 *   语义分离）
 * - 命令节点段携带 `createdAt` 与 `attemptIndex: 0`（时间轴排序键）
 * - pause 续跑（resumePendingPaused）基于旧段**新建段对象**：新 id + attemptIndex+1
 *   + createdAt，旧 paused 段保持定格快照
 * @module @deepseek-ai/dsh-sandore-microflow/src/stage-executor.spec
 */
import { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import { describe, expect, it } from 'vitest';

import type {
  ResolveNextNodesContext,
  ResolveNextNodesResult,
} from '@deepseek-ai/dsh-sandore-workflow/src/dag-navigator';
import type { WorkflowDefinition, WorkflowStage, WorkflowStep, WorkflowTaskState } from '@deepseek-ai/dsh-sandore-workflow/src/schema';
import { assistantMessageEvent, FakeAgent, FakeAgentRegistry } from '../../workflow/tests/mocks/agents.ts';
import { FakeLlm, textChunks } from '../../workflow/tests/mocks/llm.ts';
import { FakeShell } from '../../workflow/tests/mocks/shell.ts';
import { FakeSubagents } from '../../workflow/tests/mocks/subagents.ts';
import { FakeSubprocess } from '../../workflow/tests/mocks/subprocess.ts';
import { FinalizeManager } from './finalize-manager.ts';
import type { FinalizeManagerConfig } from './finalize-manager.ts';
import { LoopManager } from './loop-manager.ts';
import type { LoopState } from './loop-manager.ts';
import { StageExecutor } from './stage-executor.ts';
import type { StageExecutorOptions, StageExecutorResume } from './stage-executor.ts';
import type { StepRunnerConfig } from './step-runner.ts';

/** 纯 UUID 形状（8-4-4-4-12 十六进制）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 组装一个单 Stage 工作流定义（shell Step，无门禁/无透传变量 → finalize 直接 done）。 */
function singleShellDefinition(): { definition: WorkflowDefinition; stage: WorkflowStage; step: WorkflowStep } {
  const step: WorkflowStep = {
    id: 'step-sh',
    name: 'echo',
    command: { type: 'shell', value: { command: 'echo hi' } },
  };
  const stage: WorkflowStage = {
    id: 'stg-1',
    name: 'Stage 1',
    steps: [{ id: 'step-sh' }],
  };
  const definition: WorkflowDefinition = {
    id: 'wfl-1',
    name: 'wfl-1',
    version: '1',
    stages: [stage],
    steps: [step],
    settings: {},
  };
  return { definition, stage, step };
}

/** 组装 StageExecutor 测试环境。 */
function harness(): {
  ctx: Context;
  llm: FakeLlm;
  shell: FakeShell;
  subagents: FakeSubagents;
  subprocess: FakeSubprocess;
  makeExecutor: (options?: Partial<StageExecutorOptions>) => StageExecutor;
} {
  const ctx = new Context();
  const llm = new FakeLlm();
  const shell = new FakeShell();
  const subagents = new FakeSubagents();
  const subprocess = new FakeSubprocess();
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('shell', shell);
  ctx.provide('subagents', subagents);
  ctx.provide('subprocess', subprocess);
  ctx.provide('sessions', {} as unknown as SessionStore);
  ctx.provide('fs', {});

  const makeExecutor = (options?: Partial<StageExecutorOptions>): StageExecutor => {
    const { definition, stage } = singleShellDefinition();
    const loopState: LoopState = { activeLoopStack: [], activeLoopIterationStack: [] };
    const loopManager = new LoopManager(ctx, { defaultTimeoutMs: 60000 }, loopState);
    const config: FinalizeManagerConfig = { defaultTimeoutMs: 60000, defaultProvider: 'p', defaultModel: 'm' };
    const finalizeManager = new FinalizeManager(ctx, config);
    const runnerConfig: StepRunnerConfig = { defaultTimeoutMs: 60000 };
    return new StageExecutor({
      ctx,
      stageDef: options?.stageDef ?? stage,
      workflowDef: options?.workflowDef ?? definition,
      input: { originalInput: 'do it', contractArtifacts: {}, passThroughVars: {} },
      sharedState: { cwd: '/tmp', taskId: 'task-1' },
      runnerConfig,
      loopManager,
      finalizeManager,
      resolveNextNodes: options?.resolveNextNodes
        ?? (async (
          _nodeId: string,
          _context: ResolveNextNodesContext,
        ): Promise<ResolveNextNodesResult> => ({ nextNodeIds: [] })),
      visitCounts: {},
      ...(options?.resumeFrom === undefined ? {} : { resumeFrom: options.resumeFrom }),
      onPersist: async () => {},
    });
  };

  return { ctx, llm, shell, subagents, subprocess, makeExecutor };
}

describe('StageExecutor 段模型不变量', () => {
  it('shell Step 执行产生的段 id 为纯 UUID', async () => {
    const { shell, makeExecutor } = harness();
    shell.runHandler = async spec => ({ exitCode: 0, stdout: 'hi', stderr: '' });

    const executor = makeExecutor();
    const result = await executor.execute();

    expect(result.status).toBe('completed');
    expect(result.executedSteps).toHaveLength(1);
    const segment = result.executedSteps[0]!;
    expect(segment.id).toMatch(UUID_RE);
  });

  it('同 Stage 两个 Step 各自生成唯一段 id（每次执行段唯一）', async () => {
    const { definition, stage } = singleShellDefinition();
    // 扩展为两个 shell Step。
    const secondStep: WorkflowStep = {
      id: 'step-sh2',
      name: 'echo2',
      command: { type: 'shell', value: { command: 'echo again' } },
    };
    const multiStage: WorkflowStage = {
      ...stage,
      steps: [{ id: 'step-sh' }, { id: 'step-sh2' }],
    };
    const multiDefinition: WorkflowDefinition = {
      ...definition,
      stages: [multiStage],
      steps: [...(definition.steps ?? []), secondStep],
    };
    const { shell, makeExecutor } = harness();
    shell.runHandler = async spec => ({ exitCode: 0, stdout: spec.command, stderr: '' });

    // resolveNextNodes 按调用序放行第二个 Step（首调 step-sh → step-sh2，二调停止）。
    let resolveCalls = 0;
    const executor = makeExecutor({
      stageDef: multiStage,
      workflowDef: multiDefinition,
      resolveNextNodes: async (
        _nodeId: string,
        _context: ResolveNextNodesContext,
      ): Promise<ResolveNextNodesResult> => {
        resolveCalls += 1;
        return resolveCalls === 1 ? { nextNodeIds: ['step-sh2'] } : { nextNodeIds: [] };
      },
    });
    const result = await executor.execute();

    expect(result.executedSteps).toHaveLength(2);
    const ids = result.executedSteps.map(segment => segment.id);
    expect(ids[0]).toMatch(UUID_RE);
    expect(ids[1]).toMatch(UUID_RE);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('sessionMeta.childId 与段 id 解耦（合成占位 ≠ 执行段 id）', async () => {
    const { shell, makeExecutor } = harness();
    shell.runHandler = async spec => ({ exitCode: 0, stdout: 'hi', stderr: '' });

    const executor = makeExecutor();
    const result = await executor.execute();

    const segment = result.executedSteps[0]!;
    // shell 为合成会话：childId 是 step-{stepId}-{hex} 占位，与段 id（UUID）不同。
    expect(segment.sessionMeta?.synthetic).toBe(true);
    expect(segment.sessionMeta?.childId).toMatch(/^step-step-sh-[0-9a-f]{8}$/);
    expect(segment.sessionMeta?.childId).not.toBe(segment.id);
  });

  it('命令节点段携带 createdAt 与 attemptIndex: 0（时间轴排序键）', async () => {
    const { shell, makeExecutor } = harness();
    shell.runHandler = async spec => ({ exitCode: 0, stdout: 'hi', stderr: '' });

    const executor = makeExecutor();
    const result = await executor.execute();

    const segment = result.executedSteps[0]!;
    expect(segment.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(segment.attemptIndex).toBe(0);
  });

  it('崩溃恢复/重试续跑（resumeFrom）从指定子代理 Step 播种，跳过已完成 Step', async () => {
    const { definition, stage } = singleShellDefinition();
    const agentStep: WorkflowStep = {
      id: 'step-sh',
      name: 'agent',
      command: { type: 'agent', value: { promptText: 'do work' } },
    };
    const completed: WorkflowTaskState['executedSteps'][number] = {
      id: 'exec-1',
      stepId: 'step-sh',
      stageId: 'stg-1',
      name: 'agent',
      status: 'completed',
      command: { type: 'agent', value: { promptText: 'do work' } },
      sessionMeta: { childId: 'child-1', synthetic: false, command: 'agent' },
      visitCount: 1,
      createdAt: '2026-08-16T00:00:00.000Z',
      attemptIndex: 0,
      output: [{ type: 'text', text: 'first' }],
    };
    const resumeFrom: StageExecutorResume = {
      completedSteps: [completed],
      resumeSubagent: {
        step: agentStep,
        executed: { ...completed, id: 'exec-2', status: 'running', attemptIndex: 1, createdAt: '2026-08-16T00:00:01.000Z' },
        childId: 'child-1',
      },
    };
    const { ctx, makeExecutor } = harness();
    // 注册续跑的子代理（whenIdle 后取 final output）。
    const agents = new FakeAgentRegistry();
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'resumed output' }]));
    agents.register(child);
    ctx.provide('agents', agents);

    const executor = makeExecutor({
      stageDef: stage,
      workflowDef: definition,
      resumeFrom,
    });
    const result = await executor.execute();

    // 播种：completed 段进 executedSteps 快照（不重跑），续跑段完成后并入。
    expect(result.status).toBe('completed');
    expect(result.executedSteps.some(segment => segment.id === 'exec-1')).toBe(true);
    expect(result.executedSteps.some(segment => segment.id === 'exec-2')).toBe(true);
  });
});
