/**
 * RunView：工作流实例执行详情（执行轨迹只读视图 + 产物面板 + 交互控件 + 打开讨论）。
 *
 * 经 `remote.getInstanceState(instanceId)` 拉取 `WorkflowTaskState`，按 `stageInfos`
 * 分组只读渲染 `executedSteps`（每 Step：7 态状态图标、名称、`visitCount` 徽章、
 * 错误信息）；产物面板经 `remote.getArtifacts(instanceId)` 分层显示（Stage → Step →
 * 文件/回答）。实例运行中（running/interacting）时每 5s 轮询状态与产物，终态或卸载
 * 停止；交互控件（实例级 pauseAll/resumeAll/abort，Step 级 pauseStep/resumeStep/
 * retryStep，问答 replyQuestion、权限 replyPermission）调用后立即手动刷新。头部
 * 「打开讨论」经 `openDiscussion` 回调跳宿主会话。以普通 props 提供（非 slot 子组件），
 * 供 WorkflowPanel 下钻承载。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/RunView
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button, DisclosureRow, IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14,
  IconPauseOutline16, IconPlayOutline16, IconRefreshOutline16, IconStopFill16,
  Input, Modal, Pill, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ArtifactEntry } from '@deepseek-ai/dsh-sandore-workflow/remote'
import type { PendingPermissionEntry, PendingQuestionEntry, WorkflowTaskState } from '@deepseek-ai/dsh-sandore-workflow/schema'

import { unwrap } from './remote.ts'
import { describeError } from './describe-error.ts'
import type { SandoreKey } from './locales.ts'
import {
  isBlank, isRunningStatus, isSubagentStep, isTerminalStatus, partitionInteractions, RETRY_MODES, runDotState,
  stepDotState, stepIdOf,
} from './run-view-model.ts'
import type { DagRunStatus, ExecutedStep, RetryMode, StageInfo, StepStatus } from './run-view-model.ts'
import css from './RunView.module.css'

/** 轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 5000

/** replyQuestion 单个问题的回答（对齐 Host 的 `AskUserQuestionAnswerItem`）。 */
interface AnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** RunView 所需的最小 `ctx.remote.sandore` 访问面。 */
export interface RunViewRemote {
  getInstanceState(instanceId: string): Promise<RemoteResult<unknown>>
  getArtifacts(instanceId: string, stageId?: string): Promise<RemoteResult<ArtifactEntry[]>>
  abortInstance(instanceId: string): Promise<RemoteResult<void>>
  pauseAll(input: { instanceId: string }): Promise<RemoteResult<void>>
  resumeAll(input: { instanceId: string; resumePrompt?: string }): Promise<RemoteResult<void>>
  pauseStep(input: { instanceId: string; stepId: string }): Promise<RemoteResult<void>>
  resumeStep(input: { instanceId: string; stepId: string; resumePrompt?: string }): Promise<RemoteResult<void>>
  retryStep(input: { instanceId: string; stepId: string; mode: RetryMode; message: string }): Promise<RemoteResult<void>>
  replyQuestion(input: { instanceId: string; requestId: string; answers: unknown }): Promise<RemoteResult<void>>
  replyPermission(input: { instanceId: string; requestId: string; reply: 'once' | 'always' | 'reject' }): Promise<RemoteResult<void>>
}

/** RunView 接收的普通业务 props（instanceId + 打开讨论回调 + remote 访问面 + locale）。 */
export interface RunViewProps {
  /** 类型化的翻译函数（sandore 命名空间）。 */
  t: TranslateNS<'sandore'>
  /** 目标工作流实例 id（宿主 Session id == instanceId）。 */
  instanceId: string
  /** 打开讨论回调：跳宿主会话 chat 视图（`ctx.sessions.open(instanceId)`）。 */
  openDiscussion: () => void
  /** `ctx.remote.sandore` 的最小 RPC 访问面（返回 `RemoteResult`，经 `unwrap` 解包）。 */
  remote: RunViewRemote
}

/** 数据加载状态（状态快照 + 产物，或加载中/错误）。 */
type RunLoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly state: WorkflowTaskState; readonly artifacts: readonly ArtifactEntry[] }

/** 交互动作的本地状态（禁用按钮 + 动作错误）。 */
type ActionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'error'; readonly message: string }

