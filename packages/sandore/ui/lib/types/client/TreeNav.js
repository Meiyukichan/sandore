import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * TreeNav：执行态左栏树形导航（workflow → stage → step → result/artifact 叶子）。
 *
 * DSH DisclosureRow 风格：chevron + 状态点 + 缩进 + 折叠。todo 态 Stage/Step 默认
 * 折叠；result/artifact 叶子点击 → `onSelectLeaf` 打开右栏预览；Step 行有子代理
 * 会话时 hover 显示 ↗ 跳转按钮。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/TreeNav
 */
import { useState } from 'react';
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './tree-nav.module.css';
/** 状态 → StateDotState（DagRun/Step 7+7 态统一折入四态；缺省折入 warning）。 */
function treeDotState(status) {
    switch (status) {
        case 'completed':
            return 'done';
        case 'failed':
            return 'error';
        case 'running':
        case 'interacting':
            return 'ongoing';
        case undefined:
        case 'pending':
        case 'aborted':
        case 'paused':
        case 'blocked':
        case 'ready':
            return 'warning';
    }
}
/** 单行渲染（含子节点递归）。 */
function TreeRow({ node, depth, activePreviewId, onSelectLeaf, onOpenChild, t }) {
    const children = node.children ?? [];
    const hasChildren = children.length > 0;
    // 默认折叠：未开始（ready/blocked）与已完成（completed）的 Stage/Step 收起；
    // 运行中/待交互/失败/暂停展开；workflow 根与叶子不折叠。
    const [collapsed, setCollapsed] = useState((node.type === 'stage' || node.type === 'step')
        ? (node.status !== 'running' && node.status !== 'interacting' && node.status !== 'failed' && node.status !== 'paused')
        : false);
    if (node.type === 'result' || node.type === 'artifact') {
        const active = activePreviewId === node.id;
        return (_jsxs("div", { className: `${css.leaf} ${active ? css.leafActive : ''}`, style: { paddingLeft: 8 + depth * 16 + 16 }, "data-tree-leaf": true, onClick: () => {
                onSelectLeaf({
                    leafId: node.id,
                    kind: node.type === 'result' ? 'result' : 'artifact',
                    stepId: node.stepId ?? '',
                    name: node.name === '' ? t('run.result') : node.name,
                    meta: node.meta,
                    text: node.text,
                });
            }, children: [_jsx("span", { className: css.leafIcon, children: node.type === 'result' ? '📝' : '📄' }), _jsx("span", { className: css.leafLabel, children: node.name === '' ? t('run.result') : node.name }), node.meta !== undefined && _jsx("span", { className: css.leafMeta, children: node.meta })] }));
    }
    const status = node.type === 'workflow' || node.type === 'stage' || node.type === 'step' ? node.status : undefined;
    return (_jsxs("div", { className: `${css.node} ${collapsed ? css.nodeCollapsed : ''}`, children: [_jsxs("div", { className: css.row, style: { paddingLeft: 8 + depth * 16 }, "data-tree-row": true, onClick: () => { if (hasChildren)
                    setCollapsed(value => !value); }, children: [_jsx("span", { className: css.chevron, children: hasChildren ? '▼' : '' }), _jsx(StateDot, { state: treeDotState(status) }), _jsx("span", { className: css.label, children: node.name }), node.type === 'step' && node.childId !== undefined && (_jsx("button", { type: "button", className: css.jump, title: t('step.open', { name: node.name }), "aria-label": t('step.open', { name: node.name }), onClick: event => {
                            event.stopPropagation();
                            onOpenChild(node.childId);
                        }, children: "\u2197" }))] }), hasChildren && !collapsed && (_jsx("div", { className: css.children, children: children.map(child => (_jsx(TreeRow, { node: child, depth: depth + 1, activePreviewId: activePreviewId, onSelectLeaf: onSelectLeaf, onOpenChild: onOpenChild, t: t }, child.id))) }))] }));
}
/** 渲染树形导航。 */
export function TreeNav({ t, tree, activePreviewId, onSelectLeaf, onOpenChild }) {
    return (_jsxs("nav", { className: css.root, "aria-label": t('run.nav'), "data-sandore-tree-nav": true, children: [_jsx("div", { className: css.header, children: _jsx("span", { className: css.title, children: t('run.nav') }) }), _jsx("div", { className: css.body, children: tree.map(node => (_jsx(TreeRow, { node: node, depth: 0, activePreviewId: activePreviewId, onSelectLeaf: onSelectLeaf, onOpenChild: onOpenChild, t: t }, node.id))) })] }));
}
//# sourceMappingURL=TreeNav.js.map