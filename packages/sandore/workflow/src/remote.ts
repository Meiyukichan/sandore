/**
 * sandore Host RPC（Typert 协议）。
 *
 * `super(ctx, 'sandore')` 定 wire namespace，`@Remote('name')` 定 method，
 * 构成端点 `sandore.<method>`。定义/Job CRUD 读写在 `ctx.sandorePersistence`
 * 的三表上，实例生命周期（start/abort/reply/pause/resume/retry）转发
 * `ctx.sandoreEngine`，Provider/Model 转发 `ctx.llm`。RPC 层只做 zod 参数校验
 * + 转发/存储，无引擎业务逻辑。
 * @module @deepseek-ai/dsh-sandore-workflow/src/remote
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import { SandoreError } from './errors.ts'
import type { AskUserQuestionAnswer, DagRun, DagStartRequest } from './types.ts'
import { parseWorkflowYaml, serializeWorkflowYaml } from './yaml-parser.ts'
import type { JobRecord, WorkflowDefinitionRecord, WorkflowTaskState } from './schema.ts'
import {
  CreateDefinitionInputSchema,
  CreateJobInputSchema,
  PauseAllInputSchema,
  PauseStepInputSchema,
  ReplyPermissionInputSchema,
  ReplyQuestionInputSchema,
  ResumeAllInputSchema,
  ResumeStepInputSchema,
  RetryStepInputSchema,
  StartInstanceInputSchema,
  UpdateDefinitionInputSchema,
  UpdateJobInputSchema,
} from './wire.ts'
import type {
  ArtifactEntry,
  CreateDefinitionInput,
  CreateJobInput,
  InstanceSummary,
  JobEntry,
  PauseAllInput,
  PauseStepInput,
  PingResponse,
  ReplyPermissionInput,
  ReplyQuestionInput,
  ResumeAllInput,
  ResumeStepInput,
  RetryStepInput,
  StartInstanceInput,
  UpdateDefinitionInput,
  UpdateJobInput,
  WorkflowDefinitionEntry,
} from './wire.ts'

/** 实例的终态集合：`abortInstance` 对终态实例拒绝操作。 */
const TERMINAL_STATUSES: ReadonlySet<WorkflowTaskState['status']> = new Set(['completed', 'failed', 'aborted'])

/**
 * sandore 的 Host RPC 服务。
 *
 * 定义/Job/实例 CRUD + 7 个生命周期 RPC + 产物查询 + Provider/Model 转发；
 * `ping` 保留。
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
   * 创建定义：解析+验证 YAML → 生成 `wfl-{uuid}` → 以规范 id 重新序列化存储。
   * 非法 YAML 抛 `SandoreError`，`definitions` 表不新增记录。存储的 YAML 文本顶层
   * `id` 与记录键一致（客户端传入的哨兵 id 如 `wfl-new` 不回写进持久化文本）。
   */
  @Remote('createDefinition')
  async createDefinition(input: CreateDefinitionInput): Promise<WorkflowDefinitionEntry> {
    const parsed = CreateDefinitionInputSchema.parse(input)
    const definition = parseWorkflowYaml(parsed.yaml)
    const id = `wfl-${globalThis.crypto.randomUUID()}`
    const now = new Date().toISOString()
    const record: WorkflowDefinitionRecord = {
      yaml: serializeWorkflowYaml({ ...definition, id }),
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
  async startInstance(input: StartInstanceInput): Promise<DagRun> {
    const parsed = StartInstanceInputSchema.parse(input)
    const job = this.requireJob(parsed.jobId)
    const request: DagStartRequest = {
      workflowId: job.workflowId,
      jobId: parsed.jobId,
      originalInput: parsed.originalInput,
      ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
    }
    return await this.ctx.sandoreEngine.startInstance(request)
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

  // ── 生命周期 RPC ────────────────────────────────────────────────────────

  /** 回复待处理问答（转发 `ctx.sandoreEngine.replyQuestion`）。 */
  @Remote('replyQuestion')
  async replyQuestion(input: ReplyQuestionInput): Promise<void> {
    const parsed = ReplyQuestionInputSchema.parse(input)
    // zod 已对 answers 结构做显式运行时校验；此处桥接 `exactOptionalPropertyTypes`
    // 下 `custom?: string` 与 zod `.optional()` 推断 `string | undefined` 的类型差异。
    await this.ctx.sandoreEngine.replyQuestion(parsed.instanceId, parsed.requestId, parsed.answers as AskUserQuestionAnswer)
  }

  /** 回复待处理权限请求（转发 `ctx.sandoreEngine.replyPermission`）。 */
  @Remote('replyPermission')
  async replyPermission(input: ReplyPermissionInput): Promise<void> {
    const parsed = ReplyPermissionInputSchema.parse(input)
    await this.ctx.sandoreEngine.replyPermission(parsed.instanceId, parsed.requestId, parsed.reply)
  }

  /** 暂停单个 Step（转发 `ctx.sandoreEngine.pauseStep`）。 */
  @Remote('pauseStep')
  async pauseStep(input: PauseStepInput): Promise<void> {
    const parsed = PauseStepInputSchema.parse(input)
    await this.ctx.sandoreEngine.pauseStep(parsed.instanceId, parsed.stepId)
  }

  /** 恢复单个 Step（转发 `ctx.sandoreEngine.resumeStep`，可选恢复提示词）。 */
  @Remote('resumeStep')
  async resumeStep(input: ResumeStepInput): Promise<void> {
    const parsed = ResumeStepInputSchema.parse(input)
    await this.ctx.sandoreEngine.resumeStep(parsed.instanceId, parsed.stepId, parsed.resumePrompt)
  }

  /** 暂停实例内全部 Step（转发 `ctx.sandoreEngine.pauseAllSteps`）。 */
  @Remote('pauseAll')
  async pauseAll(input: PauseAllInput): Promise<void> {
    const parsed = PauseAllInputSchema.parse(input)
    await this.ctx.sandoreEngine.pauseAllSteps(parsed.instanceId)
  }

  /** 恢复实例内全部 Step（转发 `ctx.sandoreEngine.resumeAllSteps`，可选恢复提示词）。 */
  @Remote('resumeAll')
  async resumeAll(input: ResumeAllInput): Promise<void> {
    const parsed = ResumeAllInputSchema.parse(input)
    await this.ctx.sandoreEngine.resumeAllSteps(parsed.instanceId, parsed.resumePrompt)
  }

  /** 重试失败 Step（转发 `ctx.sandoreEngine.retryStep`）。 */
  @Remote('retryStep')
  async retryStep(input: RetryStepInput): Promise<void> {
    const parsed = RetryStepInputSchema.parse(input)
    await this.ctx.sandoreEngine.retryStep(parsed.instanceId, parsed.stepId, parsed.mode, parsed.message)
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
