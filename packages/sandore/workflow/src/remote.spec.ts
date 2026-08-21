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
import type { WorkflowDefinitionRecord, WorkflowTaskState } from './schema.ts'
import type { AskUserQuestionAnswer, DagRun, DagStartRequest, RevertBoundaryOption } from './types.ts'
import type { ImportDefinitionInput, RecoverOrphanedInstancesResult, StartInstanceInput } from './wire.ts'
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

/** mock 引擎的生命周期方法桩（`vi.fn` 记录调用，便于断言转调链路）。 */
interface MockLifecycleEngine {
  replyQuestion: ReturnType<typeof vi.fn>
  rejectQuestion: ReturnType<typeof vi.fn>
  replyPermission: ReturnType<typeof vi.fn>
  pauseStep: ReturnType<typeof vi.fn>
  resumeStep: ReturnType<typeof vi.fn>
  pauseAllSteps: ReturnType<typeof vi.fn>
  resumeAllSteps: ReturnType<typeof vi.fn>
  retryStep: ReturnType<typeof vi.fn>
  listRevertBoundaries: ReturnType<typeof vi.fn>
  sendStepMessage: ReturnType<typeof vi.fn>
  setPermissionMode: ReturnType<typeof vi.fn>
  recoverInstance: ReturnType<typeof vi.fn>
  recoverOrphanedInstances: ReturnType<typeof vi.fn>
}

