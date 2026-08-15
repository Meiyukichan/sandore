/**
 * sandore Host RPC（Typert 协议）。
 *
 * `super(ctx, 'sandore')` 定 wire namespace，`@Remote('name')` 定 method，
 * 构成端点 `sandore.<method>`。定义/Job CRUD 读写在 `ctx.sandorePersistence`
 * 的三表上，实例生命周期（start/abort）转发 `ctx.sandoreEngine`，
 * Provider/Model 转发 `ctx.llm`。RPC 层只做 zod 参数校验 + 转发/存储，
 * 无引擎业务逻辑。
 * @module @deepseek-ai/dsh-sandore-workflow/src/remote
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'

import { SandoreError } from './errors.ts'
import type { DagRun, DagStartRequest } from './types.ts'
import { parseWorkflowYaml } from './yaml-parser.ts'
import type { JobRecord, WorkflowDefinitionRecord, WorkflowTaskState } from './schema.ts'

// ── wire 类型 ────────────────────────────────────────────────────────────────

/** `definitions` 表条目：记录键（workflowId）与 value 的合并。 */
export interface WorkflowDefinitionEntry extends WorkflowDefinitionRecord {
  id: string
}

/** `jobs` 表条目：记录键（jobId）与 value 的合并。 */
export interface JobEntry extends JobRecord {
  id: string
}

/** 实例清单摘要（从 `state` 表派生）。 */
export interface InstanceSummary {
  instanceId: string
  jobId: string
  workflowId: string
  status: WorkflowTaskState['status']
  createdAt: string
  updatedAt: string
}

/** 实例产物条目（从 `stageContracts` 的产物契约扁平化）。 */
export interface ArtifactEntry {
  stepId: string
  stageId: string
  outputToId?: string
  files: string[]
  returnPrompt?: string
}

// ── 入参 zod schema ──────────────────────────────────────────────────────────

/** `createDefinition` 入参：仅承载 YAML 文本。 */
const CreateDefinitionInputSchema = z.object({
  yaml: z.string(),
})

/** `updateDefinition` 入参：可更新的元数据字段。 */
const UpdateDefinitionInputSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
})

/** `createJob` 入参。 */
const CreateJobInputSchema = z.object({
  name: z.string(),
  workflowId: z.string(),
  cwd: z.string().optional(),
})

/** `updateJob` 入参。 */
const UpdateJobInputSchema = z.object({
  name: z.string().optional(),
  cwd: z.string().optional(),
})

/** `startInstance` 入参。 */
const StartInstanceInputSchema = z.object({
  jobId: z.string(),
  originalInput: z.string(),
  cwd: z.string().optional(),
})

export type CreateDefinitionInput = z.infer<typeof CreateDefinitionInputSchema>
export type UpdateDefinitionInput = z.infer<typeof UpdateDefinitionInputSchema>
export type CreateJobInput = z.infer<typeof CreateJobInputSchema>
export type UpdateJobInput = z.infer<typeof UpdateJobInputSchema>
export type StartInstanceInput = z.infer<typeof StartInstanceInputSchema>

// ── ping ─────────────────────────────────────────────────────────────────────

/** `sandore.ping` 的桩返回数据（非真实引擎状态）。 */
export interface PingResponse {
  /** 恒为 true，表示往返成功。 */
  pong: boolean
  /** 服务命名空间标识。 */
  service: string
  /** Host 侧生成的时间戳（ISO 8601 字符串）。 */
  time: string
}

/** 实例的终态集合：`abortInstance` 对终态实例拒绝操作。 */
const TERMINAL_STATUSES: ReadonlySet<WorkflowTaskState['status']> = new Set(['completed', 'failed', 'aborted'])

/**
 * sandore 的 Host RPC 服务。
 *
 * 定义/Job/实例 CRUD + 产物查询 + Provider/Model 转发；`ping` 保留。
 */
export class SandoreRemote extends TypertRemoteService {
  static inject = ['sandorePersistence', 'sandoreEngine', 'llm']

  constructor(ctx: Context) {
    super(ctx, 'sandore')
  }

  /** 健康检查往返，验证 Host/Client RPC 链路。 */
  @Remote('ping')
  ping(): PingResponse {
    return { pong: true, service: 'sandore', time: new Date().toISOString() }
  }

  // ── 定义 CRUD ────────────────────────────────────────────────────────────

  /** 列出全部工作流定义（含 `id` 键）。 */
  @Remote('listDefinitions')
  listDefinitions(): WorkflowDefinitionEntry[] {
    const entries: WorkflowDefinitionEntry[] = []
    for (const [id, record] of this.ctx.sandorePersistence.definitions.entries()) {
      entries.push({ id, ...record })
    }
    return entries
  }

