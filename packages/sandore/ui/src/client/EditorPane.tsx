/**
 * EditorPane：工作流 overlay 右栏编辑区（模式条 + 编排态 DagEditor / 执行态 RunView）。
 *
 * 模式与选中态走 `workflow-store`；模式条提供 编排/执行 toggle 与「▶ 测试运行」
 * （对当前定义找/建 Job 后 `startInstance`，成功后自动切执行态并选中新实例）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/EditorPane
 */
import { useState, useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import { DagEditor } from './DagEditor.tsx'
import { DefinitionDetail } from './DefinitionDetail.tsx'
import { RunView } from './RunView.tsx'
import type { WorkflowOverlayFace } from './workflow-face.ts'
import { getWorkflowState, selectInstance, setWorkflowState, subscribeWorkflowState } from './workflow-store.ts'
import { describeError } from './describe-error.ts'
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
  const definitionView = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().definitionView)
  const selectedInstanceId = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().selectedInstanceId)
  const selectedDefinition = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().selectedDefinition)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | undefined>(undefined)

  const title = mode === 'dag'
    ? (selectedDefinition?.id === undefined ? t('editor.newDefinition') : t('editor.title'))
    : (selectedInstanceId ?? t('panel.title'))

  /** ▶ 测试运行：对当前定义找/建 Job 后启动实例，成功后切执行态选中新实例。 */
  const runTest = async (): Promise<void> => {
    const definitionId = selectedDefinition?.id
    if (definitionId === undefined) return
    setRunning(true)
    setRunError(undefined)
    try {
      const jobs = await face.listJobs(definitionId)
      const job = jobs[0] ?? await face.createJob({ name: `测试-${definitionId.slice(0, 8)}`, workflowId: definitionId })
      const run = await face.startInstance({ jobId: job.id, originalInput: t('editor.testRun') })
      selectInstance(run.instanceId)
    } catch (error) {
      setRunError(describeError(error))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className={css.editorCol} data-sandore-wf-editor>
      <div className={css.modeBar}>
        <span className={css.editorTitle}>{title}</span>
        <span className={css.spacer} />
        <div className={css.modeSwitch} role="tablist" aria-label={t('panel.title')}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'dag'}
            className={mode === 'dag' ? css.modeActive : ''}
            onClick={() => { setWorkflowState({ mode: 'dag' }) }}
          >
            {t('editor.mode.dag')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'run'}
            className={mode === 'run' ? css.modeActive : ''}
            onClick={() => { setWorkflowState({ mode: 'run' }) }}
          >
            {t('editor.mode.run')}
          </button>
        </div>
        {mode === 'dag' && selectedDefinition?.id !== undefined && (
          <Button size="sm" variant="primary" disabled={running} onClick={() => { void runTest() }}>
            ▶ {t('editor.testRun')}
          </Button>
        )}
      </div>
      {runError !== undefined && (
        <p className={css.runError} role="alert">{t('panel.error', { message: runError })}</p>
      )}
      <div className={css.editorBody}>
        {mode === 'dag' ? (
          selectedDefinition !== undefined && definitionView === 'detail' ? (
            <DefinitionDetail
              key={selectedDefinition.id ?? 'new'}
              t={t}
              initialYaml={selectedDefinition.initialYaml}
              initialId={selectedDefinition.id}
              save={face.save}
              onSaved={(yaml) => {
                setWorkflowState({ selectedDefinition: { id: selectedDefinition.id, initialYaml: yaml } })
                onSaved(selectedDefinition.id ?? '')
              }}
              onEnterEdit={() => { setWorkflowState({ definitionView: 'edit' }) }}
            />
          ) : (
            <DagEditor
              key={selectedDefinition?.id ?? 'new'}
              t={t}
              initialYaml={selectedDefinition?.initialYaml}
              initialId={selectedDefinition?.id}
              save={face.save}
              onSaved={onSaved}
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
