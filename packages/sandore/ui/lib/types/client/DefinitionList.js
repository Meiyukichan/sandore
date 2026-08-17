import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * DefinitionList：编排态工作流定义列表（平铺 + 删除确认 + 三态）。
 *
 * 经 `listDefinitions()` 拉取定义并平铺渲染（名称 / 版本 / 描述 / 更新时间），
 * 定义无 workspace 归属故不分组；点击定义行经 `onOpen` 下钻 DagEditor，删除按钮
 * 弹确认框，确认后 `deleteDefinition(id)`，成功本地移除、失败呈现错误。列表呈现
 * 三态：loading / empty / error（含重试）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/DefinitionList
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, IconTrashOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { formatTimestamp, matchesDefinitionQuery } from "./panel-model.js";
import { describeError } from "./describe-error.js";
import css from './WorkflowPanel.module.css';
/** 删除确认对话框：展示定义名，确认后回调定义 id，删除失败内联呈现错误。 */
function DeleteConfirmModal({ target, deleting, errorMessage, t, onCancel, onConfirm }) {
    return (_jsx(Modal, { open: true, onClose: onCancel, title: t('panel.delete.confirm.title'), closeLabel: t('panel.delete.confirm.cancel'), footer: (_jsxs(_Fragment, { children: [_jsx(Button, { variant: "ghost", size: "sm", disabled: deleting, onClick: onCancel, children: t('panel.delete.confirm.cancel') }), _jsx(Button, { variant: "primary", size: "sm", disabled: deleting, onClick: () => { onConfirm(target.id); }, children: t('panel.delete.confirm.submit') })] })), children: _jsxs("div", { className: css.deleteConfirm, children: [_jsx("p", { className: css.deleteConfirmText, children: t('panel.delete.confirm.body', { name: target.name }) }), errorMessage !== undefined && (_jsx("p", { className: css.error, role: "alert", children: t('panel.delete.failed', { message: errorMessage }) }))] }) }));
}
/** 渲染 DefinitionList。 */
export function DefinitionList({ t, query, listDefinitions, deleteDefinition, onOpen }) {
    const [state, setState] = useState({ kind: 'loading' });
    const [confirmTarget, setConfirmTarget] = useState(undefined);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState(undefined);
    const disposedRef = useRef(false);
    const refresh = useCallback(async () => {
        try {
            const definitions = await listDefinitions();
            if (!disposedRef.current)
                setState({ kind: 'ready', definitions });
        }
        catch (error) {
            if (!disposedRef.current)
                setState({ kind: 'error', message: describeError(error) });
        }
    }, [listDefinitions]);
    // 挂载时拉取一次（定义列表无轮询）；卸载后不再 setState。
    useEffect(() => {
        disposedRef.current = false;
        void refresh();
        return () => { disposedRef.current = true; };
    }, [refresh]);
    const runDelete = async (id) => {
        setDeleting(true);
        setDeleteError(undefined);
        try {
            await deleteDefinition(id);
            setState(current => (current.kind === 'ready'
                ? { kind: 'ready', definitions: current.definitions.filter(definition => definition.id !== id) }
                : current));
            setConfirmTarget(undefined);
        }
        catch (error) {
            setDeleteError(describeError(error));
        }
        finally {
            setDeleting(false);
        }
    };
    if (state.kind === 'loading') {
        return _jsx("p", { className: css.empty, children: t('panel.loading') });
    }
    if (state.kind === 'error') {
        return (_jsxs("div", { className: css.errorBox, children: [_jsx("p", { className: css.error, role: "alert", children: t('panel.error', { message: state.message }) }), _jsx(Button, { size: "sm", variant: "outline", onClick: () => { void refresh(); }, children: t('panel.retry') })] }));
    }
    if (state.definitions.length === 0) {
        return (_jsxs("div", { className: css.emptyBox, children: [_jsx("p", { className: css.empty, children: t('panel.empty.definitions') }), _jsx("p", { className: css.emptyHint, children: t('panel.empty.definitions.hint') })] }));
    }
    const filtered = state.definitions.filter(definition => matchesDefinitionQuery(definition, query));
    return (_jsxs(_Fragment, { children: [filtered.length === 0 ? (_jsx("p", { className: css.empty, children: t('panel.empty.nomatch') })) : (_jsx("ul", { className: css.rows, children: filtered.map(definition => (_jsxs("li", { className: css.row, children: [_jsx("button", { type: "button", className: css.rowAction, onClick: () => { onOpen(definition.id, definition.yaml); }, children: _jsxs("span", { className: css.rowBody, children: [_jsx("span", { className: css.rowName, children: definition.name }), _jsx("span", { className: css.rowCaption, children: `v${definition.version}${definition.description !== undefined ? ` · ${definition.description}` : ''} · ${formatTimestamp(definition.updatedAt)}` })] }) }), _jsx("button", { type: "button", className: css.deleteButton, "aria-label": t('panel.delete'), onClick: () => { setConfirmTarget(definition); setDeleteError(undefined); }, children: _jsx(IconTrashOutline16, {}) })] }, definition.id))) })), confirmTarget !== undefined && (_jsx(DeleteConfirmModal, { target: confirmTarget, deleting: deleting, errorMessage: deleteError, t: t, onCancel: () => { if (!deleting)
                    setConfirmTarget(undefined); }, onConfirm: id => { void runDelete(id); } }))] }));
}
//# sourceMappingURL=DefinitionList.js.map