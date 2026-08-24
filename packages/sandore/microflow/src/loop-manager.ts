/**
 * 循环与嵌套循环管理（loop-manager）。
 *
 * 维护活跃循环节点栈与嵌套迭代路径栈（`activeLoopStack`/`activeLoopIterationStack`，
 * 对齐 `WorkflowTaskState` 持久化字段），为循环内每次迭代生成 4 位 hex 后缀 id
 * （`getActualStepId`/`stripIdSuffix`/`stepIdSuffixMap`），构建扁平
 * `loopIteration` 嵌套数组（`buildLoopIterationPath`），并以 `checkLoopBreak` 两阶段
 * 判定循环跳出（`visitCount >= maxIterations` 硬上限优先，其次 `breakCondition`
 * agent/prompt/skill/mcp 走 `extractBreakResult === 'true'`、shell 走
 * `matchesExpectation`），同时写入 `loopMeta`（evaluating → completed）。迭代上下文
 * （`in-loop-turn`/`all-loop-turn`）经 `getLoopIterationContext` 供 env 注入与变量替换。
 * @module @deepseek-ai/dsh-sandore-microflow/src/loop-manager
 */
import type { Context } from '@deepseek-ai/cordis';

import { BranchEvaluator, extractBreakResult, matchesExpectation } from './branch-evaluator.ts';
import type { BranchEvaluatorConfig } from './branch-evaluator.ts';
import type { BranchMeta, CommandConfig, DagLoop } from '@deepseek-ai/dsh-sandore-workflow/src/schema';

/** LoopManager 的引擎级配置（与 BranchEvaluator 共用）。 */
export type LoopManagerConfig = BranchEvaluatorConfig;

/** LoopManager 持有的循环持久化状态（WorkflowTaskState 字段的子集）。 */
export interface LoopState {
  readonly activeLoopStack: string[];
  readonly activeLoopIterationStack: number[];
}

/** 循环节点最小视图（含 `loop` 控制的 Step/Stage 节点）。 */
export interface LoopNode {
  readonly id: string;
  readonly loop?: DagLoop | undefined;
}

/**
 * checkLoopBreak 的 Phase D 路由评估选项（fork 子代理机制）。
 *
 * 循环跳出判断走 fork 子代理机制（`BranchEvaluator.evaluateBreak` 内
 * `forkStepSubagent`：live → persistence 回退取 step 会话完整事件、`agents.create`
 * 重建宿主子代理），AI 在重建的 fork 会话上即可见循环体全部 I/O，无需调用方手动拼装
 * input/output/artifacts 块（推翻原 `buildBreakContextMessage`/`buildLoopBreakContext`
 * 的 I/O 传参方案）。
 */
export interface LoopBreakOptions {
  /** 当前 step 的子代理会话 ID（fork 子代理 seed 源）。 */
  readonly stepSessionId?: string;
  /** 当前循环节点 id（路由 fork 子代理合成 id 前缀）。 */
  readonly stepId?: string;
  /** 透传变量（shell breakCondition env 注入 + 提示词 `${xxx}` 替换）。 */
  readonly passThroughVars?: Readonly<Record<string, string>>;
}

/** checkLoopBreak 的跳出判定结果。 */
export interface LoopBreakOutcome {
  readonly shouldBreak: boolean;
  /** breakCondition 评估完成后的元数据（硬上限命中或未评估时为 undefined）。 */
  readonly loopMeta?: BranchMeta;
}

/**
 * 循环与嵌套循环管理器。
 *
 * 构造时绑定 `ctx`、引擎级配置与循环持久化状态（`activeLoopStack`/
 * `activeLoopIterationStack`），内部自建 {@link BranchEvaluator} 承担 breakCondition
 * 两阶段评估。`loopMaxIterations` 栈与 `stepIdSuffixMap` 为进程内辅助状态（不持久化）。
 */
export class LoopManager {
  /** 原始 step id → 4 位 hex 后缀（同一次迭代内同一原始 id 复用同一后缀）。 */
  readonly stepIdSuffixMap = new Map<string, string>();

