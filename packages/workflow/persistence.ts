/**
 * sandore 存储域持久化 Provider。
 *
 * `SandorePersistence` 在 `[Service.init]` 中打开 `sandore` 域（四表
 * `definitions`/`state`/`steps`/`microflows`，去 job 概念），用 `ctx.effect` 挂
 * `Domain.close()` 释放，并暴露四表 `KvTable` 句柄与便捷方法：`saveWorkflowState`
 * （`state.put(taskId, state)` 全量覆盖）、库表 `putStepIfAbsent`/`putMicroflowIfAbsent`
 * （仅库无此 id 时写入——新建首次自动入库）、`upsertStep`/`upsertMicroflow`
 * （同步覆盖 + 名称查重）与 `writeDefinitionToLibraries`（保存路径调用）。
 * `SandoreRemote` 通过 `ctx.sandorePersistence` 访问这些句柄。
 * @module @meiyukichan/dsh-sandore/workflow/src/persistence
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

import { SandoreError } from './errors.ts'
import { sandoreDomainSpec } from './domain.ts'
import type {
  MicroflowRecord,
  StepRecord,
  WorkflowDefinitionRecord,
  WorkflowTaskState,
  WorkflowDefinition,
} from './schema.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandorePersistence: SandorePersistence
  }
}

/** 库条目的最小形状（供名称查重泛型收窄）。 */
interface NamedRecord {
  id: string
  name: string
}

/** sandore 存储域持久化 Provider。 */
export class SandorePersistence extends Service {
  static inject = ['storageDomain']

  private definitionsTable?: KvTable<string, WorkflowDefinitionRecord>
  private stateTable?: KvTable<string, WorkflowTaskState>
  private stepsTable?: KvTable<string, StepRecord>
  private microflowsTable?: KvTable<string, MicroflowRecord>

  constructor(ctx: Context) {
    super(ctx, 'sandorePersistence')
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(sandoreDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'sandore.domainClose')
    this.definitionsTable = domain.table('definitions')
    this.stateTable = domain.table('state')
    this.stepsTable = domain.table('steps')
    this.microflowsTable = domain.table('microflows')
  }

  /** `definitions` 表句柄（key = workflowId）。 */
  get definitions(): KvTable<string, WorkflowDefinitionRecord> {
    return this.requireTable(this.definitionsTable, 'definitions')
  }

  /** `state` 表句柄（key = instanceId）。 */
  get state(): KvTable<string, WorkflowTaskState> {
    return this.requireTable(this.stateTable, 'state')
  }

  /** `steps` 库表句柄（key = `step-{uuid}`；UI 名「Agent 库」）。 */
  get steps(): KvTable<string, StepRecord> {
    return this.requireTable(this.stepsTable, 'steps')
  }

  /** `microflows` 库表句柄（key = `stg-{uuid}`；UI 名「Microflow 库」）。 */
  get microflows(): KvTable<string, MicroflowRecord> {
    return this.requireTable(this.microflowsTable, 'microflows')
  }

  /**
   * 全量覆盖写入实例状态快照。
   * @param state - 完整运行时状态快照；以 `state.taskId`（instanceId）为键。
   */
  async saveWorkflowState(state: WorkflowTaskState): Promise<void> {
    await this.state.put(state.taskId, state)
  }

  /**
   * Step 库 putIfAbsent（三级分离「自动入库仅一次」）：仅库**无此 id** 时写入，
   * 已有 → 跳过并返回 false（新建首次保存 = 库无 id → 写入；之后修改保存 = 库已有
   * → 不动，保持独立快照）。
   * @param record - 待入库的 Step 条目（含 `createdAt`/`updatedAt`）。
   * @returns 是否实际写入。
   */
  async putStepIfAbsent(record: StepRecord): Promise<boolean> {
    if (this.steps.get(record.id) !== undefined) return false
    await this.steps.put(record.id, record)
    return true
  }

  /**
   * Microflow 库 putIfAbsent（语义同 {@link putStepIfAbsent}）。
   * @param record - 待入库的 Microflow 条目（含 `createdAt`/`updatedAt`）。
   * @returns 是否实际写入。
   */
  async putMicroflowIfAbsent(record: MicroflowRecord): Promise<boolean> {
    if (this.microflows.get(record.id) !== undefined) return false
    await this.microflows.put(record.id, record)
    return true
  }

