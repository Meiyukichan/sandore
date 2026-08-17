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

import { BranchEvaluator, matchesExpectation } from '@deepseek-ai/dsh-sandore-microflow/src/branch-evaluator';
import type { BranchEvalOptions, BranchEvaluatorConfig } from '@deepseek-ai/dsh-sandore-microflow/src/branch-evaluator';
import { LoopManager } from '@deepseek-ai/dsh-sandore-microflow/src/loop-manager';
import type { LoopState } from '@deepseek-ai/dsh-sandore-microflow/src/loop-manager';

import type { BranchMeta, CommandConfig, DagBranch, WorkflowDefinition, WorkflowStage, WorkflowStep, WorkflowTaskState } from './schema.ts';
import type { StageContract } from './types.ts';

/** 已保存 Stage 契约的运行时形状（与快照 `stageContracts` 值严格一致）。 */
type StageContractValue = WorkflowTaskState['stageContracts'][string];

/** 分离式合并后的完整 Step（顶层定义 + 流控 branches）。 */
export type MergedStepRef = WorkflowStep & { readonly branches?: DagBranch[] | undefined };

/** Stage 与 Step 在 DAG 调度层的统一节点视图（出边统一在 branches）。 */
export interface DagNodeRef {
  readonly kind: 'stage' | 'step';
  /** 所属 Stage（始终可用）。 */
  readonly stage: WorkflowStage;
  /** 仅 kind === 'step' 时存在（合并后的完整 Step）。 */
  readonly step?: MergedStepRef | undefined;
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

/** 去重并保序。 */
function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
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

export class WorkflowDagNavigator {
  private readonly nodeIndex = new Map<string, DagNodeRef>();
  private readonly stageContracts = new Map<string, StageContractValue>();
  private readonly stageOrder: readonly string[];
  private currentStageId: string;
  private readonly evaluator: BranchEvaluator;
  private readonly loopManager: LoopManager;

  constructor(
    private readonly definition: WorkflowDefinition,
    ctx: Context,
    config: BranchEvaluatorConfig,
    loopState: LoopState,
    seed?: DagNavigatorSeed,
  ) {
    this.buildNodeIndex(definition);
    this.stageOrder = definition.stages.map(stage => stage.id);
    // 从快照播种当前 Stage（续跑入口）；缺省回退定义首个 Stage。
    this.currentStageId = seed?.currentStageId ?? this.stageOrder[0] ?? '';
    this.evaluator = new BranchEvaluator(ctx, config);
    this.loopManager = new LoopManager(ctx, config, loopState);
    if (seed?.stageContracts !== undefined) {
      for (const [id, contract] of Object.entries(seed.stageContracts)) {
        this.stageContracts.set(id, contract);
      }
    }
  }

  /** 当前 Stage ID（无 Stage 时为空字符串）。 */
  get currentNodeId(): string {
    return this.currentStageId;
  }

  /** 循环管理器（引擎/执行器共享，用于 ID 后缀与迭代路径）。 */
  get loopManagerInstance(): LoopManager {
    return this.loopManager;
  }

  /** 已完成 Stage 的契约（stageId → StageContract）只读快照。 */
  getStageContracts(): ReadonlyMap<string, StageContractValue> {
    return new Map(this.stageContracts);
  }

  /** 查询单个 Stage 的契约。 */
  getStageContract(stageId: string): StageContractValue | undefined {
    return this.stageContracts.get(stageId);
  }

  /** 聚合前置 Stage 的契约产物（供后续 Stage 引用）。 */
  getContractArtifacts(): Record<string, string[]> {
    const merged: Record<string, string[]> = {};
    for (const contract of this.stageContracts.values()) {
      for (const [name, files] of Object.entries(contract.contractArtifacts)) {
        merged[name] = [...(merged[name] ?? []), ...files];
      }
    }
    return merged;
  }

  /** 保存 Stage 完成契约。 */
  setStageContract(stageId: string, contract: StageContract): void {
    this.stageContracts.set(stageId, contract);
  }

  /** 当前 Stage 是否已全部完成（以已存契约的 completed 状态判定）。 */
  isStageAllDone(stageId: string): boolean {
    return this.stageContracts.get(stageId)?.status === 'completed';
  }

