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
import type { BranchMeta, CommandConfig, DagLoop } from '../../workflow/src/schema.ts';

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

/** checkLoopBreak 评估上下文（注入 `<input>`/`<output>`/`<artifacts>` 块）。 */
export interface LoopBreakContext {
  readonly input: string;
  readonly output: string;
  readonly artifacts?: readonly string[];
  readonly passThroughVars?: Readonly<Record<string, string>>;
}

/** checkLoopBreak 的跳出判定结果。 */
export interface LoopBreakOutcome {
  readonly shouldBreak: boolean;
  /** breakCondition 评估完成后的元数据（硬上限命中或未评估时为 undefined）。 */
  readonly loopMeta?: BranchMeta;
}

/** 循环跳出评估上下文：`<output>` 截前 4000 字符、每行缩进 4 格。 */
const BREAK_OUTPUT_MAX = 4000;

/** 按 4 空格缩进多行文本。 */
function indentBlock(text: string): string[] {
  return text.split('\n').map(line => `    ${line}`);
}

/** 截取文本前 `maxLength` 个字符。 */
function truncateText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

/** 构建循环跳出评估上下文（`<input>`/`<output>`/`<artifacts>` XML 块）。 */
function buildBreakContextMessage(context: LoopBreakContext | undefined): string {
  if (context === undefined) {
    return '';
  }
  const lines: string[] = ['<input>'];
  lines.push(...indentBlock(context.input));
  lines.push('</input>');
  lines.push('<output>');
  lines.push(...indentBlock(truncateText(context.output, BREAK_OUTPUT_MAX)));
  lines.push('</output>');
  lines.push('<artifacts>');
  for (const artifact of context.artifacts ?? []) {
    lines.push(`    - ${artifact}`);
  }
  lines.push('</artifacts>');
  return lines.join('\n');
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

  /** 进入循环：压循环栈 + 迭代栈（初始计数 1）+ maxIterations 栈，并清除后缀映射。 */
  pushActiveLoop(nodeId: string, maxIterations: number): void {
    this.state.activeLoopStack.push(nodeId);
    this.state.activeLoopIterationStack.push(1);
    this.loopMaxIterationsStack.push(maxIterations);
    this.stepIdSuffixMap.clear();
  }

  /** 跳出循环：先弹迭代栈，再弹循环栈（含 maxIterations 栈）。 */
  popActiveLoop(): void {
    this.state.activeLoopIterationStack.pop();
    this.state.activeLoopStack.pop();
    this.loopMaxIterationsStack.pop();
  }

  /** 返回当前循环迭代上下文（`loopTurn`/`loopMaxIterations`；非循环时均为 0）。 */
  getLoopIterationContext(): { loopTurn: number; loopMaxIterations: number } {
    const loopTurn = this.state.activeLoopIterationStack[this.state.activeLoopIterationStack.length - 1] ?? 0;
    const loopMaxIterations = this.loopMaxIterationsStack[this.loopMaxIterationsStack.length - 1] ?? 0;
    return { loopTurn, loopMaxIterations };
  }

  /**
   * 判定循环是否跳出。
   *
   * ① `visitCount >= maxIterations` 硬上限立即返回 true（不发 AI 评估）；② 配置
   * `breakCondition` 时两阶段评估：agent/prompt/skill/mcp 走 `extractBreakResult
   * === 'true'`，shell 走 `matchesExpectation(breakResult, breakExpectation)`；评估完成
   * 写入 `loopMeta`（`evaluating` → `completed`，含评估结果与期望）。
   */
  async checkLoopBreak(node: LoopNode, visitCount: number, context?: LoopBreakContext): Promise<LoopBreakOutcome> {
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
    const contextMessage = buildBreakContextMessage(context);
    const result = await this.evaluator.evaluate(breakCondition, contextMessage, {
      loopTurn: this.currentLoopTurn(),
      loopMaxIterations: this.currentLoopMaxIterations(),
      ...(context?.passThroughVars === undefined ? {} : { passThroughVars: context.passThroughVars }),
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
