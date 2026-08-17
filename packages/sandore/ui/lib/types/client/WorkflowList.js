import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * WorkflowList：工作流 overlay 左栏列表（实例/定义 toggle + 搜索 + 新增）。
 *
 * 模式切换与选中态走模块级 `workflow-store`（跨 overlay 开合保留）；内容区复用
 * `InstanceList`（默认态实例，3s 轮询）与 `DefinitionList`（编排态定义）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/WorkflowList
 */
import { useState, useSyncExternalStore } from 'react';
import { Button, IconPlusOutline16, IconSearchOutline16, Input, } from '@deepseek-ai/dsh-client-ui-primitives';
import { InstanceList } from "./InstanceList.js";
import { DefinitionList } from "./DefinitionList.js";
import { getWorkflowState, newDefinition, selectDefinition, selectInstance, setWorkflowState, subscribeWorkflowState, } from "./workflow-store.js";
import css from './WorkflowOverlay.module.css';
/** 渲染工作流 overlay 左栏列表。 */
export function WorkflowList({ t, workspaces, face, refreshKey, width }) {
    const listMode = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().listMode);
    const selectedInstanceId = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().selectedInstanceId);
    const selectedDefinitionId = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().selectedDefinition?.id);
    const [query, setQuery] = useState('');
    return (_jsxs("section", { className: css.list, style: { width }, "data-sandore-wf-list": true, children: [_jsxs("header", { className: css.listHeader, children: [_jsxs("div", { className: css.listTitleRow, children: [_jsx("span", { className: css.listTitle, children: t('panel.title') }), _jsxs("div", { className: css.toggle, role: "tablist", "aria-label": t('list.mode.switch'), children: [_jsx("span", { className: `${css.toggleThumb} ${listMode === 'definition' ? css.toggleThumbRight : ''}` }), _jsx("button", { type: "button", role: "tab", "aria-selected": listMode === 'instance', className: listMode === 'instance' ? css.toggleActive : '', onClick: () => { setWorkflowState({ listMode: 'instance' }); }, children: t('list.mode.instance') }), _jsx("button", { type: "button", role: "tab", "aria-selected": listMode === 'definition', className: listMode === 'definition' ? css.toggleActive : '', onClick: () => { setWorkflowState({ listMode: 'definition' }); }, children: t('list.mode.definition') })] })] }), _jsxs("div", { className: css.listToolbar, children: [_jsx(Input, { className: css.search ?? '', icon: _jsx(IconSearchOutline16, {}), value: query, onChange: event => { setQuery(event.target.value); }, placeholder: t('panel.search'), "aria-label": t('panel.search') }), _jsx(Button, { size: "sm", variant: "primary", icon: _jsx(IconPlusOutline16, {}), disabled: listMode === 'instance', title: listMode === 'instance' ? t('panel.add.instance.hint') : undefined, onClick: newDefinition, children: listMode === 'definition' ? t('panel.add.definition') : t('panel.add.instance') })] })] }), _jsx("div", { className: css.listBody, children: listMode === 'definition' ? (_jsx(DefinitionList, { t: t, query: query, activeId: selectedDefinitionId, listDefinitions: face.listDefinitions, deleteDefinition: face.deleteDefinition, onOpen: selectDefinition }, `def-${refreshKey}`)) : (_jsx(InstanceList, { t: t, workspaces: workspaces, query: query, activeId: selectedInstanceId, listInstances: face.listInstances, onOpen: selectInstance }, `inst-${refreshKey}`)) })] }));
}
//# sourceMappingURL=WorkflowList.js.map