  /**
   * 推进到下一 Stage。
   *
   * 仅在当前 Stage 已完成（`isStageAllDone`）时推进：优先跟随当前 Stage 的
   * `branches`（首个同 Stage 有效目标，通常为串行/并行下一 Stage），否则按定义数组
   * 顺序推断下一 Stage。无下一 Stage 返回 false。
   */
  tryAdvanceStage(): boolean {
    if (!this.isStageAllDone(this.currentStageId)) {
      return false;
    }
    const current = this.nodeIndex.get(this.currentStageId);
    if (current === undefined || current.kind !== 'stage') {
      return false;
    }
    let nextId: string | undefined;
    for (const branch of current.branches ?? []) {
      if (this.nodeIndex.get(branch.next)?.kind === 'stage') {
        nextId = branch.next;
        break;
      }
    }
    if (nextId === undefined) {
      const index = this.stageOrder.indexOf(current.id);
      nextId = index >= 0 ? this.stageOrder[index + 1] : undefined;
    }
    const next = nextId === undefined ? undefined : this.nodeIndex.get(nextId);
    if (next === undefined || next.kind !== 'stage') {
      return false;
    }
    this.currentStageId = next.id;
    return true;
  }

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
  async resolveNextNodes(nodeId: string, context: ResolveNextNodesContext): Promise<ResolveNextNodesResult> {
    const node = this.nodeIndex.get(nodeId);
    if (node === undefined || node.kind !== 'step') {
      return { nextNodeIds: [] };
    }
    const branches = node.branches ?? [];
    if (branches.length === 0) {
      const arrayNext = this.arrayNextStep(node);
      return arrayNext === undefined ? { nextNodeIds: [] } : { nextNodeIds: [arrayNext] };
    }

    const parallel = branches.filter(branch => branch.condition === undefined && branch.loop === undefined);
    const conditional = branches.filter(branch => branch.condition !== undefined && branch.loop === undefined);
    const loopBranches = branches.filter(branch => branch.loop !== undefined);

    const nextNodeIds: string[] = [];
    let branchMeta: BranchMeta | undefined;
    for (const branch of parallel) {
      if (this.sameStageStep(node, branch.next) !== undefined) {
        nextNodeIds.push(branch.next);
      }
    }

    // 条件分支：逐条布尔评估（AI true/false，shell 匹配 breakExpectation）。
    for (const branch of conditional) {
      const result = await this.evaluator.evaluate(branch.condition!, '', this.branchEvalOptions(node, context));
      branchMeta = {
        status: 'completed',
        result: result.output,
        ...(result.sessionHandle === null ? {} : { sessionId: result.sessionHandle }),
      };
      const passed = this.decideCondition(branch.condition!, result.output, branch.label);
      if (passed && this.sameStageStep(node, branch.next) !== undefined) {
        nextNodeIds.push(branch.next);
      }
    }

    // 循环分支：优先处理（命中回边分支 → 循环；否则回边分支不作为前进目标）。
    let loopResult: ResolveNextNodesResult | undefined;
    for (const branch of loopBranches) {
      const loop = branch.loop!;
      if (this.loopManager.activeLoopNodeId === node.id) {
        // 回边：累计访问计数，判定跳出或继续下一迭代。
        const visitCount = (context.visitCounts[node.id] ?? 0) + 1;
        context.visitCounts[node.id] = visitCount;
        const outcome = await this.loopManager.checkLoopBreak(
          { id: node.id, loop },
          visitCount,
          { input: '', output: '', passThroughVars: context.passThroughVars },
        );
        if (outcome.shouldBreak) {
          this.loopManager.popActiveLoop();
          const exitTo = loop.exitTo;
          loopResult = {
            nextNodeIds: exitTo !== undefined && this.sameStageStep(node, exitTo) !== undefined ? [exitTo] : [],
            ...(outcome.loopMeta === undefined ? {} : { loopMeta: outcome.loopMeta }),
          };
          break;
        }
        this.loopManager.incrementLoopIteration();
        const loopTo = loop.next;
        if (loopTo !== undefined && this.sameStageStep(node, loopTo) !== undefined) {
          loopResult = { nextNodeIds: [loopTo] };
          break;
        }
        loopResult = { nextNodeIds: [] };
        break;
      }
      // 首次进入循环：压栈，直接进入回边目标（迭代 1）。
      context.visitCounts[node.id] = 0;
      this.loopManager.pushActiveLoop(node.id, loop.maxIterations);
      const loopTo = loop.next;
      if (loopTo !== undefined && this.sameStageStep(node, loopTo) !== undefined) {
        loopResult = { nextNodeIds: [loopTo] };
        break;
      }
      // 回边目标无效（跨 Stage/缺失）：退出循环。
      this.loopManager.popActiveLoop();
      const exitTo = loop.exitTo;
      loopResult = { nextNodeIds: exitTo !== undefined && this.sameStageStep(node, exitTo) !== undefined ? [exitTo] : [] };
      break;
    }

    // 循环命中时，循环路由优先于前进分支（循环接管本轮调度）。
    if (loopResult !== undefined) {
      return loopResult;
    }

    // 无循环：前进分支 + 数组顺序兜底。
    if (nextNodeIds.length > 0) {
      return { nextNodeIds: dedupe(nextNodeIds), ...(branchMeta === undefined ? {} : { branchMeta }) };
    }
    const arrayNext = this.arrayNextStep(node);
    if (arrayNext !== undefined) {
      nextNodeIds.push(arrayNext);
    }
    return { nextNodeIds: dedupe(nextNodeIds), ...(branchMeta === undefined ? {} : { branchMeta }) };
  }

