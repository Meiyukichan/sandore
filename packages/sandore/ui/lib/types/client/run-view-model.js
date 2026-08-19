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
 *
 * 探索修正（2026-08）：仅取 `status === 'pending'` 的条目——后端已只持久化 pending，
 * 此处过滤是防御旧快照（含 replied/rejected 全量历史时避免讨论页复弹接管面板）。
 * @param interactions - 实例的 pending 交互列表。
 * @returns 问答与权限两个分组。
 */
export function partitionInteractions(interactions) {
    const questions = [];
    const permissions = [];
    for (const interaction of interactions) {
        if (interaction.status !== 'pending')
            continue;
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
 * 计算相对时间（ISO → 刚刚 / N 分钟前 / N 小时前 / N 天前；跨 7 天回退短日期）。
 * @param iso - 目标时间（ISO 串），undefined 返回 undefined。
 * @param nowIso - 基准「现在」（ISO 串）。
 * @returns 相对时间结果或 undefined。
 */
export function relativeTimeOf(iso, nowIso) {
    if (iso === undefined)
        return undefined;
    const then = Date.parse(iso);
    const now = Date.parse(nowIso);
    if (Number.isNaN(then) || Number.isNaN(now))
        return undefined;
    const diffMs = now - then;
    if (diffMs < 60_000)
        return { kind: 'justNow' };
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 60)
        return { kind: 'minutes', count: minutes };
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return { kind: 'hours', count: hours };
    const days = Math.floor(hours / 24);
    if (days < 7)
        return { kind: 'days', count: days };
    const date = new Date(then);
    const pad = (value) => String(value).padStart(2, '0');
    return {
        kind: 'date',
        text: `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
    };
}
/** 把任意载荷值缩略为单行文本（供 tool 消息行展示）。 */
function summarizeValue(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === 'string')
        return value === '' ? undefined : value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    try {
        const text = JSON.stringify(value);
        if (text === undefined)
            return undefined;
        return text.length > 160 ? `${text.slice(0, 160)}…` : text;
    }
    catch {
        return String(value);
    }
}
/**
 * 把 step 的 sessionMessages 派生为展示行（agent 内嵌消息框 / 失败列表用）。
 * tool 消息 → `┌ tool\n└ 输出摘要`（mono 行）；text/reasoning → 正文行。
 * @param step - 已执行 Step 快照。
 * @returns 展示行列表；无消息返回 undefined。
 */
export function chatLinesOf(step) {
    const messages = step.sessionMessages;
    if (messages === undefined || messages.length === 0)
        return undefined;
    const lines = [];
    for (const message of messages) {
        if (message.type === 'tool') {
            const head = `┌ ${message.tool ?? 'tool'}`;
            const output = summarizeValue(message.output);
            lines.push({
                who: `${step.name} · tool`,
                text: output === undefined ? head : `${head}\n└ ${output}`,
                kind: 'tool',
            });
        }
        else {
            const text = message.text;
            if (text === undefined || text === '')
                continue;
            lines.push({ who: `${step.name} · agent`, text, kind: 'assistant' });
        }
    }
    return lines.length === 0 ? undefined : lines;
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
        // 段模型下同 stepId 多次执行段（暂停续跑/重试/ask 续问）在树导航里聚合成一个
        // step 节点：取 attemptIndex 最大（最后）的一段展示状态，避免重复展开。
        const steps = state.executedSteps
            .filter(step => step.stageId === stage.id)
            .sort((a, b) => (b.attemptIndex ?? 0) - (a.attemptIndex ?? 0));
        const seen = new Set();
        const uniqueSteps = steps.filter(step => {
            const key = stepIdOf(step);
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
        return {
            id: stage.id,
            name: stage.name,
            type: 'stage',
            status: stage.status,
            children: uniqueSteps.map(step => {
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
 * 段模型下按「最后活跃段」聚合 Step 列表（DiscussionInput @Step 定点恢复用）。
 *
 * 同 stepId 多次执行段（暂停续跑/重试/ask 续问）只保留 attemptIndex 最大的段，
 * 避免 @Step 选择器重复展示同一 Step 的多个执行段。
 * @param steps - 实例的 executedSteps（可能含同 stepId 多段）。
 * @returns 按 stepId 去重后的 Step 快照列表（取最后活跃段；非子代理 Step 原样保留）。
 */
export function lastActiveSegmentsOf(steps) {
    const byStepId = new Map();
    for (const step of steps) {
        const key = stepIdOf(step);
        const current = byStepId.get(key);
        if (current === undefined || (step.attemptIndex ?? 0) >= (current.attemptIndex ?? 0)) {
            byStepId.set(key, step);
        }
    }
    return [...byStepId.values()];
}
/**
 * 从 `WorkflowTaskState` 构建统一时间线（段模型 + 用户消息统一排序）。
 *
 * 三路来源严格按 `createdAt` 排序合并：
 * 1. `userMessages`（input/resume/retry/answer，含原始需求——初始 input 消息
 *    由引擎 makeInitialState 写入，前端不再单独拼 `state.originalInput` 气泡）
 * 2. executedSteps 各**执行段**（`createdAt` 为段开始时间；同 stepId 多次执行段
 *    各自成卡，`attemptIndex` 标注第几次）
 * 3. running 卡无实时消息流（引擎不写 sessionMessages、无 step-message 事件），
 *    body 按状态展示输出文本 / 错误 / 运行中占位。
 * @param state - 实例状态快照。
 * @returns 时间线条目列表（按 createdAt 升序）。
 */
export function buildTimeline(state) {
    const items = [];
    for (const message of state.userMessages ?? []) {
        items.push({
            kind: 'user',
            content: message.content,
            time: message.createdAt,
            messageKind: message.kind,
            target: message.target,
        });
    }
    for (const step of state.executedSteps) {
        items.push({
            kind: 'step',
            stepId: stepIdOf(step),
            name: step.name,
            status: step.status,
            loopLabel: loopLabelOf(step.loopIteration),
            time: step.createdAt ?? step.updatedAt ?? step.startedAt,
            outputText: outputTextOf(step.output),
            error: step.error,
            childId: step.sessionMeta?.childId,
            synthetic: step.sessionMeta?.synthetic,
            messages: chatLinesOf(step),
            visitCount: step.visitCount,
            attemptIndex: step.attemptIndex,
            pausedAt: step.pausedAt,
        });
    }
    // 统一时间轴：严格按 createdAt 排序（旧实例缺 createdAt 的段排最后）。
    items.sort((a, b) => {
        const ta = a.time === undefined ? '' : a.time;
        const tb = b.time === undefined ? '' : b.time;
        return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    return items;
}
//# sourceMappingURL=run-view-model.js.map