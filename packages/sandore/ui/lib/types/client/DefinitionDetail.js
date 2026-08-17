import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * DefinitionDetail：工作流定义详情（点击定义后右侧默认显示）。
 *
 * 编辑 name / version / description / settings（defaultTimeout / maxConcurrentAgents），
 * 保存走 `save`（新建 `createDefinition`、后续 `updateYaml`），保存后回填 id 与最新
 * YAML（供「进入编排」的 DagEditor 重新解析）。「进入编排」经 `onEnterEdit` 切两层 DAG。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/DefinitionDetail
 */
import { useState } from 'react';
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives';
import { parseWorkflowYaml, serializeWorkflowYaml } from '@deepseek-ai/dsh-sandore-workflow/yaml';
import { createBlankDefinition, parseOptionalNumber, trimToUndefined, withDefinitionId } from "./dag-editor-model.js";
import { describeSaveError } from "./sandore-save.js";
import css from './DefinitionDetail.module.css';
/** 渲染定义详情。 */
export function DefinitionDetail({ t, initialYaml, initialId, save, onSaved, onEnterEdit }) {
    const [definition, setDefinition] = useState(() => initialYaml === undefined ? createBlankDefinition() : parseWorkflowYaml(initialYaml));
    const [id, setId] = useState(initialId);
    const [saveState, setSaveState] = useState({ kind: 'idle' });
    const runSave = async () => {
        setSaveState({ kind: 'pending' });
        try {
            const savedId = await save(id, serializeWorkflowYaml(definition));
            setId(savedId);
            const saved = withDefinitionId(definition, savedId);
            setDefinition(saved);
            onSaved?.(serializeWorkflowYaml(saved));
            setSaveState({ kind: 'ok' });
        }
        catch (error) {
            const { message, details } = describeSaveError(error);
            setSaveState({ kind: 'error', message, details });
        }
    };
    return (_jsxs("section", { className: css.detail, "aria-label": t('detail.title'), "data-sandore-definition-detail": true, children: [_jsxs("header", { className: css.header, children: [_jsx("span", { className: css.title, children: t('detail.title') }), _jsx("span", { className: css.spacer }), _jsx(Button, { size: "sm", variant: "outline", onClick: onEnterEdit, children: t('detail.edit') }), _jsx(Button, { size: "sm", variant: "primary", disabled: saveState.kind === 'pending', onClick: () => { void runSave(); }, children: saveState.kind === 'pending' ? t('editor.saving') : t('editor.save') })] }), saveState.kind === 'ok' && _jsx("p", { className: css.success, role: "status", children: t('editor.save.success') }), saveState.kind === 'error' && (_jsx("p", { className: css.error, role: "alert", children: saveState.details === undefined
                    ? t('editor.save.failed', { message: saveState.message })
                    : t('editor.save.failed', { message: `${saveState.message} — ${saveState.details}` }) })), _jsxs("div", { className: css.body, children: [_jsxs("label", { className: css.field, children: [_jsx("span", { className: css.label, children: t('detail.name') }), _jsx(Input, { value: definition.name, onChange: event => { setDefinition(current => ({ ...current, name: event.target.value })); }, placeholder: t('detail.name') })] }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.label, children: t('detail.version') }), _jsx(Input, { value: definition.version, onChange: event => { setDefinition(current => ({ ...current, version: event.target.value })); }, placeholder: t('detail.version') })] }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.label, children: t('detail.description') }), _jsx(Input, { value: definition.description ?? '', onChange: event => { setDefinition(current => ({ ...current, description: trimToUndefined(event.target.value) })); }, placeholder: t('detail.description') })] }), _jsx("div", { className: css.sectionTitle, children: t('detail.settings') }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.label, children: t('detail.defaultTimeout') }), _jsx(Input, { type: "number", value: String(definition.settings.defaultTimeout), onChange: event => { setDefinition(current => ({ ...current, settings: { ...current.settings, defaultTimeout: parseOptionalNumber(event.target.value) ?? 120 } })); } })] }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.label, children: t('detail.maxConcurrentAgents') }), _jsx(Input, { type: "number", value: String(definition.settings.maxConcurrentAgents), onChange: event => { setDefinition(current => ({ ...current, settings: { ...current.settings, maxConcurrentAgents: parseOptionalNumber(event.target.value) ?? 4 } })); } })] }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.label, children: t('detail.primaryGate') }), _jsxs("label", { className: css.checkbox, children: [_jsx("input", { type: "checkbox", checked: definition.gates?.primary?.enabled ?? false, onChange: event => {
                                            const next = { ...(definition.gates ?? {}), primary: { enabled: event.target.checked } };
                                            setDefinition(current => ({ ...current, gates: next }));
                                        } }), _jsx("span", { children: t('detail.primaryGate.enabled') })] })] })] })] }));
}
//# sourceMappingURL=DefinitionDetail.js.map