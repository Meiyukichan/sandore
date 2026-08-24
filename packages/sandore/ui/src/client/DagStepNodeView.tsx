/**
 * sandore-step 讨论节点的 keyed 渲染器。
 *
 * 按状态渲染单个 Step 折叠节点：running 状态徽章 + 名称（无结果）；completed
 * 内联 step-completed 的 output 文本（MarkdownText）；failed 红框 + error；
 * paused 琥珀框 + 快照提示。显示 `name` 与循环迭代标签（`#1.2`）；点击名称
 * 经注入的 `openSession(childId)` 跳子会话；failed/completed 提供节点级重试
 * 控件（continue/revert/fork + 可选 message，提交经注入的 `retryStep`）。
 *
 * Round 9：标题右侧渲染收尾阶段 badge 序列（Phase A 已检测 / Phase B 已收尾 /
 * Phase C 已门禁 / Phase D 已判断 + 各中间态），badge 可点击进入对应阶段子代理会话。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/DagStepNodeView
 */
import { useEffect, useState } from 'react'
import {
  Button, Input, MarkdownText, Pill, StateDot,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { RevertBoundaryOption } from '@deepseek-ai/dsh-sandore-workflow/types'

import { describeError } from './describe-error.ts'
import type { SandoreKey } from './locales.ts'
import { RETRY_MODES, type RetryMode } from './run-view-model.ts'
import type { SandoreStepStatus, SandoreTextBlock } from './sandore-step-definition.ts'
import type { SandoreStepChatData } from './sandore-step-definition.ts'
import css from './DagStepNodeView.module.css'
import timelineCss from './timeline.module.css'

/** 由插件自身服务访问注入的导航与重试动作。 */
export interface SandoreStepInjected {
  readonly openSession: (id: SessionId) => void
  readonly retryStep: (input: { instanceId: string; stepId: string; mode: RetryMode; message: string; revertBoundary?: number }) => Promise<void>
  readonly listRevertBoundaries: (input: { instanceId: string; stepId: string }) => Promise<RevertBoundaryOption[]>
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
export function DagStepNodeView({ node, sessionId, openSession, retryStep, listRevertBoundaries, t }: DagStepNodeViewProps) {
  const data = node.data
  const [retryOpen, setRetryOpen] = useState(false)
  const [mode, setMode] = useState<RetryMode>('continue')
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const [retryError, setRetryError] = useState<string | undefined>(undefined)
  // revert 模式可选回退点：undefined = 默认（最后一个闭合 turn）；数字 = 所选闭合 turn/end seq。
  const [revertBoundary, setRevertBoundary] = useState<number | undefined>(undefined)
  const [boundaryOptions, setBoundaryOptions] = useState<RevertBoundaryOption[]>([])
  const [boundaryLoading, setBoundaryLoading] = useState(false)

  const canRetry = data.status === 'failed' || data.status === 'completed'
  // 仅真实子会话可点击跳转（synthetic 占位——shell 无真实子代理，childId 是合成
  // id，sessions.open 会 throw）；对齐 UnifiedTimeline 的 `synthetic !== true` 守卫语义。
  const navigable = data.childId !== undefined && data.synthetic !== true

  // revert 模式打开时拉取该 Step 子代理会话的闭合 turn 回退点候选，供回退点下拉选择。
  useEffect(() => {
    setRevertBoundary(undefined)
    if (!retryOpen || mode !== 'revert') {
      setBoundaryOptions([])
      setBoundaryLoading(false)
      return
    }
    let cancelled = false
    setBoundaryLoading(true)
    void listRevertBoundaries({ instanceId: sessionId, stepId: data.stepId })
      .then(options => {
        if (cancelled) return
        setBoundaryOptions(options)
        setBoundaryLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setBoundaryOptions([])
        setBoundaryLoading(false)
      })
    return () => { cancelled = true }
  }, [retryOpen, mode, sessionId, data.stepId, listRevertBoundaries])

  const submitRetry = async (): Promise<void> => {
    setPending(true)
    setRetryError(undefined)
    try {
      const boundary = mode === 'revert' ? revertBoundary : undefined
      await retryStep({ instanceId: sessionId, stepId: data.stepId, mode, message, ...(boundary === undefined ? {} : { revertBoundary: boundary }) })
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
        {navigable ? (
          <button
            type="button"
            className={css.name}
            aria-label={t('step.open', { name: data.name })}
            onClick={() => { openSession(data.childId) }}
          >
            {data.name}
          </button>
        ) : (
          <span className={css.nameStatic}>{data.name}</span>
        )}
        {data.loopLabel !== undefined && <span className={css.loopLabel}>{data.loopLabel}</span>}
        <span className={css.status}>{t(STATUS_KEYS[data.status])}</span>
      </header>

      {/* 内容区域——统一卡片样式 */}
      {data.status === 'completed' && data.output !== undefined && data.output.length > 0 && (
        <div className={timelineCss.md}><MarkdownText text={outputText(data.output)} /></div>
      )}
      {data.status === 'failed' && data.error !== undefined && (
        <div className={css.contentCardError} role="alert">{data.error}</div>
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
              {mode === 'revert' && (
                <div className={css.boundaryRow}>
                  <label className={css.boundaryLabel} htmlFor={`sandore-step-boundary-${data.stepId}`}>
                    {t('step.retry.boundary')}
                  </label>
                  {boundaryLoading ? (
                    <span className={css.boundaryHint}>{t('step.retry.boundary.loading')}</span>
                  ) : boundaryOptions.length === 0 ? (
                    <select
                      id={`sandore-step-boundary-${data.stepId}`}
                      className={css.boundarySelect}
                      value=""
                      disabled
                    >
                      <option value="">{t('step.retry.boundary.empty')}</option>
                    </select>
                  ) : (
                    <select
                      id={`sandore-step-boundary-${data.stepId}`}
                      className={css.boundarySelect}
                      value={revertBoundary === undefined ? 'default' : String(revertBoundary)}
                      onChange={event => {
                        const value = event.target.value
                        setRevertBoundary(value === 'default' ? undefined : Number(value))
                      }}
                    >
                      <option value="default">{t('step.retry.boundary.default')}</option>
                      {boundaryOptions.map(option => (
                        <option key={option.seq} value={String(option.seq)}>
                          {t('step.retry.boundary.turn', { n: option.turn + 1 })}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
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
