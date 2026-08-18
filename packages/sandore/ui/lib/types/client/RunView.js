import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * RunView：执行态三栏视图（树形导航 + 统一时间线/输入区 + 文件预览）。
 *
 * 数据源 = `getInstanceState` 轮询（运行中 5s，终态停）+ `getArtifacts` 初始化；
 * 树与时间线由纯函数从状态派生。交互：header（暂停全部/恢复全部/中止/刷新/打开讨论）、
 * 树叶子 → 右栏预览、输入区状态驱动（running 暂停 / paused 恢复 / failed 重试）、
 * 待处理问答/权限卡片在时间线下方。Step「查看详情」/树行 ↗ 跳子代理会话。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/RunView
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button, IconRefreshOutline16, IconStopFill16, Input, StateDot, } from '@deepseek-ai/dsh-client-ui-primitives';
import { unwrap } from "./remote.js";
import { describeError } from "./describe-error.js";
import { buildTimeline, buildRunTree, isBlank, isRunningStatus, isTerminalStatus, partitionInteractions, runDotState, } from "./run-view-model.js";
import { TreeNav } from "./TreeNav.js";
import { UnifiedTimeline } from "./UnifiedTimeline.js";
import { DiscussionInput } from "./DiscussionInput.js";
import { PreviewPanel } from "./PreviewPanel.js";
import { DragHandle } from "./DragHandle.js";
import { getWorkflowState, resizePreviewWidth, setWorkflowState, subscribeWorkflowState, } from "./workflow-store.js";
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
    return (_jsxs("div", { className: css.card, children: [_jsx("div", { className: css.cardHead, children: _jsx("span", { className: css.cardTitle, children: t('run.permission.title') }) }), _jsxs("div", { className: css.metaRow, children: [_jsx("span", { className: css.metaLabel, children: t('run.permission.patterns') }), _jsx("span", { children: entry.payload.permission })] }), entry.payload.tool !== undefined && (_jsxs("div", { className: css.metaRow, children: [_jsx("span", { className: css.metaLabel, children: t('run.permission.tool') }), _jsx("span", { children: entry.payload.tool })] })), entry.payload.patterns !== undefined && entry.payload.patterns.length > 0 && (_jsxs("div", { className: css.metaRow, children: [_jsx("span", { className: css.metaLabel, children: t('run.permission.patterns') }), _jsx("span", { children: entry.payload.patterns.join(', ') })] })), _jsxs("div", { className: css.permissionActions, children: [_jsx(Button, { size: "sm", variant: "primary", disabled: pending, onClick: () => { onReply(entry.requestId, 'once'); }, children: t('run.permission.once') }), _jsx(Button, { size: "sm", variant: "outline", disabled: pending, onClick: () => { onReply(entry.requestId, 'always'); }, children: t('run.permission.always') }), _jsx(Button, { size: "sm", variant: "ghost", disabled: pending, onClick: () => { onReply(entry.requestId, 'reject'); }, children: t('run.permission.reject') })] })] }));
}
/** 渲染 RunView（三栏）。 */
export function RunView({ t, instanceId, openSession, remote }) {
    const [loadState, setLoadState] = useState({ kind: 'loading' });
    const [actionState, setActionState] = useState({ kind: 'idle' });
    const treeWidth = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().treeWidth);
    const previewWidth = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().previewWidth);
    const preview = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().preview);
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
        await refreshAndSchedule();
    };
    const pauseAll = () => { void runAction(async () => { unwrap(await remote.pauseAll({ instanceId })); }); };
    const resumeAll = (resumePrompt) => { void runAction(async () => { unwrap(await remote.resumeAll({ instanceId, resumePrompt })); }); };
    const abort = () => { void runAction(async () => { unwrap(await remote.abortInstance(instanceId)); }); };
    const resumeStep = (stepId, resumePrompt) => { void runAction(async () => { unwrap(await remote.resumeStep({ instanceId, stepId, resumePrompt })); }); };
    const retryStep = (stepId, mode, message) => { void runAction(async () => { unwrap(await remote.retryStep({ instanceId, stepId, mode, message })); }); };
    const replyQuestion = (requestId, answers) => {
        void runAction(async () => { unwrap(await remote.replyQuestion({ instanceId, requestId, answers: { answers } })); });
    };
    const replyPermission = (requestId, reply) => {
        void runAction(async () => { unwrap(await remote.replyPermission({ instanceId, requestId, reply })); });
    };
    const state = loadState.kind === 'ready' ? loadState.state : undefined;
    const tree = useMemo(() => (state === undefined ? [] : buildRunTree(state)), [state]);
    const timeline = useMemo(() => (state === undefined ? [] : buildTimeline(state)), [state]);
    const { questions, permissions } = state === undefined
        ? { questions: [], permissions: [] }
        : partitionInteractions(state.pendingInteractions);
    const selectLeaf = (selection) => {
        setWorkflowState({ preview: selection });
    };
    const closePreview = () => {
        setWorkflowState({ preview: null });
    };
    const pending = actionState.kind === 'pending';
    return (_jsx("section", { className: css.runView, "aria-label": t('run.title'), "data-sandore-run-view": true, children: _jsxs("div", { className: css.columns, children: [_jsx("aside", { style: { width: treeWidth }, className: css.treeCol, children: _jsx(TreeNav, { t: t, tree: tree, activePreviewId: preview?.leafId ?? null, onSelectLeaf: selectLeaf, onOpenChild: openSession }) }), _jsxs("div", { className: css.mainCol, children: [_jsxs("header", { className: css.header, children: [_jsx("span", { className: css.title, children: t('run.title') }), state !== undefined && (_jsxs("span", { className: css.statusBadge, children: [_jsx(StateDot, { state: runDotState(state.status) }), _jsx("span", { children: t(RUN_STATUS_KEYS[state.status]) })] })), _jsx("span", { className: css.spacer }), state !== undefined && isRunningStatus(state.status) && (_jsx(Button, { size: "sm", variant: "ghost", disabled: pending, onClick: pauseAll, children: t('run.pauseAll') })), state !== undefined && state.status === 'paused' && (_jsx(Button, { size: "sm", variant: "ghost", disabled: pending, onClick: () => { resumeAll(''); }, children: t('run.resumeAll') })), state !== undefined && !isTerminalStatus(state.status) && (_jsx(Button, { size: "sm", variant: "ghost", icon: _jsx(IconStopFill16, {}), disabled: pending, onClick: abort, "aria-label": t('run.abort') })), _jsx(Button, { size: "sm", variant: "ghost", icon: _jsx(IconRefreshOutline16, {}), onClick: () => { void refreshAndSchedule(); }, "aria-label": t('run.refresh') }), _jsx(Button, { size: "sm", variant: "outline", onClick: () => { openSession(instanceId); }, children: t('run.discuss') })] }), loadState.kind === 'loading' && _jsx("p", { className: css.loading, children: t('run.loading') }), loadState.kind === 'error' && _jsx("p", { className: css.error, role: "alert", children: t('run.error', { message: loadState.message }) }), actionState.kind === 'error' && _jsx("p", { className: css.error, role: "alert", children: actionState.message }), loadState.kind === 'ready' && state !== undefined && (_jsxs(_Fragment, { children: [_jsx(UnifiedTimeline, { t: t, items: timeline, openSession: openSession }), (questions.length > 0 || permissions.length > 0) && (_jsxs("div", { className: css.interactions, children: [questions.map(entry => (_jsx(QuestionCard, { entry: entry, t: t, pending: pending, onReply: replyQuestion }, entry.id))), permissions.map(entry => (_jsx(PermissionCard, { entry: entry, t: t, pending: pending, onReply: replyPermission }, entry.id)))] })), _jsx(DiscussionInput, { t: t, status: state.status, steps: state.executedSteps, pending: pending, onPauseAll: pauseAll, onResumeAll: resumeAll, onResumeStep: resumeStep, onRetryStep: retryStep })] }))] }), preview !== null && (_jsxs(_Fragment, { children: [_jsx(DragHandle, { side: "preview", className: css.dragHandle, onDrag: resizePreviewWidth }), _jsx("div", { style: { width: previewWidth }, className: css.previewCol, children: _jsx(PreviewPanel, { t: t, target: preview, onClose: closePreview }) })] }))] }) }));
}
//# sourceMappingURL=RunView.js.map