/** 重试表单本地状态。 */
type RetryState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'open'; readonly stepId: string; readonly mode: RetryMode; readonly message: string; readonly messageError: boolean }

/** 实例生命周期状态 → 本地化标签键。 */
const RUN_STATUS_KEYS: Record<DagRunStatus, SandoreKey> = {
  pending: 'run.status.pending',
  running: 'run.status.running',
  interacting: 'run.status.interacting',
  completed: 'run.status.completed',
  failed: 'run.status.failed',
  aborted: 'run.status.aborted',
  paused: 'run.status.paused',
}

/** Step 执行状态 → 本地化标签键。 */
const STEP_STATUS_KEYS: Record<StepStatus, SandoreKey> = {
  blocked: 'run.step.status.blocked',
  ready: 'run.step.status.ready',
  interacting: 'run.step.status.interacting',
  running: 'run.step.status.running',
  completed: 'run.step.status.completed',
  failed: 'run.step.status.failed',
  paused: 'run.step.status.paused',
}

/** 重试模式 → 本地化标签键。 */
const RETRY_MODE_KEYS: Record<RetryMode, SandoreKey> = {
  continue: 'run.retry.mode.continue',
  revert: 'run.retry.mode.revert',
  fork: 'run.retry.mode.fork',
}

/** 单个执行 Step 的只读行：状态图标 + 名称 + visitCount 徽章 + 状态文本 + 错误 + Step 级控件。 */
function StepRow({ step, t, pending, onPause, onResume, onRetry }: {
  readonly step: ExecutedStep
  readonly t: TranslateNS<'sandore'>
  readonly pending: boolean
  readonly onPause: (stepId: string) => void
  readonly onResume: (stepId: string) => void
  readonly onRetry: (stepId: string) => void
}) {
  const stepId = stepIdOf(step)
  // 仅子代理 Step（agent/skill/mcp）可暂停/恢复/重试；shell/prompt 合成 Step
  // 无真实子代理，引擎会拒绝这些操作，故不渲染其控件。
  const controllable = isSubagentStep(step)
  return (
    <div className={css.step}>
      <div className={css.stepHead}>
        <StateDot state={stepDotState(step.status)} />
        <span className={css.stepName}>{step.name}</span>
        <Pill className={css.visitBadge} aria-label={t('run.visitCount', { count: step.visitCount })}>
          {step.visitCount}
        </Pill>
        <span className={css.stepStatus}>{t(STEP_STATUS_KEYS[step.status])}</span>
        <span className={css.stepActions}>
          {controllable && (step.status === 'running' || step.status === 'interacting') && (
            <Button size="sm" variant="ghost" icon={<IconPauseOutline16 />} disabled={pending} aria-label={t('run.step.pause')} onClick={() => { onPause(stepId) }} />
          )}
          {controllable && step.status === 'paused' && (
            <Button size="sm" variant="ghost" icon={<IconPlayOutline16 />} disabled={pending} aria-label={t('run.step.resume')} onClick={() => { onResume(stepId) }} />
          )}
          {controllable && step.status === 'failed' && (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => { onRetry(stepId) }}>{t('run.step.retry')}</Button>
          )}
        </span>
      </div>
      {step.error !== undefined && (
        <div className={css.stepError}>{step.error}</div>
      )}
    </div>
  )
}

/** Stage 分组：DisclosureRow 折叠（名称 + Step 数）+ 展开 Step 只读列表。 */
function StageGroup({ stage, steps, expanded, onToggle, t, pending, onPause, onResume, onRetry }: {
  readonly stage: StageInfo
  readonly steps: readonly ExecutedStep[]
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly t: TranslateNS<'sandore'>
  readonly pending: boolean
  readonly onPause: (stepId: string) => void
  readonly onResume: (stepId: string) => void
  readonly onRetry: (stepId: string) => void
}) {
  return (
    <DisclosureRow
      icon={<IconChevronRightOutline14 />}
      title={stage.name}
      open={expanded}
      expandable
      onToggle={onToggle}
      expandOnRowClick
      rowClassName={css.stageHeader}
      collapsedContent={<span className={css.stepCount}>{steps.length}</span>}
    >
      <div className={css.steps}>
        {steps.length === 0 ? (
          <span className={css.empty}>{t('run.trajectory.empty')}</span>
        ) : (
          steps.map(step => (
            <StepRow key={step.id} step={step} t={t} pending={pending} onPause={onPause} onResume={onResume} onRetry={onRetry} />
          ))
        )}
      </div>
    </DisclosureRow>
  )
}

