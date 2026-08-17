import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** sidebar.footer.action 工作流入口：点击打开 shell.overlay 全局工作流 UI（设置上方）。 */
import { useSyncExternalStore } from 'react';
import { IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { getWorkflowState, subscribeWorkflowState } from "./workflow-store.js";
import css from './WorkflowButton.module.css';
/** 渲染工作流入口按钮，点击打开全局工作流 overlay；overlay 打开时按钮高亮。 */
export function WorkflowButton({ wide, t, onOpenWorkflow }) {
    const open = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().open);
    return (_jsx("div", { className: wide ? css.layer : `${css.layer} ${css.rail}`, children: _jsxs("button", { type: "button", className: `${css.badge} ${open ? css.badgeActive : ''}`, "data-sandore-btn": true, "aria-label": t('button.aria'), "aria-expanded": open, onClick: () => { onOpenWorkflow(); }, children: [_jsx(IconBranchOutline16, {}), wide && _jsx("span", { className: css.badgeLabel, children: t('button.trigger') })] }) }));
}
//# sourceMappingURL=WorkflowButton.js.map