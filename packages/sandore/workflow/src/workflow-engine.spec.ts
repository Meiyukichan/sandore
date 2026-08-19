/**
 * workflow-engine.ts（SandoreEngineRuntime）的集成测试：线性执行到 completed、
 * 事件序、双发可观测、childId/sessionMeta、失败/中止终态与持久化快照。
 * @module @deepseek-ai/dsh-sandore-workflow/src/workflow-engine.spec
 */
import { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { describe, expect, it } from 'vitest';

import { assistantMessageEvent, FakeAgent, FakeAgentRegistry } from '../tests/mocks/agents.ts';
import { FakeLlm, textChunks } from '../tests/mocks/llm.ts';
import { FakeSessionStore } from '../tests/mocks/sessions.ts';
import { FakeSessionTitle } from '../tests/mocks/session-title.ts';
import { FakeShell, successResult } from '../tests/mocks/shell.ts';
import { MemoryStorageDomain } from '../tests/mocks/storage-domain.ts';
import { FakeSubagents } from '../tests/mocks/subagents.ts';
import { FakeSubprocess } from '../tests/mocks/subprocess.ts';
import { FakeUserQuestions } from '../tests/mocks/user-questions.ts';
import { SandoreError } from './errors.ts';
import { SandoreEngineRuntime, SandoreEngineStub } from './index.ts';
import type { SandoreConfig, SandoreEngine, WorkflowTaskState } from './index.ts';
import { SandorePersistence } from './persistence.ts';
import type { ShellExecutor } from './shell.ts';
import { parseWorkflowYaml } from './yaml-parser.ts';

/** 两 Stage（shell → prompt）线性定义。 */
const linearYaml = `id: wfl-linear
name: linear
version: "1.0.0"
stages:
  - id: stg-1
    name: 分析
    steps:
      - id: step-abc
  - id: stg-2
    name: 推理
    steps:
      - id: step-prompt
steps:
  - id: step-abc
    command:
      type: shell
      value:
        command: "echo hello"
  - id: step-prompt
    command:
      type: prompt
      value:
        promptText: "summarize"
`;

/** 单 Stage 多 Step（A 输出被 B 引用）定义。 */
const multiStepYaml = `id: wfl-multi
name: multi
version: "1.0.0"
stages:
  - id: stg-1
    name: 处理
    steps:
      - id: step-a
      - id: step-b
steps:
  - id: step-a
    command:
      type: shell
      value:
        command: "echo hello"
    outputTo:
      - id: opt-a
        path: "out.txt"
  - id: step-b
    command:
      type: prompt
      value:
        promptText: "summarize"
    inputFrom:
      - id: in-a
        path: "step-a"
`;

/** 单 Stage 两个 shell Step（用于第二步失败断言）。 */
const twoShellYaml = `id: wfl-two-shell
name: two-shell
version: "1.0.0"
stages:
  - id: stg-1
    name: 处理
    steps:
      - id: step-a
      - id: step-b
steps:
  - id: step-a
    command:
      type: shell
      value:
        command: "echo ok"
  - id: step-b
    command:
      type: shell
      value:
        command: "false"
`;

/** 单 Stage 单 shell Step（用于崩溃恢复重跑：无需 llm 目录即可跑通）。 */
const shellOnlyYaml = `id: wfl-shell-only
name: shell-only
version: "1.0.0"
stages:
  - id: stg-1
    name: 单shell
    steps:
      - id: step-shell
steps:
  - id: step-shell
    command:
      type: shell
      value:
        command: "echo hi"
`;

/** 完整 DAG（分支 + 并行 + 汇合 + 循环 + 门禁 + 透传变量 + agent 子代理）。 */
const dagYaml = `id: wfl-dag
name: dag
version: "1.0.0"
stages:
  - id: stg-1
    name: 分支
    steps:
      - id: step-branch
        branches:
          - condition:
              type: prompt
              value:
                promptText: "route"
            next: step-agent
          - next: step-parallel
      - id: step-agent
        branches:
          - next: step-merge
      - id: step-parallel
        branches:
          - next: step-merge
      - id: step-fallback
        branches:
          - next: step-merge
      - id: step-merge
  - id: stg-2
    name: 循环
    steps:
      - id: step-loop
        branches:
          - next: step-iter
            loop:
              maxIterations: 3
              next: step-iter
              exitTo: step-finalize
      - id: step-iter
        branches:
          - next: step-loop
      - id: step-finalize
steps:
  - id: step-branch
  - id: step-agent
    command:
      type: agent
      value:
        promptText: "do-work"
  - id: step-parallel
    command:
      type: shell
      value:
        command: "echo parallel"
  - id: step-fallback
    command:
      type: shell
      value:
        command: "echo fallback"
  - id: step-merge
    command:
      type: shell
      value:
        command: "echo merge"
  - id: step-loop
  - id: step-iter
    command:
      type: shell
      value:
        command: "echo iter"
  - id: step-finalize
    command:
      type: prompt
      value:
        promptText: "report \${projectName}"
    passThroughVars:
      - name: projectName
        value: "\${projectName}"
        description: "项目名"
    gates:
      primary:
        enabled: true
`;

/** 分支无匹配（条件 false）→ 数组顺序兜底（用于验证兜底 + branchMeta 现场保留）。 */
const branchFallbackYaml = `id: wfl-branch-fallback
name: branch-fallback
version: "1.0.0"
stages:
  - id: stg-1
    name: 分支
    steps:
      - id: step-branch
        branches:
          - condition:
              type: prompt
              value:
                promptText: "route"
            next: step-matched
      - id: step-fallback
      - id: step-matched
        branches: []
steps:
  - id: step-branch
  - id: step-fallback
    command:
      type: shell
      value:
        command: "echo fallback"
  - id: step-matched
    command:
      type: shell
      value:
        command: "echo matched"
`;

/** 嵌套循环定义：外层 2 次 × 内层 2 次（用于验证内层 visitCount 重置）。 */
const nestedLoopYaml = `id: wfl-nested-loop
name: nested-loop
version: "1.0.0"
stages:
  - id: stg-1
    name: 嵌套循环
    steps:
      - id: step-outer-loop
        branches:
          - next: step-inner-loop
            loop:
              maxIterations: 2
              next: step-inner-loop
              exitTo: step-done
      - id: step-inner-loop
        branches:
          - next: step-iter
            loop:
              maxIterations: 2
              next: step-iter
              exitTo: step-outer-loop
      - id: step-iter
        branches:
          - next: step-inner-loop
      - id: step-done
steps:
  - id: step-outer-loop
  - id: step-inner-loop
  - id: step-iter
    command:
      type: shell
      value:
        command: "echo iter"
  - id: step-done
    command:
      type: shell
      value:
        command: "echo done"
`;

/** 带 breakCondition 的循环定义（prompt 判定跳出，验证 loopMeta 回写）。 */
const loopBreakYaml = `id: wfl-loop-break
name: loop-break
version: "1.0.0"
stages:
  - id: stg-1
    name: 循环跳出
    steps:
      - id: step-loop
        branches:
          - next: step-iter
            loop:
              maxIterations: 5
              breakCondition:
                type: prompt
                value:
                  promptText: "should we break?"
              next: step-iter
              exitTo: step-done
      - id: step-iter
        branches:
          - next: step-loop
      - id: step-done
steps:
  - id: step-loop
  - id: step-iter
    command:
      type: shell
      value:
        command: "echo iter"
  - id: step-done
    command:
      type: shell
      value:
        command: "echo done"
`;

/** 写入一条工作流定义记录。 */
async function putDefinition(persistence: SandorePersistence, id: string, yaml: string): Promise<void> {
  const definition = parseWorkflowYaml(yaml);
  const createdAt = new Date().toISOString();
  await persistence.definitions.put(id, {
    yaml,
    name: definition.name,
    version: definition.version,
    createdAt,
    updatedAt: createdAt,
  });
}

/** 组装一条已完成的实例状态快照（供 getState 兜底读回测试）。 */
function completedSnapshot(instanceId: string): WorkflowTaskState {
  const createdAt = new Date().toISOString();
  return {
    taskId: instanceId,
    workflowId: 'wfl-linear',
    cwd: '/tmp',
    status: 'completed',
    originalInput: 'hello world',
    currentStageId: 'stg-1',
    executedSteps: [{
      id: 'exec-1',
      stepId: 'step-abc',
      stageId: 'stg-1',
      name: 'step-abc',
      status: 'completed',
      visitCount: 1,
      output: [{ type: 'text', text: 'hello' }],
    }],
    stageInfos: [{ id: 'stg-1', name: '分析', status: 'completed' }],
    pendingInteractions: [],
    pendingQueue: [],
    visitCounts: {},
    passThroughVars: {},
    activeLoopIterationStack: [],
    activeLoopNodeId: null,
    activeLoopStack: [],
    pausedChildIds: [],
    stageContracts: {},
    createdAt,
    updatedAt: createdAt,
  };
}

/** 组装一条非终态（running）实例状态快照（供恢复扫描测试）。 */
function runningSnapshot(instanceId: string, workflowId = 'wfl-linear'): WorkflowTaskState {
  const createdAt = new Date().toISOString();
  return {
    taskId: instanceId,
    workflowId,
    cwd: '/tmp',
    status: 'running',
    originalInput: 'hello world',
    currentStageId: 'stg-1',
    executedSteps: [],
    stageInfos: [{ id: 'stg-1', name: '分析', status: 'running' }],
    pendingInteractions: [],
    pendingQueue: [],
    visitCounts: {},
    passThroughVars: {},
    activeLoopIterationStack: [],
    activeLoopNodeId: null,
    activeLoopStack: [],
    pausedChildIds: [],
    stageContracts: {},
    createdAt,
    updatedAt: createdAt,
  };
}

/** 单个已执行 Step 的快照类型。 */
type SnapshotStep = WorkflowTaskState['executedSteps'][number];

/** 构造一条 agent 子代理 Step 快照（running/paused 两态，供恢复分类测试）。 */
function agentStepSnapshot(status: 'running' | 'paused', childId = 'child-1'): SnapshotStep {
  const createdAt = new Date().toISOString();
  return {
    id: 'exec-1',
    stepId: 'step-agent',
    stageId: 'stg-1',
    name: 'step-agent',
    status,
    command: { type: 'agent', value: { promptText: 'do work' } },
    sessionMeta: { childId, synthetic: false, command: 'agent' },
    visitCount: 1,
    ...(status === 'paused' ? { pausedAt: createdAt } : {}),
  };
}

/** 构造一条 shell 合成 Step 快照（synthetic，供「合成 session 标 failed」测试）。 */
function shellStepSnapshot(status: 'running' = 'running'): SnapshotStep {
  return {
    id: 'exec-1',
    stepId: 'step-shell',
    stageId: 'stg-1',
    name: 'step-shell',
    status,
    command: { type: 'shell', value: { command: 'echo hi' } },
    sessionMeta: { childId: 'step-shell-synthetic', synthetic: true, command: 'shell' },
    visitCount: 1,
  };
}

/** 组装一条含单个指定 Step 的实例状态快照（status 决定 pausedChildIds 是否重建）。 */
function stepSnapshot(instanceId: string, workflowId: string, step: SnapshotStep, status: WorkflowTaskState['status']): WorkflowTaskState {
  const createdAt = new Date().toISOString();
  return {
    taskId: instanceId,
    workflowId,
    cwd: '/tmp',
    status,
    originalInput: 'do work',
    currentStageId: step.stageId,
    executedSteps: [step],
    stageInfos: [{ id: step.stageId, name: 'stage', status: status === 'completed' ? 'completed' : 'running' }],
    pendingInteractions: [],
    pendingQueue: [],
    visitCounts: {},
    passThroughVars: {},
    activeLoopIterationStack: [],
    activeLoopNodeId: null,
    activeLoopStack: [],
    pausedChildIds: status === 'paused' ? [step.sessionMeta?.childId ?? step.id] : [],
    stageContracts: {},
    createdAt,
    updatedAt: createdAt,
  };
}

/** 组装一条非终态（paused）实例状态快照（含 paused Step + pausedChildIds，供登记表重建测试）。 */
function pausedSnapshot(instanceId: string, workflowId = 'wfl-agent-fail'): WorkflowTaskState {
  return stepSnapshot(instanceId, workflowId, agentStepSnapshot('paused'), 'paused');
}

/** 组装集成测试 harness：注入内存 DSH 服务并加载引擎运行时。 */
async function harness(config: SandoreConfig = {}): Promise<{
  ctx: Context;
  engine: SandoreEngine;
  persistence: SandorePersistence;
  llm: FakeLlm;
  shell: FakeShell;
  sessions: FakeSessionStore;
  subagents: FakeSubagents;
  agents: FakeAgentRegistry;
  userQuestions: FakeUserQuestions;
  sessionTitle: FakeSessionTitle;
}> {
  const ctx = new Context();
  const storageDomain = new MemoryStorageDomain();
  ctx.provide('storageDomain', storageDomain as unknown as DomainFacility);
  await ctx.plugin(SandorePersistence);
  const persistence = ctx.sandorePersistence;

  const llm = new FakeLlm();
  const shell = new FakeShell();
  const sessions = new FakeSessionStore();
  const subagents = new FakeSubagents();
  const agents = new FakeAgentRegistry(sessions);
  const subprocess = new FakeSubprocess();
  const userQuestions = new FakeUserQuestions();
  const sessionTitle = new FakeSessionTitle();
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('shell', shell as unknown as ShellExecutor);
  ctx.provide('sessions', sessions as unknown as SessionStore);
  ctx.provide('sessionPersistence', {});
  ctx.provide('subagents', subagents);
  ctx.provide('agents', agents);
  ctx.provide('subprocess', subprocess);
  ctx.provide('userQuestions', userQuestions);
  ctx.provide('sessionTitle', sessionTitle);
  ctx.provide('fs', {});

  await ctx.plugin(SandoreEngineRuntime, config);
  const engine = ctx.sandoreEngine;
  return { ctx, engine, persistence, llm, shell, sessions, subagents, agents, userQuestions, sessionTitle };
}

/** 注册全部 sandore/* 监听器并记录事件（名称 + 参数）。 */
function recordSandoreEvents(ctx: Context): Array<{ name: string; args: unknown[] }> {
  const records: Array<{ name: string; args: unknown[] }> = [];
  ctx.on('sandore/start', info => records.push({ name: 'sandore/start', args: [info] }));
  ctx.on('sandore/stage-start', (info, stageId) => records.push({ name: 'sandore/stage-start', args: [info, stageId] }));
  ctx.on('sandore/stage-completed', (info, stageId, contract) => records.push({ name: 'sandore/stage-completed', args: [info, stageId, contract] }));
  ctx.on('sandore/step-start', (info, stepId, childId, name, loopIteration) => records.push({ name: 'sandore/step-start', args: [info, stepId, childId, name, loopIteration] }));
  ctx.on('sandore/step-completed', (info, stepId, childId, output, name, loopIteration) => records.push({ name: 'sandore/step-completed', args: [info, stepId, childId, output, name, loopIteration] }));
  ctx.on('sandore/step-failed', (info, stepId, childId, error, name, loopIteration) => records.push({ name: 'sandore/step-failed', args: [info, stepId, childId, error, name, loopIteration] }));
  ctx.on('sandore/end', (info, result) => records.push({ name: 'sandore/end', args: [info, result] }));
  ctx.on('sandore/aborted', info => records.push({ name: 'sandore/aborted', args: [info] }));
  return records;
}

/** 等待实例到达 completed/failed 终态（以 sandore/end 为信号）。 */
function waitForEnd(ctx: Context): Promise<void> {
  return new Promise<void>(resolve => {
    ctx.once('sandore/end', () => resolve());
  });
}

/** 段模型定位：同 stepId 取 attemptIndex 最大（最后）的执行段（重试/续跑后新段）。 */
function lastSegmentOf(
  steps: readonly SnapshotStep[],
  stepId: string,
): SnapshotStep | undefined {
  const matches = steps.filter(step => step.stepId === stepId);
  if (matches.length === 0) {
    return undefined;
  }
  return matches.sort((a, b) => (b.attemptIndex ?? 0) - (a.attemptIndex ?? 0))[0];
}

/** 等待实例到达 aborted 终态（以 sandore/aborted 为信号）。 */
function waitForAborted(ctx: Context): Promise<void> {
  return new Promise<void>(resolve => {
    ctx.once('sandore/aborted', () => resolve());
  });
}

/** 等待一次 step-start（用于确认 Step 已开始执行）。 */
function waitForStepStart(ctx: Context): Promise<void> {
  return new Promise<void>(resolve => {
    ctx.once('sandore/step-start', () => resolve());
  });
}

describe('SandoreEngineRuntime interface', () => {
  it('is the default export and keeps SandoreEngineStub as a named export', async () => {
    const { ctx } = await harness();
    expect(ctx.sandoreEngine).toBeInstanceOf(SandoreEngineRuntime);
    expect(SandoreEngineStub).toBeTypeOf('function');
  });

  it('declares agents, userQuestions, and sessionTitle in the seam inject list', () => {
    expect(SandoreEngineStub.inject).toContain('agents');
    expect(SandoreEngineStub.inject).toContain('userQuestions');
    expect(SandoreEngineStub.inject).toContain('sessionTitle');
    expect(SandoreEngineRuntime.inject).toContain('agents');
    expect(SandoreEngineRuntime.inject).toContain('userQuestions');
    expect(SandoreEngineRuntime.inject).toContain('sessionTitle');
  });

  it('routes recoverInstance and retryStep on unknown instances to NODE_NOT_FOUND (no longer not-implemented)', async () => {
    const { engine } = await harness();
    await expect(engine.recoverInstance('x')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
    await expect(engine.retryStep('x', 's', 'continue', 'm')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
  });

  it('throws NODE_NOT_FOUND for pause/resume on unknown instances', async () => {
    const { engine } = await harness();
    await expect(engine.pauseStep('x', 's')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
    await expect(engine.resumeStep('x', 's')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
    await expect(engine.pauseAllSteps('x')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
    await expect(engine.resumeAllSteps('x')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
  });

  it('replyQuestion for an unknown instance throws NODE_NOT_FOUND', async () => {
    const { engine } = await harness();
    await expect(engine.replyQuestion('x', 'q', { answers: [] })).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
    await expect(engine.replyPermission('x', 'q', 'once')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
  });
});

describe('SandoreEngineRuntime startInstance', () => {
  it('throws when the workflowId does not exist and leaves the state table empty', async () => {
    const { engine, persistence } = await harness();
    await expect(
      engine.startInstance({ workflowId: 'wfl-none', originalInput: 'x' }),
    ).rejects.toBeInstanceOf(SandoreError);
    expect(persistence.state.size).toBe(0);
  });

  it('returns a run whose state is immediately readable via getState', async () => {
    const { engine, persistence } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);

    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'hello world' });
    expect(run.status).toBe('running');

    const state = engine.getState(run.instanceId);
    expect(state.originalInput).toBe('hello world');
    expect(['pending', 'running']).toContain(state.status);
  });

  it('creates a host agent via agents.create with meta.cwd and holds it idle (no auto prompt)', async () => {
    const { engine, persistence, agents } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);

    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it', cwd: '/srv/app' });

    expect(agents.createCwds).toEqual(['/srv/app']);
    expect(agents.setupCount).toBe(1);
    const hostAgent = agents.get(run.instanceId);
    expect(hostAgent).toBeDefined();
    expect(hostAgent?.status).toBe('idle');
    expect(hostAgent?.inbox.hasPending).toBe(false);
  });

  it('rejects startInstance when agents.create setup throws and leaves no state', async () => {
    const { engine, persistence, agents } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    agents.setupError = new Error('setup boom');

    await expect(
      engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it' }),
    ).rejects.toThrow('setup boom');
    expect(persistence.state.size).toBe(0);
  });

  it('renames the host session title to `工作流实例 <instanceId>` after creating the host session', async () => {
    const { engine, persistence, sessions, sessionTitle } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);

    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it' });

    expect(sessionTitle.calls).toHaveLength(1);
    expect(sessionTitle.calls[0]?.title).toBe(`工作流实例 ${run.instanceId}`);
    // rename 传入的是经 ctx.sessions.get 读回的 live 宿主 Session（同一引用）。
    expect(sessionTitle.calls[0]?.session).toBe(sessions.get(run.instanceId));
  });

  it('does not fail startInstance when sessionTitle.rename throws and still executes to completion', async () => {
    const { ctx, engine, persistence, sessionTitle } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);
    sessionTitle.renameError = new Error('title boom');

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-shell-only', originalInput: 'do it' });

    expect(run.status).toBe('running');
    await ended;
    expect(persistence.state.get(run.instanceId)?.status).toBe('completed');
    expect(sessionTitle.calls).toHaveLength(1);
  });

  it('falls back to the state table when the instance is not in memory', async () => {
    const { engine, persistence } = await harness();
    await persistence.state.put('inst-fallback', completedSnapshot('inst-fallback'));

    const state = engine.getState('inst-fallback');
    expect(state.taskId).toBe('inst-fallback');
    expect(state.status).toBe('completed');
    expect(state.originalInput).toBe('hello world');
    expect(state.currentStageId).toBe('stg-1');
    expect(state.executedSteps).toHaveLength(1);
    expect(state.executedSteps[0]?.stepId).toBe('step-abc');
  });

  it('throws NODE_NOT_FOUND when neither memory nor the state table has the instance', async () => {
    const { engine } = await harness();
    let caught: unknown;
    try {
      engine.getState('inst-none');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SandoreError);
    expect(caught).toMatchObject({ code: 'NODE_NOT_FOUND' });
  });
});

describe('SandoreEngineRuntime linear execution', () => {
  it('runs a shell Step then a prompt Step to completed with the exact event order', async () => {
    const { ctx, engine, persistence, llm, shell, sessions } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    shell.runHandler = async spec => successResult(spec, 'hello');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('summary');

    const records = recordSandoreEvents(ctx);
    const ended = waitForEnd(ctx);

    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it' });
    await ended;

    expect(records.map(record => record.name)).toEqual([
      'sandore/start',
      'sandore/stage-start',
      'sandore/step-start',
      'sandore/step-completed',
      'sandore/stage-completed',
      'sandore/stage-start',
      'sandore/step-start',
      'sandore/step-completed',
      'sandore/stage-completed',
      'sandore/end',
    ]);

    // 事件双发：宿主 Session 记录同序事件。
    const session = sessions.get(run.instanceId);
    expect(session?.events.map(event => event.type)).toEqual([
      'sandore/start',
      'sandore/stage-start',
      'sandore/step-start',
      'sandore/step-completed',
      'sandore/stage-completed',
      'sandore/stage-start',
      'sandore/step-start',
      'sandore/step-completed',
      'sandore/stage-completed',
      'sandore/end',
    ]);

    // prompt 成功：step-completed 事件 payload 的 output 即聚合 ContentBlock[]，
    // 且 name 为 Step 定义 id（YAML 未写 name 时兜底回退 id）；非循环 Step 无 loopIteration。
    const promptCompleted = records.find(record => record.name === 'sandore/step-completed' && record.args[1] === 'step-prompt');
    expect(promptCompleted?.args[3]).toEqual([{ type: 'text', text: 'summary' }]);
    expect(promptCompleted?.args[4]).toBe('step-prompt');
    expect(promptCompleted?.args[5]).toBeUndefined();

    // 完成后 state 表读回快照。
    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    expect(state?.executedSteps).toHaveLength(2);
    expect(state?.executedSteps[0]?.status).toBe('completed');
    expect(state?.executedSteps[1]?.status).toBe('completed');
    expect(state?.executedSteps[0]?.output).toEqual([{ type: 'text', text: 'hello' }]);
    expect(state?.executedSteps[1]?.output).toEqual([{ type: 'text', text: 'summary' }]);
    expect(state?.stageInfos[0]?.status).toBe('completed');
    expect(state?.stageInfos[1]?.status).toBe('completed');
    expect(Object.keys(state?.stageContracts ?? {})).toHaveLength(2);
  });

  it('executes multiple steps within a stage in order and assembles the stage contract', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-multi', multiStepYaml);
    shell.runHandler = async spec => successResult(spec, 'hello');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('summary');

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-multi', originalInput: 'do it' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    expect(state?.executedSteps.map(step => step.stepId)).toEqual(['step-a', 'step-b']);
    const contract = state?.stageContracts['stg-1'];
    expect(contract?.stageId).toBe('stg-1');
    expect(contract?.stageName).toBe('处理');
    expect(contract?.status).toBe('completed');
    expect(contract?.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(contract?.artifacts[0]?.stepId).toBe('step-a');
    expect(contract?.artifacts[0]?.outputToId).toBe('opt-a');
  });

  it('continues to completed even when a ctx.emit listener throws', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    shell.runHandler = async spec => successResult(spec, 'hello');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('summary');

    ctx.on('sandore/step-start', () => {
      throw new Error('listener boom');
    });

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it' });
    await ended;

    expect(persistence.state.get(run.instanceId)?.status).toBe('completed');
  });

  it('synthesizes childId and sessionMeta for each executed step', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    shell.runHandler = async spec => successResult(spec, 'hello');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('summary');

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.executedSteps[0]?.sessionMeta?.childId).toMatch(/^step-step-abc-[0-9a-f]{8}$/);
    expect(state?.executedSteps[0]?.sessionMeta?.synthetic).toBe(true);
    expect(state?.executedSteps[0]?.sessionMeta?.command).toBe('shell');
    expect(state?.executedSteps[1]?.sessionMeta?.synthetic).toBe(true);
    expect(state?.executedSteps[1]?.sessionMeta?.command).toBe('prompt');
  });
});

