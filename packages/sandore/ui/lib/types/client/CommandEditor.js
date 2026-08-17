import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * CommandEditor：五类型命令（shell/prompt/agent/skill/mcp）编辑，供 Step command 与
 * 分支 condition / 循环 breakCondition 复用。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/CommandEditor
 */
import { Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives';
import { COMMAND_TYPES, createCommand, updateCommandText } from "./dag-editor-model.js";
import css from './DagEditor.module.css';
/** 命令类型的本地化标签键。 */
export const COMMAND_LABEL_KEYS = {
    shell: 'editor.command.shell',
    prompt: 'editor.command.prompt',
    agent: 'editor.command.agent',
    skill: 'editor.command.skill',
    mcp: 'editor.command.mcp',
};
/** 渲染命令编辑（类型选择 + 对应 value 字段）。`types` 可限定可选类型（如条件判断仅 bash/prompt）。 */
export function CommandEditor({ command, onChange, t, types }) {
    const available = types ?? COMMAND_TYPES;
    const update = (field) => (value) => { onChange(updateCommandText(command, field, value)); };
    return (_jsxs("div", { className: css.command, children: [_jsx("div", { className: css.commandTypes, role: "group", "aria-label": t('editor.step.command'), children: available.map(type => (_jsx(Pill, { active: command.type === type, onClick: () => { onChange(createCommand(type)); }, children: t(COMMAND_LABEL_KEYS[type]) }, type))) }), _jsxs("div", { className: css.commandValue, children: [command.type === 'shell' && (_jsx(Input, { value: command.value.command, onChange: event => { update('command')(event.target.value); }, placeholder: t('editor.field.command') })), command.type === 'prompt' && (_jsxs(_Fragment, { children: [_jsx(Input, { value: command.value.promptText, onChange: event => { update('promptText')(event.target.value); }, placeholder: t('editor.field.promptText') }), _jsx(Input, { value: command.value.providerId ?? '', onChange: event => { update('providerId')(event.target.value); }, placeholder: t('editor.field.providerId') }), _jsx(Input, { value: command.value.modelId ?? '', onChange: event => { update('modelId')(event.target.value); }, placeholder: t('editor.field.modelId') })] })), command.type === 'agent' && (_jsxs(_Fragment, { children: [_jsx(Input, { value: command.value.promptText, onChange: event => { update('promptText')(event.target.value); }, placeholder: t('editor.field.promptText') }), _jsx(Input, { value: command.value.agentParamsTemplate ?? '', onChange: event => { update('agentParamsTemplate')(event.target.value); }, placeholder: t('editor.field.agentParamsTemplate') }), _jsx(Input, { value: command.value.providerId ?? '', onChange: event => { update('providerId')(event.target.value); }, placeholder: t('editor.field.providerId') }), _jsx(Input, { value: command.value.modelId ?? '', onChange: event => { update('modelId')(event.target.value); }, placeholder: t('editor.field.modelId') })] })), command.type === 'skill' && (_jsxs(_Fragment, { children: [_jsx(Input, { value: command.value.promptText, onChange: event => { update('promptText')(event.target.value); }, placeholder: t('editor.field.promptText') }), _jsx(Input, { value: command.value.providerId ?? '', onChange: event => { update('providerId')(event.target.value); }, placeholder: t('editor.field.providerId') })] })), command.type === 'mcp' && (_jsx(Input, { value: command.value.promptText, onChange: event => { update('promptText')(event.target.value); }, placeholder: t('editor.field.promptText') }))] })] }));
}
//# sourceMappingURL=CommandEditor.js.map