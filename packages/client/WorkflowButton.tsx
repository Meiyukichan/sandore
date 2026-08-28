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
      <path d="M2 4.5C2 3.67157 2.67157 3 3.5 3C4.32843 3 5 3.67157 5 4.5C5 5.32843 4.32843 6 3.5 6C2.67157 6 2 5.32843 2 4.5ZM3.5 2C2.11929 2 1 3.11929 1 4.5C1 5.70948 1.85888 6.71836 3 6.94999V9.05001C1.85888 9.28164 1 10.2905 1 11.5C1 12.8807 2.11929 14 3.5 14C4.70948 14 5.71836 13.1411 5.94999 12H10.05C10.2816 13.1411 11.2905 14 12.5 14C13.8807 14 15 12.8807 15 11.5C15 10.2905 14.1411 9.28164 13 9.05001V6.94999C14.1411 6.71836 15 5.70948 15 4.5C15 3.11929 13.8807 2 12.5 2C11.2905 2 10.2816 2.85888 10.05 4H5.94999C5.71836 2.85888 4.70948 2 3.5 2ZM5.94999 5H10.05C10.2324 5.85811 10.8581 6.55625 11.6725 6.84607C11.7704 6.88046 11.8708 6.90979 11.9735 6.9336C11.9823 6.93561 11.9911 6.93751 12 6.93929V9.05001C10.8589 9.28164 10 10.2905 10 11.5C10 11.6712 10.0144 11.839 10.0418 12.0022C10.0446 12.0181 10.0475 12.0339 10.05 12.0497V12.05H5.94999C5.71836 10.9089 4.70948 10 3.5 10C3.32884 10 3.16098 10.0144 2.99779 10.0418C2.98193 10.0446 2.96613 10.0475 2.95039 10.05H2.94999V6.94999C4.09112 6.71836 4.94999 5.70948 4.94999 4.5C4.94999 4.32884 4.93564 4.16098 4.90821 3.99779C4.90541 3.98193 4.90248 3.96613 4.89943 3.95039V3.94999H5.94999C5.94999 3.9666 5.95007 3.98319 5.95023 3.99976C5.95007 4.16639 5.96055 4.33072 5.98089 4.49206C5.96055 4.33072 5.94999 4.16639 5.94999 4V5ZM11 4.5C11 3.67157 11.6716 3 12.5 3C13.3284 3 14 3.67157 14 4.5C14 5.32843 13.3284 6 12.5 6C11.6716 6 11 5.32843 11 4.5ZM2 11.5C2 10.6716 2.67157 10 3.5 10C4.32843 10 5 10.6716 5 11.5C5 12.3284 4.32843 13 3.5 13C2.67157 13 2 12.3284 2 11.5ZM11 11.5C11 10.6716 11.6716 10 12.5 10C13.3284 10 14 10.6716 14 11.5C14 12.3284 13.3284 13 12.5 13C11.6716 13 11 12.3284 11 11.5Z" fill="currentColor" fillRule="nonzero" />
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
