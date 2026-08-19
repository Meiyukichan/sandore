/**
 * 恢复协调器（重试三模式 + 崩溃恢复的纯协调器）。
 *
 * `RecoveryManager` 是「纯协调器」：不持有引擎状态，仅经注入的选项/回调访问宿主
 * 主代理、`subagents.followup`/`agents.create`、`sessions.fork`/`sessions.get`、
 * `readState`/`commitState`（不可变重建 + 持久化）与 `emitStepRetried`（事件双发）。
 * 它负责重试/恢复的「决策与准备」：前置校验、状态清理、`RetryRecord` 历史、子代理
 * 会话准备（continue 同会话 / revert 安全边界 fork / fork 全量 fork），随后把真正的
 * 执行（whenIdle + finalAssistantOutput + finalize + DAG 推进）交给引擎注入的
 * `resumeExecution` 续跑。
 *
 * 重试三模式：`continue` 同会话 `followup`（sessionId 不变）；`revert` 计算最后一个
 * 闭合 turn 的末事件 seq 作安全边界 → `sessions.fork(childId, boundary)` 取前缀 →
 * `agents.create({ seed: forked.events, sessionId: 新合成 childId })`（新 session id，
 * `parentSessionId` 记旧值）；`fork` 省略 boundary 保留全量历史 → `agents.create({ seed })`
 * 新 agent 续跑。三模式共用重试续跑循环：置 `running` → 清残留字段 → `RetryRecord`
 * 入 `retryHistory` → 发射 `sandore/step-retried` → followup/续跑 → `resumeExecution`。
 * 仅 `failed` Step 可重试（completed 实例/Step 返回无害 no-op），执行中抛
 * `INVALID_OPERATION`。
 *
 * 崩溃恢复：`recover()` 按快照 `executedSteps` 分类处理——合成 session（shell/prompt）
 * 标 `failed`、仅对第一个 `running`/`interacting` 子代理 Step `followup` 冷恢复（与引擎
 * 单步续跑收口一致）、`paused` 交由引擎从 `pausedChildIds` 重建登记表等待手动 resume。
 * @module @deepseek-ai/dsh-sandore-workflow/src/recovery-manager
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-sandore-microflow/src/subagents';
import type { UserMessageRecord, WorkflowTaskState } from './schema.ts';
/** 重试三模式。 */
export type RetryMode = 'continue' | 'revert' | 'fork';
/** fork 源会话最小结构（仅需 `events`，用于安全边界计算与 seed 提取）。 */
export interface ForkSourceSession {
    readonly events: readonly SessionEvent[];
}
/** 单实例恢复例程的分类结果（供引擎决定是否重跑主循环）。 */
export interface RecoverResult {
    /** 存在可续跑的子代理 Step（running/interacting 已 followup 冷恢复）。 */
    readonly hasResume: boolean;
    /** 存在合成 session Step（shell/prompt，已标 failed，实例不可恢复续跑）。 */
    readonly hasFailure: boolean;
}
/** 恢复协调器的依赖（全部经回调/选项注入，保持纯协调器可单测）。 */
export interface RecoveryManagerOptions {
    /** 引擎级取消信号（followup 的 `options.signal`）。 */
    readonly signal: AbortSignal;
    /** 读当前完整状态快照。 */
    readonly readState: () => WorkflowTaskState;
    /** 不可变重建 + 持久化当前状态快照。 */
    readonly commitState: (next: WorkflowTaskState) => void;
    /** 追加一条用户指令消息（写入 `state.userMessages` 并持久化）。 */
    readonly appendUserMessage: (record: UserMessageRecord) => void;
    /** `ctx.subagents.followup` 的注入包装（已绑定宿主主代理作 parent）。 */
    readonly followup: (childId: string, content: ContentBlock[], signal: AbortSignal) => Promise<void> | void;
    /** `ctx.agents.create` 的注入包装（revert/fork 创建带 seed 的新子代理）。 */
    readonly createAgent: (options: CreateAgentOptions) => Promise<AgentHandle>;
    /** `ctx.sessions.get` 的注入包装（安全边界计算读子代理事件流）。 */
    readonly getSession: (id: string) => ForkSourceSession | undefined;
    /** `ctx.sessions.fork` 的注入包装（boundary 省略 = 全量历史）。 */
    readonly forkSession: (source: string, boundary?: number) => ForkSourceSession;
    /** 双发 `sandore/step-retried` 事件（含 Step 名称与可选循环迭代路径）。 */
    readonly emitStepRetried: (stepId: string, mode: RetryMode, name: string, loopIteration?: number[]) => void;
    /** 重试/恢复后的续跑执行（whenIdle + finalAssistantOutput + finalize + DAG 推进）。 */
    readonly resumeExecution: () => Promise<void>;
}
/** 合成新子代理 SessionId（与 shell/prompt 的 `synthesizeChildId` 同规则）。 */
export declare function synthesizeChildId(stepId: string): string;
/**
 * 计算 revert 模式的安全 turn 边界：最后一个闭合 turn 的末事件 seq。
 *
 * 事件流中 `turn/end` 标记一个闭合 turn 的结束；若事件流无任何 `turn/end`（整个
 * 会话处于未闭合 turn），返回 `undefined`（revert 以错误结束）。fork 前据此截取前缀
 * 可避免 DSH `sessions.fork` 的 `OPEN_TURN` 校验失败。
 * @param events - 子代理会话事件流（含 `turn/start`/`turn/end` 边界事件）。
 * @returns 最后一个闭合 turn 的末事件 seq，或无法取到合法闭合 turn 时为 `undefined`。
 */
