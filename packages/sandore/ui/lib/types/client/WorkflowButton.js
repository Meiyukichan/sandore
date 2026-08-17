import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** sidebar.footer.action 工作流入口：设置上方的按钮 + 点击展开 WorkflowPanel。 */
import { useState } from 'react';
import { IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { WorkflowPanel } from "./WorkflowPanel.js";
import css from './WorkflowButton.module.css';
/** 渲染工作流入口按钮，点击切换 WorkflowPanel 展开/收起。 */
export function WorkflowButton({ wide, useWorkspaces, t, listInstances, listDefinitions, deleteDefinition, save, openDiscussion, remote, }) {
    const [open, setOpen] = useState(false);
    const workspaces = useWorkspaces(state => state.items);
    return (_jsxs("div", { className: wide ? css.layer : `${css.layer} ${css.rail}`, children: [open && (_jsx(WorkflowPanel, { t: t, workspaces: workspaces, listInstances: listInstances, listDefinitions: listDefinitions, deleteDefinition: deleteDefinition, save: save, openDiscussion: openDiscussion, remote: remote })), _jsx("div", { className: css.footerButtons, children: _jsxs("button", { type: "button", className: css.badge, "data-sandore-btn": true, "aria-label": t('button.aria'), "aria-expanded": open, onClick: () => { setOpen(value => !value); }, children: [_jsx(IconBranchOutline16, {}), wide && _jsx("span", { className: css.badgeLabel, children: t('button.trigger') })] }) })] }));
}
//# sourceMappingURL=WorkflowButton.js.map