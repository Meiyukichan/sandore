/** sidebar.footer.action 工作流入口：点击打开 shell.overlay 全局工作流 UI（设置上方）。 */

import { useSyncExternalStore } from 'react'
import { IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { getWorkflowState, openWorkflowOverlay, subscribeWorkflowState } from './workflow-store.ts'
import css from './WorkflowButton.module.css'

/** 注册进 slot 的业务 face：打开工作流 overlay 的回调。 */
export interface WorkflowButtonFace {
  /** 点击「工作流」：打开 shell.overlay 全局工作流 UI。 */
  onOpenWorkflow(): void
}

/** sidebar.footer.action 的组件 props（owner + 注入 face + locale）。 */
export type WorkflowButtonProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<WorkflowButtonFace> & PropsLocale<'sandore'>

/** 渲染工作流入口按钮，点击打开全局工作流 overlay；overlay 打开时按钮高亮。 */
export function WorkflowButton({ wide, t, onOpenWorkflow }: WorkflowButtonProps) {
  const open = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().open)
  return (
    <div className={wide ? css.layer : `${css.layer} ${css.rail}`}>
      <button
        type="button"
        className={`${css.badge} ${open ? css.badgeActive : ''}`}
        data-sandore-btn
        aria-label={t('button.aria')}
        aria-expanded={open}
        onClick={() => { onOpenWorkflow() }}
      >
        <IconBranchOutline16 />
        {wide && <span className={css.badgeLabel}>{t('button.trigger')}</span>}
      </button>
    </div>
  )
}
