/**
 * 分支条件两阶段评估器（branch-evaluator）。
 *
 * 以 `start(condition, contextMessage)` 启动评估：agent/prompt/skill/mcp 四类经
 * `ctx.llm.stream()` 创建临时会话发送评估提示词（携带 `sessionHandle`）；shell 类
 * 经 `ctx.shell.run()`（简单命令）或 `ctx.subprocess.spawn()`（透传变量替换 →
 * 环境变量注入 → stdin 注入）直接执行（`sessionHandle = null`）。`collect(partial)`
 * 聚合 AI 输出文本（shell 直接返回 stdout）；`evaluate()` 一步完成两阶段。
 *
 * 另提供纯函数 `extractExpectation`（三级解析）、`extractBreakResult`（public，
 * 供 LoopManager 复用）与 `matchesExpectation`（regex 或字符串相等匹配）。
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
 * 三级解析分支 expectation。
 *
 * ① JSON 解析取 `branchExpectation` 字段；② regex 回退
 * `/"branchExpectation"\s*:\s*"([^"]+)"/`；③ 原始输出 `raw.trim()`。
 */
export declare function extractExpectation(raw: string): string;
/**
 * 三级解析循环跳出结果（public）。
 *
 * ① JSON 解析取 `shouldBreak`（布尔转字符串，字符串 `"true"`/`"false"` 转小写）；
 * ② regex 回退 `/"shouldBreak"\s*:\s*(true|false)/i`（匹配后转小写）；③ `raw.trim()`。
 */
export declare function extractBreakResult(raw: string): string;
/**
 * 判定分支评估结果是否匹配 expectation：expectation 含 regex 特征时做正则匹配
 * （正则非法视为不匹配），否则字符串相等比较。
 */
export declare function matchesExpectation(result: string, expectation: string): boolean;
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
    private startAi;
    private startShell;
    /** 聚合 AI 临时会话输出为文本；error/aborted 抛 SandoreError。 */
    private aggregate;
    private runShellCommand;
    private runShellSimple;
    private runShellSubprocess;
    /** shell 结果 → 输出文本：成功返回 stdout，非零退出/超时/中止抛 SandoreError。 */
    private toStdout;
    /** 生成临时会话标识（随机 8 位 hex）。 */
    private newSessionHandle;
    /** provider/model 三层回退：条件定义 → 引擎配置 → ctx.llm 目录兜底。 */
    private resolveProviderModel;
}
//# sourceMappingURL=branch-evaluator.d.ts.map