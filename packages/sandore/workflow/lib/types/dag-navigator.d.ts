/**
 * 工作流 DAG 导航器（Task 3：Step 级 DAG 调度）。
 *
 * 构建 Stage/Step 统一节点索引 `nodeIndex`，`resolveNextNodes()` 作为 Step 级调度
 * 单一入口（优先级 Loop > Branches > Next > `tryAdvanceStage`，跨阶段隔离），
 * `tryAdvanceStage()` 在当前 Stage 完成后跟随 `Stage.next`（无 `next` 时按定义数组
 * 顺序推断下一 Stage）。循环路由（loopTo / checkLoopBreak）与分支路由（匹配 /
 * 并行 / 回退）均在此收敛，`branchMeta` / `loopMeta` 保留评估现场。
 * @module @deepseek-ai/dsh-sandore-workflow/src/dag-navigator
 */
import type { Context } from '@deepseek-ai/cordis';
import type { BranchEvaluatorConfig } from '@deepseek-ai/dsh-sandore-microflow/src/branch-evaluator';
import { LoopManager } from '@deepseek-ai/dsh-sandore-microflow/src/loop-manager';
import type { LoopState } from '@deepseek-ai/dsh-sandore-microflow/src/loop-manager';
import type { BranchMeta, CommandConfig, DagBranch, DagLoop, WorkflowDefinition, WorkflowStage, WorkflowStep, WorkflowTaskState } from './schema.ts';
import type { StageContract } from './types.ts';
/** 已保存 Stage 契约的运行时形状（与快照 `stageContracts` 值严格一致）。 */
type StageContractValue = WorkflowTaskState['stageContracts'][string];
/** Stage 与 Step 在 DAG 调度层的统一节点视图。 */
export interface DagNodeRef {
    readonly kind: 'stage' | 'step';
    /** 所属 Stage（始终可用）。 */
    readonly stage: WorkflowStage;
    /** 仅 kind === 'step' 时存在。 */
    readonly step?: WorkflowStep | undefined;
    readonly id: string;
    readonly name: string;
    readonly next?: string | undefined;
    readonly condition?: CommandConfig | undefined;
    readonly branches?: DagBranch[] | undefined;
    readonly loop?: DagLoop | undefined;
}
/** `resolveNextNodes` 的调度上下文（由引擎注入的共享状态）。 */
export interface ResolveNextNodesContext {
    /** 节点访问计数（循环节点记为回边次数，初始 0）。 */
    readonly visitCounts: Record<string, number>;
    /** 已解析的透传变量（`${xxx}` → 值）。 */
    readonly passThroughVars: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
}
/** `resolveNextNodes` 的返回：下一批节点 ID 与评估现场。 */
export interface ResolveNextNodesResult {
    readonly nextNodeIds: string[];
    readonly branchMeta?: BranchMeta;
    readonly loopMeta?: BranchMeta;
}
/**
 * 工作流 DAG 导航器。
 *
 * 保存 `nodeIndex`（nodeId → 统一节点视图）、`stageContracts`（已完成 Stage 契约）、
 * 当前 Stage 指针，并内置 `BranchEvaluator`/`LoopManager` 承担 Step 级分支/循环路由。
 */
/** 导航器初始化播种（崩溃恢复/重试续跑时从快照重建执行位置）。 */
export interface DagNavigatorSeed {
    /** 起始 Stage（从快照 `currentStageId` 播种，缺省为定义首个 Stage）。 */
    readonly currentStageId?: string;
    /** 已完成 Stage 契约（从快照 `stageContracts` 播种）。 */
    readonly stageContracts?: Readonly<Record<string, StageContractValue>>;
}
export declare class WorkflowDagNavigator {
    private readonly definition;
    private readonly nodeIndex;
    private readonly stageContracts;
    private readonly stageOrder;
    private currentStageId;
    private readonly evaluator;
    private readonly loopManager;
    constructor(definition: WorkflowDefinition, ctx: Context, config: BranchEvaluatorConfig, loopState: LoopState, seed?: DagNavigatorSeed);
    /** 当前 Stage ID（无 Stage 时为空字符串）。 */
    get currentNodeId(): string;
    /** 循环管理器（引擎/执行器共享，用于 ID 后缀与迭代路径）。 */
    get loopManagerInstance(): LoopManager;
    /** 已完成 Stage 的契约（stageId → StageContract）只读快照。 */
    getStageContracts(): ReadonlyMap<string, StageContractValue>;
    /** 查询单个 Stage 的契约。 */
    getStageContract(stageId: string): StageContractValue | undefined;
    /** 聚合前置 Stage 的契约产物（供后续 Stage 引用）。 */
    getContractArtifacts(): Record<string, string[]>;
    /** 保存 Stage 完成契约。 */
    setStageContract(stageId: string, contract: StageContract): void;
    /** 当前 Stage 是否已全部完成（以已存契约的 completed 状态判定）。 */
    isStageAllDone(stageId: string): boolean;
    /**
     * 推进到下一 Stage。
     *
     * 仅在当前 Stage 已完成（`isStageAllDone`）时推进：优先跟随当前 Stage 的 `next`，
     * 否则按定义数组顺序推断下一 Stage。无下一 Stage 返回 false。
     */
    tryAdvanceStage(): boolean;
    /**
     * Step 级调度单一入口。
     *
     * 按优先级解析下一批节点：① Loop（`loop.next` > 分支评估 > `node.next`，仅同阶段，
     * 回边经 `checkLoopBreak` 判定跳出/继续）；② Branches（评估 `condition` 路由到
     * expectation 匹配分支，无 expectation 的并行分支始终纳入，无匹配回退 `node.next`）；
     * ③ Next（同阶段）；④ 无 Step 级目标返回空（由引擎 `tryAdvanceStage` 跨阶段推进）。
     */
    resolveNextNodes(nodeId: string, context: ResolveNextNodesContext): Promise<ResolveNextNodesResult>;
    /** 循环路由：首次进入压栈，回边经 checkLoopBreak 判定跳出（exitTo）或继续（loopTo）。 */
    private resolveLoop;
    /** 分支路由：匹配 expectation 的分支 + 并行分支（无 expectation）入下一批。 */
    private resolveBranches;
    /** 循环内跳转目标：`loop.next` > 分支评估 > `node.next`（均限同 Stage）。 */
    private resolveLoopTo;
    /** 循环节点带 condition/branches 时用分支评估结果确定 loopTo（首个匹配分支）。 */
    private evaluateLoopBranch;
    /** 循环跳出目标：`exitTo`（限同 Stage）否则空（由 tryAdvanceStage 推进）。 */
    private exitLoopIds;
    /** 无匹配时的 Step 级回退（node.next 优先，回退数组顺序下一 Step，均限同 Stage）。 */
    private pushFallthrough;
    /** 数组顺序的下一 Step（同 Stage 内，线性兜底）。 */
    private arrayNextStep;
    /** 匹配 expectation 的带 expectation 分支。 */
    private matchBranches;
    /** 组装分支评估选项（候选分支 + 透传变量 + 循环上下文 + 取消信号）。 */
    private branchEvalOptions;
    /** 目标节点是否为同 Stage 内的 Step（跨阶段隔离：跨 Stage 目标返回 undefined）。 */
    private sameStageStep;
    private buildNodeIndex;
}
export {};
//# sourceMappingURL=dag-navigator.d.ts.map