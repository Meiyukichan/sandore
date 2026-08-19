/**
 * 单 Step 执行器（shell / prompt / agent / skill / mcp）。
 *
 * shell Step 走 `ctx.shell.resolve(request)` → `ctx.shell.run(spec)`（简单命令，
 * 无 stdin/env 注入需求）；存在 stdin（`inputFrom` 解析到内容）或非空透传变量
 * 注入需求时改走 `ctx.subprocess.spawn()`（`stdin: { data }` 写 JSON、`env` 合并）。
 * prompt Step 走三层 provider/model 回退（Step 定义 → 引擎 Config → `ctx.llm`
 * 目录兜底）后 `ctx.llm.stream()`，聚合 block-end 为 `ContentBlock[]`；agent /
 * skill / mcp 三类走可续接子代理（`startContinuable` → `ctx.agents.get(childId)`
 * → `whenIdle` → `finalAssistantOutput`），agent 定义 `agentParamsTemplate` 时先
 * `fillParams` 临时会话填充「### 当前Step参数」子节。所有提示词/命令构建前先
 * `replacePassThroughVars` 替换 `${xxx}` 透传变量（含循环上下文变量）。
 * @module @deepseek-ai/dsh-sandore-microflow/src/step-runner
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Agent } from './subagents.ts';
import type { CommandConfig, SessionMessage, WorkflowStep } from '@deepseek-ai/dsh-sandore-workflow/src/schema';
/** 子代理 ask 转接回调的入参（microflow 检测到标记块后上抛给 workflow 层解析）。 */
export interface DelegatedAskContext {
    readonly childId: string;
    /** 子代理 final result（可能含 `[[SANDORE_ASK]]` 标记块）。 */
    readonly output: ContentBlock[];
    readonly stepId: string;
    readonly stageId: string;
}
/** StepRunner 的引擎级配置（provider/model 三层回退的 L2 来源 + 名称校验数据源）。 */
export interface StepRunnerConfig {
    readonly defaultTimeoutMs: number;
    readonly defaultProvider?: string;
    readonly defaultModel?: string;
    /** 工作流级 skills 名称数组（skill 类型名称校验数据源）。 */
    readonly skills?: readonly string[];
    /** 工作流级 mcps 名称数组（mcp 类型名称校验数据源）。 */
    readonly mcps?: readonly string[];
    /** 工作流级 agents 名称数组（agent 类型名称校验数据源）。 */
    readonly agents?: readonly string[];
    /** 宿主主代理（子代理 parent）；缺省时使用最小桩对象。 */
    readonly hostAgent?: Agent;
    /**
     * 子代理真实 childId 就绪回调（由 workflow 层注入）：`startContinuable` 返回后、
     * `whenIdle` 挂起前调用，把真实子代理 SessionId 上抛给引擎（供暂停反查 childId）。
     * 返回 Promise 时 runner 会 await（引擎借此把真实 childId 落盘后再继续）。
     */
    readonly onChildStarted?: (stepId: string, childId: string) => void | Promise<void>;
    /**
     * 子代理 ask 转接回调（由 workflow 层注入，microflow 不 import workflow 运行时）。
     * 子代理 final result 含 `[[SANDORE_ASK]]` 标记块时调用；返回 `true` 表示已转接
     * （引擎级 ask 完成、答案已 followup 注回），microflow 续跑子代理并重新取 final
     * output；返回 `false` 表示未转接（非法标记块按普通输出处理）。
     */
    readonly onDelegatedAsk?: (input: DelegatedAskContext) => Promise<boolean> | boolean;
    /**
     * 取消类错误下查询暂停登记表的回调（由 workflow 层注入，microflow 不 import
     * workflow）：传入真实子代理 SessionId，返回 `true` 表示该 childId 已在暂停登记表
     * （`interrupt` 打断应保持 paused 而非 failed）。
     */
    readonly isPausedChild?: (childId: string) => boolean;
}
/** 前置 Step 的输出摘要（prompt 结构化提示词的参考信息）。 */
export interface PreviousStepOutput {
    readonly name: string;
    readonly id: string;
    readonly returnPrompt: string;
    readonly files: string[];
}
/** 单 Step 执行请求。 */
export interface StepRunRequest {
    readonly step: WorkflowStep;
    readonly workdir: string;
    readonly originalInput: string;
    readonly previousOutputs: readonly PreviousStepOutput[];
    /** 所属 Stage id（子代理 ask 转接回调的定位字段）。 */
    readonly stageId: string;
    readonly signal?: AbortSignal;
    /** 当前透传变量（键为变量名，值为已解析字符串）。 */
    readonly passThroughVars?: Readonly<Record<string, string>>;
    /** 当前循环迭代序号（1-based；不在循环中缺省视为 0）。 */
    readonly loopTurn?: number;
    /** 活跃循环 `maxIterations`（不在循环中缺省视为 0）。 */
    readonly loopMaxIterations?: number;
}
/** 单 Step 执行结果附带的会话元数据（agent/skill/mcp 返回真实 childId）。 */
export interface StepRunSessionMeta {
    readonly childId?: string;
    readonly synthetic: boolean;
    readonly command: CommandConfig['type'];
}
/** 单 Step 执行结果（成功时的输出块）。 */
export interface StepRunResult {
    readonly output: ContentBlock[];
    readonly sessionMeta?: StepRunSessionMeta;
    /** 子代理会话消息行（§3.8A：真实子代理采集，随结果带出写 `executed.sessionMessages`）。 */
    readonly sessionMessages?: SessionMessage[];
}
/**
 * 单 Step 执行器。
 *
 * 构造时绑定 `ctx` 与引擎级配置；`run()` 按 `step.command.type` 分发到
 * shell/prompt/agent/skill/mcp 五条路径。成功返回 `{ output: ContentBlock[] }`，
 * 失败抛 `SandoreError`（超时 → `STEP_TIMEOUT`，其余 → `STEP_EXECUTION`）。
 */
export declare class StepRunner {
    private readonly ctx;
    private readonly config;
    constructor(ctx: Context, config: StepRunnerConfig);
    /** 执行单个 Step；失败抛 `SandoreError`。 */
    run(request: StepRunRequest): Promise<StepRunResult>;
    private runShell;
    private runShellSimple;
    private toShellResult;
    /** 解析 Step 级 timeout（分钟）→ 毫秒；缺省回退引擎 defaultTimeoutMs。 */
    private stepTimeoutMs;
    private runPrompt;
    private runSubagent;
    /**
     * 暂停后恢复子代理 Step：重新 `whenIdle` + `finalAssistantOutput` + ask 转接循环。
     *
     * 暂停登记表命中的子代理 Step 被 `interrupt` 打断后，`resumeStep` 的 `followup` 重新
     * 驱动子代理；本方法在 `followup` 之后被引擎续跑路径调用，重新等待子代理静止并取回
     * 最终 assistant 输出（等价于首次执行时的输出收集尾段）。
     */
    resumeSubagent(commandType: 'agent' | 'skill' | 'mcp', childId: string, stepId: string, stageId: string): Promise<StepRunResult>;
    /** 收集已启动子代理的最终输出（首次执行与暂停续跑共用：whenIdle + final output + ask 转接）。 */
    private collectSubagentOutput;
    /** 用临时会话按模板填充参数；失败（error/aborted/抛错）回退模板原文。 */
    private fillParams;
    private resolveProviderModel;
    /** 子代理 parent：优先 config.hostAgent，缺省用最小桩对象。 */
    private resolveParent;
}
//# sourceMappingURL=step-runner.d.ts.map