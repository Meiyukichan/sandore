/**
 * lifecycle-manager.ts（LifecycleManager）与引擎接线的集成/单元测试：单步/全局
 * 暂停与恢复、暂停登记表、幂等 no-op、非法操作与中止传播。
 * @module @deepseek-ai/dsh-sandore-workflow/src/lifecycle-manager.spec
 */
import { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { describe, expect, it, vi } from 'vitest';

import { assistantMessageEvent, FakeAgent, FakeAgentRegistry } from '../tests/mocks/agents.ts';
import { FakeLlm, textChunks } from '../tests/mocks/llm.ts';
import { FakeSessionStore } from '../tests/mocks/sessions.ts';
import { FakeShell, successResult } from '../tests/mocks/shell.ts';
import { MemoryStorageDomain } from '../tests/mocks/storage-domain.ts';
import { FakeSubagents } from '../tests/mocks/subagents.ts';
import { FakeSubprocess } from '../tests/mocks/subprocess.ts';
import { FakeUserQuestions } from '../tests/mocks/user-questions.ts';
import SandoreEngineRuntime, { SandoreError } from './index.ts';
import type { SandoreConfig, SandoreEngine, WorkflowTaskState } from './index.ts';
import { LifecycleManager } from './lifecycle-manager.ts';
import { SandorePersistence } from './persistence.ts';
import type { ShellExecutor } from './shell.ts';
import { parseWorkflowYaml } from './yaml-parser.ts';

/** 两 Step（shell → agent）定义：shell 立即完成、agent 子代理可挂起（暂停目标）。 */
const pauseYaml = `id: wfl-pause
name: pause
version: "1.0.0"
stages:
  - id: stg-1
    name: 处理
    steps:
      - id: step-shell
        command:
          type: shell
          value:
            command: "echo ok"
      - id: step-agent
        command:
          type: agent
          value:
            promptText: "do-work"
`;

/** 单 Step prompt 定义（prompt Step 为合成 sessionMeta，用于非子代理暂停守卫测试）。 */
const promptYaml = `id: wfl-prompt
name: prompt
version: "1.0.0"
stages:
  - id: stg-1
    name: 提示
    steps:
      - id: step-prompt
        command:
          type: prompt
          value:
            promptText: "do it"
`;

/** 可手动 resolve/reject 的挂起 Promise（模拟子代理 whenIdle 挂起或取消）。 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('shell', shell as unknown as ShellExecutor);
  ctx.provide('sessions', sessions as unknown as SessionStore);
  ctx.provide('sessionPersistence', {});
  ctx.provide('subagents', subagents);
  ctx.provide('agents', agents);
  ctx.provide('subprocess', subprocess);
  ctx.provide('userQuestions', userQuestions);
  ctx.provide('fs', {});

  await ctx.plugin(SandoreEngineRuntime, config);
  const engine = ctx.sandoreEngine;
  return { ctx, engine, persistence, llm, shell, sessions, subagents, agents, userQuestions };
}

/** 配置 agent Step 可解析的 provider/model 目录（resolveProviderModel L3 兜底）。 */
function provideLlmDirectory(llm: FakeLlm): void {
  llm.providers.push({ id: 'p', name: 'Provider' });
  llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }]);
}

/** 注册 pause/resume 相关 sandore/* 监听器并记录事件（名称 + 参数）。 */
function recordSandoreEvents(ctx: Context): Array<{ name: string; args: unknown[] }> {
  const records: Array<{ name: string; args: unknown[] }> = [];
  ctx.on('sandore/step-paused', (info, stepId, childId) => records.push({ name: 'sandore/step-paused', args: [info, stepId, childId] }));
  ctx.on('sandore/step-resumed', (info, stepId, childId, resumePrompt) => records.push({ name: 'sandore/step-resumed', args: [info, stepId, childId, resumePrompt] }));
  ctx.on('sandore/step-completed', (info, stepId, childId, output) => records.push({ name: 'sandore/step-completed', args: [info, stepId, childId, output] }));
  ctx.on('sandore/step-failed', (info, stepId, childId, error) => records.push({ name: 'sandore/step-failed', args: [info, stepId, childId, error] }));
  ctx.on('sandore/aborted', info => records.push({ name: 'sandore/aborted', args: [info] }));
  return records;
}

