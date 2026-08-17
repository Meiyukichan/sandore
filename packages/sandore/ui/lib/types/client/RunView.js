import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * RunView：工作流实例执行详情（执行轨迹只读视图 + 产物面板 + 交互控件 + 打开讨论）。
 *
 * 经 `remote.getInstanceState(instanceId)` 拉取 `WorkflowTaskState`，按 `stageInfos`
 * 分组只读渲染 `executedSteps`（每 Step：7 态状态图标、名称、`visitCount` 徽章、
 * 错误信息）；产物面板经 `remote.getArtifacts(instanceId)` 分层显示（Stage → Step →
 * 文件/回答）。实例运行中（running/interacting）时每 5s 轮询状态与产物，终态或卸载
 * 停止；交互控件（实例级 pauseAll/resumeAll/abort，Step 级 pauseStep/resumeStep/
 * retryStep，问答 replyQuestion、权限 replyPermission）调用后立即手动刷新。头部
 * 「打开讨论」经 `openDiscussion` 回调跳宿主会话。以普通 props 提供（非 slot 子组件），
 * 供 WorkflowPanel 下钻承载。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/RunView
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, DisclosureRow, IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14, IconPauseOutline16, IconPlayOutline16, IconRefreshOutline16, IconStopFill16, Input, Modal, Pill, StateDot, } from '@deepseek-ai/dsh-client-ui-primitives';
import { unwrap } from "./remote.js";
import { describeError } from "./describe-error.js";
import { isBlank, isRunningStatus, isSubagentStep, isTerminalStatus, partitionInteractions, RETRY_MODES, runDotState, stepDotState, stepIdOf, } from "./run-view-model.js";
import css from './RunView.module.css';
/** 轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 5000;
/** 实例生命周期状态 → 本地化标签键。 */
const RUN_STATUS_KEYS = {
    pending: 'run.status.pending',
    running: 'run.status.running',
    interacting: 'run.status.interacting',
    completed: 'run.status.completed',
    failed: 'run.status.failed',
    aborted: 'run.status.aborted',
    paused: 'run.status.paused',
};
/** Step 执行状态 → 本地化标签键。 */
const STEP_STATUS_KEYS = {
    blocked: 'run.step.status.blocked',
    ready: 'run.step.status.ready',
    interacting: 'run.step.status.interacting',
    running: 'run.step.status.running',
    completed: 'run.step.status.completed',
    failed: 'run.step.status.failed',
    paused: 'run.step.status.paused',
};
/** 重试模式 → 本地化标签键。 */
const RETRY_MODE_KEYS = {
    continue: 'run.retry.mode.continue',
    revert: 'run.retry.mode.revert',
    fork: 'run.retry.mode.fork',
};
/** 单个执行 Step 的只读行：状态图标 + 名称 + visitCount 徽章 + 状态文本 + 错误 + Step 级控件。 */
function StepRow({ step, t, pending, onPause, onResume, onRetry }) {
    const stepId = stepIdOf(step);
    // 仅子代理 Step（agent/skill/mcp）可暂停/恢复/重试；shell/prompt 合成 Step
    // 无真实子代理，引擎会拒绝这些操作，故不渲染其控件。
    const controllable = isSubagentStep(step);
    return (_jsxs("div", { className: css.step, children: [_jsxs("div", { className: css.stepHead, children: [_jsx(StateDot, { state: stepDotState(step.status) }), _jsx("span", { className: css.stepName, children: step.name }), _jsx(Pill, { className: css.visitBadge, "aria-label": t('run.visitCount', { count: step.visitCount }), children: step.visitCount }), _jsx("span", { className: css.stepStatus, children: t(STEP_STATUS_KEYS[step.status]) }), _jsxs("span", { className: css.stepActions, children: [controllable && (step.status === 'running' || step.status === 'interacting') && (_jsx(Button, { size: "sm", variant: "ghost", icon: _jsx(IconPauseOutline16, {}), disabled: pending, "aria-label": t('run.step.pause'), onClick: () => { onPause(stepId); } })), controllable && step.status === 'paused' && (_jsx(Button, { size: "sm", variant: "ghost", icon: _jsx(IconPlayOutline16, {}), disabled: pending, "aria-label": t('run.step.resume'), onClick: () => { onResume(stepId); } })), controllable && step.status === 'failed' && (_jsx(Button, { size: "sm", variant: "outline", disabled: pending, onClick: () => { onRetry(stepId); }, children: t('run.step.retry') }))] })] }), step.error !== undefined && (_jsx("div", { className: css.stepError, children: step.error }))] }));
}
/** Stage 分组：DisclosureRow 折叠（名称 + Step 数）+ 展开 Step 只读列表。 */
function StageGroup({ stage, steps, expanded, onToggle, t, pending, onPause, onResume, onRetry }) {
    return (_jsx(DisclosureRow, { icon: _jsx(IconChevronRightOutline14, {}), title: stage.name, open: expanded, expandable: true, onToggle: onToggle, expandOnRowClick: true, rowClassName: css.stageHeader, collapsedContent: _jsx("span", { className: css.stepCount, children: steps.length }), children: _jsx("div", { className: css.steps, children: steps.length === 0 ? (_jsx("span", { className: css.empty, children: t('run.trajectory.empty') })) : (steps.map(step => (_jsx(StepRow, { step: step, t: t, pending: pending, onPause: onPause, onResume: onResume, onRetry: onRetry }, step.id)))) }) }));
}
/** 单个待答问题条目：渲染各问题的选项（单选/多选）或自由文本输入，提交经 onReply。 */
function QuestionCard({ entry, t, pending, onReply }) {
    const questions = entry.payload.questions;
    const [selections, setSelections] = useState({});
    const [customs, setCustoms] = useState({});
    const answered = questions.every(question => {
        if (question.options !== undefined && question.options.length > 0) {
            return (selections[question.id] ?? []).length > 0;
        }
        return !isBlank(customs[question.id] ?? '');
    });
    const toggleOption = (questionId, label, multi) => {
        setSelections(current => {
            const selected = current[questionId] ?? [];
            const next = multi
                ? (selected.includes(label) ? selected.filter(item => item !== label) : [...selected, label])
                : [label];
            return { ...current, [questionId]: next };
        });
    };
    const submit = () => {
        const answers = questions.map(question => {
            if (question.options !== undefined && question.options.length > 0) {
                return { id: question.id, selected: [...(selections[question.id] ?? [])] };
            }
            const custom = customs[question.id] ?? '';
            return { id: question.id, selected: [], ...(custom === '' ? {} : { custom }) };
        });
        onReply(entry.requestId, answers);
    };
    return (_jsxs("div", { className: css.card, children: [questions.map(question => (_jsxs("div", { className: css.question, children: [question.header !== undefined && _jsx("span", { className: css.questionHeader, children: question.header }), _jsx("span", { className: css.questionText, children: question.question }), question.options !== undefined && question.options.length > 0 ? (_jsx("div", { className: css.options, role: "group", children: question.options.map(option => {
                            const checked = (selections[question.id] ?? []).includes(option.label);
                            return (_jsxs("label", { className: css.option, children: [_jsx("input", { type: question.multi_select === true ? 'checkbox' : 'radio', name: question.id, checked: checked, onChange: () => { toggleOption(question.id, option.label, question.multi_select === true); } }), _jsx("span", { className: css.optionLabel, children: option.label }), option.description !== undefined && _jsx("span", { className: css.optionDesc, children: option.description })] }, option.label));
                        }) })) : (_jsx(Input, { value: customs[question.id] ?? '', onChange: event => { setCustoms(current => ({ ...current, [question.id]: event.target.value })); }, placeholder: t('run.question.placeholder') }))] }, question.id))), _jsx(Button, { size: "sm", variant: "primary", disabled: !answered || pending, onClick: submit, children: t('run.question.submit') })] }));
}
/** 单个待批权限条目：展示权限/工具/路径模式，应答经 onReply（once/always/reject）。 */
function PermissionCard({ entry, t, pending, onReply }) {
    return (_jsxs("div", { className: css.card, children: [_jsxs("div", { className: css.cardHead, children: [_jsx(IconCheckOutline16, {}), _jsx("span", { className: css.cardTitle, children: entry.payload.permission })] }), entry.payload.tool !== undefined && (_jsxs("div", { className: css.metaRow, children: [_jsx("span", { className: css.metaLabel, children: t('run.permission.tool') }), _jsx("span", { children: entry.payload.tool })] })), entry.payload.patterns !== undefined && entry.payload.patterns.length > 0 && (_jsxs("div", { className: css.metaRow, children: [_jsx("span", { className: css.metaLabel, children: t('run.permission.patterns') }), _jsx("span", { children: entry.payload.patterns.join(', ') })] })), _jsxs("div", { className: css.permissionActions, children: [_jsx(Button, { size: "sm", variant: "primary", disabled: pending, onClick: () => { onReply(entry.requestId, 'once'); }, children: t('run.permission.once') }), _jsx(Button, { size: "sm", variant: "outline", disabled: pending, onClick: () => { onReply(entry.requestId, 'always'); }, children: t('run.permission.always') }), _jsx(Button, { size: "sm", variant: "ghost", disabled: pending, onClick: () => { onReply(entry.requestId, 'reject'); }, children: t('run.permission.reject') })] })] }));
}
/** 产物面板：按 Stage → Step → 文件/回答 分层只读显示。 */
function ArtifactPanel({ artifacts, stages, t }) {
    if (artifacts.length === 0) {
        return _jsx("p", { className: css.empty, children: t('run.artifacts.empty') });
    }
    const byStage = new Map();
    for (const entry of artifacts) {
        const list = byStage.get(entry.stageId);
        if (list === undefined) {
            byStage.set(entry.stageId, [entry]);
        }
        else {
            list.push(entry);
        }
    }
    return (_jsx("div", { className: css.artifacts, children: [...byStage.entries()].map(([stageId, entries]) => (_jsxs("div", { className: css.artifactStage, children: [_jsx("div", { className: css.artifactStageName, children: stages.find(stage => stage.id === stageId)?.name ?? stageId }), entries.map(entry => (_jsxs("div", { className: css.artifactStep, children: [_jsx("div", { className: css.artifactStepName, children: entry.stepId }), entry.files.length > 0 && (_jsxs("div", { className: css.artifactBlock, children: [_jsx("span", { className: css.metaLabel, children: t('run.artifacts.files') }), _jsx("ul", { className: css.fileList, children: entry.files.map(file => (_jsx("li", { className: css.file, children: file }, file))) })] })), entry.returnPrompt !== undefined && (_jsxs("div", { className: css.artifactBlock, children: [_jsx("span", { className: css.metaLabel, children: t('run.artifacts.returnPrompt') }), _jsx("p", { className: css.returnText, children: entry.returnPrompt })] }))] }, `${entry.stepId}-${entry.outputToId ?? ''}`)))] }, stageId))) }));
}
/** 重试表单对话框：模式选择（continue/revert/fork）+ 说明输入 + 提交。 */
function RetryModal({ t, mode, message, messageError, pending, onClose, onChangeMode, onChangeMessage, onSubmit }) {
    return (_jsx(Modal, { open: true, onClose: onClose, title: t('run.retry.title'), closeLabel: t('run.retry.cancel'), footer: (_jsxs(_Fragment, { children: [_jsx(Button, { variant: "ghost", size: "sm", onClick: onClose, children: t('run.retry.cancel') }), _jsx(Button, { variant: "primary", size: "sm", disabled: pending, onClick: onSubmit, children: t('run.retry.submit') })] })), children: _jsxs("div", { className: css.retryForm, children: [_jsx("div", { className: css.retryModes, role: "group", "aria-label": t('run.retry.mode'), children: RETRY_MODES.map(candidate => (_jsx(Pill, { active: candidate === mode, onClick: () => { onChangeMode(candidate); }, children: t(RETRY_MODE_KEYS[candidate]) }, candidate))) }), _jsx(Input, { value: message, onChange: event => { onChangeMessage(event.target.value); }, placeholder: t('run.retry.message') }), messageError && _jsx("p", { className: css.error, role: "alert", children: t('run.retry.message.required') })] }) }));
}
/** RunView 就绪态主体：轨迹 + 待处理交互 + 产物。 */
function RunBody({ state, artifacts, t, pending, onPause, onResume, onRetry, onReplyQuestion, onReplyPermission }) {
    const [collapsedStageIds, setCollapsedStageIds] = useState(() => new Set());
    const { questions, permissions } = partitionInteractions(state.pendingInteractions);
    const toggleStage = (stageId) => {
        setCollapsedStageIds(current => {
            const next = new Set(current);
            if (next.has(stageId)) {
                next.delete(stageId);
            }
            else {
                next.add(stageId);
            }
            return next;
        });
    };
    return (_jsxs("div", { className: css.body, children: [_jsxs("section", { className: css.section, children: [_jsx("h3", { className: css.sectionTitle, children: t('run.trajectory.title') }), _jsx("div", { className: css.trajectory, children: state.stageInfos.map((stage, index) => {
                            const steps = state.executedSteps.filter(step => step.stageId === stage.id);
                            return (_jsxs("div", { className: css.stageWrap, children: [_jsx(StageGroup, { stage: stage, steps: steps, expanded: !collapsedStageIds.has(stage.id), onToggle: () => { toggleStage(stage.id); }, t: t, pending: pending, onPause: onPause, onResume: onResume, onRetry: onRetry }), index < state.stageInfos.length - 1 && (_jsx("div", { className: css.connector, "aria-hidden": true, children: _jsx(IconChevronDownOutline14, {}) }))] }, stage.id));
                        }) })] }), (questions.length > 0 || permissions.length > 0) && (_jsxs("section", { className: css.section, children: [_jsx("h3", { className: css.sectionTitle, children: t('run.interactions.title') }), _jsxs("div", { className: css.cards, children: [questions.map(entry => (_jsx(QuestionCard, { entry: entry, t: t, pending: pending, onReply: onReplyQuestion }, entry.id))), permissions.map(entry => (_jsx(PermissionCard, { entry: entry, t: t, pending: pending, onReply: onReplyPermission }, entry.id)))] })] })), _jsxs("section", { className: css.section, children: [_jsx("h3", { className: css.sectionTitle, children: t('run.artifacts.title') }), _jsx(ArtifactPanel, { artifacts: artifacts, stages: state.stageInfos, t: t })] })] }));
}
/** 渲染 RunView。 */
export function RunView({ t, instanceId, openDiscussion, remote }) {
    const [loadState, setLoadState] = useState({ kind: 'loading' });
    const [actionState, setActionState] = useState({ kind: 'idle' });
    const [retryState, setRetryState] = useState({ kind: 'closed' });
    const refresh = useCallback(async () => {
        try {
            const [stateResult, artifactsResult] = await Promise.all([
                remote.getInstanceState(instanceId),
                remote.getArtifacts(instanceId),
            ]);
            // RunViewRemote 最小接口把 getInstanceState 标为 unknown，Host 实际返回 WorkflowTaskState。
            const state = unwrap(stateResult);
            const artifacts = unwrap(artifactsResult);
            setLoadState({ kind: 'ready', state, artifacts });
            return state.status;
        }
        catch (error) {
            setLoadState({ kind: 'error', message: describeError(error) });
            return undefined;
        }
    }, [instanceId, remote]);
    // 轮询定时器与卸载标记（提升为 ref，使动作后也能复用调度链）。
    const timerRef = useRef(undefined);
    const disposedRef = useRef(false);
    // 拉取一次并按状态调度下一次轮询：运行中（running/interacting）且无活跃 timer
    // 时启动 5s tick 链；终态、加载失败或已卸载则停止。
    const refreshAndSchedule = useCallback(async () => {
        const status = await refresh();
        if (disposedRef.current || status === undefined || !isRunningStatus(status))
            return;
        if (timerRef.current === undefined) {
            timerRef.current = setTimeout(() => {
                timerRef.current = undefined;
                void refreshAndSchedule();
            }, POLL_INTERVAL_MS);
        }
    }, [refresh]);
    // 首拉 + 运行中 5s 轮询；卸载清理 timer 并阻止迟到 tick 继续调度。
    useEffect(() => {
        disposedRef.current = false;
        setLoadState({ kind: 'loading' });
        void refreshAndSchedule();
        return () => {
            disposedRef.current = true;
            if (timerRef.current !== undefined) {
                clearTimeout(timerRef.current);
                timerRef.current = undefined;
            }
        };
    }, [refreshAndSchedule]);
    const runAction = async (action) => {
        setActionState({ kind: 'pending' });
        try {
            await action();
        }
        catch (error) {
            setActionState({ kind: 'error', message: describeError(error) });
            return;
        }
        setActionState({ kind: 'idle' });
        // 动作后立即刷新，并在状态回到 running/interacting（如 paused→resume）时重启轮询链。
        await refreshAndSchedule();
    };
    const pauseAll = () => { void runAction(async () => { unwrap(await remote.pauseAll({ instanceId })); }); };
    const resumeAll = () => { void runAction(async () => { unwrap(await remote.resumeAll({ instanceId })); }); };
    const abort = () => { void runAction(async () => { unwrap(await remote.abortInstance(instanceId)); }); };
    const pauseStep = (stepId) => { void runAction(async () => { unwrap(await remote.pauseStep({ instanceId, stepId })); }); };
    const resumeStep = (stepId) => { void runAction(async () => { unwrap(await remote.resumeStep({ instanceId, stepId })); }); };
    const replyQuestion = (requestId, answers) => {
        void runAction(async () => { unwrap(await remote.replyQuestion({ instanceId, requestId, answers: { answers } })); });
    };
    const replyPermission = (requestId, reply) => {
        void runAction(async () => { unwrap(await remote.replyPermission({ instanceId, requestId, reply })); });
    };
    const beginRetry = (stepId) => { setRetryState({ kind: 'open', stepId, mode: 'revert', message: '', messageError: false }); };
    const submitRetry = () => {
        if (retryState.kind !== 'open')
            return;
        if (isBlank(retryState.message)) {
            setRetryState({ ...retryState, messageError: true });
            return;
        }
        const { stepId, mode, message } = retryState;
        void runAction(async () => { unwrap(await remote.retryStep({ instanceId, stepId, mode, message })); });
        setRetryState({ kind: 'closed' });
    };
    return (_jsxs("section", { className: css.runView, "aria-label": t('run.title'), "data-sandore-run-view": true, children: [_jsxs("header", { className: css.header, children: [_jsx("span", { className: css.title, children: t('run.title') }), loadState.kind === 'ready' && (_jsxs("span", { className: css.statusBadge, children: [_jsx(StateDot, { state: runDotState(loadState.state.status) }), _jsx("span", { children: t(RUN_STATUS_KEYS[loadState.state.status]) })] })), _jsx("span", { className: css.spacer }), loadState.kind === 'ready' && isRunningStatus(loadState.state.status) && (_jsx(Button, { size: "sm", variant: "ghost", disabled: actionState.kind === 'pending', onClick: pauseAll, children: t('run.pauseAll') })), loadState.kind === 'ready' && loadState.state.status === 'paused' && (_jsx(Button, { size: "sm", variant: "ghost", disabled: actionState.kind === 'pending', onClick: resumeAll, children: t('run.resumeAll') })), loadState.kind === 'ready' && !isTerminalStatus(loadState.state.status) && (_jsx(Button, { size: "sm", variant: "ghost", icon: _jsx(IconStopFill16, {}), disabled: actionState.kind === 'pending', onClick: abort, "aria-label": t('run.abort') })), _jsx(Button, { size: "sm", variant: "ghost", icon: _jsx(IconRefreshOutline16, {}), onClick: () => { void refreshAndSchedule(); }, "aria-label": t('run.refresh') }), _jsx(Button, { size: "sm", variant: "outline", onClick: openDiscussion, children: t('run.discuss') })] }), loadState.kind === 'loading' && _jsx("p", { className: css.loading, children: t('run.loading') }), loadState.kind === 'error' && _jsx("p", { className: css.error, role: "alert", children: t('run.error', { message: loadState.message }) }), actionState.kind === 'error' && _jsx("p", { className: css.error, role: "alert", children: actionState.message }), loadState.kind === 'ready' && (_jsx(RunBody, { state: loadState.state, artifacts: loadState.artifacts, t: t, pending: actionState.kind === 'pending', onPause: pauseStep, onResume: resumeStep, onRetry: beginRetry, onReplyQuestion: replyQuestion, onReplyPermission: replyPermission })), retryState.kind === 'open' && (_jsx(RetryModal, { t: t, mode: retryState.mode, message: retryState.message, messageError: retryState.messageError, pending: actionState.kind === 'pending', onClose: () => { setRetryState({ kind: 'closed' }); }, onChangeMode: mode => { setRetryState(current => (current.kind === 'open' ? { ...current, mode } : current)); }, onChangeMessage: message => { setRetryState(current => (current.kind === 'open' ? { ...current, message, messageError: false } : current)); }, onSubmit: submitRetry }))] }));
}
//# sourceMappingURL=RunView.js.map