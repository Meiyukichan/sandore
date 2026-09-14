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
  /**
   * **宿主会话过滤**（可选；只有主代理会话内的「工作流」tab 传 = 该会话 id）。
   *
   * 为什么必须逐级透传到 `RunView`：选中实例存在**共享的** `workflow-store` 里，
   * 切到本 tab 时可能残留**别的会话**的选中实例；`RunView` 的 `hostFilter` 语义正是
   * 「只认领属于该会话的实例」，认领不到就显示该视图自己的分支（绝不显示别的会话的实例）。
   * 侧栏席位不传 ⇒ 行为与改动前完全一致。
   */
  hostFilter?: string | undefined
  /**
   * 是否渲染运行视图底部的讨论输入面（`DiscussionInput`）。
   * 缺省 `true`（侧栏席位保持现状）；主代理会话内的 tab 传 `false`（该 tab 里不得有输入面）。
   */
  showDiscussionInput?: boolean | undefined
}

/** 渲染右栏编辑区。 */
export function EditorPane({ t, face, onSaved, hostFilter, showDiscussionInput }: EditorPaneProps) {
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
              face={face}
            />
          )
        ) : selectedInstanceId === undefined ? (
          <div className={css.editorPlaceholder}>{t('view.placeholder')}</div>
        ) : (
          <RunView
            key={selectedInstanceId}
            t={t}
            instanceId={selectedInstanceId}
            {...(hostFilter === undefined ? {} : { hostFilter })}
            {...(showDiscussionInput === undefined ? {} : { showDiscussionInput })}
            remote={face.remote}
            openSession={face.openSession}
            modelDirectory={face.modelDirectory}
            permissions={face.permissions}
            runCommand={face.runCommand}
            queryPermission={face.queryPermission}
          />
        )}
      </div>
    </div>
  )
}
