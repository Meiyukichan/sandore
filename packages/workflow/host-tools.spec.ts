/**
 * 新工具面（架构决策 3）的单元测试：`sandore_workflow_run` / `sandore_workflow_status` /
 * `sandore_workflow_send_message` / `sandore_workflow_control` 的入参校验、调用会话
 * 解析、detail 投影、目标展开与「continue 按 step 状态自动选机制」。
 *
 * 全 mock（Map 背书的 persistence 视图 + fake host + fake exec），无宿主依赖。
 * @module @meiyukichan/dsh-sandore/workflow/src/host-tools.spec
 */
import { describe, expect, it, vi } from 'vitest';

import type { MicroflowRecord, StepRecord, WorkflowTaskState } from './schema.ts';
import type { ExecutedStepDefault } from './types.ts';
import type { TableView } from './manager-tool.ts';
import type { SandoreToolEnvelope, SandoreToolHost } from './tool-support.ts';
import {
  WORKFLOW_RUN_PARAMETERS,
  WORKFLOW_RUN_TOOL_DESCRIPTION,
  WORKFLOW_RUN_TOOL_NAME,
  executeRunTool,
  registerGlobalRunTool,
} from './run-tool.ts';
import {
  WORKFLOW_STATUS_PARAMETERS,
  executeStatusTool,
  registerGlobalStatusTool,
} from './status-tool.ts';
import {
  WORKFLOW_MESSAGE_PARAMETERS,
  WORKFLOW_MESSAGE_TOOL_DESCRIPTION,
  executeMessageTool,
  expandTargets,
  registerGlobalMessageTool,
} from './message-tool.ts';
import {
  WORKFLOW_CONTROL_PARAMETERS,
  WORKFLOW_CONTROL_TOOL_DESCRIPTION,
  executeControlTool,
  expandScope,
  registerGlobalControlTool,
} from './control-tool.ts';
import { WORKFLOW_MANAGER_PARAMETERS, executeManagerTool } from './manager-tool.ts';
import { registerGlobalWorkflowTools, SANDORE_WORKFLOW_TOOL_NAMES } from './host-tools.ts';
import type { Context } from '@deepseek-ai/cordis';

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Map 背书的 KvTable 最小视图。 */
function tableOf<V>(rows: Record<string, V> = {}): TableView<V> & { map: Map<string, V> } {
  const map = new Map<string, V>(Object.entries(rows));
  return {
    map,
    get: key => map.get(key),
    entries: () => map.entries(),
    put: async (key, value) => { map.set(key, value); },
  };
}

interface FixturePersistence {
  definitions: ReturnType<typeof tableOf<{ yaml: string; name: string; version: string; createdAt: string; updatedAt: string }>>;
  steps: ReturnType<typeof tableOf<StepRecord>>;
  microflows: ReturnType<typeof tableOf<MicroflowRecord>>;
  state: ReturnType<typeof tableOf<WorkflowTaskState>>;
  writeDefinitionToLibraries: ReturnType<typeof vi.fn>;
}

function makePersistence(): FixturePersistence {
  return {
    definitions: tableOf({}),
    steps: tableOf<StepRecord>({}),
    microflows: tableOf<MicroflowRecord>({}),
    state: tableOf<WorkflowTaskState>({}),
    writeDefinitionToLibraries: vi.fn(async () => {}),
  };
}

function makeState(overrides: Partial<WorkflowTaskState> = {}): WorkflowTaskState {
  return {
    taskId: 'inst-1',
    // 宿主主代理会话 id（恒等 taskId；与 makeInitialState 一致）。
    hostSessionId: 'inst-1',
    workflowId: 'wfl-1',
    cwd: '/w',
    status: 'running',
    originalInput: 'do it',
    currentStageId: 'stg-a',
    executedSteps: [],
    stageInfos: [{ id: 'stg-a', name: 'StageA', status: 'running' }],
    pendingInteractions: [],
    pendingQueue: [],
    visitCounts: {},
    passThroughVars: {},
    activeLoopIterationStack: [],
    activeLoopNodeId: null,
    activeLoopStack: [],
    pausedChildIds: [],
    stageContracts: {},
    createdAt: 't0',
    updatedAt: 't1',
    ...overrides,
  };
}

function makeExecutedStep(overrides: Partial<ExecutedStepDefault> = {}): ExecutedStepDefault {
  return {
    id: 'seg',
    stepId: 'step-1',
    stageId: 'stg-a',
    name: 'StepOne',
    status: 'completed',
    visitCount: 1,
    createdAt: 't0',
    ...overrides,
  };
}