describe('SandoreEngineRuntime failure', () => {
  it('fails the instance on shell nonzero exit and emits step-failed', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    shell.runHandler = async spec => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: 'boom', truncated: false },
    });

    const records = recordSandoreEvents(ctx);
    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('failed');
    expect(state?.executedSteps[0]?.error).toContain('boom');
    const failed = records.find(record => record.name === 'sandore/step-failed');
    expect(failed).toBeDefined();
    expect(failed?.args[1]).toBe('step-abc');
    expect(failed?.args[4]).toBe('step-abc');
  });

  it('keeps the first step completed when the second step fails', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-two-shell', twoShellYaml);
    shell.runHandler = async spec => (spec.command.includes('echo')
      ? successResult(spec, 'ok')
      : {
        exitCode: 2,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: spec.timeoutMs,
        stdout: { text: '', truncated: false },
        stderr: { text: 'second boom', truncated: false },
      });

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-two-shell', originalInput: 'do it' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('failed');
    expect(state?.executedSteps).toHaveLength(2);
    expect(state?.executedSteps[0]?.status).toBe('completed');
    expect(state?.executedSteps[1]?.status).toBe('failed');
    expect(state?.executedSteps[1]?.error).toBeTruthy();
  });

  it('fails the instance with failure.message on prompt finish error', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    shell.runHandler = async spec => successResult(spec, 'hello');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('', { kind: 'error', failure: { message: 'model exploded', code: 'X' } });

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('failed');
    expect(state?.executedSteps[1]?.error).toContain('model exploded');
  });
});

