/**
 * WorkflowOverlay：shell.overlay 全局工作流 UI（root scope，不挂会话）。
 *
 * 覆盖 conversation/details 列（sidebar 保持可见可点）：双栏工作台
 * （左 WorkflowList + 分隔条 + 右 EditorPane）。无顶部栏——关闭经侧边栏
 * 入口按钮再次点击（toggle）完成。sidebar 实测宽经 ResizeObserver 同步到
 * `--wf-left`，overlay 内容永远从 sidebar 右缘开始。
 * 打开/关闭/选中态全部在 `workflow-store`。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/WorkflowOverlay
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { GlobalStandardProps, InjectFace, PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import { WorkflowList } from './WorkflowList.tsx'
import { EditorPane } from './EditorPane.tsx'
import { DragHandle } from './DragHandle.tsx'
import type { WorkflowOverlayFace } from './workflow-face.ts'
import {
  getWorkflowState, newDefinition, resizeListWidth, subscribeWorkflowState, toggleListCollapse,
} from './workflow-store.ts'
import css from './WorkflowOverlay.module.css'

/** WorkflowOverlay 的组件 props：注入 face + locale + 全局标准 prop（useWorkspaces）。 */
export type WorkflowOverlayProps =
  InjectFace<WorkflowOverlayFace> & PropsLocale<'sandore'> & GlobalStandardProps

/** 渲染 shell.overlay 全局工作流 UI（关闭时渲染 null）。 */
export function WorkflowOverlay({
  useWorkspaces, listInstances, listDefinitions, startInstance, listModelDirectory, pickDirectory,
  deleteDefinition, deleteInstance, getYaml, save, remote, openSession, modelDirectory, permissions, runCommand, queryPermission, t,
}: WorkflowOverlayProps) {
  const open = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().open)
  const listWidth = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().listWidth)
  const listCollapsed = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().listCollapsed)
  const workspaces = useWorkspaces(state => state.items)
  const [refreshKey, setRefreshKey] = useState(0)
  const layerRef = useRef<HTMLDivElement>(null)

  // sidebar 实测宽 → --wf-left：覆盖 conversation/details 列，sidebar 保持可见。
  // 注：`[data-slot="sidebar"]` 是 display:contents 的 0 宽 wrapper，需沿祖先链找
  // 第一个有实际宽度的元素（`.sidebarCol` grid 列），并观察它保持同步（拖拽/折叠）。
  useEffect(() => {
    const layer = layerRef.current
    if (layer === null) return
    let observed: Element | null = null
    const measure = (): void => {
      let el: Element | null = document.querySelector('[data-slot="sidebar"]')
      let width = 0
      while (el !== null && width <= 0) {
        width = el.getBoundingClientRect().width
        if (width <= 0) el = el.parentElement
      }
      observed = el
      layer.style.setProperty('--wf-left', `${width > 0 ? width : 248}px`)
    }
    measure()
    if (observed !== null) {
      const observer = new ResizeObserver(measure)
      observer.observe(observed)
      return () => { observer.disconnect() }
    }
    return undefined
  }, [open])

  if (!open) return null

  const face: WorkflowOverlayFace = {
    listInstances, listDefinitions, startInstance, listModelDirectory, pickDirectory,
    deleteDefinition, deleteInstance, getYaml, save, remote, openSession, modelDirectory, permissions, runCommand, queryPermission,
  }

  return (
    <div className={css.layer} ref={layerRef} data-sandore-overlay-layer>
      <div className={css.overlay} data-sandore-overlay>
        <div className={css.body}>
          {listCollapsed ? (
            // 收起态：窄条 rail（展开 + 新增）；右栏 EditorPane flex:1 自动占满。
            <ListRail t={t} onExpand={toggleListCollapse} />
          ) : (
            <>
              <WorkflowList t={t} workspaces={workspaces} face={face} refreshKey={refreshKey} width={listWidth} />
              <DragHandle side="list" className={css.dragHandle} onDrag={resizeListWidth} />
            </>
          )}
          <EditorPane
            t={t}
            face={face}
            onSaved={() => { setRefreshKey(key => key + 1) }}
          />
        </div>
      </div>
    </div>
  )
}

/** 收起态左栏窄条 rail：展开按钮 + 新增按钮。
 *
 * 新增按钮直接调 `workflow-store.newDefinition`（与展开态 WorkflowList「新增定义」
 * 同一动作；face 无 newDefinition 字段），overlay 开合间能力保留。 */
function ListRail({ t, onExpand }: {
  t: TranslateNS<'sandore'>
  /** 点击展开左栏（→ toggleListCollapse）。 */
  onExpand(): void
}) {
  return (
    <div className={css.listRail} data-sandore-wf-rail>
      <button
        type="button"
        className={css.railBtn}
        title={t('list.expand')}
        aria-label={t('list.expand')}
        onClick={onExpand}
      >
        {/* panel-left-open：展开左栏。 */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M9 3v18" />
          <path d="m14 9 3 3-3 3" />
        </svg>
      </button>
      <button
        type="button"
        className={css.railBtn}
        title={t('panel.add.definition')}
        aria-label={t('panel.add.definition')}
        onClick={() => { newDefinition() }}
      >
        {/* plus：新增定义（切编排态 + 空白 DagEditor）。 */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12h14" />
          <path d="M12 5v14" />
        </svg>
      </button>
    </div>
  )
}
