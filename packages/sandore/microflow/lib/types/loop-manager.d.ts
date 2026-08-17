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
import type { BranchEvaluatorConfig } from './branch-evaluator.ts';
import type { BranchMeta, DagLoop } from '@deepseek-ai/dsh-sandore-workflow/src/schema';
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
/**
 * 循环与嵌套循环管理器。
 *
 * 构造时绑定 `ctx`、引擎级配置与循环持久化状态（`activeLoopStack`/
 * `activeLoopIterationStack`），内部自建 {@link BranchEvaluator} 承担 breakCondition
 * 两阶段评估。`loopMaxIterations` 栈与 `stepIdSuffixMap` 为进程内辅助状态（不持久化）。
 */
export declare class LoopManager {
    private readonly state;
    /** 原始 step id → 4 位 hex 后缀（同一次迭代内同一原始 id 复用同一后缀）。 */
    readonly stepIdSuffixMap: Map<string, string>;
    private readonly loopMaxIterationsStack;
    private readonly evaluator;
    constructor(ctx: Context, config: LoopManagerConfig, state: LoopState);
    /** 栈顶活跃循环节点 ID（无活跃循环为 null）。 */
    get activeLoopNodeId(): string | null;
    /** 生成 4 位 hex 后缀（小写 0-9a-f）。 */
    static loopIdSuffix(): string;
    /** 返回循环内实际执行的带后缀 id（`原始id-4位hex`）；同迭代同原始 id 复用同后缀。 */
    getActualStepId(originalStepId: string): string;
    /** 去除循环后缀还原原始 id（非本迭代生成的后缀原样返回）。 */
    stripIdSuffix(id: string): string;
    /** 构建当前嵌套迭代路径（如 `[1, 2]`），无活跃循环返回空数组。 */
    buildLoopIterationPath(): number[];
    /** 递增最内层迭代计数，并清除本迭代的后缀映射（新迭代生成新后缀）。 */
    incrementLoopIteration(): void;
    /** 进入循环：压循环栈 + 迭代栈（初始计数 1）+ maxIterations 栈，并清除后缀映射。 */
    pushActiveLoop(nodeId: string, maxIterations: number): void;
    /** 跳出循环：先弹迭代栈，再弹循环栈（含 maxIterations 栈）。 */
    popActiveLoop(): void;
    /** 返回当前循环迭代上下文（`loopTurn`/`loopMaxIterations`；非循环时均为 0）。 */
    getLoopIterationContext(): {
        loopTurn: number;
        loopMaxIterations: number;
    };
    /**
     * 判定循环是否跳出。
     *
     * ① `visitCount >= maxIterations` 硬上限立即返回 true（不发 AI 评估）；② 配置
     * `breakCondition` 时两阶段评估：agent/prompt/skill/mcp 走 `extractBreakResult
     * === 'true'`，shell 走 `matchesExpectation(breakResult, breakExpectation)`；评估完成
     * 写入 `loopMeta`（`evaluating` → `completed`，含评估结果与期望）。
     */
    checkLoopBreak(node: LoopNode, visitCount: number, context?: LoopBreakContext): Promise<LoopBreakOutcome>;
    /** 当前最内层循环迭代序号（无活跃循环 0）。 */
    private currentLoopTurn;
    /** 当前最内层循环 maxIterations（无活跃循环 0）。 */
    private currentLoopMaxIterations;
    /** 按 breakCondition 类型判定是否跳出。 */
    private decideBreak;
}
//# sourceMappingURL=loop-manager.d.ts.map