import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * RunView：执行态视图（树形导航 + 执行详情页）。
 *
 * 执行详情按 `docs/design/execution-detail-prototype.html` 原型实现：
 * multica Issue 页面骨架（面包屑 header + 固定 head + 滚动 feed + 底部 composer）×
 * DSH 多 agent 对话流（用户右气泡 + agent 左流式）× DSH composer 接管面板
 * （权限申请 ApprovalPanel / 问题选择 QuestionComposer）。
 *
 * 数据源 = `getInstanceState` 轮询（运行中 5s，终态停）+ `getArtifacts` 初始化；
 * 对话流与 agent 消息由纯函数从状态派生。agent 标题点击 → `openSession(childId)`
 * 打开 DSH 现成的子代理会话页（复用，不重复实现）；暂停/恢复/重试/中止集中在
 * 底部 composer（接管面板期间隐藏）；权限/问答待办以 composer 接管面板呈现。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/RunView
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { unwrap } from "./remote.js";
import { describeError } from "./describe-error.js";
import { buildTimeline, buildRunTree, isRunningStatus, lastActiveSegmentsOf, partitionInteractions, } from "./run-view-model.js";
import { TreeNav } from "./TreeNav.js";
import { UnifiedTimeline } from "./UnifiedTimeline.js";
import { DiscussionInput } from "./DiscussionInput.js";
import { PreviewPanel } from "./PreviewPanel.js";
import { DragHandle } from "./DragHandle.js";
import { getWorkflowState, resizePreviewWidth, setWorkflowState, subscribeWorkflowState, } from "./workflow-store.js";
import css from './RunView.module.css';
/** 轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 5000;
/** 渲染 RunView（树形导航 + 执行详情页）。 */
export function RunView({ t, instanceId, openSession, remote, modelDirectory, permissions: sessionPermissionsOf, runCommand, queryPermission }) {
    const [loadState, setLoadState] = useState({ kind: 'loading' });
    const [actionState, setActionState] = useState({ kind: 'idle' });
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
    // 「N 个正在工作」：已开始且未结束的 Step（running/interacting/paused）。
    const workingCount = state === undefined
        ? 0
        : state.executedSteps.filter(step => step.status === 'running' || step.status === 'interacting' || step.status === 'paused').length;
    const selectLeaf = (selection) => {
        setWorkflowState({ preview: selection });
    };
    const closePreview = () => {
        setWorkflowState({ preview: null });
    };
    const pending = actionState.kind === 'pending';
    // 会话权限投影面（绑定当前实例会话，供 composer 权限选择器订阅）。
    const permissionsFace = useMemo(() => sessionPermissionsOf(instanceId), [sessionPermissionsOf, instanceId]);
    const workflowName = state?.workflowName ?? state?.workflowId ?? '';
    const rawInput = state?.originalInput ?? '';
    return (_jsxs("section", { className: css.runView, "aria-label": t('run.title'), "data-sandore-run-view": true, children: [_jsxs("header", { className: css.pageHeader, children: [_jsxs("nav", { className: css.crumb, children: [_jsx("span", { className: css.seg, children: _jsx("span", { className: css.crumbItem, children: workflowName }) }), _jsx("span", { className: css.sep, "aria-hidden": true, children: "/" }), _jsx("span", { className: css.seg, children: _jsx("span", { className: `${css.crumbItem} ${css.crumbCurrent}`, title: rawInput, children: rawInput }) })] }), _jsx("div", { className: css.headerActions, children: state !== undefined && workingCount > 0 && (_jsxs("span", { className: css.agentChip, children: [_jsx("span", { className: css.agentDot, "aria-hidden": true }), t('run.workingAgents', { count: workingCount })] })) })] }), _jsxs("div", { className: css.detailSplit, children: [_jsx("div", { className: css.navCol, children: _jsx(TreeNav, { t: t, tree: tree, activePreviewId: preview?.leafId ?? null, onSelectLeaf: selectLeaf, onOpenChild: openSession }) }), _jsxs("div", { className: css.feedCol, children: [_jsx("div", { className: css.feedScroll, children: _jsxs("div", { className: css.column, children: [loadState.kind === 'loading' && _jsx("p", { className: css.loading, children: t('run.loading') }), loadState.kind === 'error' && _jsx("p", { className: css.error, role: "alert", children: t('run.error', { message: loadState.message }) }), actionState.kind === 'error' && _jsx("p", { className: css.error, role: "alert", children: actionState.message }), loadState.kind === 'ready' && state !== undefined && (_jsx(UnifiedTimeline, { t: t, items: timeline, openSession: openSession }))] }) }), loadState.kind === 'ready' && state !== undefined && (_jsx("div", { className: css.composerWrap, children: _jsx(DiscussionInput, { t: t, status: state.status, steps: lastActiveSegmentsOf(state.executedSteps), questions: questions, permissions: permissions, pending: pending, onPauseAll: pauseAll, onResumeAll: resumeAll, onResumeStep: resumeStep, onRetryStep: retryStep, onReplyQuestion: replyQuestion, onReplyPermission: replyPermission, onAbort: abort, instanceId: instanceId, modelDirectory: modelDirectory, sessionPermissions: permissionsFace, runCommand: runCommand, queryPermission: () => queryPermission(instanceId) }) }))] }), preview !== null && (_jsxs(_Fragment, { children: [_jsx(DragHandle, { side: "preview", className: css.dragHandle, onDrag: resizePreviewWidth }), _jsx("div", { style: { width: previewWidth }, className: css.previewCol, children: _jsx(PreviewPanel, { t: t, target: preview, onClose: closePreview }) })] }))] })] }));
}
//# sourceMappingURL=RunView.js.map