describe('SandoreEngineRuntime abort', () => {
  it('aborts a hanging shell step to the aborted terminal state', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    shell.runHandler = spec => new Promise(resolve => {
      const finish = (): void => {
        resolve({
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: false,
          aborted: true,
          timeoutMs: spec.timeoutMs,
          stdout: { text: '', truncated: false },
          stderr: { text: '', truncated: false },
        });
      };
      if (spec.signal?.aborted) {
        finish();
        return;
      }
      spec.signal?.addEventListener('abort', finish, { once: true });
    });

    const records = recordSandoreEvents(ctx);
    const aborted = waitForAborted(ctx);
    const stepStarted = waitForStepStart(ctx);

    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it' });
    await stepStarted;
    await engine.abortInstance(run.instanceId);
    await aborted;

    // 收敛到单一出口：abortInstance 显式发射一次，runInstance failed 分支不再重复发射。
    expect(records.filter(record => record.name === 'sandore/aborted')).toHaveLength(1);
    expect(persistence.state.get(run.instanceId)?.status).toBe('aborted');
  });

  it('rejects abortInstance for a completed instance', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);
    shell.runHandler = async spec => successResult(spec, 'hello');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('summary');

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-linear', originalInput: 'do it' });
    await ended;

    await expect(engine.abortInstance(run.instanceId)).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });
});

