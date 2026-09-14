/**
 * `manager-tool.ts` 的单元测试（架构决策 3 收窄后）：定义查改（get-def/update-def）
 * 四 action 语义、寻址/合并纯函数、跨字段硬约束、lib 浏览、注册降级与 execute 期 gate。
 * 全 mock（Map 背书的 persistence 视图 + fake host），无宿主依赖。
 *
 * 运行面（run / status / send_message / control）已拆成独立工具，用例见
 * `host-tools.spec.ts`。
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
  SandoreToolEnvelope,
  SandoreToolHost,
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

function makeHost(persistence: FixturePersistence): SandoreToolHost & { startRequests: DagStartRequest[] } {
  const startRequests: DagStartRequest[] = [];
  return {
    startRequests,
    startInstance: vi.fn(async (request: DagStartRequest) => {
      startRequests.push(request);
      return { instanceId: 'inst-1', status: 'pending' as const };
    }),
    runInstanceInSession: vi.fn(async (_hostSessionId: string, request: DagStartRequest) => {
      startRequests.push(request);
      return { instanceId: 'inst-1', status: 'running' as const };
    }),
    getState: vi.fn(() => {
      throw new Error('not stubbed');
    }),
    getInstanceState: vi.fn(() => undefined),
    findInstanceIdByHostSession: vi.fn(() => undefined),
    pauseStep: vi.fn(async () => {}),
    pauseAllSteps: vi.fn(async () => {}),
    resumeStep: vi.fn(async () => {}),
    resumeAllSteps: vi.fn(async () => {}),
    retryStep: vi.fn(async () => {}),
    sendStepMessage: vi.fn(async () => {}),
    persistence: () => persistence,
  };
}

/** 顶层主代理调用方（gate 放行）。 */
const topLevelExec = { agent: { session: { id: 'sess-1', header: { cwd: '/w' } } } };
/** 委派子代理调用方（gate 拒绝）。 */
const subagentExec = { agent: { session: { id: 'child-1', header: { parentSession: 'host-x' } } } };

async function run(host: SandoreToolHost, args: Partial<ManagerToolArgs>, exec: unknown = topLevelExec): Promise<SandoreToolEnvelope> {
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
    const data = result.data as { stages: Array<{ id: string; steps: Array<{ id: string }> }>; stepDefinitionCount: number; orphanStepDefinitions?: unknown[]; libraryHints: { stages: Array<{ id: string; present: boolean; name?: string; libraryUpdatedAt?: string }>; steps: Array<{ id: string; present: boolean }> } };
    expect(data.stages[0]!.steps.map(step => step.id)).toEqual(['step-1', 'step-2']);
    // S3：完整 step 定义只在 stages[].steps[] 的合并视图里出现一次（不再重复一份 stepDefinitions）。
    expect(data.stepDefinitionCount).toBe(2);
    expect(data.orphanStepDefinitions).toBeUndefined();
    // 库提示按「库表是否有同 id 快照条目」判定：stg-a/step-1 有库条目；step-2 无。
    expect(data.libraryHints.stages.find(hint => hint.id === 'stg-a')).toMatchObject({ present: true, name: 'StageA', libraryUpdatedAt: 't1' });
    expect(data.libraryHints.steps.find(hint => hint.id === 'step-1')).toMatchObject({ present: true, name: 'StepOne' });
    expect(data.libraryHints.steps.find(hint => hint.id === 'step-2')).toMatchObject({ present: false });
  });

  it('S3: returns ONLY orphan step definitions (流控位未引用的定义)，已放置的定义只在合并视图里出现一次', async () => {
    const persistence = makePersistence();
    // 在 demo 定义上追加一个「有顶层定义但没有任何 stage 流控位引用」的孤儿 step。
    const original = parseWorkflowYaml(demoYaml);
    const withOrphan = `${demoYaml}  - id: step-orphan\n    name: OrphanStep\n`;
    void original;
    persistence.definitions.map.set('wfl-1', {
      yaml: withOrphan, name: 'Demo', version: '1', createdAt: 't0', updatedAt: 't1',
    });
    const host = makeHost(persistence);
    const result = await run(host, { action: 'get-def', workflowId: 'wfl-1' });
    expect(result.ok).toBe(true);
    const data = result.data as {
      stages: Array<{ steps: Array<{ id: string }> }>;
      stepDefinitionCount: number;
      orphanStepDefinitions?: Array<{ id: string }>;
    };
    // 已放置的 step-1/step-2 在合并视图里；孤儿定义**只**在 orphanStepDefinitions 里（不重复返回）。
    expect(data.stepDefinitionCount).toBe(3);
    expect(data.stages[0]!.steps.map(step => step.id)).toEqual(['step-1', 'step-2']);
    expect(data.orphanStepDefinitions?.map(step => step.id)).toEqual(['step-orphan']);
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

// ── run / get-state 已迁出（架构决策 3：独立工具） ─────────────────────────────
//
// 原 `sandore_workflow` 的 `run` 与 `get-state` 两个 action 已移除（不留两套入口）：
// - run → `sandore_workflow_run`（run-tool.spec.ts + host-tools.spec.ts）
// - get-state → `sandore_workflow_status`（status-tool.spec.ts + host-tools.spec.ts）
//
// 旧用例（hostSessionId 组装 / get-state 定点与裁剪）随行为迁移到上述 spec，
// 此处不再保留——本文件只覆盖「定义 + 库」这条低频资源管理面。

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

  it('rejects lib-get without lib/entryId and routes workflow kind to get-def (S2: 两条文案分开)', async () => {
    const host = makeHost(makePersistence());
    const workflowKind = await run(host, { action: 'lib-get', lib: 'workflow', entryId: 'wfl-1' });
    expect(workflowKind.error).toMatchObject({ code: 'INVALID_OPERATION' });
    expect(workflowKind.reason).toContain("lib-get 不支持 lib='workflow'");
    expect(workflowKind.reason).toContain("action='get-def'");
    const noEntry = await run(host, { action: 'lib-get', lib: 'step' });
    expect(noEntry.error).toMatchObject({ code: 'INVALID_OPERATION' });
    // 缺 lib 的文案与 lib='workflow' 不同（旧实现共用一条，对「忘了传」不够直白）。
    const noLib = await run(host, { action: 'lib-get', entryId: 'step-1' });
    expect(noLib.error).toMatchObject({ code: 'INVALID_OPERATION' });
    expect(noLib.reason).toContain('lib-get 必须携带 lib');
    expect(noLib.reason).not.toBe(workflowKind.reason);
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
    const tool = registered[0] as { name: string; description: string; parameters: typeof WORKFLOW_MANAGER_PARAMETERS; output: { schema: { required: string[] } }; execute(args: unknown, exec: unknown): Promise<SandoreToolEnvelope> };
    expect(tool.name).toBe(WORKFLOW_MANAGER_TOOL_NAME);
    expect(tool.description).toContain('Sandore workflow definitions and libraries');
    // 架构决策 3：本工具不再有运行面 action（run/get-state 已迁出，共 4 个 action）。
    expect(tool.description).toContain('does NOT run workflows');
    expect(tool.parameters.required).toEqual(['action']);
    expect(tool.parameters.properties.action.enum).toEqual(['get-def', 'update-def', 'lib-list', 'lib-get']);
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
