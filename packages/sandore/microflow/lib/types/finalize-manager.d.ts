/**
 * Step 收尾拆分（finalize-manager）。
 *
 * `FinalizeAssessor`（收尾第 1 部分）按 Step 类型选择会话完成完成判定 + 透传变量提取
 * + ask 转换：session 类型（agent/prompt/skill/mcp）经 `ctx.sessions.fork(stepSessionId)`
 * 创建 fork 会话（boundary 省略取源最后一条事件，规避 OPEN_TURN），评估 LLM 请求携带
 * fork 会话 `sessionId` 作身份戳记（路由/重放）；fork 抛错时降级为一次性临时会话（省略
 * sessionId）且 Step 不失败；shell 类型经 `ctx.llm.stream()` 一次性临时会话（shell stdout
 * 作为输入）。完整注入 fork 会话历史留待 Task 4。
 * `GateEvaluator`（收尾第 2 部分）恒开独立新临时会话执行 primary/secondary 双门
 * 审查，`gatesPassed=true` 后再验证 outputTo 产物文件存在，缺失则覆盖为 false。
 * `FinalizeManager.finalizeStep` 编排：跳过检查（无未解析透传变量 + 无门禁）→ assess →
 * ask 置 interacting 中断门禁 / gate 审查 → 回写 passThroughVars（保留 refresh）→ 同步
 * finalizeMeta 到 executedSteps → persistState。
 * @module @deepseek-ai/dsh-sandore-microflow/src/finalize-manager
 */
import type { Context } from '@deepseek-ai/cordis';
import type { PassThroughVarValue } from './stage-executor.ts';
import type { ExecutedStepDefault, FinalizeOutcome } from '@deepseek-ai/dsh-sandore-workflow/src/types';
import type { AskUserQuestionPayload, FinalizeAssessResult, GateEvalResult, Gates, WorkflowStep } from '@deepseek-ai/dsh-sandore-workflow/src/schema';
/** 收尾管理器引擎级配置（provider/model 三层回退的 L2 来源）。 */
export interface FinalizeManagerConfig {
    readonly defaultTimeoutMs: number;
    readonly defaultProvider?: string;
    readonly defaultModel?: string;
}
/** Step 收尾评估上下文（`<stepContext>` 的 input/output/artifacts 块）。 */
export interface FinalizeStepContext {
    readonly input: string;
    readonly output: string;
    readonly artifacts?: readonly string[];
}
/** FinalizeAssessor 的评估输入。 */
export interface FinalizeAssessInput {
    readonly step: WorkflowStep;
    /** session 类型 Step 的 fork 源会话 ID（省略时降级为临时会话）。 */
    readonly stepSessionId?: string;
    readonly context: FinalizeStepContext;
    readonly signal?: AbortSignal;
}
/** GateEvaluator 的评估输入。 */
export interface FinalizeGateInput {
    readonly step: WorkflowStep;
    readonly context: FinalizeStepContext;
    /** 三级合并后的门禁配置。 */
    readonly gates: Gates;
    readonly workdir: string;
    readonly signal?: AbortSignal;
}
/** finalizeStep 编排请求（含回写目标与持久化钩子）。 */
export interface FinalizeStepRequest {
    readonly step: WorkflowStep;
    readonly executedStep: ExecutedStepDefault;
    readonly stepSessionId?: string;
    readonly context: FinalizeStepContext;
    /** 三级合并后的门禁配置；省略视为无门禁。 */
    readonly gates?: Gates;
    readonly workdir: string;
    /** 引擎透传变量累积器（就地回写提取结果）。 */
    readonly passThroughVars?: Record<string, PassThroughVarValue>;
    readonly signal?: AbortSignal;
    /** 同步 finalizeMeta 后的持久化回调（由引擎注入）。 */
    readonly onPersist?: (executedStep: ExecutedStepDefault) => Promise<void> | void;
}
/** Assessor 解析出的完成判定结果（未含会话/原始输出字段）。 */
export interface AssessParsed {
    readonly completionType: 'completed' | 'ask';
    readonly passThroughVars: Record<string, string>;
    readonly askQuestion?: AskUserQuestionPayload;
}
/** primary 门禁解析结果（`taskStatus` → passed）。 */
export interface PrimaryGateParsed {
    readonly passed: boolean;
    readonly errorDetail?: string;
}
/** secondary 门禁解析结果（`gateStatus` → passed）。 */
export interface SecondaryGateParsed {
    readonly passed: boolean;
    readonly detail?: string;
}
/**
 * 三级解析收尾评估结果（public）。
 *
 * ① JSON 解析取 `completionType`/`passThroughVars`/`askQuestion`；② regex 回退
 * `/"completionType"\s*:\s*"([^"]+)"/`（透传变量回落空）；③ 原始输出回落
 * `completionType='completed'` + 空透传变量。
 */