/** 组装 fake host（记录全部调用；默认不绑定调用会话）。 */
function makeHost(persistence = makePersistence()): SandoreToolHost & {
  runCalls: Array<{ hostSessionId: string; request: unknown }>;
  sentMessages: Array<{ instanceId: string; stepId: string; message: string }>;
  controls: string[];
} {
  const runCalls: Array<{ hostSessionId: string; request: unknown }> = [];
  const sentMessages: Array<{ instanceId: string; stepId: string; message: string }> = [];
  const controls: string[] = [];
  return {
    runCalls,
    sentMessages,
    controls,
    startInstance: vi.fn(async () => ({ instanceId: 'inst-1', status: 'pending' as const })),
    runInstanceInSession: vi.fn(async (hostSessionId: string, request: unknown) => {
      runCalls.push({ hostSessionId, request });
      return { instanceId: hostSessionId, status: 'running' as const };
    }),
    getState: vi.fn(() => { throw new Error('not stubbed'); }),
    getInstanceState: vi.fn(() => undefined),
    // `step`/`messages` detail 读取期按需装饰：`sessionMessages` 已不再持久化，由引擎从
    // 各段子代理会话现算（此处直接读 mock 里预置的同名字段，等价于「会话里的真值」）。
    hydrateStateMessages: vi.fn(async (state: WorkflowTaskState) => ({
      ...state,
      executedSteps: state.executedSteps.map(step => {
        const messages = (step as { sessionMessages?: unknown[] }).sessionMessages;
        return messages === undefined ? step : { ...step, sessionMessages: messages };
      }),
    })),
    findInstanceIdByHostSession: vi.fn(() => undefined),
    pauseStep: vi.fn(async (_instanceId: string, stepId: string) => { controls.push(`pause:${stepId}`); }),
    pauseAllSteps: vi.fn(async () => { controls.push('pause:all'); }),
    resumeStep: vi.fn(async (_instanceId: string, stepId: string) => { controls.push(`resume:${stepId}`); }),
    resumeAllSteps: vi.fn(async () => { controls.push('resume:all'); }),
    retryStep: vi.fn(async (_instanceId: string, stepId: string, mode: string) => { controls.push(`retry:${stepId}:${mode}`); }),
    sendStepMessage: vi.fn(async (instanceId: string, stepId: string, message: string) => { sentMessages.push({ instanceId, stepId, message }); }),
    persistence: () => persistence,
  };
}

/** 顶层主代理调用方（gate 放行；会话 id = 宿主会话）。 */
const topLevelExec = { agent: { session: { id: 'sess-1', header: { cwd: '/w' } } } };
/** 委派子代理调用方（gate 拒绝）。 */
const subagentExec = { agent: { session: { id: 'child-1', header: { parentSession: 'sess-1' } } } };

/** `sandore_workflow`（定义/库）用的 host：未知键检查在任何业务逻辑之前，故空 persistence 足够。 */
function makeManagerHost() {
  return makeHost();
}

// ── sandore_workflow_run ──────────────────────────────────────────────────────

describe('sandore_workflow_run（唯一启动入口）', () => {
  it('starts in the CALLING session (no hostSessionId parameter at all) and defaults cwd from the session header', async () => {
    const host = makeHost();
    const result = await executeRunTool(host, { workflowId: 'wfl-1', originalInput: 'go' }, topLevelExec);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ instanceId: 'sess-1', status: 'running' });
    // 恒等式：runInstanceInSession 的宿主会话 = 调用会话；请求里没有 hostSessionId/attachSession。
    expect(host.runCalls[0]?.hostSessionId).toBe('sess-1');
    expect(host.runCalls[0]?.request).toEqual({ workflowId: 'wfl-1', originalInput: 'go', cwd: '/w' });
  });

  it('honors explicit cwd/model/permission', async () => {
    const host = makeHost();
    await executeRunTool(host, {
      workflowId: 'wfl-1',
      originalInput: 'go',
      cwd: '/other',
      model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
      permission: 'read-only',
    }, topLevelExec);
    expect(host.runCalls[0]?.request).toEqual({
      workflowId: 'wfl-1',
      originalInput: 'go',
      cwd: '/other',
      model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
      permission: 'read-only',
    });
  });

  it('rejects non-top-level callers, missing cwd, empty args and bad permission', async () => {
    const host = makeHost();
    const denied = await executeRunTool(host, { workflowId: 'wfl-1', originalInput: 'go' }, subagentExec);
    expect(denied.error).toMatchObject({ code: 'INVALID_OPERATION' });
    expect(denied.reason).toContain('顶层');
    expect(host.runCalls).toHaveLength(0);

    const noCwd = await executeRunTool(host, { workflowId: 'wfl-1', originalInput: 'go' }, { agent: { session: { id: 's1' } } });
    expect(noCwd.error).toMatchObject({ code: 'INVALID_OPERATION' });

    const noInput = await executeRunTool(host, { workflowId: 'wfl-1' }, topLevelExec);
    expect(noInput.error).toMatchObject({ code: 'INVALID_OPERATION' });

    const emptyInput = await executeRunTool(host, { workflowId: 'wfl-1', originalInput: '' }, topLevelExec);
    expect(emptyInput.error).toMatchObject({ code: 'INVALID_OPERATION' });

    const badPermission = await executeRunTool(host, { workflowId: 'wfl-1', originalInput: 'go', permission: 'root' }, topLevelExec);
    expect(badPermission.error).toMatchObject({ code: 'INVALID_OPERATION' });
  });

  it('propagates an engine SandoreError through the envelope', async () => {
    const host = makeHost();
    host.runInstanceInSession = vi.fn(async () => {
      throw Object.assign(new Error('session already hosts a non-terminal instance'), { code: 'INVALID_OPERATION' });
    });
    const result = await executeRunTool(host, { workflowId: 'wfl-1', originalInput: 'go' }, topLevelExec);
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_OPERATION' });
  });

  it('registers under the sandore_workflow_run name with workflowId/originalInput required', async () => {
    const registered: Array<{ name: string; parameters: { required: string[]; properties: Record<string, { enum?: string[] }> } }> = [];
    const ctx = { get: (name: string) => (name === 'tools' ? { register: (tool: unknown) => { registered.push(tool as never); return () => {}; } } : undefined) } as unknown as Context;
    const dispose = registerGlobalRunTool(ctx, makeHost());
    expect(dispose).toBeTypeOf('function');
    expect(registered[0]?.name).toBe(WORKFLOW_RUN_TOOL_NAME);
    expect(registered[0]?.parameters.required).toEqual(['workflowId', 'originalInput']);
    // 入参面明确没有 hostSessionId / attachSession（入口归一）。
    expect(Object.keys(registered[0]!.parameters.properties).sort()).toEqual(['cwd', 'model', 'originalInput', 'permission', 'workflowId']);
  });

  it('skips registration when the tools service is absent', () => {
    const bareCtx = { get: () => undefined } as unknown as Context;
    expect(registerGlobalRunTool(bareCtx, makeHost())).toBeTypeOf('function');
    expect(registerGlobalStatusTool(bareCtx, makeHost())).toBeTypeOf('function');
    expect(registerGlobalMessageTool(bareCtx, makeHost())).toBeTypeOf('function');
    expect(registerGlobalControlTool(bareCtx, makeHost())).toBeTypeOf('function');
  });

  it('registerGlobalWorkflowTools registers all five tools and disposes them together', () => {
    const registered: string[] = [];
    const registry = { register: (tool: unknown) => { registered.push((tool as { name: string }).name); return () => { registered.splice(registered.indexOf((tool as { name: string }).name), 1); }; } };
    const ctx = { get: (name: string) => (name === 'tools' ? registry : undefined) } as unknown as Context;
    const dispose = registerGlobalWorkflowTools(ctx, makeHost());
    expect(registered.sort()).toEqual([...SANDORE_WORKFLOW_TOOL_NAMES].sort());
    dispose();
    expect(registered).toEqual([]);
  });
});

