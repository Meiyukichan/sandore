/**
 * lifecycle-manager.ts（LifecycleManager）与引擎接线的集成/单元测试：单步/全局
 * 暂停与恢复、暂停登记表、幂等 no-op、非法操作与中止传播。
 * @module @meiyukichan/dsh-sandore/workflow/src/lifecycle-manager.spec
 */
import { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { describe, expect, it, vi } from 'vitest';

import { assistantMessageEvent, FakeAgent, FakeAgentRegistry } from '../tests/mocks/agents.ts';
import { FakeLlm, textChunks } from '../tests/mocks/llm.ts';
import { FakeSessionStore } from '../tests/mocks/sessions.ts';
import { FakeSessionTitle } from '../tests/mocks/session-title.ts';
import { FakeShell, successResult } from '../tests/mocks/shell.ts';
import { MemoryStorageDomain } from '../tests/mocks/storage-domain.ts';
import { FakeSubagents } from '../tests/mocks/subagents.ts';
import { FakeSubprocess } from '../tests/mocks/subprocess.ts';
import { FakeUserQuestions } from '../tests/mocks/user-questions.ts';
import { SandoreEngineRuntime, SandoreError } from './index.ts';
import type { DagRun, DagStartRequest, SandoreConfig, SandoreEngine, WorkflowTaskState } from './index.ts';
import { LifecycleManager } from './lifecycle-manager.ts';
import { SandorePersistence } from './persistence.ts';
import type { ShellExecutor } from './shell.ts';
import { parseWorkflowYaml } from './yaml-parser.ts';

/**
 * 启动实例并让它真正跑起来（入口归一后 `startInstance` 只做第一阶段）。
 *
 * 架构决策 1：`startInstance` = 建真实顶层会话 + 绑定（id ≡ 会话 id）+ 注入协作上下文，
 * 返回 `{instanceId, status:'pending'}`；执行由该会话调用 `sandore_workflow_run`
 * （引擎 `runInstanceInSession`）触发。本 helper 串起两阶段，语义等价于「宿主会话发起 run」。
 */
async function startWorkflow(engine: SandoreEngine, request: DagStartRequest): Promise<DagRun> {
  const run = await engine.startInstance(request);
  return await engine.runInstanceInSession(run.instanceId, request);
}

/** 两 Step（shell → agent）定义：shell 立即完成、agent 子代理可挂起（暂停目标）。 */
const pauseYaml = `id: wfl-pause
name: pause
version: "1.0.0"
stages:
  - id: stg-1
    name: 处理
    steps:
      - id: step-shell
      - id: step-agent
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

/** 单 Step prompt 定义（prompt Step 为真实可续接子代理（决策 D3），用于暂停测试）。 */
const promptYaml = `id: wfl-prompt
name: prompt
version: "1.0.0"
stages:
  - id: stg-1
    name: 提示
    steps:
      - id: step-prompt
steps:
  - id: step-prompt
    command:
      type: prompt
      value:
        promptText: "do it"
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
  const agents = new FakeAgentRegistry(sessions);
  const subagents = new FakeSubagents(ctx, (id) => agents.get(id));
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
  ctx.provide('sessionTitle', new FakeSessionTitle());
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
  ctx.on('sandore/step-paused', (info, stepId, childId, name, loopIteration) => records.push({ name: 'sandore/step-paused', args: [info, stepId, childId, name, loopIteration] }));
  ctx.on('sandore/step-resumed', (info, stepId, childId, resumePrompt, name, loopIteration) => records.push({ name: 'sandore/step-resumed', args: [info, stepId, childId, resumePrompt, name, loopIteration] }));
  ctx.on('sandore/step-completed', (info, stepId, childId, output, name, loopIteration) => records.push({ name: 'sandore/step-completed', args: [info, stepId, childId, output, name, loopIteration] }));
  ctx.on('sandore/step-failed', (info, stepId, childId, error, name, loopIteration) => records.push({ name: 'sandore/step-failed', args: [info, stepId, childId, error, name, loopIteration] }));
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

/** 挂起 agent Step 的公共准备：注册真实 childId + running 状态。settle 路径下子代理经
 *  `awaitSubagentSettlement` 挂起（pending `sandore/subagent-settled`），不再依赖 `whenIdle`。 */
function prepareHangingAgent(agents: FakeAgentRegistry, status: 'idle' | 'running' = 'running'): FakeAgent {
  const child = new FakeAgent('child-1');
  child.status = status;
  agents.register(child);
  return child;
}

/** 排空微任务：让 settle 事件 → collectSubagentOutput → stage-executor catch 传播完成。 */
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('LifecycleManager pause/resume via engine', () => {
  it('pauses a running step: ancestor interrupt + registry + paused status + persisted + double event', async () => {
    const { ctx, engine, persistence, llm, shell, sessions, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    const child = prepareHangingAgent(agents);

    const records = recordSandoreEvents(ctx);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await startWorkflow(engine, { workflowId: 'wfl-pause', originalInput: 'do it', cwd: '/tmp' });
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

    // sandore/step-paused 单发（Cordis 载荷含 childId；Round 25 去污染：宿主会话不再承载）。
    const record = records.find(r => r.name === 'sandore/step-paused');
    expect(record?.args[1]).toBe('step-agent');
    expect(record?.args[2]).toBe('child-1');
    expect(record?.args[3]).toBe('step-agent');
    expect(record?.args[4]).toBeUndefined();

    // 清理：让挂起的 Step settle 完成（pauseStep 的 interrupt 已 settle aborted 使 run 收敛为
    // paused；此处显式 settle completed 令残余 awaiter 释放，避免悬挂 run）。
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    subagents.settleChild('child-1', 'completed');
    await flushMicrotasks();
  });

  it('keeps a paused step paused (not failed) when interrupt settles aborted', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);

    // settle 路径下子代理经 awaitSubagentSettlement 挂起；interrupt 自动 settle(aborted)。
    const child = new FakeAgent('child-1');
    child.status = 'running';
    agents.register(child);

    const records = recordSandoreEvents(ctx);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await startWorkflow(engine, { workflowId: 'wfl-pause', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    await engine.pauseStep(run.instanceId, 'step-agent');

    // 排空微任务：让 interrupt→settle(aborted)→STEP_PAUSED→stage-executor catch 传播完成。
    await flushMicrotasks();

    const state = persistence.state.get(run.instanceId);
    const agent = state?.executedSteps.find(step => step.stepId === 'step-agent');
    expect(agent?.status).toBe('paused');
    expect(state?.status).toBe('paused');
    expect(records.filter(record => record.name === 'sandore/step-failed')).toHaveLength(0);
  });

  it('fails a step when the child settles with error (no matching pause) ', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);

    const child = new FakeAgent('child-1');
    child.status = 'running';
    agents.register(child);

    const records = recordSandoreEvents(ctx);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await startWorkflow(engine, { workflowId: 'wfl-pause', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    // 未 pauseStep：子代理 settle(error)（非 aborted）→ collectSubagentOutput 抛 STEP_EXECUTION → failed。
    subagents.settleChild('child-1', 'error');
    await flushMicrotasks();

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('failed');
    expect(records.filter(record => record.name === 'sandore/step-failed')).toHaveLength(1);
  });

  it('pauseStep is an idempotent no-op for an idle child (not marked paused)', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    const child = prepareHangingAgent(agents, 'running');

    const records = recordSandoreEvents(ctx);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await startWorkflow(engine, { workflowId: 'wfl-pause', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    // settle 路径下 child 用 'running' 注册（避免 startContinuable 的 idle auto-settle
    // 使 Step 提前 fail）；pauseStep 前切 'idle' 模拟「子代理恰在 interrupt 前空闲」的
    // 竞态窗口，验证 pauseStep 的 idle 幂等 no-op（不 interrupt、不误标 paused）。
    child.status = 'idle';
    await engine.pauseStep(run.instanceId, 'step-agent');

    expect(subagents.interrupts).toHaveLength(0);
    const state = persistence.state.get(run.instanceId);
    expect(state?.pausedChildIds).toEqual([]);
    const agent = state?.executedSteps.find(step => step.stepId === 'step-agent');
    expect(agent?.status).toBe('running');
    expect(records.some(r => r.name === 'sandore/step-paused')).toBe(false);

    // 清理：idle child 未被 interrupt；显式 settle completed 令挂起 Step 收敛。
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    subagents.settleChild('child-1', 'completed');
    await flushMicrotasks();
  });

  it('pauseStep throws INVALID_OPERATION for non-existent and terminal steps', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    const child = prepareHangingAgent(agents);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await startWorkflow(engine, { workflowId: 'wfl-pause', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    await expect(engine.pauseStep(run.instanceId, 'step-nonexistent')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    await expect(engine.pauseStep(run.instanceId, 'step-shell')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });

    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    subagents.settleChild('child-1', 'completed');
    await flushMicrotasks();
  });

  it('resumes a registered step: followup hostAgent + removed from registry + running + double event', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    const child = prepareHangingAgent(agents);

    const records = recordSandoreEvents(ctx);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await startWorkflow(engine, { workflowId: 'wfl-pause', originalInput: 'do it', cwd: '/tmp' });
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
    // 段模型：resumeStep 只负责 followup/移表/消息/事件，不建段——被暂停段保持 paused
    // 定格快照，新执行段由执行器续跑（resumePendingPaused）时创建。
    const resumed = state?.executedSteps.find(step => step.stepId === 'step-agent');
    expect(resumed?.status).toBe('paused');
    expect(resumed?.pausedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(state?.pausedChildIds).toEqual([]);
    expect(state?.status).toBe('running');

    // sandore/step-resumed 双发（载荷含 childId 与 resumePrompt）。
    const record = records.find(r => r.name === 'sandore/step-resumed');
    expect(record?.args[1]).toBe('step-agent');
    expect(record?.args[2]).toBe('child-1');
    expect(record?.args[3]).toBe('请继续处理 X');
    expect(record?.args[4]).toBe('step-agent');

    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    subagents.settleChild('child-1', 'completed');
    await flushMicrotasks();
  });

  it('resumeStep throws INVALID_OPERATION for a non-paused step', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    const child = prepareHangingAgent(agents);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await startWorkflow(engine, { workflowId: 'wfl-pause', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    await expect(engine.resumeStep(run.instanceId, 'step-agent')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });

    child.session.append(assistantMessageEvent([{ type: 'text', text: 'done' }]));
    subagents.settleChild('child-1', 'completed');
    await flushMicrotasks();
  });

  it('pauseAllSteps pauses only running steps and leaves completed untouched', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    const child = prepareHangingAgent(agents);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await startWorkflow(engine, { workflowId: 'wfl-pause', originalInput: 'do it', cwd: '/tmp' });
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
    subagents.settleChild('child-1', 'completed');
    await flushMicrotasks();
  });

  it('resumeAllSteps follows up each registered child and clears the registry', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    const child = prepareHangingAgent(agents);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await startWorkflow(engine, { workflowId: 'wfl-pause', originalInput: 'do it', cwd: '/tmp' });
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
    subagents.settleChild('child-1', 'completed');
    await flushMicrotasks();
  });

  it('abortInstance interrupts registered children, marks aborted, cleans up, and rejects repeat', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    prepareHangingAgent(agents);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await startWorkflow(engine, { workflowId: 'wfl-pause', originalInput: 'do it', cwd: '/tmp' });
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
    agents.register(child);
    // settle 路径下：pauseStep 的 interrupt 自动 settle(aborted) → STEP_PAUSED →
    // stage-executor 判定 paused 并驱动主循环进入 waitForResume 等待。

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
    const run = await startWorkflow(engine, { workflowId: 'wfl-pause', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    await engine.pauseStep(run.instanceId, 'step-agent');
    // 排空微任务：让 interrupt→settle(aborted)→STEP_PAUSED 传播到 stage-executor 并判为 paused，
    // 主循环随后进入 waitForResume 等待。
    await flushMicrotasks();

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
    agents.register(child);
    // settle 路径：pauseStep → interrupt 自动 settle(aborted) → paused；resume → followup
    // (cold-resume) → 测试 settleChild(completed) 令续跑收敛，最终输出由 child.session 注入。

    const records = recordSandoreEvents(ctx);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-pause', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    await engine.pauseStep(run.instanceId, 'step-agent');
    // 排空微任务：让 interrupt→settle(aborted)→STEP_PAUSED 传播并判为 paused。
    await flushMicrotasks();

    const pausedState = persistence.state.get(run.instanceId);
    expect(pausedState?.executedSteps.find(s => s.stepId === 'step-agent')?.status).toBe('paused');

    // 注入最终输出后 resume：Step 应续跑到 completed 并推进 DAG 至实例 completed。
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'resumed output' }]));
    await engine.resumeStep(run.instanceId, 'step-agent', '请继续');
    // resume 的 followup（cold-resume）后 settle completed 令续跑收敛。
    subagents.settleChild('child-1', 'completed');

    await ended;

    const state = persistence.state.get(run.instanceId);
    expect(state?.status).toBe('completed');
    // 段模型：resumeStep 后 executor 续跑创建新段（attemptIndex 1），旧 paused 段保持定格。
    const agentSteps = state?.executedSteps.filter(s => s.stepId === 'step-agent') ?? [];
    expect(agentSteps).toHaveLength(2);
    expect(agentSteps[0]?.status).toBe('paused');
    const resumedSegment = agentSteps.sort((a, b) => (b.attemptIndex ?? 0) - (a.attemptIndex ?? 0))[0];
    expect(resumedSegment?.status).toBe('completed');
    expect(resumedSegment?.output).toEqual([{ type: 'text', text: 'resumed output' }]);
    expect(state?.stageInfos[0]?.status).toBe('completed');

    const completed = records.find(r => r.name === 'sandore/step-completed' && r.args[1] === 'step-agent');
    expect(completed?.args[2]).toBe('child-1');
    expect(completed?.args[3]).toEqual([{ type: 'text', text: 'resumed output' }]);
  });
});

