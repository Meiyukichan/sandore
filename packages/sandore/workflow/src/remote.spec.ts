/**
 * remote.ts（SandoreRemote）的单元测试：定义/实例 CRUD、产物查询、
 * Provider/Model 转发与 ping。测试用内存 mock storageDomain + mock llm +
 * mock sandoreEngine。
 * @module @deepseek-ai/dsh-sandore-workflow/src/remote.spec
 */
import { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'

import { MemoryStorageDomain } from '../tests/mocks/storage-domain.ts'
import { SandoreError } from './errors.ts'
import type { SandoreEngine } from './index.ts'
import { SandorePersistence } from './persistence.ts'
import { SandoreRemote } from './remote.ts'
import type { WorkflowTaskState } from './schema.ts'
import type { AskUserQuestionAnswer, DagRun, DagStartRequest } from './types.ts'
import { parseWorkflowYaml } from './yaml-parser.ts'

const validV2Yaml = `id: wfl-source
name: demo
version: "1.0.0"
description: shell to prompt
stages:
  - id: stg-1
    name: 分析
    steps:
      - id: step-1
steps:
  - id: step-1
    name: lint
    command:
      type: shell
      value:
        command: "echo hi"
`

/** 构造一个字段完整的 `WorkflowTaskState` 快照（`taskId` 必填）。 */
function makeState(overrides: Partial<WorkflowTaskState> & { taskId: string }): WorkflowTaskState {
  const { taskId, ...rest } = overrides
  const now = new Date().toISOString()
  return {
    taskId,
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

/**
 * 捕获 `fn` 抛出的 {@link SandoreError} 并返回其 `code`；未抛错或非 SandoreError 返回 `undefined`。
 * @param fn - 待执行的可疑同步函数。
 */
function catchCode(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (err) {
    return err instanceof SandoreError ? err.code : undefined
  }
}

/**
 * 捕获 `fn` 异步拒绝的 {@link SandoreError} 并返回其 `code`；未拒绝或非 SandoreError 返回 `undefined`。
 * @param fn - 待执行的可疑异步函数。
 */
async function catchCodeAsync(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn()
    return undefined
  } catch (err) {
    return err instanceof SandoreError ? err.code : undefined
  }
}

/** mock 引擎的 7 个生命周期方法桩（`vi.fn` 记录调用，便于断言转调链路）。 */
interface MockLifecycleEngine {
  replyQuestion: ReturnType<typeof vi.fn>
  replyPermission: ReturnType<typeof vi.fn>
  pauseStep: ReturnType<typeof vi.fn>
  resumeStep: ReturnType<typeof vi.fn>
  pauseAllSteps: ReturnType<typeof vi.fn>
  resumeAllSteps: ReturnType<typeof vi.fn>
  retryStep: ReturnType<typeof vi.fn>
}

/** 组装测试 harness：注入内存 storageDomain、mock llm 与 mock 引擎。 */
async function harness(): Promise<{
  ctx: Context
  persistence: SandorePersistence
  remote: SandoreRemote
  engine: {
    startInstance: (request: DagStartRequest) => DagRun
    abortInstance: (instanceId: string) => Promise<void>
  } & MockLifecycleEngine
}> {
  const ctx = new Context()
  const storageDomain = new MemoryStorageDomain()
  ctx.provide('storageDomain', storageDomain as unknown as DomainFacility)
  await ctx.plugin(SandorePersistence)
  const persistence = ctx.sandorePersistence

  const llm = {
    listProviders: () => [{ id: 'provider-a', name: 'Provider A' }],
    listModels: async (provider: string) =>
      provider === 'provider-a'
        ? [{ provider: 'provider-a', id: 'model-a', name: 'Model A' }]
        : [],
  }
  ctx.provide('llm', llm as unknown as LlmRuntime)

  const startInstance = (request: DagStartRequest): DagRun => {
    const instanceId = `inst-${globalThis.crypto.randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const state: WorkflowTaskState = {
      taskId: instanceId,
      workflowId: request.workflowId,
      cwd: request.cwd ?? '/tmp',
      status: 'running',
      originalInput: request.originalInput,
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
    }
    void persistence.saveWorkflowState(state)
    return { instanceId, status: 'running' }
  }
  const engine = {
    startInstance,
    abortInstance: async (instanceId: string): Promise<void> => {
      const current = persistence.state.get(instanceId)
      if (current === undefined) return
      await persistence.saveWorkflowState({ ...current, status: 'aborted', updatedAt: new Date().toISOString() })
    },
    replyQuestion: vi.fn(async (_instanceId: string, _requestId: string, _answers: AskUserQuestionAnswer) => {}),
    replyPermission: vi.fn(async (_instanceId: string, _requestId: string, _reply: 'once' | 'always' | 'reject') => {}),
    pauseStep: vi.fn(async (_instanceId: string, _stepId: string) => {}),
    resumeStep: vi.fn(async (_instanceId: string, _stepId: string, _resumePrompt?: string) => {}),
    pauseAllSteps: vi.fn(async (_instanceId: string) => {}),
    resumeAllSteps: vi.fn(async (_instanceId: string, _resumePrompt?: string) => {}),
    retryStep: vi.fn(async (_instanceId: string, _stepId: string, _mode: 'continue' | 'revert' | 'fork', _message: string) => {}),
  }
  ctx.provide('sandoreEngine', engine as unknown as SandoreEngine)

  const remote = new SandoreRemote(ctx)
  return { ctx, persistence, remote, engine }
}

describe('SandoreRemote definition CRUD', () => {
  it('creates a wfl- prefixed definition and lists/yaml round-trips it', async () => {
    const { remote } = await harness()

    const created = await remote.createDefinition({ yaml: validV2Yaml })
    expect(created.id).toMatch(/^wfl-/)
    expect(created.name).toBe('demo')
    expect(created.version).toBe('1.0.0')

    // 存储的 YAML 文本经规范序列化，其顶层 id 与记录键一致（而非调用方传入的原文 id）。
    expect(parseWorkflowYaml(created.yaml).id).toBe(created.id)

    const listed = remote.listDefinitions()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(created.id)
    expect(remote.getYaml(created.id)).toBe(created.yaml)
  })

  it('stores canonical YAML whose id matches the record key, not the sentinel id', async () => {
    const { remote } = await harness()
    const blankYaml = `id: wfl-new
name: 未命名工作流
version: "1.0.0"
skills: []
mcps: []
agents: []
settings:
  defaultTimeout: 120
  maxConcurrentAgents: 4
stages:
  - id: stg-1
    name: 阶段 1
    steps: []
`

    const created = await remote.createDefinition({ yaml: blankYaml })

    expect(created.id).toMatch(/^wfl-/)
    expect(created.id).not.toBe('wfl-new')
    // 首次保存后再打开，YAML 里的 id 是真实 wfl-{uuid} 而非 wfl-new。
    const stored = parseWorkflowYaml(remote.getYaml(created.id))
    expect(stored.id).toBe(created.id)
    expect(stored.id).not.toBe('wfl-new')
  })

  it('rejects invalid YAML and leaves the definitions table empty', async () => {
    const { remote } = await harness()

    await expect(remote.createDefinition({ yaml: 'stages: [ broken' })).rejects.toMatchObject({
      code: 'YAML_PARSE',
    })
    expect(remote.listDefinitions()).toHaveLength(0)
  })

  it('rejects invalid YAML on updateYaml and keeps the old yaml', async () => {
    const { remote } = await harness()
    const created = await remote.createDefinition({ yaml: validV2Yaml })

    await expect(remote.updateYaml(created.id, 'stages: [ broken')).rejects.toMatchObject({
      code: 'YAML_PARSE',
    })
    expect(remote.getYaml(created.id)).toBe(created.yaml)
  })

  it('syncs metadata from the new yaml on updateYaml', async () => {
    const { remote } = await harness()
    const created = await remote.createDefinition({ yaml: validV2Yaml })
    const renamed = validV2Yaml.replace('name: demo', 'name: 已改名工作流')

    const updated = await remote.updateYaml(created.id, renamed)

    expect(updated.name).toBe('已改名工作流')
    expect(updated.yaml).toBe(renamed)
    expect(remote.listDefinitions().find(entry => entry.id === created.id)?.name).toBe('已改名工作流')
  })

  it('deletes a definition idempotently', async () => {
    const { remote } = await harness()
    const created = await remote.createDefinition({ yaml: validV2Yaml })

    await expect(remote.deleteDefinition(created.id)).resolves.toBe(true)
    expect(remote.listDefinitions()).toHaveLength(0)
    await expect(remote.deleteDefinition(created.id)).resolves.toBe(false)
  })

  it('updates definition metadata and returns the updated record', async () => {
    const { remote } = await harness()
    const created = await remote.createDefinition({ yaml: validV2Yaml })

    const updated = await remote.updateDefinition(created.id, {
      name: 'renamed',
      version: '2.0.0',
      description: 'new description',
    })

    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe('renamed')
    expect(updated.version).toBe('2.0.0')
    expect(updated.description).toBe('new description')
    expect(updated.yaml).toBe(created.yaml)
  })

  it('getYaml throws NODE_NOT_FOUND for a nonexistent definition', async () => {
    const { remote } = await harness()

    expect(catchCode(() => remote.getYaml('wfl-nonexistent'))).toBe('NODE_NOT_FOUND')
  })
})

describe('SandoreRemote instance lifecycle', () => {
  it('startInstance returns a run and writes a readable state snapshot', async () => {
    const { remote, persistence } = await harness()
    const definition = await remote.createDefinition({ yaml: validV2Yaml })

    const run = await remote.startInstance({ workflowId: definition.id, originalInput: '测试需求' })
    expect(run.instanceId).toBeTruthy()
    expect(run.status).toBe('running')

    const state = remote.getInstanceState(run.instanceId)
    expect(state.originalInput).toBe('测试需求')
    expect(state.workflowId).toBe(definition.id)
    expect(persistence.state.get(run.instanceId)?.originalInput).toBe('测试需求')
  })

  it('rejects startInstance for a nonexistent workflowId', async () => {
    const { remote } = await harness()

    await expect(remote.startInstance({ workflowId: 'wfl-nonexistent', originalInput: 'x' })).rejects.toMatchObject({
      code: 'INVALID_OPERATION',
    })
  })

  it('derives instance summaries for every state row (no job filter)', async () => {
    const { remote } = await harness()
    const definition = await remote.createDefinition({ yaml: validV2Yaml })
    await remote.startInstance({ workflowId: definition.id, originalInput: 'a' })
    await remote.startInstance({ workflowId: definition.id, originalInput: 'b' })

    const instances = remote.listInstances()
    expect(instances).toHaveLength(2)
    expect(instances.map(instance => instance.workflowId)).toEqual([definition.id, definition.id])
    expect(instances.map(instance => instance.originalInput).sort()).toEqual(['a', 'b'])
  })

  it('removes the snapshot on deleteInstance', async () => {
    const { remote } = await harness()
    const definition = await remote.createDefinition({ yaml: validV2Yaml })
    const run = await remote.startInstance({ workflowId: definition.id, originalInput: 'x' })

    await remote.deleteInstance(run.instanceId)
    expect(catchCode(() => remote.getInstanceState(run.instanceId))).toBe('NODE_NOT_FOUND')
    expect(remote.listInstances()).toHaveLength(0)
  })

  it('rejects abortInstance for a completed instance', async () => {
    const { remote, persistence } = await harness()
    await persistence.saveWorkflowState(makeState({ taskId: 'inst-done', status: 'completed' }))

    await expect(remote.abortInstance('inst-done')).rejects.toMatchObject({ code: 'INVALID_OPERATION' })
  })

  it('getInstanceState throws NODE_NOT_FOUND for a nonexistent instance', async () => {
    const { remote } = await harness()

    expect(catchCode(() => remote.getInstanceState('inst-nonexistent'))).toBe('NODE_NOT_FOUND')
  })

  it('getArtifacts throws NODE_NOT_FOUND for a nonexistent instance', async () => {
    const { remote } = await harness()

    expect(catchCode(() => remote.getArtifacts('inst-nonexistent'))).toBe('NODE_NOT_FOUND')
  })

  it('abortInstance throws NODE_NOT_FOUND for a nonexistent instance', async () => {
    const { remote } = await harness()

    expect(await catchCodeAsync(() => remote.abortInstance('inst-nonexistent'))).toBe('NODE_NOT_FOUND')
  })
})

describe('SandoreRemote lifecycle RPCs', () => {
  it('replyQuestion forwards instanceId/requestId/answers to the engine', async () => {
    const { remote, engine } = await harness()
    const answers: AskUserQuestionAnswer = { answers: [{ id: 'q1', selected: ['A'] }] }

    await remote.replyQuestion({ instanceId: 'inst-1', requestId: 'req-1', answers })

    expect(engine.replyQuestion).toHaveBeenCalledWith('inst-1', 'req-1', answers)
  })

  it('replyPermission forwards instanceId/requestId/reply to the engine', async () => {
    const { remote, engine } = await harness()

    await remote.replyPermission({ instanceId: 'inst-1', requestId: 'req-1', reply: 'always' })

    expect(engine.replyPermission).toHaveBeenCalledWith('inst-1', 'req-1', 'always')
  })

  it('rejects an invalid reply enum value (zod)', async () => {
    const { remote } = await harness()

    await expect(
      remote.replyPermission({ instanceId: 'inst-1', requestId: 'req-1', reply: 'bad' as 'once' }),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('pauseStep forwards instanceId/stepId to the engine', async () => {
    const { remote, engine } = await harness()

    await remote.pauseStep({ instanceId: 'inst-1', stepId: 'step-1' })

    expect(engine.pauseStep).toHaveBeenCalledWith('inst-1', 'step-1')
  })

  it('resumeStep forwards instanceId/stepId/resumePrompt to the engine', async () => {
    const { remote, engine } = await harness()

    await remote.resumeStep({ instanceId: 'inst-1', stepId: 'step-1', resumePrompt: 'continue please' })

    expect(engine.resumeStep).toHaveBeenCalledWith('inst-1', 'step-1', 'continue please')
  })

  it('resumeStep forwards without resumePrompt when absent', async () => {
    const { remote, engine } = await harness()

    await remote.resumeStep({ instanceId: 'inst-1', stepId: 'step-1' })

    expect(engine.resumeStep).toHaveBeenCalledWith('inst-1', 'step-1', undefined)
  })

  it('pauseAll forwards instanceId to engine.pauseAllSteps', async () => {
    const { remote, engine } = await harness()

    await remote.pauseAll({ instanceId: 'inst-1' })

    expect(engine.pauseAllSteps).toHaveBeenCalledWith('inst-1')
  })

  it('resumeAll forwards instanceId/resumePrompt to engine.resumeAllSteps', async () => {
    const { remote, engine } = await harness()

    await remote.resumeAll({ instanceId: 'inst-1', resumePrompt: 'go' })

    expect(engine.resumeAllSteps).toHaveBeenCalledWith('inst-1', 'go')
  })

  it('retryStep forwards instanceId/stepId/mode/message to the engine', async () => {
    const { remote, engine } = await harness()

    await remote.retryStep({ instanceId: 'inst-1', stepId: 'step-1', mode: 'revert', message: 'retry now' })

    expect(engine.retryStep).toHaveBeenCalledWith('inst-1', 'step-1', 'revert', 'retry now')
  })

  it('rejects an invalid retry mode enum value (zod)', async () => {
    const { remote } = await harness()

    await expect(
      remote.retryStep({ instanceId: 'inst-1', stepId: 'step-1', mode: 'bad' as 'fork', message: 'x' }),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('passes through SandoreError from the engine without swallowing it', async () => {
    const { remote, engine } = await harness()
    engine.pauseStep.mockRejectedValueOnce(new SandoreError('step busy', 'INVALID_OPERATION'))

    await expect(remote.pauseStep({ instanceId: 'inst-1', stepId: 'step-1' })).rejects.toMatchObject({
      code: 'INVALID_OPERATION',
    })
  })
})

describe('SandoreRemote artifacts and llm forwarding', () => {
  it('returns artifact entries and filters by stageId', async () => {
    const { remote, persistence } = await harness()
    const now = new Date().toISOString()
    await persistence.saveWorkflowState(makeState({
      taskId: 'inst-art',
      status: 'completed',
      currentStageId: 'stg-2',
      executedSteps: [
        {
          type: 'default',
          id: 'step-shell',
          stepId: 'step-shell',
          stageId: 'stg-1',
          name: 'lint',
          status: 'completed',
          visitCount: 1,
        },
        {
          type: 'default',
          id: 'step-prompt',
          stepId: 'step-prompt',
          stageId: 'stg-2',
          name: 'summarize',
          status: 'completed',
          visitCount: 1,
        },
      ],
      stageContracts: {
        'stg-1': {
          stageId: 'stg-1',
          stageName: '分析',
          status: 'completed',
          artifacts: [{ stepId: 'step-shell', outputToId: 'opt-1', files: ['/abs/report.txt'] }],
          passThroughVars: {},
          contractArtifacts: {},
          completedAt: now,
        },
        'stg-2': {
          stageId: 'stg-2',
          stageName: '推理',
          status: 'completed',
          artifacts: [{ stepId: 'step-prompt', outputToId: 'opt-2', files: [], returnPrompt: 'The summary.' }],
          passThroughVars: {},
          contractArtifacts: {},
          completedAt: now,
        },
      },
    }))

    const artifacts = remote.getArtifacts('inst-art')
    expect(artifacts).toHaveLength(2)
    expect(artifacts).toContainEqual({
      stepId: 'step-shell',
      stageId: 'stg-1',
      outputToId: 'opt-1',
      files: ['/abs/report.txt'],
    })
    expect(artifacts).toContainEqual({
      stepId: 'step-prompt',
      stageId: 'stg-2',
      outputToId: 'opt-2',
      files: [],
      returnPrompt: 'The summary.',
    })

    expect(remote.getArtifacts('inst-art', 'stg-1')).toHaveLength(1)
  })

  it('forwards listProviders and listModels', async () => {
    const { remote } = await harness()

    expect(remote.listProviders()).toEqual([{ id: 'provider-a', name: 'Provider A' }])
    await expect(remote.listModels('provider-a')).resolves.toEqual([
      { provider: 'provider-a', id: 'model-a', name: 'Model A' },
    ])
  })

  it('keeps ping returning pong/service/time', async () => {
    const { remote } = await harness()

    const pong = remote.ping()
    expect(pong.pong).toBe(true)
    expect(pong.service).toBe('sandore')
    expect(pong.time).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