// ── sandore_workflow_status ───────────────────────────────────────────────────

describe('sandore_workflow_status', () => {
  it('resolves the instance from the calling session when instanceId is omitted', async () => {
    const persistence = makePersistence();
    persistence.state.map.set('sess-1', makeState({ taskId: 'sess-1' }));
    const host = makeHost(persistence);
    host.findInstanceIdByHostSession = vi.fn((sessionId: string) => (sessionId === 'sess-1' ? 'sess-1' : undefined));

    const result = await executeStatusTool(host, { detail: 'summary' }, topLevelExec);
    expect(result.ok).toBe(true);
    expect(host.findInstanceIdByHostSession).toHaveBeenCalledWith('sess-1');
    expect((result.data as { instanceId: string }).instanceId).toBe('sess-1');

    // 调用会话未绑定实例：NODE_NOT_FOUND（提示可显式传 instanceId）。
    const unbound = await executeStatusTool(host, { detail: 'summary' }, { agent: { session: { id: 'other', header: { cwd: '/w' } } } });
    expect(unbound.error).toMatchObject({ code: 'NODE_NOT_FOUND' });
    expect(unbound.reason).toContain('instanceId');
  });

  it('summary: status/stage/pending interactions/failed steps; steps: capped rows', async () => {
    const persistence = makePersistence();
    const question = { id: 'q-1', stageId: 'stg-a', stepId: 'step-1', sessionId: 's1', requestId: 'rq-1', kind: 'question' as const, status: 'pending' as const, payload: { questions: [{ id: 'q1', question: 'Q?' }] }, createdAt: 't0' };
    const replied = { ...question, id: 'q-2', requestId: 'rq-2', status: 'replied' as const };
    persistence.state.map.set('inst-1', makeState({
      workflowName: 'Demo',
      executedSteps: [
        makeExecutedStep({ sessionMeta: { childId: 'child-1', synthetic: false, command: 'prompt' } }),
        makeExecutedStep({ id: 'seg-b', stepId: 'step-2', name: 'StepTwo', status: 'failed', error: 'boom' }),
      ],
      pendingInteractions: [question, replied],
    }));
    const host = makeHost(persistence);

    const summary = await executeStatusTool(host, { detail: 'summary', instanceId: 'inst-1' }, topLevelExec);
    const summaryData = summary.data as {
      workflowName?: string;
      stageInfos: unknown[];
      segmentCounts: Record<string, number>;
      pendingInteractions: Array<{ kind: string }>;
      failedSteps: Array<{ stepId: string; error?: string }>;
    };
    expect(summaryData.workflowName).toBe('Demo');
    expect(summaryData.stageInfos).toHaveLength(1);
    expect(summaryData.segmentCounts).toEqual({ completed: 1, failed: 1 });
    expect(summaryData.pendingInteractions).toHaveLength(1); // replied 过滤
    expect(summaryData.failedSteps).toEqual([{ stepId: 'step-2', name: 'StepTwo', error: 'boom' }]);

    const steps = await executeStatusTool(host, { detail: 'steps', instanceId: 'inst-1', limit: 1 }, topLevelExec);
    const stepsData = steps.data as { steps: unknown[]; truncated?: boolean; segmentCount: number; distinctStepCount: number; returnedCount?: number };
    // P5：steps 是**执行段**行 → 计数按段（segmentCount）+ 去重 step 数（distinctStepCount），
    // 旧的 `stepCount` 会被读成「步骤数」，已改名。
    expect(stepsData.segmentCount).toBe(2);
    expect(stepsData.distinctStepCount).toBe(2);
    expect(stepsData.steps).toHaveLength(1);
    expect(stepsData.truncated).toBe(true);
    expect(stepsData.returnedCount).toBe(1);
  });

  it('steps: segmentCount counts SEGMENTS while distinctStepCount counts steps (multi-segment step)', async () => {
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', makeState({
      executedSteps: [
        makeExecutedStep({ id: 'seg-0', stepId: 'step-1', status: 'paused', attemptIndex: 0, createdAt: 't0' }),
        makeExecutedStep({ id: 'seg-1', stepId: 'step-1', status: 'paused', attemptIndex: 1, createdAt: 't1' }),
        makeExecutedStep({ id: 'seg-2', stepId: 'step-1', status: 'running', attemptIndex: 2, createdAt: 't2' }),
      ],
    }));
    const host = makeHost(persistence);
    const result = await executeStatusTool(host, { detail: 'steps', instanceId: 'inst-1' }, topLevelExec);
    const data = result.data as { segmentCount: number; distinctStepCount: number; steps: unknown[] };
    expect(data.segmentCount).toBe(3);
    expect(data.distinctStepCount).toBe(1);
    expect(data.steps).toHaveLength(3);
  });

  it('step: latest segment by default with output preview; unknown step → NODE_NOT_FOUND', async () => {
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', makeState({
      executedSteps: [
        makeExecutedStep({ id: 'seg-0', attemptIndex: 0, createdAt: 't0', output: [{ type: 'text', text: 'old' }] }),
        makeExecutedStep({ id: 'seg-1', attemptIndex: 1, createdAt: 't1', output: [{ type: 'text', text: 'x'.repeat(3000) }], artifacts: ['/tmp/a.txt'], sessionMessages: [{ type: 'text', text: 'm1' }] }),
      ],
    }));
    const host = makeHost(persistence);
    const latest = await executeStatusTool(host, { detail: 'step', instanceId: 'inst-1', stepId: 'step-1' }, topLevelExec);
    const latestData = latest.data as { segmentCount: number; latest: { attemptIndex?: number; outputPreview?: { truncated: boolean }; sessionMessagesCount?: number; artifacts?: string[] } };
    expect(latestData.segmentCount).toBe(2);
    expect(latestData.latest.attemptIndex).toBe(1);
    expect(latestData.latest.outputPreview).toMatchObject({ truncated: true });
    expect(latestData.latest.sessionMessagesCount).toBe(1);
    expect(latestData.latest.artifacts).toEqual(['/tmp/a.txt']);

    const missingStep = await executeStatusTool(host, { detail: 'step', instanceId: 'inst-1' }, topLevelExec);
    expect(missingStep.error).toMatchObject({ code: 'INVALID_OPERATION' });
    const unknown = await executeStatusTool(host, { detail: 'step', instanceId: 'inst-1', stepId: 'nope' }, topLevelExec);
    expect(unknown.error).toMatchObject({ code: 'NODE_NOT_FOUND' });
    const unknownInstance = await executeStatusTool(host, { detail: 'summary', instanceId: 'inst-x' }, topLevelExec);
    expect(unknownInstance.error).toMatchObject({ code: 'NODE_NOT_FOUND' });
  });

  it('messages: step subagent session tail with limit; without stepId the instance user messages + per-step counts', async () => {
    const persistence = makePersistence();
    const userMessages = Array.from({ length: 5 }, (_, index) => ({ id: `m-${index}`, kind: 'message' as const, target: 'step-1', content: `msg ${index}`, createdAt: `t${index}` }));
    persistence.state.map.set('inst-1', makeState({
      executedSteps: [makeExecutedStep({ sessionMessages: [{ type: 'text', text: 'm1' }, { type: 'text', text: 'm2' }, { type: 'text', text: 'm3' }] })],
      userMessages,
    }));
    const host = makeHost(persistence);

    const stepMessages = await executeStatusTool(host, { detail: 'messages', instanceId: 'inst-1', stepId: 'step-1', limit: 2 }, topLevelExec);
    const stepData = stepMessages.data as { total: number; messages: unknown[]; childSessionId?: string };
    expect(stepData.total).toBe(3);
    expect(stepData.messages).toHaveLength(2);

    const instanceMessages = await executeStatusTool(host, { detail: 'messages', instanceId: 'inst-1', limit: 2 }, topLevelExec);
    const instanceData = instanceMessages.data as { userMessages: unknown[]; stepMessageCounts: Array<{ count: number }> };
    expect(instanceData.userMessages).toHaveLength(2);
    expect(instanceData.stepMessageCounts).toEqual([{ stepId: 'step-1', status: 'completed', count: 3 }]);
  });

  it('prefers the in-memory state over the persisted one', async () => {
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', makeState({ originalInput: 'persisted' }));
    const host = makeHost(persistence);
    host.getInstanceState = vi.fn(() => makeState({ originalInput: 'in-memory' }));
    const result = await executeStatusTool(host, { detail: 'summary', instanceId: 'inst-1' }, topLevelExec);
    expect((result.data as { originalInput: string }).originalInput).toBe('in-memory');
  });
});