/** 单个待答问题条目：渲染各问题的选项（单选/多选）或自由文本输入，提交经 onReply。 */
function QuestionCard({ entry, t, pending, onReply }: {
  readonly entry: PendingQuestionEntry
  readonly t: TranslateNS<'sandore'>
  readonly pending: boolean
  readonly onReply: (requestId: string, answers: AnswerItem[]) => void
}) {
  const questions = entry.payload.questions
  const [selections, setSelections] = useState<Readonly<Record<string, readonly string[]>>>({})
  const [customs, setCustoms] = useState<Readonly<Record<string, string>>>({})

  const answered = questions.every(question => {
    if (question.options !== undefined && question.options.length > 0) {
      return (selections[question.id] ?? []).length > 0
    }
    return !isBlank(customs[question.id] ?? '')
  })

  const toggleOption = (questionId: string, label: string, multi: boolean): void => {
    setSelections(current => {
      const selected = current[questionId] ?? []
      const next = multi
        ? (selected.includes(label) ? selected.filter(item => item !== label) : [...selected, label])
        : [label]
      return { ...current, [questionId]: next }
    })
  }

  const submit = (): void => {
    const answers = questions.map(question => {
      if (question.options !== undefined && question.options.length > 0) {
        return { id: question.id, selected: [...(selections[question.id] ?? [])] }
      }
      const custom = customs[question.id] ?? ''
      return { id: question.id, selected: [], ...(custom === '' ? {} : { custom }) }
    })
    onReply(entry.requestId, answers)
  }

  return (
    <div className={css.card}>
      {questions.map(question => (
        <div key={question.id} className={css.question}>
          {question.header !== undefined && <span className={css.questionHeader}>{question.header}</span>}
          <span className={css.questionText}>{question.question}</span>
          {question.options !== undefined && question.options.length > 0 ? (
            <div className={css.options} role="group">
              {question.options.map(option => {
                const checked = (selections[question.id] ?? []).includes(option.label)
                return (
                  <label key={option.label} className={css.option}>
                    <input
                      type={question.multi_select === true ? 'checkbox' : 'radio'}
                      name={question.id}
                      checked={checked}
                      onChange={() => { toggleOption(question.id, option.label, question.multi_select === true) }}
                    />
                    <span className={css.optionLabel}>{option.label}</span>
                    {option.description !== undefined && <span className={css.optionDesc}>{option.description}</span>}
                  </label>
                )
              })}
            </div>
          ) : (
            <Input
              value={customs[question.id] ?? ''}
              onChange={event => { setCustoms(current => ({ ...current, [question.id]: event.target.value })) }}
              placeholder={t('run.question.placeholder')}
            />
          )}
        </div>
      ))}
      <Button size="sm" variant="primary" disabled={!answered || pending} onClick={submit}>
        {t('run.question.submit')}
      </Button>
    </div>
  )
}

/** 单个待批权限条目：展示权限/工具/路径模式，应答经 onReply（once/always/reject）。 */
function PermissionCard({ entry, t, pending, onReply }: {
  readonly entry: PendingPermissionEntry
  readonly t: TranslateNS<'sandore'>
  readonly pending: boolean
  readonly onReply: (requestId: string, reply: 'once' | 'always' | 'reject') => void
}) {
  return (
    <div className={css.card}>
      <div className={css.cardHead}>
        <IconCheckOutline16 />
        <span className={css.cardTitle}>{entry.payload.permission}</span>
      </div>
      {entry.payload.tool !== undefined && (
        <div className={css.metaRow}>
          <span className={css.metaLabel}>{t('run.permission.tool')}</span>
          <span>{entry.payload.tool}</span>
        </div>
      )}
      {entry.payload.patterns !== undefined && entry.payload.patterns.length > 0 && (
        <div className={css.metaRow}>
          <span className={css.metaLabel}>{t('run.permission.patterns')}</span>
          <span>{entry.payload.patterns.join(', ')}</span>
        </div>
      )}
      <div className={css.permissionActions}>
        <Button size="sm" variant="primary" disabled={pending} onClick={() => { onReply(entry.requestId, 'once') }}>
          {t('run.permission.once')}
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => { onReply(entry.requestId, 'always') }}>
          {t('run.permission.always')}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => { onReply(entry.requestId, 'reject') }}>
          {t('run.permission.reject')}
        </Button>
      </div>
    </div>
  )
}

