import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * TreeNav：执行态左栏树形导航（workflow → stage → step → result/artifact）。
 *
 * 风格照 DSH `ui-workflow-run` WorkflowRunPanel：32px run/phase 行、24px
 * member 行、细线 chevron（IconChevronRightOutline14 / Down）、16px 逐级缩进。
 * 状态一律用**左侧状态点**（chevron 后、标题前），右侧无任何文字。默认全部
 * 展开；result/artifact 叶子点击 → 打开右栏预览；running Step 可点跳子会话。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/TreeNav
 */
import { useState } from 'react';
import { IconChevronDownOutline14, IconChevronRightOutline14, StateDot, } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './tree-nav.module.css';
/** 状态 → StateDotState（DagRun/Step 7+7 态统一折入四态；缺省折入 warning）。 */
function dotState(status) {
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
/** 可折叠行：chevron + 状态点 + 标题 +（可选行尾按钮），点击整行展开/折叠。 */
function DisclosureRow({ node, className, headerClassName, leadingClassName, titleClassName, trailing, children }) {
    const hasChildren = (node.children ?? []).length > 0;
    // 默认全部展开（用户要求）；workflow/stage/step 均可点击整行切换展开/折叠。
    const [open, setOpen] = useState(true);
    return (_jsxs("div", { className: className, "data-open": open || undefined, children: [_jsxs("div", { className: headerClassName, "data-disclosure-row": true, "data-expandable": hasChildren || undefined, role: "button", tabIndex: 0, "aria-expanded": open, onClick: () => { setOpen(value => !value); }, onKeyDown: event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setOpen(value => !value);
                    }
                }, children: [_jsx("span", { className: leadingClassName, children: hasChildren
                            ? (open ? _jsx(IconChevronDownOutline14, {}) : _jsx(IconChevronRightOutline14, {}))
                            : _jsx("span", { className: css.chevronPlaceholder }) }), _jsx("span", { className: css.dotSlot, children: _jsx(StateDot, { state: dotState(node.status) }) }), _jsx("span", { className: titleClassName, children: node.name }), trailing] }), open && children] }));
}
/** Workflow 根行：32px、模块底色、chevron + 状态点 + 名称。 */
function WorkflowRow({ node, children }) {
    return (_jsx(DisclosureRow, { node: node, className: css.workflow, headerClassName: css.workflowHeader, leadingClassName: css.workflowLeading, titleClassName: css.workflowTitle, children: children }));
}
/** Stage 行：32px、无底、缩进；chevron + 状态点 + 名称。 */
function StageRow({ node, children }) {
    return (_jsx(DisclosureRow, { node: node, className: css.stage, headerClassName: css.stageHeader, leadingClassName: css.stageLeading, titleClassName: css.stageTitle, children: children }));
}
/** Step 行：24px、chevron + 状态点 + 名称 +（running 跳子会话按钮），叶子随展开。 */
function StepRow({ node, onOpenChild, t, children }) {
    const navigable = node.status === 'running' && node.childId !== undefined;
    return (_jsx(DisclosureRow, { node: node, headerClassName: css.memberHeader, leadingClassName: css.memberLeading, titleClassName: css.memberLabel, trailing: navigable ? (_jsx("button", { type: "button", className: css.jump, title: t('step.open', { name: node.name }), "aria-label": t('step.open', { name: node.name }), onClick: event => {
                event.stopPropagation();
                onOpenChild(node.childId);
            }, children: "\u2197" })) : undefined, children: children }));
}
/** result 叶子图标：文本行（简单线框 SVG，currentColor）。 */
function ResultGlyph() {
    return (_jsxs("svg", { width: "12", height: "12", viewBox: "0 0 12 12", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": true, children: [_jsx("rect", { x: "1", y: "1", width: "10", height: "10", rx: "2", stroke: "currentColor", strokeWidth: "1.2" }), _jsx("path", { d: "M3 4.5h6M3 7h4", stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round" })] }));
}
/** artifact 叶子图标：文件方块（简单线框 SVG，currentColor）。 */
function ArtifactGlyph() {
    return (_jsxs("svg", { width: "12", height: "12", viewBox: "0 0 12 12", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": true, children: [_jsx("path", { d: "M2.5 1h5L10 3.5v7a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 2 10.5v-9A.5.5 0 0 1 2.5 1Z", stroke: "currentColor", strokeWidth: "1.2", strokeLinejoin: "round" }), _jsx("path", { d: "M7.5 1v2.5H10", stroke: "currentColor", strokeWidth: "1.2", strokeLinejoin: "round" })] }));
}
/** 叶子（result/artifact）：图标与 step 状态点同列对齐，点击打开右栏预览。 */
function LeafRow({ node, activePreviewId, onSelectLeaf, t }) {
    const active = activePreviewId === node.id;
    return (_jsxs("button", { type: "button", className: `${css.leafRow} ${active ? css.leafActive : ''}`, "data-tree-leaf": true, onClick: () => {
            onSelectLeaf({
                leafId: node.id,
                kind: node.type === 'result' ? 'result' : 'artifact',
                stepId: node.stepId ?? '',
                name: node.name === '' ? t('run.result') : node.name,
                meta: node.meta,
                text: node.text,
            });
        }, children: [_jsx("span", { className: css.leafIcon, children: node.type === 'result' ? _jsx(ResultGlyph, {}) : _jsx(ArtifactGlyph, {}) }), _jsx("span", { className: css.leafLabel, children: node.name === '' ? t('run.result') : node.name }), node.meta !== undefined && _jsx("span", { className: css.leafMeta, children: node.meta })] }));
}
/** 递归渲染：workflow → stage → step → 叶子。 */
function RenderNode({ node, depth, activePreviewId, onSelectLeaf, onOpenChild, t }) {
    const children = node.children ?? [];
    if (node.type === 'workflow') {
        return (_jsx(WorkflowRow, { node: node, children: _jsx("div", { className: css.stageList, children: children.map(child => (_jsx(RenderNode, { node: child, depth: depth + 1, activePreviewId: activePreviewId, onSelectLeaf: onSelectLeaf, onOpenChild: onOpenChild, t: t }, child.id))) }) }));
    }
    if (node.type === 'stage') {
        return (_jsx(StageRow, { node: node, children: _jsx("div", { className: css.memberList, children: children.map(child => (_jsx(RenderNode, { node: child, depth: depth + 1, activePreviewId: activePreviewId, onSelectLeaf: onSelectLeaf, onOpenChild: onOpenChild, t: t }, child.id))) }) }));
    }
    if (node.type === 'step') {
        const leaves = children;
        return (_jsx(StepRow, { node: node, onOpenChild: onOpenChild, t: t, children: leaves.length > 0 && (_jsx("div", { className: css.leafList, children: leaves.map(leaf => (_jsx(LeafRow, { node: leaf, activePreviewId: activePreviewId, onSelectLeaf: onSelectLeaf, t: t }, leaf.id))) })) }));
    }
    return null;
}
/** 渲染树形导航（照 DSH WorkflowRunPanel；左上角标题 + 树身顶部留白）。 */
export function TreeNav({ t, tree, activePreviewId, onSelectLeaf, onOpenChild }) {
    return (_jsxs("nav", { className: css.root, "aria-label": t('run.nav'), "data-sandore-tree-nav": true, children: [_jsx("div", { className: css.titleBar, children: _jsx("span", { className: css.title, children: t('run.nav') }) }), _jsx("div", { className: css.scroll, children: _jsx("div", { className: css.body, children: tree.map(node => (_jsx(RenderNode, { node: node, depth: 0, activePreviewId: activePreviewId, onSelectLeaf: onSelectLeaf, onOpenChild: onOpenChild, t: t }, node.id))) }) })] }));
}
//# sourceMappingURL=TreeNav.js.map