  /**
   * Step 库同步覆盖（【同步到库】按钮路径）：名称查重（同 name 不同 id →
   * `DUPLICATE_NAME`，消息携带已有条目 id）后全量覆盖写入。
   * @param record - 待写入的 Step 条目（id 同名同 id 时为正常覆盖）。
   */
  async upsertStep(record: StepRecord): Promise<void> {
    await this.assertNoDuplicateName(this.steps, record)
    await this.steps.put(record.id, record)
  }

  /**
   * Microflow 库同步覆盖（语义同 {@link upsertStep}）。
   * @param record - 待写入的 Microflow 条目（id 同名同 id 时为正常覆盖）。
   */
  async upsertMicroflow(record: MicroflowRecord): Promise<void> {
    await this.assertNoDuplicateName(this.microflows, record)
    await this.microflows.put(record.id, record)
  }

  /**
   * 保存工作流定义后自动补写库表（三级分离 plan §4.3）：内联 stages/steps 逐条
   * putIfAbsent。**best-effort**：无名称的 step 跳过（库条目必须有名称）、库中已有
   * 同 id（后续修改保存）或同 name 不同 id（名称冲突）时静默跳过——自动路径不抛错，
   * 不阻断工作流保存；显式覆盖走 {@link upsertStep}/{@link upsertMicroflow}。
   * @param definition - 解析成功的工作流定义。
   */
  async writeDefinitionToLibraries(definition: WorkflowDefinition): Promise<void> {
    const now = new Date().toISOString()
    for (const stage of definition.stages) {
      if (stage.name.trim() === '') continue
      // 同 name 不同 id 的既有条目存在时跳过（putIfAbsent 不查重，这里先查）。
      if ((await this.findDuplicateName(this.microflows, stage.id, stage.name)) !== undefined) continue
      await this.putMicroflowIfAbsent({
        id: stage.id,
        name: stage.name,
        ...(stage.rules === undefined ? {} : { rules: stage.rules }),
        ...(stage.gates === undefined ? {} : { gates: stage.gates }),
        ...(stage.defaultExpectation === undefined ? {} : { defaultExpectation: stage.defaultExpectation }),
        steps: stage.steps,
        createdAt: now,
        updatedAt: now,
      })
    }
    for (const step of definition.steps ?? []) {
      if (step.name === undefined || step.name.trim() === '') continue
      if ((await this.findDuplicateName(this.steps, step.id, step.name)) !== undefined) continue
      await this.putStepIfAbsent({
        id: step.id,
        name: step.name,
        ...(step.command === undefined ? {} : { command: step.command }),
        ...(step.outputTo === undefined ? {} : { outputTo: step.outputTo }),
        ...(step.passThroughVars === undefined ? {} : { passThroughVars: step.passThroughVars }),
        ...(step.timeout === undefined ? {} : { timeout: step.timeout }),
        ...(step.defaultExpectation === undefined ? {} : { defaultExpectation: step.defaultExpectation }),
        ...(step.rules === undefined ? {} : { rules: step.rules }),
        ...(step.gates === undefined ? {} : { gates: step.gates }),
        createdAt: now,
        updatedAt: now,
      })
    }
  }

  /** 名称查重：库中存在「同 name 不同 id」时返回该条目 id，否则 undefined。 */
  private async findDuplicateName<V extends NamedRecord>(
    table: KvTable<string, V>,
    id: string,
    name: string,
  ): Promise<string | undefined> {
    for (const [existingId, existing] of table.entries()) {
      if (existingId !== id && existing.name === name) return existingId
    }
    return undefined
  }

  /** 同步覆盖前的名称查重守卫：冲突抛 `DUPLICATE_NAME`（消息携带已有条目 id）。 */
  private async assertNoDuplicateName<V extends NamedRecord>(table: KvTable<string, V>, record: V): Promise<void> {
    const duplicateId = await this.findDuplicateName(table, record.id, record.name)
    if (duplicateId !== undefined) {
      throw new SandoreError(
        `library entry name '${record.name}' is already used by '${duplicateId}'`,
        'DUPLICATE_NAME',
      )
    }
  }

  private requireTable<V>(table: KvTable<string, V> | undefined, name: string): KvTable<string, V> {
    if (table === undefined) {
      throw new Error(`sandore persistence is not initialized ('${name}' table unavailable)`)
    }
    return table
  }
}
