/**
 * `manager-tool.ts` 的单元测试：六 action 语义、寻址/合并纯函数、跨字段硬约束、
 * run 的 hostSessionId/cwd 组装、get-state 定点与裁剪、lib 浏览、注册降级与
 * execute 期 gate。全 mock（Map 背书的 persistence 视图 + fake host），无宿主依赖。
 * @module @meiyukichan/dsh-sandore/workflow/src/manager-tool.spec
 */
import { describe, expect, it, vi } from 'vitest';

import type { MicroflowRecord, StepRecord, WorkflowTaskState } from './schema.ts';
import type { ExecutedStepDefault } from './types.ts';
import {
  executeManagerTool,
  findStepSlots,
  mergedStageView,
  mergedStepView,
  registerGlobalManagerTool,
  WORKFLOW_MANAGER_PARAMETERS,
  WORKFLOW_MANAGER_TOOL_NAME,
} from './manager-tool.ts';
import type {
  ManagerToolArgs,
  SandoreManagerToolHost,
  SandoreManagerToolResult,
  TableView,
} from './manager-tool.ts';
import type { Context } from '@deepseek-ai/cordis';
import { mergedStepsOf } from '../client/dag-editor-model';
import type { DagStartRequest } from './types.ts';
import { parseWorkflowYaml } from './yaml-parser.ts';

// ── fixtures ──────────────────────────────────────────────────────────────────

/** 单 Stage 两 Step 的合法定义（step-2 无 command，供 warning 断言）。 */
const demoYaml = `id: wfl-1
name: Demo
version: '1'
description: demo flow
stages:
  - id: stg-a
    name: StageA
    steps:
      - id: step-1
        branches:
          - next: step-2
      - id: step-2
steps:
  - id: step-1
    name: StepOne
    command:
      type: shell
      value:
        command: echo one
  - id: step-2
    name: StepTwo
`;

/** 流控位缺顶层定义的 workflow（update-def 警告用例）。 */
const orphanSlotYaml = `id: wfl-orphan
name: Orphan
version: '1'
stages:
  - id: stg-o
    name: O
    steps:
      - id: step-ghost
steps:
  - id: step-real
    name: Real
    command:
      type: shell
      value:
        command: x
`;

function definitionRecord(yaml: string, name: string): { yaml: string; name: string; version: string; description?: string; createdAt: string; updatedAt: string } {
  const description = /description: (.+)/.exec(yaml)?.[1];
  return { yaml, name, version: '1', ...(description === undefined ? {} : { description }), createdAt: 't0', updatedAt: 't1' };
}

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
  definitions: ReturnType<typeof tableOf<{ yaml: string; name: string; version: string; description?: string; createdAt: string; updatedAt: string }>>;
  steps: ReturnType<typeof tableOf<StepRecord>>;
  microflows: ReturnType<typeof tableOf<MicroflowRecord>>;
  state: ReturnType<typeof tableOf<WorkflowTaskState>>;
  writeDefinitionToLibraries: ReturnType<typeof vi.fn>;
}

function makePersistence(): FixturePersistence {
  return {
    definitions: tableOf({
      'wfl-1': definitionRecord(demoYaml, 'Demo'),
      'wfl-orphan': definitionRecord(orphanSlotYaml, 'Orphan'),
    }),
    steps: tableOf<StepRecord>({
      'step-1': { id: 'step-1', name: 'StepOne', createdAt: 't0', updatedAt: 't1' },
    }),
    microflows: tableOf<MicroflowRecord>({
      'stg-a': { id: 'stg-a', name: 'StageA', steps: [{ id: 'step-1' }, { id: 'step-2' }], createdAt: 't0', updatedAt: 't1' },
    }),
    state: tableOf<WorkflowTaskState>({}),
    writeDefinitionToLibraries: vi.fn(async () => {}),
  };
}

function makeHost(persistence: FixturePersistence): SandoreManagerToolHost & { startRequests: DagStartRequest[] } {
  const startRequests: DagStartRequest[] = [];
  return {
    startRequests,
    startInstance: vi.fn(async (request: DagStartRequest) => {
      startRequests.push(request);
      return { instanceId: 'inst-1', status: 'running' as const };
    }),
    getState: vi.fn(() => {
      throw new Error('not stubbed');
    }),
    getInstanceState: vi.fn(() => undefined),
    persistence: () => persistence,
  };
}