/** 产物面板：按 Stage → Step → 文件/回答 分层只读显示。 */
function ArtifactPanel({ artifacts, stages, t }: {
  readonly artifacts: readonly ArtifactEntry[]
  readonly stages: readonly StageInfo[]
  readonly t: TranslateNS<'sandore'>
}) {
  if (artifacts.length === 0) {
    return <p className={css.empty}>{t('run.artifacts.empty')}</p>
  }

  const byStage = new Map<string, ArtifactEntry[]>()
  for (const entry of artifacts) {
    const list = byStage.get(entry.stageId)
    if (list === undefined) {
      byStage.set(entry.stageId, [entry])
    } else {
      list.push(entry)
    }
  }

  return (
    <div className={css.artifacts}>
      {[...byStage.entries()].map(([stageId, entries]) => (
        <div key={stageId} className={css.artifactStage}>
          <div className={css.artifactStageName}>{stages.find(stage => stage.id === stageId)?.name ?? stageId}</div>
          {entries.map(entry => (
            <div key={`${entry.stepId}-${entry.outputToId ?? ''}`} className={css.artifactStep}>
              <div className={css.artifactStepName}>{entry.stepId}</div>
              {entry.files.length > 0 && (
                <div className={css.artifactBlock}>
                  <span className={css.metaLabel}>{t('run.artifacts.files')}</span>
                  <ul className={css.fileList}>
                    {entry.files.map(file => (
                      <li key={file} className={css.file}>{file}</li>
                    ))}
                  </ul>
                </div>
              )}
              {entry.returnPrompt !== undefined && (
                <div className={css.artifactBlock}>
                  <span className={css.metaLabel}>{t('run.artifacts.returnPrompt')}</span>
                  <p className={css.returnText}>{entry.returnPrompt}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/** 重试表单对话框：模式选择（continue/revert/fork）+ 说明输入 + 提交。 */
function RetryModal({ t, mode, message, messageError, pending, onClose, onChangeMode, onChangeMessage, onSubmit }: {
  readonly t: TranslateNS<'sandore'>
  readonly mode: RetryMode
  readonly message: string
  readonly messageError: boolean
  readonly pending: boolean
  readonly onClose: () => void
  readonly onChangeMode: (mode: RetryMode) => void
  readonly onChangeMessage: (message: string) => void
  readonly onSubmit: () => void
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title={t('run.retry.title')}
      closeLabel={t('run.retry.cancel')}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('run.retry.cancel')}</Button>
          <Button variant="primary" size="sm" disabled={pending} onClick={onSubmit}>{t('run.retry.submit')}</Button>
        </>
      )}
    >
      <div className={css.retryForm}>
        <div className={css.retryModes} role="group" aria-label={t('run.retry.mode')}>
          {RETRY_MODES.map(candidate => (
            <Pill key={candidate} active={candidate === mode} onClick={() => { onChangeMode(candidate) }}>
              {t(RETRY_MODE_KEYS[candidate])}
            </Pill>
          ))}
        </div>
        <Input value={message} onChange={event => { onChangeMessage(event.target.value) }} placeholder={t('run.retry.message')} />
        {messageError && <p className={css.error} role="alert">{t('run.retry.message.required')}</p>}
      </div>
    </Modal>
  )
}

/** RunView 就绪态主体：轨迹 + 待处理交互 + 产物。 */
function RunBody({ state, artifacts, t, pending, onPause, onResume, onRetry, onReplyQuestion, onReplyPermission }: {
  readonly state: WorkflowTaskState
  readonly artifacts: readonly ArtifactEntry[]
  readonly t: TranslateNS<'sandore'>
  readonly pending: boolean
  readonly onPause: (stepId: string) => void
  readonly onResume: (stepId: string) => void
  readonly onRetry: (stepId: string) => void
  readonly onReplyQuestion: (requestId: string, answers: AnswerItem[]) => void
  readonly onReplyPermission: (requestId: string, reply: 'once' | 'always' | 'reject') => void
}) {
  const [collapsedStageIds, setCollapsedStageIds] = useState<ReadonlySet<string>>(() => new Set())
  const { questions, permissions } = partitionInteractions(state.pendingInteractions)

  const toggleStage = (stageId: string): void => {
    setCollapsedStageIds(current => {
      const next = new Set(current)
      if (next.has(stageId)) {
        next.delete(stageId)
      } else {
        next.add(stageId)
      }
      return next
    })
  }

  return (
    <div className={css.body}>
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('run.trajectory.title')}</h3>
        <div className={css.trajectory}>
          {state.stageInfos.map((stage, index) => {
            const steps = state.executedSteps.filter(step => step.stageId === stage.id)
            return (
              <div key={stage.id} className={css.stageWrap}>
                <StageGroup
                  stage={stage}
                  steps={steps}
                  expanded={!collapsedStageIds.has(stage.id)}
                  onToggle={() => { toggleStage(stage.id) }}
                  t={t}
                  pending={pending}
                  onPause={onPause}
                  onResume={onResume}
                  onRetry={onRetry}
                />
                {index < state.stageInfos.length - 1 && (
                  <div className={css.connector} aria-hidden><IconChevronDownOutline14 /></div>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {(questions.length > 0 || permissions.length > 0) && (
        <section className={css.section}>
          <h3 className={css.sectionTitle}>{t('run.interactions.title')}</h3>
          <div className={css.cards}>
            {questions.map(entry => (
              <QuestionCard key={entry.id} entry={entry} t={t} pending={pending} onReply={onReplyQuestion} />
            ))}
            {permissions.map(entry => (
              <PermissionCard key={entry.id} entry={entry} t={t} pending={pending} onReply={onReplyPermission} />
            ))}
          </div>
        </section>
      )}

      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('run.artifacts.title')}</h3>
        <ArtifactPanel artifacts={artifacts} stages={state.stageInfos} t={t} />
      </section>
    </div>
  )
}

/** 渲染 RunView。 */
export function RunView({ t, instanceId, openDiscussion, remote }: RunViewProps) {
  const [loadState, setLoadState] = useState<RunLoadState>({ kind: 'loading' })
  const [actionState, setActionState] = useState<ActionState>({ kind: 'idle' })
  const [retryState, setRetryState] = useState<RetryState>({ kind: 'closed' })

  const refresh = useCallback(async (): Promise<DagRunStatus | undefined> => {
    try {
      const [stateResult, artifactsResult] = await Promise.all([
        remote.getInstanceState(instanceId),
        remote.getArtifacts(instanceId),
      ])
      // RunViewRemote 最小接口把 getInstanceState 标为 unknown，Host 实际返回 WorkflowTaskState。
      const state = unwrap(stateResult) as WorkflowTaskState
      const artifacts = unwrap(artifactsResult)
      setLoadState({ kind: 'ready', state, artifacts })
      return state.status
    } catch (error) {
      setLoadState({ kind: 'error', message: describeError(error) })
      return undefined
    }
  }, [instanceId, remote])

  // 轮询定时器与卸载标记（提升为 ref，使动作后也能复用调度链）。
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const disposedRef = useRef(false)

  // 拉取一次并按状态调度下一次轮询：运行中（running/interacting）且无活跃 timer
  // 时启动 5s tick 链；终态、加载失败或已卸载则停止。
  const refreshAndSchedule = useCallback(async (): Promise<void> => {
    const status = await refresh()
    if (disposedRef.current || status === undefined || !isRunningStatus(status)) return
    if (timerRef.current === undefined) {
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined
        void refreshAndSchedule()
      }, POLL_INTERVAL_MS)
    }
  }, [refresh])

  // 首拉 + 运行中 5s 轮询；卸载清理 timer 并阻止迟到 tick 继续调度。
  useEffect(() => {
    disposedRef.current = false
    setLoadState({ kind: 'loading' })
    void refreshAndSchedule()
    return () => {
      disposedRef.current = true
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current)
        timerRef.current = undefined
      }
    }
  }, [refreshAndSchedule])

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    setActionState({ kind: 'pending' })
    try {
      await action()
    } catch (error) {
      setActionState({ kind: 'error', message: describeError(error) })
      return
    }
    setActionState({ kind: 'idle' })
    // 动作后立即刷新，并在状态回到 running/interacting（如 paused→resume）时重启轮询链。
    await refreshAndSchedule()
  }

  const pauseAll = (): void => { void runAction(async () => { unwrap(await remote.pauseAll({ instanceId })) }) }
  const resumeAll = (): void => { void runAction(async () => { unwrap(await remote.resumeAll({ instanceId })) }) }
  const abort = (): void => { void runAction(async () => { unwrap(await remote.abortInstance(instanceId)) }) }
  const pauseStep = (stepId: string): void => { void runAction(async () => { unwrap(await remote.pauseStep({ instanceId, stepId })) }) }
  const resumeStep = (stepId: string): void => { void runAction(async () => { unwrap(await remote.resumeStep({ instanceId, stepId })) }) }
  const replyQuestion = (requestId: string, answers: AnswerItem[]): void => {
    void runAction(async () => { unwrap(await remote.replyQuestion({ instanceId, requestId, answers: { answers } })) })
  }
  const replyPermission = (requestId: string, reply: 'once' | 'always' | 'reject'): void => {
    void runAction(async () => { unwrap(await remote.replyPermission({ instanceId, requestId, reply })) })
  }
  const beginRetry = (stepId: string): void => { setRetryState({ kind: 'open', stepId, mode: 'revert', message: '', messageError: false }) }
  const submitRetry = (): void => {
    if (retryState.kind !== 'open') return
    if (isBlank(retryState.message)) {
      setRetryState({ ...retryState, messageError: true })
      return
    }
    const { stepId, mode, message } = retryState
    void runAction(async () => { unwrap(await remote.retryStep({ instanceId, stepId, mode, message })) })
    setRetryState({ kind: 'closed' })
  }

  return (
    <section className={css.runView} aria-label={t('run.title')} data-sandore-run-view>
      <header className={css.header}>
        <span className={css.title}>{t('run.title')}</span>
        {loadState.kind === 'ready' && (
          <span className={css.statusBadge}>
            <StateDot state={runDotState(loadState.state.status)} />
            <span>{t(RUN_STATUS_KEYS[loadState.state.status])}</span>
          </span>
        )}
        <span className={css.spacer} />
        {loadState.kind === 'ready' && isRunningStatus(loadState.state.status) && (
          <Button size="sm" variant="ghost" disabled={actionState.kind === 'pending'} onClick={pauseAll}>{t('run.pauseAll')}</Button>
        )}
        {loadState.kind === 'ready' && loadState.state.status === 'paused' && (
          <Button size="sm" variant="ghost" disabled={actionState.kind === 'pending'} onClick={resumeAll}>{t('run.resumeAll')}</Button>
        )}
        {loadState.kind === 'ready' && !isTerminalStatus(loadState.state.status) && (
          <Button size="sm" variant="ghost" icon={<IconStopFill16 />} disabled={actionState.kind === 'pending'} onClick={abort} aria-label={t('run.abort')} />
        )}
        <Button size="sm" variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { void refreshAndSchedule() }} aria-label={t('run.refresh')} />
        <Button size="sm" variant="outline" onClick={openDiscussion}>{t('run.discuss')}</Button>
      </header>

      {loadState.kind === 'loading' && <p className={css.loading}>{t('run.loading')}</p>}
      {loadState.kind === 'error' && <p className={css.error} role="alert">{t('run.error', { message: loadState.message })}</p>}
      {actionState.kind === 'error' && <p className={css.error} role="alert">{actionState.message}</p>}

      {loadState.kind === 'ready' && (
        <RunBody
          state={loadState.state}
          artifacts={loadState.artifacts}
          t={t}
          pending={actionState.kind === 'pending'}
          onPause={pauseStep}
          onResume={resumeStep}
          onRetry={beginRetry}
          onReplyQuestion={replyQuestion}
          onReplyPermission={replyPermission}
        />
      )}

      {retryState.kind === 'open' && (
        <RetryModal
          t={t}
          mode={retryState.mode}
          message={retryState.message}
          messageError={retryState.messageError}
          pending={actionState.kind === 'pending'}
          onClose={() => { setRetryState({ kind: 'closed' }) }}
          onChangeMode={mode => { setRetryState(current => (current.kind === 'open' ? { ...current, mode } : current)) }}
          onChangeMessage={message => { setRetryState(current => (current.kind === 'open' ? { ...current, message, messageError: false } : current)) }}
          onSubmit={submitRetry}
        />
      )}
    </section>
  )
}
