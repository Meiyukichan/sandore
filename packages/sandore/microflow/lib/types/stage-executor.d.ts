/**
 * Stage 内部执行器（Task 3：`resolveNextNodes` 驱动的 DAG 调度循环）。
 *
 * 以批量工作队列逐节点执行：路由节点（带 `loop`/`branches` 且无 `command`）直接解析
 * 下一批；命令节点经 {@link StepRunner} 执行后经 {@link FinalizeManager} 收尾（透传
 * 变量提取 + 门禁审查），再经 `resolveNextNodes` 解析下一批。循环节点经
 * {@link LoopManager} 生成带后缀 id、`loopIteration` 与 `visitCount`；agent/skill/mcp
 * 的真实子代理 `sessionMeta`（`synthetic:false`）透传到 `ExecutedStepDefault`。
 * 每个 Step 完成后经 `onPersist` 钩子通知引擎逐 Step 持久化。
 * @module @deepseek-ai/dsh-sandore-microflow/src/stage-executor
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ExecutedStepDefault, StageContract, StepStatus } from '@deepseek-ai/dsh-sandore-workflow/src/types';
import type { DagBranch, WorkflowDefinition, WorkflowStage, WorkflowStep, WorkflowTaskState } from '@deepseek-ai/dsh-sandore-workflow/src/schema';
import type { ResolveNextNodesContext, ResolveNextNodesResult } from '@deepseek-ai/dsh-sandore-workflow/src/dag-navigator';
import { FinalizeManager } from './finalize-manager.ts';
import { LoopManager } from './loop-manager.ts';
import type { StepRunnerConfig } from './step-runner.ts';
/** 分离式合并后的完整 Step：完整定义（command/映射等）+ 流控 branches。 */
export type MergedStep = WorkflowStep & {
    readonly branches?: DagBranch[] | undefined;
};
/** Stage 执行输入（原始需求 + 前置契约产物 + 透传变量）。 */
export interface StageExecutionInput {
    readonly originalInput: string;
    readonly contractArtifacts: Record<string, string[]>;
    readonly passThroughVars: WorkflowTaskState['passThroughVars'];
}
/** 透传变量运行时值。 */
export interface PassThroughVarValue {
    value: string;
    description: string;
    refresh?: boolean;
}
/** Stage 共享状态。 */
export interface StageSharedState {
    readonly cwd: string;
    readonly taskId: string;
}
/** Step 生命周期钩子（由引擎注入，用于发射 `sandore/step-*` 事件）。 */
export interface StageStepHooks {
    readonly onStepStart: (step: WorkflowStep, childId: string) => void;
    readonly onStepCompleted: (step: WorkflowStep, childId: string, output: ContentBlock[]) => void;
    readonly onStepFailed: (step: WorkflowStep, childId: string, error: string) => void;
}
/** StageExecutor 构造参数。 */
export interface StageExecutorOptions {
    readonly ctx: Context;
    readonly stageDef: WorkflowStage;
    readonly workflowDef: WorkflowDefinition;
    readonly input: StageExecutionInput;
    readonly sharedState: StageSharedState;
    readonly runnerConfig: StepRunnerConfig;
    readonly signal?: AbortSignal;
    readonly hooks?: StageStepHooks;
    /** 单个 Step 完成/失败后的持久化回调（由引擎注入，逐 Step 持久化状态快照）。 */
    readonly onPersist?: (executedStep: ExecutedStepDefault) => Promise<void> | void;
    /** 循环管理器（引擎共享：ID 后缀 + 迭代路径）。 */
    readonly loopManager: LoopManager;
    /** 收尾管理器（透传变量提取 + 门禁审查）。 */
    readonly finalizeManager: FinalizeManager;
    /** Step 级调度单一入口（由引擎绑定 `WorkflowDagNavigator.resolveNextNodes`）。 */
    readonly resolveNextNodes: (nodeId: string, context: ResolveNextNodesContext) => Promise<ResolveNextNodesResult>;
    /** 节点访问计数（引擎共享，持久化于 `WorkflowTaskState.visitCounts`）。 */
    readonly visitCounts: Record<string, number>;
    /** 崩溃恢复/重试续跑播种：跳过已完成 Step 并从指定子代理 Step 续跑。 */
    readonly resumeFrom?: StageExecutorResume;
}
/** Stage 断点续跑播种（从快照重建执行位置，跳过已完成 Step 并续跑指定子代理 Step）。 */
export interface StageExecutorResume {
    /** 已完成 Step 快照（跳过不重跑，用于重建 previousOutputs 与 executedSteps）。 */
    readonly completedSteps: readonly ExecutedStepDefault[];
    /** 需续跑的子代理 Step（携带原 executed 条目，`finishCommandNode` 原地复用）。 */
    readonly resumeSubagent: {
        readonly step: WorkflowStep;
        readonly executed: ExecutedStepDefault;
        readonly childId: string;
    };
}
/** Stage 执行结果。 */
export interface StageExecutionResult {
    readonly stageContract: StageContract;
    readonly executedSteps: ExecutedStepDefault[];
    readonly passThroughVars: Record<string, PassThroughVarValue>;
    readonly status: StepStatus;
    readonly errorDetail?: string;
}
export declare class StageExecutor {
    private readonly options;
    private readonly runner;
    private runState;
    /** step.id → 真实子代理 SessionId（经 onChildStarted 记录，取消类错误判定暂停用）。 */
    private readonly realChildIds;
    /** 本 Stage 的完整 Step（按 id 合并 stages[].steps 流控 + 顶层 steps 完整定义，含 branches）。 */
    private readonly steps;
    constructor(options: StageExecutorOptions);
    /** 包装 onChildStarted：记录真实 childId（供取消类错误查暂停登记表），再透传原回调。 */
    private trackChildStarted;
    /**
     * 执行本 Stage 内全部 Step（DAG 调度循环）。
     *
     * 首次调用初始化断点续跑状态；ask 中断返回 `interacting` 后，引擎回复用户再次调用
     * 本方法即从断点续跑（重跑门禁 + 推进剩余 Step），直至 completed/failed。
     */
    execute(): Promise<StageExecutionResult>;
    /** 初始化断点续跑状态（首次调用 execute 时）。 */
    private initState;
    /** 组装调度上下文（透传变量字符串映射 + 访问计数 + 取消信号）。 */
    private buildContext;
    /** 主调度循环：逐批推进，遇到 ask/failed 停止（状态保留在 runState 供续跑）。 */
    private runLoop;
    /** 路由节点：resolveNextNodes 产出下一批，分支/循环评估现场回写路由条目。 */
    private processRoutingNode;
    /** 命令节点：run + finalize + resolveNextNodes；ask 中断 / 失败 / 暂停时返回对应标记。 */
    private processCommandNode;
    /**
     * 命令节点执行成功后的公共收尾：回填输出/会话元数据 → 收尾（finalize）→ ask 中断 /
     * 失败 / 推进下一批。首次执行、暂停续跑与崩溃恢复/重试续跑共用：`executed` 仅在尚未
     * 进入 executedSteps 时纳入（按唯一执行 id 去重），暂停续跑已在列表中则原地复用。
     */
    private finishCommandNode;
    /**
     * pause 后从断点续跑：基于被暂停段**新建执行段**（新 id + attemptIndex+1 + createdAt，
     * sessionMeta 保持原 childId）后重新收集子代理输出 + 公共收尾。
     *
     * 段创建权归执行器（§3.5 定夺）：lifecycle 的 resumeStep 只负责 followup/登记表/消息/事件，
     * 新段由这里创建——旧 paused 段保持定格快照，新段以新 id 走 finishCommandNode 追加。
     */
    private resumePendingPaused;
    /** 崩溃恢复/重试续跑：重新收集子代理输出（whenIdle + final output），随后走公共收尾。 */
    private resumePendingResume;
    /** 续跑子代理 Step 的公共尾段：重新收集输出 + 公共收尾（finishCommandNode）。 */
    private resumeSubagentStep;
    /** 取消类错误下，Step 是否命中暂停登记表（真实 childId 已暂停 → 保持 paused）。 */
    private isPausedStep;
    /** ask 回复后从断点续跑：真实子代理先重收集新 output，随后重跑收尾并推进下一批。 */
    private resumePendingAsk;
    /** 组装 Stage 执行结果。 */
    private buildResult;
}
//# sourceMappingURL=stage-executor.d.ts.map