/** 组装测试 harness：注入内存 storageDomain、mock llm 与 mock 引擎。 */
async function harness(): Promise<{
  ctx: Context
  persistence: SandorePersistence
  remote: SandoreRemote
  /** stub 引擎收到的全部 startInstance 请求（透传断言）。 */
  startRequests: DagStartRequest[]
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

  const startRequests: DagStartRequest[] = []
  const startInstance = (request: DagStartRequest): DagRun => {
    startRequests.push(request)
    const instanceId = `inst-${globalThis.crypto.randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const state: WorkflowTaskState = {
      taskId: instanceId,
      workflowId: request.workflowId,
      // cwd 必填（wire schema 已校验），mock 原样透传。
      cwd: request.cwd,
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
    rejectQuestion: vi.fn(async (_instanceId: string, _requestId: string) => {}),
    replyPermission: vi.fn(async (_instanceId: string, _requestId: string, _reply: 'once' | 'always' | 'reject') => {}),
    pauseStep: vi.fn(async (_instanceId: string, _stepId: string) => {}),
    resumeStep: vi.fn(async (_instanceId: string, _stepId: string, _resumePrompt?: string) => {}),
    pauseAllSteps: vi.fn(async (_instanceId: string) => {}),
    resumeAllSteps: vi.fn(async (_instanceId: string, _resumePrompt?: string) => {}),
    retryStep: vi.fn(async (_instanceId: string, _stepId: string, _mode: 'continue' | 'revert' | 'fork', _message: string, _revertBoundary?: number) => {}),
    listRevertBoundaries: vi.fn((_instanceId: string, _stepId: string): RevertBoundaryOption[] => []),
    sendStepMessage: vi.fn(async (_instanceId: string, _stepId: string, _message: string) => {}),
    setPermissionMode: vi.fn(async (_instanceId: string, _mode: 'read-only' | 'workspace-write' | 'danger-full-access') => {}),
    recoverInstance: vi.fn(async (instanceId: string): Promise<DagRun> => ({ instanceId, status: 'running' })),
    recoverOrphanedInstances: vi.fn(async (): Promise<RecoverOrphanedInstancesResult> => ({ recovered: [], errors: [] })),
  }
  ctx.provide('sandoreEngine', engine as unknown as SandoreEngine)

  const remote = new SandoreRemote(ctx)
  return { ctx, persistence, remote, startRequests, engine }
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

describe('SandoreRemote importDefinitionFromYaml RPC (缺陷 30)', () => {
  // V1 三级 YAML（stages[].scenarios[].tasks[]）——parseWorkflowYaml 内建 convertLegacyToV2。
  const v1Yaml = `id: code-review-workflow
name: 代码审查工作流
version: "1.0.0"
settings:
  defaultTimeout: 60
stages:
  - id: stg-analyze
    name: 代码分析
    scenarios:
      - id: sce-static-analysis
        name: 静态分析
        tasks:
          - id: tsk-lint
            name: 代码规范检查
            prompt:
              type: Bash
              value:
                command: "npm run lint 2>&1"
            outputTo:
              - id: opt-lint-report
                path: "reports/lint.txt"
`

  it('creates a new definition when no match exists (matchBy name default)', async () => {
    const { remote } = await harness()

    const result = await remote.importDefinitionFromYaml({ yaml: validV2Yaml })

    expect(result.status).toBe('created')
    expect(result.matchedCount).toBe(0)
    expect(result.id).toMatch(/^wfl-/)
    expect(result.name).toBe('demo')
    // 复用 createDefinition：存储的 YAML 顶层 id 与记录键一致（哨兵 id 被改写）。
    expect(parseWorkflowYaml(remote.getYaml(result.id)).id).toBe(result.id)
  })

  it('skips when an existing name match has the same version', async () => {
    const { remote } = await harness()
    const created = await remote.createDefinition({ yaml: validV2Yaml })

    // 再次导入同一 YAML（同 name 同 version）→ skipped，不新增记录。
    const result = await remote.importDefinitionFromYaml({ yaml: validV2Yaml })

    expect(result.status).toBe('skipped')
    expect(result.matchedCount).toBe(1)
    expect(result.id).toBe(created.id)
    expect(remote.listDefinitions()).toHaveLength(1)
  })

  it('updates when an existing name match has a different version', async () => {
    const { remote } = await harness()
    const created = await remote.createDefinition({ yaml: validV2Yaml })
    const v2Yaml = validV2Yaml.replace('version: "1.0.0"', 'version: "2.0.0"')

    const result = await remote.importDefinitionFromYaml({ yaml: v2Yaml })

    expect(result.status).toBe('updated')
    expect(result.matchedCount).toBe(1)
    expect(result.id).toBe(created.id)
    // 复用 updateYaml：元数据从新 YAML 同步，YAML 文本为传入原文。
    const stored = remote.listDefinitions().find(entry => entry.id === created.id)
    expect(stored?.version).toBe('2.0.0')
    expect(stored?.name).toBe('demo')
    expect(remote.getYaml(created.id)).toBe(v2Yaml)
  })

  it('resolves name multi-match by latest updatedAt and reports matchedCount (SA8)', async () => {
    const { remote, persistence } = await harness()
    // 直接写入两条同名同版本记录，控制 updatedAt 以验证确定性策略（取最新）。
    const seed = (updatedAt: string): WorkflowDefinitionRecord => ({
      yaml: validV2Yaml,
      name: 'demo',
      version: '1.0.0',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt,
    })
    await persistence.definitions.put('wfl-older', seed('2024-01-01T00:00:00.000Z'))
    await persistence.definitions.put('wfl-newer', seed('2024-01-02T00:00:00.000Z'))

    const v2Yaml = validV2Yaml.replace('version: "1.0.0"', 'version: "2.0.0"')
    const result = await remote.importDefinitionFromYaml({ yaml: v2Yaml })

    // 多匹配：取最新 updatedAt（wfl-newer）更新，matchedCount 注明歧义命中数。
    expect(result.status).toBe('updated')
    expect(result.matchedCount).toBe(2)
    expect(result.id).toBe('wfl-newer')
    expect(remote.getYaml('wfl-newer')).toBe(v2Yaml)
    // 未命中的旧记录保持不变。
    expect(parseWorkflowYaml(remote.getYaml('wfl-older')).version).toBe('1.0.0')
  })

  it('imports V1 YAML via built-in conversion and reports created with converted name/version', async () => {
    const { remote } = await harness()

    const result = await remote.importDefinitionFromYaml({ yaml: v1Yaml })

    expect(result.status).toBe('created')
    expect(result.matchedCount).toBe(0)
    expect(result.name).toBe('代码审查工作流')
    // V1 已自动转换为 V2：存储的 YAML 无 scenarios，name/version 与转换后一致。
    const stored = remote.listDefinitions().find(entry => entry.id === result.id)
    expect(stored?.version).toBe('1.0.0')
    expect(stored?.name).toBe('代码审查工作流')
    const reparsed = parseWorkflowYaml(remote.getYaml(result.id))
    expect(reparsed.stages[0]).not.toHaveProperty('scenarios')
    expect(reparsed.name).toBe('代码审查工作流')
  })

  it('skips a V1 re-import after conversion when name/version already match', async () => {
    const { remote } = await harness()
    const created = await remote.importDefinitionFromYaml({ yaml: v1Yaml })

    // 同一 V1 文件重放：转换后 name/version 与已存记录相同 → skipped（幂等）。
    const result = await remote.importDefinitionFromYaml({ yaml: v1Yaml })

    expect(result.status).toBe('skipped')
    expect(result.matchedCount).toBe(1)
    expect(result.id).toBe(created.id)
    expect(remote.listDefinitions()).toHaveLength(1)
  })

  it('matches by YAML top-level id when matchBy id is requested', async () => {
    const { remote, persistence } = await harness()
    // 以 YAML 顶层 id 为键直接写入一条记录（绕过 createDefinition 的 uuid 改写），
    // 验证 matchBy:'id' 按 definitions.get(yamlId) 命中并做版本比对。
    const seeded: WorkflowDefinitionRecord = {
      yaml: validV2Yaml,
      name: 'demo',
      version: '1.0.0',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    }
    await persistence.definitions.put('wfl-source', seeded)

    const sameVersion = await remote.importDefinitionFromYaml({ yaml: validV2Yaml, matchBy: 'id' })
    expect(sameVersion.status).toBe('skipped')
    expect(sameVersion.id).toBe('wfl-source')
    expect(sameVersion.matchedCount).toBe(1)

    const v2Yaml = validV2Yaml.replace('version: "1.0.0"', 'version: "2.0.0"')
    const diffVersion = await remote.importDefinitionFromYaml({ yaml: v2Yaml, matchBy: 'id' })
    expect(diffVersion.status).toBe('updated')
    expect(diffVersion.id).toBe('wfl-source')
    expect(diffVersion.matchedCount).toBe(1)
    expect(remote.getYaml('wfl-source')).toBe(v2Yaml)
  })

  it('rejects a missing yaml field (zod, 缺陷 30)', async () => {
    const { remote } = await harness()

    await expect(
      remote.importDefinitionFromYaml({} as ImportDefinitionInput),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects an invalid matchBy enum value (zod, 缺陷 30)', async () => {
    const { remote } = await harness()

    await expect(
      remote.importDefinitionFromYaml({ yaml: validV2Yaml, matchBy: 'bad' as 'id' }),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects invalid YAML and leaves the definitions table empty (缺陷 30)', async () => {
    const { remote } = await harness()

    await expect(
      remote.importDefinitionFromYaml({ yaml: 'stages: [ broken' }),
    ).rejects.toMatchObject({ code: 'YAML_PARSE' })
    expect(remote.listDefinitions()).toHaveLength(0)
  })
})

describe('SandoreRemote instance lifecycle', () => {
  it('startInstance returns a run and writes a readable state snapshot', async () => {
    const { remote, persistence } = await harness()
    const definition = await remote.createDefinition({ yaml: validV2Yaml })

    const run = await remote.startInstance({ workflowId: definition.id, originalInput: '测试需求', cwd: '/tmp' })
    expect(run.instanceId).toBeTruthy()
    expect(run.status).toBe('running')

    const state = remote.getInstanceState(run.instanceId)
    expect(state.originalInput).toBe('测试需求')
    expect(state.workflowId).toBe(definition.id)
    expect(persistence.state.get(run.instanceId)?.originalInput).toBe('测试需求')
  })

  it('rejects startInstance for a nonexistent workflowId', async () => {
    const { remote } = await harness()

    await expect(remote.startInstance({ workflowId: 'wfl-nonexistent', originalInput: 'x', cwd: '/tmp' })).rejects.toMatchObject({
      code: 'INVALID_OPERATION',
    })
  })

  it('rejects a missing cwd on startInstance (wire schema, cwd required)', async () => {
    const { remote } = await harness()
    const definition = await remote.createDefinition({ yaml: validV2Yaml })

    // cwd 已改为必填：缺 cwd 的请求在 wire schema 层被拒（ZodError），不会到达引擎。
    await expect(
      remote.startInstance({ workflowId: definition.id, originalInput: 'x' } as StartInstanceInput),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('forwards the optional hostSessionId to the engine startInstance', async () => {
    const { remote, startRequests } = await harness()
    const definition = await remote.createDefinition({ yaml: validV2Yaml })

    // 未传 hostSessionId：引擎请求不含该字段。
    await remote.startInstance({ workflowId: definition.id, originalInput: 'a', cwd: '/tmp' })
    expect(startRequests[0]).not.toHaveProperty('hostSessionId')

    // 传入 hostSessionId：原样透传（复用宿主主代理会话，不新建）。
    await remote.startInstance({ workflowId: definition.id, originalInput: 'b', cwd: '/tmp', hostSessionId: 'host-1' })
    expect(startRequests[1]?.hostSessionId).toBe('host-1')
  })

  it('derives instance summaries for every state row (no job filter)', async () => {
    const { remote } = await harness()
    const definition = await remote.createDefinition({ yaml: validV2Yaml })
    await remote.startInstance({ workflowId: definition.id, originalInput: 'a', cwd: '/tmp' })
    await remote.startInstance({ workflowId: definition.id, originalInput: 'b', cwd: '/tmp' })

    const instances = remote.listInstances()
    expect(instances).toHaveLength(2)
    expect(instances.map(instance => instance.workflowId)).toEqual([definition.id, definition.id])
    expect(instances.map(instance => instance.originalInput).sort()).toEqual(['a', 'b'])
  })

  it('removes the snapshot on deleteInstance', async () => {
    const { remote } = await harness()
    const definition = await remote.createDefinition({ yaml: validV2Yaml })
    const run = await remote.startInstance({ workflowId: definition.id, originalInput: 'x', cwd: '/tmp' })

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

  it('rejectQuestion forwards instanceId/requestId to the engine (缺陷 26)', async () => {
    const { remote, engine } = await harness()

    await remote.rejectQuestion({ instanceId: 'inst-1', requestId: 'req-1' })

    expect(engine.rejectQuestion).toHaveBeenCalledWith('inst-1', 'req-1')
  })

  it('rejects a missing requestId on rejectQuestion (zod, 缺陷 26)', async () => {
    const { remote } = await harness()

    await expect(
      remote.rejectQuestion({ instanceId: 'inst-1' } as { instanceId: string; requestId: string }),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects a missing instanceId on rejectQuestion (zod, 缺陷 26)', async () => {
    const { remote } = await harness()

    await expect(
      remote.rejectQuestion({ requestId: 'req-1' } as { instanceId: string; requestId: string }),
    ).rejects.toBeInstanceOf(ZodError)
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

  it('retryStep forwards instanceId/stepId/mode/message/revertBoundary to the engine', async () => {
    const { remote, engine } = await harness()

    await remote.retryStep({ instanceId: 'inst-1', stepId: 'step-1', mode: 'revert', message: 'retry now', revertBoundary: 5 })

    expect(engine.retryStep).toHaveBeenCalledWith('inst-1', 'step-1', 'revert', 'retry now', 5)
  })

  it('retryStep forwards revertBoundary as undefined when omitted', async () => {
    const { remote, engine } = await harness()

    await remote.retryStep({ instanceId: 'inst-1', stepId: 'step-1', mode: 'continue', message: 'go' })

    expect(engine.retryStep).toHaveBeenCalledWith('inst-1', 'step-1', 'continue', 'go', undefined)
  })

  it('rejects a non-numeric revertBoundary (zod)', async () => {
    const { remote } = await harness()

    await expect(
      remote.retryStep({ instanceId: 'inst-1', stepId: 'step-1', mode: 'revert', message: 'x', revertBoundary: 'not-a-number' as unknown as number }),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects an invalid retry mode enum value (zod)', async () => {
    const { remote } = await harness()

    await expect(
      remote.retryStep({ instanceId: 'inst-1', stepId: 'step-1', mode: 'bad' as 'fork', message: 'x' }),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('listRevertBoundaries forwards instanceId/stepId to the engine and returns the boundary list', async () => {
    const { remote, engine } = await harness()
    const options: RevertBoundaryOption[] = [
      { seq: 2, turn: 0, preview: 'first answer' },
      { seq: 5, turn: 1, preview: 'second answer' },
    ]
    engine.listRevertBoundaries.mockReturnValueOnce(options)

    const result = remote.listRevertBoundaries({ instanceId: 'inst-1', stepId: 'step-agent' })

    expect(engine.listRevertBoundaries).toHaveBeenCalledWith('inst-1', 'step-agent')
    expect(result).toEqual(options)
  })

  it('passes through SandoreError from the engine without swallowing it', async () => {
    const { remote, engine } = await harness()
    engine.pauseStep.mockRejectedValueOnce(new SandoreError('step busy', 'INVALID_OPERATION'))

    await expect(remote.pauseStep({ instanceId: 'inst-1', stepId: 'step-1' })).rejects.toMatchObject({
      code: 'INVALID_OPERATION',
    })
  })
})

describe('SandoreRemote updateInstancePermissionMode RPC', () => {
  it('forwards instanceId/mode to the engine after passing the terminal guard (缺陷 29)', async () => {
    const { remote, persistence, engine } = await harness()
    await persistence.saveWorkflowState(makeState({ taskId: 'inst-1', status: 'running' }))

    await remote.updateInstancePermissionMode({ instanceId: 'inst-1', mode: 'workspace-write' })

    expect(engine.setPermissionMode).toHaveBeenCalledWith('inst-1', 'workspace-write')
  })

  it('rejects an invalid mode enum value (zod, 缺陷 29)', async () => {
    const { remote } = await harness()

    await expect(
      remote.updateInstancePermissionMode({ instanceId: 'inst-1', mode: 'bad' as 'read-only' }),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects a missing instanceId (zod, 缺陷 29)', async () => {
    const { remote } = await harness()

    await expect(
      remote.updateInstancePermissionMode({ mode: 'read-only' } as { instanceId: string; mode: 'read-only' }),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects a terminal instance with INVALID_OPERATION (terminal guard, 缺陷 29)', async () => {
    const { remote, persistence } = await harness()
    await persistence.saveWorkflowState(makeState({ taskId: 'inst-done', status: 'completed' }))

    await expect(remote.updateInstancePermissionMode({ instanceId: 'inst-done', mode: 'read-only' })).rejects.toMatchObject({
      code: 'INVALID_OPERATION',
    })
  })

  it('throws NODE_NOT_FOUND when the instance snapshot is missing (缺陷 29)', async () => {
    const { remote } = await harness()

    expect(
      await catchCodeAsync(() => remote.updateInstancePermissionMode({ instanceId: 'inst-nonexistent', mode: 'read-only' })),
    ).toBe('NODE_NOT_FOUND')
  })

  it('passes through SandoreError from the engine without swallowing it (缺陷 29)', async () => {
    const { remote, persistence, engine } = await harness()
    await persistence.saveWorkflowState(makeState({ taskId: 'inst-1', status: 'running' }))
    engine.setPermissionMode.mockRejectedValueOnce(new SandoreError('definition gone', 'NODE_NOT_FOUND'))

    await expect(remote.updateInstancePermissionMode({ instanceId: 'inst-1', mode: 'read-only' })).rejects.toMatchObject({
      code: 'NODE_NOT_FOUND',
    })
  })
})

describe('SandoreRemote sendStepMessage RPC', () => {
  it('forwards instanceId/stepId/message to the engine after passing the terminal guard (缺陷 31)', async () => {
    const { remote, persistence, engine } = await harness()
    await persistence.saveWorkflowState(makeState({ taskId: 'inst-1', status: 'running' }))

    await remote.sendStepMessage({ instanceId: 'inst-1', stepId: 'step-agent', message: '请确认参数' })

    expect(engine.sendStepMessage).toHaveBeenCalledWith('inst-1', 'step-agent', '请确认参数')
  })

  it('rejects an empty message (zod min(1), 缺陷 31)', async () => {
    const { remote } = await harness()

    await expect(
      remote.sendStepMessage({ instanceId: 'inst-1', stepId: 'step-agent', message: '' }),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects a missing stepId (zod, 缺陷 31)', async () => {
    const { remote } = await harness()

    await expect(
      remote.sendStepMessage({ instanceId: 'inst-1', message: 'hi' } as { instanceId: string; stepId: string; message: string }),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects a missing instanceId (zod, 缺陷 31)', async () => {
    const { remote } = await harness()

    await expect(
      remote.sendStepMessage({ stepId: 'step-agent', message: 'hi' } as { instanceId: string; stepId: string; message: string }),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects a terminal instance with INVALID_OPERATION (terminal guard, 缺陷 31)', async () => {
    const { remote, persistence } = await harness()
    await persistence.saveWorkflowState(makeState({ taskId: 'inst-done', status: 'completed' }))

    await expect(remote.sendStepMessage({ instanceId: 'inst-done', stepId: 'step-agent', message: 'hi' })).rejects.toMatchObject({
      code: 'INVALID_OPERATION',
    })
  })

  it('throws NODE_NOT_FOUND when the instance snapshot is missing (缺陷 31)', async () => {
    const { remote } = await harness()

    expect(
      await catchCodeAsync(() => remote.sendStepMessage({ instanceId: 'inst-nonexistent', stepId: 'step-agent', message: 'hi' })),
    ).toBe('NODE_NOT_FOUND')
  })

  it('passes through SandoreError from the engine without swallowing it (缺陷 31)', async () => {
    const { remote, persistence, engine } = await harness()
    await persistence.saveWorkflowState(makeState({ taskId: 'inst-1', status: 'running' }))
    engine.sendStepMessage.mockRejectedValueOnce(new SandoreError('step is synthetic', 'INVALID_OPERATION'))

    await expect(remote.sendStepMessage({ instanceId: 'inst-1', stepId: 'step-shell', message: 'hi' })).rejects.toMatchObject({
      code: 'INVALID_OPERATION',
    })
  })
})

describe('SandoreRemote recoverInstance RPC', () => {
  it('forwards instanceId to the engine and returns the recovered DagRun', async () => {
    const { remote, persistence, engine } = await harness()
    // 内存未命中但快照非终态：recoverInstance 应转发引擎并返回非终态 DagRun
    // （恢复后实例可被 pause/resume/retry/reply/abort 操作，UI 可用）。
    await persistence.saveWorkflowState(makeState({ taskId: 'inst-orphan', status: 'running' }))

    const run = await remote.recoverInstance({ instanceId: 'inst-orphan' })

    expect(engine.recoverInstance).toHaveBeenCalledWith('inst-orphan')
    expect(run).toEqual({ instanceId: 'inst-orphan', status: 'running' })
  })

  it('rejects a missing instanceId (zod validation)', async () => {
    const { remote } = await harness()

    await expect(
      remote.recoverInstance({ instanceId: 123 as unknown as string }),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects a terminal instance with INVALID_OPERATION (terminal guard)', async () => {
    const { remote, persistence } = await harness()
    await persistence.saveWorkflowState(makeState({ taskId: 'inst-done', status: 'completed' }))

    await expect(remote.recoverInstance({ instanceId: 'inst-done' })).rejects.toMatchObject({
      code: 'INVALID_OPERATION',
    })
  })

  it('throws NODE_NOT_FOUND when the instance snapshot is missing', async () => {
    const { remote } = await harness()

    expect(await catchCodeAsync(() => remote.recoverInstance({ instanceId: 'inst-nonexistent' }))).toBe('NODE_NOT_FOUND')
  })

  it('passes through SandoreError from the engine without swallowing it', async () => {
    const { remote, persistence, engine } = await harness()
    await persistence.saveWorkflowState(makeState({ taskId: 'inst-1', status: 'running' }))
    engine.recoverInstance.mockRejectedValueOnce(new SandoreError('definition gone', 'NODE_NOT_FOUND'))

    await expect(remote.recoverInstance({ instanceId: 'inst-1' })).rejects.toMatchObject({
      code: 'NODE_NOT_FOUND',
    })
  })
})

describe('SandoreRemote recoverOrphanedInstances RPC', () => {
  it('forwards to the engine with no input and returns the { recovered, errors } summary', async () => {
    const { remote, persistence, engine } = await harness()
    await persistence.saveWorkflowState(makeState({ taskId: 'inst-a', status: 'running' }))
    await persistence.saveWorkflowState(makeState({ taskId: 'inst-b', status: 'paused' }))
    engine.recoverOrphanedInstances.mockResolvedValueOnce({
      recovered: ['inst-a', 'inst-b'],
      errors: [],
    })

    const result = await remote.recoverOrphanedInstances()

    expect(engine.recoverOrphanedInstances).toHaveBeenCalledWith()
    expect(result).toEqual({ recovered: ['inst-a', 'inst-b'], errors: [] })
  })

  it('returns the errors array when some instances fail to recover (single-failure does not block)', async () => {
    const { remote, persistence, engine } = await harness()
    await persistence.saveWorkflowState(makeState({ taskId: 'inst-ok', status: 'running' }))
    await persistence.saveWorkflowState(makeState({ taskId: 'inst-bad', status: 'running' }))
    engine.recoverOrphanedInstances.mockResolvedValueOnce({
      recovered: ['inst-ok'],
      errors: [{ instanceId: 'inst-bad', error: 'definition gone' }],
    })

    const result = await remote.recoverOrphanedInstances()

    expect(result.recovered).toEqual(['inst-ok'])
    expect(result.errors).toEqual([{ instanceId: 'inst-bad', error: 'definition gone' }])
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
