/**
 * StepRetryRow（批 B2；需求 1 起 message 走固定默认串）：step 内嵌会话面板底部的
 * 「重试」行。
 *
 * 位置与职责：面板在 `item.status === 'failed'` 且是真实子代理 step 时（可见性判定
 * 见 step-retry.ts 的 `stepRetryVisible`），在面板底部动作位（`data-step-chat-retry-seat`；
 * 占位态则在 `data-step-chat-retry-placeholder`）渲染本行——模式三选
 * （继续 / 回退 / 分叉）+ revert 模式的回退点下拉 + 「重试」按钮 + 失败错误行。
 * 行本身不持有数据通道：调用面由上层装配的 `StepChatRetryPort` 提供（RunView 的
 * `remote.retryStep` / `remote.listRevertBoundaries` 薄封装，**零新 RPC**）。
 *
 * 为什么 message 是固定的默认串（需求 1）：重试行的 `message` 原本取面板输入框的
 * **当前草稿**；需求 1 把面板内嵌输入框整个移除后草稿不复存在（面板不再有任何输入
 * 面），故 message 统一走本地化默认串 `run.step.chat.retry.defaultMessage`
 * （wire 上 `message` 必填，不能为空串）——调用方不再传草稿，
 * `stepRetryRequestOf` 收到空草稿即返回该默认串。
 *
 * 提交语义（引擎面只读参考 `recovery-manager.ts` / `wire.ts`）：
 * - `message`：固定默认串（见上；`stepRetryMessageOf` 的空草稿分支）；
 * - `mode`：所选三模式之一；`revertBoundary` **仅 revert 模式**携带（'default' =
 *   不携带，引擎按最后一个闭合 turn 回退）；
 * - 失败：错误行展示**引擎原文**（F1 的「子代理会话已销毁…不能重试」原样可见），
 *   并对该族补一句本地化引导（`run.step.chat.retry.disposed`）；
 * - 成功：随后的段刷新/new childId 由 RunView 既有轮询完成，UnifiedTimeline 的
 *   `key`（childId）换值即重挂面板（面板不再有需要清空的草稿）。
 *
 * 降级文案：回退点拉取中 → 「加载回退点…」；拉到空（该会话无闭合 turn）→ 下拉禁用
 * 显示「无可用回退点」+ 一句轻量提示（建议改用继续/分叉）；拉取失败 → 错误原文
 * （`run.step.chat.retry.boundariesFailed`）。提交按钮在飞行中禁用并显示「重试中…」。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/StepRetryRow
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import {
  STEP_RETRY_BOUNDARY_DEFAULT,
  STEP_RETRY_MODES,
  stepRetryBoundaryHintOf,
  stepRetryBoundaryOf,
  stepRetryBoundaryOptionsOf,
  stepRetryBoundarySelectValue,
  stepRetryErrorKind,
  stepRetryErrorText,
  stepRetryModeLabelKey,
  stepRetryRequestOf,
  stepRetryRevertUnavailable,
  type StepChatRetryPort,
  type StepRetryBoundariesState,
  type StepRetryMode,
} from './step-retry.ts'
import css from './composer-bar.module.css'

/** StepRetryRow 的 props（端口 + 本地化）。 */
export interface StepRetryRowProps {
  /** 重试端口（目标段片段 + retryStep/listRevertBoundaries 调用面）。 */
  readonly port: StepChatRetryPort
  readonly t: TranslateNS<'sandore'>
}

/** 失败态（文案 + 是否 F1「子代理会话已销毁」族，后者附一句引导）。 */
interface RetryFailure {
  readonly text: string
  readonly disposed: boolean
}

/**
 * 重试行：模式选择 + 回退点下拉 + 重试按钮 + 错误行。
 * @param props - 见 StepRetryRowProps。
 * @returns 重试行的元素树。
 */