describe('SandoreEngineRuntime DAG execution', () => {
  it('routes branches, runs the loop, extracts pass-through vars and passes the gate to completed', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-dag', dagYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    // 条件分支评估（布尔 true）→ agent 执行 → prompt 执行 → 收尾 assess → 门禁（按序供给 chunk 流）。
    const responses = [
      'true',
      'report done',
      '{"completionType":"completed","passThroughVars":{"projectName":"sandore"}}',
      '{"taskStatus":"done"}',
    ];
    let callIndex = 0;
    llm.streamHandler = () => textChunks(responses[callIndex++ % responses.length] ?? '');

    // agent Step 走可续接子代理：注册真实 childId 并回填最终 assistant 输出。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'agent output' }]));
    agents.register(child);

    const records = recordSandoreEvents(ctx);
    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-dag', originalInput: 'do it' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');

    // 分支路由：匹配 agent 分支 + 并行分支；回退分支未执行；汇合节点仅执行一次。
    const stepIds = state?.executedSteps.map(step => step.stepId);
    expect(stepIds).toEqual([
      'step-branch',
      'step-parallel',
      'step-agent',
      'step-merge',
      'step-iter',
      'step-iter',
      'step-iter',
      'step-finalize',
    ]);
    expect(stepIds?.filter(id => id === 'step-fallback')).toHaveLength(0);
    expect(stepIds?.filter(id => id === 'step-merge')).toHaveLength(1);

    // 分支决策点保留 branchMeta 评估现场（布尔判定输出）。
    const branchEntry = state?.executedSteps.find(step => step.stepId === 'step-branch');
    expect(branchEntry?.branchMeta?.status).toBe('completed');
    expect(branchEntry?.branchMeta?.result).toBe('true');

    // agent Step：真实 childId（synthetic:false）+ 子代理最终输出。
    const agentStep = state?.executedSteps.find(step => step.stepId === 'step-agent');
    expect(agentStep?.sessionMeta).toEqual({ childId: 'child-1', synthetic: false, command: 'agent' });
    expect(agentStep?.output).toEqual([{ type: 'text', text: 'agent output' }]);

    // hostAgent 注入：agent Step 的子代理 parent 即宿主主代理（id = instanceId）。
    expect(subagents.continuableStarts[0]?.request.parent.id).toBe(run.instanceId);

    // 循环：3 次扁平迭代，loopIteration 嵌套路径；段 id 为纯 UUID（§3.3），
    // 4 位 hex 后缀在 sessionMeta.childId（loopManager 合成占位）。
    const iterations = state?.executedSteps.filter(step => step.stepId === 'step-iter') ?? [];
    expect(iterations.map(step => step.loopIteration)).toEqual([[1], [2], [3]]);
    expect(iterations[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(iterations[0]?.sessionMeta?.childId).toMatch(/^step-iter-[0-9a-f]{4}$/);
    expect(iterations[2]?.visitCount).toBe(3);

    // 透传变量回写：finalize 提取 projectName 并保留 description。
    expect(state?.passThroughVars['projectName']).toEqual({ value: 'sandore', description: '项目名' });

    // 门禁通过：finalizeMeta 记录 gateResult。
    const finalizeStep = state?.executedSteps.find(step => step.stepId === 'step-finalize');
    expect(finalizeStep?.finalizeMeta?.gateResult?.gatesPassed).toBe(true);
    expect(finalizeStep?.finalizeMeta?.completionType).toBe('completed');

    // agent Step 的 step-completed 事件载荷：真实 childId + 最终 output + name；
    // 非循环 Step 无 loopIteration。
    const agentCompleted = records.find(record => record.name === 'sandore/step-completed' && record.args[1] === 'step-agent');
    expect(agentCompleted?.args[2]).toBe('child-1');
    expect(agentCompleted?.args[3]).toEqual([{ type: 'text', text: 'agent output' }]);
    expect(agentCompleted?.args[4]).toBe('step-agent');
    expect(agentCompleted?.args[5]).toBeUndefined();

    // 循环内 Step 的 step-completed 事件载荷：name + 扁平迭代路径（末尾位置）。
    const iterCompleted = records.filter(record => record.name === 'sandore/step-completed' && record.args[1] === 'step-iter');
    expect(iterCompleted.map(record => record.args[4])).toEqual(['step-iter', 'step-iter', 'step-iter']);
    expect(iterCompleted.map(record => record.args[5])).toEqual([[1], [2], [3]]);

    // 两 Stage 均 completed，契约落盘。
    expect(state?.stageInfos.map(info => info.status)).toEqual(['completed', 'completed']);
    expect(Object.keys(state?.stageContracts ?? {})).toHaveLength(2);
  });

  it('falls back to array order and preserves branchMeta when no branch matches', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-branch-fallback', branchFallbackYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('false');

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-branch-fallback', originalInput: 'do it' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');

    // 条件 false → 分支未命中（branchMeta.result=false）→ 数组顺序兜底 step-fallback。
    const stepIds = state?.executedSteps.map(step => step.stepId);
    expect(stepIds).toEqual(['step-branch', 'step-fallback', 'step-matched']);

    // branchMeta 保留原始评估结果（false 证明条件分支未命中）。
    const branchEntry = state?.executedSteps.find(step => step.stepId === 'step-branch');
    expect(branchEntry?.branchMeta?.status).toBe('completed');
    expect(branchEntry?.branchMeta?.result).toBe('false');
  });

  it('executes nested loops fully on every outer iteration (inner loop visitCount resets)', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-nested-loop', nestedLoopYaml);
    shell.runHandler = async spec => successResult(spec, 'iter');

    const records = recordSandoreEvents(ctx);
    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-nested-loop', originalInput: 'do it' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');

    // 内层循环体在每个外层迭代中均完整执行 2 次（而非第 2 次外层迭代时提前跳出），
    // loopIteration 路径为嵌套数组 [[1,1],[1,2],[2,1],[2,2]]。
    const iterations = state?.executedSteps.filter(step => step.stepId === 'step-iter') ?? [];
    expect(iterations.map(step => step.loopIteration)).toEqual([[1, 1], [1, 2], [2, 1], [2, 2]]);

    // 事件 payload 的 loopIteration 为嵌套完整路径数组（与 state 快照一致）。
    const iterCompleted = records.filter(record => record.name === 'sandore/step-completed' && record.args[1] === 'step-iter');
    expect(iterCompleted.map(record => record.args[5])).toEqual([[1, 1], [1, 2], [2, 1], [2, 2]]);
  });

  it('writes loopMeta to executedSteps when a breakCondition breaks the loop', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-loop-break', loopBreakYaml);
    shell.runHandler = async spec => successResult(spec, 'iter');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('{"shouldBreak": true}');

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-loop-break', originalInput: 'do it' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');

    // breakCondition 跳出后 loopMeta（checkLoopBreak 两阶段产出）回写到 executedSteps。
    const loopMetaEntry = state?.executedSteps.find(step => step.loopMeta !== undefined);
    expect(loopMetaEntry).toBeDefined();
    expect(loopMetaEntry?.loopMeta?.status).toBe('completed');
    expect(loopMetaEntry?.loopMeta?.result).toBe('{"shouldBreak": true}');
  });
});

