/**
 * DiscussionInput：执行详情底部输入区（DSH composer 风格 + composer 接管面板）。
 *
 * 按 `docs/design/execution-detail-prototype.html` 原型实现：
 * - 正常态：DSH InputBar 风格 composer（22px 圆角卡片 + 透明 textarea + 底部工具行：
 *   左权限胶囊 / 右模型胶囊 + 圆形发送按钮）。状态语义保留：
 *   running → textarea 禁用 + ⏸ 暂停（trailing 主按钮）+ 中止 ghost；
 *   paused → 发送 = 定点 `resumeStep`（@Step）或广播 `resumeAll`；
 *   failed → 发送 = `retryStep`（continue/revert/fork）；终态 → 禁用。
 *   @Step 目标选择与重试模式行做成 composer 上方仅在 paused/failed 出现的细工具条。
 * - 接管态：存在 pending 权限 → ApprovalPanel 风格卡片（琥珀条 + headline + command
 *   + 拒绝/始终允许/允许一次）；否则存在 pending 问答 → QuestionComposer 风格卡片
 *   （header + 编号选项 + 自定义行 + pager + 跳过/提交）。接管面板隐藏 composer。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/DiscussionInput
 */
import { useMemo, useState, useSyncExternalStore, type ChangeEvent, type KeyboardEvent } from 'react'
import {
  IconChevronDownOutline14, IconChevronLeftOutline14, IconChevronRightOutline14,
  IconChevronUpOutline14, IconCloseOutline16, IconEditOutline16, IconStopFill16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PendingPermissionEntry, PendingQuestionEntry } from '@deepseek-ai/dsh-sandore-workflow/schema'

import {
  isBlank, stepIdOf, RETRY_MODES,
  type AnswerItem, type DagRunStatus, type ExecutedStep, type RetryMode,
} from './run-view-model.ts'
import { ModelSelectSandore, PermissionSelectSandore } from './composer-selects.tsx'
import type { ModelDirectoryFace, ObservableFace, PermissionSelectValue } from './model-faces.ts'
import css from './input.module.css'

/** DiscussionInput 接收的 props。 */
export interface DiscussionInputProps {
  /** 类型化翻译函数。 */
  t: TranslateNS<'sandore'>
  /** 实例生命周期状态。 */
  status: DagRunStatus
  /** 已执行 Step 列表（供 @Step 选择、失败默认目标与接管面板 step 名反查）。 */
  steps: readonly ExecutedStep[]
  /** 待答问题条目（接管 QuestionComposer）。 */
  questions: readonly PendingQuestionEntry[]
  /** 待批权限条目（接管 ApprovalPanel）。 */
  permissions: readonly PendingPermissionEntry[]
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
  /** 回复问答（整批回答）。 */
  onReplyQuestion(requestId: string, answers: AnswerItem[]): void
  /** 回复权限（once/always/reject）。 */
  onReplyPermission(requestId: string, reply: 'once' | 'always' | 'reject'): void
  /** 中止实例（running/paused 态 trailing 的 ghost 按钮）。 */
  onAbort?(): void
  /** 目标工作流实例 id（宿主 Session id；模型目录/权限/命令都绑定它）。 */
  instanceId: string
  /** 复用 DSH `ctx.modelDirectories` 的每会话模型目录。 */
  modelDirectory(sessionId: string): ModelDirectoryFace
  /** 当前实例会话的权限投影（`projections.permissions`）。 */
  sessionPermissions: ObservableFace<PermissionSelectValue | undefined>
  /** 对实例会话执行命令（`/permission <id>`）。 */
  runCommand(sessionId: string, line: string): Promise<boolean>
  /** 权限投影缺失回退：查询当前权限预设与可用列表。 */
  queryPermission(): Promise<PermissionSelectValue | undefined>
}

/** 运行中/终态判定（决定输入区可用性）。 */
function isRunning(status: DagRunStatus): boolean {
  return status === 'running' || status === 'interacting'
}

function isTerminal(status: DagRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted'
}