// ── sandore_workflow_send_message ─────────────────────────────────────────────

describe('sandore_workflow_send_message', () => {
  function stateWithActiveSteps(): WorkflowTaskState {
    return makeState({
      executedSteps: [
        makeExecutedStep({ stepId: 'step-a', status: 'running', sessionMeta: { childId: 'child-a', synthetic: false, command: 'prompt' } }),
        makeExecutedStep({ id: 'seg-b', stepId: 'step-b', status: 'completed' }),
        makeExecutedStep({ id: 'seg-c', stepId: 'step-c', status: 'interacting', sessionMeta: { childId: 'child-c', synthetic: false, command: 'agent' } }),
      ],
    });
  }

  it("expands targets: ['all'] = running/interacting steps; explicit ids are kept and de-duplicated", () => {
    const state = stateWithActiveSteps();
    expect(expandTargets(state, ['all'])).toEqual(['step-a', 'step-c']);
    expect(expandTargets(state, ['step-a', 'step-a'])).toEqual(['step-a']);
    expect(expandTargets(state, ['step-b'])).toEqual(['step-b']);
    expect(expandTargets(state, ['all', 'step-a'])).toEqual(['step-a', 'step-c']);
  });

  it("delivers to each expanded target and reports per-target results", async () => {
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', stateWithActiveSteps());
    const host = makeHost(persistence);

    const broadcast = await executeMessageTool(host, { targets: ['all'], message: 'keep going', instanceId: 'inst-1' }, topLevelExec);
    expect(broadcast.ok).toBe(true);
    expect(host.sentMessages.map(item => item.stepId)).toEqual(['step-a', 'step-c']);
    expect(host.sentMessages.every(item => item.message === 'keep going')).toBe(true);

    const single = await executeMessageTool(host, { targets: ['step-a'], message: 'focus', instanceId: 'inst-1' }, topLevelExec);
    expect((single.data as { delivered: string[] }).delivered).toEqual(['step-a']);
  });

  it('collects per-target failures without aborting the rest (partial → ok:true + data.failures, no duplicate warnings)', async () => {
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', stateWithActiveSteps());
    const host = makeHost(persistence);
    host.sendStepMessage = vi.fn(async (_instanceId: string, stepId: string) => {
      if (stepId === 'step-a') throw Object.assign(new Error('step is a non-subagent step'), { code: 'INVALID_OPERATION' });
    });

    const result = await executeMessageTool(host, { targets: ['step-a', 'step-c'], message: 'hi', instanceId: 'inst-1' }, topLevelExec);
    expect(result.ok).toBe(true);
    const data = result.data as { delivered: string[]; failures: Array<{ stepId: string; error: string }> };
    expect(data.delivered).toEqual(['step-c']);
    expect(data.failures).toEqual([{ stepId: 'step-a', error: 'step is a non-subagent step' }]);
    // S4：结构化 failures 就是报告，不再同时给一份同义 warnings。
    expect(result.warnings).toBeUndefined();
  });

  it("expands ['all'] from each step's LATEST segment (P2/P3 同口径)", () => {
    const state = makeState({
      executedSteps: [
        // step-a：旧段 paused（历史值）→ 最新段 running ⇒ 可投递。
        makeExecutedStep({ id: 'a0', stepId: 'step-a', status: 'paused', attemptIndex: 0, createdAt: 't0' }),
        makeExecutedStep({ id: 'a1', stepId: 'step-a', status: 'running', attemptIndex: 1, createdAt: 't1' }),
        // step-b：旧段 running（历史值）→ 最新段 paused ⇒ 不可投递（旧实现会错误地把它算进来）。
        makeExecutedStep({ id: 'b0', stepId: 'step-b', status: 'running', attemptIndex: 0, createdAt: 't0' }),
        makeExecutedStep({ id: 'b1', stepId: 'step-b', status: 'paused', attemptIndex: 1, createdAt: 't1' }),
      ],
    });
    expect(expandTargets(state, ['all'])).toEqual(['step-a']);
  });

  it('fails when nothing is messageable and rejects empty message / empty targets / subagent callers', async () => {
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', makeState({ executedSteps: [makeExecutedStep({ status: 'completed' })] }));
    const host = makeHost(persistence);

    const nothing = await executeMessageTool(host, { targets: ['all'], message: 'hi', instanceId: 'inst-1' }, topLevelExec);
    expect(nothing.error).toMatchObject({ code: 'INVALID_OPERATION' });

    const emptyMessage = await executeMessageTool(host, { targets: ['all'], message: '', instanceId: 'inst-1' }, topLevelExec);
    expect(emptyMessage.error).toMatchObject({ code: 'INVALID_OPERATION' });

    const emptyTargets = await executeMessageTool(host, { targets: [], message: 'hi', instanceId: 'inst-1' }, topLevelExec);
    expect(emptyTargets.error).toMatchObject({ code: 'INVALID_OPERATION' });

    const denied = await executeMessageTool(host, { targets: ['all'], message: 'hi', instanceId: 'inst-1' }, subagentExec);
    expect(denied.reason).toContain('顶层');
  });

  it('resolves the instance from the calling session when instanceId is omitted', async () => {
    const persistence = makePersistence();
    persistence.state.map.set('sess-1', stateWithActiveSteps());
    const host = makeHost(persistence);
    host.findInstanceIdByHostSession = vi.fn(() => 'sess-1');
    const result = await executeMessageTool(host, { targets: ['step-a'], message: 'hi' }, topLevelExec);
    expect(result.ok).toBe(true);
    expect(host.sentMessages[0]?.instanceId).toBe('sess-1');
  });
});