  /**
   * 创建定义：解析+验证 YAML → 生成 `wfl-{uuid}` → 存 yaml 原文与元数据。
   * 非法 YAML 抛 `SandoreError`，`definitions` 表不新增记录。
   */
  @Remote('createDefinition')
  async createDefinition(input: CreateDefinitionInput): Promise<WorkflowDefinitionEntry> {
    const parsed = CreateDefinitionInputSchema.parse(input)
    const definition = parseWorkflowYaml(parsed.yaml)
    const id = `wfl-${globalThis.crypto.randomUUID()}`
    const now = new Date().toISOString()
    const record: WorkflowDefinitionRecord = {
      yaml: parsed.yaml,
      name: definition.name,
      version: definition.version,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      createdAt: now,
      updatedAt: now,
    }
    await this.ctx.sandorePersistence.definitions.put(id, record)
    return { id, ...record }
  }

  /** 更新定义元数据（name/version/description），保留 yaml 文本。 */
  @Remote('updateDefinition')
  async updateDefinition(id: string, input: UpdateDefinitionInput): Promise<WorkflowDefinitionEntry> {
    const parsed = UpdateDefinitionInputSchema.parse(input)
    const existing = this.requireDefinition(id)
    const now = new Date().toISOString()
    const description = parsed.description ?? existing.description
    const next: WorkflowDefinitionRecord = {
      yaml: existing.yaml,
      name: parsed.name ?? existing.name,
      version: parsed.version ?? existing.version,
      ...(description === undefined ? {} : { description }),
      createdAt: existing.createdAt,
      updatedAt: now,
    }
    await this.ctx.sandorePersistence.definitions.put(id, next)
    return { id, ...next }
  }

  /** 删除定义（不级联删除实例）；重复删除幂等（返回 false）。 */
  @Remote('deleteDefinition')
  async deleteDefinition(id: string): Promise<boolean> {
    return await this.ctx.sandorePersistence.definitions.delete(id)
  }

  /** 读取定义的原始 YAML 文本。 */
  @Remote('getYaml')
  getYaml(id: string): string {
    return this.requireDefinition(id).yaml
  }

  /** 重新验证后覆盖定义的 YAML 文本；非法 YAML 抛错且存储保持旧值。 */
  @Remote('updateYaml')
  async updateYaml(id: string, yaml: string): Promise<WorkflowDefinitionEntry> {
    parseWorkflowYaml(yaml)
    const existing = this.requireDefinition(id)
    const now = new Date().toISOString()
    const next: WorkflowDefinitionRecord = {
      yaml,
      name: existing.name,
      version: existing.version,
      ...(existing.description === undefined ? {} : { description: existing.description }),
      createdAt: existing.createdAt,
      updatedAt: now,
    }
    await this.ctx.sandorePersistence.definitions.put(id, next)
    return { id, ...next }
  }

  // ── Job CRUD ─────────────────────────────────────────────────────────────

  /** 列出 Job，可选按 workflowId 过滤。 */
  @Remote('listJobs')
  listJobs(workflowId?: string): JobEntry[] {
    const entries: JobEntry[] = []
    for (const [id, record] of this.ctx.sandorePersistence.jobs.entries()) {
      if (workflowId !== undefined && record.workflowId !== workflowId) continue
      entries.push({ id, ...record })
    }
    return entries
  }

  /** 创建 Job：校验 workflowId 存在（否则抛 `INVALID_OPERATION`），自动生成 jobId。 */
  @Remote('createJob')
  async createJob(input: CreateJobInput): Promise<JobEntry> {
    const parsed = CreateJobInputSchema.parse(input)
    if (this.ctx.sandorePersistence.definitions.get(parsed.workflowId) === undefined) {
      throw new SandoreError(`workflow '${parsed.workflowId}' does not exist`, 'INVALID_OPERATION')
    }
    const id = `job-${globalThis.crypto.randomUUID()}`
    const now = new Date().toISOString()
    const record: JobRecord = {
      name: parsed.name,
      workflowId: parsed.workflowId,
      ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
      createdAt: now,
      updatedAt: now,
    }
    await this.ctx.sandorePersistence.jobs.put(id, record)
    return { id, ...record }
  }

  /** 按 id 读取单个 Job。 */
  @Remote('getJob')
  getJob(id: string): JobEntry {
    return this.requireJob(id)
  }

  /** 更新 Job 元数据（name/cwd），保留 workflowId。 */
  @Remote('updateJob')
  async updateJob(id: string, input: UpdateJobInput): Promise<JobEntry> {
    const parsed = UpdateJobInputSchema.parse(input)
    const existing = this.requireJob(id)
    const now = new Date().toISOString()
    const cwd = parsed.cwd ?? existing.cwd
    const next: JobRecord = {
      name: parsed.name ?? existing.name,
      workflowId: existing.workflowId,
      ...(cwd === undefined ? {} : { cwd }),
      createdAt: existing.createdAt,
      updatedAt: now,
    }
    await this.ctx.sandorePersistence.jobs.put(id, next)
    return { id, ...next }
  }

