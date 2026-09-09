/**
 * WorkflowOverlay：中心列内嵌工作流视图（非遮罩浮层）。
 *
 * 自挂载树（view-seat 经 createRoot 渲染到中心列尾子容器，非 slot 渲染机）：
 * face / workspaces / t 全部经 seat-bridge 读取（组件树拿不到 slot 注入 props）。
 * 双栏工作台（左 WorkflowList + 分隔条 + 右 EditorPane），无顶部栏——关闭经侧栏
 * 入口 toggle、点击任意侧栏会话行或 family 驱逐事件完成（view-seat）。打开/关闭/
 * 选中态全部在 `workflow-store`；关闭时渲染 null（容器显隐由 workflow-seat.css
 * 按列级开态 attr 接管）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/WorkflowOverlay
 */
import { useState, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import { WorkflowList } from './WorkflowList.tsx'
import { EditorPane } from './EditorPane.tsx'
import { DragHandle } from './DragHandle.tsx'
import { seatT, useSeatFace, useSeatLocaleRevision, useSeatWorkspaces } from './seat-bridge.ts'
import {
  getWorkflowState, newDefinition, resizeListWidth, subscribeWorkflowState, toggleListCollapse,
} from './workflow-store.ts'
import css from './WorkflowOverlay.module.css'

/**
 * 渲染中心列内嵌工作流视图（关闭时渲染 null；face 未就绪时降级 null——
 * mount 在 install 之后，理论不发生，防御即可）。
 */
export function WorkflowOverlay() {
  const open = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().open)
  const listWidth = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().listWidth)
  const listCollapsed = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().listCollapsed)
  const face = useSeatFace()
  const workspaces = useSeatWorkspaces()
  // 翻译函数引用稳定（bind(NS) 缓存，调用时读当前语言）；locale revision 变化
  // 驱动本树重渲染，文本即切换为新语言（与 slot 渲染机同一信号源）。
  const t: TranslateNS<'sandore'> = seatT()
  useSeatLocaleRevision()
  const [refreshKey, setRefreshKey] = useState(0)

  if (!open) return null
  if (face === undefined) return null

  return (
    <div className={css.viewRoot} data-sandore-wf-view>
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
  )
}

/** 收起态左栏窄条 rail：展开按钮 + 新增按钮。
 *
 * 新增按钮直接调 `workflow-store.newDefinition`（与展开态 WorkflowList「新增定义」
 * 同一动作；face 无 newDefinition 字段），视图开合间能力保留。 */
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
