import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** sidebar.footer.action 工作流入口：点击后把主区切换到「工作流」双栏视图（不再展开面板）。 */
import { IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './WorkflowButton.module.css';
/** 渲染工作流入口按钮，点击打开右侧编辑区（conversation.view「工作流」tab）。 */
export function WorkflowButton({ wide, t, onOpenWorkflow }) {
    return (_jsx("div", { className: wide ? css.layer : `${css.layer} ${css.rail}`, children: _jsxs("button", { type: "button", className: css.badge, "data-sandore-btn": true, "aria-label": t('button.aria'), onClick: () => { void onOpenWorkflow(); }, children: [_jsx(IconBranchOutline16, {}), wide && _jsx("span", { className: css.badgeLabel, children: t('button.trigger') })] }) }));
}
//# sourceMappingURL=WorkflowButton.js.map