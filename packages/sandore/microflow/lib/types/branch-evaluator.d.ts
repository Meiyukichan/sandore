/**
 * 分支条件两阶段评估器（branch-evaluator）。
 *
 * 以 `start(condition, contextMessage)` 启动评估：agent/prompt/skill/mcp 四类经
 * `ctx.llm.stream()` 创建临时会话发送评估提示词（携带 `sessionHandle`）；shell 类
 * 经 `ctx.shell.run()`（简单命令）或 `ctx.subprocess.spawn()`（透传变量替换 →
 * 环境变量注入 → stdin 注入）直接执行（`sessionHandle = null`）。`collect(partial)`
 * 聚合 AI 输出文本（shell 直接返回 stdout）；`evaluate()` 一步完成两阶段。
 * `evaluateCondition()` 在条件分支 AI 路径上叠加解析失败重试（首轮评估 +
 * 最多 {@link MAX_BRANCH_EVAL_RETRIES} 次 follow-up 纠正），shell 路径直接委托
 * `evaluate()`（走 matchesExpectation，无重试）。
 *
 * 另提供纯函数 `extractShouldExecute`（条件分支 shouldExecute 两层解析，public；
 * 解析失败返回 undefined 触发重试）、`extractBreakResult`（循环跳出 shouldBreak 三级
 * 解析，public，供 LoopManager 复用；分场景字段互不复用）与 `matchesExpectation`
 * （大小写不敏感+包含匹配；显式 `/.../ ` 定界时走正则）。
 * @module @deepseek-ai/dsh-sandore-microflow/src/branch-evaluator
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CommandConfig, DagBranch } from '@deepseek-ai/dsh-sandore-workflow/src/schema';
/** AI 分支评估临时会话标识（与 DSH 品牌字符串结构兼容）。 */
export type TempSessionHandle = string;
/** BranchEvaluator 的引擎级配置（provider/model 三层回退的 L2 来源 + shell 超时）。 */
export interface BranchEvaluatorConfig {
    readonly defaultTimeoutMs: number;
    readonly defaultProvider?: string;
    readonly defaultModel?: string;
}
/** 分支评估附加选项（分支列表 + shell 三注入所需上下文）。 */
export interface BranchEvalOptions {
    /** 候选分支（用于构建评估提示词的分支列表）。 */
    readonly branches?: readonly DagBranch[];
    /** 透传变量（shell 三注入与提示词 `${xxx}` 替换）。 */
    readonly passThroughVars?: Readonly<Record<string, string>>;
    /** 当前循环迭代序号（1-based；非循环 0）。 */
    readonly loopTurn?: number;
    /** 活跃循环 maxIterations（非循环 0）。 */
    readonly loopMaxIterations?: number;
    /** shell 执行工作目录。 */
    readonly workdir?: string;
    /** shell 分支 stdin 注入内容（当前 Step 输出 JSON）。 */
    readonly stdin?: string;
    /** 取消信号。 */
    readonly signal?: AbortSignal;
}
/** 一次分支评估的最终结果。 */
export interface BranchEvalResult {
    /** 聚合输出文本（AI 会话输出或 shell stdout）。 */
    readonly output: string;
    /** 临时会话标识；shell 分支为 null。 */
    readonly sessionHandle: TempSessionHandle | null;
}
/** 两阶段评估的中间态：`start` 产生、`collect` 消费。 */
export interface BranchEvalPartial {
    /** 临时会话标识；shell 分支为 null。 */
    readonly sessionHandle: TempSessionHandle | null;
    /** 待聚合的输出（AI 会话为流聚合 promise，shell 为直接结果）。 */
    readonly outputPromise: Promise<string>;
}
/**
 * 三级解析循环跳出结果（public）。
 *
 * ① JSON 解析取 `shouldBreak`（布尔转字符串，字符串 `"true"`/`"false"` 转小写）；
 * ② regex 回退 `/"shouldBreak"\s*:\s*(true|false)/i`（匹配后转小写）；③ `raw.trim()`。
 */
