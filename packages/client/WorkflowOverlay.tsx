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

/** WorkflowOverlay 接收的可选参数（**两个 WebUI 宿主的唯一差异**）。 */
export interface WorkflowOverlayProps {
  /**
   * 是否忽略 `workflow-store.open` 恒常渲染（默认 false = 侧栏席位：按 store 开合）。
   *
   * 主代理会话内的「工作流」tab 传 `true`：那个宿主常驻（没有开合概念），
   * 而且它与侧栏**共用同一份 `workflow-store`**（同一份页面状态），若照读 open，
   * 关掉侧栏会连带把 tab 里的页面变成 null。
   */
  readonly alwaysVisible?: boolean | undefined
  /**
   * **宿主会话过滤**（可选；只有主代理会话内的 tab 传 = 该会话 id）：
   * 实例列表只列绑定到该会话的实例（硬约束：绝不列别的会话的实例）；
   * 右栏执行视图也只渲染属于该会话的实例。侧栏不传 ⇒ 行为与改动前完全一致。
   */
  readonly hostFilter?: string | undefined
  /**
   * 是否渲染运行视图底部的讨论输入面（`DiscussionInput`）。
   * 缺省 `true`（侧栏席位保持现状）；tab 传 `false`（该 tab 里不得出现任何输入面）。
   */
  readonly showDiscussionInput?: boolean | undefined
}

/**
 * 渲染中心列内嵌工作流视图（关闭时渲染 null；face 未就绪时降级 null——
 * mount 在 install 之后，理论不发生，防御即可）。
 *
 * **两个宿主共用**：侧栏席位（`view-seat.tsx`，无参）与主代理会话内的「工作流」tab
 * （`main-agent-workflow-tab.tsx`，传 `alwaysVisible` + `hostFilter` + `showDiscussionInput=false`）。
 * 参数只有上面三个，页面本体（列表/模式切换/搜索/运行工作流/新增定义/编辑器）完全同一份。
 */
export function WorkflowOverlay({ alwaysVisible = false, hostFilter, showDiscussionInput }: WorkflowOverlayProps = {}) {
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

  if (!alwaysVisible && !open) return null
  if (face === undefined) return null

  return (
    <div className={css.viewRoot} data-sandore-wf-view>
      <div className={css.body}>
        {listCollapsed ? (
          // 收起态：窄条 rail（展开 + 新增）；右栏 EditorPane flex:1 自动占满。
          <ListRail t={t} onExpand={toggleListCollapse} />
        ) : (
          <>
            <WorkflowList
              t={t}
              workspaces={workspaces}
              face={face}
              refreshKey={refreshKey}
              width={listWidth}
              {...(hostFilter === undefined ? {} : { hostFilter })}
            />
            <DragHandle side="list" className={css.dragHandle} onDrag={resizeListWidth} />
          </>
        )}
        <EditorPane
          t={t}
          face={face}
          onSaved={() => { setRefreshKey(key => key + 1) }}
          {...(hostFilter === undefined ? {} : { hostFilter })}
          {...(showDiscussionInput === undefined ? {} : { showDiscussionInput })}
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
