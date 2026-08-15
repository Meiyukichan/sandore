/** sidebar.footer.action 工作流入口：设置上方的按钮 + 点击展开 WorkflowPanel。 */

import { useState } from 'react'
import { IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { HostCall } from './host.ts'
import { WorkflowPanel } from './WorkflowPanel.tsx'
import css from './WorkflowButton.module.css'

/** 注册进 slot 的业务 face。 */
export interface WorkflowButtonFace {
  /** Client→Host RPC 桥。 */
  host: HostCall
}

/** sidebar.footer.action 的组件 props（owner + 注入 face + locale）。 */
export type WorkflowButtonProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<WorkflowButtonFace> & PropsLocale<'sandore'>

/** 渲染工作流入口按钮，点击切换 WorkflowPanel 展开/收起。 */
export function WorkflowButton({ wide, host, t }: WorkflowButtonProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className={wide ? css.layer : `${css.layer} ${css.rail}`}>
      {open && <WorkflowPanel t={t} host={host} />}
      <div className={css.footerButtons}>
        <button
          type="button"
          className={css.badge}
          data-sandore-btn
          aria-label={t('button.aria')}
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconBranchOutline16 />
          {wide && <span className={css.badgeLabel}>{t('button.trigger')}</span>}
        </button>
      </div>
    </div>
  )
}