/** 等待指定 stepId 的 `sandore/step-start`（确认该 Step 已开始执行）。 */
function waitForStepId(ctx: Context, stepId: string): Promise<void> {
  return new Promise(resolve => {
    const off = ctx.on('sandore/step-start', (_info, id) => {
      if (id === stepId) {
        off();
        resolve();
      }
    });
  });
}

/** 等待一次 `sandore/aborted`（以事件为信号）。 */
function waitForAborted(ctx: Context): Promise<void> {
  return new Promise(resolve => {
    ctx.once('sandore/aborted', () => resolve());
  });
}

/** 等待实例到达 completed/failed 终态（以 `sandore/end` 为信号）。 */
function waitForEnd(ctx: Context): Promise<void> {
  return new Promise<void>(resolve => {
    ctx.once('sandore/end', () => resolve());
  });
}

/** 等待指定 stepId 的 Step 在持久化快照中变为 running（确认已开始执行并落盘）。 */
async function waitForRunningStep(persistence: SandorePersistence, instanceId: string, stepId: string): Promise<void> {
  await vi.waitFor(() => {
    const step = persistence.state.get(instanceId)?.executedSteps.find(s => s.stepId === stepId);
    expect(step?.status).toBe('running');
  });
}

/** 等待子代理真实 childId 就绪（`onChildStarted` 把 running Step 的 sessionMeta 切为 real）。 */
async function waitForChildStarted(persistence: SandorePersistence, instanceId: string, stepId: string): Promise<void> {
  await vi.waitFor(() => {
    const step = persistence.state.get(instanceId)?.executedSteps.find(s => s.stepId === stepId);
    expect(step?.sessionMeta?.synthetic).toBe(false);
    expect(step?.sessionMeta?.childId).toBe('child-1');
  });
}

/** 组装最小完整状态快照（供 LifecycleManager 单元测试 readState 返回）。 */
function minimalState(overrides: Partial<WorkflowTaskState> = {}): WorkflowTaskState {
  const createdAt = new Date().toISOString();
  return {
    taskId: 'inst-1',
    jobId: 'job-1',
    workflowId: 'wfl-pause',
    cwd: '/tmp',
    status: 'running',
    originalInput: 'do it',
    currentStageId: 'stg-1',
    executedSteps: [],
    stageInfos: [],
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
    ...overrides,
  };
}

/** 挂起 agent Step 的公共准备：注册真实 childId + running 状态 + 挂起 whenIdle。 */
function prepareHangingAgent(agents: FakeAgentRegistry, status: 'idle' | 'running' = 'running'): { child: FakeAgent; gate: ReturnType<typeof deferred<void>> } {
  const child = new FakeAgent('child-1');
  child.status = status;
  const gate = deferred<void>();
  child.whenIdle = () => gate.promise;
  agents.register(child);
  return { child, gate };
}

