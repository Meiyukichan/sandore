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
import { FakeShell, successResult } from '../tests/mocks/shell.ts';
import { MemoryStorageDomain } from '../tests/mocks/storage-domain.ts';
import { FakeSubagents } from '../tests/mocks/subagents.ts';
import { FakeSubprocess } from '../tests/mocks/subprocess.ts';
import { SandoreError } from './errors.ts';
import SandoreEngineRuntime, { SandoreEngineStub } from './index.ts';
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
    next: stg-2
    steps:
      - id: step-abc
        command:
          type: shell
          value:
            command: "echo hello"
  - id: stg-2
    name: 推理
    steps:
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
            path: "stg-1.step-a.opt-a"
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

/** 完整 DAG（分支 + 并行 + 汇合 + 循环 + 门禁 + 透传变量 + agent 子代理）。 */
const dagYaml = `id: wfl-dag
name: dag
version: "1.0.0"
stages:
  - id: stg-1
    name: 分支
    steps:
      - id: step-branch
        condition:
          type: prompt
          value:
            promptText: "route"
        branches:
          - expectation: "agent"
            next: step-agent
          - next: step-parallel
        next: step-fallback
      - id: step-agent
        command:
          type: agent
          value:
            promptText: "do-work"
        next: step-merge
      - id: step-parallel
        command:
          type: shell
          value:
            command: "echo parallel"
        next: step-merge
      - id: step-fallback
        command:
          type: shell
          value:
            command: "echo fallback"
        next: step-merge
      - id: step-merge
        command:
          type: shell
          value:
            command: "echo merge"
  - id: stg-2
    name: 循环
    steps:
      - id: step-loop
        loop:
          maxIterations: 3
          next: step-iter
          exitTo: step-finalize
      - id: step-iter
        command:
          type: shell
          value:
            command: "echo iter"
        next: step-loop
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

/** 分支无匹配回退（用于验证 node.next 回退 + branchMeta 现场保留）。 */
const branchFallbackYaml = `id: wfl-branch-fallback
name: branch-fallback
version: "1.0.0"
stages:
  - id: stg-1
    name: 分支
    steps:
      - id: step-branch
        condition:
          type: prompt
          value:
            promptText: "route"
        branches:
          - expectation: "matched"
            next: step-matched
        next: step-fallback
      - id: step-matched
        command:
          type: shell
          value:
            command: "echo matched"
      - id: step-fallback
        command:
          type: shell
          value:
            command: "echo fallback"
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
        loop:
          maxIterations: 2
          next: step-inner-loop
          exitTo: step-done
      - id: step-inner-loop
        loop:
          maxIterations: 2
          next: step-iter
          exitTo: step-outer-loop
      - id: step-iter
        command:
          type: shell
          value:
            command: "echo iter"
        next: step-inner-loop
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
        loop:
          maxIterations: 5
          breakCondition:
            type: prompt
            value:
              promptText: "should we break?"
          next: step-iter
          exitTo: step-done
      - id: step-iter
        command:
          type: shell
          value:
            command: "echo iter"
        next: step-loop
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
    jobId: 'job-1',
    workflowId: 'wfl-linear',
    cwd: '/tmp',
    status: 'completed',
    originalInput: 'hello world',
    currentStageId: 'stg-1',
    executedSteps: [{
      type: 'default',
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
    pausedStepIds: [],
    stageContracts: {},
    createdAt,
    updatedAt: createdAt,
  };
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
  const agents = new FakeAgentRegistry();
  const subprocess = new FakeSubprocess();
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('shell', shell as unknown as ShellExecutor);
  ctx.provide('sessions', sessions as unknown as SessionStore);
  ctx.provide('sessionPersistence', {});
  ctx.provide('subagents', subagents);
  ctx.provide('agents', agents);
  ctx.provide('subprocess', subprocess);
  ctx.provide('fs', {});

  await ctx.plugin(SandoreEngineRuntime, config);
  const engine = ctx.sandoreEngine;
  return { ctx, engine, persistence, llm, shell, sessions, subagents, agents };
}

