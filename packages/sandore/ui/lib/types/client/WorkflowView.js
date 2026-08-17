import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * WorkflowView：conversation.view「工作流」tab 主体 —— VSCode 式双栏工作区。
 *
 * 左侧为工作流列表侧边栏（默认态实例列表 / 编排态定义列表，搜索 + toggle + 新增），
 * 右侧为编辑区：选择实例渲染 RunView（执行详情），选择定义渲染 DagEditor（编排器），
 * 未选择渲染占位提示。根节点带 `data-conversation-composer-overlay`（对齐
 * ui-trajectory）：composer 悬浮于底部预留条之上，工作区占满主区其余高度。
 * 选中态放在模块级 snapshot store（`createSnapshotStore`），跨会话/视图切换保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/WorkflowView
 */
import { useEffect, useSyncExternalStore, useState } from 'react';
import { Button, IconPlusOutline16, IconSearchOutline16, Input, Pill, } from '@deepseek-ai/dsh-client-ui-primitives';
import { InstanceList } from "./InstanceList.js";
import { DefinitionList } from "./DefinitionList.js";
import { DagEditor } from "./DagEditor.js";
import { RunView } from "./RunView.js";
import { describeError } from "./describe-error.js";
import css from './WorkflowView.module.css';
/**
 * 模块级选中态：跨会话/视图切换保留（避免每次打开 tab 重置）。
 * 自实现 getSnapshot/subscribe（DSH bundle 的 ModuleLoader 格式无法被 bundler
 * 静态分析出 `createSnapshotStore` 具名导出，故不依赖 dsh-client-runtime）。
 */
let selection = null;
const selectionListeners = new Set();
function getSelection() {
    return selection;
}
function setSelection(next) {
    selection = next;
    for (const listener of selectionListeners)
        listener();
}
function subscribeSelection(listener) {
    selectionListeners.add(listener);
    return () => { selectionListeners.delete(listener); };
}
/** 定义加载壳：拉取 YAML 后渲染 DagEditor（id 变化时重拉并重挂载）。 */
function DefinitionLoader({ t, definitionId, getYaml, save, onSaved }) {
    const [state, setState] = useState({ kind: 'loading' });
    // 拉取定义 YAML；组件卸载或 id 变化后丢弃过期结果。
    useEffect(() => {
        let alive = true;
        setState({ kind: 'loading' });
        getYaml(definitionId)
            .then(yaml => { if (alive)
            setState({ kind: 'ready', yaml }); })
            .catch(error => { if (alive)
            setState({ kind: 'error', message: describeError(error) }); });
        return () => { alive = false; };
    }, [definitionId, getYaml]);
    if (state.kind === 'loading') {
        return _jsx("p", { className: css.loading, children: t('panel.loading') });
    }
    if (state.kind === 'error') {
        return _jsx("p", { className: css.errorText, role: "alert", children: t('view.editor.error', { message: state.message }) });
    }
    return (_jsx(DagEditor, { t: t, initialYaml: state.yaml, initialId: definitionId, save: save, onSaved: onSaved }, definitionId));
}
/** 渲染 WorkflowView（双栏工作区）。 */
export function WorkflowView({ useWorkspaces, listInstances, listDefinitions, deleteDefinition, getYaml, save, remote, openSession, t, }) {
    const workspaces = useWorkspaces(state => state.items);
    const selection = useSyncExternalStore(subscribeSelection, getSelection);
    const [orchestrating, setOrchestrating] = useState(false);
    const [query, setQuery] = useState('');
    const [listKey, setListKey] = useState(0);
    const refreshList = () => { setListKey(key => key + 1); };
    const selectInstance = (instanceId) => {
        setSelection({ kind: 'instance', id: instanceId });
        refreshList();
    };
    const selectDefinition = (definitionId, initialYaml) => {
        setSelection({ kind: 'definition', id: definitionId, initialYaml });
        refreshList();
    };
    const selectNewDefinition = () => {
        setSelection({ kind: 'definition' });
        refreshList();
    };
    const renderEditor = () => {
        if (selection === null) {
            return _jsx("div", { className: css.placeholder, children: t('view.placeholder') });
        }
        if (selection.kind === 'instance') {
            return (_jsx(RunView, { t: t, instanceId: selection.id, openDiscussion: () => { openSession(selection.id); }, remote: remote }, selection.id));
        }
        if (selection.id !== undefined && selection.initialYaml === undefined) {
            return _jsx(DefinitionLoader, { t: t, definitionId: selection.id, getYaml: getYaml, save: save, onSaved: refreshList }, selection.id);
        }
        return (_jsx(DagEditor, { t: t, initialYaml: selection.initialYaml, initialId: selection.id, save: save, onSaved: refreshList }, selection.id ?? 'new'));
    };
    return (_jsxs("div", { className: css.root, "data-sandore-view": true, "data-conversation-composer-overlay": true, children: [_jsxs("div", { className: css.workspace, children: [_jsxs("aside", { className: css.sidebar, "data-sandore-view-sidebar": true, children: [_jsxs("header", { className: css.sidebarHeader, children: [_jsxs("div", { className: css.sidebarTitleRow, children: [_jsx("span", { className: css.sidebarTitle, children: t('panel.title') }), _jsx(Pill, { active: orchestrating, onClick: () => { setOrchestrating(value => !value); }, children: t('panel.orchestrate') })] }), _jsxs("div", { className: css.sidebarToolbar, children: [_jsx(Input, { className: css.search ?? '', icon: _jsx(IconSearchOutline16, {}), value: query, onChange: event => { setQuery(event.target.value); }, placeholder: t('panel.search'), "aria-label": t('panel.search') }), _jsx(Button, { size: "sm", variant: "primary", icon: _jsx(IconPlusOutline16, {}), disabled: !orchestrating, title: orchestrating ? undefined : t('panel.add.instance.hint'), onClick: selectNewDefinition, children: orchestrating ? t('panel.add.definition') : t('panel.add.instance') })] })] }), _jsx("div", { className: css.sidebarBody, "data-sandore-view-list": true, children: orchestrating ? (_jsx(DefinitionList, { t: t, query: query, listDefinitions: listDefinitions, deleteDefinition: deleteDefinition, onOpen: selectDefinition }, `def-${listKey}`)) : (_jsx(InstanceList, { t: t, workspaces: workspaces, query: query, listInstances: listInstances, onOpen: selectInstance }, `inst-${listKey}`)) })] }), _jsx("main", { className: css.editor, "data-sandore-view-editor": true, children: renderEditor() })] }), _jsx("div", { className: css.composerReserve, "aria-hidden": true })] }));
}
//# sourceMappingURL=WorkflowView.js.map