describe('LifecycleManager pause/resume via engine', () => {
  it('pauses a running step: ancestor interrupt + registry + paused status + persisted + double event', async () => {
    const { ctx, engine, persistence, llm, shell, sessions, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    const { child, gate } = prepareHangingAgent(agents);

    const records = recordSandoreEvents(ctx);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await engine.startInstance({ workflowId: 'wfl-pause', jobId: 'job-1', originalInput: 'do it' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    await engine.pauseStep(run.instanceId, 'step-agent');

    // interrupt 以 ancestor authority 调用，目标 childId = 'child-1'。
    expect(subagents.interrupts).toHaveLength(1);
    expect(subagents.interrupts[0]?.targetSessionId).toBe('child-1');
    expect(subagents.interrupts[0]?.authority).toMatchObject({ kind: 'ancestor' });

    const state = persistence.state.get(run.instanceId);
    const paused = state?.executedSteps.find(step => step.stepId === 'step-agent');
    expect(paused?.status).toBe('paused');
    expect(paused?.pausedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(state?.pausedChildIds).toEqual(['child-1']);
    expect(state?.status).toBe('paused');

    // sandore/step-paused 双发（Cordis 载荷含 childId + 宿主 Session append）。
    const record = records.find(r => r.name === 'sandore/step-paused');
    expect(record?.args[1]).toBe('step-agent');
    expect(record?.args[2]).toBe('child-1');
    const session = sessions.get(run.instanceId);
    expect(session?.events.some(e => e.type === 'sandore/step-paused')).toBe(true);

    // 清理：让挂起的 Step 正常完成，令 run 收敛。
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    gate.resolve();
  });

  it('keeps a paused step paused (not failed) when interrupt rejects whenIdle with a cancellation error', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);

    const child = new FakeAgent('child-1');
    child.status = 'running';
    const gate = deferred<void>();
    child.whenIdle = () => gate.promise;
    agents.register(child);
    // interrupt 联动：pauseStep 的 interrupt 使 whenIdle 以取消类错误拒绝（模拟 cancel）。
    subagents.whenIdleCancels.set('child-1', () => gate.reject(new SandoreError('agent cancelled', 'CANCELLED')));

    const records = recordSandoreEvents(ctx);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await engine.startInstance({ workflowId: 'wfl-pause', jobId: 'job-1', originalInput: 'do it' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    await engine.pauseStep(run.instanceId, 'step-agent');

    // 排空微任务：让 whenIdle 的取消类错误传播到 stage-executor 的 catch 并被判定。
    await new Promise(resolve => setTimeout(resolve, 0));

    const state = persistence.state.get(run.instanceId);
    const agent = state?.executedSteps.find(step => step.stepId === 'step-agent');
    expect(agent?.status).toBe('paused');
    expect(state?.status).toBe('paused');
    expect(records.filter(record => record.name === 'sandore/step-failed')).toHaveLength(0);
  });

  it('fails a step when a cancellation error occurs without a matching pause registry entry', async () => {
    const { ctx, engine, persistence, llm, shell, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);

    const child = new FakeAgent('child-1');
    child.status = 'running';
    const gate = deferred<void>();
    child.whenIdle = () => gate.promise;
    agents.register(child);

    const records = recordSandoreEvents(ctx);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await engine.startInstance({ workflowId: 'wfl-pause', jobId: 'job-1', originalInput: 'do it' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    // 未 pauseStep（登记表未命中）：直接以取消类错误拒绝 whenIdle，应落 failed。
    gate.reject(new SandoreError('agent cancelled', 'CANCELLED'));
    await new Promise(resolve => setTimeout(resolve, 0));

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('failed');
    expect(records.filter(record => record.name === 'sandore/step-failed')).toHaveLength(1);
  });

  it('pauseStep is an idempotent no-op for an idle child (not marked paused)', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    const { child, gate } = prepareHangingAgent(agents, 'idle');

    const records = recordSandoreEvents(ctx);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await engine.startInstance({ workflowId: 'wfl-pause', jobId: 'job-1', originalInput: 'do it' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    await engine.pauseStep(run.instanceId, 'step-agent');

    expect(subagents.interrupts).toHaveLength(0);
    const state = persistence.state.get(run.instanceId);
    expect(state?.pausedChildIds).toEqual([]);
    const agent = state?.executedSteps.find(step => step.stepId === 'step-agent');
    expect(agent?.status).toBe('running');
    expect(records.some(r => r.name === 'sandore/step-paused')).toBe(false);

    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    gate.resolve();
  });

  it('pauseStep throws INVALID_OPERATION for non-existent and terminal steps', async () => {
    const { ctx, engine, persistence, llm, shell, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    const { child, gate } = prepareHangingAgent(agents);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await engine.startInstance({ workflowId: 'wfl-pause', jobId: 'job-1', originalInput: 'do it' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    await expect(engine.pauseStep(run.instanceId, 'step-nonexistent')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    await expect(engine.pauseStep(run.instanceId, 'step-shell')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });

    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    gate.resolve();
  });

  it('resumes a registered step: followup hostAgent + removed from registry + running + double event', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    const { child, gate } = prepareHangingAgent(agents);

    const records = recordSandoreEvents(ctx);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await engine.startInstance({ workflowId: 'wfl-pause', jobId: 'job-1', originalInput: 'do it' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    await engine.pauseStep(run.instanceId, 'step-agent');
    await engine.resumeStep(run.instanceId, 'step-agent', '请继续处理 X');

    // followup 以 hostAgent（id = instanceId）为 parent 发送提示。
    expect(subagents.followups).toHaveLength(1);
    expect(subagents.followups[0]?.childId).toBe('child-1');
    expect(subagents.followups[0]?.parent.id).toBe(run.instanceId);
    expect(subagents.followups[0]?.content).toEqual([{ type: 'text', text: '请继续处理 X' }]);

    const state = persistence.state.get(run.instanceId);
    const resumed = state?.executedSteps.find(step => step.stepId === 'step-agent');
    expect(resumed?.status).toBe('running');
    expect(resumed?.resumedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(resumed?.resumePrompt).toBe('请继续处理 X');
    expect(state?.pausedChildIds).toEqual([]);
    expect(state?.status).toBe('running');

    // sandore/step-resumed 双发（载荷含 childId 与 resumePrompt）。
    const record = records.find(r => r.name === 'sandore/step-resumed');
    expect(record?.args[1]).toBe('step-agent');
    expect(record?.args[2]).toBe('child-1');
    expect(record?.args[3]).toBe('请继续处理 X');

    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    gate.resolve();
  });

  it('resumeStep throws INVALID_OPERATION for a non-paused step', async () => {
    const { ctx, engine, persistence, llm, shell, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    const { child, gate } = prepareHangingAgent(agents);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await engine.startInstance({ workflowId: 'wfl-pause', jobId: 'job-1', originalInput: 'do it' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    await expect(engine.resumeStep(run.instanceId, 'step-agent')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });

    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    gate.resolve();
  });

  it('pauseAllSteps pauses only running steps and leaves completed untouched', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    const { child, gate } = prepareHangingAgent(agents);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await engine.startInstance({ workflowId: 'wfl-pause', jobId: 'job-1', originalInput: 'do it' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    await engine.pauseAllSteps(run.instanceId);

    const state = persistence.state.get(run.instanceId);
    const shellStep = state?.executedSteps.find(step => step.stepId === 'step-shell');
    const agentStep = state?.executedSteps.find(step => step.stepId === 'step-agent');
    expect(shellStep?.status).toBe('completed');
    expect(agentStep?.status).toBe('paused');
    expect(state?.pausedChildIds).toEqual(['child-1']);
    expect(subagents.interrupts).toHaveLength(1);

    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    gate.resolve();
  });

  it('resumeAllSteps follows up each registered child and clears the registry', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    const { child, gate } = prepareHangingAgent(agents);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await engine.startInstance({ workflowId: 'wfl-pause', jobId: 'job-1', originalInput: 'do it' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    await engine.pauseAllSteps(run.instanceId);
    await engine.resumeAllSteps(run.instanceId, '全部继续');

    const state = persistence.state.get(run.instanceId);
    expect(state?.pausedChildIds).toEqual([]);
    expect(state?.status).toBe('running');
    expect(subagents.followups).toHaveLength(1);
    expect(subagents.followups[0]?.childId).toBe('child-1');
    expect(subagents.followups[0]?.content).toEqual([{ type: 'text', text: '全部继续' }]);

    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    gate.resolve();
  });

  it('abortInstance interrupts registered children, marks aborted, cleans up, and rejects repeat', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    prepareHangingAgent(agents);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await engine.startInstance({ workflowId: 'wfl-pause', jobId: 'job-1', originalInput: 'do it' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    await engine.pauseStep(run.instanceId, 'step-agent');
    const interruptsBefore = subagents.interrupts.length;
    const aborted = waitForAborted(ctx);
    await engine.abortInstance(run.instanceId);
    await aborted;

    // 中止传播到登记表内全部子代理（pause 已 interrupt 一次，abort 再 interrupt 一次）。
    expect(subagents.interrupts.length).toBe(interruptsBefore + 1);
    const abortInterrupt = subagents.interrupts[subagents.interrupts.length - 1];
    expect(abortInterrupt?.targetSessionId).toBe('child-1');
    expect(abortInterrupt?.authority).toMatchObject({ kind: 'ancestor' });

    expect(persistence.state.get(run.instanceId)?.status).toBe('aborted');
    expect(engine.getState(run.instanceId).status).toBe('aborted');
    await expect(engine.abortInstance(run.instanceId)).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
  });

  it('abort during a paused wait converges the main loop (no hang) with a single aborted emission', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);

    const child = new FakeAgent('child-1');
    child.status = 'running';
    const gate = deferred<void>();
    child.whenIdle = () => gate.promise;
    agents.register(child);
    // interrupt 联动：pauseStep 的 interrupt 使挂起的 whenIdle 以取消类错误拒绝，
    // 让 stage-executor 判定 paused 并驱动主循环进入 waitForResume。
    subagents.whenIdleCancels.set('child-1', () => gate.reject(new SandoreError('agent cancelled', 'CANCELLED')));

    // 捕获 execute 异步任务的完成 Promise，用于断言主循环收敛（不悬挂）。
    let executeSettled = false;
    const runtime = engine as unknown as { execute: (instanceId: string) => Promise<void> };
    const originalExecute = runtime.execute.bind(runtime);
    vi.spyOn(runtime, 'execute').mockImplementation((instanceId: string) => {
      const done = originalExecute(instanceId);
      void done.then(() => {
        executeSettled = true;
      });
      return done;
    });

    const records = recordSandoreEvents(ctx);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await engine.startInstance({ workflowId: 'wfl-pause', jobId: 'job-1', originalInput: 'do it' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    await engine.pauseStep(run.instanceId, 'step-agent');
    // 排空微任务：让 whenIdle 取消类错误传播到 stage-executor 并被判定为 paused，
    // 主循环随后进入 waitForResume 等待。
    await new Promise(resolve => setTimeout(resolve, 0));

    const pausedState = persistence.state.get(run.instanceId);
    expect(pausedState?.executedSteps.find(s => s.stepId === 'step-agent')?.status).toBe('paused');
    expect(pausedState?.status).toBe('paused');

    const aborted = waitForAborted(ctx);
    await engine.abortInstance(run.instanceId);
    await aborted;

    // 主循环收敛：waitForResume 被 abort 唤醒，execute 异步任务正常返回（不悬挂）。
    await vi.waitFor(() => {
      expect(executeSettled).toBe(true);
    });

    // sandore/aborted 仍恰好一次（abortInstance 显式发射，主循环 aborted 兜底不双发）。
    expect(records.filter(r => r.name === 'sandore/aborted')).toHaveLength(1);
    // 实例终态 aborted。
    expect(persistence.state.get(run.instanceId)?.status).toBe('aborted');
    expect(engine.getState(run.instanceId).status).toBe('aborted');
  });
});

describe('LifecycleManager pause/resume full loop', () => {
  it('resumes a paused subagent step to completed and advances the DAG (sandore/step-completed)', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);

    const child = new FakeAgent('child-1');
    child.status = 'running';
    const gate = deferred<void>();
    let idleCalls = 0;
    child.whenIdle = () => {
      idleCalls += 1;
      if (idleCalls === 1) {
        return gate.promise; // 首次：挂起，等待 pauseStep 的 interrupt 取消。
      }
      return Promise.resolve(); // 恢复后：立即 idle（最终输出已由测试注入）。
    };
    agents.register(child);
    // interrupt 联动：pauseStep 的 interrupt 使挂起的 whenIdle 以取消类错误拒绝。
    subagents.whenIdleCancels.set('child-1', () => gate.reject(new SandoreError('agent cancelled', 'CANCELLED')));

    const records = recordSandoreEvents(ctx);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const ended = waitForEnd(ctx);
    const run = await engine.startInstance({ workflowId: 'wfl-pause', jobId: 'job-1', originalInput: 'do it' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    await engine.pauseStep(run.instanceId, 'step-agent');
    // 排空微任务：让 whenIdle 取消类错误传播到 stage-executor 并被判定为 paused。
    await new Promise(resolve => setTimeout(resolve, 0));

    const pausedState = persistence.state.get(run.instanceId);
    expect(pausedState?.executedSteps.find(s => s.stepId === 'step-agent')?.status).toBe('paused');

    // 注入最终输出后 resume：Step 应续跑到 completed 并推进 DAG 至实例 completed。
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'resumed output' }]));
    await engine.resumeStep(run.instanceId, 'step-agent', '请继续');

    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    const agentStep = state?.executedSteps.find(s => s.stepId === 'step-agent');
    expect(agentStep?.status).toBe('completed');
    expect(agentStep?.output).toEqual([{ type: 'text', text: 'resumed output' }]);
    expect(state?.stageInfos[0]?.status).toBe('completed');

    const completed = records.find(r => r.name === 'sandore/step-completed' && r.args[1] === 'step-agent');
    expect(completed?.args[2]).toBe('child-1');
    expect(completed?.args[3]).toEqual([{ type: 'text', text: 'resumed output' }]);
  });
});

describe('LifecycleManager non-subagent pause guard', () => {
  it('pauseStep throws INVALID_OPERATION for a running prompt step (not marked paused)', async () => {
    const { ctx, engine, persistence, llm, shell, subagents } = await harness();
    await putDefinition(persistence, 'wfl-prompt', promptYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    const gate = deferred<void>();
    llm.streamHandler = () => (async function* () {
      await gate.promise;
      yield* textChunks('done');
    })();

    const stepStarted = waitForStepId(ctx, 'step-prompt');
    const run = await engine.startInstance({ workflowId: 'wfl-prompt', jobId: 'job-1', originalInput: 'do it' });
    await stepStarted;
    await waitForRunningStep(persistence, run.instanceId, 'step-prompt');

    await expect(engine.pauseStep(run.instanceId, 'step-prompt')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });

    const state = persistence.state.get(run.instanceId);
    const promptStep = state?.executedSteps.find(s => s.stepId === 'step-prompt');
    expect(promptStep?.status).toBe('running');
    expect(state?.pausedChildIds).toEqual([]);
    expect(subagents.interrupts).toHaveLength(0);

    gate.resolve();
  });

  it('pauseAllSteps skips a running prompt step (not marked paused)', async () => {
    const { ctx, engine, persistence, llm, shell, subagents } = await harness();
    await putDefinition(persistence, 'wfl-prompt', promptYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    const gate = deferred<void>();
    llm.streamHandler = () => (async function* () {
      await gate.promise;
      yield* textChunks('done');
    })();

    const stepStarted = waitForStepId(ctx, 'step-prompt');
    const run = await engine.startInstance({ workflowId: 'wfl-prompt', jobId: 'job-1', originalInput: 'do it' });
    await stepStarted;
    await waitForRunningStep(persistence, run.instanceId, 'step-prompt');

    await engine.pauseAllSteps(run.instanceId);

    const state = persistence.state.get(run.instanceId);
    const promptStep = state?.executedSteps.find(s => s.stepId === 'step-prompt');
    expect(promptStep?.status).toBe('running');
    expect(state?.pausedChildIds).toEqual([]);
    expect(subagents.interrupts).toHaveLength(0);

    gate.resolve();
  });
});

describe('LifecycleManager registry', () => {
  it('reconstructs the in-memory registry from snapshot pausedChildIds', () => {
    const manager = new LifecycleManager({
      hostAgent: new FakeAgent('host'),
      initialPausedChildIds: ['child-1', 'child-2'],
      interrupt: () => {},
      followup: async () => {},
      getAgent: () => undefined,
      signal: new AbortController().signal,
      readState: () => minimalState(),
      commitState: () => {},
      emitStepPaused: () => {},
      emitStepResumed: () => {},
    });
    expect(manager.hasPaused('child-1')).toBe(true);
    expect(manager.hasPaused('child-2')).toBe(true);
    expect(manager.pausedIds).toEqual(['child-1', 'child-2']);
  });
});
