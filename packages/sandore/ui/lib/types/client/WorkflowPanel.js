import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * WorkflowPanel：工作流展开列表（sidebar 内，header 搜索/编排/新增）。
 *
 * 由 WorkflowButton 承载，以 `.panel` 在 sidebar 底部按钮上方展开（占侧栏宽度，
 * 不覆盖主区）。header 提供搜索（客户端过滤）、编排 toggle（默认态实例列表 ↔
 * 编排态定义列表）与新增按钮（编排态进入空 DagEditor）。点击工作流项经
 * `onOpen` 打开右侧编辑区（宿主会话 + conversation.view「工作流」tab）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/WorkflowPanel
 */
import { useState } from 'react';
import { Button, IconPlusOutline16, IconSearchOutline16, Input, Pill, } from '@deepseek-ai/dsh-client-ui-primitives';
import { InstanceList } from "./InstanceList.js";
import { DefinitionList } from "./DefinitionList.js";
import css from './WorkflowPanel.module.css';
/** 渲染 WorkflowPanel（sidebar 内列表）。 */
export function WorkflowPanel({ t, workspaces, listInstances, listDefinitions, deleteDefinition, onOpen }) {
    const [orchestrating, setOrchestrating] = useState(false);
    const [query, setQuery] = useState('');
    return (_jsxs("section", { className: css.panel, "aria-label": t('panel.title'), "data-sandore-panel": true, children: [_jsxs("header", { className: css.header, children: [_jsx("span", { className: css.title, children: t('panel.title') }), _jsx(Input, { className: css.search ?? '', icon: _jsx(IconSearchOutline16, {}), value: query, onChange: event => { setQuery(event.target.value); }, placeholder: t('panel.search'), "aria-label": t('panel.search') }), _jsx(Pill, { active: orchestrating, onClick: () => { setOrchestrating(value => !value); }, children: t('panel.orchestrate') }), _jsx(Button, { size: "sm", variant: "primary", icon: _jsx(IconPlusOutline16, {}), disabled: !orchestrating, title: orchestrating ? undefined : t('panel.add.instance.hint'), onClick: () => { onOpen({ kind: 'definition' }); }, children: orchestrating ? t('panel.add.definition') : t('panel.add.instance') })] }), _jsx("div", { className: css.body, children: orchestrating ? (_jsx(DefinitionList, { t: t, query: query, listDefinitions: listDefinitions, deleteDefinition: deleteDefinition, onOpen: (definitionId, initialYaml) => { onOpen({ kind: 'definition', definitionId, initialYaml }); } })) : (_jsx(InstanceList, { t: t, workspaces: workspaces, query: query, listInstances: listInstances, onOpen: instanceId => { onOpen({ kind: 'instance', instanceId }); } })) })] }));
}
//# sourceMappingURL=WorkflowPanel.js.map