export declare function parseAssessResult(raw: string): AssessParsed;
/** 解析 primary 门禁输出（`taskStatus` + `errorDetail`）。 */
export declare function parsePrimaryGate(raw: string): PrimaryGateParsed;
/** 解析 secondary 门禁输出（`gateStatus` + `gateDetail`）。 */
export declare function parseSecondaryGate(raw: string): SecondaryGateParsed;
/**
 * 收尾第 1 部分：完成判定 + 透传变量提取 + ask 转换。
 *
 * session 类型 Step 经 `ctx.sessions.fork(stepSessionId)` 创建 fork 会话（boundary 省略
 * 取源最后一条事件），评估 LLM 请求携带 fork 会话 `sessionId` 作身份戳记（路由/重放）；
 * fork 抛错时降级为一次性临时会话（省略 sessionId）并记 `errorDetail`（Step 不失败）。
 * shell 类型经
 * `ctx.llm.stream()` 一次性临时会话（shell stdout 作为输入）。评估提示词含
 * `<stepContext>`、透传变量列表、返回 JSON 格式与红线规则；输出三级解析
 * （JSON → regex → 原始）。
 */
export declare class FinalizeAssessor {
    private readonly ctx;
    private readonly config;
    constructor(ctx: Context, config: FinalizeManagerConfig);
    /** 执行收尾评估，返回 `FinalizeAssessResult`（含 forkSessionId/assessmentRaw）。 */
    assess(input: FinalizeAssessInput): Promise<FinalizeAssessResult>;
}
/**
 * 收尾第 2 部分：独立新临时会话双门审查。
 *
 * primary 门禁（产物存在 + 基本完成度 → `taskStatus`）与 secondary 门禁
 * （`secondaryEnabled` 时注入 `secondaryPrompt` → `gateStatus`）各开一次 `ctx.llm.stream()`
 * 临时会话，与 Assessor 完全隔离。`gatesPassed=true` 后再验证 outputTo 产物文件存在，
 * 任一缺失则覆盖为 false 并记 `errorDetail`。未启用的门禁在 `gateDetails` 中仅标
 * `enabled:false`、不输出 `passed`（顶层 `primaryPassed`/`secondaryPassed` 亦省略）。
 */
export declare class GateEvaluator {
    private readonly ctx;
    private readonly config;
    constructor(ctx: Context, config: FinalizeManagerConfig);
    /** 执行门禁审查，返回 `GateEvalResult`（含 gateSessionId/assessmentRaw）。 */
    evaluate(input: FinalizeGateInput): Promise<GateEvalResult>;
    /** 校验 outputTo 产物文件存在；返回缺失的 pattern 列表。 */
    private verifyArtifacts;
}
/**
 * Step 收尾编排器。
 *
 * 组合 {@link FinalizeAssessor} 与 {@link GateEvaluator}，`finalizeStep()` 按序执行：跳过检查
 * （无未解析透传变量 + 无门禁 → 零 AI 调用直接 done）→ assess → ask 置 interacting 中断
 * 门禁 / gate 审查 → 回写 passThroughVars（保留 refresh）→ 同步 finalizeMeta → persistState。
 */
export declare class FinalizeManager {
    private readonly ctx;
    private readonly config;
    private readonly assessor;
    private readonly gateEvaluator;
    constructor(ctx: Context, config: FinalizeManagerConfig);
    /** 编排单个 Step 的收尾，返回 `FinalizeOutcome`（done/ask/error 三态）。 */
    finalizeStep(request: FinalizeStepRequest): Promise<FinalizeOutcome>;
    /**
     * ask 回复后重跑收尾（继续门禁审查）：
     * 评估已在首次 finalizeStep 完成（completionType === 'ask'），此处仅重跑门禁并把
     * executedStep 从 interacting 置回 completed/failed。
     */
    finalizeStepAfterAsk(request: FinalizeStepRequest, assessResult: FinalizeAssessResult): Promise<FinalizeOutcome>;
    /** 评估完成后（completionType === 'completed' 或 ask 恢复后）的收尾：门禁审查 + 回写。 */
    private finalizeAfterAssess;
    /** 回写 finalizeMeta + 透传变量 + onPersist（评估结果与门禁结果的统一落点）。 */
    private persistFinalize;
}
//# sourceMappingURL=finalize-manager.d.ts.map