/** 反查 Step 名（接管面板 headline/eyebrow 用）。 */
function stepNameOf(steps: readonly ExecutedStep[], stepId: string): string {
  const step = steps.find(item => stepIdOf(item) === stepId)
  return step?.name ?? stepId
}

/** 拆分约定推荐后缀（照 DSH QuestionComposer.parseRecommendedLabel）。 */
function parseRecommendedLabel(label: string): { label: string; recommended: boolean } {
  const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i
  return suffix.test(label)
    ? { label: label.replace(suffix, ''), recommended: true }
    : { label, recommended: false }
}

// ── composer 接管：权限申请（ApprovalPanel 风格） ────────────────────────────

function ApprovalCard({ entry, steps, t, pending, onReply }: {
  readonly entry: PendingPermissionEntry
  readonly steps: readonly ExecutedStep[]
  readonly t: TranslateNS<'sandore'>
  readonly pending: boolean
  readonly onReply: (requestId: string, reply: 'once' | 'always' | 'reject') => void
}) {
  const stepName = stepNameOf(steps, entry.stepId)
  const permission = entry.payload.permission
  const patterns = entry.payload.patterns ?? []
  const tool = entry.payload.tool
  const command = tool !== undefined
    ? `${tool}${patterns.length > 0 ? `(${patterns.join(', ')})` : ''}`
    : patterns.length > 0
      ? patterns.join(', ')
      : permission
  return (
    <div className={css.takeover} data-sandore-takeover="approval">
      <div className={css.approvalCard}>
        <div className={css.approvalStrip}>
          <span className={css.approvalDot} aria-hidden />
          {t('run.approval.waiting')}
        </div>
        <div className={css.approvalBody}>
          <div className={css.approvalHeadline}>
            {t('run.approval.headline', { step: stepName, permission })}
          </div>
          <div className={css.approvalCommand}>{command}</div>
        </div>
        <div className={css.approvalActions}>
          <button
            type="button"
            className={`${css.approvalBtn} ${css.approvalReject}`}
            disabled={pending}
            onClick={() => { onReply(entry.requestId, 'reject') }}
          >
            {t('run.permission.reject')}
          </button>
          <button
            type="button"
            className={`${css.approvalBtn} ${css.approvalGhost}`}
            disabled={pending}
            onClick={() => { onReply(entry.requestId, 'always') }}
          >
            {t('run.permission.always')}
          </button>
          <button
            type="button"
            className={`${css.approvalBtn} ${css.approvalAllow}`}
            disabled={pending}
            onClick={() => { onReply(entry.requestId, 'once') }}
          >
            {t('run.permission.once')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── composer 接管：问题选择（QuestionComposer 风格） ─────────────────────────

interface DraftAnswer {
  selected: string[]
  custom: string
  skipped: boolean
}

function QuestionCard({ entry, steps, t, pending, onReply }: {
  readonly entry: PendingQuestionEntry
  readonly steps: readonly ExecutedStep[]
  readonly t: TranslateNS<'sandore'>
  readonly pending: boolean
  readonly onReply: (requestId: string, answers: AnswerItem[]) => void
}) {
  const questions = entry.payload.questions
  const stepName = stepNameOf(steps, entry.stepId)
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<DraftAnswer[]>(() => questions.map(() => ({
    selected: [], custom: '', skipped: false,
  })))
  const [minimized, setMinimized] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const question = questions[index]!
  const draft = drafts[index]!
  const hasOptions = (question.options?.length ?? 0) > 0
  const multi = question.multi_select === true

  const updateDraft = (update: (current: DraftAnswer) => DraftAnswer): void => {
    setDrafts(current => current.map((item, itemIndex) => itemIndex === index ? update(item) : item))
    setError(null)
  }

  const choose = (label: string): void => {
    updateDraft(current => {
      if (multi) {
        const selected = current.selected.includes(label)
          ? current.selected.filter(item => item !== label)
          : [...current.selected, label]
        return { ...current, selected, skipped: false }
      }
      return { selected: [label], custom: '', skipped: false }
    })
    if (!multi && index < questions.length - 1) {
      setIndex(current => current + 1)
    }
  }

  const answered = (item: DraftAnswer): boolean => item.selected.length > 0 || item.custom.trim() !== ''
  const completed = (item: DraftAnswer): boolean => answered(item) || item.skipped

  const submitAll = (values: DraftAnswer[]): void => {
    const missing = values.findIndex(item => !completed(item))
    if (missing >= 0) {
      setIndex(missing)
      setError(t('run.question.incomplete'))
      return
    }
    const answers: AnswerItem[] = questions.map((item, itemIndex) => {
      const value = values[itemIndex]!
      if (value.skipped) return { id: item.id, selected: [] }
      const custom = value.custom.trim()
      return {
        id: item.id,
        selected: custom === '' || item.multi_select === true ? value.selected : [],
        ...(custom === '' ? {} : { custom }),
      }
    })
    onReply(entry.requestId, answers)
  }

  const continueFlow = (): void => {
    if (!answered(draft)) {
      setError(t('run.question.unanswered'))
      return
    }
    if (index < questions.length - 1) {
      setIndex(current => current + 1)
      setError(null)
      return
    }
    submitAll(drafts)
  }

  const skipQuestion = (): void => {
    const next = drafts.map((item, itemIndex) => itemIndex === index
      ? { selected: [], custom: '', skipped: true }
      : item)
    setDrafts(next)
    setError(null)
    if (index < questions.length - 1) {
      setIndex(current => current + 1)
      return
    }
    submitAll(next)
  }

  // 取消 = 整批跳过（放弃问题集，解锁引擎等待）。
  const cancelFlow = (): void => {
    const next = drafts.map(item => ({ selected: [], custom: '', skipped: true }))
    setDrafts(next)
    submitAll(next)
  }

  const draftCustom = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    updateDraft(current => ({
      ...current,
      selected: multi ? current.selected : [],
      custom: event.target.value,
      skipped: false,
    }))
  }

  const continueFromCustom = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    continueFlow()
  }

  return (
    <div className={css.takeover} data-sandore-takeover="question">
      <section className={css.questionCard}>
        <header className={css.qHeader}>
          <div className={css.qHeadingBlock}>
            <div className={css.qEyebrow}>
              {question.header ?? t('run.question.eyebrow', { step: stepName })}
            </div>
            <h2 className={css.qTitle}>{question.question}</h2>
          </div>
          <div className={css.qHeaderActions}>
            <button
              type="button"
              className={css.qIconBtn}
              title={minimized ? t('run.question.maximize') : t('run.question.minimize')}
              disabled={pending}
              onClick={() => { setMinimized(current => !current) }}
            >
              {minimized ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
            </button>
            <button
              type="button"
              className={css.qIconBtn}
              title={t('run.question.cancel')}
              disabled={pending}
              onClick={cancelFlow}
            >
              <IconCloseOutline16 size={14} />
            </button>
          </div>
        </header>

        {!minimized && (
          <>
            <div className={css.qBody}>
              <div className={css.qOptions}>
                {(question.options ?? []).map((option, optionIndex) => {
                  const selected = draft.selected.includes(option.label)
                  const display = parseRecommendedLabel(option.label)
                  return (
                    <button
                      type="button"
                      key={`${option.label}-${String(optionIndex)}`}
                      className={`${css.qOption} ${selected && !multi ? css.qOptionSelected : ''}`}
                      role={multi ? 'checkbox' : 'radio'}
                      aria-checked={selected}
                      disabled={pending}
                      onClick={() => { choose(option.label) }}
                    >
                      {multi
                        ? (
                          <span className={`${css.qCheckbox} ${selected ? css.qCheckboxChecked : ''}`} aria-hidden>
                            {selected ? '✓' : ''}
                          </span>
                        )
                        : <span className={css.qNumber}>{optionIndex + 1}</span>}
                      <span className={css.qOptionCopy}>
                        <span className={css.qOptionLine}>
                          <span className={css.qOptionLabel}>{display.label}</span>
                          {display.recommended && <span className={css.qBadge}>{t('run.question.recommended')}</span>}
                          {option.description !== undefined && <span className={css.qDesc}>{option.description}</span>}
                        </span>
                      </span>
                    </button>
                  )
                })}

                {hasOptions ? (
                  <div className={`${css.qCustom} ${draft.custom !== '' ? css.qCustomActive : ''}`}>
                    <span className={css.qNumber} aria-hidden><IconEditOutline16 size={12} /></span>
                    <input
                      type="text"
                      value={draft.custom}
                      disabled={pending}
                      placeholder={t('run.question.customPlaceholder')}
                      onChange={draftCustom}
                      onKeyDown={continueFromCustom}
                    />
                  </div>
                ) : (
                  <textarea
                    rows={2}
                    className={css.qTextarea}
                    value={draft.custom}
                    disabled={pending}
                    placeholder={t('run.question.customPlaceholder')}
                    onChange={draftCustom}
                    onKeyDown={continueFromCustom}
                  />
                )}
              </div>
            </div>

            <footer className={css.qFooter}>
              <div className={css.qPager}>
                <button
                  type="button"
                  className={css.qIconBtn}
                  aria-label="‹"
                  disabled={index === 0 || pending}
                  onClick={() => { setIndex(current => current - 1); setError(null) }}
                >
                  <IconChevronLeftOutline14 />
                </button>
                <span className={css.qProgress}>{index + 1} / {questions.length}</span>
                <button
                  type="button"
                  className={css.qIconBtn}
                  aria-label="›"
                  disabled={index === questions.length - 1 || pending}
                  onClick={() => { setIndex(current => current + 1); setError(null) }}
                >
                  <IconChevronRightOutline14 />
                </button>
              </div>
              {error !== null && <div className={css.qFeedback} role="status">{error}</div>}
              <div className={css.qFooterActions}>
                <button
                  type="button"
                  className={`${css.qBtn} ${css.qSkip}`}
                  disabled={pending}
                  onClick={skipQuestion}
                >
                  {t('run.question.skip')}
                </button>
                <button
                  type="button"
                  className={`${css.qBtn} ${css.qSend}`}
                  disabled={pending || !answered(draft)}
                  onClick={continueFlow}
                >
                  {index === questions.length - 1 ? t('run.question.submit') : t('run.question.next')}
                </button>
              </div>
            </footer>
          </>
        )}
      </section>
    </div>
  )
}

// ── 正常 composer（DSH InputBar 风格） ──────────────────────────────────────

/** 发送箭头 glyph（照 DSH InputBar 主按钮）。 */
function SendGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
    </svg>
  )
}

