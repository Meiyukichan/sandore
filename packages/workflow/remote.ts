/**
 * sandore Host RPC（Typert 协议）。
 *
 * `super(ctx, 'sandore')` 定 wire namespace，`@Remote('name')` 定 method，
 * 构成端点 `sandore.<method>`。定义/Job CRUD 读写在 `ctx.sandorePersistence`
 * 的三表上，实例生命周期（start/abort/reply/pause/resume/retry）转发
 * `ctx.sandoreEngine`，Provider/Model 转发 `ctx.llm`。RPC 层只做 zod 参数校验
 * + 转发/存储，无引擎业务逻辑。
 * @module @meiyukichan/dsh-sandore/workflow/src/remote
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import { SandoreError } from './errors.ts'
import { collectLibraryReferences, toLibrarySummary } from './library-views.ts'
import type { AskUserQuestionAnswer, DagRun, DagStartRequest } from './types.ts'
import {
  parseMicroflowYaml,
  parseStepYaml,
  parseWorkflowYaml,
  serializeWorkflowYaml,
} from './yaml-parser.ts'
import type { MicroflowRecord, StepRecord, WorkflowDefinitionRecord, WorkflowTaskState } from './schema.ts'
import {
  CreateDefinitionInputSchema,
  DeleteMicroflowInputSchema,
  DeleteStepInputSchema,
  GetMicroflowInputSchema,
  GetStepInputSchema,
  ImportDefinitionInputSchema,
  ListRevertBoundariesInputSchema,
  PauseAllInputSchema,
  PauseStepInputSchema,
  RecoverInstanceInputSchema,
  RejectQuestionInputSchema,
  ReplyPermissionInputSchema,
  ReplyQuestionInputSchema,
  ResumeAllInputSchema,
  ResumeStepInputSchema,
  RetryStepInputSchema,
  SendStepMessageInputSchema,
  StartInstanceInputSchema,
  UpdateDefinitionInputSchema,
  UpdateInstancePermissionModeInputSchema,
  UpsertMicroflowInputSchema,
  UpsertStepInputSchema,
} from './wire.ts'
import type {
  ArtifactEntry,
  CreateDefinitionInput,
  DeleteEntryResult,
  DeleteMicroflowInput,
  DeleteStepInput,
  GetMicroflowInput,
  GetStepInput,
  ImportDefinitionInput,
  ImportDefinitionResult,
  InstanceSummary,
  LibraryEntrySummary,
  ListRevertBoundariesInput,
  PauseAllInput,
  PauseStepInput,
  PingResponse,
  RecoverInstanceInput,
  RecoverOrphanedInstancesResult,
  RejectQuestionInput,
  ReplyPermissionInput,
  ReplyQuestionInput,
  ResumeAllInput,
  ResumeStepInput,
  RetryStepInput,
  RevertBoundaryOption,
  SendStepMessageInput,
  StartInstanceInput,
  UpdateDefinitionInput,
  UpdateInstancePermissionModeInput,
  UpsertMicroflowInput,
  UpsertStepInput,
  WorkflowDefinitionEntry,
} from './wire.ts'

/** 实例的终态集合：`abortInstance` 对终态实例拒绝操作。 */
const TERMINAL_STATUSES: ReadonlySet<WorkflowTaskState['status']> = new Set(['completed', 'failed', 'aborted'])

