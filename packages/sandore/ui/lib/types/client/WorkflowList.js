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
import { NewInstanceDialog } from "./NewInstanceDialog.js";
import { getWorkflowState, newDefinition, selectDefinition, selectInstance, setWorkflowState, subscribeWorkflowState, } from "./workflow-store.js";
import css from './WorkflowOverlay.module.css';
/** 渲染工作流 overlay 左栏列表。 */
export function WorkflowList({ t, workspaces, face, refreshKey, width }) {
    const listMode = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().listMode);
    const selectedInstanceId = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().selectedInstanceId);
    const selectedDefinitionId = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().selectedDefinition?.id);
    const [query, setQuery] = useState('');
    /** 新增实例弹窗开关（实例模式下「+」按钮打开）。 */
    const [creatingInstance, setCreatingInstance] = useState(false);
    /** 实例列表即时刷新计数：新建/删除实例后 +1，重挂载 InstanceList 立即拉取
        （不等 3s 轮询周期，新建后列表立即可见）。 */
    const [instanceTick, setInstanceTick] = useState(0);
    return (_jsxs("section", { className: css.list, style: { width }, "data-sandore-wf-list": true, children: [_jsxs("header", { className: css.listHeader, children: [_jsxs("div", { className: css.listTitleRow, children: [_jsx("span", { className: css.listTitle, children: t('panel.title') }), _jsxs("div", { className: css.toggle, role: "tablist", "aria-label": t('list.mode.switch'), children: [_jsx("span", { className: `${css.toggleThumb} ${listMode === 'definition' ? css.toggleThumbRight : ''}` }), _jsx("button", { type: "button", role: "tab", "aria-selected": listMode === 'instance', className: listMode === 'instance' ? css.toggleActive : '', onClick: () => { setWorkflowState({ listMode: 'instance' }); }, children: t('list.mode.instance') }), _jsx("button", { type: "button", role: "tab", "aria-selected": listMode === 'definition', className: listMode === 'definition' ? css.toggleActive : '', onClick: () => { setWorkflowState({ listMode: 'definition' }); }, children: t('list.mode.definition') })] })] }), _jsxs("div", { className: css.listToolbar, children: [_jsx(Input, { className: css.search ?? '', icon: _jsx(IconSearchOutline16, {}), value: query, onChange: event => { setQuery(event.target.value); }, placeholder: t('panel.search'), "aria-label": t('panel.search') }), _jsx(Button, { size: "sm", variant: "primary", icon: _jsx(IconPlusOutline16, {}), title: t('panel.add.instance.hint'), onClick: () => {
                                    if (listMode === 'instance')
                                        setCreatingInstance(true);
                                    else
                                        newDefinition();
                                }, children: listMode === 'definition' ? t('panel.add.definition') : t('panel.add.instance') })] })] }), _jsx("div", { className: css.listBody, children: listMode === 'definition' ? (_jsx(DefinitionList, { t: t, query: query, activeId: selectedDefinitionId, listDefinitions: face.listDefinitions, deleteDefinition: face.deleteDefinition, onOpen: selectDefinition }, `def-${refreshKey}`)) : (_jsx(InstanceList, { t: t, workspaces: workspaces, query: query, activeId: selectedInstanceId, listInstances: face.listInstances, deleteInstance: face.deleteInstance, onOpen: selectInstance, onInstanceDeleted: () => { setInstanceTick(tick => tick + 1); } }, `inst-${refreshKey}-${instanceTick}`)) }), creatingInstance && (_jsx(NewInstanceDialog, { t: t, face: face, onClose: () => { setCreatingInstance(false); }, onCreated: instanceId => {
                    setCreatingInstance(false);
                    selectInstance(instanceId);
                    // 立即重挂载实例列表，让新实例马上可见（不必等轮询周期）。
                    setInstanceTick(tick => tick + 1);
                } }))] }));
}
//# sourceMappingURL=WorkflowList.js.map