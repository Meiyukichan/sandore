/** 三种重试模式（供重试表单下拉/选项渲染）。 */
export const RETRY_MODES = ['continue', 'revert', 'fork'];
/**
 * StepStatus 7 态 → StateDotState 4 态穷尽映射：
 * `completed→done`、`failed→error`、`running→ongoing`，其余（等待用户注意的
 * blocked/ready/interacting/paused）折入 `warning`。
 * @param status - Step 执行状态。
 * @returns 四态语义点。
 */
export function stepDotState(status) {
    switch (status) {
        case 'completed':
            return 'done';
        case 'failed':
            return 'error';
        case 'running':
            return 'ongoing';
        case 'blocked':
        case 'ready':
        case 'interacting':
        case 'paused':
            return 'warning';
    }
}
/**
 * DagRunStatus 7 态 → StateDotState 4 态穷尽映射：
 * `completed→done`、`failed→error`、`running→ongoing`，其余（pending/interacting/
 * aborted/paused）折入 `warning`。
 * @param status - 实例生命周期状态。
 * @returns 四态语义点。
 */
export function runDotState(status) {
    switch (status) {
        case 'completed':
            return 'done';
        case 'failed':
            return 'error';
        case 'running':
            return 'ongoing';
        case 'pending':
        case 'interacting':
        case 'aborted':
        case 'paused':
            return 'warning';
    }
}
/**
 * 实例是否处于「运行中」状态（`running`/`interacting`），决定是否启动 5s 轮询。
 * @param status - 实例生命周期状态。
 * @returns 运行中（需轮询）为 true。
 */
export function isRunningStatus(status) {
    return status === 'running' || status === 'interacting';
}
/**
 * 实例是否已进入终态（`completed`/`failed`/`aborted`），终态停止轮询。
 * @param status - 实例生命周期状态。
 * @returns 终态为 true。
 */
export function isTerminalStatus(status) {
    return status === 'completed' || status === 'failed' || status === 'aborted';
}
/**
 * 按 `kind` 把 `pendingInteractions` 分为问答与权限两组。
 * @param interactions - 实例的 pending 交互列表。
 * @returns 问答与权限两个分组。
 */
export function partitionInteractions(interactions) {
    const questions = [];
    const permissions = [];
    for (const interaction of interactions) {
        if (interaction.kind === 'question') {
            questions.push(interaction);
        }
        else {
            permissions.push(interaction);
        }
    }
    return { questions, permissions };
}
/**
 * 判断字符串是否为空或仅含空白（用于 retry message 等必填文本校验）。
 * @param value - 待校验文本。
 * @returns 空白为 true。
 */
export function isBlank(value) {
    return value.trim() === '';
}
/**
 * Step 对外交互标识：定义 `stepId` 优先，缺省回退唯一执行 `id`。
 * 与引擎侧 `findStep`（先 `stepId` 后 `id` 反查）保持一致，供
 * `pauseStep`/`resumeStep`/`retryStep` 入参使用。
 * @param step - 含 `id` 与可选 `stepId` 的 Step 快照。
 * @returns 可反查该 Step 的稳定标识。
 */
export function stepIdOf(step) {
    return step.stepId ?? step.id;
}
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
export function isSubagentStep(step) {
    const command = step.sessionMeta?.command ?? step.command?.type;
    return command === 'agent' || command === 'skill' || command === 'mcp';
}
//# sourceMappingURL=run-view-model.js.map