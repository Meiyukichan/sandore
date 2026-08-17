import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * InstanceList：默认态工作流实例列表（按工作区分组 + 3s 轮询 + 三态）。
 *
 * 经 `listInstances()` 拉取实例摘要，`useWorkspaces` 的 `WorkspaceView[].sessionIds`
 * 成员表把实例按归属分组（instanceId 命中即归组，未命中归「未分组」）；打开期间
 * 每 3s 递归 setTimeout 刷新（组件卸载即清理停止）。列表呈现三态：loading（加载中）、
 * empty（空态引导）、error（RPC 失败提示 + 重试）。点击实例行经 `onOpen` 下钻 RunView。
 * 分组派生与关键词过滤抽至 `panel-model.ts`（纯函数，可单测）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/InstanceList
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import { deriveGroups, formatTimestamp, matchesInstanceQuery } from "./panel-model.js";
import { describeError } from "./describe-error.js";
import { runDotState } from "./run-view-model.js";
import css from './WorkflowPanel.module.css';
/** 实例列表轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 3000;
/** 7 态实例生命周期状态词汇（用于把 wire 侧 string 安全收窄为 DagRunStatus）。 */
const DAG_RUN_STATUSES = ['pending', 'running', 'interacting', 'completed', 'failed', 'aborted', 'paused'];
/** 实例生命周期状态 → 本地化标签键（7 态，与 RunView 对齐）。 */
const STATUS_KEYS = {
    pending: 'run.status.pending',
    running: 'run.status.running',
    interacting: 'run.status.interacting',
    completed: 'run.status.completed',
    failed: 'run.status.failed',
    aborted: 'run.status.aborted',
    paused: 'run.status.paused',
};
/** 收窄 wire 侧 status 字符串为 7 态枚举（生成物拍平为 string，Host 实际返回 7 态）。 */
function isDagRunStatus(status) {
    return DAG_RUN_STATUSES.includes(status);
}
/** 7 态 status 字符串 → StateDotState（未知状态折入 warning，避免空状态点）。 */
function instanceDotState(status) {
    return isDagRunStatus(status) ? runDotState(status) : 'warning';
}
/** 渲染 InstanceList。 */
export function InstanceList({ t, workspaces, query, activeId, listInstances, onOpen }) {
    const [state, setState] = useState({ kind: 'loading' });
    // 轮询定时器与卸载标记：打开期间每 3s 刷新一次，卸载/收起面板即清理停止。
    const timerRef = useRef(undefined);
    const disposedRef = useRef(false);
    const refresh = useCallback(async () => {
        try {
            const instances = await listInstances();
            if (!disposedRef.current)
                setState({ kind: 'ready', instances });
        }
        catch (error) {
            if (!disposedRef.current)
                setState({ kind: 'error', message: describeError(error) });
        }
    }, [listInstances]);
    const refreshAndSchedule = useCallback(async () => {
        await refresh();
        if (disposedRef.current)
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
        void refreshAndSchedule();
        return () => {
            disposedRef.current = true;
            if (timerRef.current !== undefined) {
                clearTimeout(timerRef.current);
                timerRef.current = undefined;
            }
        };
    }, [refreshAndSchedule]);
    if (state.kind === 'loading') {
        return _jsx("p", { className: css.empty, children: t('panel.loading') });
    }
    if (state.kind === 'error') {
        return (_jsxs("div", { className: css.errorBox, children: [_jsx("p", { className: css.error, role: "alert", children: t('panel.error', { message: state.message }) }), _jsx(Button, { size: "sm", variant: "outline", onClick: () => { void refresh(); }, children: t('panel.retry') })] }));
    }
    if (state.instances.length === 0) {
        return (_jsxs("div", { className: css.emptyBox, children: [_jsx("p", { className: css.empty, children: t('panel.empty.instances') }), _jsx("p", { className: css.emptyHint, children: t('panel.empty.instances.hint') })] }));
    }
    const filtered = state.instances.filter(instance => matchesInstanceQuery(instance, query));
    const groups = deriveGroups(filtered, workspaces, t('panel.ungrouped'));
    if (groups.length === 0) {
        return _jsx("p", { className: css.empty, children: t('panel.empty.nomatch') });
    }
    return (_jsx("div", { className: css.listGroups, children: groups.map(group => (_jsxs("section", { className: css.groupSection, children: [_jsx("h3", { className: css.group, children: group.title }), _jsx("ul", { className: css.rows, children: group.instances.map(instance => (_jsx("li", { className: css.row, children: _jsxs("button", { type: "button", className: `${css.rowAction} ${activeId === instance.instanceId ? css.rowActive : ''}`, onClick: () => { onOpen(instance.instanceId); }, children: [_jsx(StateDot, { state: instanceDotState(instance.status) }), _jsxs("span", { className: css.rowBody, children: [_jsx("span", { className: css.rowName, children: instance.instanceId }), _jsx("span", { className: css.rowCaption, children: `${instance.jobId} · ${formatTimestamp(instance.updatedAt)}` })] }), _jsx("span", { className: css.rowStatus, children: isDagRunStatus(instance.status) ? t(STATUS_KEYS[instance.status]) : instance.status })] }) }, instance.instanceId))) })] }, group.key))) }));
}
//# sourceMappingURL=InstanceList.js.map