import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** sidebar.footer.action 工作流入口：点击切换 shell.overlay 全局工作流 UI（设置上方）。 */
import { useSyncExternalStore } from 'react';
import { getWorkflowState, subscribeWorkflowState } from "./workflow-store.js";
import css from './WorkflowButton.module.css';
/**
 * 工作流图标：Lucide "workflow" 官方形状——顶部左右两个节点 + 底部中间节点，
 * 顶部水平连线 + 中间垂直连线（标准工作流符号）。手绘内联 SVG 16×16，
 * stroke = currentColor。
 */
function WorkflowIcon() {
    return (_jsxs("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": true, children: [_jsx("rect", { x: "1.6", y: "1.6", width: "4", height: "4", rx: "1", stroke: "currentColor", strokeWidth: "1.3" }), _jsx("rect", { x: "10.4", y: "1.6", width: "4", height: "4", rx: "1", stroke: "currentColor", strokeWidth: "1.3" }), _jsx("rect", { x: "6", y: "10.4", width: "4", height: "4", rx: "1", stroke: "currentColor", strokeWidth: "1.3" }), _jsx("path", { d: "M5.6 3.6h4.8", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" }), _jsx("path", { d: "M8 5.6v4.8", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" })] }));
}
/** 渲染工作流入口按钮，点击切换全局工作流 overlay 开关；overlay 打开时按钮高亮。 */
export function WorkflowButton({ wide, t, onToggleWorkflow }) {
    const open = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().open);
    return (_jsx("div", { className: wide ? css.layer : `${css.layer} ${css.rail}`, children: _jsxs("button", { type: "button", className: `${css.badge} ${open ? css.badgeActive : ''}`, "data-sandore-btn": true, "aria-label": t('button.aria'), "aria-expanded": open, onClick: () => { onToggleWorkflow(); }, children: [_jsx(WorkflowIcon, {}), wide && _jsx("span", { className: css.badgeLabel, children: t('button.trigger') })] }) }));
}
//# sourceMappingURL=WorkflowButton.js.map