/**
 * DiscussionInput：执行详情底部输入区（**独立输入框** + composer 接管面板）。
 *
 * 呈现层统一（用户决策 1/2/4）——运行页底部输入框的**最终形态**是
 * `main-agent-input.tsx` 里的**独立实现**（视觉逐值照抄 DSH InputBar）：
 * - 正常态 = `[data-sandore-disc-input]` 内的独立输入框 + 暂停/中止动作组。
 *   它**不挂 DSH 输入内核、不接管任何 DOM 根、草稿是本地 state**（决策变更：上一版
 *   「复用 DSH 输入壳以共享草稿 + 接管编辑器根并归还」被用户否决，观感与行为都"诡异"），
 *   发送即把消息投递到**主代理会话**（该实例的宿主会话 `hostSessionId`）。
 * - **`@step` 结构化引用已全部退役**（决策 2）：运行页的 step 选择器
 *   （`data-sandore-step-picker`）、`@Step` 目标按钮、重试模式行、定点 `sendStepMessage`
 *   全部删除。用户用自然语言说「给 xx 步骤发消息」，由主代理按注入的上下文调用
 *   `sandore_workflow_send_message` 工具完成（工具在引擎侧）。面板内的 `@` 触发菜单链路
 *   （step-mention-source.ts / step-view/composer-trigger-menu.ts）保留为**未挂载的恢复
 *   入口**：`packages/client/index.ts` 已不再注册 mention source / 装配触发词控制器。
 * - **输入框区没有任何工作流动作按钮**（决策 4，三轮真机反馈的最终形态）：先并排渲染
 *   「暂停 + 中止」被否（「两个暂停按钮不要多此一举」），合成一个 DSH 同款「停止生成」后仍被否
 *   （「还是有个暂停按钮在输入框那里……去掉这个按钮」），故**全部删除**——输入框区只剩：
 *   左 = 权限下拉（无 `+`）、右 = 模型下拉 + 发送钮。
 *   暂停 / 中止的可用入口（能力不丢，见文件底部「需求 4」注释与 M-LAYER.md §5.8）：
 *   ① 暂停 = DSH 中心列输入框自带的「停止生成」（取消宿主主代理 turn → 引擎据此判 `paused`）；
 *   ② 中止实例 = 运行视图标题栏的 `[data-sandore-abort]`。
 * - 接管态（旧行为不变）：存在 pending 权限 → ApprovalPanel 风格卡片（琥珀条 + headline +
 *   command + 拒绝/始终允许/允许一次）；否则存在 pending 问答 → QuestionComposer 风格卡片
 *   （header + 编号选项 + 自定义行 + pager + 跳过/提交）。接管面板隐藏输入框。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/DiscussionInput
 */
