/**
 * sandore 工作流引擎运行时（Stage 级线性主循环）。
 *
 * `SandoreEngineRuntime` 继承 {@link SandoreEngine}：`startInstance` 异步完成
 * 读定义 → parse → 生成 instanceId → 初始化 pending 快照 → `ctx.agents.create`
 * 创建宿主主代理（setup 注册 8 个 `sandore_*` 工具）→ fire-and-forget
 * `execute`；`execute` 以 Stage 级线性主循环编排（StageExecutor 执行 Stage 内
 * Step → 收集 StageContract → `tryAdvanceStage` 跟随 `Stage.next`）。每次状态
 * 变化 `persistState` 并双发 `sandore/*` 事件（`ctx.emit` + 宿主 Session
 * `append`）；每个 Step 完成后经 `onPersist` 钩子立即追加到
 * `state.executedSteps` 并持久化；`childId = step-{stepId}-{execId 前 8 位}`
 * 合成 sessionMeta。
 * @module @deepseek-ai/dsh-sandore-workflow/src/workflow-engine
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { RetryMode } from './recovery-manager.ts';
import { SandoreEngine } from './seam.ts';
import type { SandoreConfig } from './seam.ts';
import type { AskUserQuestionAnswer, DagRun, DagStartRequest, DagInstanceState } from './types.ts';
/**
 * 工作流引擎运行时。
 *
 * 作为 workflow 包默认导出：实现 11 个实例级生命周期方法
 * （start/recover/abort/reply/pause/resume/retry/getState），其中 8 个
 * 交互/生命周期/恢复方法转调 interaction/lifecycle/recovery 三管理器。
 */
export default class SandoreEngineRuntime extends SandoreEngine {
    private readonly config;
    static Config: z<SandoreConfig>;
    static inject: string[];
    private readonly instances;
    constructor(ctx: Context, config: SandoreConfig);
    /** 启动时（Cordis Service.init）自动扫描并恢复孤儿实例（崩溃恢复启动扫描）。 */
    protected [Service.init](): Promise<void>;
    /** 启动实例：读定义 → parse → 初始化 pending 快照 → 创建宿主主代理 → fire-and-forget 执行。 */
    startInstance(request: DagStartRequest): Promise<DagRun>;
    /** 查询实例的当前状态快照（内存活跃实例优先，state 表兜底读）。 */
    getState(instanceId: string): DagInstanceState;
    /**
     * 中止运行中的实例：置中止标志 → 登记表内全部子代理 interrupt（ancestor）→
     * 实例 aborted 终态（保留持久化快照）→ 双发 `sandore/aborted` → 清理内存
     * ActiveInstance（getState 退回 state 表仍可读到 aborted 快照）。
     */
    abortInstance(instanceId: string): Promise<void>;
    /**
     * 恢复单个实例（崩溃恢复入口）。
     *
     * 对终态实例抛 `INVALID_OPERATION`；内存未命中时从持久化 state 表读回快照，经
     * `ctx.agents.resume` 冷恢复宿主主代理（setup 重跑）→ `recovery.recover()` 分类恢复
     * Step（running/interacting 子代理 followup 冷恢复、合成 session 标 failed）→ 重建
     * 登记表 → 重跑 `runInstance` 续跑，返回 `DagRun`。
     */
    recoverInstance(instanceId: string): Promise<DagRun>;
    /**
     * 孤儿实例启动扫描：遍历 state 表全部条目 → 跳过终态 → 逐个调用
     * `recoverInstance`。单实例失败不阻断（逐实例 try/catch），返回
     * `{ recovered, errors }`。
     */
    recoverOrphanedInstances(): Promise<{
        recovered: string[];
        errors: Array<{
            instanceId: string;
            error: string;
        }>;
    }>;
    replyQuestion(instanceId: string, requestId: string, answers: AskUserQuestionAnswer): Promise<void>;
    replyPermission(instanceId: string, requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void>;
    /** 暂停单个 Step（委托生命周期协调器：反查 childId → interrupt → 登记表 → 状态 paused）。 */
    pauseStep(instanceId: string, stepId: string): Promise<void>;
    /** 恢复单个 Step（委托生命周期协调器：反查 childId → 移出登记表 → followup → 状态 running）。 */
    resumeStep(instanceId: string, stepId: string, resumePrompt?: string): Promise<void>;
    /** 暂停实例内全部 running/interacting Step（completed/failed 与非子代理 Step 跳过）。 */
    pauseAllSteps(instanceId: string): Promise<void>;
    /** 恢复登记表内全部 Step（逐个 followup 并清空登记表）。 */
    resumeAllSteps(instanceId: string, resumePrompt?: string): Promise<void>;
    /** 重试单个 Step（continue/revert/fork 三模式，委托恢复协调器）。 */
    retryStep(instanceId: string, stepId: string, mode: RetryMode, message: string): Promise<void>;
    private execute;
    /** 重试/恢复后的续跑执行（复用 runInstance 主循环，从快照续跑，不重发 start）。 */
    private resumeExecution;
    /** 运行主循环并兜底引擎级故障为 failed 终态。 */
    private runAndCatch;
    private runInstance;
    private markStageStatus;
    private runnerConfig;
    /** 构造完整 ActiveInstance（交互/生命周期/恢复三个管理器 + 宿主主代理 + 状态快照）。 */
    private buildActiveInstance;
    /** 快照是否含 paused Step（paused-only 实例等待手动 resume，不自动重跑）。 */
    private hasPausedStep;
    /** 续跑执行位置的起始 Stage：running/interacting Step 所在 Stage，否则 currentStageId。 */
    private resumeStageId;
    /** 计算 Stage 续跑播种：跳过已完成 Step 并从 running/interacting 子代理 Step 续跑。 */
    private resumeInfo;
    private persistence;
    /** 取内存活跃实例；未命中抛 `NODE_NOT_FOUND`。 */
    private requireActive;
    /**
     * 主循环 paused 时等待 resume 信号（与 `signal.aborted` 竞争）。
     *
     * 若 resume 已先行触发（竞态：resumeStep 先于主循环进入等待），立即消费标志返回；
     * 否则注册 waiter 并监听 abort：由 `notifyResume` 在 resumeStep/resumeAllSteps 时
     * resolve，或由 `abortInstance` 的 `controller.abort()` 触发 abort 监听 resolve——
     * 主循环恢复后经 `signal.aborted` 检查退出到 aborted 处理分支，避免 paused 期中止
     * 导致主循环永久悬挂。
     */
    private waitForResume;
    /** resumeStep/resumeAllSteps 成功后唤醒等待 resume 的主循环（无 waiter 时置标志）。 */
    private notifyResume;
    private persistState;
    private emitContained;
    private safeAppend;
    private emitStart;
    private emitStageStart;
    private emitStageCompleted;
    private emitStepStart;
    private emitStepCompleted;
    private emitStepFailed;
    private emitStepPaused;
    private emitStepResumed;
    private emitStepRetried;
    private emitEnd;
    private emitAborted;
    private emitQuestion;
    private emitPermission;
}
//# sourceMappingURL=workflow-engine.d.ts.map