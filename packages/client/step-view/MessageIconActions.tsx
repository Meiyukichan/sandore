// MessageIconActions（B2a step-view 版）：user/assistant 消息共用的 IconActions
// chrome——复制实时、可选 branch 接线、可选日期感知时钟。逐字抄自 DSH 0.1.2-rc.1
// `ui-chat/src/client/chat/MessageIconActions.tsx` + 同名 module.css（只读参考
// deepseek-harness）。
//
// 差异：
// - locale 面收窄为 sandore 命名空间；时间/日期格式函数复用旧路径同源实现
//   （../chat/message-chrome.ts 的 formatMessageClock、../chat/use-calendar-day.ts
//   的 useCalendarDay——两者与 rc.1 逐字同逻辑，仅命名空间不同，不重复抄）；
// - B3：补上 rc.1 的 usageAction 槽位（branch 之后、end 时钟之前）。槽内容由
//   turn-tail 行供给（只读 stat 药丸，见 TurnTailNodeView.tsx 文件头的 B3 裁剪
//   说明——rc.1 此处是 TurnUsagePanel/TurnTimePanel 的可点开明细对话框触发，
//   面板不做浮层，仅静态读数；若未来接明细，槽位已就位无需改本文件）。
//
// 新 CSS（message-icon-actions.module.css）全部令牌化（--dsh-content-font-delta
// 链、--dsw-alias-*），并保留 rc.1 的 hover reveal 规则
// （data-actions-reveal / 相邻 user 行隐藏动作）；面板行默认不挂
// data-actions-reveal，因此动作行恒可见（与 rc.1 主机流行为一致）。
// @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/MessageIconActions
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  IconBranchOutline16, IconCheckOutline16, IconCopyOutline16, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { formatMessageClock } from '../chat-utils/message-chrome.ts'
import { useCalendarDay } from '../chat-utils/use-calendar-day.ts'
import css from './message-icon-actions.module.css'

export interface StepMessageIconActionsProps {
  /** Plain text the copy action writes. */
  text: string
  /** Unix epoch ms for the clock label; omitted for transient messages. */
  time?: number | undefined
  /** Clock before icons (user) or after (assistant). */
  clock: 'start' | 'end'
  /** Fork the session at this message; omission hides the branch action. */
  onBranch?: (() => void) | undefined
  /** The message is not a completed transcript tail, so branch stays visible but unavailable. */
  branchUnavailable?: boolean | undefined
  /** Parent layout class composed onto the actions row. */
  className?: string | undefined
  /**
   * Slot-rendered actions owned by independent plugins, placed between the
   * built-in copy and branch controls.
   */
  extraActions?: ReactNode
  /**
   * Icon-row Turn-usage trigger (the TurnUsagePanel pill), seated after the
   * branch control at the end of the icon cluster. B3 由 turn-tail 行供给只读
   * 静态药丸（明细浮层裁剪，见 TurnTailNodeView.tsx）。
   */
  usageAction?: ReactNode
  /** The owning view's locale seat, passed down as a plain prop. */
  t: TranslateNS<'sandore'>
}

/**
 * Copy / branch (/ clock) IconActions row shared by user and assistant chrome.
 * @param props - Copy text, event time, clock side, branch callback, className.
 * @returns The actions row element.
 */
export function MessageIconActions({
  text, time, clock, onBranch, branchUnavailable = false, className,
  extraActions, usageAction, t,
}: StepMessageIconActionsProps) {
  const day = useCalendarDay()
  const reasonId = useId()
  // Same success chrome as CodeBlock: a short check swap after the write,
  // gated so re-clicks during the window neither re-copy nor stack timers.
  const [copied, setCopied] = useState(false)
  const copyPending = useRef(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyEpoch = useRef(0)
  useEffect(() => () => {
    copyEpoch.current += 1
    copyPending.current = false
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
  }, [])
  const onCopy = useCallback(() => {
    if (copied || copyPending.current) return
    const epoch = copyEpoch.current
    copyPending.current = true
    void writeClipboard(text).then((ok) => {
      if (epoch !== copyEpoch.current) return
      copyPending.current = false
      if (!ok) return
      setCopied(true)
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null
        setCopied(false)
      }, 1000)
    })
  }, [copied, text])
  const clockEl = time === undefined ? null : (
    <span className={clock === 'start' ? css.timeStart : css.timeEnd}>
      {formatMessageClock(time, t, day)}
    </span>
  )
  return (
    <div className={className === undefined ? css.actions : `${css.actions} ${className}`}>
      {clock === 'start' ? clockEl : null}
      <Tooltip label={copied ? t('copied') : t('copy')} side="bottom">
        <button type="button" className={css.action} aria-label={copied ? t('copied') : t('copy')} onClick={onCopy}>
          {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
        </button>
      </Tooltip>
      {extraActions}
      {onBranch !== undefined && (
        <Tooltip label={branchUnavailable ? t('message.branchUnavailable') : t('message.branch')} side="bottom">
          {/* Native disabled buttons do not deliver the hover/focus events Tooltip needs. */}
          <button
            type="button"
            className={css.action}
            aria-label={t('message.branch')}
            aria-disabled={branchUnavailable || undefined}
            aria-describedby={branchUnavailable ? reasonId : undefined}
            data-unavailable={branchUnavailable || undefined}
            onClick={branchUnavailable ? undefined : onBranch}
          >
            <IconBranchOutline16 />
          </button>
        </Tooltip>
      )}
      {onBranch !== undefined && branchUnavailable && (
        <span id={reasonId} className={css.visuallyHidden}>{t('message.branchUnavailable')}</span>
      )}
      {usageAction}
      {clock === 'end' ? clockEl : null}
    </div>
  )
}
