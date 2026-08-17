import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * sandore-step 讨论节点的 keyed 渲染器。
 *
 * 按状态渲染单个 Step 折叠节点：running 状态徽章 + 名称（无结果）；completed
 * 内联 step-completed 的 output 文本（MarkdownText）；failed 红框 + error；
 * paused 琥珀框 + 快照提示。显示 `name` 与循环迭代标签（`#1.2`）；点击名称
 * 经注入的 `openSession(childId)` 跳子会话；failed/completed 提供节点级重试
 * 控件（continue/revert/fork + 可选 message，提交经注入的 `retryStep`）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/DagStepNodeView
 */
import { useState } from 'react';
import { Button, Input, MarkdownText, Pill, StateDot, } from '@deepseek-ai/dsh-client-ui-primitives';
import { describeError } from "./describe-error.js";
import { RETRY_MODES } from "./run-view-model.js";
import css from './DagStepNodeView.module.css';
/** 状态 → 本地化标签键。 */
const STATUS_KEYS = {
    running: 'step.status.running',
    completed: 'step.status.completed',
    failed: 'step.status.failed',
    paused: 'step.status.paused',
};
/** 重试模式 → 本地化标签键。 */
const RETRY_MODE_KEYS = {
    continue: 'step.retry.mode.continue',
    revert: 'step.retry.mode.revert',
    fork: 'step.retry.mode.fork',
};
/** 四态 → StateDotState 四态穷尽映射。 */
function dotState(status) {
    switch (status) {
        case 'running': return 'ongoing';
        case 'completed': return 'done';
        case 'failed': return 'error';
        case 'paused': return 'warning';
        /* v8 ignore next -- SandoreStepStatus is closed and every variant is handled above. */
        default: return status;
    }
}
/** 拼接 output 文本块为单个 Markdown 源（空数组/缺省返回空串）。 */
function outputText(output) {
    return output === undefined ? '' : output.map(block => block.text).join('\n');
}
/** 渲染单个 sandore Step 节点。 */
export function DagStepNodeView({ node, sessionId, openSession, retryStep, t }) {
    const data = node.data;
    const [retryOpen, setRetryOpen] = useState(false);
    const [mode, setMode] = useState('continue');
    const [message, setMessage] = useState('');
    const [pending, setPending] = useState(false);
    const [retryError, setRetryError] = useState(undefined);
    const canRetry = data.status === 'failed' || data.status === 'completed';
    const submitRetry = async () => {
        setPending(true);
        setRetryError(undefined);
        try {
            await retryStep({ instanceId: sessionId, stepId: data.stepId, mode, message });
            setRetryOpen(false);
        }
        catch (error) {
            setRetryError(describeError(error));
        }
        finally {
            setPending(false);
        }
    };
    return (_jsxs("section", { className: css.root, "data-sandore-step": true, "data-step-status": data.status, children: [_jsxs("header", { className: css.header, "data-step-status": data.status, children: [_jsx(StateDot, { state: dotState(data.status) }), _jsx("button", { type: "button", className: css.name, "aria-label": t('step.open', { name: data.name }), onClick: () => { openSession(data.childId); }, children: data.name }), data.loopLabel !== undefined && _jsx("span", { className: css.loopLabel, children: data.loopLabel }), _jsx("span", { className: css.status, children: t(STATUS_KEYS[data.status]) })] }), data.status === 'completed' && data.output !== undefined && data.output.length > 0 && (_jsx("div", { className: css.output, children: _jsx(MarkdownText, { text: outputText(data.output) }) })), data.status === 'failed' && data.error !== undefined && (_jsx("div", { className: css.error, role: "alert", children: data.error })), data.status === 'paused' && (_jsx("div", { className: css.paused, children: t('step.paused.hint') })), canRetry && (_jsx("div", { className: css.actions, children: retryOpen ? (_jsxs("div", { className: css.retryForm, children: [_jsx("div", { className: css.retryModes, role: "group", "aria-label": t('step.retry.mode'), children: RETRY_MODES.map(candidate => (_jsx(Pill, { active: candidate === mode, onClick: () => { setMode(candidate); }, children: t(RETRY_MODE_KEYS[candidate]) }, candidate))) }), _jsx(Input, { value: message, onChange: event => { setMessage(event.target.value); }, placeholder: t('step.retry.message') }), retryError !== undefined && (_jsx("p", { className: css.retryError, role: "alert", children: t('step.retry.failed', { message: retryError }) })), _jsxs("div", { className: css.retryActions, children: [_jsx(Button, { size: "sm", variant: "ghost", disabled: pending, onClick: () => { setRetryOpen(false); }, children: t('step.retry.cancel') }), _jsx(Button, { size: "sm", variant: "primary", disabled: pending, onClick: () => { void submitRetry(); }, children: t('step.retry.submit') })] })] })) : (_jsx(Button, { size: "sm", variant: "outline", onClick: () => { setRetryOpen(true); }, children: t('step.retry') })) }))] }));
}
//# sourceMappingURL=DagStepNodeView.js.map