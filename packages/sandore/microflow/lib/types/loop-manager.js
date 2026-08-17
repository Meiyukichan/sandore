import { BranchEvaluator, extractBreakResult, matchesExpectation } from "./branch-evaluator.js";
/** 循环跳出评估上下文：`<output>` 截前 4000 字符、每行缩进 4 格。 */
const BREAK_OUTPUT_MAX = 4000;
/** 按 4 空格缩进多行文本。 */
function indentBlock(text) {
    return text.split('\n').map(line => `    ${line}`);
}
/** 截取文本前 `maxLength` 个字符。 */
function truncateText(text, maxLength) {
    return text.length <= maxLength ? text : text.slice(0, maxLength);
}
/** 构建循环跳出评估上下文（`<input>`/`<output>`/`<artifacts>` XML 块）。 */
function buildBreakContextMessage(context) {
    if (context === undefined) {
        return '';
    }
    const lines = ['<input>'];
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
    state;
    /** 原始 step id → 4 位 hex 后缀（同一次迭代内同一原始 id 复用同一后缀）。 */
    stepIdSuffixMap = new Map();
    loopMaxIterationsStack = [];
    evaluator;
    constructor(ctx, config, state) {
        this.state = state;
        this.evaluator = new BranchEvaluator(ctx, config);
    }
    /** 栈顶活跃循环节点 ID（无活跃循环为 null）。 */
    get activeLoopNodeId() {
        return this.state.activeLoopStack[this.state.activeLoopStack.length - 1] ?? null;
    }
    /** 生成 4 位 hex 后缀（小写 0-9a-f）。 */
    static loopIdSuffix() {
        return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 4);
    }
    /** 返回循环内实际执行的带后缀 id（`原始id-4位hex`）；同迭代同原始 id 复用同后缀。 */
    getActualStepId(originalStepId) {
        const existing = this.stepIdSuffixMap.get(originalStepId);
        if (existing !== undefined) {
            return `${originalStepId}-${existing}`;
        }
        const suffix = LoopManager.loopIdSuffix();
        this.stepIdSuffixMap.set(originalStepId, suffix);
        return `${originalStepId}-${suffix}`;
    }
    /** 去除循环后缀还原原始 id（非本迭代生成的后缀原样返回）。 */
    stripIdSuffix(id) {
        for (const [original, suffix] of this.stepIdSuffixMap) {
            if (id === `${original}-${suffix}`) {
                return original;
            }
        }
        return id;
    }
    /** 构建当前嵌套迭代路径（如 `[1, 2]`），无活跃循环返回空数组。 */
    buildLoopIterationPath() {
        return [...this.state.activeLoopIterationStack];
    }
    /** 递增最内层迭代计数，并清除本迭代的后缀映射（新迭代生成新后缀）。 */
    incrementLoopIteration() {
        const last = this.state.activeLoopIterationStack.length - 1;
        if (last >= 0) {
            this.state.activeLoopIterationStack[last] = (this.state.activeLoopIterationStack[last] ?? 0) + 1;
        }
        this.stepIdSuffixMap.clear();
    }
    /** 进入循环：压循环栈 + 迭代栈（初始计数 1）+ maxIterations 栈，并清除后缀映射。 */
    pushActiveLoop(nodeId, maxIterations) {
        this.state.activeLoopStack.push(nodeId);
        this.state.activeLoopIterationStack.push(1);
        this.loopMaxIterationsStack.push(maxIterations);
        this.stepIdSuffixMap.clear();
    }
    /** 跳出循环：先弹迭代栈，再弹循环栈（含 maxIterations 栈）。 */
    popActiveLoop() {
        this.state.activeLoopIterationStack.pop();
        this.state.activeLoopStack.pop();
        this.loopMaxIterationsStack.pop();
    }
    /** 返回当前循环迭代上下文（`loopTurn`/`loopMaxIterations`；非循环时均为 0）。 */
    getLoopIterationContext() {
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
    async checkLoopBreak(node, visitCount, context) {
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
        const loopMeta = {
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
    currentLoopTurn() {
        return this.state.activeLoopIterationStack[this.state.activeLoopIterationStack.length - 1] ?? 0;
    }
    /** 当前最内层循环 maxIterations（无活跃循环 0）。 */
    currentLoopMaxIterations() {
        return this.loopMaxIterationsStack[this.loopMaxIterationsStack.length - 1] ?? 0;
    }
    /** 按 breakCondition 类型判定是否跳出。 */
    decideBreak(condition, output, breakExpectation) {
        if (condition.type === 'shell') {
            if (breakExpectation === undefined) {
                return false;
            }
            return matchesExpectation(output.trim(), breakExpectation);
        }
        return extractBreakResult(output) === 'true';
    }
}
//# sourceMappingURL=loop-manager.js.map