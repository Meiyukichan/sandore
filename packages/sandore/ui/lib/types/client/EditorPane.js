import { jsx as _jsx } from "react/jsx-runtime";
/**
 * EditorPane：工作流 overlay 右栏编辑区（编排态 DagEditor / 执行态 RunView）。
 *
 * 模式与选中态走 `workflow-store`；无顶部模式条（编排/执行由列表点击与测试运行
 * 驱动）。「▶ 测试运行」按钮在 DagEditor header 内（DagEditor 自持 RPC）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/EditorPane
 */
import { useSyncExternalStore } from 'react';
import { DagEditor } from "./DagEditor.js";
import { RunView } from "./RunView.js";
import { getWorkflowState, subscribeWorkflowState } from "./workflow-store.js";
import css from './WorkflowOverlay.module.css';
/** 渲染右栏编辑区。 */
export function EditorPane({ t, face, onSaved }) {
    const mode = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().mode);
    const selectedInstanceId = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().selectedInstanceId);
    const selectedDefinition = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().selectedDefinition);
    const creatingNew = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().creatingNew);
    return (_jsx("div", { className: css.editorCol, "data-sandore-wf-editor": true, children: _jsx("div", { className: css.editorBody, children: mode === 'dag' ? (
            // 编排态：未选中定义且非新建 → 占位；选中/新建 → DagEditor。
            selectedDefinition === undefined && !creatingNew ? (_jsx("div", { className: css.editorPlaceholder, children: t('view.placeholder') })) : (_jsx(DagEditor, { t: t, initialYaml: selectedDefinition?.initialYaml, initialId: selectedDefinition?.id, save: face.save, onSaved: onSaved, startInstance: face.startInstance }, selectedDefinition?.id ?? 'new'))) : selectedInstanceId === undefined ? (_jsx("div", { className: css.editorPlaceholder, children: t('view.placeholder') })) : (_jsx(RunView, { t: t, instanceId: selectedInstanceId, remote: face.remote, openSession: face.openSession, modelDirectory: face.modelDirectory, permissions: face.permissions, runCommand: face.runCommand, queryPermission: face.queryPermission }, selectedInstanceId)) }) }));
}
//# sourceMappingURL=EditorPane.js.map