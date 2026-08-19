/**
 * RunView：执行态视图（树形导航 + 执行详情页）。
 *
 * 执行详情按 `docs/design/execution-detail-prototype.html` 原型实现：
 * multica Issue 页面骨架（面包屑 header + 固定 head + 滚动 feed + 底部 composer）×
 * DSH 多 agent 对话流（用户右气泡 + agent 左流式）× DSH composer 接管面板
 * （权限申请 ApprovalPanel / 问题选择 QuestionComposer）。
 *
 * 数据源 = `getInstanceState` 轮询（运行中 5s，终态停）+ `getArtifacts` 初始化；
 * 对话流与 agent 消息由纯函数从状态派生。agent 标题点击 → `openSession(childId)`
 * 打开 DSH 现成的子代理会话页（复用，不重复实现）；暂停/恢复/重试/中止集中在
 * 底部 composer（接管面板期间隐藏）；权限/问答待办以 composer 接管面板呈现。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/RunView
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ArtifactEntry } from '@deepseek-ai/dsh-sandore-workflow/remote'
import type { PendingPermissionEntry, PendingQuestionEntry, WorkflowTaskState } from '@deepseek-ai/dsh-sandore-workflow/schema'

import { unwrap } from './remote.ts'
import { describeError } from './describe-error.ts'
import {
  buildTimeline, buildRunTree, isRunningStatus, lastActiveSegmentsOf, partitionInteractions,
  type AnswerItem, type DagRunStatus, type RetryMode,
} from './run-view-model.ts'
import { TreeNav, type TreeLeafSelection } from './TreeNav.tsx'
import { UnifiedTimeline } from './UnifiedTimeline.tsx'
import { DiscussionInput } from './DiscussionInput.tsx'
import type { ModelDirectoryFace, ObservableFace, PermissionSelectValue } from './model-faces.ts'
import { PreviewPanel } from './PreviewPanel.tsx'
import { DragHandle } from './DragHandle.tsx'
import {
  getWorkflowState, resizePreviewWidth, setWorkflowState, subscribeWorkflowState,
} from './workflow-store.ts'
import css from './RunView.module.css'

/** 轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 5000

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
  /** 跳会话回调（agent 标题 → DSH 现成子代理会话页）。 */
  openSession(id: string): void
  /** `ctx.remote.sandore` 的最小 RPC 访问面（返回 `RemoteResult`，经 `unwrap` 解包）。 */
  remote: RunViewRemote
  /** 某会话的共享模型目录（复用 DSH `ctx.modelDirectories`）。 */
  modelDirectory(sessionId: string): ModelDirectoryFace
  /** 某会话的权限投影（`projections.permissions`）。 */
  permissions(sessionId: string): ObservableFace<PermissionSelectValue | undefined>
  /** 对某会话执行一行命令（`/permission <id>`）。 */
  runCommand(sessionId: string, line: string): Promise<boolean>
  /** 权限投影缺失回退：经 `/permission`（无参）查询。 */
  queryPermission(sessionId: string): Promise<PermissionSelectValue | undefined>
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

/** 渲染 RunView（树形导航 + 执行详情页）。 */
export function RunView({ t, instanceId, openSession, remote, modelDirectory, permissions: sessionPermissionsOf, runCommand, queryPermission }: RunViewProps) {
  const [loadState, setLoadState] = useState<RunLoadState>({ kind: 'loading' })
  const [actionState, setActionState] = useState<ActionState>({ kind: 'idle' })

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

  // 「N 个正在工作」：已开始且未结束的 Step（running/interacting/paused）。
  const workingCount = state === undefined
    ? 0
    : state.executedSteps.filter(step =>
        step.status === 'running' || step.status === 'interacting' || step.status === 'paused',
      ).length

  const selectLeaf = (selection: TreeLeafSelection): void => {
    setWorkflowState({ preview: selection })
  }

  const closePreview = (): void => {
    setWorkflowState({ preview: null })
  }

  const pending = actionState.kind === 'pending'

  // 会话权限投影面（绑定当前实例会话，供 composer 权限选择器订阅）。
  const permissionsFace = useMemo(
    () => sessionPermissionsOf(instanceId),
    [sessionPermissionsOf, instanceId],
  )

  const workflowName = state?.workflowName ?? state?.workflowId ?? ''
  const rawInput = state?.originalInput ?? ''

  return (
    <section className={css.runView} aria-label={t('run.title')} data-sandore-run-view>
      {/* 顶部标题栏（横跨全宽）：面包屑 + agent 工作数 chip。 */}
      <header className={css.pageHeader}>
        <nav className={css.crumb}>
          <span className={css.seg}><span className={css.crumbItem}>{workflowName}</span></span>
          <span className={css.sep} aria-hidden>/</span>
          <span className={css.seg}>
            <span className={`${css.crumbItem} ${css.crumbCurrent}`} title={rawInput}>{rawInput}</span>
          </span>
        </nav>
        <div className={css.headerActions}>
          {state !== undefined && workingCount > 0 && (
            <span className={css.agentChip}>
              <span className={css.agentDot} aria-hidden />
              {t('run.workingAgents', { count: workingCount })}
            </span>
          )}
        </div>
      </header>

      {/* 左右分栏（无分割线）：左 = 工作流导航，右 = 对话消息列表。 */}
      <div className={css.detailSplit}>
        <div className={css.navCol}>
          <TreeNav
            t={t}
            tree={tree}
            activePreviewId={preview?.leafId ?? null}
            onSelectLeaf={selectLeaf}
            onOpenChild={openSession}
          />
        </div>

        <div className={css.feedCol}>
          {/* 消息滚动区（独立滚动）。 */}
          <div className={css.feedScroll}>
            <div className={css.column}>
              {loadState.kind === 'loading' && <p className={css.loading}>{t('run.loading')}</p>}
              {loadState.kind === 'error' && <p className={css.error} role="alert">{t('run.error', { message: loadState.message })}</p>}
              {actionState.kind === 'error' && <p className={css.error} role="alert">{actionState.message}</p>}

              {loadState.kind === 'ready' && state !== undefined && (
                <UnifiedTimeline t={t} items={timeline} openSession={openSession} />
              )}
            </div>
          </div>

          {/* 输入框：固定在对话列最底部（照 DSH 主会话输入框位置），与消息区隔离。 */}
          {loadState.kind === 'ready' && state !== undefined && (
            <div className={css.composerWrap}>
              <DiscussionInput
                t={t}
                status={state.status}
                steps={lastActiveSegmentsOf(state.executedSteps)}
                questions={questions}
                permissions={permissions}
                pending={pending}
                onPauseAll={pauseAll}
                onResumeAll={resumeAll}
                onResumeStep={resumeStep}
                onRetryStep={retryStep}
                onReplyQuestion={replyQuestion}
                onReplyPermission={replyPermission}
                onAbort={abort}
                instanceId={instanceId}
                modelDirectory={modelDirectory}
                sessionPermissions={permissionsFace}
                runCommand={runCommand}
                queryPermission={() => queryPermission(instanceId)}
              />
            </div>
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
