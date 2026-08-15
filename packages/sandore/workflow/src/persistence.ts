/**
 * sandore 存储域持久化 Provider。
 *
 * `SandorePersistence` 在 `[Service.init]` 中打开 `sandore` 域（三表
 * `definitions`/`jobs`/`state`），用 `ctx.effect` 挂 `Domain.close()` 释放，
 * 并暴露三表 `KvTable` 句柄与 `saveWorkflowState`（`state.put(taskId, state)`
 * 全量覆盖）。`SandoreRemote` 通过 `ctx.sandorePersistence` 访问这些句柄。
 * @module @deepseek-ai/dsh-sandore-workflow/src/persistence
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

import {
  sandoreDomainSpec,
  type JobRecord,
  type WorkflowDefinitionRecord,
  type WorkflowTaskState,
} from './schema.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandorePersistence: SandorePersistence
  }
}

/** sandore 存储域持久化 Provider。 */
export class SandorePersistence extends Service {
  static inject = ['storageDomain']

  private definitionsTable?: KvTable<string, WorkflowDefinitionRecord>
  private jobsTable?: KvTable<string, JobRecord>
  private stateTable?: KvTable<string, WorkflowTaskState>

  constructor(ctx: Context) {
    super(ctx, 'sandorePersistence')
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(sandoreDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'sandore.domainClose')
    this.definitionsTable = domain.table('definitions')
    this.jobsTable = domain.table('jobs')
    this.stateTable = domain.table('state')
  }

  /** `definitions` 表句柄（key = workflowId）。 */
  get definitions(): KvTable<string, WorkflowDefinitionRecord> {
    return this.requireTable(this.definitionsTable, 'definitions')
  }

  /** `jobs` 表句柄（key = jobId）。 */
  get jobs(): KvTable<string, JobRecord> {
    return this.requireTable(this.jobsTable, 'jobs')
  }

  /** `state` 表句柄（key = instanceId）。 */
  get state(): KvTable<string, WorkflowTaskState> {
    return this.requireTable(this.stateTable, 'state')
  }

  /**
   * 全量覆盖写入实例状态快照。
   * @param state - 完整运行时状态快照；以 `state.taskId`（instanceId）为键。
   */
  async saveWorkflowState(state: WorkflowTaskState): Promise<void> {
    await this.state.put(state.taskId, state)
  }

  private requireTable<V>(table: KvTable<string, V> | undefined, name: string): KvTable<string, V> {
    if (table === undefined) {
      throw new Error(`sandore persistence is not initialized ('${name}' table unavailable)`)
    }
    return table
  }
}
