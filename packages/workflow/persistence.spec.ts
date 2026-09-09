/**
 * persistence.ts（SandorePersistence）的单元测试：域打开/关闭生命周期与
 * 状态快照全量覆盖写。
 * @module @meiyukichan/dsh-sandore/workflow/src/persistence.spec
 */
import { Context } from '@deepseek-ai/cordis'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it } from 'vitest'

import { MemoryStorageDomain } from '../tests/mocks/storage-domain.ts'
import { SandorePersistence } from './persistence.ts'
import type {
  MicroflowRecord, StepRecord, WorkflowDefinition, WorkflowTaskState,
} from './schema.ts'

/** 构造一个字段完整的 `WorkflowTaskState` 快照（`taskId` 必填）。 */
function makeState(overrides: Partial<WorkflowTaskState> & { taskId: string }): WorkflowTaskState {
  const { taskId, ...rest } = overrides
  const now = new Date().toISOString()
  return {
    taskId,
    jobId: 'job-1',
    workflowId: 'wfl-1',
    cwd: '/tmp',
    status: 'running',
    originalInput: 'do the thing',
    currentStageId: '',
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
    createdAt: now,
    updatedAt: now,
    ...rest,
  }
}

/** 组装测试 harness：注入内存 storageDomain 并加载 SandorePersistence。 */
async function harness(): Promise<{ ctx: Context; storageDomain: MemoryStorageDomain }> {
  const ctx = new Context()
  const storageDomain = new MemoryStorageDomain()
  ctx.provide('storageDomain', storageDomain as unknown as DomainFacility)
  await ctx.plugin(SandorePersistence)
  return { ctx, storageDomain }
}

describe('SandorePersistence', () => {
  it('opens the sandore domain and resolves the table handles on init', async () => {
    const { ctx, storageDomain } = await harness()
    const persistence = ctx.sandorePersistence

    expect(storageDomain.get('sandore')).toBeDefined()
    expect(storageDomain.get('sandore')?.name).toBe('sandore')
    expect(persistence.definitions.size).toBe(0)
    expect(persistence.state.size).toBe(0)
    // 三级分离：库表句柄就绪（version 保持 1，新增空表无需迁移）。
    expect(persistence.steps.size).toBe(0)
    expect(persistence.microflows.size).toBe(0)
  })

  it('closes the domain when the provider fiber unloads', async () => {
    const ctx = new Context()
    const storageDomain = new MemoryStorageDomain()
    ctx.provide('storageDomain', storageDomain as unknown as DomainFacility)
    const fiber = ctx.plugin(SandorePersistence)
    await fiber

    expect(storageDomain.get('sandore')?.closed).toBe(false)
    await fiber.dispose()
    expect(storageDomain.get('sandore')?.closed).toBe(true)
  })

  it('overwrites the full snapshot for the same instanceId on repeated saveWorkflowState', async () => {
    const { ctx } = await harness()
    const persistence = ctx.sandorePersistence

    const first = makeState({
      taskId: 'inst-1',
      originalInput: 'first input',
      executedSteps: [
        {
          type: 'default',
          id: 'step-1',
          stepId: 'step-1',
          stageId: 'stg-1',
          name: 'lint',
          status: 'completed',
          visitCount: 1,
        },
      ],
    })
    const second = makeState({
      taskId: 'inst-1',
      originalInput: 'second input',
      status: 'completed',
    })

    await persistence.saveWorkflowState(first)
    await persistence.saveWorkflowState(second)

    const snapshot = persistence.state.get('inst-1')
    expect(snapshot).toEqual(second)
    expect(snapshot?.originalInput).toBe('second input')
    // 全量覆盖：旧快照的 executedSteps 不应残留。
    expect(snapshot?.executedSteps).toHaveLength(0)
  })
})

/** 构造一个最小合法的 Step 库条目。 */
function makeStepRecord(overrides: Partial<StepRecord> & { id: string; name: string }): StepRecord {
  const { id, name, ...rest } = overrides
  return {
    id,
    name,
    command: { type: 'shell', value: { command: 'echo hi' } },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...rest,
  }
}