/** 单 Stage prompt Step 带透传变量（触发 finalize assess → ask）。 */
const askYaml = `id: wfl-ask
name: ask
version: "1.0.0"
stages:
  - id: stg-1
    name: 提问
    steps:
      - id: step-ask
steps:
  - id: step-ask
    command:
      type: prompt
      value:
        promptText: "do it"
    passThroughVars:
      - name: projectName
        value: "\${projectName}"
        description: "项目名"
`;

/** 单 Stage 多 Step：step-ask（prompt + 门禁 + 透传变量）触发中途 ask，step-after 为剩余 Step。 */
const askMidYaml = `id: wfl-ask-mid
name: ask-mid
version: "1.0.0"
stages:
  - id: stg-1
    name: 中途提问
    steps:
      - id: step-ask
      - id: step-after
steps:
  - id: step-ask
    command:
      type: prompt
      value:
        promptText: "do it"
    passThroughVars:
      - name: projectName
        value: "\${projectName}"
        description: "项目名"
    gates:
      primary:
        enabled: true
  - id: step-after
    command:
      type: shell
      value:
        command: "echo done"
`;

/** 单 Stage agent Step（子代理 final result 含 [[SANDORE_ASK]] 标记块触发转接）。 */
const delegatedAskYaml = `id: wfl-delegated
name: delegated
version: "1.0.0"
stages:
  - id: stg-1
    name: 委托
    steps:
      - id: step-agent
steps:
  - id: step-agent
    command:
      type: agent
      value:
        promptText: "do-work"
`;

/** 等待一次 sandore/question 事件并返回载荷（用于读取 requestId）。 */
function waitForQuestion(ctx: Context): Promise<{ info: unknown; question: unknown }> {
  return new Promise(resolve => {
    ctx.once('sandore/question', (info, question) => resolve({ info, question }));
  });
}

