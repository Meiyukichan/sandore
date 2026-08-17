import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
/**
 * WorkflowOverlay：shell.overlay 全局工作流 UI（root scope，不挂会话）。
 *
 * 覆盖 conversation/details 列（sidebar 保持可见可点）：header（标题/刷新/关闭）+
 * 双栏工作台（左 WorkflowList + 分隔条 + 右 EditorPane）。sidebar 实测宽经
 * ResizeObserver 同步到 `--wf-left`，overlay 内容永远从 sidebar 右缘开始。
 * 打开/关闭/选中态全部在 `workflow-store`。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/WorkflowOverlay
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { IconCloseOutline16, IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { WorkflowList } from "./WorkflowList.js";
import { EditorPane } from "./EditorPane.js";
import { DragHandle } from "./DragHandle.js";
import { closeWorkflowOverlay, getWorkflowState, resizeListWidth, subscribeWorkflowState, } from "./workflow-store.js";
import css from './WorkflowOverlay.module.css';
/** 渲染 shell.overlay 全局工作流 UI（关闭时渲染 null）。 */
export function WorkflowOverlay({ useWorkspaces, listInstances, listDefinitions, listJobs, createJob, startInstance, deleteDefinition, getYaml, save, remote, openSession, t, }) {
    const open = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().open);
    const listWidth = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().listWidth);
    const workspaces = useWorkspaces(state => state.items);
    const [refreshKey, setRefreshKey] = useState(0);
    const layerRef = useRef(null);
    // sidebar 实测宽 → --wf-left：覆盖 conversation/details 列，sidebar 保持可见。
    // 注：`[data-slot="sidebar"]` 是 display:contents 的 0 宽 wrapper，需沿祖先链找
    // 第一个有实际宽度的元素（`.sidebarCol` grid 列），并观察它保持同步（拖拽/折叠）。
    useEffect(() => {
        const layer = layerRef.current;
        if (layer === null)
            return;
        let observed = null;
        const measure = () => {
            let el = document.querySelector('[data-slot="sidebar"]');
            let width = 0;
            while (el !== null && width <= 0) {
                width = el.getBoundingClientRect().width;
                if (width <= 0)
                    el = el.parentElement;
            }
            observed = el;
            layer.style.setProperty('--wf-left', `${width > 0 ? width : 248}px`);
        };
        measure();
        if (observed !== null) {
            const observer = new ResizeObserver(measure);
            observer.observe(observed);
            return () => { observer.disconnect(); };
        }
        return undefined;
    }, [open]);
    if (!open)
        return null;
    const face = {
        listInstances, listDefinitions, listJobs, createJob, startInstance,
        deleteDefinition, getYaml, save, remote, openSession,
    };
    return (_jsx("div", { className: css.layer, ref: layerRef, "data-sandore-overlay-layer": true, children: _jsxs("div", { className: css.overlay, "data-sandore-overlay": true, children: [_jsxs("header", { className: css.header, children: [_jsxs("span", { className: css.headerTitle, children: ["\uD83D\uDD00 ", t('panel.title')] }), _jsx("span", { className: css.spacer }), _jsx("button", { type: "button", className: css.iconBtn, "aria-label": t('overlay.refresh'), title: t('overlay.refresh'), onClick: () => { setRefreshKey(key => key + 1); }, children: _jsx(IconRefreshOutline16, {}) }), _jsx("button", { type: "button", className: css.iconBtn, "aria-label": t('overlay.close'), title: t('overlay.close'), "data-sandore-overlay-close": true, onClick: closeWorkflowOverlay, children: _jsx(IconCloseOutline16, {}) })] }), _jsxs("div", { className: css.body, children: [_jsx(WorkflowList, { t: t, workspaces: workspaces, face: face, refreshKey: refreshKey, width: listWidth }), _jsx(DragHandle, { side: "list", className: css.dragHandle, onDrag: resizeListWidth }), _jsx(EditorPane, { t: t, face: face, onSaved: () => { setRefreshKey(key => key + 1); } })] })] }) }));
}
//# sourceMappingURL=WorkflowOverlay.js.map