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
/**
 * 把 `output: ContentBlock[]` 的 text 块拼接为纯文本（无 text 块返回 undefined）。
 * @param output - Step 执行输出块（引擎在 step-completed 事件/快照中内联）。
 * @returns 拼接文本或 undefined。
 */
export function outputTextOf(output) {
    if (output === undefined || output.length === 0)
        return undefined;
    const parts = [];
    for (const block of output) {
        if (block.type === 'text' && block.text !== undefined)
            parts.push(block.text);
    }
    return parts.length === 0 ? undefined : parts.join('\n');
}
/** 循环迭代路径 → 展示标签（`#1.2`），非循环返回 undefined。 */
export function loopLabelOf(loopIteration) {
    return loopIteration === undefined || loopIteration.length === 0
        ? undefined
        : `#${loopIteration.join('.')}`;
}
/**
 * 从 `WorkflowTaskState` 构建树形导航数据：workflow → stage → step → result/artifact 叶子。
 * result 叶子来自 step 输出文本；artifact 叶子来自 `stageContracts` 产物契约的 files。
 * @param state - 实例状态快照。
 * @returns 树形导航根节点列表（单个 workflow 根）。
 */
export function buildRunTree(state) {
    // 叶子按「定义 stepId」分组（artifact.stepId 为定义 id；step 用 stepIdOf 对齐）。
    const leavesByStepId = new Map();
    for (const step of state.executedSteps) {
        const output = outputTextOf(step.output);
        if (output === undefined)
            continue;
        const key = stepIdOf(step);
        const current = leavesByStepId.get(key) ?? [];
        leavesByStepId.set(key, [...current, { id: `${step.id}:result`, name: '', type: 'result', stepId: key, text: output }]);
    }
    for (const contract of Object.values(state.stageContracts)) {
        for (const artifact of contract.artifacts) {
            for (const file of artifact.files) {
                const current = leavesByStepId.get(artifact.stepId) ?? [];
                leavesByStepId.set(artifact.stepId, [...current, {
                        id: `${artifact.stepId}:file:${file}`,
                        name: file,
                        type: 'artifact',
                        stepId: artifact.stepId,
                        meta: artifact.outputToId,
                        text: file,
                    }]);
            }
        }
    }
    const stageNodes = state.stageInfos.map(stage => {
        const steps = state.executedSteps.filter(step => step.stageId === stage.id);
        return {
            id: stage.id,
            name: stage.name,
            type: 'stage',
            status: stage.status,
            children: steps.map(step => {
                const key = stepIdOf(step);
                return {
                    id: step.id,
                    name: step.name,
                    type: 'step',
                    status: step.status,
                    stepId: key,
                    childId: step.sessionMeta?.childId,
                    children: leavesByStepId.get(key),
                };
            }),
        };
    });
    return [{
            id: state.workflowId,
            name: state.workflowName ?? state.workflowId,
            type: 'workflow',
            status: state.status,
            children: stageNodes,
        }];
}
/**
 * 从 `WorkflowTaskState` 构建统一时间线：初始输入 user 气泡 + 各 executedStep 卡片
 * （按执行顺序）。running 卡无实时消息流（引擎不写 sessionMessages、无 step-message
 * 事件），body 按状态展示输出文本 / 错误 / 运行中占位。
 * @param state - 实例状态快照。
 * @returns 时间线条目列表。
 */
export function buildTimeline(state) {
    const items = [];
    if (state.originalInput !== '') {
        items.push({ kind: 'user', content: state.originalInput });
    }
    for (const step of state.executedSteps) {
        items.push({
            kind: 'step',
            stepId: stepIdOf(step),
            name: step.name,
            status: step.status,
            loopLabel: loopLabelOf(step.loopIteration),
            outputText: outputTextOf(step.output),
            error: step.error,
            childId: step.sessionMeta?.childId,
            visitCount: step.visitCount,
        });
    }
    return items;
}
//# sourceMappingURL=run-view-model.js.map