describe('SandoreEngineRuntime interaction', () => {
  it('registers a pending question, asks via userQuestions (hostAgent), and resumes after the card reply', async () => {
    const { ctx, engine, persistence, llm, userQuestions } = await harness();
    await putDefinition(persistence, 'wfl-ask', askYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    // prompt Step 输出 → finalize assess（completionType=ask + askQuestion）。
    const responses = [
      'work done',
      '{"completionType":"ask","passThroughVars":{"projectName":"sandore"},"askQuestion":{"questions":[{"id":"q1","question":"Which?","options":[{"label":"A"},{"label":"B"}]}]}}',
    ];
    let callIndex = 0;
    llm.streamHandler = () => textChunks(responses[callIndex++ % responses.length] ?? '');

    const firedQuestions: unknown[] = [];
    ctx.on('sandore/question', (info, question) => firedQuestions.push({ info, question }));

    // 卡片回复：捕获 ask 请求并回填答案。
    userQuestions.resolveNext = async (request) => {
      expect(request.questions).toEqual([{ id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }]);
      return { answers: [{ id: 'q1', selected: ['A'] }] };
    };

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-ask', originalInput: 'do it' });
    await ended;

    // ask 以 hostAgent（id = instanceId）身份发起。
    expect(userQuestions.calls).toHaveLength(1);
    expect(userQuestions.calls[0]?.agent?.id).toBe(run.instanceId);

    // sandore/question 事件：pending 条目（kind/status/payload）。
    expect(firedQuestions).toHaveLength(1);
    const fired = firedQuestions[0] as { question: { kind: string; status: string; payload: { questions: Array<{ id: string }> } } };
    expect(fired.question.kind).toBe('question');
    expect(fired.question.status).toBe('pending');
    expect(fired.question.payload.questions[0]?.id).toBe('q1');

    // 回复后恢复：Step completed + 实例 completed + 条目不再持久化（pending 已清，
    // 回答写入 userMessages kind:'answer'——交互管理器只持久化 pending，§3.6A）。
    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    expect(state?.executedSteps.find(step => step.stepId === 'step-ask')?.status).toBe('completed');
    expect(state?.pendingInteractions).toEqual([]);
    const answers = state?.userMessages?.filter(message => message.kind === 'answer');
    expect(answers).toHaveLength(1);
    expect(answers?.[0]?.target).toBe('step-ask');
    expect(answers?.[0]?.content).toBe('A');
  });

  it('supports the replyQuestion compat path when the card channel is unavailable', async () => {
    const { ctx, engine, persistence, llm } = await harness();
    await putDefinition(persistence, 'wfl-ask', askYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    const responses = [
      'work done',
      '{"completionType":"ask","passThroughVars":{"projectName":"sandore"},"askQuestion":{"questions":[{"id":"q1","question":"Which?","options":[{"label":"A"},{"label":"B"}]}]}}',
    ];
    let callIndex = 0;
    llm.streamHandler = () => textChunks(responses[callIndex++ % responses.length] ?? '');

    const question = waitForQuestion(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-ask', originalInput: 'do it' });
    const fired = await question;
    const requestId = (fired.question as { requestId: string }).requestId;

    // 兼容路径回复：resolve ask 的 await 并恢复执行。
    await engine.replyQuestion(run.instanceId, requestId, { answers: [{ id: 'q1', selected: ['B'] }] });
    await waitForEnd(ctx);

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    // 回答后 pending 已清（只持久化 pending），回答进 userMessages kind:'answer'。
    expect(state?.pendingInteractions).toEqual([]);
    const answers = state?.userMessages?.filter(message => message.kind === 'answer');
    expect(answers).toHaveLength(1);
    expect(answers?.[0]?.content).toBe('B');
  });

  it('resumes the remaining steps and re-runs the gate after a mid-stage ask', async () => {
    const { ctx, engine, persistence, llm, shell, userQuestions } = await harness();
    await putDefinition(persistence, 'wfl-ask-mid', askMidYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    shell.runHandler = async spec => successResult(spec, 'done');

    const responses = [
      'work done',
      '{"completionType":"ask","passThroughVars":{"projectName":"sandore"},"askQuestion":{"questions":[{"id":"q1","question":"Which?","options":[{"label":"A"},{"label":"B"}]}]}}',
      '{"taskStatus":"done"}',
    ];
    let callIndex = 0;
    llm.streamHandler = () => textChunks(responses[callIndex++ % responses.length] ?? '');

    userQuestions.resolveNext = async () => ({ answers: [{ id: 'q1', selected: ['A'] }] });

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-ask-mid', originalInput: 'do it' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    // 剩余 Step 不丢失：step-ask 与 step-after 均执行。
    expect(state?.executedSteps.map(step => step.stepId)).toEqual(['step-ask', 'step-after']);
    // ask 回复后重跑门禁：step-ask 的 finalizeMeta 记录 gateResult。
    const askStep = state?.executedSteps.find(step => step.stepId === 'step-ask');
    expect(askStep?.status).toBe('completed');
    expect(askStep?.finalizeMeta?.gateResult?.gatesPassed).toBe(true);
  });
});

describe('SandoreEngineRuntime delegated subagent ask', () => {
  it('delegates a valid [[SANDORE_ASK]] marker block to an engine-level ask and re-reads the child output after followup', async () => {
    const { ctx, engine, persistence, llm, agents, subagents, userQuestions } = await harness();
    await putDefinition(persistence, 'wfl-delegated', delegatedAskYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([
      { type: 'text', text: '[[SANDORE_ASK]]{"questions":[{"id":"q1","question":"Which?"}]}[[/SANDORE_ASK]]' },
    ]));
    let idleCalls = 0;
    child.whenIdle = async () => {
      idleCalls += 1;
      if (idleCalls === 2) {
        child.session.append(assistantMessageEvent([{ type: 'text', text: 'final answer' }]));
      }
    };
    agents.register(child);

    userQuestions.resolveNext = async () => ({ answers: [{ id: 'q1', selected: ['A'] }] });

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-delegated', originalInput: 'do it' });
    await ended;

    // 引擎级 ask 以 hostAgent（id = instanceId）身份触发。
    expect(userQuestions.calls).toHaveLength(1);
    expect(userQuestions.calls[0]?.agent?.id).toBe(run.instanceId);
    // 答案经 followup 注回子代理。
    expect(subagents.followups).toHaveLength(1);
    expect(subagents.followups[0]?.childId).toBe('child-1');
    // 子代理续跑后 Step 输出为重新取回的 final output（非标记块）。
    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    expect(state?.executedSteps.find(step => step.stepId === 'step-agent')?.output).toEqual([
      { type: 'text', text: 'final answer' },
    ]);
  });

  it('does not delegate an invalid marker block (treated as ordinary output)', async () => {
    const { ctx, engine, persistence, llm, agents, subagents, userQuestions } = await harness();
    await putDefinition(persistence, 'wfl-delegated', delegatedAskYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([
      { type: 'text', text: '[[SANDORE_ASK]]not json[[/SANDORE_ASK]]' },
    ]));
    agents.register(child);

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-delegated', originalInput: 'do it' });
    await ended;

    // 非法标记块：不转接、不 ask、不 followup，按普通输出处理。
    expect(userQuestions.calls).toHaveLength(0);
    expect(subagents.followups).toHaveLength(0);
    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    expect(state?.executedSteps.find(step => step.stepId === 'step-agent')?.output).toEqual([
      { type: 'text', text: '[[SANDORE_ASK]]not json[[/SANDORE_ASK]]' },
    ]);
  });
});

/** 单 Stage 单 agent Step（用于重试续跑集成测试：首跑无输出 failed，续跑回填输出 completed）。 */
const agentFailYaml = `id: wfl-agent-fail
name: agent-fail
version: "1.0.0"
stages:
  - id: stg-1
    name: 单agent
    steps:
      - id: step-agent
steps:
  - id: step-agent
    command:
      type: agent
      value:
        promptText: "do work"
`;

/** 单 Stage 三 Step：shell（outputTo）→ agent（中间失败可重试）→ shell（剩余 Step）。 */
const multiStepRetryYaml = `id: wfl-multi-retry
name: multi-retry
version: "1.0.0"
stages:
  - id: stg-1
    name: 重试续跑
    steps:
      - id: step-a
      - id: step-b
      - id: step-c
steps:
  - id: step-a
    command:
      type: shell
      value:
        command: "echo hello"
    outputTo:
      - id: opt-a
        path: "out-a.txt"
  - id: step-b
    command:
      type: agent
      value:
        promptText: "do work"
    outputTo:
      - id: opt-b
        path: "out-b.txt"
  - id: step-c
    command:
      type: shell
      value:
        command: "echo done"
`;

describe('SandoreEngineRuntime recovery', () => {
  it('throws INVALID_OPERATION when recovering a terminal instance', async () => {
    const { engine, persistence } = await harness();
    await persistence.state.put('inst-done', completedSnapshot('inst-done'));

    await expect(engine.recoverInstance('inst-done')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });

  it('retries a failed agent step with continue mode and resumes to completed', async () => {
    const { ctx, engine, persistence, llm, agents, subagents, sessions } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    // 子代理首次无输出 → Step failed（真实 childId 已记录）。
    const child = new FakeAgent('child-1');
    agents.register(child);

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-agent-fail', originalInput: 'do it' });
    await ended;
    expect(persistence.state.get(run.instanceId)?.status).toBe('failed');

    // 续跑前给子代理回填最终输出。
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'retry output' }]));

    const retried: Array<{ stepId: string; mode: string; name: string; loopIteration?: number[] }> = [];
    ctx.on('sandore/step-retried', (_info, stepId, mode, name, loopIteration) => retried.push({ stepId, mode, name, ...(loopIteration === undefined ? {} : { loopIteration }) }));

    await engine.retryStep(run.instanceId, 'step-agent', 'continue', 'please retry');

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    // 段模型：重试追加新段（attemptIndex 1），断言取最后活跃段。
    const step = lastSegmentOf(state?.executedSteps ?? [], 'step-agent');
    expect(step?.output).toEqual([{ type: 'text', text: 'retry output' }]);
    expect(step?.sessionMeta?.childId).toBe('child-1');
    expect(step?.retryHistory?.[0]?.mode).toBe('continue');
    expect(step?.retryHistory?.[0]?.result).toBe('completed');
    expect(subagents.followups.some(item => item.childId === 'child-1')).toBe(true);

    // sandore/step-retried 双发：Cordis emit + Session append 同发。
    expect(retried).toEqual([{ stepId: 'step-agent', mode: 'continue', name: 'step-agent' }]);
    expect(sessions.get(run.instanceId)?.events.some(event => event.type === 'sandore/step-retried')).toBe(true);
  });

  it('retries a failed middle agent step and runs all remaining steps to completed', async () => {
    const { ctx, engine, persistence, llm, shell, agents } = await harness();
    await putDefinition(persistence, 'wfl-multi-retry', multiStepRetryYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    const child = new FakeAgent('child-1');
    agents.register(child);

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-multi-retry', originalInput: 'do it' });
    await ended;

    // 首跑：step-a 完成、step-b（agent 无输出）失败、step-c 未执行。
    let state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('failed');
    expect(state?.executedSteps.map(step => step.stepId)).toEqual(['step-a', 'step-b']);
    expect(state?.executedSteps[1]?.status).toBe('failed');

    // 续跑前给子代理回填最终输出。
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'retry output' }]));
    await engine.retryStep(run.instanceId, 'step-b', 'continue', 'please retry');

    state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    // 段模型：step-b 重试追加新段（attemptIndex 1），旧 failed 段保留定格快照。
    // 断言聚焦新段状态与输出（不假设 stepIds 顺序，旧 failed 段的存在单独验证）。
    const stepIds = state?.executedSteps.map(step => step.stepId) ?? [];
    expect(new Set(stepIds)).toEqual(new Set(['step-a', 'step-b', 'step-c']));
    expect(stepIds.filter(id => id === 'step-b').length).toBe(2);
    const retriedB = lastSegmentOf(state?.executedSteps ?? [], 'step-b');
    expect(retriedB?.status).toBe('completed');
    expect(retriedB?.output).toEqual([{ type: 'text', text: 'retry output' }]);
    expect(retriedB?.retryHistory?.[0]?.mode).toBe('continue');
    expect(retriedB?.retryHistory?.[0]?.result).toBe('completed');
    const failedB = state?.executedSteps.find(step => step.stepId === 'step-b' && step.status === 'failed');
    expect(failedB).toBeDefined();
  });

  it('preserves outputTo artifacts in the stage contract after retrying the producing step', async () => {
    const { ctx, engine, persistence, llm, shell, agents } = await harness();
    await putDefinition(persistence, 'wfl-multi-retry', multiStepRetryYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    const child = new FakeAgent('child-1');
    agents.register(child);

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-multi-retry', originalInput: 'do it' });
    await ended;
    expect(persistence.state.get(run.instanceId)?.status).toBe('failed');

    child.session.append(assistantMessageEvent([{ type: 'text', text: 'retry output' }]));
    await engine.retryStep(run.instanceId, 'step-b', 'continue', 'please retry');

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    // 重试 Step 的 outputTo 产物保留在 StageContract.artifacts（含已完成的 step-a）。
    const contract = state?.stageContracts['stg-1'];
    expect(contract?.status).toBe('completed');
    const artifacts = contract?.artifacts ?? [];
    expect(artifacts.map(item => item.outputToId)).toEqual(['opt-a', 'opt-b']);
    expect(artifacts.find(item => item.outputToId === 'opt-b')?.stepId).toBe('step-b');
  });

  it('retries a failed agent step with fork mode to a new childId and completes', async () => {
    const { ctx, engine, persistence, llm, agents, subagents, sessions } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    const child = new FakeAgent('child-1');
    agents.register(child);

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-agent-fail', originalInput: 'do it' });
    await ended;
    expect(persistence.state.get(run.instanceId)?.status).toBe('failed');

    // fork 源：child-1 在 sessions 表登记，其 assistant 输出作为 fork 的 seed 回放。
    const childSession = sessions.create('child-1');
    childSession.append('assistant/message', assistantMessageEvent([{ type: 'text', text: 'fork output' }]).data);

    await engine.retryStep(run.instanceId, 'step-agent', 'fork', 'fork it');

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    // 段模型：fork 新段（attemptIndex 1）承载新 childId/output/retryHistory。
    const step = lastSegmentOf(state?.executedSteps ?? [], 'step-agent');
    expect(step?.output).toEqual([{ type: 'text', text: 'fork output' }]);
    // 新 childId（合成 session id）续跑，parentSessionId 记旧值。
    expect(step?.sessionMeta?.childId).toMatch(/^step-step-agent-[0-9a-f]{8}$/);
    expect(step?.sessionMeta?.childId).not.toBe('child-1');
    expect(step?.parentSessionId).toBe('child-1');
    expect(step?.retryHistory?.[0]?.mode).toBe('fork');
    expect(step?.retryHistory?.[0]?.result).toBe('completed');
    expect(subagents.followups.some(item => item.childId === step?.sessionMeta?.childId)).toBe(true);
  });

  it('retries a failed agent step with revert mode to a new childId and completes', async () => {
    const { ctx, engine, persistence, llm, agents, subagents, sessions } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    const child = new FakeAgent('child-1');
    agents.register(child);

    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-agent-fail', originalInput: 'do it' });
    await ended;
    expect(persistence.state.get(run.instanceId)?.status).toBe('failed');

    // revert 源：child-1 含闭合 turn（turn/start → assistant → turn/end）供安全边界计算。
    const childSession = sessions.create('child-1');
    childSession.append('turn/start', { turn: 0 });
    childSession.append('assistant/message', assistantMessageEvent([{ type: 'text', text: 'revert output' }]).data);
    childSession.append('turn/end', { turn: 0, reason: { kind: 'completed' } });

    await engine.retryStep(run.instanceId, 'step-agent', 'revert', 'rollback');

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    const step = lastSegmentOf(state?.executedSteps ?? [], 'step-agent');
    expect(step?.output).toEqual([{ type: 'text', text: 'revert output' }]);
    expect(step?.sessionMeta?.childId).toMatch(/^step-step-agent-[0-9a-f]{8}$/);
    expect(step?.parentSessionId).toBe('child-1');
    expect(step?.retryHistory?.[0]?.mode).toBe('revert');
    expect(step?.retryHistory?.[0]?.result).toBe('completed');
    expect(subagents.followups.some(item => item.childId === step?.sessionMeta?.childId)).toBe(true);
  });

  it('truly re-runs an empty-executedSteps non-terminal snapshot to completed (no fake recovery)', async () => {
    const { ctx, engine, persistence, sessions } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);

    await persistence.state.put('inst-running', runningSnapshot('inst-running', 'wfl-shell-only'));
    sessions.create('inst-running');

    const ended = waitForEnd(ctx);
    const result = await engine.recoverInstance('inst-running');
    expect(result).toEqual({ instanceId: 'inst-running', status: 'running' });
    await ended;

    const state = persistence.state.get('inst-running');
    expect(state?.status).toBe('completed');
    expect(state?.executedSteps).toHaveLength(1);
    expect(state?.executedSteps[0]?.stepId).toBe('step-shell');
    expect(state?.executedSteps[0]?.status).toBe('completed');
  });

  it('resumes the host agent before following up the child subagent during recovery', async () => {
    const { ctx, engine, persistence, sessions, agents, subagents } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);

    await persistence.state.put('inst-run', stepSnapshot('inst-run', 'wfl-agent-fail', agentStepSnapshot('running'), 'running'));
    sessions.create('inst-run');
    // 子代理 child-1 已注册并携带输出（followup 后 resumeSubagent 收集其输出）。
    const child = new FakeAgent('child-1');
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'recovered output' }]));
    agents.register(child);

    const ended = waitForEnd(ctx);
    const result = await engine.recoverInstance('inst-run');
    expect(result.status).toBe('running');
    await ended;

    // 宿主主代理经 agents.resume 冷恢复，且作为 followup 的 parent（先宿主后子代理）。
    expect(agents.setupCount).toBeGreaterThanOrEqual(1);
    expect(subagents.followups).toHaveLength(1);
    expect(subagents.followups[0]?.childId).toBe('child-1');
    expect(subagents.followups[0]?.parent.id).toBe('inst-run');

    const state = persistence.state.get('inst-run');
    expect(state?.status).toBe('completed');
    expect(state?.executedSteps[0]?.output).toEqual([{ type: 'text', text: 'recovered output' }]);
  });

  it('rebuilds the paused registry from pausedChildIds and stays paused without re-running', async () => {
    const { engine, persistence, sessions, subagents } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);

    await persistence.state.put('inst-paused', pausedSnapshot('inst-paused'));
    sessions.create('inst-paused');

    const result = await engine.recoverInstance('inst-paused');
    expect(result.status).toBe('paused');
    // 不自动 followup（等待手动 resume）。
    expect(subagents.followups).toHaveLength(0);

    // 登记表已从 pausedChildIds 重建：resumeStep 可反查并 followup 原 childId。
    await engine.resumeStep('inst-paused', 'step-agent', 'continue now');
    expect(subagents.followups).toHaveLength(1);
    expect(subagents.followups[0]?.childId).toBe('child-1');
  });

  it('marks an unrecoverable synthetic (shell) running step as failed during recovery', async () => {
    const { engine, persistence, sessions } = await harness();
    await putDefinition(persistence, 'wfl-shell-only', shellOnlyYaml);

    await persistence.state.put('inst-shell', stepSnapshot('inst-shell', 'wfl-shell-only', shellStepSnapshot('running'), 'running'));
    sessions.create('inst-shell');

    const result = await engine.recoverInstance('inst-shell');
    expect(result.status).toBe('failed');

    const state = persistence.state.get('inst-shell');
    expect(state?.status).toBe('failed');
    expect(state?.executedSteps[0]?.status).toBe('failed');
    expect(state?.executedSteps[0]?.error).toContain('not recoverable');
  });

  it('recoverOrphanedInstances scans the state table, skips terminal, and recovers non-terminal', async () => {
    const { engine, persistence, sessions, agents } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);

    // 终态实例（跳过）。
    await persistence.state.put('inst-done', completedSnapshot('inst-done'));
    await persistence.state.put('inst-failed', { ...completedSnapshot('inst-failed'), status: 'failed' });
    await persistence.state.put('inst-aborted', { ...completedSnapshot('inst-aborted'), status: 'aborted' });

    // 非终态实例（恢复）：预建宿主 Session 供 agents.resume 后读回。
    await persistence.state.put('inst-paused', pausedSnapshot('inst-paused'));
    sessions.create('inst-paused');

    const result = await (engine as SandoreEngineRuntime).recoverOrphanedInstances();
    expect(result.recovered).toEqual(['inst-paused']);
    expect(result.errors).toHaveLength(0);
    // 宿主主代理经 agents.resume 冷恢复（setup 重跑）。
    expect(agents.setupCount).toBeGreaterThanOrEqual(1);
  });

  it('recoverOrphanedInstances aggregates a single failing instance without blocking others', async () => {
    const { engine, persistence, sessions } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);

    // 一个可恢复（定义存在 + 宿主 Session），一个定义缺失（失败进 errors）。
    await persistence.state.put('inst-ok', pausedSnapshot('inst-ok'));
    sessions.create('inst-ok');
    await persistence.state.put('inst-bad', pausedSnapshot('inst-bad', 'wfl-missing'));

    const result = await (engine as SandoreEngineRuntime).recoverOrphanedInstances();
    expect(result.recovered).toEqual(['inst-ok']);
    expect(result.errors.map(item => item.instanceId)).toEqual(['inst-bad']);
    expect(result.errors[0]?.error).toContain('not found');
  });

  it('aggregates host resume failure into errors without blocking', async () => {
    const { engine, persistence, sessions, agents } = await harness();
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);

    await persistence.state.put('inst-run', pausedSnapshot('inst-run'));
    sessions.create('inst-run');
    agents.setupError = new Error('resume boom');

    const result = await (engine as SandoreEngineRuntime).recoverOrphanedInstances();
    expect(result.recovered).toEqual([]);
    expect(result.errors.map(item => item.instanceId)).toEqual(['inst-run']);
    expect(result.errors[0]?.error).toContain('resume boom');
  });

  it('recovers orphaned instances automatically at Service.init (startup scan)', async () => {
    const ctx = new Context();
    const storageDomain = new MemoryStorageDomain();
    ctx.provide('storageDomain', storageDomain as unknown as DomainFacility);
    await ctx.plugin(SandorePersistence);
    const persistence = ctx.sandorePersistence;
    await putDefinition(persistence, 'wfl-agent-fail', agentFailYaml);
    await persistence.state.put('inst-init', pausedSnapshot('inst-init'));

    const sessions = new FakeSessionStore();
    sessions.create('inst-init');
    const agents = new FakeAgentRegistry(sessions);
    ctx.provide('sessions', sessions as unknown as SessionStore);
    ctx.provide('sessionPersistence', {});
    ctx.provide('agents', agents);
    ctx.provide('subagents', new FakeSubagents());
    ctx.provide('llm', new FakeLlm() as unknown as LlmRuntime);
    ctx.provide('shell', new FakeShell() as unknown as ShellExecutor);
    ctx.provide('subprocess', new FakeSubprocess());
    ctx.provide('userQuestions', new FakeUserQuestions());
    ctx.provide('sessionTitle', new FakeSessionTitle());
    ctx.provide('fs', {});

    await ctx.plugin(SandoreEngineRuntime, {});

    // 启动扫描自动冷恢复宿主主代理（agents.resume setup 重跑）+ 实例进内存。
    expect(agents.setupCount).toBeGreaterThanOrEqual(1);
    expect(ctx.sandoreEngine.getState('inst-init').status).toBe('paused');
  });
});
