/**
 * NoticeRow（B2b step-view 版）：model-retry / turn-error / turn-max-tokens /
 * unknown 四类「消息流边界通知行」，抄自 DSH 0.1.2-rc.1
 * `ui-chat/src/client/chat/MessageItem.tsx` 的 ModelRetryItem / TurnErrorItem /
 * TurnMaxTokensItem / UnknownNodeView + MessageItem.module.css 对应规则（只读参考
 * deepseek-harness）。
 *
 * - model-retry：一行折叠披露（scheduled 时状态文本走 shimmer 倒计时并显示
 *   `(retry/maximum) · Ns`），展开露出延迟与失败原因两格；
 * - turn-error：error 状态点 + 「本轮运行失败」标题 + 净化的失败消息
 *   （AUTH code 换本地文案）+ 可选 code 徽标；
 * - turn-max-tokens：warning 状态点 + 上限标题 + 截断提示；
 * - unknown：JsonBlock 回退行（label 带 surface type、payload 为原事件 data）。
 *
 * 适配：data 经 step-row-data 的 payloadOf 防御读取（live 未知叶子，不抛）；locale
 * 面为 sandore（message.* 键已抄进 sandore 字典，另补 message.failure.auth）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/NoticeRow
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { JsonBlock, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  StepChatTurnErrorPayload, StepModelRetryAttempt,
} from './step-row-data.ts'
import {
  stepChatModelRetryPayloadOf, stepChatTurnErrorPayloadOf,
  stepChatTurnMaxTokensPayloadOf, stepChatUnknownPayloadOf,
} from './step-row-data.ts'
import css from './notice-row.module.css'

function retrySeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1_000))
}

interface RetryCountdown {
  deadline: number
  seconds: number
}

function failureMessage(
  message: string,
  code: string | undefined,
  t: TranslateNS<'sandore'>,
): string {
  return code === 'AUTH' ? t('message.failure.auth') : message
}

function StepModelRetryItem({ attempt, active, t }: {
  /** 当前（最后一次）重试 attempt（本地断言面）。 */
  attempt: StepModelRetryAttempt
  /** scheduled 且所在边界仍开着：倒计时走字生效。 */
  active: boolean
  t: TranslateNS<'sandore'>
}) {
  // 把 host 调度的延迟锚到本浏览器对 retry 节点的首次渲染。host 事件时间与
  // Date.now() 可能分属不同时钟。
  const deadline = useMemo(() => Date.now() + attempt.delayMs, [attempt.delayMs, attempt.seq, attempt.retry])
  const scheduledSeconds = retrySeconds(attempt.delayMs)
  const maximum = attempt.mode === 'normal' ? attempt.maxRetries ?? 0 : '∞'
  const [countdown, setCountdown] = useState<RetryCountdown>(() => ({
    deadline,
    seconds: retrySeconds(deadline - Date.now()),
  }))
  const remainingSeconds = countdown.deadline === deadline
    ? countdown.seconds
    : retrySeconds(deadline - Date.now())

  useEffect(() => {
    if (!active) return
    const updateCountdown = (): number => {
      const next = retrySeconds(deadline - Date.now())
      setCountdown(current => (
        current.deadline === deadline && current.seconds === next
          ? current
          : { deadline, seconds: next }
      ))
      return next
    }
    if (updateCountdown() === 1) return
    const timer = window.setInterval(() => {
      if (updateCountdown() === 1) window.clearInterval(timer)
    }, 250)
    return () => { window.clearInterval(timer) }
  }, [active, deadline])

  const label = active
    ? t('message.retry.active')
    : attempt.retryState === 'cancelled'
      ? t('message.retry.cancelled')
      : attempt.retryState === 'started'
        ? t('message.retry.started')
        : t('message.retry.scheduled')
  const seconds = active ? remainingSeconds : scheduledSeconds

  return (
    <details className={css.retryRow} data-active={active || undefined}>
      <summary className={css.retrySummary}>
        <span className={css.retryText} role="status">
          {t('message.retry.status', { label, retry: attempt.retry, maximum, seconds })}
        </span>
      </summary>
      <div className={css.retryDetails}>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.delay')}</span>
          {t('duration.milliseconds', { milliseconds: Math.round(attempt.delayMs) })}
        </div>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.failure')}</span>
          {failureMessage(attempt.failure.message, attempt.failure.code, t)}
        </div>
      </div>
    </details>
  )
}

/** 常驻、turn 定位的终结失败反馈。 */
function StepTurnErrorItem({ node, t }: {
  node: StepChatTurnErrorPayload
  t: TranslateNS<'sandore'>
}) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="error" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.turnErrorTitle}>{t('message.turnError')}</span>
        <span className={css.turnErrorMessage}>{failureMessage(node.message, node.code, t)}</span>
      </div>
      {node.code !== undefined && <code className={css.turnErrorCode}>{node.code}</code>}
    </div>
  )
}

/** 常驻、turn 定位的输出 token 上限结束通知。 */
function StepTurnMaxTokensItem({ t }: {
  t: TranslateNS<'sandore'>
}) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="warning" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.maxTokensTitle}>{t('message.maxTokens')}</span>
        <span className={css.turnErrorMessage}>{t('message.maxTokens.hint')}</span>
      </div>
    </div>
  )
}

/** model-retry 行的 keyed 渲染器（B2b StepChatViewRow 分发目标）。 */
export const StepChatModelRetryView = memo(function StepChatModelRetryView({ data, t }: {
  data: unknown
  t: TranslateNS<'sandore'>
}) {
  const payload = stepChatModelRetryPayloadOf(data)
  return (
    <StepModelRetryItem
      attempt={payload.current}
      active={payload.current.retryState === 'scheduled'}
      t={t}
    />
  )
})

/** turn-error 行的 keyed 渲染器（B2b StepChatViewRow 分发目标）。 */
export const StepChatTurnErrorView = memo(function StepChatTurnErrorView({ data, t }: {
  data: unknown
  t: TranslateNS<'sandore'>
}) {
  const payload = stepChatTurnErrorPayloadOf(data)
  return <StepTurnErrorItem node={payload} t={t} />
})

/** turn-max-tokens 行的 keyed 渲染器（B2b StepChatViewRow 分发目标）。 */
export const StepChatTurnMaxTokensView = memo(function StepChatTurnMaxTokensView({ data, t }: {
  data: unknown
  t: TranslateNS<'sandore'>
}) {
  // rc.1：data 仅提供定位（turn/step/seq/time），行视觉只依赖文案——仍防御读取
  // 以对齐（B3 turn 轴可用）。
  stepChatTurnMaxTokensPayloadOf(data)
  return <StepTurnMaxTokensItem t={t} />
})

/** unknown 行的 keyed 渲染器（B2b StepChatViewRow 分发目标）。 */
export const StepChatUnknownView = memo(function StepChatUnknownView({ data, t }: {
  data: unknown
  t: TranslateNS<'sandore'>
}) {
  const payload = stepChatUnknownPayloadOf(data)
  return (
    <div className={css.contextRow}>
      <JsonBlock
        label={t('message.unknownSurface', { type: payload.type })}
        payload={payload.data}
        truncatedLabel={total => t('json.truncated', { total })}
      />
    </div>
  )
})
