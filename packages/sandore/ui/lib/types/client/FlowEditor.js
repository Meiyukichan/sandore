import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * FlowEditor：Stage/Step 通用流控编辑器（分支是唯一出边单元）。
 *
 * 统一结构：`branches: [{ next, condition?, loop? }]`。
 * - 无 `condition` = 并行分支（始终走）；
 * - 有 `condition` = 条件分支（布尔判定命令，true 才走）；
 * - 有 `loop` = 循环回边分支（该分支 `next` 指向更早节点，`loop` 控制迭代/跳出）。
 * 每条分支独立编辑：目标 + 并行/条件切换 + 判断条件命令 + 循环参数（折叠）。
 * Stage 层不允许循环（回环连线被拒绝，分支不会带 loop）；Stage 层判断条件仅
 * shell/prompt（`conditionTypes` 限定）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/FlowEditor
 */
import { Button, IconPlusOutline16, IconTrashOutline16, Input } from '@deepseek-ai/dsh-client-ui-primitives';
import { CommandEditor } from "./CommandEditor.js";
import { createCommand, isConditionalBranch, parseOptionalNumber } from "./dag-editor-model.js";
import css from './DagEditor.module.css';
/** 折叠小节标题（复用 DagEditor 的样式）。 */
function SectionLabel({ children }) {
    return _jsx("div", { className: css.sectionLabel, children: children });
}
/** 目标节点下拉（分支 next）。 */
function TargetSelect({ value, targets, t, onChange }) {
    return (_jsxs("select", { className: css.select, value: value, onChange: event => { onChange(event.target.value); }, children: [_jsx("option", { value: "", children: t('flow.none') }), targets.map(target => (_jsx("option", { value: target.id, children: target.name }, target.id)))] }));
}
/**
 * 渲染 Stage/Step 流控编辑器（分支列表：每条 = 类型下拉 + 只读目标 + 判断条件 + 循环）。
 * 循环由画布回环连线自动产生（loop 必填），详情不做手动添加。
 * @param stageSteps - 当前 Stage 内全部合并 step（含 branches 流控），用于计算回环环上节点。
 * @param currentId - 当前编辑节点 id。
 * @param conditionTypes - 判断条件命令可选类型（缺省 = 全部五类型；Stage 层 shell/prompt）。
 */
