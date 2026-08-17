/**
 * RunView：执行态三栏视图（树形导航 + 统一时间线/输入区 + 文件预览）。
 *
 * 数据源 = `getInstanceState` 轮询（运行中 5s，终态停）+ `getArtifacts` 初始化；
 * 树与时间线由纯函数从状态派生。交互：header（暂停全部/恢复全部/中止/刷新/打开讨论）、
 * 树叶子 → 右栏预览、输入区状态驱动（running 暂停 / paused 恢复 / failed 重试）、
 * 待处理问答/权限卡片在时间线下方。Step「查看详情」/树行 ↗ 跳子代理会话。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/RunView
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  Button, IconRefreshOutline16, IconStopFill16, Input, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ArtifactEntry } from '@deepseek-ai/dsh-sandore-workflow/remote'
import type { PendingPermissionEntry, PendingQuestionEntry, WorkflowTaskState } from '@deepseek-ai/dsh-sandore-workflow/schema'

import { unwrap } from './remote.ts'
import { describeError } from './describe-error.ts'
import type { SandoreKey } from './locales.ts'
import {
  buildTimeline, buildRunTree, isBlank, isRunningStatus, isTerminalStatus, partitionInteractions,
  runDotState, type DagRunStatus, type ExecutedStep, type RetryMode,
} from './run-view-model.ts'
import { TreeNav, type TreeLeafSelection } from './TreeNav.tsx'
import { UnifiedTimeline } from './UnifiedTimeline.tsx'
import { DiscussionInput } from './DiscussionInput.tsx'
import { PreviewPanel } from './PreviewPanel.tsx'
import { DragHandle } from './DragHandle.tsx'
import {
  getWorkflowState, resizePreviewWidth, resizeTreeWidth, setWorkflowState, subscribeWorkflowState,
} from './workflow-store.ts'
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

/** RunView 接收的普通业务 props（instanceId + 跳会话回调 + remote 访问面 + locale）。 */
export interface RunViewProps {
  /** 类型化的翻译函数（sandore 命名空间）。 */
  t: TranslateNS<'sandore'>
  /** 目标工作流实例 id（宿主 Session id == instanceId）。 */
  instanceId: string
  /** 跳会话回调（Step 详情/树行 → 子代理会话；打开讨论 → 宿主会话）。 */
  openSession(id: string): void
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
        <span className={css.cardTitle}>{t('run.permission.title')}</span>
      </div>
      <div className={css.metaRow}>
        <span className={css.metaLabel}>{t('run.permission.patterns')}</span>
        <span>{entry.payload.permission}</span>
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

/** 渲染 RunView（三栏）。 */
export function RunView({ t, instanceId, openSession, remote }: RunViewProps) {
  const [loadState, setLoadState] = useState<RunLoadState>({ kind: 'loading' })
  const [actionState, setActionState] = useState<ActionState>({ kind: 'idle' })

  const treeWidth = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().treeWidth)
  const previewWidth = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().previewWidth)
  const preview = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().preview)

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
    await refreshAndSchedule()
  }

  const pauseAll = (): void => { void runAction(async () => { unwrap(await remote.pauseAll({ instanceId })) }) }
  const resumeAll = (resumePrompt: string): void => { void runAction(async () => { unwrap(await remote.resumeAll({ instanceId, resumePrompt })) }) }
  const abort = (): void => { void runAction(async () => { unwrap(await remote.abortInstance(instanceId)) }) }
  const resumeStep = (stepId: string, resumePrompt: string): void => { void runAction(async () => { unwrap(await remote.resumeStep({ instanceId, stepId, resumePrompt })) }) }
  const retryStep = (stepId: string, mode: RetryMode, message: string): void => { void runAction(async () => { unwrap(await remote.retryStep({ instanceId, stepId, mode, message })) }) }
  const replyQuestion = (requestId: string, answers: AnswerItem[]): void => {
    void runAction(async () => { unwrap(await remote.replyQuestion({ instanceId, requestId, answers: { answers } })) })
  }
  const replyPermission = (requestId: string, reply: 'once' | 'always' | 'reject'): void => {
    void runAction(async () => { unwrap(await remote.replyPermission({ instanceId, requestId, reply })) })
  }

  const state = loadState.kind === 'ready' ? loadState.state : undefined
  const tree = useMemo(() => (state === undefined ? [] : buildRunTree(state)), [state])
  const timeline = useMemo(() => (state === undefined ? [] : buildTimeline(state)), [state])
  const { questions, permissions } = state === undefined
    ? { questions: [], permissions: [] }
    : partitionInteractions(state.pendingInteractions)

  const selectLeaf = (selection: TreeLeafSelection): void => {
    setWorkflowState({ preview: selection })
  }

  const closePreview = (): void => {
    setWorkflowState({ preview: null })
  }

  const pending = actionState.kind === 'pending'

  return (
    <section className={css.runView} aria-label={t('run.title')} data-sandore-run-view>
      <div className={css.columns}>
        <aside style={{ width: treeWidth }} className={css.treeCol}>
          <TreeNav
            t={t}
            tree={tree}
            activePreviewId={preview?.leafId ?? null}
            onSelectLeaf={selectLeaf}
            onOpenChild={openSession}
          />
        </aside>
        <DragHandle side="tree" className={css.dragHandle} onDrag={resizeTreeWidth} />
        <div className={css.mainCol}>
          <header className={css.header}>
            <span className={css.title}>{t('run.title')}</span>
            {state !== undefined && (
              <span className={css.statusBadge}>
                <StateDot state={runDotState(state.status)} />
                <span>{t(RUN_STATUS_KEYS[state.status])}</span>
              </span>
            )}
            <span className={css.spacer} />
            {state !== undefined && isRunningStatus(state.status) && (
              <Button size="sm" variant="ghost" disabled={pending} onClick={pauseAll}>{t('run.pauseAll')}</Button>
            )}
            {state !== undefined && state.status === 'paused' && (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => { resumeAll('') }}>{t('run.resumeAll')}</Button>
            )}
            {state !== undefined && !isTerminalStatus(state.status) && (
              <Button size="sm" variant="ghost" icon={<IconStopFill16 />} disabled={pending} onClick={abort} aria-label={t('run.abort')} />
            )}
            <Button size="sm" variant="ghost" icon={<IconRefreshOutline16 />} onClick={() => { void refreshAndSchedule() }} aria-label={t('run.refresh')} />
            <Button size="sm" variant="outline" onClick={() => { openSession(instanceId) }}>{t('run.discuss')}</Button>
          </header>

          {loadState.kind === 'loading' && <p className={css.loading}>{t('run.loading')}</p>}
          {loadState.kind === 'error' && <p className={css.error} role="alert">{t('run.error', { message: loadState.message })}</p>}
          {actionState.kind === 'error' && <p className={css.error} role="alert">{actionState.message}</p>}

          {loadState.kind === 'ready' && state !== undefined && (
            <>
              <UnifiedTimeline t={t} items={timeline} openSession={openSession} />
              {(questions.length > 0 || permissions.length > 0) && (
                <div className={css.interactions}>
                  {questions.map(entry => (
                    <QuestionCard key={entry.id} entry={entry} t={t} pending={pending} onReply={replyQuestion} />
                  ))}
                  {permissions.map(entry => (
                    <PermissionCard key={entry.id} entry={entry} t={t} pending={pending} onReply={replyPermission} />
                  ))}
                </div>
              )}
              <DiscussionInput
                t={t}
                status={state.status}
                steps={state.executedSteps}
                pending={pending}
                onPauseAll={pauseAll}
                onResumeAll={resumeAll}
                onResumeStep={resumeStep}
                onRetryStep={retryStep}
              />
            </>
          )}
        </div>
        {preview !== null && (
          <>
            <DragHandle side="preview" className={css.dragHandle} onDrag={resizePreviewWidth} />
            <div style={{ width: previewWidth }} className={css.previewCol}>
              <PreviewPanel t={t} target={preview} onClose={closePreview} />
            </div>
          </>
        )}
      </div>
    </section>
  )
}