export declare function extractBreakResult(raw: string): string;
/**
 * 两层解析条件分支 shouldExecute 布尔（public）。
 *
 * ① JSON 解析取 `shouldExecute`（布尔直接返回；字符串 `"true"`/`"false"` 大小写
 * 不敏感转布尔）；② regex 回退 `/\{"shouldExecute"\s*:\s*(true|false)/i`（匹配后
 * 转小写判定）。两层均不满足返回 undefined（解析失败，触发
 * {@link BranchEvaluator.evaluateCondition} 重试或由调用方按 false 处理）。
 * **仅条件分支使用**——循环跳出走 {@link extractBreakResult} 的 shouldBreak 字段，
 * 两者分场景字段互不复用。
 */
export declare function extractShouldExecute(raw: string): boolean | undefined;
/**
 * 判定分支评估结果是否匹配 expectation。
 *
 * 语义对齐基准 `workflow-engine-helpers.matchesExpectation`：默认大小写不敏感 +
 * 包含匹配（宽松，便于迁移工作流）。需正则时用**显式定界符**——expectation 以
 * `/` 起始且以 `/` 结尾（如 `/build-[0-9]+/`）才视为正则，取中间 inner 用
 * `new RegExp(inner)` 匹配；非法正则返回 false。无定界符一律走包含匹配，此时
 * 字面量含 `.`、`\`、`%`、括号等不会被启发式误判为正则（废除旧
 * `hasRegexMetacharacters` 启发式）。expectation 为 undefined 时返回 false（守卫，
 * 避免静默变并行分支）。
 */
export declare function matchesExpectation(result: string, expectation: string | undefined): boolean;
/**
 * 分支条件两阶段评估器。
 *
 * 构造时绑定 `ctx` 与引擎级配置；`start()` 按 `condition.type` 分发（shell 直接
 * 执行，其余四类走 `ctx.llm.stream()` 临时会话），`collect()` 聚合输出文本，
 * `evaluate()` 一步完成。AI 会话失败（error/aborted）抛 `SandoreError`。
 */
export declare class BranchEvaluator {
    private readonly ctx;
    private readonly config;
    constructor(ctx: Context, config: BranchEvaluatorConfig);
    /** 启动评估，返回中间态；AI 会话带 sessionHandle，shell 直接执行完成。 */
    start(condition: CommandConfig, contextMessage: string, options?: BranchEvalOptions): Promise<BranchEvalPartial>;
    /** 收集评估结果：聚合 AI 输出文本（shell 直接返回 stdout）。 */
    collect(partial: BranchEvalPartial): Promise<BranchEvalResult>;
    /** 一步完成两阶段评估。 */
    evaluate(condition: CommandConfig, contextMessage: string, options?: BranchEvalOptions): Promise<BranchEvalResult>;
    /**
     * 条件分支评估（带解析失败重试）。
     *
     * shell 条件直接委托 {@link evaluate}（走 matchesExpectation，无重试）；AI 条件
     * （agent/prompt/skill/mcp）首轮发送分支评估提示词，若 {@link extractShouldExecute}
     * 解析失败（undefined），则把上一轮 AI 输出 + {@link SHOULD_EXECUTE_CORRECTION_HINT}
     * 构造为 follow-up 多轮消息重新评估，最多重试 {@link MAX_BRANCH_EVAL_RETRIES} 次；
     * 重试耗尽记日志（条件不通过由调用方 decideCondition 的 `extractShouldExecute === true`
     * 判定兜底为 false）。仅条件分支使用——循环跳出仍走 {@link evaluate} +
     * extractBreakResult（shouldBreak 字段，缺陷 4 范畴）。
     */
    evaluateCondition(condition: CommandConfig, contextMessage: string, options?: BranchEvalOptions): Promise<BranchEvalResult>;
    private startAi;
    /** 单轮 AI 临时会话流式评估：聚合输出文本；error/aborted 抛 SandoreError。 */
    private streamAi;
    private startShell;
    /** 聚合 AI 临时会话输出为文本；error/aborted 抛 SandoreError。 */
    private aggregate;
    private runShellCommand;
    /** shell 结果 → 输出文本：成功返回 stdout，非零退出/超时/中止抛 SandoreError。 */
    private toStdout;
    /** 生成临时会话标识（随机 8 位 hex）。 */
    private newSessionHandle;
    /** provider/model 三层回退：条件定义 → 引擎配置 → ctx.llm 目录兜底。 */
    private resolveProviderModel;
}
//# sourceMappingURL=branch-evaluator.d.ts.map