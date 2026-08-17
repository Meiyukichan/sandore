/**
 * DiscussionInput：执行态中栏底部输入区（状态驱动）。
 *
 * - running/interacting：textarea 禁用 + ⏸ 暂停按钮（pauseAll）。
 * - paused：可输入，发送 → 定点 `resumeStep`（@Step 目标）或广播 `resumeAll`（文本作 resumePrompt）。
 * - failed：可输入 + 重试三模式（continue/revert/fork），发送 → `retryStep`（@Step 目标缺省首个失败 Step）。
 * - 终态：禁用（无可用操作）。
 * @Step 选择器列出 paused/failed Step，不选 = 广播。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/DiscussionInput
 */
import { useMemo, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import { isBlank, stepIdOf, RETRY_MODES, type DagRunStatus, type ExecutedStep, type RetryMode } from './run-view-model.ts'
import css from './input.module.css'

/** DiscussionInput 接收的 props。 */
export interface DiscussionInputProps {
  /** 类型化翻译函数。 */
  t: TranslateNS<'sandore'>
  /** 实例生命周期状态。 */
  status: DagRunStatus
  /** 已执行 Step 列表（供 @Step 选择与失败默认目标）。 */
  steps: readonly ExecutedStep[]
  /** 动作进行中（禁用交互）。 */
  pending: boolean
  /** 暂停全部（running 态主操作）。 */
  onPauseAll(): void
  /** 广播恢复（文本作 resumePrompt）。 */
  onResumeAll(resumePrompt: string): void
  /** 定点恢复指定 Step。 */
  onResumeStep(stepId: string, resumePrompt: string): void
  /** 重试指定 Step（失败态）。 */
  onRetryStep(stepId: string, mode: RetryMode, message: string): void
}

/** 运行中/终态判定（决定输入区可用性）。 */
function isRunning(status: DagRunStatus): boolean {
  return status === 'running' || status === 'interacting'
}

function isTerminal(status: DagRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted'
}

/** 渲染状态驱动输入区。 */
export function DiscussionInput({ t, status, steps, pending, onPauseAll, onResumeAll, onResumeStep, onRetryStep }: DiscussionInputProps) {
  const [text, setText] = useState('')
  const [targetStepId, setTargetStepId] = useState<string | undefined>(undefined)
  const [retryMode, setRetryMode] = useState<RetryMode>('continue')
  const [pickerOpen, setPickerOpen] = useState(false)

  const running = isRunning(status)
  const failed = status === 'failed'
  const paused = status === 'paused'
  const terminal = isTerminal(status)

  // @Step 可选目标：paused / failed 的 Step（子代理可操作）。
  const targetSteps = useMemo(
    () => steps.filter(step => step.status === 'paused' || step.status === 'failed'),
    [steps],
  )
  const firstFailedStepId = steps.find(step => step.status === 'failed')
  const effectiveTarget = targetStepId ?? (failed && firstFailedStepId !== undefined ? stepIdOf(firstFailedStepId) : undefined)
  const targetName = targetStepId === undefined
    ? t('input.target.broadcast')
    : (steps.find(step => stepIdOf(step) === targetStepId)?.name ?? targetStepId)

  const placeholder = running
    ? t('input.placeholder.running')
    : paused
      ? t('input.placeholder.paused')
      : failed
        ? t('input.placeholder.failed')
        : ''

  const canSend = !terminal && !running && !isBlank(text)

  const send = (): void => {
    if (!canSend || pending) return
    if (failed) {
      if (effectiveTarget !== undefined) {
        onRetryStep(effectiveTarget, retryMode, text)
        setText('')
      }
      return
    }
    if (paused) {
      if (effectiveTarget !== undefined) {
        onResumeStep(effectiveTarget, text)
      } else {
        onResumeAll(text)
      }
      setText('')
    }
  }

  const disabled = terminal || running || pending

  return (
    <div className={css.root} data-sandore-disc-input>
      <div className={css.mentionBar}>
        <button
          type="button"
          className={css.targetBtn}
          onClick={() => { setPickerOpen(current => !current) }}
          disabled={disabled}
        >
          {targetStepId === undefined && !failed ? t('input.target.broadcast') : `@${targetName}`} ▾
        </button>
        <span className={css.mentionHint}>{t('input.resume.hint')}</span>
        {pickerOpen && targetSteps.length > 0 && (
          <div className={css.picker} data-sandore-step-picker>
            <button
              type="button"
              className={targetStepId === undefined ? css.pickerActive : ''}
              onClick={() => { setTargetStepId(undefined); setPickerOpen(false) }}
            >
              {t('input.target.broadcast')}
            </button>
            {targetSteps.map(step => {
              const id = stepIdOf(step)
              return (
                <button
                  key={id}
                  type="button"
                  className={targetStepId === id ? css.pickerActive : ''}
                  onClick={() => { setTargetStepId(id); setPickerOpen(false) }}
                >
                  @{step.name}
                </button>
              )
            })}
          </div>
        )}
      </div>

      <textarea
        className={css.textarea}
        value={text}
        onChange={event => { setText(event.target.value) }}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
      />

      {failed && (
        <div className={css.retryRow}>
          <span className={css.retryLabel}>{t('input.retry.label')}</span>
          {RETRY_MODES.map(mode => (
            <button
              key={mode}
              type="button"
              className={`${css.retryBtn} ${retryMode === mode ? css.retryBtnActive : ''}`}
              onClick={() => { setRetryMode(mode) }}
            >
              {mode === 'continue' ? t('run.retry.mode.continue') : mode === 'revert' ? t('run.retry.mode.revert') : t('run.retry.mode.fork')}
            </button>
          ))}
        </div>
      )}

      <div className={css.actions}>
        <span className={css.spacer} />
        {running ? (
          <button type="button" className={css.pauseBtn} title={t('input.pause')} aria-label={t('input.pause')} disabled={pending} onClick={onPauseAll}>
            ⏸
          </button>
        ) : (
          <button type="button" className={css.sendBtn} title={t('input.send')} aria-label={t('input.send')} disabled={!canSend || pending} onClick={send}>
            ➤
          </button>
        )}
      </div>
    </div>
  )
}
