import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * DiscussionInput：执行详情底部输入区（DSH composer 风格 + composer 接管面板）。
 *
 * 按 `docs/design/execution-detail-prototype.html` 原型实现：
 * - 正常态：DSH InputBar 风格 composer（22px 圆角卡片 + 透明 textarea + 底部工具行：
 *   左权限胶囊 / 右模型胶囊 + 圆形发送按钮）。状态语义保留：
 *   running → textarea 禁用 + ⏸ 暂停（trailing 主按钮）+ 中止 ghost；
 *   paused → 发送 = 定点 `resumeStep`（@Step）或广播 `resumeAll`；
 *   failed → 发送 = `retryStep`（continue/revert/fork）；终态 → 禁用。
 *   @Step 目标选择与重试模式行做成 composer 上方仅在 paused/failed 出现的细工具条。
 * - 接管态：存在 pending 权限 → ApprovalPanel 风格卡片（琥珀条 + headline + command
 *   + 拒绝/始终允许/允许一次）；否则存在 pending 问答 → QuestionComposer 风格卡片
 *   （header + 编号选项 + 自定义行 + pager + 跳过/提交）。接管面板隐藏 composer。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/DiscussionInput
 */
import { useMemo, useState, useSyncExternalStore } from 'react';
import { IconChevronDownOutline14, IconChevronLeftOutline14, IconChevronRightOutline14, IconChevronUpOutline14, IconCloseOutline16, IconEditOutline16, IconStopFill16, } from '@deepseek-ai/dsh-client-ui-primitives';
import { isBlank, stepIdOf, RETRY_MODES, } from "./run-view-model.js";
import { ModelSelectSandore, PermissionSelectSandore } from "./composer-selects.js";
import css from './input.module.css';
/** 运行中/终态判定（决定输入区可用性）。 */
function isRunning(status) {
    return status === 'running' || status === 'interacting';
}
function isTerminal(status) {
    return status === 'completed' || status === 'failed' || status === 'aborted';
}
/** 反查 Step 名（接管面板 headline/eyebrow 用）。 */
function stepNameOf(steps, stepId) {
    const step = steps.find(item => stepIdOf(item) === stepId);
    return step?.name ?? stepId;
}
/** 拆分约定推荐后缀（照 DSH QuestionComposer.parseRecommendedLabel）。 */
function parseRecommendedLabel(label) {
    const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;
    return suffix.test(label)
        ? { label: label.replace(suffix, ''), recommended: true }
        : { label, recommended: false };
}
// ── composer 接管：权限申请（ApprovalPanel 风格） ────────────────────────────
function ApprovalCard({ entry, steps, t, pending, onReply }) {
    const stepName = stepNameOf(steps, entry.stepId);
    const permission = entry.payload.permission;
    const patterns = entry.payload.patterns ?? [];
    const tool = entry.payload.tool;
    const command = tool !== undefined
        ? `${tool}${patterns.length > 0 ? `(${patterns.join(', ')})` : ''}`
        : patterns.length > 0
            ? patterns.join(', ')
            : permission;
    return (_jsx("div", { className: css.takeover, "data-sandore-takeover": "approval", children: _jsxs("div", { className: css.approvalCard, children: [_jsxs("div", { className: css.approvalStrip, children: [_jsx("span", { className: css.approvalDot, "aria-hidden": true }), t('run.approval.waiting')] }), _jsxs("div", { className: css.approvalBody, children: [_jsx("div", { className: css.approvalHeadline, children: t('run.approval.headline', { step: stepName, permission }) }), _jsx("div", { className: css.approvalCommand, children: command })] }), _jsxs("div", { className: css.approvalActions, children: [_jsx("button", { type: "button", className: `${css.approvalBtn} ${css.approvalReject}`, disabled: pending, onClick: () => { onReply(entry.requestId, 'reject'); }, children: t('run.permission.reject') }), _jsx("button", { type: "button", className: `${css.approvalBtn} ${css.approvalGhost}`, disabled: pending, onClick: () => { onReply(entry.requestId, 'always'); }, children: t('run.permission.always') }), _jsx("button", { type: "button", className: `${css.approvalBtn} ${css.approvalAllow}`, disabled: pending, onClick: () => { onReply(entry.requestId, 'once'); }, children: t('run.permission.once') })] })] }) }));
}
function QuestionCard({ entry, steps, t, pending, onReply }) {
    const questions = entry.payload.questions;
    const stepName = stepNameOf(steps, entry.stepId);
    const [index, setIndex] = useState(0);
    const [drafts, setDrafts] = useState(() => questions.map(() => ({
        selected: [], custom: '', skipped: false,
    })));
    const [minimized, setMinimized] = useState(false);
    const [error, setError] = useState(null);
    const question = questions[index];
    const draft = drafts[index];
    const hasOptions = (question.options?.length ?? 0) > 0;
    const multi = question.multi_select === true;
    const updateDraft = (update) => {
        setDrafts(current => current.map((item, itemIndex) => itemIndex === index ? update(item) : item));
        setError(null);
    };
    const choose = (label) => {
        updateDraft(current => {
            if (multi) {
                const selected = current.selected.includes(label)
                    ? current.selected.filter(item => item !== label)
                    : [...current.selected, label];
                return { ...current, selected, skipped: false };
            }
            return { selected: [label], custom: '', skipped: false };
        });
        if (!multi && index < questions.length - 1) {
            setIndex(current => current + 1);
        }
    };
    const answered = (item) => item.selected.length > 0 || item.custom.trim() !== '';
    const completed = (item) => answered(item) || item.skipped;
    const submitAll = (values) => {
        const missing = values.findIndex(item => !completed(item));
        if (missing >= 0) {
            setIndex(missing);
            setError(t('run.question.incomplete'));
            return;
        }
        const answers = questions.map((item, itemIndex) => {
            const value = values[itemIndex];
            if (value.skipped)
                return { id: item.id, selected: [] };
            const custom = value.custom.trim();
            return {
                id: item.id,
                selected: custom === '' || item.multi_select === true ? value.selected : [],
                ...(custom === '' ? {} : { custom }),
            };
        });
        onReply(entry.requestId, answers);
    };
    const continueFlow = () => {
        if (!answered(draft)) {
            setError(t('run.question.unanswered'));
            return;
        }
        if (index < questions.length - 1) {
            setIndex(current => current + 1);
            setError(null);
            return;
        }
        submitAll(drafts);
    };
    const skipQuestion = () => {
        const next = drafts.map((item, itemIndex) => itemIndex === index
            ? { selected: [], custom: '', skipped: true }
            : item);
        setDrafts(next);
        setError(null);
        if (index < questions.length - 1) {
            setIndex(current => current + 1);
            return;
        }
        submitAll(next);
    };
    // 取消 = 整批跳过（放弃问题集，解锁引擎等待）。
    const cancelFlow = () => {
        const next = drafts.map(item => ({ selected: [], custom: '', skipped: true }));
        setDrafts(next);
        submitAll(next);
    };
    const draftCustom = (event) => {
        updateDraft(current => ({
            ...current,
            selected: multi ? current.selected : [],
            custom: event.target.value,
            skipped: false,
        }));
    };
    const continueFromCustom = (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing)
            return;
        event.preventDefault();
        continueFlow();
    };
    return (_jsx("div", { className: css.takeover, "data-sandore-takeover": "question", children: _jsxs("section", { className: css.questionCard, children: [_jsxs("header", { className: css.qHeader, children: [_jsxs("div", { className: css.qHeadingBlock, children: [_jsx("div", { className: css.qEyebrow, children: question.header ?? t('run.question.eyebrow', { step: stepName }) }), _jsx("h2", { className: css.qTitle, children: question.question })] }), _jsxs("div", { className: css.qHeaderActions, children: [_jsx("button", { type: "button", className: css.qIconBtn, title: minimized ? t('run.question.maximize') : t('run.question.minimize'), disabled: pending, onClick: () => { setMinimized(current => !current); }, children: minimized ? _jsx(IconChevronUpOutline14, {}) : _jsx(IconChevronDownOutline14, {}) }), _jsx("button", { type: "button", className: css.qIconBtn, title: t('run.question.cancel'), disabled: pending, onClick: cancelFlow, children: _jsx(IconCloseOutline16, { size: 14 }) })] })] }), !minimized && (_jsxs(_Fragment, { children: [_jsx("div", { className: css.qBody, children: _jsxs("div", { className: css.qOptions, children: [(question.options ?? []).map((option, optionIndex) => {
                                        const selected = draft.selected.includes(option.label);
                                        const display = parseRecommendedLabel(option.label);
                                        return (_jsxs("button", { type: "button", className: `${css.qOption} ${selected && !multi ? css.qOptionSelected : ''}`, role: multi ? 'checkbox' : 'radio', "aria-checked": selected, disabled: pending, onClick: () => { choose(option.label); }, children: [multi
                                                    ? (_jsx("span", { className: `${css.qCheckbox} ${selected ? css.qCheckboxChecked : ''}`, "aria-hidden": true, children: selected ? '✓' : '' }))
                                                    : _jsx("span", { className: css.qNumber, children: optionIndex + 1 }), _jsx("span", { className: css.qOptionCopy, children: _jsxs("span", { className: css.qOptionLine, children: [_jsx("span", { className: css.qOptionLabel, children: display.label }), display.recommended && _jsx("span", { className: css.qBadge, children: t('run.question.recommended') }), option.description !== undefined && _jsx("span", { className: css.qDesc, children: option.description })] }) })] }, `${option.label}-${String(optionIndex)}`));
                                    }), hasOptions ? (_jsxs("div", { className: `${css.qCustom} ${draft.custom !== '' ? css.qCustomActive : ''}`, children: [_jsx("span", { className: css.qNumber, "aria-hidden": true, children: _jsx(IconEditOutline16, { size: 12 }) }), _jsx("input", { type: "text", value: draft.custom, disabled: pending, placeholder: t('run.question.customPlaceholder'), onChange: draftCustom, onKeyDown: continueFromCustom })] })) : (_jsx("textarea", { rows: 2, className: css.qTextarea, value: draft.custom, disabled: pending, placeholder: t('run.question.customPlaceholder'), onChange: draftCustom, onKeyDown: continueFromCustom }))] }) }), _jsxs("footer", { className: css.qFooter, children: [_jsxs("div", { className: css.qPager, children: [_jsx("button", { type: "button", className: css.qIconBtn, "aria-label": "\u2039", disabled: index === 0 || pending, onClick: () => { setIndex(current => current - 1); setError(null); }, children: _jsx(IconChevronLeftOutline14, {}) }), _jsxs("span", { className: css.qProgress, children: [index + 1, " / ", questions.length] }), _jsx("button", { type: "button", className: css.qIconBtn, "aria-label": "\u203A", disabled: index === questions.length - 1 || pending, onClick: () => { setIndex(current => current + 1); setError(null); }, children: _jsx(IconChevronRightOutline14, {}) })] }), error !== null && _jsx("div", { className: css.qFeedback, role: "status", children: error }), _jsxs("div", { className: css.qFooterActions, children: [_jsx("button", { type: "button", className: `${css.qBtn} ${css.qSkip}`, disabled: pending, onClick: skipQuestion, children: t('run.question.skip') }), _jsx("button", { type: "button", className: `${css.qBtn} ${css.qSend}`, disabled: pending || !answered(draft), onClick: continueFlow, children: index === questions.length - 1 ? t('run.question.submit') : t('run.question.next') })] })] })] }))] }) }));
}
// ── 正常 composer（DSH InputBar 风格） ──────────────────────────────────────
/** 发送箭头 glyph（照 DSH InputBar 主按钮）。 */
function SendGlyph() {
    return (_jsx("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, children: _jsx("path", { d: "M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z", fill: "currentColor" }) }));
}
/** 暂停 glyph（照 DSH 主按钮 stop 方块）。 */
function PauseGlyph() {
    return (_jsx("svg", { viewBox: "0 0 16 16", "aria-hidden": true, children: _jsx("rect", { x: "3", y: "3", width: "10", height: "10", rx: "3", fill: "currentColor" }) }));
}
function Composer({ t, status, steps, pending, onPauseAll, onResumeAll, onResumeStep, onRetryStep, onAbort, instanceId, modelDirectory, sessionPermissions, runCommand, queryPermission }) {
    const [text, setText] = useState('');
    const [targetStepId, setTargetStepId] = useState(undefined);
    const [retryMode, setRetryMode] = useState('continue');
    const [pickerOpen, setPickerOpen] = useState(false);
    // 模型目录 / 权限投影：绑定当前实例会话（复用 DSH 数据与 RPC，行为与主 session 一致）。
    const directory = useMemo(() => modelDirectory(instanceId), [modelDirectory, instanceId]);
    const permissionValue = useSyncExternalStore(fn => sessionPermissions.subscribe(fn), () => sessionPermissions.getSnapshot());
    const running = isRunning(status);
    const failed = status === 'failed';
    const paused = status === 'paused';
    const terminal = isTerminal(status);
    const showAbort = onAbort !== undefined && (running || paused);
    // @Step 可选目标：paused / failed 的 Step（子代理可操作）。
    const targetSteps = steps.filter(step => step.status === 'paused' || step.status === 'failed');
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
    return (_jsxs("div", { className: css.root, "data-sandore-disc-input": true, children: [(paused || failed) && (_jsxs("div", { className: css.toolbar, children: [_jsxs("button", { type: "button", className: css.targetBtn, onClick: () => { setPickerOpen(current => !current); }, disabled: disabled, children: [targetStepId === undefined && !failed ? t('input.target.broadcast') : `@${targetName}`, _jsx(IconChevronDownOutline14, {})] }), pickerOpen && targetSteps.length > 0 && (_jsxs("div", { className: css.picker, "data-sandore-step-picker": true, children: [_jsx("button", { type: "button", className: targetStepId === undefined ? css.pickerActive : '', onClick: () => { setTargetStepId(undefined); setPickerOpen(false); }, children: t('input.target.broadcast') }), targetSteps.map(step => {
                                const id = stepIdOf(step);
                                return (_jsxs("button", { type: "button", className: targetStepId === id ? css.pickerActive : '', onClick: () => { setTargetStepId(id); setPickerOpen(false); }, children: ["@", step.name] }, id));
                            })] })), failed && (_jsxs("div", { className: css.retryRow, children: [_jsx("span", { className: css.retryLabel, children: t('input.retry.label') }), RETRY_MODES.map(mode => (_jsx("button", { type: "button", className: `${css.retryBtn} ${retryMode === mode ? css.retryBtnActive : ''}`, onClick: () => { setRetryMode(mode); }, children: mode === 'continue' ? t('run.retry.mode.continue') : mode === 'revert' ? t('run.retry.mode.revert') : t('run.retry.mode.fork') }, mode)))] }))] })), _jsxs("div", { className: css.composerCard, children: [_jsx("div", { className: css.composerScroll, children: _jsx("textarea", { className: css.composerInput, value: text, onChange: event => { setText(event.target.value); }, placeholder: placeholder, disabled: disabled, rows: 1 }) }), _jsxs("div", { className: css.composerRow, children: [_jsx("div", { className: css.composerTools, children: _jsx(PermissionSelectSandore, { t: t, value: permissionValue, locked: pending, runCommand: (line) => runCommand(instanceId, line), queryValue: queryPermission }) }), _jsxs("div", { className: css.composerTrailing, children: [_jsx(ModelSelectSandore, { t: t, directory: directory, locked: pending }), showAbort && (_jsx("button", { type: "button", className: css.abortBtn, title: t('run.abort'), "aria-label": t('run.abort'), disabled: pending, onClick: onAbort, children: _jsx(IconStopFill16, {}) })), _jsx("button", { type: "button", className: css.sendBtn, title: running ? t('input.pause') : `${t('input.send')} · ⌘↵`, "aria-label": running ? t('input.pause') : t('input.send'), disabled: running ? pending : (!canSend || pending), onClick: running ? onPauseAll : send, children: running ? _jsx(PauseGlyph, {}) : _jsx(SendGlyph, {}) })] })] })] })] }));
}
/** 渲染执行详情底部（composer 或接管面板）。 */
export function DiscussionInput({ t, status, steps, questions, permissions, pending, onPauseAll, onResumeAll, onResumeStep, onRetryStep, onReplyQuestion, onReplyPermission, onAbort, instanceId, modelDirectory, sessionPermissions, runCommand, queryPermission }) {
    // 接管面板：有 pending 权限 → ApprovalPanel；否则有 pending 问答 → QuestionComposer；
    // 均无 → 正常 composer（原型：接管时隐藏 composer）。
    if (permissions.length > 0) {
        return _jsx(ApprovalCard, { entry: permissions[0], steps: steps, t: t, pending: pending, onReply: onReplyPermission });
    }
    if (questions.length > 0) {
        return _jsx(QuestionCard, { entry: questions[0], steps: steps, t: t, pending: pending, onReply: onReplyQuestion });
    }
    return (_jsx(Composer, { t: t, status: status, steps: steps, pending: pending, onPauseAll: onPauseAll, onResumeAll: onResumeAll, onResumeStep: onResumeStep, onRetryStep: onRetryStep, onAbort: onAbort, instanceId: instanceId, modelDirectory: modelDirectory, sessionPermissions: sessionPermissions, runCommand: runCommand, queryPermission: queryPermission }));
}
//# sourceMappingURL=DiscussionInput.js.map