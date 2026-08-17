import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * NewDefinitionView：新建工作流向导（点击「新增定义」后进入）。
 *
 * 顶部两个模式按钮：**对话生成**（静态占位，待后续接入）/ **手动创建**（进入
 * DagEditor 编排）。下方始终展示**可编辑的工作流详情**（WorkflowDetailFields），
 * 模式切换不丢失详情编辑态。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/NewDefinitionView
 */
import { useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { serializeWorkflowYaml } from '@deepseek-ai/dsh-sandore-workflow/yaml';
import { DagEditor } from "./DagEditor.js";
import { WorkflowDetailFields } from "./DefinitionDetail.js";
import { createBlankDefinition } from "./dag-editor-model.js";
import css from './WorkflowOverlay.module.css';
/** 渲染新建工作流向导。 */
export function NewDefinitionView({ t, face, onSaved }) {
    // 新建定义骨架（单 Stage 空白），详情表单直接编辑它；保存走 face.save。
    const [definition, setDefinition] = useState(() => createBlankDefinition());
    const [mode, setMode] = useState('chat');
    const [savedId, setSavedId] = useState(undefined);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(undefined);
    const runSave = async () => {
        setSaving(true);
        setSaveError(undefined);
        try {
            const id = await face.save(savedId, serializeWorkflowYaml(definition));
            setSavedId(id);
            onSaved(id);
        }
        catch (error) {
            setSaveError(error instanceof Error ? error.message : String(error));
        }
        finally {
            setSaving(false);
        }
    };
    return (_jsxs("div", { className: css.newView, "data-sandore-new-definition": true, children: [_jsxs("div", { className: css.createModes, children: [_jsx(Button, { size: "sm", variant: mode === 'chat' ? 'primary' : 'ghost', onClick: () => { setMode('chat'); }, children: t('create.mode.chat') }), _jsx(Button, { size: "sm", variant: mode === 'manual' ? 'primary' : 'ghost', onClick: () => { setMode('manual'); }, children: t('create.mode.manual') }), _jsx("span", { className: css.spacer }), _jsx(Button, { size: "sm", variant: "outline", disabled: saving, onClick: () => { void runSave(); }, children: saving ? t('editor.saving') : t('editor.save') })] }), saveError !== undefined && (_jsx("p", { className: css.error, role: "alert", children: t('panel.error', { message: saveError }) })), mode === 'chat' ? (_jsxs("div", { className: css.createChat, children: [_jsx("div", { className: css.createChatHint, children: t('create.chat.hint') }), _jsx("div", { className: css.createChatDetail, children: _jsx(WorkflowDetailFields, { t: t, definition: definition, onChange: setDefinition }) })] })) : (_jsx(DagEditor, { t: t, initialYaml: serializeWorkflowYaml(definition), initialId: savedId, save: face.save, onSaved: onSaved, listJobs: face.listJobs, createJob: face.createJob, startInstance: face.startInstance }, `new-${savedId ?? 'draft'}`))] }));
}
//# sourceMappingURL=NewDefinitionView.js.map