  /** 按 condition 类型判定条件分支是否通过。 */
  private decideCondition(condition: CommandConfig, output: string, expectation: string | undefined): boolean {
    if (condition.type === 'shell') {
      if (expectation === undefined) {
        return false;
      }
      return matchesExpectation(output.trim(), expectation);
    }
    return output.trim().toLowerCase() === 'true';
  }

  /** 数组顺序的下一 Step（同 Stage 内，线性兜底）。 */
  private arrayNextStep(node: DagNodeRef): string | undefined {
    if (node.kind !== 'step') {
      return undefined;
    }
    const steps = node.stage.steps;
    const index = steps.findIndex(step => step.id === node.id);
    return index < 0 ? undefined : steps[index + 1]?.id;
  }

  /** 组装分支评估选项（候选分支 + 透传变量 + 循环上下文 + 取消信号）。 */
  private branchEvalOptions(node: DagNodeRef, context: ResolveNextNodesContext): BranchEvalOptions {
    const loopContext = this.loopManager.getLoopIterationContext();
    return {
      ...(node.branches === undefined ? {} : { branches: node.branches }),
      passThroughVars: context.passThroughVars,
      loopTurn: loopContext.loopTurn,
      loopMaxIterations: loopContext.loopMaxIterations,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    };
  }

  /** 目标节点是否为同 Stage 内的 Step（跨阶段隔离：跨 Stage 目标返回 undefined）。 */
  private sameStageStep(node: DagNodeRef, targetId: string): DagNodeRef | undefined {
    const target = this.nodeIndex.get(targetId);
    if (target === undefined || target.kind !== 'step') {
      return undefined;
    }
    if (target.stage.id !== node.stage.id) {
      return undefined;
    }
    return target;
  }

  private buildNodeIndex(definition: WorkflowDefinition): void {
    const definitions = new Map((definition.steps ?? []).map(step => [step.id, step] as const));
    for (const stage of definition.stages) {
      this.nodeIndex.set(stage.id, {
        kind: 'stage',
        stage,
        id: stage.id,
        name: stage.name,
        branches: stage.branches,
      });
      for (const step of stage.steps) {
        // 分离式合并：stage.steps 提供 id + 流控（branches），definition.steps 提供完整定义。
        const definitionStep = definitions.get(step.id);
        const merged: MergedStepRef = definitionStep === undefined
          ? step as MergedStepRef
          : { ...definitionStep, ...(step.branches === undefined ? {} : { branches: step.branches }) };
        this.nodeIndex.set(step.id, {
          kind: 'step',
          stage,
          step: merged,
          id: step.id,
          name: merged.name ?? step.id,
          branches: merged.branches,
        });
      }
    }
  }
}
