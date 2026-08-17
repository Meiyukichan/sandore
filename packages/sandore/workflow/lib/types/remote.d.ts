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
import type { Context } from '@deepseek-ai/cordis';
import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { DagRun } from './types.ts';
import type { WorkflowTaskState } from './schema.ts';
import type { ArtifactEntry, CreateDefinitionInput, CreateJobInput, InstanceSummary, JobEntry, ListJobsInput, PauseAllInput, PauseStepInput, PingResponse, ReplyPermissionInput, ReplyQuestionInput, ResumeAllInput, ResumeStepInput, RetryStepInput, StartInstanceInput, UpdateDefinitionInput, UpdateJobInput, WorkflowDefinitionEntry } from './wire.ts';
/**
 * sandore 的 Host RPC 服务。
 *
 * 定义/Job/实例 CRUD + 7 个生命周期 RPC + 产物查询 + Provider/Model 转发；
 * `ping` 保留。
 */
export declare class SandoreRemote extends TypertRemoteService {
    static inject: string[];
    constructor(ctx: Context);
    /** 健康检查往返，验证 Host/Client RPC 链路。 */
    ping(): PingResponse;
    /** 列出全部工作流定义（含 `id` 键）。 */
    listDefinitions(): WorkflowDefinitionEntry[];
    /**
     * 创建定义：解析+验证 YAML → 生成 `wfl-{uuid}` → 以规范 id 重新序列化存储。
     * 非法 YAML 抛 `SandoreError`，`definitions` 表不新增记录。存储的 YAML 文本顶层
     * `id` 与记录键一致（客户端传入的哨兵 id 如 `wfl-new` 不回写进持久化文本）。
     */
    createDefinition(input: CreateDefinitionInput): Promise<WorkflowDefinitionEntry>;
    /** 更新定义元数据（name/version/description），保留 yaml 文本。 */
    updateDefinition(id: string, input: UpdateDefinitionInput): Promise<WorkflowDefinitionEntry>;
    /** 删除定义（不级联删除实例）；重复删除幂等（返回 false）。 */
    deleteDefinition(id: string): Promise<boolean>;
    /** 读取定义的原始 YAML 文本。 */
    getYaml(id: string): string;
    /** 重新验证后覆盖定义的 YAML 文本；非法 YAML 抛错且存储保持旧值。
     *  元数据（name/version/description）从新 YAML 解析同步，保证列表展示与内容一致。 */
    updateYaml(id: string, yaml: string): Promise<WorkflowDefinitionEntry>;
    /** 列出 Job，可选按 workflowId 过滤（对象入参，RPC 面稳定）。 */
    listJobs(input: ListJobsInput): JobEntry[];
    /** 创建 Job：校验 workflowId 存在（否则抛 `INVALID_OPERATION`），自动生成 jobId。 */
    createJob(input: CreateJobInput): Promise<JobEntry>;
    /** 按 id 读取单个 Job。 */
    getJob(id: string): JobEntry;
    /** 更新 Job 元数据（name/cwd），保留 workflowId。 */
    updateJob(id: string, input: UpdateJobInput): Promise<JobEntry>;
    /** 删除 Job（不级联删除实例）；重复删除幂等（返回 false）。 */
    deleteJob(id: string): Promise<boolean>;
    /** 列出实例摘要（从 `state` 表派生），可选按 jobId 过滤。 */
    listInstances(jobId?: string): InstanceSummary[];
    /** 启动实例：解析 Job 的 workflowId 后转发 `ctx.sandoreEngine.startInstance`。 */
    startInstance(input: StartInstanceInput): Promise<DagRun>;
    /** 删除实例快照（`state` 表删除）；重复删除幂等。 */
    deleteInstance(instanceId: string): Promise<boolean>;
    /** 读取实例的完整状态快照；不存在抛 `NODE_NOT_FOUND`。 */
    getInstanceState(instanceId: string): WorkflowTaskState;
    /** 中止运行中实例（转发引擎）；终态实例抛 `INVALID_OPERATION`。 */
    abortInstance(instanceId: string): Promise<void>;
    /** 回复待处理问答（转发 `ctx.sandoreEngine.replyQuestion`）。 */
    replyQuestion(input: ReplyQuestionInput): Promise<void>;
    /** 回复待处理权限请求（转发 `ctx.sandoreEngine.replyPermission`）。 */
    replyPermission(input: ReplyPermissionInput): Promise<void>;
    /** 暂停单个 Step（转发 `ctx.sandoreEngine.pauseStep`）。 */
    pauseStep(input: PauseStepInput): Promise<void>;
    /** 恢复单个 Step（转发 `ctx.sandoreEngine.resumeStep`，可选恢复提示词）。 */
    resumeStep(input: ResumeStepInput): Promise<void>;
    /** 暂停实例内全部 Step（转发 `ctx.sandoreEngine.pauseAllSteps`）。 */
    pauseAll(input: PauseAllInput): Promise<void>;
    /** 恢复实例内全部 Step（转发 `ctx.sandoreEngine.resumeAllSteps`，可选恢复提示词）。 */
    resumeAll(input: ResumeAllInput): Promise<void>;
    /** 重试失败 Step（转发 `ctx.sandoreEngine.retryStep`）。 */
    retryStep(input: RetryStepInput): Promise<void>;
    /**
     * 查询实例产物：从 `stageContracts` 的产物契约扁平化条目，可选按 stageId 过滤。
     */
    getArtifacts(instanceId: string, stageId?: string): ArtifactEntry[];
    /** 列出 LLM Provider（透传 `ctx.llm.listProviders()`）。 */
    listProviders(): LlmProviderInfo[];
    /** 列出某 Provider 的模型（透传 `ctx.llm.listModels()`）。 */
    listModels(provider: string): Promise<LlmModelInfo[]>;
    private requireDefinition;
    private requireJob;
    private requireInstanceState;
}
export default SandoreRemote;
//# sourceMappingURL=remote.d.ts.map