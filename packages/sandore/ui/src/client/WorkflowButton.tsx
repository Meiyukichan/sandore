/** sidebar.footer.action 工作流入口：点击切换 shell.overlay 全局工作流 UI（设置上方）。 */

import { useSyncExternalStore } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { getWorkflowState, toggleWorkflowOverlay, subscribeWorkflowState } from './workflow-store.ts'
import css from './WorkflowButton.module.css'

/** 注册进 slot 的业务 face：切换工作流 overlay 开关的回调。 */
export interface WorkflowButtonFace {
  /** 点击「工作流」：切换 shell.overlay 全局工作流 UI 开关（开→关、关→开）。 */
  onToggleWorkflow(): void
}

/** sidebar.footer.action 的组件 props（owner + 注入 face + locale）。 */
export type WorkflowButtonProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<WorkflowButtonFace> & PropsLocale<'sandore'>

/**
 * 工作流图标：Lucide "workflow" 官方形状——顶部左右两个节点 + 底部中间节点，
 * 顶部水平连线 + 中间垂直连线（标准工作流符号）。手绘内联 SVG 16×16，
 * stroke = currentColor。
 */
function WorkflowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      {/* 顶部左节点 */}
      <rect x="1.6" y="1.6" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
      {/* 顶部右节点 */}
      <rect x="10.4" y="1.6" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
      {/* 底部中间节点 */}
      <rect x="6" y="10.4" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
      {/* 顶部两节点水平连线 */}
      <path d="M5.6 3.6h4.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      {/* 顶部连线中点 → 底部节点（垂直连线） */}
      <path d="M8 5.6v4.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** 渲染工作流入口按钮，点击切换全局工作流 overlay 开关；overlay 打开时按钮高亮。 */
export function WorkflowButton({ wide, t, onToggleWorkflow }: WorkflowButtonProps) {
  const open = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().open)
  return (
    <div className={wide ? css.layer : `${css.layer} ${css.rail}`}>
      <button
        type="button"
        className={`${css.badge} ${open ? css.badgeActive : ''}`}
        data-sandore-btn
        aria-label={t('button.aria')}
        aria-expanded={open}
        onClick={() => { onToggleWorkflow() }}
      >
        <WorkflowIcon />
        {wide && <span className={css.badgeLabel}>{t('button.trigger')}</span>}
      </button>
    </div>
  )
}
