import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * DagEditor：Stage DAG 简化可视化 + Step 编辑 + YAML 预览/保存。
 *
 * 以 ui-primitives 的节点列表 + 缩进层级呈现 Stage DAG（Stage 间以竖线 + 箭头示意
 * 串行推进，不引入 React Flow/Dagre）。原始 yaml 经浏览器安全子路径
 * `@deepseek-ai/dsh-sandore-workflow/yaml` 解析为编辑态模型（`WorkflowDefinition`），
 * Step 字段（name / command 五类型 / inputFrom / outputTo / passThroughVars / gates /
 * branches / loop）编辑即改模型，YAML 预览随模型同步序列化；保存经 `save` 回调
 * （新建走 `createDefinition`、后续走 `updateYaml`），失败呈现校验错误并保留未保存内容。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/DagEditor
 */
import { useMemo, useState } from 'react';
import { Button, CodeBlock, DisclosureRow, IconChevronDownOutline14, IconChevronRightOutline14, IconPlusOutline16, IconTrashOutline16, Input, Pill, } from '@deepseek-ai/dsh-client-ui-primitives';
import { parseWorkflowYaml, serializeWorkflowYaml } from '@deepseek-ai/dsh-sandore-workflow/yaml';
import { COMMAND_TYPES, createBlankDefinition, createBranch, createCommand, createInputFromItem, createOutputToItem, createPassThroughVar, createStage, newId, parseOptionalNumber, trimToUndefined, updateCommandText, withDefinitionId, } from "./dag-editor-model.js";
import { describeSaveError } from "./sandore-save.js";
import css from './DagEditor.module.css';
/** 命令类型的本地化标签键。 */
const COMMAND_LABEL_KEYS = {
    shell: 'editor.command.shell',
    prompt: 'editor.command.prompt',
    agent: 'editor.command.agent',
    skill: 'editor.command.skill',
    mcp: 'editor.command.mcp',
};
/** 渲染 Step 命令类型选择与 value 字段编辑。 */
function CommandEditor({ command, onChange, t }) {
    const update = (field) => (value) => { onChange(updateCommandText(command, field, value)); };
    return (_jsxs("div", { className: css.command, children: [_jsx("div", { className: css.commandTypes, role: "group", "aria-label": t('editor.step.command'), children: COMMAND_TYPES.map(type => (_jsx(Pill, { active: command.type === type, onClick: () => { onChange(createCommand(type)); }, children: t(COMMAND_LABEL_KEYS[type]) }, type))) }), _jsxs("div", { className: css.commandValue, children: [command.type === 'shell' && (_jsx(Input, { value: command.value.command, onChange: event => { update('command')(event.target.value); }, placeholder: t('editor.field.command') })), command.type === 'prompt' && (_jsxs(_Fragment, { children: [_jsx(Input, { value: command.value.promptText, onChange: event => { update('promptText')(event.target.value); }, placeholder: t('editor.field.promptText') }), _jsx(Input, { value: command.value.providerId ?? '', onChange: event => { update('providerId')(event.target.value); }, placeholder: t('editor.field.providerId') }), _jsx(Input, { value: command.value.modelId ?? '', onChange: event => { update('modelId')(event.target.value); }, placeholder: t('editor.field.modelId') })] })), command.type === 'agent' && (_jsxs(_Fragment, { children: [_jsx(Input, { value: command.value.promptText, onChange: event => { update('promptText')(event.target.value); }, placeholder: t('editor.field.promptText') }), _jsx(Input, { value: command.value.agentParamsTemplate ?? '', onChange: event => { update('agentParamsTemplate')(event.target.value); }, placeholder: t('editor.field.agentParamsTemplate') }), _jsx(Input, { value: command.value.providerId ?? '', onChange: event => { update('providerId')(event.target.value); }, placeholder: t('editor.field.providerId') }), _jsx(Input, { value: command.value.modelId ?? '', onChange: event => { update('modelId')(event.target.value); }, placeholder: t('editor.field.modelId') })] })), command.type === 'skill' && (_jsxs(_Fragment, { children: [_jsx(Input, { value: command.value.promptText, onChange: event => { update('promptText')(event.target.value); }, placeholder: t('editor.field.promptText') }), _jsx(Input, { value: command.value.providerId ?? '', onChange: event => { update('providerId')(event.target.value); }, placeholder: t('editor.field.providerId') })] })), command.type === 'mcp' && (_jsx(Input, { value: command.value.promptText, onChange: event => { update('promptText')(event.target.value); }, placeholder: t('editor.field.promptText') }))] })] }));
}
/** 折叠小节标题。 */
function SectionLabel({ children }) {
    return _jsx("div", { className: css.sectionLabel, children: children });
}
/** 单个映射条目（inputFrom/outputTo 的 `{id, path, regex}`）编辑行。 */
function MappingRow({ item, onChange, onRemove, t }) {
    return (_jsxs("div", { className: css.itemRow, children: [_jsx(Input, { value: item.id, onChange: event => { onChange({ ...item, id: event.target.value }); }, placeholder: t('editor.field.id') }), _jsx(Input, { value: item.path ?? '', onChange: event => { onChange({ ...item, path: trimToUndefined(event.target.value) }); }, placeholder: t('editor.field.path') }), _jsx(Input, { value: item.regex ?? '', onChange: event => { onChange({ ...item, regex: trimToUndefined(event.target.value) }); }, placeholder: t('editor.field.regex') }), _jsx(Button, { variant: "ghost", size: "sm", icon: _jsx(IconTrashOutline16, {}), onClick: onRemove, "aria-label": t('editor.remove.item') })] }));
}
/** Step 完整字段编辑器。 */
function StepEditor({ step, onChange, onRemove, t }) {
    const inputFrom = step.inputFrom ?? [];
    const outputTo = step.outputTo ?? [];
    const passThroughVars = step.passThroughVars ?? [];
    const branches = step.branches ?? [];
    return (_jsxs("div", { className: css.step, children: [_jsxs("div", { className: css.stepHead, children: [_jsx(Input, { value: step.name ?? '', onChange: event => { onChange({ ...step, name: trimToUndefined(event.target.value) }); }, placeholder: t('editor.step.name'), "aria-label": t('editor.step.name') }), _jsx(Button, { variant: "ghost", size: "sm", icon: _jsx(IconTrashOutline16, {}), onClick: onRemove, "aria-label": t('editor.remove.item') })] }), step.command === undefined ? (_jsx(Button, { variant: "outline", size: "sm", icon: _jsx(IconPlusOutline16, {}), onClick: () => { onChange({ ...step, command: createCommand('shell') }); }, children: t('editor.step.command') })) : (_jsx(CommandEditor, { command: step.command, onChange: command => { onChange({ ...step, command }); }, t: t })), _jsx(SectionLabel, { children: t('editor.section.inputFrom') }), inputFrom.map((item, index) => (_jsx(MappingRow, { item: item, onChange: next => { onChange({ ...step, inputFrom: inputFrom.map((current, i) => (i === index ? next : current)) }); }, onRemove: () => { onChange({ ...step, inputFrom: inputFrom.filter((_, i) => i !== index) }); }, t: t }, index))), _jsx(Button, { variant: "ghost", size: "sm", icon: _jsx(IconPlusOutline16, {}), onClick: () => { onChange({ ...step, inputFrom: [...inputFrom, createInputFromItem()] }); }, children: t('editor.add.item') }), _jsx(SectionLabel, { children: t('editor.section.outputTo') }), outputTo.map((item, index) => (_jsx(MappingRow, { item: item, onChange: next => { onChange({ ...step, outputTo: outputTo.map((current, i) => (i === index ? next : current)) }); }, onRemove: () => { onChange({ ...step, outputTo: outputTo.filter((_, i) => i !== index) }); }, t: t }, index))), _jsx(Button, { variant: "ghost", size: "sm", icon: _jsx(IconPlusOutline16, {}), onClick: () => { onChange({ ...step, outputTo: [...outputTo, createOutputToItem()] }); }, children: t('editor.add.item') }), _jsx(SectionLabel, { children: t('editor.section.passThroughVars') }), passThroughVars.map((variable, index) => (_jsxs("div", { className: css.itemRow, children: [_jsx(Input, { value: variable.name, onChange: event => { onChange({ ...step, passThroughVars: passThroughVars.map((v, i) => (i === index ? { ...v, name: event.target.value } : v)) }); }, placeholder: t('editor.field.name') }), _jsx(Input, { value: variable.value, onChange: event => { onChange({ ...step, passThroughVars: passThroughVars.map((v, i) => (i === index ? { ...v, value: event.target.value } : v)) }); }, placeholder: t('editor.field.value') }), _jsx(Input, { value: variable.description, onChange: event => { onChange({ ...step, passThroughVars: passThroughVars.map((v, i) => (i === index ? { ...v, description: event.target.value } : v)) }); }, placeholder: t('editor.field.description') }), _jsx(Button, { variant: "ghost", size: "sm", icon: _jsx(IconTrashOutline16, {}), onClick: () => { onChange({ ...step, passThroughVars: passThroughVars.filter((_, i) => i !== index) }); }, "aria-label": t('editor.remove.item') })] }, index))), _jsx(Button, { variant: "ghost", size: "sm", icon: _jsx(IconPlusOutline16, {}), onClick: () => { onChange({ ...step, passThroughVars: [...passThroughVars, createPassThroughVar()] }); }, children: t('editor.add.item') }), _jsx(SectionLabel, { children: t('editor.section.gates') }), _jsx(GatesEditor, { gates: step.gates, onChange: gates => { onChange({ ...step, gates }); }, t: t }), _jsx(SectionLabel, { children: t('editor.section.branches') }), branches.map((branch, index) => (_jsxs("div", { className: css.itemRow, children: [_jsx(Input, { value: branch.expectation ?? '', onChange: event => { onChange({ ...step, branches: branches.map((b, i) => (i === index ? { ...b, expectation: trimToUndefined(event.target.value) } : b)) }); }, placeholder: t('editor.field.expectation') }), _jsx(Input, { value: branch.next, onChange: event => { onChange({ ...step, branches: branches.map((b, i) => (i === index ? { ...b, next: event.target.value } : b)) }); }, placeholder: t('editor.field.next') }), _jsx(Input, { value: branch.label ?? '', onChange: event => { onChange({ ...step, branches: branches.map((b, i) => (i === index ? { ...b, label: trimToUndefined(event.target.value) } : b)) }); }, placeholder: t('editor.field.label') }), _jsx(Button, { variant: "ghost", size: "sm", icon: _jsx(IconTrashOutline16, {}), onClick: () => { onChange({ ...step, branches: branches.filter((_, i) => i !== index) }); }, "aria-label": t('editor.remove.item') })] }, index))), _jsx(Button, { variant: "ghost", size: "sm", icon: _jsx(IconPlusOutline16, {}), onClick: () => { onChange({ ...step, branches: [...branches, createBranch()] }); }, children: t('editor.add.item') }), _jsx(SectionLabel, { children: t('editor.section.loop') }), _jsx(LoopEditor, { loop: step.loop, onChange: loop => { onChange({ ...step, loop }); }, t: t })] }));
}
/** gates 编辑（maxRetries/maxTokens/need_confirm）。 */
function GatesEditor({ gates, onChange, t }) {
    const current = gates ?? {};
    return (_jsxs("div", { className: css.gates, children: [_jsx(Input, { type: "number", value: current.maxRetries ?? '', onChange: event => { onChange({ ...current, maxRetries: parseOptionalNumber(event.target.value) }); }, placeholder: t('editor.field.maxRetries') }), _jsx(Input, { type: "number", value: current.maxTokens ?? '', onChange: event => { onChange({ ...current, maxTokens: parseOptionalNumber(event.target.value) }); }, placeholder: t('editor.field.maxTokens') }), _jsxs("label", { className: css.checkbox, children: [_jsx("input", { type: "checkbox", checked: current.need_confirm ?? false, onChange: event => { onChange({ ...current, need_confirm: event.target.checked }); } }), _jsx("span", { children: t('editor.field.needConfirm') })] })] }));
}
/** loop 编辑（maxIterations/breakExpectation/next/exitTo）。 */
function LoopEditor({ loop, onChange, t }) {
    const current = loop ?? { maxIterations: 1 };
    return (_jsxs("div", { className: css.loop, children: [_jsx(Input, { type: "number", value: String(current.maxIterations), onChange: event => { onChange({ ...current, maxIterations: parseOptionalNumber(event.target.value) ?? 1 }); }, placeholder: t('editor.field.maxIterations'), "aria-label": t('editor.field.maxIterations') }), _jsx(Input, { value: current.breakExpectation ?? '', onChange: event => { onChange({ ...current, breakExpectation: trimToUndefined(event.target.value) }); }, placeholder: t('editor.field.breakExpectation') }), _jsx(Input, { value: current.next ?? '', onChange: event => { onChange({ ...current, next: trimToUndefined(event.target.value) }); }, placeholder: t('editor.field.next') }), _jsx(Input, { value: current.exitTo ?? '', onChange: event => { onChange({ ...current, exitTo: trimToUndefined(event.target.value) }); }, placeholder: t('editor.field.exitTo') })] }));
}
/** Stage 节点：DisclosureRow 折叠（名称 + Step 数）+ 展开 Step 列表。 */
function StageNode({ stage, expanded, onToggle, onAddStep, onUpdateStage, onRemoveStage, t }) {
    return (_jsx(DisclosureRow, { icon: _jsx(IconChevronRightOutline14, {}), title: stage.name, open: expanded, expandable: true, onToggle: onToggle, expandOnRowClick: true, previewChevron: false, rowClassName: css.stageHeader, collapsedContent: _jsx("span", { className: css.stepCount, children: t('editor.steps.count', { count: stage.steps.length }) }), children: _jsxs("div", { className: css.steps, children: [stage.steps.length === 0 ? (_jsx("span", { className: css.empty, children: t('editor.steps.empty') })) : (stage.steps.map(step => (_jsx(StepEditor, { step: step, onChange: next => { onUpdateStage({ ...stage, steps: stage.steps.map(s => (s.id === step.id ? next : s)) }); }, onRemove: () => { onUpdateStage({ ...stage, steps: stage.steps.filter(s => s.id !== step.id) }); }, t: t }, step.id)))), _jsxs("div", { className: css.stepActions, children: [_jsx(Button, { variant: "ghost", size: "sm", icon: _jsx(IconPlusOutline16, {}), onClick: onAddStep, children: t('editor.step.add') }), _jsx(Button, { variant: "ghost", size: "sm", icon: _jsx(IconTrashOutline16, {}), onClick: onRemoveStage, children: t('editor.remove.item') })] })] }) }));
}
/** 渲染 DagEditor。 */
export function DagEditor({ t, initialYaml, initialId, save, onSaved }) {
    const [definition, setDefinition] = useState(() => initialYaml === undefined ? createBlankDefinition() : parseWorkflowYaml(initialYaml));
    const [id, setId] = useState(initialId);
    const [expandedStageId, setExpandedStageId] = useState(undefined);
    const [saveState, setSaveState] = useState({ kind: 'idle' });
    const preview = useMemo(() => serializeWorkflowYaml(definition), [definition]);
    const patchStages = (patch) => {
        setDefinition(current => ({ ...current, stages: patch(current.stages) }));
    };
    const updateStage = (stageId, next) => {
        patchStages(stages => stages.map(stage => (stage.id === stageId ? next : stage)));
    };
    const toggleStage = (stageId) => {
        setExpandedStageId(current => (current === stageId ? undefined : stageId));
    };
    const addStage = () => {
        patchStages(stages => {
            const count = stages.length;
            return [...stages, createStage(`阶段 ${count + 1}`)];
        });
    };
    const addStep = (stageId) => {
        patchStages(stages => stages.map(stage => (stage.id !== stageId ? stage : { ...stage, steps: [...stage.steps, { id: newId('step') }] })));
    };
    const removeStage = (stageId) => {
        patchStages(stages => stages.filter(stage => stage.id !== stageId));
    };
    const runSave = async () => {
        setSaveState({ kind: 'pending' });
        try {
            const savedId = await save(id, serializeWorkflowYaml(definition));
            setId(savedId);
            onSaved?.(savedId);
            // 回填保存后的真实 id 进编辑态模型，使 YAML 预览基线反映已保存内容。
            setDefinition(current => withDefinitionId(current, savedId));
            setSaveState({ kind: 'ok' });
        }
        catch (error) {
            const { message, details } = describeSaveError(error);
            setSaveState({ kind: 'error', message, details });
        }
    };
    return (_jsxs("section", { className: css.editor, "aria-label": t('editor.title'), "data-sandore-dag-editor": true, children: [_jsxs("header", { className: css.header, children: [_jsx("span", { className: css.title, children: t('editor.title') }), _jsx(Button, { size: "sm", variant: "primary", disabled: saveState.kind === 'pending', onClick: () => { void runSave(); }, children: saveState.kind === 'pending' ? t('editor.saving') : t('editor.save') })] }), saveState.kind === 'ok' && (_jsx("p", { className: css.success, role: "status", children: t('editor.save.success') })), saveState.kind === 'error' && (_jsx("p", { className: css.error, role: "alert", children: saveState.details === undefined
                    ? t('editor.save.failed', { message: saveState.message })
                    : t('editor.save.failed', { message: `${saveState.message} — ${saveState.details}` }) })), _jsxs("div", { className: css.body, children: [_jsxs("div", { className: css.dag, children: [definition.stages.map((stage, index) => (_jsxs("div", { className: css.nodeWrap, children: [_jsx(StageNode, { stage: stage, expanded: expandedStageId === stage.id, onToggle: () => { toggleStage(stage.id); }, onAddStep: () => { addStep(stage.id); }, onUpdateStage: next => { updateStage(stage.id, next); }, onRemoveStage: () => { removeStage(stage.id); }, t: t }), index < definition.stages.length - 1 && (_jsx("div", { className: css.connector, "aria-hidden": true, children: _jsx(IconChevronDownOutline14, {}) }))] }, stage.id))), _jsx(Button, { variant: "outline", size: "sm", icon: _jsx(IconPlusOutline16, {}), onClick: addStage, children: t('editor.stage.add') })] }), _jsxs("div", { className: css.preview, children: [_jsx(SectionLabel, { children: t('editor.preview') }), _jsx(CodeBlock, { code: preview, lang: "yaml", copyLabel: t('editor.preview') })] })] })] }));
}
//# sourceMappingURL=DagEditor.js.map