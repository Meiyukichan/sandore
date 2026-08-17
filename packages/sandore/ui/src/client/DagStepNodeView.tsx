/**
 * sandore-step 讨论节点的 keyed 渲染器。
 *
 * 按状态渲染单个 Step 折叠节点：running 状态徽章 + 名称（无结果）；completed
 * 内联 step-completed 的 output 文本（MarkdownText）；failed 红框 + error；
 * paused 琥珀框 + 快照提示。显示 `name` 与循环迭代标签（`#1.2`）；点击名称
 * 经注入的 `openSession(childId)` 跳子会话；failed/completed 提供节点级重试
 * 控件（continue/revert/fork + 可选 message，提交经注入的 `retryStep`）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/DagStepNodeView
 */
import { useState } from 'react'
import {
  Button, Input, MarkdownText, Pill, StateDot,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

import { describeError } from './describe-error.ts'
import type { SandoreKey } from './locales.ts'
import { RETRY_MODES, type RetryMode } from './run-view-model.ts'
import type { SandoreStepStatus, SandoreTextBlock } from './sandore-step-definition.ts'
import css from './DagStepNodeView.module.css'

/** 由插件自身服务访问注入的导航与重试动作。 */
export interface SandoreStepInjected {
  readonly openSession: (id: SessionId) => void
  readonly retryStep: (input: { instanceId: string; stepId: string; mode: RetryMode; message: string }) => Promise<void>
}

/** keyed Chat 渲染器完整 props。 */
export type DagStepNodeViewProps =
  PropsRuntime<'conversation.chat.node', 'sandore-step'>
  & PropsLocale<'sandore'>
  & SandoreStepInjected

/** 状态 → 本地化标签键。 */
const STATUS_KEYS: Record<SandoreStepStatus, SandoreKey> = {
  running: 'step.status.running',
  completed: 'step.status.completed',
  failed: 'step.status.failed',
  paused: 'step.status.paused',
}

/** 重试模式 → 本地化标签键。 */
const RETRY_MODE_KEYS: Record<RetryMode, SandoreKey> = {
  continue: 'step.retry.mode.continue',
  revert: 'step.retry.mode.revert',
  fork: 'step.retry.mode.fork',
}

/** 四态 → StateDotState 四态穷尽映射。 */
function dotState(status: SandoreStepStatus): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'completed': return 'done'
    case 'failed': return 'error'
    case 'paused': return 'warning'
    /* v8 ignore next -- SandoreStepStatus is closed and every variant is handled above. */
    default: return status satisfies never
  }
}

/** 拼接 output 文本块为单个 Markdown 源（空数组/缺省返回空串）。 */
function outputText(output: readonly SandoreTextBlock[] | undefined): string {
  return output === undefined ? '' : output.map(block => block.text).join('\n')
}

/** 渲染单个 sandore Step 节点。 */
export function DagStepNodeView({ node, sessionId, openSession, retryStep, t }: DagStepNodeViewProps) {
  const data = node.data
  const [retryOpen, setRetryOpen] = useState(false)
  const [mode, setMode] = useState<RetryMode>('continue')
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const [retryError, setRetryError] = useState<string | undefined>(undefined)

  const canRetry = data.status === 'failed' || data.status === 'completed'

  const submitRetry = async (): Promise<void> => {
    setPending(true)
    setRetryError(undefined)
    try {
      await retryStep({ instanceId: sessionId, stepId: data.stepId, mode, message })
      setRetryOpen(false)
    } catch (error) {
      setRetryError(describeError(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <section className={css.root} data-sandore-step data-step-status={data.status}>
      <header className={css.header} data-step-status={data.status}>
        <StateDot state={dotState(data.status)} />
        <button
          type="button"
          className={css.name}
          aria-label={t('step.open', { name: data.name })}
          onClick={() => { openSession(data.childId) }}
        >
          {data.name}
        </button>
        {data.loopLabel !== undefined && <span className={css.loopLabel}>{data.loopLabel}</span>}
        <span className={css.status}>{t(STATUS_KEYS[data.status])}</span>
      </header>

      {data.status === 'completed' && data.output !== undefined && data.output.length > 0 && (
        <div className={css.output}><MarkdownText text={outputText(data.output)} /></div>
      )}
      {data.status === 'failed' && data.error !== undefined && (
        <div className={css.error} role="alert">{data.error}</div>
      )}
      {data.status === 'paused' && (
        <div className={css.paused}>{t('step.paused.hint')}</div>
      )}

      {canRetry && (
        <div className={css.actions}>
          {retryOpen ? (
            <div className={css.retryForm}>
              <div className={css.retryModes} role="group" aria-label={t('step.retry.mode')}>
                {RETRY_MODES.map(candidate => (
                  <Pill key={candidate} active={candidate === mode} onClick={() => { setMode(candidate) }}>
                    {t(RETRY_MODE_KEYS[candidate])}
                  </Pill>
                ))}
              </div>
              <Input
                value={message}
                onChange={event => { setMessage(event.target.value) }}
                placeholder={t('step.retry.message')}
              />
              {retryError !== undefined && (
                <p className={css.retryError} role="alert">{t('step.retry.failed', { message: retryError })}</p>
              )}
              <div className={css.retryActions}>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setRetryOpen(false) }}>
                  {t('step.retry.cancel')}
                </Button>
                <Button size="sm" variant="primary" disabled={pending} onClick={() => { void submitRetry() }}>
                  {t('step.retry.submit')}
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => { setRetryOpen(true) }}>{t('step.retry')}</Button>
          )}
        </div>
      )}
    </section>
  )
}