/** 暂停 glyph（照 DSH 主按钮 stop 方块）。 */
function PauseGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden>
      <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
    </svg>
  )
}

function Composer({ t, status, steps, pending, onPauseAll, onResumeAll, onResumeStep, onRetryStep, onAbort, instanceId, modelDirectory, sessionPermissions, runCommand, queryPermission }: {
  readonly t: TranslateNS<'sandore'>
  readonly status: DagRunStatus
  readonly steps: readonly ExecutedStep[]
  readonly pending: boolean
  readonly onPauseAll: () => void
  readonly onResumeAll: (resumePrompt: string) => void
  readonly onResumeStep: (stepId: string, resumePrompt: string) => void
  readonly onRetryStep: (stepId: string, mode: RetryMode, message: string) => void
  readonly onAbort: (() => void) | undefined
  readonly instanceId: string
  readonly modelDirectory: (sessionId: string) => ModelDirectoryFace
  readonly sessionPermissions: ObservableFace<PermissionSelectValue | undefined>
  readonly runCommand: (sessionId: string, line: string) => Promise<boolean>
  readonly queryPermission: () => Promise<PermissionSelectValue | undefined>
}) {
  const [text, setText] = useState('')
  const [targetStepId, setTargetStepId] = useState<string | undefined>(undefined)
  const [retryMode, setRetryMode] = useState<RetryMode>('continue')
  const [pickerOpen, setPickerOpen] = useState(false)

  // 模型目录 / 权限投影：绑定当前实例会话（复用 DSH 数据与 RPC，行为与主 session 一致）。
  const directory = useMemo(() => modelDirectory(instanceId), [modelDirectory, instanceId])
  const permissionValue = useSyncExternalStore(
    fn => sessionPermissions.subscribe(fn),
    () => sessionPermissions.getSnapshot(),
  )

  const running = isRunning(status)
  const failed = status === 'failed'
  const paused = status === 'paused'
  const terminal = isTerminal(status)
  const showAbort = onAbort !== undefined && (running || paused)

  // @Step 可选目标：paused / failed 的 Step（子代理可操作）。
  const targetSteps = steps.filter(step => step.status === 'paused' || step.status === 'failed')
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
      {(paused || failed) && (
        <div className={css.toolbar}>
          <button
            type="button"
            className={css.targetBtn}
            onClick={() => { setPickerOpen(current => !current) }}
            disabled={disabled}
          >
            {targetStepId === undefined && !failed ? t('input.target.broadcast') : `@${targetName}`}
            <IconChevronDownOutline14 />
          </button>
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
        </div>
      )}

      <div className={css.composerCard}>
        <div className={css.composerScroll}>
          <textarea
            className={css.composerInput}
            value={text}
            onChange={event => { setText(event.target.value) }}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
          />
        </div>
        <div className={css.composerRow}>
          <div className={css.composerTools}>
            {/* 权限选择：复用 DSH 会话权限投影 + `/permission` 命令（与主 session 一致）。
                模型/权限是会话级设置，与工作流运行状态无关，仅动作进行中禁用。 */}
            <PermissionSelectSandore
              t={t}
              value={permissionValue}
              locked={pending}
              runCommand={(line) => runCommand(instanceId, line)}
              queryValue={queryPermission}
            />
          </div>
          <div className={css.composerTrailing}>
            {/* 模型选择：复用 DSH 每会话模型目录（与主 session 一致）。 */}
            <ModelSelectSandore t={t} directory={directory} locked={pending} />
            {showAbort && (
              <button
                type="button"
                className={css.abortBtn}
                title={t('run.abort')}
                aria-label={t('run.abort')}
                disabled={pending}
                onClick={onAbort}
              >
                <IconStopFill16 />
              </button>
            )}
            <button
              type="button"
              className={css.sendBtn}
              title={running ? t('input.pause') : `${t('input.send')} · ⌘↵`}
              aria-label={running ? t('input.pause') : t('input.send')}
              disabled={running ? pending : (!canSend || pending)}
              onClick={running ? onPauseAll : send}
            >
              {running ? <PauseGlyph /> : <SendGlyph />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 渲染执行详情底部（composer 或接管面板）。 */
export function DiscussionInput({ t, status, steps, questions, permissions, pending, onPauseAll, onResumeAll, onResumeStep, onRetryStep, onReplyQuestion, onReplyPermission, onAbort, instanceId, modelDirectory, sessionPermissions, runCommand, queryPermission }: DiscussionInputProps) {
  // 接管面板：有 pending 权限 → ApprovalPanel；否则有 pending 问答 → QuestionComposer；
  // 均无 → 正常 composer（原型：接管时隐藏 composer）。
  if (permissions.length > 0) {
    return <ApprovalCard entry={permissions[0]!} steps={steps} t={t} pending={pending} onReply={onReplyPermission} />
  }
  if (questions.length > 0) {
    return <QuestionCard entry={questions[0]!} steps={steps} t={t} pending={pending} onReply={onReplyQuestion} />
  }
  return (
    <Composer
      t={t}
      status={status}
      steps={steps}
      pending={pending}
      onPauseAll={onPauseAll}
      onResumeAll={onResumeAll}
      onResumeStep={onResumeStep}
      onRetryStep={onRetryStep}
      onAbort={onAbort}
      instanceId={instanceId}
      modelDirectory={modelDirectory}
      sessionPermissions={sessionPermissions}
      runCommand={runCommand}
      queryPermission={queryPermission}
    />
  )
}