// ── sandore_workflow_control ──────────────────────────────────────────────────

describe('sandore_workflow_control', () => {
  it('expands scope by action: pause → running/interacting, continue → paused/failed', () => {
    const state = makeState({
      executedSteps: [
        makeExecutedStep({ stepId: 'a', status: 'running' }),
        makeExecutedStep({ id: 'seg-b', stepId: 'b', status: 'paused' }),
        makeExecutedStep({ id: 'seg-c', stepId: 'c', status: 'failed' }),
        makeExecutedStep({ id: 'seg-d', stepId: 'd', status: 'completed' }),
      ],
    });
    expect(expandScope(state, 'pause', undefined)).toEqual(['a']);
    expect(expandScope(state, 'continue', undefined)).toEqual(['b', 'c']);
    expect(expandScope(state, 'pause', 'b')).toEqual(['b']);
    expect(expandScope(state, 'continue', 'all')).toEqual(['b', 'c']);
  });

  it('pause: scope=all uses the instance-wide pause; a stepId uses pauseStep', async () => {
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', makeState({ executedSteps: [makeExecutedStep({ stepId: 'a', status: 'running' })] }));
    const host = makeHost(persistence);

    const all = await executeControlTool(host, { action: 'pause', instanceId: 'inst-1' }, topLevelExec);
    expect((all.data as { paused: string[] }).paused).toEqual(['a']);
    expect(host.controls).toEqual(['pause:all']);

    const scoped = await executeControlTool(host, { action: 'pause', scope: 'a', instanceId: 'inst-1' }, topLevelExec);
    expect(scoped.ok).toBe(true);
    expect(host.controls).toEqual(['pause:all', 'pause:a']);
  });

  it('continue: paused steps resume their EXISTING subagent; failed steps are REBUILT (fork)', async () => {
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', makeState({
      executedSteps: [
        makeExecutedStep({ stepId: 'p', status: 'paused' }),
        makeExecutedStep({ id: 'seg-f', stepId: 'f', status: 'failed', error: 'boom' }),
      ],
    }));
    const host = makeHost(persistence);

    const result = await executeControlTool(host, { action: 'continue', instanceId: 'inst-1' }, topLevelExec);
    expect(result.ok).toBe(true);
    // paused → resumeStep（继续现有子代理，childId 不变）；failed → retryStep('fork')（重建）。
    expect(host.controls).toEqual(['resume:p', 'retry:f:fork']);
    const data = result.data as { resumed: string[]; retried: string[] };
    expect(data.resumed).toEqual(['p']);
    expect(data.retried).toEqual(['f']);
  });

  it('continue: an all-paused scope uses the instance-wide resume with the given prompt', async () => {
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', makeState({ executedSteps: [makeExecutedStep({ stepId: 'p', status: 'paused' })] }));
    const host = makeHost(persistence);
    const result = await executeControlTool(host, { action: 'continue', message: '继续吧', instanceId: 'inst-1' }, topLevelExec);
    expect(result.ok).toBe(true);
    expect(host.controls).toEqual(['resume:all']);
    expect(host.resumeAllSteps).toHaveBeenCalledWith('inst-1', '继续吧');
  });

  it('continue: reports a not-paused/failed target as a FAILED call (P1: ok:false + STEP_CONTROL_FAILED)', async () => {
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', makeState({ executedSteps: [makeExecutedStep({ stepId: 'done', status: 'completed' })] }));
    const host = makeHost(persistence);
    const result = await executeControlTool(host, { action: 'continue', scope: 'done', instanceId: 'inst-1' }, topLevelExec);
    // P1：全部目标都失败 → ok:false（与 send_message 的全失败语义对齐），per-step 细节仍在 data.failures。
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'STEP_CONTROL_FAILED' });
    const data = result.data as { failures: Array<{ stepId: string; error: string }>; resumed: string[]; retried: string[] };
    expect(data.resumed).toEqual([]);
    expect(data.retried).toEqual([]);
    expect(data.failures[0]?.stepId).toBe('done');
    expect(data.failures[0]?.error).toContain('neither paused nor failed');
    expect(result.reason).toContain('done');
  });

  it('continue: PARTIAL failure stays ok:true with data.failures, ALL-fail becomes STEP_CONTROL_FAILED (P1 三态)', async () => {
    const persistence = makePersistence();
    // 混合场景（paused + failed）走逐步处理路径：p1/p2 各自 resume、f 走 fork 重试。
    persistence.state.map.set('inst-1', makeState({
      executedSteps: [
        makeExecutedStep({ id: 'seg-p1', stepId: 'p1', status: 'paused' }),
        makeExecutedStep({ id: 'seg-p2', stepId: 'p2', status: 'paused' }),
        makeExecutedStep({ id: 'seg-f', stepId: 'f', status: 'failed', error: 'boom' }),
      ],
    }));
    const host = makeHost(persistence);
    host.resumeStep = vi.fn(async (_instanceId: string, stepId: string) => {
      if (stepId === 'p2') throw Object.assign(new Error('resume boom'), { code: 'INVALID_OPERATION' });
    });
    host.retryStep = vi.fn(async (_instanceId: string, stepId: string) => { host.controls.push(`retry:${stepId}`); });

    // ① 部分失败：ok:true + data.resumed/data.retried 记录生效目标 + data.failures 记失败目标。
    const partial = await executeControlTool(host, { action: 'continue', instanceId: 'inst-1' }, topLevelExec);
    expect(partial.ok).toBe(true);
    const partialData = partial.data as { resumed: string[]; retried: string[]; failures?: Array<{ stepId: string; error: string }> };
    expect(partialData.resumed).toEqual(['p1']);
    expect(partialData.retried).toEqual(['f']);
    expect(partialData.failures).toEqual([{ stepId: 'p2', error: 'resume boom' }]);

    // ② 全部失败：ok:false + STEP_CONTROL_FAILED（模型只看 ok 也不会误报成功）。
    host.resumeStep = vi.fn(async () => { throw Object.assign(new Error('resume boom'), { code: 'INVALID_OPERATION' }); });
    host.retryStep = vi.fn(async () => { throw Object.assign(new Error('retry boom'), { code: 'INVALID_OPERATION' }); });
    const allFailed = await executeControlTool(host, { action: 'continue', instanceId: 'inst-1' }, topLevelExec);
    expect(allFailed.ok).toBe(false);
    expect(allFailed.error).toMatchObject({ code: 'STEP_CONTROL_FAILED' });
    const failedData = allFailed.data as { resumed: string[]; retried: string[]; failures: unknown[] };
    expect(failedData.resumed).toEqual([]);
    expect(failedData.retried).toEqual([]);
    expect(failedData.failures).toHaveLength(3);
    expect(allFailed.reason).toContain('p1');
    expect(allFailed.reason).toContain('retry boom');

    // ③ 全成功：ok:true、无 failures、无 warnings。
    host.resumeStep = vi.fn(async (_instanceId: string, stepId: string) => { host.controls.push(`resume:${stepId}`); });
    host.retryStep = vi.fn(async (_instanceId: string, stepId: string) => { host.controls.push(`retry:${stepId}`); });
    const allOk = await executeControlTool(host, { action: 'continue', instanceId: 'inst-1' }, topLevelExec);
    expect(allOk.ok).toBe(true);
    const okData = allOk.data as { resumed: string[]; retried: string[]; failures?: unknown };
    expect(okData.resumed).toEqual(['p1', 'p2']);
    expect(okData.retried).toEqual(['f']);
    expect(okData.failures).toBeUndefined();
    expect(allOk.warnings).toBeUndefined();
  });

  it('continue: unknown explicit stepId → NODE_NOT_FOUND (S7: existence checked before status)', async () => {
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', makeState({ executedSteps: [makeExecutedStep({ stepId: 'p', status: 'paused' })] }));
    const host = makeHost(persistence);
    const result = await executeControlTool(host, { action: 'continue', scope: 'nope', instanceId: 'inst-1' }, topLevelExec);
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'NODE_NOT_FOUND' });
    // 不再报成「状态不可继续」（旧文案 step status 'unknown' … 把不存在与不可继续混为一谈）。
    expect(result.reason).not.toContain('unknown');
    expect(result.reason).toContain("step 'nope' not found");
    expect(host.controls).toEqual([]);
  });

  it('continue: multi-segment step is judged by its LATEST segment (P2 —— 不再自相矛盾)', async () => {
    // 审计实测形态：同一 stepId 有 3 段（0 paused、1 paused、2 running）。
    const multiSegment = () => makeState({
      executedSteps: [
        makeExecutedStep({ id: 'seg-0', stepId: 'step-1', status: 'paused', attemptIndex: 0, createdAt: 't0' }),
        makeExecutedStep({ id: 'seg-1', stepId: 'step-1', status: 'paused', attemptIndex: 1, createdAt: 't1' }),
        makeExecutedStep({ id: 'seg-2', stepId: 'step-1', status: 'running', attemptIndex: 2, createdAt: 't2' }),
      ],
    });
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', multiSegment());
    const host = makeHost(persistence);

    // ① 目标展开按最新段：最新段 running ⇒ 不是 continue 目标、是 pause 目标。
    expect(expandScope(multiSegment(), 'continue', undefined)).toEqual([]);
    expect(expandScope(multiSegment(), 'pause', undefined)).toEqual(['step-1']);

    // ② 不带 scope 的 continue：目标集为空 → 明确报「nothing to continue」，
    //    **不再**出现「选中了它又报 running 既非 paused 也非 failed」的自相矛盾。
    const result = await executeControlTool(host, { action: 'continue', instanceId: 'inst-1' }, topLevelExec);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('nothing to continue');
    expect(JSON.stringify(result)).not.toContain('neither paused nor failed');
    expect(host.controls).toEqual([]);

    // ③ 最新段是 paused（旧段 running 是历史值）⇒ 正常成为目标并 resumeStep。
    const latestPaused = makeState({
      executedSteps: [
        makeExecutedStep({ id: 'seg-0', stepId: 'step-1', status: 'running', attemptIndex: 0, createdAt: 't0' }),
        makeExecutedStep({ id: 'seg-1', stepId: 'step-1', status: 'paused', attemptIndex: 1, createdAt: 't1' }),
      ],
    });
    persistence.state.map.set('inst-1', latestPaused);
    expect(expandScope(latestPaused, 'continue', undefined)).toEqual(['step-1']);
    const resumed = await executeControlTool(host, { action: 'continue', instanceId: 'inst-1' }, topLevelExec);
    expect(resumed.ok).toBe(true);
    expect((resumed.data as { resumed: string[] }).resumed).toEqual(['step-1']);
    expect(host.controls).toEqual(['resume:all']);
  });

  it('rejects an empty target set, bad action, and subagent callers', async () => {
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', makeState({ executedSteps: [makeExecutedStep({ status: 'completed' })] }));
    const host = makeHost(persistence);

    const nothing = await executeControlTool(host, { action: 'pause', instanceId: 'inst-1' }, topLevelExec);
    expect(nothing.error).toMatchObject({ code: 'INVALID_OPERATION' });
    expect(nothing.reason).toContain('no running step to pause');

    const nothingToContinue = await executeControlTool(host, { action: 'continue', instanceId: 'inst-1' }, topLevelExec);
    expect(nothingToContinue.reason).toContain('nothing to continue');

    const badAction = await executeControlTool(host, { action: 'restart', instanceId: 'inst-1' }, topLevelExec);
    expect(badAction.error).toMatchObject({ code: 'INVALID_OPERATION' });

    const denied = await executeControlTool(host, { action: 'pause', instanceId: 'inst-1' }, subagentExec);
    expect(denied.reason).toContain('顶层');
  });
});

