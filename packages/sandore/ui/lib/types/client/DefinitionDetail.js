import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * WorkflowDetailFields：工作流定义详情的**受控字段表单**（点击定义直接进 DAG 后，
 * 右侧面板默认展示；选中 Stage/Step 时切换为节点配置）。
 *
 * 仅渲染 name / version / description / settings（defaultTimeout / maxConcurrentAgents）
 * 与工作流级 primary 门禁开关；字段变更经 `onChange` 直接更新宿主 `WorkflowDefinition`
 * （由 DagEditor 持有，保存/Ctrl+S 统一序列化）。不含 header 与保存按钮。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/DefinitionDetail
 */
import { Input } from '@deepseek-ai/dsh-client-ui-primitives';
import { parseOptionalNumber, trimToUndefined } from "./dag-editor-model.js";
import css from './DefinitionDetail.module.css';
/** 渲染工作流详情字段表单（右侧面板默认视图）。 */
export function WorkflowDetailFields({ t, definition, onChange }) {
    return (_jsxs("div", { className: css.body, children: [_jsx("div", { className: css.sectionTitle, children: t('detail.title') }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.label, children: t('detail.name') }), _jsx(Input, { value: definition.name, onChange: event => { onChange({ ...definition, name: event.target.value }); }, placeholder: t('detail.name') })] }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.label, children: t('detail.version') }), _jsx(Input, { value: definition.version, onChange: event => { onChange({ ...definition, version: event.target.value }); }, placeholder: t('detail.version') })] }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.label, children: t('detail.description') }), _jsx(Input, { value: definition.description ?? '', onChange: event => { onChange({ ...definition, description: trimToUndefined(event.target.value) }); }, placeholder: t('detail.description') })] }), _jsx("div", { className: css.sectionTitle, children: t('detail.settings') }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.label, children: t('detail.defaultTimeout') }), _jsx(Input, { type: "number", value: String(definition.settings.defaultTimeout), onChange: event => { onChange({ ...definition, settings: { ...definition.settings, defaultTimeout: parseOptionalNumber(event.target.value) ?? 120 } }); } })] }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.label, children: t('detail.maxConcurrentAgents') }), _jsx(Input, { type: "number", value: String(definition.settings.maxConcurrentAgents), onChange: event => { onChange({ ...definition, settings: { ...definition.settings, maxConcurrentAgents: parseOptionalNumber(event.target.value) ?? 4 } }); } })] }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.label, children: t('detail.primaryGate') }), _jsxs("label", { className: css.checkbox, children: [_jsx("input", { type: "checkbox", checked: definition.gates?.primary?.enabled ?? false, onChange: event => {
                                    const next = { ...(definition.gates ?? {}), primary: { enabled: event.target.checked } };
                                    onChange({ ...definition, gates: next });
                                } }), _jsx("span", { children: t('detail.primaryGate.enabled') })] })] })] }));
}
//# sourceMappingURL=DefinitionDetail.js.map