/** 顶层主代理调用方（gate 放行）。 */
const topLevelExec = { agent: { session: { id: 'sess-1', header: { cwd: '/w' } } } };
/** 委派子代理调用方（gate 拒绝）。 */
const subagentExec = { agent: { session: { id: 'child-1', header: { parentSession: 'host-x' } } } };

async function run(host: SandoreManagerToolHost, args: Partial<ManagerToolArgs>, exec: unknown = topLevelExec): Promise<SandoreManagerToolResult> {
  return await executeManagerTool(host, { action: 'get-def', ...args } as unknown, exec as never);
}

function makeState(overrides: Partial<WorkflowTaskState> = {}): WorkflowTaskState {
  return {
    taskId: 'inst-1',
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

// ── 纯函数：分离式合并与定位 ──────────────────────────────────────────────────

describe('分离式合并视图（mergedStepView / mergedStageView / findStepSlots）', () => {
  it('merges slot branches with the top-level definition and falls back to { id }', () => {
    const definition = parseWorkflowYaml(demoYaml);
    const merged = mergedStepView(definition, definition.stages[0]!.steps[0]!);
    expect(merged).toMatchObject({ id: 'step-1', name: 'StepOne', command: { type: 'shell' }, branches: [{ next: 'step-2' }] });
    const fallback = mergedStepView({ ...definition, steps: [] }, definition.stages[0]!.steps[0]!);
    expect(fallback).toEqual({ id: 'step-1', branches: [{ next: 'step-2' }] });
    // 等价性：与 client mergedStepsOf（DagEditor 画布）逐项一致。
    const clientView = mergedStepsOf(definition, definition.stages[0]!);
    expect(definition.stages[0]!.steps.map(slot => mergedStepView(definition, slot))).toEqual(clientView);
  });

  it('returns merged steps in slot order; unknown stage throws NODE_NOT_FOUND', () => {
    const definition = parseWorkflowYaml(demoYaml);
    const view = mergedStageView(definition, 'stg-a');
    expect(view.steps.map(step => step.id)).toEqual(['step-1', 'step-2']);
    expect(view.steps).toEqual(mergedStepsOf(definition, definition.stages[0]!));
    expect(() => mergedStageView(definition, 'nope')).toThrowError(expect.objectContaining({ code: 'NODE_NOT_FOUND' }));
  });

  it('finds all stage slots containing a stepId', () => {
    const definition = parseWorkflowYaml(demoYaml);
    expect(findStepSlots(definition, 'step-1').map(slot => slot.stageId)).toEqual(['stg-a']);
    expect(findStepSlots(definition, 'nope')).toEqual([]);
  });
});

// ── get-def ───────────────────────────────────────────────────────────────────

describe('get-def', () => {
  it('lists definition summaries (counts from yaml; broken rows flagged)', async () => {
    const host = makeHost(makePersistence());
    host.persistence()!.definitions.map.set('wfl-bad', { yaml: 'stages: [oops', name: 'bad', version: '1', createdAt: 't', updatedAt: 't' });
    const result = await run(host, { action: 'get-def' });
    expect(result.ok).toBe(true);
    const rows = (result.data as { definitions: Array<Record<string, unknown>> }).definitions;
    expect(rows).toHaveLength(3);
    const demo = rows.find(row => row.workflowId === 'wfl-1')!;
    expect(demo).toMatchObject({ name: 'Demo', stageCount: 1, stepCount: 2 });
    expect(rows.find(row => row.workflowId === 'wfl-bad')).toMatchObject({ parseError: true });
  });

  it('returns the full merged definition with library hints', async () => {
    const host = makeHost(makePersistence());
    const result = await run(host, { action: 'get-def', workflowId: 'wfl-1' });
    expect(result.ok).toBe(true);
    const data = result.data as { stages: Array<{ id: string; steps: Array<{ id: string }> }>; stepDefinitions: unknown[]; libraryHints: { stages: Array<{ id: string; present: boolean; name?: string; libraryUpdatedAt?: string }>; steps: Array<{ id: string; present: boolean }> } };
    expect(data.stages[0]!.steps.map(step => step.id)).toEqual(['step-1', 'step-2']);
    expect(data.stepDefinitions).toHaveLength(2);
    // 库提示按「库表是否有同 id 快照条目」判定：stg-a/step-1 有库条目；step-2 无。
    expect(data.libraryHints.stages.find(hint => hint.id === 'stg-a')).toMatchObject({ present: true, name: 'StageA', libraryUpdatedAt: 't1' });
    expect(data.libraryHints.steps.find(hint => hint.id === 'step-1')).toMatchObject({ present: true, name: 'StepOne' });
    expect(data.libraryHints.steps.find(hint => hint.id === 'step-2')).toMatchObject({ present: false });
  });

  it('targets a stage (merged) and a step (all occurrences)', async () => {
    const host = makeHost(makePersistence());
    const stageResult = await run(host, { action: 'get-def', workflowId: 'wfl-1', stageId: 'stg-a' });
    expect((stageResult.data as { stage: { name: string } }).stage.name).toBe('StageA');
    const stepResult = await run(host, { action: 'get-def', workflowId: 'wfl-1', stepId: 'step-1' });
    expect((stepResult.data as { occurrences: unknown[] }).occurrences).toHaveLength(1);
  });

  it('enforces the workflowId hard constraint for stage/step reads and NODE_NOT_FOUND for unknown ids', async () => {
    const host = makeHost(makePersistence());
    const missing = await run(host, { action: 'get-def', stepId: 'step-1' });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatchObject({ code: 'INVALID_OPERATION' });
    const unknown = await run(host, { action: 'get-def', workflowId: 'wfl-1', stepId: 'nope' });
    expect(unknown.error).toMatchObject({ code: 'NODE_NOT_FOUND' });
  });
});

// ── update-def ────────────────────────────────────────────────────────────────

describe('update-def', () => {
  it('shallow-merges workflow metadata and syncs record via yaml roundtrip', async () => {
    const persistence = makePersistence();
    const host = makeHost(persistence);
    const result = await run(host, { action: 'update-def', workflowId: 'wfl-1', fields: { name: 'Renamed' } });
    expect(result.ok).toBe(true);
    const record = persistence.definitions.map.get('wfl-1')!;
    // 往返一致性：持久化 yaml = 原定义深等值 + 仅 name 变更（元数据从新 yaml 解析同步）。
    const original = parseWorkflowYaml(demoYaml);
    expect(parseWorkflowYaml(record.yaml)).toEqual({ ...original, name: 'Renamed' });
    expect(record.createdAt).toBe('t0');
    expect(record.updatedAt).not.toBe('t1');
    expect(persistence.writeDefinitionToLibraries).toHaveBeenCalledTimes(1);
    // 未知 workflow → NODE_NOT_FOUND，且不落盘。
    const missing = await run(host, { action: 'update-def', workflowId: 'nope', fields: {} });
    expect(missing.error).toMatchObject({ code: 'NODE_NOT_FOUND' });
    expect(persistence.definitions.map.has('nope')).toBe(false);
  });

  it('warns about structural fields on metadata-only updates', async () => {
    const host = makeHost(makePersistence());
    const result = await run(host, { action: 'update-def', workflowId: 'wfl-1', fields: { stages: [] } });
    expect(result.warnings?.[0]).toContain('stages');
  });

  it('replaces a stage node, rejects id mutation, and flags missing slot definitions', async () => {
    const persistence = makePersistence();
    const host = makeHost(persistence);
    const result = await run(host, { action: 'update-def', workflowId: 'wfl-orphan', stageId: 'stg-o', fields: { name: 'O2' } });
    expect(result.ok).toBe(true);
    expect(result.warnings?.join(' ')).toContain('step-ghost');
    expect(parseWorkflowYaml(persistence.definitions.map.get('wfl-orphan')!.yaml).stages[0]!.name).toBe('O2');

    const idLocked = await run(host, { action: 'update-def', workflowId: 'wfl-1', stageId: 'stg-a', fields: { id: 'other' } });
    expect(idLocked.error).toMatchObject({ code: 'INVALID_OPERATION' });
    const unknownStage = await run(host, { action: 'update-def', workflowId: 'wfl-1', stageId: 'nope', fields: {} });
    expect(unknownStage.error).toMatchObject({ code: 'NODE_NOT_FOUND' });
  });

  it('replaces a step (definition fields + stage slot flow fields) with stageId required (Q4)', async () => {
    const persistence = makePersistence();
    const host = makeHost(persistence);
    const result = await run(host, {
      action: 'update-def',
      workflowId: 'wfl-1',
      stageId: 'stg-a',
      stepId: 'step-2',
      fields: { name: 'StepTwoNew', branches: [{ next: 'step-1' }] },
    });
    expect(result.ok).toBe(true);
    const definition = parseWorkflowYaml(persistence.definitions.map.get('wfl-1')!.yaml);
    expect(definition.steps!.find(step => step.id === 'step-2')!.name).toBe('StepTwoNew');
    expect(definition.stages[0]!.steps[1]!.branches).toEqual([{ next: 'step-1' }]);

    const noStage = await run(host, { action: 'update-def', workflowId: 'wfl-1', stepId: 'step-2', fields: { name: 'x' } });
    expect(noStage.error).toMatchObject({ code: 'INVALID_OPERATION' });
    const wrongStage = await run(host, { action: 'update-def', workflowId: 'wfl-1', stageId: 'stg-a', stepId: 'step-9', fields: {} });
    expect(wrongStage.error).toMatchObject({ code: 'NODE_NOT_FOUND' });
    const idLocked = await run(host, { action: 'update-def', workflowId: 'wfl-1', stageId: 'stg-a', stepId: 'step-1', fields: { id: 'other' } });
    expect(idLocked.error).toMatchObject({ code: 'INVALID_OPERATION' });
  });

  it('creates a top-level definition for a slot-only step (update-def step-level, slot lacks def)', async () => {
    const persistence = makePersistence();
    const host = makeHost(persistence);
    const before = parseWorkflowYaml(persistence.definitions.map.get('wfl-orphan')!.yaml);
    expect(before.steps!.some(step => step.id === 'step-ghost')).toBe(false);
    const result = await run(host, {
      action: 'update-def',
      workflowId: 'wfl-orphan',
      stageId: 'stg-o',
      stepId: 'step-ghost',
      fields: { name: 'Ghost', command: { type: 'shell', value: { command: 'echo ghost' } } },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toBeUndefined(); // 补齐顶层定义 + command 后不再有警告。
    const definition = parseWorkflowYaml(persistence.definitions.map.get('wfl-orphan')!.yaml);
    expect(definition.steps).toHaveLength(2);
    expect(definition.steps!.find(step => step.id === 'step-ghost')).toMatchObject({ name: 'Ghost', command: { type: 'shell' } });
  });

  it('keeps the old record when validation fails (atomicity)', async () => {
    const persistence = makePersistence();
    const host = makeHost(persistence);
    const before = persistence.definitions.map.get('wfl-1');
    const result = await run(host, { action: 'update-def', workflowId: 'wfl-1', stageId: 'stg-a', fields: { steps: 'oops' } });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'DEFINITION_INVALID' });
    expect(persistence.definitions.map.get('wfl-1')).toBe(before);
  });
});

// ── run ───────────────────────────────────────────────────────────────────────

describe('run', () => {
  it('assembles DagStartRequest with hostSessionId (attach default true) and session cwd', async () => {
    const host = makeHost(makePersistence());
    const result = await run(host, { action: 'run', workflowId: 'wfl-1', originalInput: 'go' });
    expect(result.ok).toBe(true);
    expect(host.startRequests[0]).toEqual({
      workflowId: 'wfl-1',
      originalInput: 'go',
      cwd: '/w',
      hostSessionId: 'sess-1',
    });
  });

  it('omits hostSessionId when attachSession=false and honors explicit cwd/model/permission', async () => {
    const host = makeHost(makePersistence());
    await run(host, {
      action: 'run',
      workflowId: 'wfl-1',
      originalInput: 'go',
      attachSession: false,
      cwd: '/other',
      model: { provider: 'p', model: 'm' },
      permission: 'read-only',
    });
    expect(host.startRequests[0]).toEqual({
      workflowId: 'wfl-1',
      originalInput: 'go',
      cwd: '/other',
      model: { provider: 'p', model: 'm' },
      permission: 'read-only',
    });
  });

  it('fails when cwd cannot be derived and requires workflowId/originalInput', async () => {
    const host = makeHost(makePersistence());
    const noCwd = await executeManagerTool(host, { action: 'run', workflowId: 'wfl-1', originalInput: 'go' }, { agent: { session: { id: 's1' } } });
    expect(noCwd.error).toMatchObject({ code: 'INVALID_OPERATION' });
    const noInput = await run(host, { action: 'run', workflowId: 'wfl-1' });
    expect(noInput.error).toMatchObject({ code: 'INVALID_OPERATION' });
    const noWorkflow = await run(host, { action: 'run', originalInput: 'go' });
    expect(noWorkflow.error).toMatchObject({ code: 'INVALID_OPERATION' });
  });

  it('propagates engine SandoreError through the envelope', async () => {
    const host = makeHost(makePersistence());
    host.startInstance = vi.fn(async () => { throw Object.assign(new Error("definition 'x' not found"), { code: 'NODE_NOT_FOUND' }); });
    const result = await run(host, { action: 'run', workflowId: 'wfl-1', originalInput: 'go' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'NODE_NOT_FOUND' });
  });
});

// ── get-state ─────────────────────────────────────────────────────────────────

describe('get-state', () => {
  it('lists instance summaries with workflowId/status filters', async () => {
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', makeState({ taskId: 'inst-1', status: 'running' }));
    persistence.state.map.set('inst-2', makeState({ taskId: 'inst-2', workflowId: 'wfl-2', status: 'completed' }));
    const host = makeHost(persistence);
    const all = await run(host, { action: 'get-state' });
    expect((all.data as { instances: unknown[] }).instances).toHaveLength(2);
    const filtered = await run(host, { action: 'get-state', workflowId: 'wfl-2', status: 'completed' });
    expect((filtered.data as { instances: Array<{ instanceId: string }> }).instances).toEqual([
      expect.objectContaining({ instanceId: 'inst-2' }),
    ]);
  });

  it('prefers in-memory state, falls back to persistence, and NODE_NOT_FOUND when both miss', async () => {
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', makeState());
    const host = makeHost(persistence);
    const detail = await run(host, { action: 'get-state', instanceId: 'inst-1' });
    expect(detail.ok).toBe(true);
    expect(host.getInstanceState).toHaveBeenCalledWith('inst-1');

    const fallbackHost = makeHost(persistence);
    fallbackHost.getInstanceState = vi.fn(() => undefined);
    const fallback = await run(fallbackHost, { action: 'get-state', instanceId: 'inst-1' });
    expect((fallback.data as { instanceId: string }).instanceId).toBe('inst-1');

    const missing = await run(fallbackHost, { action: 'get-state', instanceId: 'inst-x' });
    expect(missing.error).toMatchObject({ code: 'NODE_NOT_FOUND' });
  });

  it('targets a step: latest segment by default, attemptIndex pick, caps unless includeDetail', async () => {
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', makeState({
      executedSteps: [
        makeExecutedStep({ id: 'seg-0', attemptIndex: 0, createdAt: 't0', output: [{ type: 'text', text: 'old' }], sessionMessages: [{ type: 'text', text: 'm0' }] }),
        makeExecutedStep({ id: 'seg-1', attemptIndex: 1, createdAt: 't1', output: [{ type: 'text', text: 'x'.repeat(3000) }], sessionMeta: { childId: 'child-9', synthetic: false, command: 'shell' }, sessionMessages: [{ type: 'text', text: 'm1' }, { type: 'text', text: 'm2' }] }),
      ],
    }));
    const host = makeHost(persistence);
    const latest = await run(host, { action: 'get-state', instanceId: 'inst-1', stepId: 'step-1' });
    const latestData = latest.data as { segmentCount: number; latest: { attemptIndex?: number; outputPreview?: { text: string; truncated: boolean }; sessionMessagesCount?: number; output?: unknown; sessionMeta?: { childId: string } } };
    expect(latestData.segmentCount).toBe(2);
    expect(latestData.latest.attemptIndex).toBe(1);
    expect(latestData.latest.outputPreview).toMatchObject({ truncated: true });
    expect(latestData.latest.sessionMessagesCount).toBe(2);
    expect(latestData.latest.output).toBeUndefined();
    expect(latestData.latest.sessionMeta).toMatchObject({ childId: 'child-9' });

    const picked = await run(host, { action: 'get-state', instanceId: 'inst-1', stepId: 'step-1', attemptIndex: 0 });
    expect(((picked.data as { latest: { attemptIndex?: number } }).latest).attemptIndex).toBe(0);

    const detailed = await run(host, { action: 'get-state', instanceId: 'inst-1', stepId: 'step-1', includeDetail: true });
    const detailedData = detailed.data as { latest: { output: unknown; sessionMessages?: unknown[] } };
    expect(Array.isArray(detailedData.latest.output)).toBe(true);
    expect(detailedData.latest.sessionMessages).toHaveLength(2);

    const unknownSegment = await run(host, { action: 'get-state', instanceId: 'inst-1', stepId: 'nope' });
    expect(unknownSegment.error).toMatchObject({ code: 'NODE_NOT_FOUND' });
    const unknownAttempt = await run(host, { action: 'get-state', instanceId: 'inst-1', stepId: 'step-1', attemptIndex: 9 });
    expect(unknownAttempt.error).toMatchObject({ code: 'NODE_NOT_FOUND' });
  });

  it('returns the full summary shape (workflowName/pending interactions filtered/userMessages tail)', async () => {
    const question = { id: 'q-1', stageId: 'stg-a', stepId: 'step-1', sessionId: 's1', requestId: 'rq-1', kind: 'question' as const, status: 'pending' as const, payload: { questions: [{ id: 'q1', question: 'Q?' }] }, createdAt: 't0' };
    const replied = { id: 'q-2', stageId: 'stg-a', stepId: 'step-1', sessionId: 's1', requestId: 'rq-2', kind: 'question' as const, status: 'replied' as const, payload: { questions: [{ id: 'q1', question: 'Q?' }] }, answer: [['A']], createdAt: 't0' };
    const permission = { id: 'p-1', stageId: 'stg-a', stepId: 'step-2', sessionId: 's1', requestId: 'rq-3', kind: 'permission' as const, status: 'pending' as const, payload: { permission: 'workspace-write' }, createdAt: 't0' };
    const userMessages = Array.from({ length: 12 }, (_, index) => ({ id: `m-${index}`, kind: 'message' as const, target: 'step-1', content: `msg ${index}`, createdAt: `t${index}` }));
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', makeState({
      workflowName: 'Demo',
      executedSteps: [makeExecutedStep(), makeExecutedStep({ id: 'seg-b', stepId: 'step-2', name: 'StepTwo' })],
      pendingQueue: ['step-1'],
      pendingInteractions: [question, replied, permission],
      userMessages,
    }));
    const host = makeHost(persistence);
    const result = await run(host, { action: 'get-state', instanceId: 'inst-1' });
    expect(result.ok).toBe(true);
    const data = result.data as {
      workflowName?: string;
      executedSteps: unknown[];
      pendingQueue: string[];
      pendingInteractions: Array<{ id: string; kind: string }>;
      userMessages?: unknown[];
    };
    expect(data.workflowName).toBe('Demo');
    expect(data.executedSteps).toHaveLength(2);
    expect(data.pendingQueue).toEqual(['step-1']);
    // 只列 pending 的交互（replied 过滤掉），保留 question/permission 两 kind。
    expect(data.pendingInteractions.map(entry => entry.kind).sort()).toEqual(['permission', 'question']);
    expect(data.userMessages).toHaveLength(10); // 尾部 10 条
  });

  it('targets a stage (info + contract + step rows) and rejects unknown stages', async () => {
    const persistence = makePersistence();
    persistence.state.map.set('inst-1', makeState({
      executedSteps: [makeExecutedStep()],
      stageContracts: { 'stg-a': { stageId: 'stg-a', stageName: 'StageA', status: 'running', artifacts: [], passThroughVars: {}, contractArtifacts: {}, completedAt: 't1' } },
    }));
    const host = makeHost(persistence);
    const result = await run(host, { action: 'get-state', instanceId: 'inst-1', stageId: 'stg-a' });
    const data = result.data as { stage: { id: string }; contract?: { stageId: string }; executedSteps: unknown[] };
    expect(data.stage.id).toBe('stg-a');
    expect(data.contract).toMatchObject({ stageId: 'stg-a' });
    expect(data.executedSteps).toHaveLength(1);
    const unknown = await run(host, { action: 'get-state', instanceId: 'inst-1', stageId: 'nope' });
    expect(unknown.error).toMatchObject({ code: 'NODE_NOT_FOUND' });
  });
});

