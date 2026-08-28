/**
 * Stage 内 Step 级 DAG 导航器（Task 3：Step 级 DAG 调度，迁自 workflow 的 dag-navigator）。
 *
 * **包职责边界（用户原则）**：Step 生命周期（含路由 resolveNextNodes + 执行 + 判断 + 收尾 +
 * 循环计数）全归 microflow。本模块持有当前 Stage 的 Step 节点索引 `stepIndex`，以
 * `resolveNextNodes()` 作为 Step 级调度单一入口，内部自建 {@link BranchEvaluator}（fork-based
 * 条件评估）+ {@link LoopManager}（循环跳出/计数模型，缺陷 3 不动）承担 Step 级分支/循环路由。
 * 一个 Stage 内部执行（含 Step 路由）自包含在 microflow 完成，才到下一 Stage（Stage→Stage 推进
 * + Stage 级条件评估留 workflow 的 dag-navigator）。
 *
 * 构建 Stage 内 Step 节点索引 `stepIndex`（分离式合并：`stage.steps` 流控位 + 顶层
 * `definition.steps` 完整定义，按 id 交叉引用）。**分支是唯一出边单元**（统一
 * `branches: [{ next, condition?, loop? }]`）：
 * - 并行分支（无 `condition`）始终纳入下一批；
 * - 条件分支（有 `condition`）一次批量评估（fork step 会话注入全量历史，AI 返回
 *   shouldExecute 分支 id 数组，shell 逐条走 `matchesExpectation(label)`）；
 * - 循环分支（有 `loop`，`next` 为回边）命中后经 `checkLoopBreak` 判定跳出（exitTo）或继续下一
 *   迭代。无分支或无命中时按定义数组顺序线性兜底；跨 Stage 目标不在此路由（交由引擎
 *   `tryAdvanceStage` 跨阶段推进）。`branchMeta` / `loopMeta` 保留评估现场。
 * @module dsh-sandore/microflow/src/step-navigator
 */
import type { Context } from '@deepseek-ai/cordis';

import { BranchEvaluator } from './branch-evaluator.ts';
import type { BranchEvalOptions, BranchEvaluatorConfig } from './branch-evaluator.ts';
import { LoopManager } from './loop-manager.ts';
import type { LoopState } from './loop-manager.ts';

import type { BranchMeta, DagBranch, WorkflowDefinition, WorkflowStage, WorkflowStep } from '../workflow/schema';

/** 分离式合并后的完整 Step（顶层定义 + 流控 branches）。 */
export type MergedStepRef = WorkflowStep & { readonly branches?: DagBranch[] | undefined };

/** Step 节点视图（出边统一在 branches；同 Stage 内节点，跨 Stage 目标不在此索引）。 */
export interface StepNodeRef {
  /** 所属 Stage（始终可用，供数组顺序兜底与同 Stage 判定）。 */
  readonly stage: WorkflowStage;
  /** 合并后的完整 Step。 */
  readonly step: MergedStepRef;
  readonly id: string;
  readonly name: string;
  readonly branches?: DagBranch[] | undefined;
}

/** `resolveNextNodes` 的调度上下文（由 StageExecutor.buildContext 注入的共享状态）。 */
export interface ResolveNextNodesContext {
  /** 节点访问计数（循环节点记为回边次数，初始 0）。 */
  readonly visitCounts: Record<string, number>;
  /** 已解析的透传变量（`${xxx}` → 值）。 */
  readonly passThroughVars: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /**
   * 当前 step 的子代理会话 ID（fork-based 判断：缺陷 2/4 改造）。
   *
   * 由 `stage-executor.buildContext` 从最近命令节点的 `sessionMeta.childId`
   * （`synthetic === false` 真实子代理会话）取。条件分支 `evaluateConditions` 与
   * 循环跳出 `checkLoopBreak` 消费：fork 此会话注入全量历史，AI 在 fork 会话上跑判断
   * 即可见全部 I/O。合成 session（prompt/shell）或无已执行命令节点时为 undefined
   * （判断降级为临时会话）。
   */
  readonly recentStepSessionId?: string;
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
 * Stage 内 Step 级 DAG 导航器。
 *
 * 持有当前 Stage 的 `stepIndex`（stepId → 节点视图）、内置 {@link BranchEvaluator}/
 * {@link LoopManager} 承担 Step 级分支/循环路由。循环节点 ID 后缀、迭代路径经
 * {@link StepNavigator.loopManagerInstance} 暴露给 StageExecutor/引擎共享。
 */
export class StepNavigator {
  private readonly stepIndex = new Map<string, StepNodeRef>();
  private readonly evaluator: BranchEvaluator;
  private readonly loopManager: LoopManager;