export declare function computeSafeRevertBoundary(events: readonly SessionEvent[]): number | undefined;
/**
 * 恢复协调器。
 *
 * 持有注入的依赖，实现 `retryStep`（三模式重试）与 `recover`（Step 分类恢复）；
 * 状态更新以「不可变重建 + commitState」落到引擎 `active.state` 与持久化快照。
 */
export declare class RecoveryManager {
    private readonly deps;
    constructor(deps: RecoveryManagerOptions);
    /**
     * 重试单个 failed Step（continue/revert/fork 三模式共用续跑循环）。
     *
     * 前置校验：实例 completed 或 Step completed → 无害 no-op（不抛错、不改状态）；
     * Step running/interacting/paused → 抛 `INVALID_OPERATION`；仅 failed 可重试。
     * 随后清残留字段 + 置 running + 追加 `RetryRecord`（result 先 `running`）+ 发射
     * `sandore/step-retried`，按模式准备子代理会话（continue 不变 / revert 安全边界
     * fork + 新 agent / fork 全量 fork + 新 agent），followup 后 `resumeExecution`
     * 续跑，最后据实际结果更新 `retryHistory` 末条 result。
     * @param stepId - 待重试 Step 的定义 id（或唯一执行 id）。
     * @param mode - 重试模式。
     * @param message - 重试附带的提示消息。
     */
    retryStep(stepId: string, mode: RetryMode, message: string): Promise<void>;
    /**
     * 单实例恢复例程的 Step 分类处理（崩溃恢复）。
     *
     * 遍历快照 `executedSteps`：`running`/`interacting` 的子代理 Step 经 `followup`
     * 冷恢复（absent child 自动从持久化 Session 恢复）；合成 session（shell/prompt）
     * 无真实子代理，标记 `failed`（不可恢复）；`completed`/`failed`/`paused` 无需处理
     * （paused 登记表由引擎从 `pausedChildIds` 重建，等待手动 resume）。
     * @returns 分类结果（是否有可续跑子代理 / 是否有合成 session 失败）。
     */
    recover(): Promise<RecoverResult>;
    /** 不可变重建状态：更新单个 Step（按唯一执行 id 定位，不改实例状态）+ updatedAt。 */
    private commitStep;
    /** 重试发起：追加新执行段（保留旧 failed 段定格快照）并置实例 running + updatedAt。 */
    private commitRunningStep;
    /** 重试会话准备/续跑失败：Step 回退 failed、实例 failed，记录 retryHistory 末条 result=failed。 */
    private failRetry;
    /** 更新 retryHistory 末条记录的 result。 */
    private setRetryResult;
}
//# sourceMappingURL=recovery-manager.d.ts.map