// ── lib-list / lib-get ────────────────────────────────────────────────────────

describe('lib-list / lib-get', () => {
  it('lists all three libraries by default (workflow counts, referencedBy rows)', async () => {
    const host = makeHost(makePersistence());
    const result = await run(host, { action: 'lib-list' });
    const libraries = result.data as { libraries: Array<{ kind: string; entries: Array<Record<string, unknown>> }> };
    expect(libraries.libraries.map(library => library.kind)).toEqual(['workflow', 'step', 'microflow']);
    expect(libraries.libraries[0]!.entries.find(entry => entry.id === 'wfl-1')).toMatchObject({ stageCount: 1, stepCount: 2 });
    // step-1 被 wfl-1 与 wfl-orphan? no——wfl-orphan 顶层是 step-real；step-1 仅 wfl-1 引用。
    expect(libraries.libraries[1]!.entries.find(entry => entry.id === 'step-1')).toMatchObject({ referencedBy: 1 });
  });

  it('filters a single library via lib', async () => {
    const host = makeHost(makePersistence());
    const result = await run(host, { action: 'lib-list', lib: 'microflow' });
    const libraries = result.data as { libraries: Array<{ kind: string }> };
    expect(libraries.libraries).toHaveLength(1);
    expect(libraries.libraries[0]!.kind).toBe('microflow');
  });

  it('returns a full library entry with referencing workflows; NODE_NOT_FOUND otherwise', async () => {
    const host = makeHost(makePersistence());
    const result = await run(host, { action: 'lib-get', lib: 'step', entryId: 'step-1' });
    const data = result.data as { kind: string; entry: { id: string }; referencedBy: Array<{ workflowId: string; name: string }> };
    expect(data.entry.id).toBe('step-1');
    expect(data.referencedBy).toEqual([expect.objectContaining({ workflowId: 'wfl-1', name: 'Demo' })]);
    const missing = await run(host, { action: 'lib-get', lib: 'step', entryId: 'nope' });
    expect(missing.error).toMatchObject({ code: 'NODE_NOT_FOUND' });
    expect(missing.reason).toContain('Agent 库');
  });

  it('rejects lib-get without lib/entryId and routes workflow kind to get-def', async () => {
    const host = makeHost(makePersistence());
    const workflowKind = await run(host, { action: 'lib-get', lib: 'workflow', entryId: 'wfl-1' });
    expect(workflowKind.error).toMatchObject({ code: 'INVALID_OPERATION' });
    const noEntry = await run(host, { action: 'lib-get', lib: 'step' });
    expect(noEntry.error).toMatchObject({ code: 'INVALID_OPERATION' });
  });
});