  constructor(
    private readonly ctx: Context,
    config: BranchEvaluatorConfig,
    loopState: LoopState,
    stage: WorkflowStage,
    workflowDef: WorkflowDefinition,
  ) {
    this.buildStepIndex(stage, workflowDef);
    this.evaluator = new BranchEvaluator(ctx, config);
    this.loopManager = new LoopManager(ctx, config, loopState);
  }

  /** 循环管理器（StageExecutor/引擎共享，用于 ID 后缀与迭代路径）。 */
  get loopManagerInstance(): LoopManager {
    return this.loopManager;
  }

  /**
   * Step 级调度单一入口。
   *
   * 统一分支路由（branches 是唯一出边单元）：
   * ① 并行分支（无 condition）始终纳入下一批（多条并发）；
   * ② 条件分支（有 condition）一次批量评估（AI 返回 shouldExecute 分支 id 数组；
   *    shell 走 `matchesExpectation(label)`），命中纳入；
   * ③ 循环分支（有 loop，next 为回边）：**首入与回边都调 `checkLoopBreak`**（只读
   *    visitCount，递增已由 `runLoop` 在处理节点前完成，等价基准 `processNode`
   *    L93-94 + L164）；跳出走 `exitTo`（先 `resetLoopVisitCounts`+`popActiveLoop`），
   *    继续回 `loop.next`（同循环 `incrementLoopIteration` / 首入 `pushActiveLoop`）；
   * ④ 无任何命中时按定义数组顺序线性兜底；无 Step 级目标返回空
   *    （由引擎 `tryAdvanceStage` 跨阶段推进）。
   */
  async resolveNextNodes(nodeId: string, context: ResolveNextNodesContext): Promise<ResolveNextNodesResult> {
    const node = this.stepIndex.get(nodeId);
    if (node === undefined) {
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

    // 条件分支：一次批量评估（Round 20 批量模板——AI 一次 fork 返回 shouldExecute 分支
    // id 数组，shell 逐条匹配 label）。branchMeta 只写一次（修复多条件分支覆盖 bug：
    // 旧逐条循环里 branchMeta 被最后一条覆盖，只保留最后一个分支的评估现场）。
    if (conditional.length > 0) {
      const { result, passedBranchIds } = await this.evaluator.evaluateConditions(
        conditional.map(b => ({ branch: b, condition: b.condition! })),
        this.branchEvalOptions(node, context),
      );
      branchMeta = {
        status: 'completed',
        result: result.output,
        ...(result.sessionHandle === null ? {} : { sessionId: result.sessionHandle }),
      };
      for (const nextId of passedBranchIds) {
        if (this.sameStageStep(node, nextId) !== undefined) nextNodeIds.push(nextId);
      }
    }

    // 循环分支：对齐基准模型——checkLoopBreak 总是调（只读 visitCount，不递增，
    // 递增已由 runLoop 在处理节点前完成，等价基准 processNode L93-94 + L164 总调）。
    // 跳出时 resetLoopVisitCounts（归零该循环作用域）+ popActiveLoop + exitTo
    // （仅当已在该循环回边时；首入即跳出无栈可弹）；继续时同循环 incrementLoopIteration、
    // 首入/嵌套 pushActiveLoop。
    let loopResult: ResolveNextNodesResult | undefined;
    for (const branch of loopBranches) {
      const loop = branch.loop!;
      const wasInThisLoop = this.loopManager.activeLoopNodeId === node.id;
      // checkLoopBreak 只读 visitCount（不递增），根治命令门双重计数（缺陷 3 case ①）。
      const visitCount = context.visitCounts[node.id] ?? 0;
      // 缺陷 4（fork-based 改造）：传入当前 step 会话 id，checkLoopBreak fork 注入全量历史
      // （不手动传 I/O 文本——fork 会话携带循环体全部 I/O，AI 在 fork 会话上跑判断即可见）。
      const outcome = await this.loopManager.checkLoopBreak(
        { id: node.id, loop },
        visitCount,
        {
          ...(context.recentStepSessionId === undefined ? {} : { stepSessionId: context.recentStepSessionId }),
          stepId: node.id,
          passThroughVars: context.passThroughVars,
        },
      );
      if (outcome.shouldBreak) {
        // 跳出：仅已在该循环（回边）才归零作用域 + 弹栈（首入即跳出无栈可弹）。
        // 归零作用域推翻缺陷 22 的「进入时归零」，改用基准「跳出时归零」语义。
        if (wasInThisLoop) {
          this.loopManager.resetLoopVisitCounts(context.visitCounts);
          this.loopManager.popActiveLoop();
        }
        const exitTo = loop.exitTo;
        loopResult = {
          nextNodeIds: exitTo !== undefined && this.sameStageStep(node, exitTo) !== undefined ? [exitTo] : [],
          ...(outcome.loopMeta === undefined ? {} : { loopMeta: outcome.loopMeta }),
        };
        break;
      }
      // 继续：同循环 incrementLoopIteration；首入或嵌套 pushActiveLoop。
      if (wasInThisLoop) {
        this.loopManager.incrementLoopIteration();
      } else {
        this.loopManager.pushActiveLoop(node.id, loop.maxIterations);
      }
      const loopTo = loop.next;
      if (loopTo !== undefined && this.sameStageStep(node, loopTo) !== undefined) {
        // 缺陷 23：continue 分支同样透传 outcome.loopMeta（checkLoopBreak 在 shouldBreak=false
        // 时也产出 loopMeta(completed)，loop-manager.spec L174-175 实证）。修复前仅 break
        // 分支透传，导致每次「继续」迭代的 breakCondition 评估现场静默丢失（审计/可观测性缺口）。
        // 不改计数语义：visitCount 递增仍由 runLoop 单一完成（缺陷 3 已重构），路由条目仅
        // 快照当前值——continue 透传不引入双重计数。
        loopResult = {
          nextNodeIds: [loopTo],
          ...(outcome.loopMeta === undefined ? {} : { loopMeta: outcome.loopMeta }),
        };
        break;
      }
      // 回边目标无效（跨 Stage/缺失）：回滚刚压栈后退出（仅 !wasInThisLoop 时刚 push）。
      if (!wasInThisLoop) {
        this.loopManager.resetLoopVisitCounts(context.visitCounts);
        this.loopManager.popActiveLoop();
      }
      const exitTo = loop.exitTo;
      // 缺陷 23：continue 分支回边目标无效的回滚路径同样透传 loopMeta（评估已完成）。
      loopResult = {
        nextNodeIds: exitTo !== undefined && this.sameStageStep(node, exitTo) !== undefined ? [exitTo] : [],
        ...(outcome.loopMeta === undefined ? {} : { loopMeta: outcome.loopMeta }),
      };
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

  /** 数组顺序的下一 Step（同 Stage 内，线性兜底）。 */
  private arrayNextStep(node: StepNodeRef): string | undefined {
    const steps = node.stage.steps;
    const index = steps.findIndex(step => step.id === node.id);
    return index < 0 ? undefined : steps[index + 1]?.id;
  }

  /** 组装分支评估选项（候选分支 + 透传变量 + 循环上下文 + fork 源会话 + stepId + 取消信号）。 */
  private branchEvalOptions(node: StepNodeRef, context: ResolveNextNodesContext): BranchEvalOptions {
    const loopContext = this.loopManager.getLoopIterationContext();
    return {
      ...(node.branches === undefined ? {} : { branches: node.branches }),
      passThroughVars: context.passThroughVars,
      loopTurn: loopContext.loopTurn,
      loopMaxIterations: loopContext.loopMaxIterations,
      ...(context.recentStepSessionId === undefined ? {} : { stepSessionId: context.recentStepSessionId }),
      stepId: node.id,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    };
  }

  /** 目标节点是否为本 Stage 内的 Step（跨 Stage 目标返回 undefined，交由引擎跨阶段推进）。 */
  private sameStageStep(node: StepNodeRef, targetId: string): StepNodeRef | undefined {
    const target = this.stepIndex.get(targetId);
    if (target === undefined) {
      return undefined;
    }
    if (target.stage.id !== node.stage.id) {
      return undefined;
    }
    return target;
  }

  /**
   * 构建当前 Stage 的 Step 节点索引（分离式合并）。
   *
   * `stage.steps` 提供流控位（id + branches），`workflowDef.steps` 提供完整定义
   * （command/映射/gates 等），按 id 合并成执行用的完整 Step。
   */
  private buildStepIndex(stage: WorkflowStage, workflowDef: WorkflowDefinition): void {
    const definitions = new Map((workflowDef.steps ?? []).map(step => [step.id, step] as const));
    for (const flowStep of stage.steps) {
      const definitionStep = definitions.get(flowStep.id);
      const merged: MergedStepRef = definitionStep === undefined
        ? flowStep as MergedStepRef
        : { ...definitionStep, ...(flowStep.branches === undefined ? {} : { branches: flowStep.branches }) };
      this.stepIndex.set(flowStep.id, {
        stage,
        step: merged,
        id: flowStep.id,
        name: merged.name ?? flowStep.id,
        branches: merged.branches,
      });
    }
  }
}
