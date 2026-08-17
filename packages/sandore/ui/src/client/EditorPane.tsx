/**
 * EditorPane：工作流 overlay 右栏编辑区（编排态 DagEditor / 执行态 RunView）。
 *
 * 模式与选中态走 `workflow-store`；无顶部模式条（编排/执行由列表点击与测试运行
 * 驱动）。「▶ 测试运行」按钮在 DagEditor header 内（DagEditor 自持 RPC）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/EditorPane
 */
import { useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import { DagEditor } from './DagEditor.tsx'
import { RunView } from './RunView.tsx'
import type { WorkflowOverlayFace } from './workflow-face.ts'
import { getWorkflowState, subscribeWorkflowState } from './workflow-store.ts'
import css from './WorkflowOverlay.module.css'

/** EditorPane 接收的 props。 */
export interface EditorPaneProps {
  /** 类型化的翻译函数（sandore 命名空间）。 */
  t: TranslateNS<'sandore'>
  /** 业务 face（RPC 已解包）。 */
  face: WorkflowOverlayFace
  /** 保存成功后刷新左列表（由 overlay 逐级透传）。 */
  onSaved(id: string): void
}

/** 渲染右栏编辑区。 */
export function EditorPane({ t, face, onSaved }: EditorPaneProps) {
  const mode = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().mode)
  const selectedInstanceId = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().selectedInstanceId)
  const selectedDefinition = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().selectedDefinition)
  const creatingNew = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().creatingNew)

  return (
    <div className={css.editorCol} data-sandore-wf-editor>
      <div className={css.editorBody}>
        {mode === 'dag' ? (
          // 编排态：未选中定义且非新建 → 占位；选中/新建 → DagEditor。
          selectedDefinition === undefined && !creatingNew ? (
            <div className={css.editorPlaceholder}>{t('view.placeholder')}</div>
          ) : (
            <DagEditor
              key={selectedDefinition?.id ?? 'new'}
              t={t}
              initialYaml={selectedDefinition?.initialYaml}
              initialId={selectedDefinition?.id}
              save={face.save}
              onSaved={onSaved}
              listJobs={face.listJobs}
              createJob={face.createJob}
              startInstance={face.startInstance}
            />
          )
        ) : selectedInstanceId === undefined ? (
          <div className={css.editorPlaceholder}>{t('view.placeholder')}</div>
        ) : (
          <RunView
            key={selectedInstanceId}
            t={t}
            instanceId={selectedInstanceId}
            remote={face.remote}
            openSession={face.openSession}
          />
        )}
      </div>
    </div>
  )
}
