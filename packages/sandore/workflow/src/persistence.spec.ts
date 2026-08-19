/**
 * persistence.ts（SandorePersistence）的单元测试：域打开/关闭生命周期与
 * 状态快照全量覆盖写。
 * @module @deepseek-ai/dsh-sandore-workflow/src/persistence.spec
 */
import { Context } from '@deepseek-ai/cordis'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it } from 'vitest'

import { MemoryStorageDomain } from '../tests/mocks/storage-domain.ts'
import { SandorePersistence } from './persistence.ts'
import type { WorkflowTaskState } from './schema.ts'

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
  it('opens the sandore domain and resolves the three table handles on init', async () => {
    const { ctx, storageDomain } = await harness()
    const persistence = ctx.sandorePersistence

    expect(storageDomain.get('sandore')).toBeDefined()
    expect(storageDomain.get('sandore')?.name).toBe('sandore')
    expect(persistence.definitions.size).toBe(0)
    expect(persistence.state.size).toBe(0)
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