/** 信封形状（各工具一致）：成功必带 ok（错误信封带 error.code）。 */
function assertEnvelope(value: SandoreToolEnvelope): void {
  expect(typeof value.ok).toBe('boolean');
}

// ── P4：未知入参键必须报错并列出可用参数 ────────────────────────────────────────

describe('P4 未知入参键（裸注册的工具不走 DSH 入参校验 → execute 入口显式拒绝）', () => {
  /** 断言一个未知键错误信封：ok:false + INVALID_OPERATION + 点名未知键 + 列出可用参数。 */
  function expectUnknownKeyRejected(result: SandoreToolEnvelope, unknownKeys: readonly string[], allowed: readonly string[]): void {
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_OPERATION' });
    for (const key of unknownKeys) {
      expect(result.reason, `应点名未知参数 ${key}`).toContain(`'${key}'`);
    }
    expect(result.reason).toContain('未知参数');
    for (const key of allowed) {
      expect(result.reason, `应列出可用参数 ${key}`).toContain(key);
    }
  }

  it('sandore_workflow_run rejects hostSessionId / attachSession / sessionId and lists its parameters', async () => {
    const host = makeHost();
    for (const legacy of [{ hostSessionId: 'x' }, { attachSession: true }, { sessionId: 'x' }]) {
      const result = await executeRunTool(host, { workflowId: 'wfl-1', originalInput: 'go', ...legacy }, topLevelExec);
      expectUnknownKeyRejected(result, Object.keys(legacy), ['workflowId', 'originalInput', 'cwd', 'model', 'permission']);
    }
    // 拒绝必须发生在启动之前：没有发生任何引擎调用。
    expect(host.runCalls).toHaveLength(0);
  });

  it('sandore_workflow_run rejects unknown keys INSIDE model (schema declares additionalProperties:false)', async () => {
    const host = makeHost();
    const result = await executeRunTool(host, {
      workflowId: 'wfl-1',
      originalInput: 'go',
      model: { provider: 'p', model: 'm', extra: 1 } as never,
    }, topLevelExec);
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_OPERATION' });
    expect(result.reason).toContain('model');
    expect(result.reason).toContain("'extra'");
    expect(result.reason).toContain('reasoningEffort');
    expect(host.runCalls).toHaveLength(0);
  });

  it('sandore_workflow_status / _send_message / _control reject unknown keys too', async () => {
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', makeState({ executedSteps: [makeExecutedStep({ stepId: 'a', status: 'running' })] }));
    const host = makeHost(persistence);

    const status = await executeStatusTool(host, { detail: 'summary', instanceId: 'inst-1', fullState: true }, topLevelExec);
    expectUnknownKeyRejected(status, ['fullState'], ['detail', 'instanceId', 'stepId', 'limit']);

    const message = await executeMessageTool(host, { targets: ['a'], message: 'm', instanceId: 'inst-1', stepId: 'a' }, topLevelExec);
    expectUnknownKeyRejected(message, ['stepId'], ['targets', 'message', 'instanceId']);
    expect(host.sentMessages).toHaveLength(0);

    const control = await executeControlTool(host, { action: 'pause', instanceId: 'inst-1', target: 'a' }, topLevelExec);
    expectUnknownKeyRejected(control, ['target'], ['action', 'scope', 'message', 'instanceId']);
    expect(host.controls).toEqual([]);
  });

  it('sandore_workflow 的未知键同样被拒（且不落库）', async () => {
    const host = makeManagerHost();
    const result = await executeManagerTool(host, { action: 'get-def', workflowId: 'wfl-1', run: true }, topLevelExec);
    expectUnknownKeyRejected(result, ['run'], ['action', 'workflowId', 'stageId', 'stepId', 'fields', 'lib', 'entryId']);
  });

  it('五个工具的 parameters 顶层都声明 additionalProperties:false（声明与运行时同口径）', () => {
    for (const parameters of [
      WORKFLOW_RUN_PARAMETERS,
      WORKFLOW_STATUS_PARAMETERS,
      WORKFLOW_MESSAGE_PARAMETERS,
      WORKFLOW_CONTROL_PARAMETERS,
      WORKFLOW_MANAGER_PARAMETERS,
    ]) {
      expect(parameters.additionalProperties).toBe(false);
    }
  });
});