  private readonly loopMaxIterationsStack: number[] = [];
  /**
   * 与 `activeLoopStack` 并行的循环作用域节点集栈：记录每个活跃循环执行期间被
   * `runLoop` 计数的节点 id。内层节点同时记入所有外层作用域集（内层节点也属于外层
   * 循环）。跳出时 `resetLoopVisitCounts` 归零栈顶集内所有节点 visitCount（等价基准
   * `workflow-loop-manager.ts:resetLoopVisitCounts` 的「跳出时归零」语义，取代缺陷 22
   * 的「进入时归零」）。运行时不持久化（与 stepIdSuffixMap/loopMaxIterationsStack 同）。
   */
  private readonly loopScopeStack: Set<string>[] = [];
  private readonly evaluator: BranchEvaluator;

  constructor(
    ctx: Context,
    config: LoopManagerConfig,
    private readonly state: LoopState,
  ) {
    this.evaluator = new BranchEvaluator(ctx, config);
  }

  /** 栈顶活跃循环节点 ID（无活跃循环为 null）。 */
  get activeLoopNodeId(): string | null {
    return this.state.activeLoopStack[this.state.activeLoopStack.length - 1] ?? null;
  }

  /** 生成 4 位 hex 后缀（小写 0-9a-f）。 */
  static loopIdSuffix(): string {
    return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 4);
  }

  /** 返回循环内实际执行的带后缀 id（`原始id-4位hex`）；同迭代同原始 id 复用同后缀。 */
  getActualStepId(originalStepId: string): string {
    const existing = this.stepIdSuffixMap.get(originalStepId);
    if (existing !== undefined) {
      return `${originalStepId}-${existing}`;
    }
    const suffix = LoopManager.loopIdSuffix();
    this.stepIdSuffixMap.set(originalStepId, suffix);
    return `${originalStepId}-${suffix}`;
  }

  /** 去除循环后缀还原原始 id（非本迭代生成的后缀原样返回）。 */
  stripIdSuffix(id: string): string {
    for (const [original, suffix] of this.stepIdSuffixMap) {
      if (id === `${original}-${suffix}`) {
        return original;
      }
    }
    return id;
  }

  /** 构建当前嵌套迭代路径（如 `[1, 2]`），无活跃循环返回空数组。 */
  buildLoopIterationPath(): number[] {
    return [...this.state.activeLoopIterationStack];
  }

  /** 递增最内层迭代计数，并清除本迭代的后缀映射（新迭代生成新后缀）。 */
  incrementLoopIteration(): void {
    const last = this.state.activeLoopIterationStack.length - 1;
    if (last >= 0) {
      this.state.activeLoopIterationStack[last] = (this.state.activeLoopIterationStack[last] ?? 0) + 1;
    }
    this.stepIdSuffixMap.clear();
  }

  /** 进入循环：压循环栈 + 迭代栈（初始计数 1）+ maxIterations 栈 + 作用域集，并清除后缀映射。 */
  pushActiveLoop(nodeId: string, maxIterations: number): void {
    this.state.activeLoopStack.push(nodeId);
    this.state.activeLoopIterationStack.push(1);
    this.loopMaxIterationsStack.push(maxIterations);
    this.loopScopeStack.push(new Set<string>());
    this.stepIdSuffixMap.clear();
  }

  /** 跳出循环：先弹迭代栈，再弹循环栈（含 maxIterations 栈与作用域集）。 */
  popActiveLoop(): void {
    this.state.activeLoopIterationStack.pop();
    this.state.activeLoopStack.pop();
    this.loopMaxIterationsStack.pop();
    this.loopScopeStack.pop();
  }

  /**
   * 记录循环作用域内被计数的节点（由 `runLoop` 在递增 visitCount 后调用）。
   *
   * 节点同时记入所有活跃作用域集——内层循环节点也属于所有外层循环作用域，
   * 保证外层跳出时也归零内层节点（等价基准按 loopIteration 前缀归零的语义）。
   * 无活跃循环时为空操作。
   */
  recordScopeVisit(nodeId: string): void {
    if (this.loopScopeStack.length === 0) {
      return;
    }
    for (const scope of this.loopScopeStack) {
      scope.add(nodeId);
    }
  }

  /**
   * 归零栈顶循环作用域内所有节点的 visitCount（等价基准
   * `workflow-loop-manager.ts:resetLoopVisitCounts` 的「跳出时归零」语义）。
   *
   * 在 `popActiveLoop` 之前调用：栈顶作用域集仍存在，遍历其中所有节点 id 把
   * visitCount 归零，使外层重入该循环时各节点从 0 起重新计数。无活跃循环时为空操作。
   */
  resetLoopVisitCounts(visitCounts: Record<string, number>): void {
    const scope = this.loopScopeStack[this.loopScopeStack.length - 1];
    if (scope === undefined) {
      return;
    }
    for (const id of scope) {
      visitCounts[id] = 0;
    }
  }

  /** 返回当前循环迭代上下文（`loopTurn`/`loopMaxIterations`；非循环时均为 0）。 */
  getLoopIterationContext(): { loopTurn: number; loopMaxIterations: number } {
    const loopTurn = this.state.activeLoopIterationStack[this.state.activeLoopIterationStack.length - 1] ?? 0;
    const loopMaxIterations = this.loopMaxIterationsStack[this.loopMaxIterationsStack.length - 1] ?? 0;
    return { loopTurn, loopMaxIterations };
  }

  /**
   * 判定循环是否跳出（**只读** visitCount，不递增——递增由 `runLoop` 在处理节点前完成，
   * 等价基准 `processNode` L93-94 单一递增点 + `checkLoopBreak` L170 只读）。
   *
   * ① `visitCount >= maxIterations` 硬上限立即返回 true（不发 AI 评估）；② 配置
   * `breakCondition` 时两阶段评估：agent/prompt/skill/mcp 走 `extractBreakResult
   * === 'true'`，shell 走 `matchesExpectation(breakResult, breakExpectation)`；评估完成
   * 写入 `loopMeta`（`evaluating` → `completed`，含评估结果与期望）。
   */
  async checkLoopBreak(node: LoopNode, visitCount: number, options: LoopBreakOptions = {}): Promise<LoopBreakOutcome> {
    const loop = node.loop;
    if (loop === undefined) {
      return { shouldBreak: false };
    }
    if (visitCount >= loop.maxIterations) {
      return { shouldBreak: true };
    }
    const breakCondition = loop.breakCondition;
    if (breakCondition === undefined) {
      return { shouldBreak: false };
    }
    // 缺陷 4（fork-based 改造）：breakCondition 走 fork step 会话注入全量历史 + 专用 shouldBreak
    // 模板（不手动传 I/O 文本——fork 会话携带循环体全部 I/O，AI 在 fork 会话上跑判断即可见）；
    // decideBreak 的 AI 分支用 extractBreakResult 解析 shouldBreak，与提示词格式对齐。
    const result = await this.evaluator.evaluateBreak(breakCondition, {
      ...(options.stepSessionId === undefined ? {} : { stepSessionId: options.stepSessionId }),
      ...(options.stepId === undefined ? {} : { stepId: options.stepId }),
      loopTurn: this.currentLoopTurn(),
      loopMaxIterations: this.currentLoopMaxIterations(),
      ...(options.passThroughVars === undefined ? {} : { passThroughVars: options.passThroughVars }),
    });
    const loopMeta: BranchMeta = {
      status: 'completed',
      result: result.output,
      ...(result.sessionHandle === null ? {} : { sessionId: result.sessionHandle }),
      ...(loop.breakExpectation === undefined ? {} : { expectation: loop.breakExpectation }),
    };
    return {
      shouldBreak: this.decideBreak(breakCondition, result.output, loop.breakExpectation),
      loopMeta,
    };
  }

  /** 当前最内层循环迭代序号（无活跃循环 0）。 */
  private currentLoopTurn(): number {
    return this.state.activeLoopIterationStack[this.state.activeLoopIterationStack.length - 1] ?? 0;
  }

  /** 当前最内层循环 maxIterations（无活跃循环 0）。 */
  private currentLoopMaxIterations(): number {
    return this.loopMaxIterationsStack[this.loopMaxIterationsStack.length - 1] ?? 0;
  }

  /** 按 breakCondition 类型判定是否跳出。 */
  private decideBreak(condition: CommandConfig, output: string, breakExpectation: string | undefined): boolean {
    if (condition.type === 'shell') {
      if (breakExpectation === undefined) {
        return false;
      }
      return matchesExpectation(output.trim(), breakExpectation);
    }
    return extractBreakResult(output) === 'true';
  }
}