/** 注册全部 sandore/* 监听器并记录事件（名称 + 参数）。 */
function recordSandoreEvents(ctx: Context): Array<{ name: string; args: unknown[] }> {
  const records: Array<{ name: string; args: unknown[] }> = [];
  ctx.on('sandore/start', info => records.push({ name: 'sandore/start', args: [info] }));
  ctx.on('sandore/stage-start', (info, stageId) => records.push({ name: 'sandore/stage-start', args: [info, stageId] }));
  ctx.on('sandore/stage-completed', (info, stageId, contract) => records.push({ name: 'sandore/stage-completed', args: [info, stageId, contract] }));
  ctx.on('sandore/step-start', (info, stepId, childId) => records.push({ name: 'sandore/step-start', args: [info, stepId, childId] }));
  ctx.on('sandore/step-completed', (info, stepId, childId, output) => records.push({ name: 'sandore/step-completed', args: [info, stepId, childId, output] }));
  ctx.on('sandore/step-failed', (info, stepId, childId, error) => records.push({ name: 'sandore/step-failed', args: [info, stepId, childId, error] }));
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

  it('throws INVALID_OPERATION with not implemented for the 8 unimplemented methods', async () => {
    const { engine } = await harness();
    await expect(engine.recoverInstance('x')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    await expect(engine.recoverInstance('x')).rejects.toThrow(/not implemented/);
    await expect(engine.replyQuestion('x', 'q', {})).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    await expect(engine.replyPermission('x', 'q', 'once')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    await expect(engine.pauseStep('x', 's')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    await expect(engine.resumeStep('x', 's')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    await expect(engine.pauseAllSteps('x')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    await expect(engine.resumeAllSteps('x')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    await expect(engine.retryStep('x', 's', 'continue', 'm')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });
});

describe('SandoreEngineRuntime startInstance', () => {
  it('throws when the workflowId does not exist and leaves the state table empty', async () => {
    const { engine, persistence } = await harness();
    let caught: unknown;
    try {
      engine.startInstance({ workflowId: 'wfl-none', jobId: 'job-1', originalInput: 'x' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SandoreError);
    expect(persistence.state.size).toBe(0);
  });

  it('returns a run whose state is immediately readable via getState', async () => {
    const { engine, persistence } = await harness();
    await putDefinition(persistence, 'wfl-linear', linearYaml);

    const run = engine.startInstance({ workflowId: 'wfl-linear', jobId: 'job-1', originalInput: 'hello world' });
    expect(run.status).toBe('running');

    const state = engine.getState(run.instanceId);
    expect(state.originalInput).toBe('hello world');
    expect(['pending', 'running']).toContain(state.status);
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

    const run = engine.startInstance({ workflowId: 'wfl-linear', jobId: 'job-1', originalInput: 'do it' });
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

    // prompt 成功：step-completed 事件 payload 的 output 即聚合 ContentBlock[]。
    const promptCompleted = records.find(record => record.name === 'sandore/step-completed' && record.args[1] === 'step-prompt');
    expect(promptCompleted?.args[3]).toEqual([{ type: 'text', text: 'summary' }]);

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
    const run = engine.startInstance({ workflowId: 'wfl-multi', jobId: 'job-1', originalInput: 'do it' });
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
    const run = engine.startInstance({ workflowId: 'wfl-linear', jobId: 'job-1', originalInput: 'do it' });
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
    const run = engine.startInstance({ workflowId: 'wfl-linear', jobId: 'job-1', originalInput: 'do it' });
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
    const run = engine.startInstance({ workflowId: 'wfl-linear', jobId: 'job-1', originalInput: 'do it' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('failed');
    expect(state?.executedSteps[0]?.error).toContain('boom');
    expect(records.some(record => record.name === 'sandore/step-failed')).toBe(true);
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
    const run = engine.startInstance({ workflowId: 'wfl-two-shell', jobId: 'job-1', originalInput: 'do it' });
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
    const run = engine.startInstance({ workflowId: 'wfl-linear', jobId: 'job-1', originalInput: 'do it' });
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

    const run = engine.startInstance({ workflowId: 'wfl-linear', jobId: 'job-1', originalInput: 'do it' });
    await stepStarted;
    await engine.abortInstance(run.instanceId);
    await aborted;

    expect(records.some(record => record.name === 'sandore/aborted')).toBe(true);
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
    const run = engine.startInstance({ workflowId: 'wfl-linear', jobId: 'job-1', originalInput: 'do it' });
    await ended;

    await expect(engine.abortInstance(run.instanceId)).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });
});

describe('SandoreEngineRuntime DAG execution', () => {
  it('routes branches, runs the loop, extracts pass-through vars and passes the gate to completed', async () => {
    const { ctx, engine, persistence, llm, shell, agents } = await harness();
    await putDefinition(persistence, 'wfl-dag', dagYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);

    // 分支评估 → agent 执行 → prompt 执行 → 收尾 assess → 门禁（按序供给 chunk 流）。
    const responses = [
      '{"branchExpectation": "agent"}',
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
    const run = engine.startInstance({ workflowId: 'wfl-dag', jobId: 'job-1', originalInput: 'do it' });
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

    // 分支决策点保留 branchMeta 评估现场。
    const branchEntry = state?.executedSteps.find(step => step.stepId === 'step-branch');
    expect(branchEntry?.branchMeta?.status).toBe('completed');
    expect(branchEntry?.branchMeta?.result).toBe('{"branchExpectation": "agent"}');
    expect(branchEntry?.branchMeta?.expectation).toBe('agent');

    // agent Step：真实 childId（synthetic:false）+ 子代理最终输出。
    const agentStep = state?.executedSteps.find(step => step.stepId === 'step-agent');
    expect(agentStep?.sessionMeta).toEqual({ childId: 'child-1', synthetic: false, command: 'agent' });
    expect(agentStep?.output).toEqual([{ type: 'text', text: 'agent output' }]);

    // 循环：3 次扁平迭代，loopIteration 嵌套路径 + 4 位 hex 后缀 id。
    const iterations = state?.executedSteps.filter(step => step.stepId === 'step-iter') ?? [];
    expect(iterations.map(step => step.loopIteration)).toEqual([[1], [2], [3]]);
    expect(iterations[0]?.id).toMatch(/^step-iter-[0-9a-f]{4}$/);
    expect(iterations[2]?.visitCount).toBe(3);

    // 透传变量回写：finalize 提取 projectName 并保留 description。
    expect(state?.passThroughVars['projectName']).toEqual({ value: 'sandore', description: '项目名' });

    // 门禁通过：finalizeMeta 记录 gateResult。
    const finalizeStep = state?.executedSteps.find(step => step.stepId === 'step-finalize');
    expect(finalizeStep?.finalizeMeta?.gateResult?.gatesPassed).toBe(true);
    expect(finalizeStep?.finalizeMeta?.completionType).toBe('completed');

    // agent Step 的 step-completed 事件载荷：真实 childId + 最终 output。
    const agentCompleted = records.find(record => record.name === 'sandore/step-completed' && record.args[1] === 'step-agent');
    expect(agentCompleted?.args[2]).toBe('child-1');
    expect(agentCompleted?.args[3]).toEqual([{ type: 'text', text: 'agent output' }]);

    // 两 Stage 均 completed，契约落盘。
    expect(state?.stageInfos.map(info => info.status)).toEqual(['completed', 'completed']);
    expect(Object.keys(state?.stageContracts ?? {})).toHaveLength(2);
  });

  it('falls back to node.next and preserves branchMeta when no branch matches', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-branch-fallback', branchFallbackYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('{"branchExpectation": "other"}');

    const ended = waitForEnd(ctx);
    const run = engine.startInstance({ workflowId: 'wfl-branch-fallback', jobId: 'job-1', originalInput: 'do it' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');

    // 无匹配 → 回退 node.next（step-fallback），匹配分支未执行。
    const stepIds = state?.executedSteps.map(step => step.stepId);
    expect(stepIds).toEqual(['step-branch', 'step-fallback']);
    expect(stepIds?.filter(id => id === 'step-matched')).toHaveLength(0);

    // branchMeta 保留原始评估结果。
    const branchEntry = state?.executedSteps.find(step => step.stepId === 'step-branch');
    expect(branchEntry?.branchMeta?.status).toBe('completed');
    expect(branchEntry?.branchMeta?.result).toBe('{"branchExpectation": "other"}');
    expect(branchEntry?.branchMeta?.expectation).toBe('other');
  });

  it('executes nested loops fully on every outer iteration (inner loop visitCount resets)', async () => {
    const { ctx, engine, persistence, shell } = await harness();
    await putDefinition(persistence, 'wfl-nested-loop', nestedLoopYaml);
    shell.runHandler = async spec => successResult(spec, 'iter');

    const ended = waitForEnd(ctx);
    const run = engine.startInstance({ workflowId: 'wfl-nested-loop', jobId: 'job-1', originalInput: 'do it' });
    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');

    // 内层循环体在每个外层迭代中均完整执行 2 次（而非第 2 次外层迭代时提前跳出），
    // loopIteration 路径为嵌套数组 [[1,1],[1,2],[2,1],[2,2]]。
    const iterations = state?.executedSteps.filter(step => step.stepId === 'step-iter') ?? [];
    expect(iterations.map(step => step.loopIteration)).toEqual([[1, 1], [1, 2], [2, 1], [2, 2]]);
  });

  it('writes loopMeta to executedSteps when a breakCondition breaks the loop', async () => {
    const { ctx, engine, persistence, llm, shell } = await harness();
    await putDefinition(persistence, 'wfl-loop-break', loopBreakYaml);
    shell.runHandler = async spec => successResult(spec, 'iter');
    llm.providers.push({ id: 'p', name: 'Provider' });
    llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
    llm.streamHandler = () => textChunks('{"shouldBreak": true}');

    const ended = waitForEnd(ctx);
    const run = engine.startInstance({ workflowId: 'wfl-loop-break', jobId: 'job-1', originalInput: 'do it' });
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