export function StepRetryRow({ port, t }: StepRetryRowProps) {
  const [mode, setMode] = useState<StepRetryMode>('continue')
  // revert 模式所选闭合 turn/end seq；undefined = 默认（引擎取最后一个闭合 turn）。
  const [boundary, setBoundary] = useState<number | undefined>(undefined)
  const [boundaries, setBoundaries] = useState<StepRetryBoundariesState>({ kind: 'idle' })
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<RetryFailure | null>(null)
  // 提交原子闸（同帧连点不重复投递；state 更新前的同步守卫）。
  const submittingRef = useRef(false)

  const stepId = port.target.stepId
  const { listBoundaries, retry } = port
  const retryFailedText = t('run.step.chat.retry.failed')

  // revert 模式才拉取回退点（与 DiscussionInput 同语义：continue/fork 不拉、不显示
  // 下拉）。作废守卫：切换模式/换 step 后丢弃在飞结果，绝不把旧 step 的候选落到新
  // step 的下拉里；模式切走时把所选边界与候选一起清空，避免下次进 revert 命中陈旧值。
  useEffect(() => {
    setBoundary(undefined)
    if (mode !== 'revert') {
      setBoundaries({ kind: 'idle' })
      return undefined
    }
    let cancelled = false
    setBoundaries({ kind: 'loading' })
    void listBoundaries(stepId)
      .then((options) => {
        if (cancelled) return
        setBoundaries({ kind: 'ready', options: stepRetryBoundaryOptionsOf(options) })
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setBoundaries({ kind: 'error', message: stepRetryErrorText(reason, retryFailedText) })
      })
    return () => { cancelled = true }
  }, [mode, stepId, listBoundaries, retryFailedText])

  // 重试：装配入参（固定默认 message / revert 边界）→ 端口；失败落错误行（引擎原文）。
  // 空草稿 = 面板无输入面（需求 1 移除内嵌输入框）→ `stepRetryMessageOf` 返回
  // `run.step.chat.retry.defaultMessage` 这条固定 message（见文件头注释）。
  const submit = useCallback((): void => {
    if (submittingRef.current) return
    submittingRef.current = true
    setFailure(null)
    setSubmitting(true)
    const request = stepRetryRequestOf(
      port.target,
      mode,
      '',
      { defaultMessage: t('run.step.chat.retry.defaultMessage') },
      boundary,
    )
    void retry(request)
      .catch((reason: unknown) => {
        setFailure({
          text: stepRetryErrorText(reason, retryFailedText),
          disposed: stepRetryErrorKind(reason) === 'disposed',
        })
      })
      .finally(() => {
        submittingRef.current = false
        setSubmitting(false)
      })
  }, [boundary, mode, port.target, retry, retryFailedText, t])

  const hint = stepRetryBoundaryHintOf(boundaries)
  const options = boundaries.kind === 'ready' ? boundaries.options : []
  // revert 模式的轻量提示：候选拉到但为空（该子代理会话没有闭合 turn/end）——
  // 提交仍放行（引擎可能仍有默认边界或自行报错），只提示这不是正常可回退态。
  const revertUnavailable = stepRetryRevertUnavailable(boundaries, mode)
  const boundaryDisabled = submitting || boundaries.kind === 'loading'

  return (
    <div className={css.retryBlock} data-step-chat-retry-row data-step-chat-retry-step={stepId}>
      <div className={css.retryRow}>
        <span className={css.retryLabel}>{t('run.retry.mode')}</span>
        {STEP_RETRY_MODES.map(option => (
          <button
            key={option}
            type="button"
            className={option === mode ? `${css.retryBtn} ${css.retryBtnActive}` : css.retryBtn}
            aria-pressed={option === mode}
            disabled={submitting}
            data-step-chat-retry-mode={option}
            onClick={() => { setMode(option) }}
          >
            {t(stepRetryModeLabelKey(option))}
          </button>
        ))}
        {mode === 'revert' && (
          <label className={css.boundaryPicker}>
            <span className={css.retryLabel}>{t('run.retry.boundary')}</span>
            {boundaries.kind === 'loading' ? (
              <span className={css.boundaryHint} data-step-chat-retry-boundary-loading>
                {t('run.retry.boundary.loading')}
              </span>
            ) : options.length === 0 ? (
              // 空候选（无闭合 turn）或拉取失败：下拉禁用并显示空态文案，
              // 具体原因由下方提示行给出（失败带宿主错误原文）。
              <select
                className={css.boundarySelect}
                value=""
                disabled
                aria-label={t('run.retry.boundary')}
                data-step-chat-retry-boundary
              >
                <option value="">{t('run.retry.boundary.empty')}</option>
              </select>
            ) : (
              <select
                className={css.boundarySelect}
                value={stepRetryBoundarySelectValue(boundary)}
                disabled={boundaryDisabled}
                aria-label={t('run.retry.boundary')}
                data-step-chat-retry-boundary
                onChange={(event) => { setBoundary(stepRetryBoundaryOf(event.target.value)) }}
              >
                <option value={STEP_RETRY_BOUNDARY_DEFAULT}>{t('run.retry.boundary.default')}</option>
                {options.map(option => (
                  <option key={option.seq} value={String(option.seq)}>
                    {t('run.retry.boundary.turn', { n: option.turn + 1 })}
                  </option>
                ))}
              </select>
            )}
          </label>
        )}
        <button
          type="button"
          className={css.retrySubmit}
          disabled={submitting}
          data-step-chat-retry-submit
          onClick={submit}
        >
          {submitting ? t('run.step.chat.retry.running') : t('run.step.chat.retry.submit')}
        </button>
      </div>
      {hint !== undefined && hint.kind === 'error' && (
        <div className={css.retryHint} role="status" data-step-chat-retry-boundary-error>
          {t(hint.key, { message: hint.message })}
        </div>
      )}
      {revertUnavailable && (
        <div className={css.retryHint} role="status" data-step-chat-retry-revert-unavailable>
          {t('run.step.chat.retry.revertUnavailable')}
        </div>
      )}
      {failure !== null && (
        // 错误行复用 composer 状态行样式（同族胶囊），另挂专属锚点便于 e2e 定位。
        <div className={css.statusError} role="alert" data-step-chat-retry-error>
          {failure.text}
        </div>
      )}
      {failure?.disposed === true && (
        <div className={css.retryHint} role="status" data-step-chat-retry-disposed>
          {t('run.step.chat.retry.disposed')}
        </div>
      )}
    </div>
  )
}