export function FlowEditor({ t, flow, targets, onChange, stageSteps, currentId, conditionTypes }) {
    const branches = flow.branches ?? [];
    const setBranch = (index, next) => {
        onChange({ ...flow, branches: branches.map((b, i) => (i === index ? next : b)) });
    };
    /**
     * 计算回环环上节点集合：从回边目标出发沿出边（branches[].next + loop.next）做图搜索，
     * 若可回到当前节点，则**实际参与该回环的节点**（路径成员）都不能作为跳出目标
     * （否则跳出后仍会无限循环）。
     */
    const loopNodesOf = (branch) => {
        const current = currentId;
        if (stageSteps === undefined || current === undefined)
            return new Set();
        const back = branch.next;
        const outgoing = new Map();
        for (const step of stageSteps) {
            const targets = [];
            for (const b of step.branches ?? []) {
                if (b.next !== undefined && b.next !== '')
                    targets.push(b.next);
                if (b.loop?.next !== undefined && b.loop.next !== '')
                    targets.push(b.loop.next);
            }
            outgoing.set(step.id, targets);
        }
        // 从回边目标 DFS，记录能到达当前节点的路径成员。
        const onPath = new Set();
        const visited = new Set();
        const dfs = (id, path) => {
            if (id === current) {
                for (const node of path)
                    onPath.add(node);
                return true;
            }
            if (visited.has(id))
                return false;
            visited.add(id);
            let found = false;
            for (const next of outgoing.get(id) ?? []) {
                if (dfs(next, [...path, id]))
                    found = true;
            }
            return found;
        };
        if (back !== undefined && back !== '') {
            dfs(back, [back]);
        }
        return onPath;
    };
    /** 目标节点名（读 targets 表；未知 id 显示原 id）。 */
    const targetName = (id) => targets.find(target => target.id === id)?.name ?? id;
    return (_jsxs("div", { className: css.flow, children: [_jsx(SectionLabel, { children: t('flow.branches') }), branches.map((branch, index) => {
                const conditional = isConditionalBranch(branch);
                return (_jsxs("div", { className: css.branchRow, children: [_jsxs("div", { className: css.branchHead, children: [_jsxs("select", { className: css.branchKindSelect, value: conditional ? 'conditional' : 'parallel', onChange: event => {
                                        const kind = event.target.value;
                                        if (kind === 'conditional') {
                                            setBranch(index, { ...branch, condition: branch.condition ?? createCommand('shell') });
                                        }
                                        else {
                                            setBranch(index, { ...branch, condition: undefined });
                                        }
                                    }, children: [_jsx("option", { value: "parallel", children: t('flow.parallelBranch') }), _jsx("option", { value: "conditional", children: t('flow.conditionalBranch') })] }), _jsx("span", { className: css.branchTarget, title: branch.next === '' ? t('flow.none') : targetName(branch.next), children: branch.next === '' ? t('flow.none') : targetName(branch.next) }), _jsx(Button, { variant: "ghost", size: "sm", icon: _jsx(IconTrashOutline16, {}), "aria-label": t('editor.remove.item'), onClick: () => { onChange({ ...flow, branches: branches.filter((_, i) => i !== index) }); } })] }), _jsx("span", { className: css.branchHint, children: conditional ? t('flow.conditionalHint') : t('flow.parallelHint') }), conditional && (_jsxs("div", { className: css.command, children: [_jsx(SectionLabel, { children: t('flow.condition') }), _jsx("div", { className: css.conditionCard, children: _jsx(CommandEditor, { command: branch.condition, onChange: condition => { setBranch(index, { ...branch, condition }); }, t: t, types: conditionTypes }) })] })), branch.loop !== undefined && (_jsxs("div", { className: css.loop, children: [_jsx(SectionLabel, { children: t('flow.loop') }), _jsx(Input, { type: "number", value: String(branch.loop.maxIterations ?? 1), onChange: event => { setBranch(index, { ...branch, loop: { ...branch.loop, maxIterations: parseOptionalNumber(event.target.value) ?? 1 } }); }, placeholder: t('editor.field.maxIterations'), "aria-label": t('editor.field.maxIterations') }), _jsx(TargetSelect, { value: branch.loop.next ?? '', targets: targets, t: t, onChange: next => { setBranch(index, { ...branch, loop: { ...branch.loop, next: next === '' ? undefined : next } }); } }), _jsx(SectionLabel, { children: t('editor.field.exitTo') }), _jsxs("select", { className: css.select, value: branch.loop.exitTo ?? '__end__', onChange: event => {
                                        const value = event.target.value;
                                        // END 占位符（__end__）不写入 YAML：存 exitTo: undefined，引擎推进下一 Stage。
                                        setBranch(index, { ...branch, loop: { ...branch.loop, exitTo: value === '__end__' ? undefined : value } });
                                    }, children: [_jsx("option", { value: "__end__", children: t('flow.end') }), targets.filter(target => !loopNodesOf(branch).has(target.id)).map(target => (_jsx("option", { value: target.id, children: target.name }, target.id)))] }), _jsx(SectionLabel, { children: t('flow.breakCondition') }), branch.loop.breakCondition === undefined ? (_jsx(Button, { variant: "outline", size: "sm", icon: _jsx(IconPlusOutline16, {}), onClick: () => { setBranch(index, { ...branch, loop: { ...branch.loop, breakCondition: createCommand('prompt') } }); }, children: t('flow.addCondition') })) : (_jsx(CommandEditor, { command: branch.loop.breakCondition, onChange: breakCondition => { setBranch(index, { ...branch, loop: { ...branch.loop, breakCondition } }); }, t: t }))] }))] }, index));
            }), _jsx(Button, { variant: "ghost", size: "sm", icon: _jsx(IconPlusOutline16, {}), onClick: () => { onChange({ ...flow, branches: [...branches, { next: '' }] }); }, children: t('flow.addBranch') })] }));
}
//# sourceMappingURL=FlowEditor.js.map