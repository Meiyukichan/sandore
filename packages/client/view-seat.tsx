/**
 * 工作流视图挂载：中心列尾子容器（React 从不管理的 trailing child）+ 独立
 * React 根渲染 WorkflowOverlay；会话列内容由全局 CSS 隐藏（保持挂载，关闭后
 * 聊天/编辑器状态零丢失）。开态 attr 打在**列元素自身**（`data-sandore-open`，
 * React 不会清理它没管理的 data 属性），CSS 组合器按列级作用域显隐视图。
 *
 * 列匹配为三世代（对照 dsh-taskboard board-mount.tsx，已在本机 shell 验证）：
 * dev 壳 `data-pane="conversation"`、官方 layout 的 CSS-Module centerCol、
 * DSH Desktop 的扩展壳 conversation surface。
 *
 * 关闭时机（任一即关，state 保留可再开）：
 * 1. 捕获阶段 click 命中侧栏任意会话/工作区/搜索结果/新建会话行；
 * 2. 入口 toggle（sidebar-seat 自身 onClick，不在本模块）；
 * 3. face.openSession（先 close 再 sessions.open，index.ts 装配）；
 * 4. 其他 DSH family 面板激活（`dsh-panel-activate` 驱逐事件，开自家时派发、
 *    听别家时收）。
 * @module @meiyukichan/dsh-sandore/src/client/view-seat
 */
import { Component, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { WorkflowOverlay } from './WorkflowOverlay.tsx'
import { SEAT_ENTRY_SELECTOR } from './sidebar-seat.ts'
import { closeWorkflowOverlay, getWorkflowState, subscribeWorkflowState } from './workflow-store.ts'
import './workflow-seat.css'

/** 本插件视图容器的稳定 data 属性选择器。 */
export const SEAT_VIEW_SELECTOR = '[data-sandore-seat-view]'

const CONVERSATION_COLUMN_SELECTOR =
  '[data-pane="conversation"], [class*="centerCol"], .dshDesktopConversationSurface'
/** 列级开态 attr（打在中心列元素上）。 */
const OPEN_ATTR = 'data-sandore-open'
/** 侧栏可点击行的类匹配（会话/项目/搜索结果/新建会话）——命中即收起视图。 */
const SIDEBAR_ROW_SELECTOR =
  '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'
/** 跨插件面板激活事件（family 共用约定）；detail 为激活面板名。 */
const ACTIVATE_EVENT = 'dsh-panel-activate'
/** 本插件面板名（与 taskboard 的 'dsh-taskboard'、ssh 的面板名互异）。 */
const PANEL_NAME = 'dsh-sandore'

/** 查找中心列元素（三世代选择器依次尝试）。 */
function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

/**
 * 视图错误边界：渲染崩溃时绝不白屏。捕获后移除列级开态 attr（会话内容立即
 * 恢复显示）并关闭 store（下次点入口重新挂载重试），自身渲染 null 退场。
 */
export class SeatViewBoundary extends Component<{ children: ReactNode; onCrash(): void }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, info: { componentStack?: string | null }): void {
    console.error('[dsh-sandore] seat view crashed; recovering conversation column:', error, info.componentStack)
    this.props.onCrash()
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/**
 * 挂载视图容器与 React 根，绑定开合 attr、点击自动关与驱逐互斥；返回 disposer
 * （逆序清理：监听器 / Observer / 列 attr / React 根 / 容器）。
 */
export function mountWorkflowSeatView(): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  let column: HTMLElement | undefined

  const ensure = (): void => {
    // 列被整体重建（桌面扩展壳）时旧容器随宿主 DOM 失效：拆掉旧 React 根重挂。
    if (container !== undefined && !container.isConnected) {
      try {
        root?.unmount()
      } catch {
        // 旧根已随宿主 DOM 卸载——忽略即可。
      }
      root = undefined
      container = undefined
      column = undefined
    }
    if (container !== undefined) return
    column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset.sandoreSeatView = ''
    column.appendChild(container)
    root = createRoot(container)
    // WorkflowOverlay 内部自读 seat-bridge（face/workspaces/t）；关闭时渲染 null。
    // 错误边界兜底：渲染崩溃时恢复会话列显示 + 关闭 store（不白屏、可重试）。
    root.render(
      <SeatViewBoundary onCrash={handleCrash}>
        <WorkflowOverlay />
      </SeatViewBoundary>,
    )
    // 迟挂补打开态：shell 就绪晚于 open 翻转时，由这里补上列 attr。
    if (getWorkflowState().open && !column.hasAttribute(OPEN_ATTR)) column.setAttribute(OPEN_ATTR, '')
  }

  /** 边界崩溃回调：摘开态 attr + 关 store（store 通知会再走 applyOpen，幂等）。 */
  const handleCrash = (): void => {
    column?.removeAttribute(OPEN_ATTR)
    if (getWorkflowState().open) closeWorkflowOverlay()
  }

  // body 级 watcher：等待中心列首次渲染 / 整体重建后补挂。
  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  /** 开合状态 → 列 attr（只在值变化时写 DOM，避免冗余 mutation 记录）；仅在
      「关闭→打开」翻转沿广播驱逐事件（open 保持期间的重复 store 通知不重复
      广播，避免给 taskboard/ssh 造成无谓的监听 churn）。 */
  let announcedOpen = false
  const applyOpen = (): void => {
    if (column === undefined) return
    const open = getWorkflowState().open
    if (open) {
      if (!announcedOpen) {
        document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
        announcedOpen = true
      }
      if (!column.hasAttribute(OPEN_ATTR)) column.setAttribute(OPEN_ATTR, '')
    } else {
      announcedOpen = false
      if (column.hasAttribute(OPEN_ATTR)) column.removeAttribute(OPEN_ATTR)
    }
  }
  /** 别家面板打开 → 收起自家（忽略自家广播，避免自驱逐）。 */
  const onOtherActivate = (event: Event): void => {
    if ((event as CustomEvent).detail !== PANEL_NAME && getWorkflowState().open) closeWorkflowOverlay()
  }
  /**
   * 捕获阶段点击侧栏行 → 收起视图。先于会话行自身的 React onClick 执行，
   * 视图先收起、会话内容立即显示，随后会话切换发生（无「点两次」）。
   * 0.4.1 竞态修复（taskboard 教训）：本插件入口子树整体豁免——部分 shell 的
   * DOM 里插入点落在 class 含 newSession 的容器内，不豁免的话入口点击会被本
   * 监听器先 closeWorkflowOverlay，再被入口自身的 toggle 翻回去（症状：视图闪
   * 关或入口按钮关不掉）。豁免必须按「入口子树」判定（closest 而非元素自身
   * 匹配）：入口可能嵌在带 newSession 类的祖先容器里，仅对选择器加 :not()
   * 排除元素自身挡不住那种嵌套形态。
   */
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!getWorkflowState().open) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SEAT_ENTRY_SELECTOR) !== null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) closeWorkflowOverlay()
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = subscribeWorkflowState(applyOpen)
  applyOpen()
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    unsubscribe()
    column?.removeAttribute(OPEN_ATTR)
    root?.unmount()
    container?.remove()
  }
}