// ── S 系列：描述/约束补齐（schema 面回归锁） ──────────────────────────────────

describe('S1-S6 描述与 schema 面（防回退）', () => {
  it('S1: status.limit 声明 1..200 并在描述里写全 steps/messages 的缺省值', () => {
    const limit = WORKFLOW_STATUS_PARAMETERS.properties.limit;
    expect(limit.minimum).toBe(1);
    expect(limit.maximum).toBe(200);
    expect(limit.description).toContain('50'); // steps 缺省
    expect(limit.description).toContain('20'); // messages 缺省
    expect(limit.description).toContain('200'); // 上限
  });

  it('S5: control.scope 描述写明「省略 / all / 空串」等价，且说明未知 stepId 报 NODE_NOT_FOUND', () => {
    expect(WORKFLOW_CONTROL_PARAMETERS.properties.scope.description).toContain('空串');
    expect(WORKFLOW_CONTROL_PARAMETERS.properties.scope.description).toContain('NODE_NOT_FOUND');
    expect(WORKFLOW_CONTROL_TOOL_DESCRIPTION).toContain('LATEST execution segment');
    expect(WORKFLOW_CONTROL_TOOL_DESCRIPTION).toContain('STEP_CONTROL_FAILED');
  });

  it('S6: run 描述说明 status 恒为 running，且没有 hostSessionId 入参', () => {
    expect(WORKFLOW_RUN_TOOL_DESCRIPTION).toContain('always "running"');
    expect(WORKFLOW_RUN_TOOL_DESCRIPTION).toContain('NO hostSessionId/attachSession parameter');
  });

  it('S4/P3: send_message 描述与失败语义（结构化 failures、无 warnings、同一门槛）', () => {
    expect(WORKFLOW_MESSAGE_TOOL_DESCRIPTION).toContain('LATEST execution segment is running/interacting');
    expect(WORKFLOW_MESSAGE_TOOL_DESCRIPTION).toContain('STEP_DELIVERY_FAILED');
    expect(WORKFLOW_MESSAGE_TOOL_DESCRIPTION).toContain('no separate warnings');
  });
});

describe('工具信封一致性（架构决策 3）', () => {
  it('every tool returns the shared {ok, action?, data?, reason?, error?} envelope', async () => {
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', makeState({ executedSteps: [makeExecutedStep({ stepId: 'a', status: 'running' })] }));
    const host = makeHost(persistence);
    assertEnvelope(await executeRunTool(host, { workflowId: 'w', originalInput: 'i' }, topLevelExec));
    assertEnvelope(await executeStatusTool(host, { detail: 'summary', instanceId: 'inst-1' }, topLevelExec));
    assertEnvelope(await executeMessageTool(host, { targets: ['a'], message: 'm', instanceId: 'inst-1' }, topLevelExec));
    assertEnvelope(await executeControlTool(host, { action: 'pause', instanceId: 'inst-1' }, topLevelExec));
  });
});
