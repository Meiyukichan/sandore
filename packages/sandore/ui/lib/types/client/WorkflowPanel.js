import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * WorkflowPanel：工作流展开面板（header 搜索/编排/新增 + 两级下钻 view 栈 + 宽展开）。
 *
 * 由 WorkflowButton 承载，以 `.panel` fixed 浮层弹出（宽展开 layer，不受 rail 宽度
 * 约束）。header 在列表态提供搜索（客户端过滤）、编排 toggle（默认态↔编排态）与
 * 新增按钮（编排态新增定义；默认态「新增实例」暂未实现，按钮禁用并以 tooltip 说明
 * 需先创建定义/Job）；下钻态仅保留返回按钮。内部维护
 * view 状态栈（`list` ↔ `editor`/DagEditor ↔ `run`/RunView，经 `viewStackReducer`），
 * 编排 toggle / 搜索关键词存于面板自身 state，下钻返回后自然保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/WorkflowPanel
 */
import { useReducer, useState } from 'react';
import { Button, IconChevronLeftOutline14, IconPlusOutline16, IconSearchOutline16, Input, Pill, } from '@deepseek-ai/dsh-client-ui-primitives';
import { DagEditor } from "./DagEditor.js";
import { RunView } from "./RunView.js";
import { InstanceList } from "./InstanceList.js";
import { DefinitionList } from "./DefinitionList.js";
import { INITIAL_VIEW_STACK, topView, viewStackReducer } from "./view-stack.js";
import css from './WorkflowPanel.module.css';
/** 渲染 WorkflowPanel。 */
export function WorkflowPanel({ t, workspaces, listInstances, listDefinitions, deleteDefinition, save, openDiscussion, remote }) {
    const [viewStack, dispatch] = useReducer(viewStackReducer, INITIAL_VIEW_STACK);
    const [orchestrating, setOrchestrating] = useState(false);
    const [query, setQuery] = useState('');
    const current = topView(viewStack);
    const drilled = current.kind !== 'list';
    const handleBack = () => { dispatch({ type: 'back' }); };
    const handleAdd = () => {
        // 仅编排态可达（默认态「新增实例」按钮已禁用）：下钻空白 DagEditor，
        // 无 initialId/initialYaml，首次保存走 createDefinition。
        dispatch({ type: 'open', view: { kind: 'editor' } });
    };
    return (_jsxs("section", { className: drilled ? `${css.panel} ${css.drill}` : css.panel, "aria-label": t('panel.title'), "data-sandore-panel": true, children: [_jsx("header", { className: css.header, children: drilled ? (_jsx(Button, { size: "sm", variant: "ghost", icon: _jsx(IconChevronLeftOutline14, {}), onClick: handleBack, children: t('panel.back') })) : (_jsxs(_Fragment, { children: [_jsx("span", { className: css.title, children: t('panel.title') }), _jsx(Input, { className: css.search ?? '', icon: _jsx(IconSearchOutline16, {}), value: query, onChange: event => { setQuery(event.target.value); }, placeholder: t('panel.search'), "aria-label": t('panel.search') }), _jsx(Pill, { active: orchestrating, onClick: () => { setOrchestrating(value => !value); }, children: t('panel.orchestrate') }), _jsx(Button, { size: "sm", variant: "primary", icon: _jsx(IconPlusOutline16, {}), disabled: !orchestrating, title: orchestrating ? undefined : t('panel.add.instance.hint'), onClick: handleAdd, children: orchestrating ? t('panel.add.definition') : t('panel.add.instance') })] })) }), drilled ? (_jsx("div", { className: css.drillBody, children: current.kind === 'editor' ? (_jsx(DagEditor, { t: t, initialId: current.definitionId, initialYaml: current.initialYaml, save: save })) : (_jsx(RunView, { t: t, instanceId: current.instanceId, openDiscussion: openDiscussion(current.instanceId), remote: remote })) })) : (_jsx("div", { className: css.body, children: orchestrating ? (_jsx(DefinitionList, { t: t, query: query, listDefinitions: listDefinitions, deleteDefinition: deleteDefinition, onOpen: (definitionId, initialYaml) => {
                        dispatch({ type: 'open', view: { kind: 'editor', definitionId, initialYaml } });
                    } })) : (_jsx(InstanceList, { t: t, workspaces: workspaces, query: query, listInstances: listInstances, onOpen: instanceId => { dispatch({ type: 'open', view: { kind: 'run', instanceId } }); } })) }))] }));
}
//# sourceMappingURL=WorkflowPanel.js.map