// ── 注册与 gate ───────────────────────────────────────────────────────────────

describe('registerGlobalManagerTool / execute gate', () => {
  it('skips registration when the tools service is absent', () => {
    const bareCtx = { get: () => undefined } as unknown as Context;
    const disposer = registerGlobalManagerTool(bareCtx, makeHost(makePersistence()));
    expect(disposer).toBeTypeOf('function');
  });

  it('registers a normalized definition and gates non-top-level callers (Q7)', async () => {
    const registered: unknown[] = [];
    const registry = { register: (tool: unknown) => { registered.push(tool); return () => {}; } };
    const ctx = { get: (name: string) => (name === 'tools' ? registry : undefined) } as unknown as Context;
    const disposer = registerGlobalManagerTool(ctx, makeHost(makePersistence()));
    expect(disposer).toBeTypeOf('function');

    expect(registered).toHaveLength(1);
    const tool = registered[0] as { name: string; description: string; parameters: typeof WORKFLOW_MANAGER_PARAMETERS; output: { schema: { required: string[] } }; execute(args: unknown, exec: unknown): Promise<SandoreManagerToolResult> };
    expect(tool.name).toBe(WORKFLOW_MANAGER_TOOL_NAME);
    expect(tool.description).toContain('Sandore workflow manager');
    // 规范化 JSON Schema：required 只用 object 节点字符串数组，六 action 枚举。
    expect(tool.parameters.required).toEqual(['action']);
    expect(tool.parameters.properties.action.enum).toHaveLength(6);
    expect(tool.output.schema.required).toEqual(['ok']);

    // gate：委派子代理拒绝；顶层会话放行并真正执行 action。
    const host = makeHost(makePersistence());
    const denied = await tool.execute({ action: 'lib-list' }, subagentExec);
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatchObject({ code: 'INVALID_OPERATION' });
    expect(denied.reason).toContain('顶层');
    const allowed = await tool.execute({ action: 'lib-list' }, topLevelExec);
    expect(allowed.ok).toBe(true);
  });

  it('maps invalid arguments to a readable INVALID_OPERATION envelope', async () => {
    const host = makeHost(makePersistence());
    const result = await executeManagerTool(host, { action: 'nope' }, topLevelExec);
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_OPERATION' });
  });
});
