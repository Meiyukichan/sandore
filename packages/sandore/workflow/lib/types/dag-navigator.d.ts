/**
 * 工作流 DAG 导航器（Task 3：Step 级 DAG 调度）。
 *
 * 构建 Stage/Step 统一节点索引 `nodeIndex`，`resolveNextNodes()` 作为 Step 级调度
 * 单一入口。**分支是唯一出边单元**（统一 `branches: [{ next, condition?, loop? }]`）：
 * 并行分支（无 `condition`）始终纳入下一批；条件分支（有 `condition`）逐条布尔评估
 * （AI 输出 true/false，shell 走 `matchesExpectation(breakExpectation)`）；循环分支
 * （有 `loop`，`next` 为回边）命中后经 `checkLoopBreak` 判定跳出（exitTo）或继续下一
 * 迭代。无分支或无命中时按定义数组顺序线性兜底；Stage 完成由 `tryAdvanceStage`
 * （数组顺序推断）推进。`branchMeta` / `loopMeta` 保留评估现场。
 * @module @deepseek-ai/dsh-sandore-workflow/src/dag-navigator
 */
import type { Context } from '@deepseek-ai/cordis';
import type { BranchEvaluatorConfig } from '@deepseek-ai/dsh-sandore-microflow/src/branch-evaluator';
import { LoopManager } from '@deepseek-ai/dsh-sandore-microflow/src/loop-manager';
import type { LoopState } from '@deepseek-ai/dsh-sandore-microflow/src/loop-manager';
import type { BranchMeta, DagBranch, WorkflowDefinition, WorkflowStage, WorkflowStep, WorkflowTaskState } from './schema.ts';
import type { StageContract } from './types.ts';
/** 已保存 Stage 契约的运行时形状（与快照 `stageContracts` 值严格一致）。 */
type StageContractValue = WorkflowTaskState['stageContracts'][string];
/** Stage 与 Step 在 DAG 调度层的统一节点视图（出边统一在 branches）。 */
export interface DagNodeRef {
    readonly kind: 'stage' | 'step';
    /** 所属 Stage（始终可用）。 */
    readonly stage: WorkflowStage;
    /** 仅 kind === 'step' 时存在。 */
    readonly step?: WorkflowStep | undefined;
    readonly id: string;
    readonly name: string;
    readonly branches?: DagBranch[] | undefined;
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
     * 仅在当前 Stage 已完成（`isStageAllDone`）时推进：优先跟随当前 Stage 的
     * `branches`（首个同 Stage 有效目标，通常为串行/并行下一 Stage），否则按定义数组
     * 顺序推断下一 Stage。无下一 Stage 返回 false。
     */
    tryAdvanceStage(): boolean;
    /**
     * Step 级调度单一入口。
     *
     * 统一分支路由（branches 是唯一出边单元）：
     * ① 并行分支（无 condition）始终纳入下一批（多条并发）；
     * ② 条件分支（有 condition）逐条布尔评估（AI 输出 true/false；shell 走
     *    `matchesExpectation(breakExpectation)`），true 纳入；
     * ③ 循环分支（有 loop，next 为回边）：命中后经 `checkLoopBreak` 判定跳出
     *    （走 `exitTo`）或继续下一迭代（回 `loop.next`）；
     * ④ 无任何命中时按定义数组顺序线性兜底；无 Step 级目标返回空
     *    （由引擎 `tryAdvanceStage` 跨阶段推进）。
     */
    resolveNextNodes(nodeId: string, context: ResolveNextNodesContext): Promise<ResolveNextNodesResult>;
    /** 按 condition 类型判定条件分支是否通过。 */
    private decideCondition;
    /** 数组顺序的下一 Step（同 Stage 内，线性兜底）。 */
    private arrayNextStep;
    /** 组装分支评估选项（候选分支 + 透传变量 + 循环上下文 + 取消信号）。 */
    private branchEvalOptions;
    /** 目标节点是否为同 Stage 内的 Step（跨阶段隔离：跨 Stage 目标返回 undefined）。 */
    private sameStageStep;
    private buildNodeIndex;
}
export {};
//# sourceMappingURL=dag-navigator.d.ts.map