describe('LifecycleManager non-subagent pause guard', () => {
  it('pauses a running prompt step (决策 D3: prompt 为真实子代理，可暂停)', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-prompt', promptYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    // prompt Step 走可续接子代理：child status='running' 不自动 settle
    // （collectSubagentOutput 挂起等待），保持 step-prompt running 供暂停测试。
    const child = new FakeAgent('child-1');
    child.status = 'running';
    agents.register(child);

    const stepStarted = waitForStepId(ctx, 'step-prompt');
    const run = await startWorkflow(engine, { workflowId: 'wfl-prompt', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-prompt');

    // prompt 与 agent/skill/mcp 同为真实子代理：pauseStep 应正常 interrupt + 登记 + paused。
    await engine.pauseStep(run.instanceId, 'step-prompt');
    await flushMicrotasks();

    const state = persistence.state.get(run.instanceId);
    expect(state?.executedSteps.find(s => s.stepId === 'step-prompt')?.status).toBe('paused');
    expect(state?.pausedChildIds).toEqual(['child-1']);
    expect(subagents.interrupts).toHaveLength(1);
    expect(subagents.interrupts[0]?.targetSessionId).toBe('child-1');
  });

  it('pauseAllSteps pauses a running prompt step (决策 D3)', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-prompt', promptYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    // prompt Step 走可续接子代理：child status='running' 不自动 settle，保持 running。
    const child = new FakeAgent('child-1');
    child.status = 'running';
    agents.register(child);

    const stepStarted = waitForStepId(ctx, 'step-prompt');
    const run = await startWorkflow(engine, { workflowId: 'wfl-prompt', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-prompt');

    await engine.pauseAllSteps(run.instanceId);
    await flushMicrotasks();

    const state = persistence.state.get(run.instanceId);
    expect(state?.executedSteps.find(s => s.stepId === 'step-prompt')?.status).toBe('paused');
    expect(state?.pausedChildIds).toEqual(['child-1']);
    expect(subagents.interrupts).toHaveLength(1);
  });
});

/**
 * 恢复（resume）与暂停落态的竞态：**resume 成功后实例 status 必须回到 running**。
 *
 * 实机 e2e（M5）现象：paused → DiscussionInput 发送恢复提示词（`resumeAll`）→
 * `sandore/step-resumed` 恰 1 次、无错误提示，但 `getInstanceState` 仍为 `paused`。
 * 三条成因（本组用例钉住前两条；第三条为同类加固）：
 *
 * - **C（根因，探针实测）**：`buildActiveInstance` 的 `sandore/subagent-settled` 监听器
 *   （workflow-engine.ts:1992-2004）在 resolver 判定**之前**无条件写 `settlementBuffer`
 *   （原实现 :1957），故 pause 的 `interrupt` 发出的 `{stopReason:'aborted'}` 虽已被在等的
 *   awaiter 消费，仍以陈旧副本残留缓冲。resume 后新段 `collectSubagentOutput` →
 *   `awaitSubagentSettlement` 直接命中该陈旧副本（探针：`BUFFER HIT child-1 aborted`，
 *   而期间并无新的 settle）→ `STEP_PAUSED`（step-runner.ts:707-710）→ stage-executor
 *   把段/实例重新判为 paused（stage-executor.ts:1405-1408）→ 实例停在 paused。
 * - **A 落态被回写**：执行器 `commitState({ status: 'paused' })`（stage-executor.ts:886 /
 *   :1407）若晚于 `resumeAllSteps` 的 `commitPausedRegistry`（lifecycle-manager.ts:208-217）
 *   写入的 `running`，内存态被打回 `paused`——与 aborted 双发同一类「落态被回写」缺陷。
 * - **B 唤醒丢失**：`resumeAllSteps` 在**无已注册 waiter** 时只置 `'*'` 标志
 *   （workflow-engine.ts:2192-2201 `resumeRequested.add`），而主循环
 *   `waitForResume(active, pausedStepId)`（:2169）只查具体 stepId key、从不消费 `'*'` →
 *   恢复手势先于暂停落态到达时（子代理 settle 慢于用户点击）唤醒被永久丢弃。修复：
 *   `resumeAllSteps`（:1033）先按登记表 childId 反查各 Step 的对外 stepId，恢复后对这些
 *   key 逐个 notifyResume——与主循环 parked 时的 key 同源。
 */
describe('LifecycleManager resume vs 暂停落态竞态', () => {
  /** 真实时序排空：settle 消费 → 执行器落态 → 主循环等待/唤醒 → 续跑均为异步链。 */
  async function drainLoop(): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  it('resume 手势先于暂停落态到达：实例终态仍回 running、step-resumed 恰一次、段被续跑', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    const child = prepareHangingAgent(agents);

    const records = recordSandoreEvents(ctx);
    let instanceId = '';
    ctx.on('sandore/start', info => { instanceId = info.taskId; });
    // step-start 在 `onStepStart` 处发出（stage-executor.ts:854），**早于** 执行器注册
    // settle awaiter（`runner.resumeSubagent` → collectSubagentOutput）——故此处同步暂停：
    // interrupt 的 settle(aborted) 落入引擎 settle 缓冲（无 awaiter），紧接着同步发起
    // resume 手势（= e2e 实机「用户点击发送早于子代理 settle」的确定性版本）。
    const stepStarted = waitForStepId(ctx, 'step-agent');
    ctx.on('sandore/step-start', (_info, stepId) => {
      if (stepId !== 'step-agent') return;
      void engine.pauseAllSteps(instanceId);
      void engine.resumeAllSteps(instanceId, '继续');
    });

    const ended = waitForEnd(ctx);
    const run = await startWorkflow(engine, { workflowId: 'wfl-pause', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await drainLoop();

    // 恢复手势自身只投递一次（不因竞态重复）。
    expect(records.filter(r => r.name === 'sandore/step-resumed')).toHaveLength(1);
    expect(subagents.followups).toHaveLength(1);
    expect(subagents.followups[0]?.childId).toBe('child-1');
    // 实例状态回到 running（内存态 = UI `getInstanceState` 读取面）。
    expect(engine.getState(run.instanceId).status).toBe('running');
    expect(persistence.state.get(run.instanceId)?.status).toBe('running');
    // 续跑入口确实被驱动：resumePendingPaused 基于旧段新建段（attemptIndex 1）——且**只建一个**
    // （陈旧 settle 若被续跑段消费，会出现 attemptIndex 1 = paused + attemptIndex 2 的多余重试段）。
    const segments = engine.getState(run.instanceId).executedSteps.filter(s => s.stepId === 'step-agent');
    expect(segments.map(s => [s.attemptIndex ?? 0, s.status])).toEqual([[0, 'paused'], [1, 'running']]);

    // 续跑段等待的是**新的** settle（陈旧 {aborted} 已被消费、不得复活）：子代理给出
    // 续跑产出后，工作流应真正推进到 completed（而非再次被判为 paused 卡死）。
    child.session.append(assistantMessageEvent([{ type: 'text', text: 'resumed output' }]));
    subagents.settleChild('child-1', 'completed');
    await ended;

    const finalState = persistence.state.get(run.instanceId);
    expect(finalState?.status).toBe('completed');
    const resumed = finalState?.executedSteps
      .filter(s => s.stepId === 'step-agent')
      .sort((a, b) => (b.attemptIndex ?? 0) - (a.attemptIndex ?? 0))[0];
    expect(resumed?.attemptIndex).toBe(1);
    expect(resumed?.status).toBe('completed');
    expect(records.filter(r => r.name === 'sandore/step-resumed')).toHaveLength(1);
  });

  it('正常时序（先落 paused 并驻留，再 resume）：驻留期保持 paused，resume 后回 running 并续跑', async () => {
    const { ctx, engine, persistence, llm, shell, subagents, agents } = await harness();
    await putDefinition(persistence, 'wfl-pause', pauseYaml);
    shell.runHandler = async spec => successResult(spec, 'ok');
    provideLlmDirectory(llm);
    prepareHangingAgent(agents);

    const records = recordSandoreEvents(ctx);
    const stepStarted = waitForStepId(ctx, 'step-agent');
    const run = await startWorkflow(engine, { workflowId: 'wfl-pause', originalInput: 'do it', cwd: '/tmp' });
    await stepStarted;
    await waitForChildStarted(persistence, run.instanceId, 'step-agent');

    // ① 暂停 → 排空（执行器落 paused、主循环驻留 waitForResume）→ 状态保持 paused。
    await engine.pauseAllSteps(run.instanceId);
    await drainLoop();
    expect(engine.getState(run.instanceId).status).toBe('paused');
    expect(persistence.state.get(run.instanceId)?.status).toBe('paused');
    expect(records.filter(r => r.name === 'sandore/step-paused')).toHaveLength(1);

    // ② resume → 主循环被唤醒 → running + 续跑段（attemptIndex 1）创建。
    await engine.resumeAllSteps(run.instanceId, '继续');
    await drainLoop();

    expect(records.filter(r => r.name === 'sandore/step-resumed')).toHaveLength(1);
    expect(engine.getState(run.instanceId).status).toBe('running');
    expect(persistence.state.get(run.instanceId)?.status).toBe('running');
    expect(persistence.state.get(run.instanceId)?.pausedChildIds).toEqual([]);
    // 段序列精确断言：旧段保持 paused 定格 + **恰好一个**续跑段（attemptIndex 1, running）。
    // 若陈旧 settle 被续跑段消费（根因 C），续跑段会再被判 paused 并多出一个重试段
    // （实测 [0 paused, 1 paused, 2 running]）——本断言即钉住该回归。
    const segments = engine.getState(run.instanceId).executedSteps.filter(s => s.stepId === 'step-agent');
    expect(segments.map(s => [s.attemptIndex ?? 0, s.status])).toEqual([[0, 'paused'], [1, 'running']]);
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