/**
 * sandore 的 Host RPC 服务。
 *
 * 定义/Job/实例 CRUD + 生命周期 RPC（reply/pause/resume/retry/recover）+ 产物查询
 * + Provider/Model 转发；`ping` 保留。
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
    // 三级分离：新建首次自动入库——内联 stages/steps putIfAbsent 写库表（best-effort，
    // 库已有 id / 名称冲突 / step 无名称时静默跳过，不阻断保存）。
    await this.ctx.sandorePersistence.writeDefinitionToLibraries({ ...definition, id })
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

  /** 重新验证后覆盖定义的 YAML 文本；非法 YAML 抛错且存储保持旧值。
   *  元数据（name/version/description）从新 YAML 解析同步，保证列表展示与内容一致。 */
  @Remote('updateYaml')
  async updateYaml(id: string, yaml: string): Promise<WorkflowDefinitionEntry> {
    const parsed = parseWorkflowYaml(yaml)
    const existing = this.requireDefinition(id)
    const now = new Date().toISOString()
    const next: WorkflowDefinitionRecord = {
      yaml,
      name: parsed.name,
      version: parsed.version,
      ...(parsed.description === undefined ? {} : { description: parsed.description }),
      createdAt: existing.createdAt,
      updatedAt: now,
    }
    await this.ctx.sandorePersistence.definitions.put(id, next)
    // 三级分离：保存路径自动补写库表（putIfAbsent——库已有 id 跳过，保持「自动入库
    // 仅一次」语义；旧定义首次保存自动补写）。
    await this.ctx.sandorePersistence.writeDefinitionToLibraries(parsed)
    return { id, ...next }
  }

  /**
   * 幂等导入工作流定义（缺陷 30）：parseWorkflowYaml → 按 `matchBy` 在
   * `definitions` 表查找现有 → 同版本 skipped / 不同版本 updateYaml / 不存在
   * createDefinition。返回对齐基准 `{ created | updated | skipped }` 三态。
   *
   * 身份稳定性：`createDefinition` 强制生成新 `wfl-{uuid}` 并改写 YAML 顶层 id
   * （remote.spec 锁定此行为），故默认 `matchBy:'name'`（应答文档缺陷 30 修复
   * 计划点 2「关键前置」推荐后者——按 name 查找是唯一能在「复用 createDefinition/
   * updateYaml 本体不改」约束下实现幂等导入的策略）。name 非唯一键：多匹配时取
   * 最新 `updatedAt` 的记录（确定性策略，SA8），并在 `matchedCount` 注明命中数。
   *
   * `matchBy:'id'` 按 YAML 顶层 id 直接查 `definitions` 表；标准 `createDefinition`
   * 路径产生的记录键为 `wfl-{uuid}` 而非 YAML 原始 id，故 'id' 模式仅在记录曾以
   * YAML id 为键存储时可命中——对任意文件的幂等重放导入，请用默认 'name'。
   *
   * 文件读取归属：workflow 包为浏览器安全包（无 Node fs），调用方（CI 脚本/
   * CLI）自行 `fs.readFileSync` 后调本 RPC；服务端路径导入应在 Host 侧另包一层。
   */
  @Remote('importDefinitionFromYaml')
  async importDefinitionFromYaml(input: ImportDefinitionInput): Promise<ImportDefinitionResult> {
    const parsed = ImportDefinitionInputSchema.parse(input)
    const definition = parseWorkflowYaml(parsed.yaml)
    const matchBy = parsed.matchBy ?? 'name'
    const yaml = parsed.yaml

    if (matchBy === 'id') {
      const existing = this.ctx.sandorePersistence.definitions.get(definition.id)
      if (existing === undefined) {
        const created = await this.createDefinition({ yaml })
        return { status: 'created', id: created.id, name: created.name, matchedCount: 0 }
      }
      if (existing.version === definition.version) {
        return { status: 'skipped', id: definition.id, name: existing.name, matchedCount: 1 }
      }
      await this.updateYaml(definition.id, yaml)
      return { status: 'updated', id: definition.id, name: definition.name, matchedCount: 1 }
    }

    // matchBy === 'name'：收集全部同名记录。
    const matches: Array<{ id: string; record: WorkflowDefinitionRecord }> = []
    for (const [id, record] of this.ctx.sandorePersistence.definitions.entries()) {
      if (record.name === definition.name) matches.push({ id, record })
    }
    if (matches.length === 0) {
      const created = await this.createDefinition({ yaml })
      return { status: 'created', id: created.id, name: created.name, matchedCount: 0 }
    }
    // 多匹配歧义（SA8）：取最新 updatedAt（确定性）；平手时按 Map 插入序取首个。
    const matched = matches.reduce((latest, current) =>
      current.record.updatedAt > latest.record.updatedAt ? current : latest,
    )
    if (matched.record.version === definition.version) {
      return { status: 'skipped', id: matched.id, name: matched.record.name, matchedCount: matches.length }
    }
    await this.updateYaml(matched.id, yaml)
    return { status: 'updated', id: matched.id, name: definition.name, matchedCount: matches.length }
  }

  // ── 库管理（三级分离：Step / Microflow 库） ────────────────────────────────

  /** 列出 Step 库条目摘要（含被引用数；UI 名「Agent 库」）。 */
  @Remote('listSteps')
  listSteps(): LibraryEntrySummary[] {
    const { stepRefs } = collectLibraryReferences(this.ctx.sandorePersistence.definitions)
    const summaries: LibraryEntrySummary[] = []
    for (const [id, record] of this.ctx.sandorePersistence.steps.entries()) {
      summaries.push(toLibrarySummary(id, record, stepRefs))
    }
    return summaries
  }

  /** 读取单个 Step 库条目；不存在抛 `NODE_NOT_FOUND`。 */
  @Remote('getStep')
  getStep(input: GetStepInput): StepRecord {
    const parsed = GetStepInputSchema.parse(input)
    return this.requireStep(parsed.id)
  }

  /**
   * 写入/覆盖 Step 库条目（覆盖模式）：解析 YAML → 名称查重（同 name 不同 id 抛
   * `DUPLICATE_NAME`）→ 全量覆盖。已有条目保留 `createdAt`，刷新 `updatedAt`。
   */
  @Remote('upsertStep')
  async upsertStep(input: UpsertStepInput): Promise<StepRecord> {
    const parsed = UpsertStepInputSchema.parse(input)
    const record = parseStepYaml(parsed.yaml)
    const now = new Date().toISOString()
    const existing = this.ctx.sandorePersistence.steps.get(record.id)
    const next: StepRecord = { ...record, createdAt: existing?.createdAt ?? now, updatedAt: now }
    await this.ctx.sandorePersistence.upsertStep(next)
    return next
  }

  /**
   * 删除 Step 库条目：被任一工作流定义引用（id 命中）时抛 `REFERENCED`（消息携带
   * 引用方 workflowId 列表）；否则删除并返回 `{ deleted: true }`（重复删除幂等 false）。
   */
  @Remote('deleteStep')
  async deleteStep(input: DeleteStepInput): Promise<DeleteEntryResult> {
    const parsed = DeleteStepInputSchema.parse(input)
    const { stepRefs } = collectLibraryReferences(this.ctx.sandorePersistence.definitions)
    const owners = stepRefs.get(parsed.id)
    if (owners !== undefined && owners.size > 0) {
      throw new SandoreError(`step '${parsed.id}' is referenced by: ${[...owners].sort().join(', ')}`, 'REFERENCED')
    }
    return { deleted: await this.ctx.sandorePersistence.steps.delete(parsed.id) }
  }

  /** 列出 Microflow 库条目摘要（含被引用数；UI 名「Microflow 库」）。 */
  @Remote('listMicroflows')
  listMicroflows(): LibraryEntrySummary[] {
    const { microflowRefs } = collectLibraryReferences(this.ctx.sandorePersistence.definitions)
    const summaries: LibraryEntrySummary[] = []
    for (const [id, record] of this.ctx.sandorePersistence.microflows.entries()) {
      summaries.push(toLibrarySummary(id, record, microflowRefs))
    }
    return summaries
  }

  /** 读取单个 Microflow 库条目；不存在抛 `NODE_NOT_FOUND`。 */
  @Remote('getMicroflow')
  getMicroflow(input: GetMicroflowInput): MicroflowRecord {
    const parsed = GetMicroflowInputSchema.parse(input)
    return this.requireMicroflow(parsed.id)
  }

  /** 写入/覆盖 Microflow 库条目（覆盖模式，语义同 {@link upsertStep}）。 */
  @Remote('upsertMicroflow')
  async upsertMicroflow(input: UpsertMicroflowInput): Promise<MicroflowRecord> {
    const parsed = UpsertMicroflowInputSchema.parse(input)
    const record = parseMicroflowYaml(parsed.yaml)
    const now = new Date().toISOString()
    const existing = this.ctx.sandorePersistence.microflows.get(record.id)
    const next: MicroflowRecord = { ...record, createdAt: existing?.createdAt ?? now, updatedAt: now }
    await this.ctx.sandorePersistence.upsertMicroflow(next)
    return next
  }

  /**
   * 删除 Microflow 库条目：被引用 → `REFERENCED` + 引用方列表；否则删除
   * （重复删除幂等 false）。语义同 {@link deleteStep}。
   */
  @Remote('deleteMicroflow')
  async deleteMicroflow(input: DeleteMicroflowInput): Promise<DeleteEntryResult> {
    const parsed = DeleteMicroflowInputSchema.parse(input)
    const { microflowRefs } = collectLibraryReferences(this.ctx.sandorePersistence.definitions)
    const owners = microflowRefs.get(parsed.id)
    if (owners !== undefined && owners.size > 0) {
      throw new SandoreError(`microflow '${parsed.id}' is referenced by: ${[...owners].sort().join(', ')}`, 'REFERENCED')
    }
    return { deleted: await this.ctx.sandorePersistence.microflows.delete(parsed.id) }
  }

  // ── 实例生命周期 ─────────────────────────────────────────────────────────

  /** 列出实例摘要（从 `state` 表派生，去 job 概念）。 */
  @Remote('listInstances')
  listInstances(): InstanceSummary[] {
    const summaries: InstanceSummary[] = []
    for (const [instanceId, state] of this.ctx.sandorePersistence.state.entries()) {
      summaries.push({
        instanceId,
        workflowId: state.workflowId,
        originalInput: state.originalInput,
        status: state.status,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      })
    }
    return summaries
  }

  /**
   * 启动实例（入口归一第一阶段）：校验定义存在后转发 `ctx.sandoreEngine.startInstance`。
   *
   * 恒等式（架构决策 1）：本 RPC 只**建会话 + 绑实例 + 注入协作上下文**，返回
   * `{instanceId, status:'pending'}`；真正的执行由该新建会话（= 实例 id = 宿主会话 id）
   * 调用 `sandore_workflow_run` 触发。入参不再有 `hostSessionId`（宿主会话恒为本 RPC
   * 新建的会话）。
   */
  @Remote('startInstance')
  async startInstance(input: StartInstanceInput): Promise<DagRun> {
    const parsed = StartInstanceInputSchema.parse(input)
    if (this.ctx.sandorePersistence.definitions.get(parsed.workflowId) === undefined) {
      throw new SandoreError(`workflow '${parsed.workflowId}' does not exist`, 'INVALID_OPERATION')
    }
    const request = {
      workflowId: parsed.workflowId,
      originalInput: parsed.originalInput,
      // cwd 必填（wire schema 已校验）：直接透传，hostAgent 据此 attach web workspace。
      cwd: parsed.cwd,
      ...(parsed.model === undefined ? {} : { model: parsed.model }),
      ...(parsed.permission === undefined ? {} : { permission: parsed.permission }),
    } as DagStartRequest
    return await this.ctx.sandoreEngine.startInstance(request)
  }

  /** 删除实例快照（`state` 表删除）；重复删除幂等。 */
  @Remote('deleteInstance')
  async deleteInstance(instanceId: string): Promise<boolean> {
    return await this.ctx.sandorePersistence.state.delete(instanceId)
  }

  /**
   * 读取实例的完整状态快照：内存 active.state 第一优先级（收尾中间态立即可见），
   * 未在内存（终态清表/未启动）回退持久化；两者皆无抛 NODE_NOT_FOUND。
   *
   * **展示派生数据的按需回填**：`executedSteps[].sessionMessages` 不再持久化
   *（实测占 state 的 41%–54%），本 RPC 返回前经 `engine.hydrateStateMessages`
   * 从各段子代理会话现算补回（live 优先 → 持久化回退）。消费面（client 的
   * `chatLinesOf`、e2e 断言）字段名与形状不变，只是数据来源从 state 副本改为会话真值。
   */
  @Remote('getInstanceState')
  async getInstanceState(instanceId: string): Promise<WorkflowTaskState> {
    const live = this.ctx.sandoreEngine.getInstanceState(instanceId)
    const state = live !== undefined ? live : this.requireInstanceState(instanceId)
    return await this.ctx.sandoreEngine.hydrateStateMessages(state)
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

  /**
   * 恢复单个实例（崩溃恢复入口）：前置 state 表终态守卫后转发
   * `ctx.sandoreEngine.recoverInstance`。内存未命中但快照非终态的孤儿实例
   * 经此端点重新进入内存登记表并续跑；内存已有的非终态实例为 no-op 返回
   * 当前状态。终态实例拒绝（守卫对齐 `abortInstance`，避免无意义恢复）。
   */
  @Remote('recoverInstance')
  async recoverInstance(input: RecoverInstanceInput): Promise<DagRun> {
    const parsed = RecoverInstanceInputSchema.parse(input)
    const state = this.requireInstanceState(parsed.instanceId)
    if (TERMINAL_STATUSES.has(state.status)) {
      throw new SandoreError(`instance '${parsed.instanceId}' is already in terminal state '${state.status}'`, 'INVALID_OPERATION')
    }
    return await this.ctx.sandoreEngine.recoverInstance(parsed.instanceId)
  }

  /**
   * 批量恢复孤儿实例（对齐基准 GET /jobs 恢复触发）：遍历 state 表全部非终态
   * 实例逐个 `recoverInstance`，单实例失败不阻断（逐实例 try/catch），
   * 返回 `{ recovered, errors }` 摘要。供前端在进程重启后一键恢复全部孤儿。
   */
  @Remote('recoverOrphanedInstances')
  async recoverOrphanedInstances(): Promise<RecoverOrphanedInstancesResult> {
    return await this.ctx.sandoreEngine.recoverOrphanedInstances()
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

  /** 拒绝待处理问答（转发 `ctx.sandoreEngine.rejectQuestion`，标对应 Step failed，缺陷 26）。 */
  @Remote('rejectQuestion')
  async rejectQuestion(input: RejectQuestionInput): Promise<void> {
    const parsed = RejectQuestionInputSchema.parse(input)
    await this.ctx.sandoreEngine.rejectQuestion(parsed.instanceId, parsed.requestId)
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

  /**
   * 重试失败 Step（转发 `ctx.sandoreEngine.retryStep`）。
   *
   * @deprecated 架构决策 3 去掉了「回滚会话/回退点（revert）」功能：新工具面
   * `sandore_workflow_control` 只用 continue（paused 续跑现有子代理）/ fork（failed
   * 重建子代理），`revertBoundary` 不再对外提供。本 RPC 保留 `revert` 分支与
   * `revertBoundary` 入参**仅为兼容既有 client 呈现层**（`packages/client/RunView.tsx`
   * / `step-view/StepRetryRow.tsx` 仍装配它们，而呈现层不在本次改造范围内）。
   */
  @Remote('retryStep')
  async retryStep(input: RetryStepInput): Promise<void> {
    const parsed = RetryStepInputSchema.parse(input)
    await this.ctx.sandoreEngine.retryStep(parsed.instanceId, parsed.stepId, parsed.mode, parsed.message, parsed.revertBoundary)
  }

  /**
   * 列出某 Step 子代理会话中可用的闭合 turn 回退点候选。
   *
   * @deprecated 见 {@link SandoreRemote.retryStep}：回退点功能已去掉，本 RPC 仅为兼容
   * 既有 client 呈现层保留。
   */
  @Remote('listRevertBoundaries')
  listRevertBoundaries(input: ListRevertBoundariesInput): RevertBoundaryOption[] {
    const parsed = ListRevertBoundariesInputSchema.parse(input)
    return this.ctx.sandoreEngine.listRevertBoundaries(parsed.instanceId, parsed.stepId)
  }

  /**
   * 向运行中实例的指定 Step 子代理追加一条用户消息。
   *
   * zod 校验 + 终态守卫后转发 `ctx.sandoreEngine.sendStepMessage`（对齐
   * `updateInstancePermissionMode` / `recoverInstance` / `abortInstance` 的两层
   * 守卫：remote 层基于持久化 state 终态守卫，engine 层基于内存 ActiveInstance）。
   * 引擎层 requireActive + 终态守卫 → 按 stepId 反查最后活跃段并校验状态门槛
   * （仅 running/interacting；synthetic 抛 INVALID_OPERATION）→ 投递到子代理会话 →
   * 单发 `sandore/step-message`。**不写 `state.userMessages`**（消息只在子代理会话
   * 与事件里，discussion 页只展示 step agent 消息与主代理消息）。
   * 错误透传（对齐 retryStep 风格，不吞 SandoreError）。
   */
  @Remote('sendStepMessage')
  async sendStepMessage(input: SendStepMessageInput): Promise<void> {
    const parsed = SendStepMessageInputSchema.parse(input)
    const state = this.requireInstanceState(parsed.instanceId)
    if (TERMINAL_STATUSES.has(state.status)) {
      throw new SandoreError(`instance '${parsed.instanceId}' is already in terminal state '${state.status}'`, 'INVALID_OPERATION')
    }
    await this.ctx.sandoreEngine.sendStepMessage(parsed.instanceId, parsed.stepId, parsed.message)
  }

  /**
   * 运行中切换实例权限模式（缺陷 29）：zod 校验 + 终态守卫后转发
   * `ctx.sandoreEngine.setPermissionMode`。对齐 abortInstance/recoverInstance 的
   * 两层守卫（remote 层基于持久化 state 终态守卫，engine 层基于内存
   * ActiveInstance）；engine 层对宿主 session + hostAgent 重新应用 sandbox 模式
   * + 审批策略，下次受限调用即生效。
   */
  @Remote('updateInstancePermissionMode')
  async updateInstancePermissionMode(input: UpdateInstancePermissionModeInput): Promise<void> {
    const parsed = UpdateInstancePermissionModeInputSchema.parse(input)
    const state = this.requireInstanceState(parsed.instanceId)
    if (TERMINAL_STATUSES.has(state.status)) {
      throw new SandoreError(`instance '${parsed.instanceId}' is already in terminal state '${state.status}'`, 'INVALID_OPERATION')
    }
    await this.ctx.sandoreEngine.setPermissionMode(parsed.instanceId, parsed.mode)
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

  /** 读取 Step 库条目；不存在抛 `NODE_NOT_FOUND`。 */
  private requireStep(id: string): StepRecord {
    const record = this.ctx.sandorePersistence.steps.get(id)
    if (record === undefined) {
      throw new SandoreError(`step library entry '${id}' not found`, 'NODE_NOT_FOUND')
    }
    return record
  }

  /** 读取 Microflow 库条目；不存在抛 `NODE_NOT_FOUND`。 */
  private requireMicroflow(id: string): MicroflowRecord {
    const record = this.ctx.sandorePersistence.microflows.get(id)
    if (record === undefined) {
      throw new SandoreError(`microflow library entry '${id}' not found`, 'NODE_NOT_FOUND')
    }
    return record
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
