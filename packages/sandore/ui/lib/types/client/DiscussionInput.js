import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
/**
 * DiscussionInput：执行态中栏底部输入区（状态驱动）。
 *
 * - running/interacting：textarea 禁用 + ⏸ 暂停按钮（pauseAll）。
 * - paused：可输入，发送 → 定点 `resumeStep`（@Step 目标）或广播 `resumeAll`（文本作 resumePrompt）。
 * - failed：可输入 + 重试三模式（continue/revert/fork），发送 → `retryStep`（@Step 目标缺省首个失败 Step）。
 * - 终态：禁用（无可用操作）。
 * @Step 选择器列出 paused/failed Step，不选 = 广播。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/DiscussionInput
 */
import { useMemo, useState } from 'react';
import { isBlank, stepIdOf, RETRY_MODES } from "./run-view-model.js";
import css from './input.module.css';
/** 运行中/终态判定（决定输入区可用性）。 */
function isRunning(status) {
    return status === 'running' || status === 'interacting';
}
function isTerminal(status) {
    return status === 'completed' || status === 'failed' || status === 'aborted';
}
/** 渲染状态驱动输入区。 */
export function DiscussionInput({ t, status, steps, pending, onPauseAll, onResumeAll, onResumeStep, onRetryStep }) {
    const [text, setText] = useState('');
    const [targetStepId, setTargetStepId] = useState(undefined);
    const [retryMode, setRetryMode] = useState('continue');
    const [pickerOpen, setPickerOpen] = useState(false);
    const running = isRunning(status);
    const failed = status === 'failed';
    const paused = status === 'paused';
    const terminal = isTerminal(status);
    // @Step 可选目标：paused / failed 的 Step（子代理可操作）。
    const targetSteps = useMemo(() => steps.filter(step => step.status === 'paused' || step.status === 'failed'), [steps]);
    const firstFailedStepId = steps.find(step => step.status === 'failed');
    const effectiveTarget = targetStepId ?? (failed && firstFailedStepId !== undefined ? stepIdOf(firstFailedStepId) : undefined);
    const targetName = targetStepId === undefined
        ? t('input.target.broadcast')
        : (steps.find(step => stepIdOf(step) === targetStepId)?.name ?? targetStepId);
    const placeholder = running
        ? t('input.placeholder.running')
        : paused
            ? t('input.placeholder.paused')
            : failed
                ? t('input.placeholder.failed')
                : '';
    const canSend = !terminal && !running && !isBlank(text);
    const send = () => {
        if (!canSend || pending)
            return;
        if (failed) {
            if (effectiveTarget !== undefined) {
                onRetryStep(effectiveTarget, retryMode, text);
                setText('');
            }
            return;
        }
        if (paused) {
            if (effectiveTarget !== undefined) {
                onResumeStep(effectiveTarget, text);
            }
            else {
                onResumeAll(text);
            }
            setText('');
        }
    };
    const disabled = terminal || running || pending;
    return (_jsxs("div", { className: css.root, "data-sandore-disc-input": true, children: [_jsxs("div", { className: css.mentionBar, children: [_jsxs("button", { type: "button", className: css.targetBtn, onClick: () => { setPickerOpen(current => !current); }, disabled: disabled, children: [targetStepId === undefined && !failed ? t('input.target.broadcast') : `@${targetName}`, " \u25BE"] }), _jsx("span", { className: css.mentionHint, children: t('input.resume.hint') }), pickerOpen && targetSteps.length > 0 && (_jsxs("div", { className: css.picker, "data-sandore-step-picker": true, children: [_jsx("button", { type: "button", className: targetStepId === undefined ? css.pickerActive : '', onClick: () => { setTargetStepId(undefined); setPickerOpen(false); }, children: t('input.target.broadcast') }), targetSteps.map(step => {
                                const id = stepIdOf(step);
                                return (_jsxs("button", { type: "button", className: targetStepId === id ? css.pickerActive : '', onClick: () => { setTargetStepId(id); setPickerOpen(false); }, children: ["@", step.name] }, id));
                            })] }))] }), _jsx("textarea", { className: css.textarea, value: text, onChange: event => { setText(event.target.value); }, placeholder: placeholder, disabled: disabled, rows: 1 }), failed && (_jsxs("div", { className: css.retryRow, children: [_jsx("span", { className: css.retryLabel, children: t('input.retry.label') }), RETRY_MODES.map(mode => (_jsx("button", { type: "button", className: `${css.retryBtn} ${retryMode === mode ? css.retryBtnActive : ''}`, onClick: () => { setRetryMode(mode); }, children: mode === 'continue' ? t('run.retry.mode.continue') : mode === 'revert' ? t('run.retry.mode.revert') : t('run.retry.mode.fork') }, mode)))] })), _jsxs("div", { className: css.actions, children: [_jsx("span", { className: css.spacer }), running ? (_jsx("button", { type: "button", className: css.pauseBtn, title: t('input.pause'), "aria-label": t('input.pause'), disabled: pending, onClick: onPauseAll, children: "\u23F8" })) : (_jsx("button", { type: "button", className: css.sendBtn, title: t('input.send'), "aria-label": t('input.send'), disabled: !canSend || pending, onClick: send, children: "\u27A4" }))] })] }));
}
//# sourceMappingURL=DiscussionInput.js.map