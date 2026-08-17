import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * EditorPane：工作流 overlay 右栏编辑区（模式条 + 编排态 DagEditor / 执行态 RunView）。
 *
 * 模式与选中态走 `workflow-store`；模式条提供 编排/执行 toggle 与「▶ 测试运行」
 * （对当前定义找/建 Job 后 `startInstance`，成功后自动切执行态并选中新实例）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/EditorPane
 */
import { useState, useSyncExternalStore } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { DagEditor } from "./DagEditor.js";
import { DefinitionDetail } from "./DefinitionDetail.js";
import { RunView } from "./RunView.js";
import { getWorkflowState, selectInstance, setWorkflowState, subscribeWorkflowState } from "./workflow-store.js";
import { describeError } from "./describe-error.js";
import css from './WorkflowOverlay.module.css';
/** 渲染右栏编辑区。 */
export function EditorPane({ t, face, onSaved }) {
    const mode = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().mode);
    const definitionView = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().definitionView);
    const selectedInstanceId = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().selectedInstanceId);
    const selectedDefinition = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().selectedDefinition);
    const [running, setRunning] = useState(false);
    const [runError, setRunError] = useState(undefined);
    const title = mode === 'dag'
        ? (selectedDefinition?.id === undefined ? t('editor.newDefinition') : t('editor.title'))
        : (selectedInstanceId ?? t('panel.title'));
    /** ▶ 测试运行：对当前定义找/建 Job 后启动实例，成功后切执行态选中新实例。 */
    const runTest = async () => {
        const definitionId = selectedDefinition?.id;
        if (definitionId === undefined)
            return;
        setRunning(true);
        setRunError(undefined);
        try {
            const jobs = await face.listJobs(definitionId);
            const job = jobs[0] ?? await face.createJob({ name: `测试-${definitionId.slice(0, 8)}`, workflowId: definitionId });
            const run = await face.startInstance({ jobId: job.id, originalInput: t('editor.testRun') });
            selectInstance(run.instanceId);
        }
        catch (error) {
            setRunError(describeError(error));
        }
        finally {
            setRunning(false);
        }
    };
    return (_jsxs("div", { className: css.editorCol, "data-sandore-wf-editor": true, children: [_jsxs("div", { className: css.modeBar, children: [_jsx("span", { className: css.editorTitle, children: title }), _jsx("span", { className: css.spacer }), _jsxs("div", { className: css.modeSwitch, role: "tablist", "aria-label": t('panel.title'), children: [_jsx("button", { type: "button", role: "tab", "aria-selected": mode === 'dag', className: mode === 'dag' ? css.modeActive : '', onClick: () => { setWorkflowState({ mode: 'dag' }); }, children: t('editor.mode.dag') }), _jsx("button", { type: "button", role: "tab", "aria-selected": mode === 'run', className: mode === 'run' ? css.modeActive : '', onClick: () => { setWorkflowState({ mode: 'run' }); }, children: t('editor.mode.run') })] }), mode === 'dag' && selectedDefinition?.id !== undefined && (_jsxs(Button, { size: "sm", variant: "primary", disabled: running, onClick: () => { void runTest(); }, children: ["\u25B6 ", t('editor.testRun')] }))] }), runError !== undefined && (_jsx("p", { className: css.runError, role: "alert", children: t('panel.error', { message: runError }) })), _jsx("div", { className: css.editorBody, children: mode === 'dag' ? (selectedDefinition !== undefined && definitionView === 'detail' ? (_jsx(DefinitionDetail, { t: t, initialYaml: selectedDefinition.initialYaml, initialId: selectedDefinition.id, save: face.save, onSaved: (yaml) => {
                        setWorkflowState({ selectedDefinition: { id: selectedDefinition.id, initialYaml: yaml } });
                        onSaved(selectedDefinition.id ?? '');
                    }, onEnterEdit: () => { setWorkflowState({ definitionView: 'edit' }); } }, selectedDefinition.id ?? 'new')) : (_jsx(DagEditor, { t: t, initialYaml: selectedDefinition?.initialYaml, initialId: selectedDefinition?.id, save: face.save, onSaved: onSaved }, selectedDefinition?.id ?? 'new'))) : selectedInstanceId === undefined ? (_jsx("div", { className: css.editorPlaceholder, children: t('view.placeholder') })) : (_jsx(RunView, { t: t, instanceId: selectedInstanceId, remote: face.remote, openSession: face.openSession }, selectedInstanceId)) })] }));
}
//# sourceMappingURL=EditorPane.js.map