/** 构造一个最小合法的 Microflow 库条目。 */
function makeMicroflowRecord(overrides: Partial<MicroflowRecord> & { id: string; name: string }): MicroflowRecord {
  const { id, name, ...rest } = overrides
  return {
    id,
    name,
    steps: [{ id: 'step-a' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...rest,
  }
}

/** 构造一个最小合法定义（putIfAbsent 自动入库测试用）。 */
function makeDefinition(overrides: Partial<WorkflowDefinition> & { id: string; name: string }): WorkflowDefinition {
  const { id, name, ...rest } = overrides
  return {
    id,
    name,
    version: '1.0.0',
    skills: [],
    mcps: [],
    agents: [],
    settings: { defaultTimeout: 120, maxConcurrentAgents: 4 },
    stages: [{ id: 'stg-a', name: '阶段 A', steps: [{ id: 'step-a' }] }],
    steps: [{ id: 'step-a', name: '步骤 A', command: { type: 'shell', value: { command: 'echo hi' } } }],
    ...rest,
  }
}

describe('SandorePersistence 库表（三级分离 putIfAbsent / upsert / 查重 / 自动入库）', () => {
  it('putStepIfAbsent writes only when the id is absent (自动入库仅一次)', async () => {
    const { ctx } = await harness()
    const persistence = ctx.sandorePersistence
    const record = makeStepRecord({ id: 'step-1', name: '构建' })

    await expect(persistence.putStepIfAbsent(record)).resolves.toBe(true)
    // 库已有此 id：后续修改保存跳过（独立快照语义）。
    await expect(persistence.putStepIfAbsent(makeStepRecord({ id: 'step-1', name: '已改名' }))).resolves.toBe(false)
    expect(persistence.steps.get('step-1')?.name).toBe('构建')
  })

  it('putMicroflowIfAbsent writes only when the id is absent', async () => {
    const { ctx } = await harness()
    const persistence = ctx.sandorePersistence

    await expect(persistence.putMicroflowIfAbsent(makeMicroflowRecord({ id: 'stg-1', name: '构建' }))).resolves.toBe(true)
    await expect(persistence.putMicroflowIfAbsent(makeMicroflowRecord({ id: 'stg-1', name: '已改名' }))).resolves.toBe(false)
    expect(persistence.microflows.get('stg-1')?.name).toBe('构建')
  })

  it('upsertStep overwrites the record as-is (createdAt 合并在 remote 层)', async () => {
    const { ctx } = await harness()
    const persistence = ctx.sandorePersistence
    await persistence.putStepIfAbsent(makeStepRecord({ id: 'step-1', name: '构建' }))

    await persistence.upsertStep(makeStepRecord({ id: 'step-1', name: '构建', command: { type: 'shell', value: { command: 'pnpm build' } } }))

    // persistence 层为直接覆盖写：payload 原样入库（remote 层负责保留 createdAt）。
    const updated = persistence.steps.get('step-1')
    expect(updated?.command).toEqual({ type: 'shell', value: { command: 'pnpm build' } })
    expect(updated?.name).toBe('构建')
  })

  it('upsertStep rejects a duplicate name with a different id (DUPLICATE_NAME + 已有 id)', async () => {
    const { ctx } = await harness()
    const persistence = ctx.sandorePersistence
    await persistence.putStepIfAbsent(makeStepRecord({ id: 'step-1', name: '构建' }))

    // 同 name 不同 id → 拒绝，消息携带已有条目 id。
    await expect(persistence.upsertStep(makeStepRecord({ id: 'step-2', name: '构建' }))).rejects.toMatchObject({
      code: 'DUPLICATE_NAME',
    })
    // 同 id 同 name → 正常覆盖（消息不误伤自己）。
    await expect(persistence.upsertStep(makeStepRecord({ id: 'step-1', name: '构建' }))).resolves.toBeUndefined()
  })

  it('upsertMicroflow rejects a duplicate name with a different id (DUPLICATE_NAME)', async () => {
    const { ctx } = await harness()
    const persistence = ctx.sandorePersistence
    await persistence.putMicroflowIfAbsent(makeMicroflowRecord({ id: 'stg-1', name: '构建' }))

    await expect(persistence.upsertMicroflow(makeMicroflowRecord({ id: 'stg-2', name: '构建' }))).rejects.toMatchObject({
      code: 'DUPLICATE_NAME',
    })
  })

  it('writeDefinitionToLibraries auto-registers named stages/steps once (putIfAbsent 语义)', async () => {
    const { ctx } = await harness()
    const persistence = ctx.sandorePersistence
    const definition = makeDefinition({ id: 'wfl-1', name: '工作流' })

    await persistence.writeDefinitionToLibraries(definition)
    expect(persistence.microflows.get('stg-a')?.name).toBe('阶段 A')
    expect(persistence.steps.get('step-a')?.name).toBe('步骤 A')

    // 后续修改保存（stage 改名）→ 库已有 id → 不覆盖（独立快照）。
    const renamed: WorkflowDefinition = {
      ...definition,
      stages: [{ id: 'stg-a', name: '阶段 A 已改名', steps: [{ id: 'step-a' }] }],
    }
    await persistence.writeDefinitionToLibraries(renamed)
    expect(persistence.microflows.get('stg-a')?.name).toBe('阶段 A')
  })

  it('writeDefinitionToLibraries skips unnamed steps and name-conflicting entries without throwing', async () => {
    const { ctx } = await harness()
    const persistence = ctx.sandorePersistence
    // 库中已有同名不同 id 条目（microflow「构建」= stg-other；step「构建」= step-other）。
    await persistence.putMicroflowIfAbsent(makeMicroflowRecord({ id: 'stg-other', name: '构建' }))
    await persistence.putStepIfAbsent(makeStepRecord({ id: 'step-other', name: '构建' }))

    const definition: WorkflowDefinition = {
      id: 'wfl-1',
      name: '工作流',
      version: '1.0.0',
      skills: [],
      mcps: [],
      agents: [],
      settings: { defaultTimeout: 120, maxConcurrentAgents: 4 },
      stages: [
        { id: 'stg-a', name: '构建', steps: [] }, // 同名不同 id → 自动路径静默跳过
        { id: 'stg-b', name: '', steps: [] }, // 空名 stage → 跳过
      ],
      steps: [
        { id: 'step-anon', command: { type: 'shell', value: { command: 'x' } } }, // 无名 step → 跳过
        { id: 'step-mine', name: '构建', command: { type: 'shell', value: { command: 'x' } } }, // 同名冲突 → 跳过
      ],
    }

    // 自动入库 best-effort：任何冲突都不抛错、不阻断保存。
    await expect(persistence.writeDefinitionToLibraries(definition)).resolves.toBeUndefined()
    expect(persistence.microflows.get('stg-a')).toBeUndefined()
    expect(persistence.microflows.get('stg-b')).toBeUndefined()
    expect(persistence.steps.get('step-anon')).toBeUndefined()
    expect(persistence.steps.get('step-mine')).toBeUndefined()
  })
})