import { useCallback, useMemo, useState, useSyncExternalStore, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react'
import {
  IconChevronDownOutline14, IconChevronLeftOutline14, IconChevronRightOutline14,
  IconChevronUpOutline14, IconCloseOutline16, IconEditOutline16, IconStopFill16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionFace, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PendingPermissionEntry, PendingQuestionEntry } from '@meiyukichan/dsh-sandore/schema'

import {
  stepIdOf,
  type AnswerItem, type DagRunStatus, type ExecutedStep,
} from './run-view-model.ts'
import { stepChatSessionsOf } from './StepChatPanel.tsx'
import { stepChatComposerBindingOf, stepChatComposerSendOf } from './step-view/composer-bar.ts'
import { MainAgentInput } from './main-agent-input.tsx'
import { ModelSelectSandore, PermissionSelectSandore } from './composer-selects.tsx'
import type { ModelDirectoryFace, ObservableFace, PermissionSelectValue } from './model-faces.ts'
import css from './input.module.css'

/** DiscussionInput 接收的 props（呈现层统一后：运行页输入框 = 独立输入框，向主代理发消息）。 */
export interface DiscussionInputProps {
  /** 类型化翻译函数。 */
  t: TranslateNS<'sandore'>
  /** 实例生命周期状态（决定暂停/中止动作的可用性）。 */
  status: DagRunStatus
  /** 已执行 Step 列表（接管面板的 step 名反查；需求 2 起不再作 @Step 选择用）。 */
  steps: readonly ExecutedStep[]
  /** 待答问题条目（接管 QuestionComposer）。 */
  questions: readonly PendingQuestionEntry[]
  /** 待批权限条目（接管 ApprovalPanel）。 */
  permissions: readonly PendingPermissionEntry[]
  /** 动作进行中（禁用交互）。 */
  pending: boolean
  /** 回复问答（整批回答）。 */
  onReplyQuestion(requestId: string, answers: AnswerItem[]): void
  /** 拒绝问答（标对应 Step failed，缺陷 26）。 */
  onRejectQuestion(requestId: string): void
  /** 回复权限（once/always/reject）。 */
  onReplyPermission(requestId: string, reply: 'once' | 'always' | 'reject'): void
  /**
   * 主代理（= 实例宿主会话）会话 id：本输入框把消息投递到该会话
   * （`stepChatComposerSendOf` 的 `conversation.send` / `session.prompt` 都按它寻址），
   * 也是「主代理卡片」要渲染的会话（需求 1/3）。**注意**：本输入框不挂 DSH 输入内核、
   * 不接触该会话的编辑器根（见 main-agent-input.tsx 文件头）。
   */
  hostSessionId: string
  /** 模型目录面（DSH `ctx.modelDirectories` 的 per-session 目录；座位在发送钮左侧）。 */
  modelDirectory: (sessionId: string) => ModelDirectoryFace
  /** 权限投影面（宿主会话 `projections.permissions`；座位在工具行左侧）。 */
  permissionFace: (sessionId: string) => ObservableFace<PermissionSelectValue | undefined>
  /** 执行一行会话命令（`/permission <id>`，DSH 官方命令通路）。 */
  runCommand: (sessionId: string, line: string) => Promise<boolean>
  /**
   * 引擎侧同步实例权限模式（`updateInstancePermissionMode`）：宿主 session + hostAgent 重新
   * 应用 sandbox/审批策略 + 实例快照持久化。终态实例会拒绝——调用方吞掉即可（DSH 命令已生效）。
   */
  setInstancePermission: (mode: string) => Promise<void>
  /** 权限投影缺失回退（`/permission` 无参查询）。 */
  queryPermission: (sessionId: string) => Promise<PermissionSelectValue | undefined>
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

/** QuestionCard 接收的 props（讨论页接管面板 / 主会话 composer 问答卡共用）。 */
export interface QuestionCardProps {
  readonly entry: PendingQuestionEntry
  readonly steps: readonly ExecutedStep[]
  readonly t: TranslateNS<'sandore'>
  readonly pending: boolean
  readonly onReply: (requestId: string, answers: AnswerItem[]) => void
  readonly onReject: (requestId: string) => void
  /** 实例标注（主会话 composer 多实例聚合时展示 `[workflowName]` 前缀；缺省不显示）。 */
  readonly workflowLabel?: string | undefined
}

export function QuestionCard({ entry, steps, t, pending, onReply, onReject, workflowLabel }: QuestionCardProps) {
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
              {workflowLabel !== undefined && <span className={css.qWorkflowTag}>{workflowLabel}</span>}
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
                  onClick={() => { onReject(entry.requestId) }}
                >
                  {t('run.question.reject')}
                </button>
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

// ── 运行页底部：独立输入框（向主代理发消息）。**输入框区不带任何工作流动作按钮** ──────
//
// 需求 1（**决策变更后的最终形态**）：运行视图底部是**独立实现**的输入框
// （`main-agent-input.tsx`，视觉细节逐值照抄 DSH InputBar）——**不挂 DSH 输入内核、不接管任何
// DOM 根、草稿是本地 state**。上一版「挂同一会话的 DSH 输入内核以共享草稿 + 接管编辑器根并在
// 卸载时归还」的做法已被用户否决（真机上观感与行为都"诡异"），相关机制（`takeRoot` /
// `owner="main"` / `setRootElement(prev)` 归还）已从 ComposerBar 中**删除**：它现在只保留
// step 面板输入壳的恢复入口语义（见 step-view/ComposerBar.tsx 文件头）。
// 发送语义不变：消息投递到**主代理会话**（该实例的宿主会话），走既有封装
// `stepChatComposerSendOf`（scope `conversation.send` 优先 → `session.prompt(content,'queue')`
// 兜底），失败显示错误行；Enter 发送 / Shift+Enter 换行 / IME 组合期不发送。
//
// 需求 2：`@step` 结构化引用**全部退役**——运行页的 step 选择器
// （`data-sandore-step-picker`）、`@Step` 目标按钮/重试模式行随之删除；用户直接用自然
// 语言说「给 xx 步骤发消息」，由主代理按注入的上下文调用 `sandore_workflow_send_message`
// 工具完成（工具在引擎侧，本文件不实现）。面板内的 `@` 触发菜单链路
// （step-mention-source.ts / step-view/composer-trigger-menu.ts）保留为「未挂载的恢复
// 入口」，且**不再被注册/挂载**（见 packages/client/index.ts 的装配注释与各文件头）。
//
// 需求 4（**三轮真机反馈后的最终形态：输入框区不放工作流动作按钮**）：
// 第一版并排渲染「暂停」+「中止」→ 用户说「模型下拉左边有两个暂停按钮，不要多此一举」；
// 第二版合成**一个** DSH 同款停止按钮（tooltip「暂停工作流实例，并中止主代理当前回复」）→
// 用户仍要求**去掉**：「还是有个暂停按钮在输入框那里……去掉这个按钮」。
// 故现在输入框区**只剩**：左 = 权限下拉（无 `+`），右 = 模型下拉 + 发送按钮；
// 暂停 / 停止 / 中止的可用入口改为（能力不丢，见 M-LAYER.md §5.8）：
// 1. **暂停**：DSH 中心列输入框自带的**「停止生成」**（取消宿主主代理当前 turn）——
//    引擎监听 `turn/end` 且 `reason.kind === 'aborted'`，据此把实例判为 `paused`
//    （`workflow-engine.ts` 的 host-turn-abort 分支，架构决策 6；真机断言见 m5 第一条用例）；
// 2. **中止实例**：运行视图**标题栏**的 `[data-sandore-abort]`（本文件不再渲染它）。
// 旧实现的 resumePrompt / retry message / @Step 定点发送（sendStepMessage）全部删除；
// step 级重试仍住在 step 面板底部的重试行动作位（见 StepChatPanel.tsx）。

/** sessions 服务未安装时的空订阅（useSyncExternalStore subscribe 侧）。 */
const NOOP_SUBSCRIBE = (): (() => void) => () => undefined

/**
 * 权限席位（DSH InputBar 左 `.tools` 里的 `PermissionSelect` 同款）：
 * 从宿主会话的 `projections.permissions` 读当前预设（与 DSH 中心列同一数据源），
 * 选择后经 `runCommand('/permission <id>')` 走 DSH 官方命令（权限/preset + sandbox/mode +
 * approval/policy 三个旋钮一起落），**并同时**经引擎 RPC 把实例权限模式同步过去
 * （`updateInstancePermissionMode`：宿主 session + hostAgent 重新应用 + 实例快照持久化）。
 */
function MainAgentAccessSeat({ t, hostSessionId, permissions, runCommand, setInstancePermission, queryPermission }: {
  readonly t: TranslateNS<'sandore'>
  readonly hostSessionId: string
  readonly permissions: (sessionId: string) => ObservableFace<PermissionSelectValue | undefined>
  readonly runCommand: (sessionId: string, line: string) => Promise<boolean>
  /** 引擎侧同步（失败不阻塞 UI：DSH 命令已生效，实例侧可能因终态而拒绝）。 */
  readonly setInstancePermission: (mode: string) => Promise<void>
  readonly queryPermission: (sessionId: string) => Promise<PermissionSelectValue | undefined>
}) {
  const face = useMemo(() => permissions(hostSessionId), [permissions, hostSessionId])
  const value = useSyncExternalStore(
    listener => face.subscribe(listener),
    () => face.getSnapshot(),
  )
  const command = useCallback(async (line: string): Promise<boolean> => {
    const mode = line.replace(/^\/permission\s+/, '').trim()
    const [accepted] = await Promise.all([
      runCommand(hostSessionId, line).catch(() => false),
      // 引擎侧：实例权限模式（宿主 session + hostAgent 重新应用；终态实例会拒，故吞掉）。
      mode === '' ? Promise.resolve(false) : setInstancePermission(mode).then(() => true, () => false),
    ])
    return accepted
  }, [hostSessionId, runCommand, setInstancePermission])
  const query = useCallback((): Promise<PermissionSelectValue | undefined> => queryPermission(hostSessionId), [hostSessionId, queryPermission])
  return (
    <span data-main-agent-access>
      <PermissionSelectSandore t={t} value={value} locked={false} runCommand={command} queryValue={query} />
    </span>
  )
}

/**
 * 模型席位（DSH InputBar 右 `.trailing` 里的模型触发同款，位于发送钮左侧）：
 * 复用 DSH `ctx.modelDirectories` 的 per-session 目录面 → 选择经 `session.selectModel`
 * 落到**主代理会话**的模型选择投影（引擎侧已 `installModelSelection`，下一次请求即生效）。
 */
function MainAgentModelSeat({ t, hostSessionId, modelDirectory }: {
  readonly t: TranslateNS<'sandore'>
  readonly hostSessionId: string
  readonly modelDirectory: (sessionId: string) => ModelDirectoryFace
}) {
  const directory = useMemo(() => modelDirectory(hostSessionId), [modelDirectory, hostSessionId])
  // 目录状态透出到 DOM（只读诊断：`routable === false` 时 DSH 同款行为是**隐藏**触发器，
  // 那样 e2e 只能看到「席位是空的」而拿不到原因；这两个属性让取证能区分
  // 「宿主没装 ui-model-selection」与「目录尚未加载完」）。
  const state = useSyncExternalStore(
    listener => directory.store.subscribe(listener),
    () => directory.store.getSnapshot(),
  )
  return (
    <span
      data-main-agent-model-trigger
      data-model-routable={String(state.routable)}
      data-model-status={state.status}
      {...state.error === null ? {} : { 'data-model-error': state.error }}
    >
      <ModelSelectSandore t={t} directory={directory} locked={false} />
    </span>
  )
}

/**
 * 输入框席位：解析宿主会话的**发送通道**并把独立输入框挂上（见文件头「需求 1」）。
 *
 * 只解析通道（`stepChatComposerSendOf`：scope conversation.send 优先 / session.prompt 兜底），
 * **不解析输入内核、不绑编辑器根**——这正是「独立输入框」与上一版的分野。宿主会话可能晚于
 * 运行视图出现，故订阅 `sessions.list` 以便会话出现后自动重解析通道。
 */
function MainAgentSeat({ t, hostSessionId, model, accessory }: {
  readonly t: TranslateNS<'sandore'>
  readonly hostSessionId: string
  /** 模型下拉席位（DSH 顺序：模型 → 发送）。 */
  readonly model: ReactNode
  /** 左席位（权限下拉；DSH `.tools` 位置）。 */
  readonly accessory: ReactNode
}) {
  const sessions = stepChatSessionsOf()
  useSyncExternalStore(
    sessions === undefined ? NOOP_SUBSCRIBE : sessions.list.subscribe,
    () => (sessions === undefined ? undefined : sessions.list.getSnapshot()),
  )
  const binding = stepChatComposerBindingOf(sessions?.binding(hostSessionId as SessionId))
  // 通道探测（装配期一次；binding 变化时重探）。通道缺失 → undefined ⇒ 输入框禁用 + 状态行。
  const send = useMemo(() => stepChatComposerSendOf(binding), [binding])
  return (
    <MainAgentInput
      t={t}
      send={send}
      placeholder={t('run.mainAgent.placeholder')}
      accessory={accessory}
      model={model}
    />
  )
}

/**
 * 渲染执行详情底部。
 *
 * 三种形态（互斥）：
 * 1. 有 pending 权限 → ApprovalPanel 风格接管卡（旧行为不变）；
 * 2. 有 pending 问答 → QuestionComposer 风格接管卡（旧行为不变）；
 * 3. 否则 → **独立输入框**（`main-agent-input.tsx`，需求 1 的最终形态）：
 *    左 = 权限下拉、右 = 模型下拉 + 发送按钮——**没有任何暂停/停止/中止按钮**
 *    （真机反馈第三轮；暂停入口见本文件需求 4 的注释与 M-LAYER.md §5.8）。
 *
 * 注：接管态（1/2）依旧整体替换输入区——那是 DSH 的 composer 接管语义（接管时隐藏
 * composer），本批不改。
 */
export function DiscussionInput({
  t, status, steps, questions, permissions, pending,
  onReplyQuestion, onRejectQuestion, onReplyPermission,
  hostSessionId, modelDirectory, permissionFace, runCommand, setInstancePermission, queryPermission,
}: DiscussionInputProps) {
  // 接管面板：有 pending 权限 → ApprovalPanel；否则有 pending 问答 → QuestionComposer；
  // 均无 → 独立输入框（原型：接管时隐藏 composer）。
  if (permissions.length > 0) {
    return <ApprovalCard entry={permissions[0]!} steps={steps} t={t} pending={pending} onReply={onReplyPermission} />
  }
  if (questions.length > 0) {
    return <QuestionCard entry={questions[0]!} steps={steps} t={t} pending={pending} onReply={onReplyQuestion} onReject={onRejectQuestion} />
  }
  return (
    // 真机反馈修正：输入框上方那行「主代理 / 消息发给主代理（不是发给某个 Step）」标签
    // **已删除**（用户明确不要）；语义由「主代理卡片」的卡头（头像 M + 标题「主代理」）承担。
    // 输入框区**不含任何工作流动作按钮**（暂停/停止/中止已全部移出，见文件头「需求 4」）。
    <div className={css.root} data-sandore-disc-input>
      <MainAgentSeat
        t={t}
        hostSessionId={hostSessionId}
        accessory={(
          <MainAgentAccessSeat
            t={t}
            hostSessionId={hostSessionId}
            permissions={permissionFace}
            runCommand={runCommand}
            setInstancePermission={setInstancePermission}
            queryPermission={queryPermission}
          />
        )}
        model={(
          <MainAgentModelSeat t={t} hostSessionId={hostSessionId} modelDirectory={modelDirectory} />
        )}
      />
    </div>
  )
}
