/**
 * sandore 存储域持久化 Provider。
 *
 * `SandorePersistence` 在 `[Service.init]` 中打开 `sandore` 域（三表
 * `definitions`/`jobs`/`state`），用 `ctx.effect` 挂 `Domain.close()` 释放，
 * 并暴露三表 `KvTable` 句柄与 `saveWorkflowState`（`state.put(taskId, state)`
 * 全量覆盖）。`SandoreRemote` 通过 `ctx.sandorePersistence` 访问这些句柄。
 * @module @deepseek-ai/dsh-sandore-workflow/src/persistence
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { KvTable } from '@deepseek-ai/dsh-storage-domain';
import type { JobRecord, WorkflowDefinitionRecord, WorkflowTaskState } from './schema.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        sandorePersistence: SandorePersistence;
    }
}
/** sandore 存储域持久化 Provider。 */
export declare class SandorePersistence extends Service {
    static inject: string[];
    private definitionsTable?;
    private jobsTable?;
    private stateTable?;
    constructor(ctx: Context);
    protected [Service.init](): Promise<void>;
    /** `definitions` 表句柄（key = workflowId）。 */
    get definitions(): KvTable<string, WorkflowDefinitionRecord>;
    /** `jobs` 表句柄（key = jobId）。 */
    get jobs(): KvTable<string, JobRecord>;
    /** `state` 表句柄（key = instanceId）。 */
    get state(): KvTable<string, WorkflowTaskState>;
    /**
     * 全量覆盖写入实例状态快照。
     * @param state - 完整运行时状态快照；以 `state.taskId`（instanceId）为键。
     */
    saveWorkflowState(state: WorkflowTaskState): Promise<void>;
    private requireTable;
}
//# sourceMappingURL=persistence.d.ts.map