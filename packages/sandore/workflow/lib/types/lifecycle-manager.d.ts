/**
 * 生命周期协调器（单步/全局暂停与恢复的纯协调器）。
 *
 * `LifecycleManager` 是暂停/恢复能力的「纯协调器」：不持有引擎状态，仅经注入的
 * 回调/选项访问宿主主代理、`subagents.interrupt`/`followup`、`readState`/
 * `commitState`（不可变重建 + 持久化）、`emitStepPaused`/`emitStepResumed`（事件
 * 双发）与暂停登记表读写。暂停登记表（内存 `Set<string>`，值 = 子代理 SessionId）
 * 是「暂停集」的唯一权威，与 `WorkflowTaskState.pausedChildIds` 数组同步（登记即
 * add + 持久化，恢复即 delete + 持久化）；`Agent.status`（仅 `idle|running`，无
 * paused 态）不能替代登记表查询。
 *
 * 单步暂停：`executedSteps[].sessionMeta.childId` 反查子代理 SessionId →
 * `interrupt(childId, { kind: 'ancestor', agent: hostAgent })` → 登记表 add →
 * Step 置 `paused`（`pausedAt`）→ 持久化 → 双发 `sandore/step-paused`。已空闲
 * Step（`agent.status === 'idle' && !inbox.hasPending`）幂等 no-op；不存在/终态
 * Step 抛 `SandoreError('INVALID_OPERATION')`。单步恢复：反查 childId → 移出登记表
 * → `followup(hostAgent, childId, text(resumePrompt ?? 默认提示))` → Step 置
 * `running`（`resumedAt`/`resumePrompt`）→ 持久化 → 双发 `sandore/step-resumed`；
 * 非登记 Step 抛 `INVALID_OPERATION`。
 * @module @deepseek-ai/dsh-sandore-workflow/src/lifecycle-manager
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Agent, SubagentInterruptAuthority } from '@deepseek-ai/dsh-sandore-microflow/src/subagents';
import type { WorkflowTaskState } from './schema.ts';
/** 生命周期协调器的依赖（全部经回调/选项注入，保持纯协调器可单测）。 */
export interface LifecycleManagerOptions {
    /** 宿主主代理（interrupt 的 ancestor authority + followup 的 parent 三合一）。 */
    readonly hostAgent: Agent;
    /** 暂停登记表初始值（startInstance 为空，崩溃恢复时从快照 `pausedChildIds` 重建）。 */
    readonly initialPausedChildIds: readonly string[];
    /** `ctx.subagents.interrupt` 的注入包装。 */
    readonly interrupt: (childId: string, authority: SubagentInterruptAuthority) => void;
    /** `ctx.subagents.followup` 的注入包装。 */
    readonly followup: (childId: string, content: ContentBlock[], signal: AbortSignal) => Promise<void> | void;
    /** 按 childId 查活子代理（空闲幂等 no-op 判定用）。 */
    readonly getAgent: (childId: string) => Agent | undefined;
    /** 引擎级取消信号（followup 的 `options.signal`）。 */
    readonly signal: AbortSignal;
    /** 读当前完整状态快照。 */
    readonly readState: () => WorkflowTaskState;
    /** 不可变重建 + 持久化当前状态快照。 */
    readonly commitState: (next: WorkflowTaskState) => void;
    /** 双发 `sandore/step-paused` 事件（含 Step 名称与可选循环迭代路径）。 */
    readonly emitStepPaused: (stepId: string, childId: string, name: string, loopIteration?: number[]) => void;
    /** 双发 `sandore/step-resumed` 事件（含 Step 名称与可选循环迭代路径）。 */
    readonly emitStepResumed: (stepId: string, childId: string, resumePrompt: string | undefined, name: string, loopIteration?: number[]) => void;
}
/**
 * 生命周期协调器。
 *
 * 持有暂停登记表（内存 `Set`），通过注入的依赖驱动单步/全局暂停与恢复；状态更新
 * 以「不可变重建 + commitState」落到引擎 `active.state` 与持久化快照。
 */
export declare class LifecycleManager {
    private readonly deps;
    private readonly pausedChildIds;
    constructor(deps: LifecycleManagerOptions);
    /** 暂停登记表当前内容（子代理 SessionId 集合，仅只读投影）。 */
    get pausedIds(): readonly string[];
    /** 某子代理 SessionId 是否在暂停登记表中。 */
    hasPaused(childId: string): boolean;
    /** 暂停单个 Step（经 childId 反查 + interrupt + 登记表 add + 状态 paused + 事件）。 */
    pauseStep(stepId: string): void;
    /** 恢复单个 Step（反查 childId + 移出登记表 + followup + 状态 running + 事件）。 */
    resumeStep(stepId: string, resumePrompt?: string): Promise<void>;
    /** 暂停实例内全部 running/interacting Step（completed/failed 与非子代理 Step 跳过）。 */
    pauseAllSteps(): void;
    /** 恢复登记表内全部 Step（逐个 followup，完成后登记表清空）。 */
    resumeAllSteps(resumePrompt?: string): Promise<void>;
    /** 按 stepId（定义 id 或唯一执行 id）在 executedSteps 中反查 Step。 */
    private findStep;
    /** 按子代理 SessionId 反查 Step（`resumeAllSteps` 遍历登记表用）。 */
    private findStepByChildId;
    /** 反查 Step 的子代理 SessionId（缺省回退唯一执行 id）。 */
    private childIdOf;
    /** 判定 Step 是否为非子代理命令（shell/prompt 合成占位，无真实子代理，不可暂停）。 */
    private isNonSubagentCommand;
    /** Step 对外展示 id（定义 stepId，缺省回退唯一执行 id）。 */
    private stepIdOf;
    /** 不可变重建状态：更新单个 Step 状态 + 同步登记表 + 持久化。 */
    private commitStepStatus;
}
//# sourceMappingURL=lifecycle-manager.d.ts.map