  /** 删除 Job（不级联删除实例）；重复删除幂等（返回 false）。 */
  @Remote('deleteJob')
  async deleteJob(id: string): Promise<boolean> {
    return await this.ctx.sandorePersistence.jobs.delete(id)
  }

  // ── 实例生命周期 ─────────────────────────────────────────────────────────

  /** 列出实例摘要（从 `state` 表派生），可选按 jobId 过滤。 */
  @Remote('listInstances')
  listInstances(jobId?: string): InstanceSummary[] {
    const summaries: InstanceSummary[] = []
    for (const [instanceId, state] of this.ctx.sandorePersistence.state.entries()) {
      if (jobId !== undefined && state.jobId !== jobId) continue
      summaries.push({
        instanceId,
        jobId: state.jobId,
        workflowId: state.workflowId,
        status: state.status,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      })
    }
    return summaries
  }

  /** 启动实例：解析 Job 的 workflowId 后转发 `ctx.sandoreEngine.startInstance`。 */
  @Remote('startInstance')
  startInstance(input: StartInstanceInput): DagRun {
    const parsed = StartInstanceInputSchema.parse(input)
    const job = this.requireJob(parsed.jobId)
    const request: DagStartRequest = {
      workflowId: job.workflowId,
      jobId: parsed.jobId,
      originalInput: parsed.originalInput,
      ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
    }
    return this.ctx.sandoreEngine.startInstance(request)
  }

  /** 删除实例快照（`state` 表删除）；重复删除幂等。 */
  @Remote('deleteInstance')
  async deleteInstance(instanceId: string): Promise<boolean> {
    return await this.ctx.sandorePersistence.state.delete(instanceId)
  }

  /** 读取实例的完整状态快照；不存在抛 `NODE_NOT_FOUND`。 */
  @Remote('getInstanceState')
  getInstanceState(instanceId: string): WorkflowTaskState {
    return this.requireInstanceState(instanceId)
  }

  /** 中止运行中实例（转发引擎）；终态实例抛 `INVALID_OPERATION`。 */
  @Remote('abortInstance')
  async abortInstance(instanceId: string): Promise<void> {
    const state = this.requireInstanceState(instanceId)
    if (TERMINAL_STATUSES.has(state.status)) {
      throw new SandoreError(`instance '${instanceId}' is already in terminal state '${state.status}'`, 'INVALID_OPERATION')
    }
    await this.ctx.sandoreEngine.abortInstance(instanceId)
  }

  // ── 产物 / Provider 转发 ─────────────────────────────────────────────────

  /**
   * 查询实例产物：从 `stageContracts` 的产物契约扁平化条目，可选按 stageId 过滤。
   */
  @Remote('getArtifacts')
  getArtifacts(instanceId: string, stageId?: string): ArtifactEntry[] {
    const state = this.requireInstanceState(instanceId)
    const entries: ArtifactEntry[] = []
    for (const [contractStageId, contract] of Object.entries(state.stageContracts)) {
      if (stageId !== undefined && contractStageId !== stageId) continue
      for (const artifact of contract.artifacts) {
        entries.push({
          stepId: artifact.stepId,
          stageId: contractStageId,
          outputToId: artifact.outputToId,
          files: [...artifact.files],
          ...(artifact.returnPrompt === undefined ? {} : { returnPrompt: artifact.returnPrompt }),
        })
      }
    }
    return entries
  }

  /** 列出 LLM Provider（透传 `ctx.llm.listProviders()`）。 */
  @Remote('listProviders')
  listProviders(): LlmProviderInfo[] {
    return this.ctx.llm.listProviders()
  }

  /** 列出某 Provider 的模型（透传 `ctx.llm.listModels()`）。 */
  @Remote('listModels')
  async listModels(provider: string): Promise<LlmModelInfo[]> {
    return await this.ctx.llm.listModels(provider)
  }

  // ── 私有守卫 ─────────────────────────────────────────────────────────────

  private requireDefinition(id: string): WorkflowDefinitionEntry {
    const record = this.ctx.sandorePersistence.definitions.get(id)
    if (record === undefined) {
      throw new SandoreError(`definition '${id}' not found`, 'NODE_NOT_FOUND')
    }
    return { id, ...record }
  }

  private requireJob(id: string): JobEntry {
    const record = this.ctx.sandorePersistence.jobs.get(id)
    if (record === undefined) {
      throw new SandoreError(`job '${id}' not found`, 'NODE_NOT_FOUND')
    }
    return { id, ...record }
  }

  private requireInstanceState(instanceId: string): WorkflowTaskState {
    const state = this.ctx.sandorePersistence.state.get(instanceId)
    if (state === undefined) {
      throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND')
    }
    return state
  }
}

export default SandoreRemote
