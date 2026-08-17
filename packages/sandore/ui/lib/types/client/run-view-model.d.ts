/**
 * RunView 的可测纯逻辑（无 React 依赖）。
 *
 * 从 `@deepseek-ai/dsh-sandore-workflow/schema`（浏览器安全子路径）导入
 * `WorkflowTaskState` 等 wire 类型，并以其派生 `DagRunStatus`/`StepStatus`/
 * `ExecutedStep`/`StageInfo`（避免从包根 `types.ts` 导入带出 `dsh-llm` 依赖）。
 * 此处提供：7 态 → StateDotState 穷尽映射、运行中/终态判定（驱动 5s 轮询）、
 * pending 交互分类、retry message 校验与 `RetryMode` 词汇。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/run-view-model
 */
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PendingPermissionEntry, PendingQuestionEntry, WorkflowTaskState } from '@deepseek-ai/dsh-sandore-workflow/schema';
/** 实例生命周期状态（从 `WorkflowTaskState` 派生，避免 dsh-llm 依赖）。 */
export type DagRunStatus = WorkflowTaskState['status'];
/** 单个 Step/Stage 执行状态（从 `WorkflowTaskState` 派生）。 */
export type StepStatus = WorkflowTaskState['executedSteps'][number]['status'];
/** 已执行 Step 的快照（从 `WorkflowTaskState` 派生）。 */
export type ExecutedStep = WorkflowTaskState['executedSteps'][number];
/** Stage 状态快照（从 `WorkflowTaskState` 派生）。 */
export type StageInfo = WorkflowTaskState['stageInfos'][number];
/** 重试模式（对齐 `retryStep` 入参 `mode` 的 zod 枚举）。 */
export type RetryMode = 'continue' | 'revert' | 'fork';
/** 三种重试模式（供重试表单下拉/选项渲染）。 */
export declare const RETRY_MODES: readonly RetryMode[];
/**
 * StepStatus 7 态 → StateDotState 4 态穷尽映射：
 * `completed→done`、`failed→error`、`running→ongoing`，其余（等待用户注意的
 * blocked/ready/interacting/paused）折入 `warning`。
 * @param status - Step 执行状态。
 * @returns 四态语义点。
 */
export declare function stepDotState(status: StepStatus): StateDotState;
/**
 * DagRunStatus 7 态 → StateDotState 4 态穷尽映射：
 * `completed→done`、`failed→error`、`running→ongoing`，其余（pending/interacting/
 * aborted/paused）折入 `warning`。
 * @param status - 实例生命周期状态。
 * @returns 四态语义点。
 */
export declare function runDotState(status: DagRunStatus): StateDotState;
/**
 * 实例是否处于「运行中」状态（`running`/`interacting`），决定是否启动 5s 轮询。
 * @param status - 实例生命周期状态。
 * @returns 运行中（需轮询）为 true。
 */
export declare function isRunningStatus(status: DagRunStatus): boolean;
/**
 * 实例是否已进入终态（`completed`/`failed`/`aborted`），终态停止轮询。
 * @param status - 实例生命周期状态。
 * @returns 终态为 true。
 */
export declare function isTerminalStatus(status: DagRunStatus): boolean;
/** pending 交互分类结果。 */
export interface PendingInteractionPartition {
    /** 待答问题条目。 */
    readonly questions: readonly PendingQuestionEntry[];
    /** 待批权限条目。 */
    readonly permissions: readonly PendingPermissionEntry[];
}
/**
 * 按 `kind` 把 `pendingInteractions` 分为问答与权限两组。
 * @param interactions - 实例的 pending 交互列表。
 * @returns 问答与权限两个分组。
 */
export declare function partitionInteractions(interactions: readonly (PendingQuestionEntry | PendingPermissionEntry)[]): PendingInteractionPartition;
/**
 * 判断字符串是否为空或仅含空白（用于 retry message 等必填文本校验）。
 * @param value - 待校验文本。
 * @returns 空白为 true。
 */
export declare function isBlank(value: string): boolean;
/**
 * Step 对外交互标识：定义 `stepId` 优先，缺省回退唯一执行 `id`。
 * 与引擎侧 `findStep`（先 `stepId` 后 `id` 反查）保持一致，供
 * `pauseStep`/`resumeStep`/`retryStep` 入参使用。
 * @param step - 含 `id` 与可选 `stepId` 的 Step 快照。
 * @returns 可反查该 Step 的稳定标识。
 */
export declare function stepIdOf(step: {
    readonly id: string;
    readonly stepId?: string | undefined;
}): string;
/**
 * 判定 Step 是否为可续接的子代理 Step（agent/skill/mcp），非 shell/prompt 合成 session。
 *
 * 对齐引擎侧 `recovery-manager.ts` 的 `isSubagentStep`：优先 `sessionMeta.command`
 * （运行时 session 元数据），缺省回退 `command.type`（定义态命令类型）。shell/prompt
 * 合成 session 无真实子代理，引擎对暂停/重试明确抛 `INVALID_OPERATION`，故 UI 不应
 * 对其渲染 pause/resume/retry 控件。
 * @param step - 已执行 Step 快照。
 * @returns 子代理 Step（可暂停/恢复/重试）为 true。
 */
export declare function isSubagentStep(step: ExecutedStep): boolean;
//# sourceMappingURL=run-view-model.d.ts.map