/**
 * RunView：执行态视图（树形导航 + 执行详情页）。
 *
 * 执行详情按 `docs/design/execution-detail-prototype.html` 原型实现：
 * multica Issue 页面骨架（面包屑 header + 固定 head + 滚动 feed + 底部 composer）×
 * DSH 多 agent 对话流（用户右气泡 + agent 左流式）× DSH composer 接管面板
 * （权限申请 ApprovalPanel / 问题选择 QuestionComposer）。
 *
 * Round 12：去除 5s 递归 setTimeout 轮询，改为 subscribeStepPhase 事件驱动
 * + 30s 超低频兜底 + 焦点/可见性恢复刷新（终态自动停止）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/RunView
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ArtifactEntry } from '@meiyukichan/dsh-sandore/remote'
import type { RevertBoundaryOption } from '@meiyukichan/dsh-sandore/types'
import type { PendingPermissionEntry, PendingQuestionEntry, WorkflowTaskState } from '@meiyukichan/dsh-sandore/schema'

import { unwrap } from './remote.ts'
import { describeError } from './describe-error.ts'
import { FOLLOW_THRESHOLD } from './timeline-window.ts'
import {
  buildTimeline, buildRunTree, isRunningStatus, lastActiveSegmentsOf, partitionInteractions,
  type AnswerItem, type DagRunStatus, type RetryMode,
} from './run-view-model.ts'
import { TreeNav, type TreeLeafSelection } from './TreeNav.tsx'
import { UnifiedTimeline } from './UnifiedTimeline.tsx'
import { DiscussionInput } from './DiscussionInput.tsx'
import { subscribeSandoreSse } from './sandore-sse.ts'
import type { ModelDirectoryFace, ObservableFace, PermissionSelectValue } from './model-faces.ts'
import { PreviewPanel } from './PreviewPanel.tsx'
import { DragHandle } from './DragHandle.tsx'
import {
  getWorkflowState, resizePreviewWidth, setWorkflowState, subscribeWorkflowState,
} from './workflow-store.ts'
import { useFocusRefresh } from './use-focus-refresh.ts'
import css from './RunView.module.css'

/** Round 12：30s 超低频兜底轮询间隔（事件驱动+焦点恢复为主要刷新源）。 */
const STALE_POLL_MS = 30000

/** RunView 所需的最小 `ctx.remote.sandore` 访问面。 */
export interface RunViewRemote {
  getInstanceState(instanceId: string): Promise<RemoteResult<unknown>>
  getArtifacts(instanceId: string, stageId?: string): Promise<RemoteResult<ArtifactEntry[]>>
  abortInstance(instanceId: string): Promise<RemoteResult<void>>
  pauseAll(input: { instanceId: string }): Promise<RemoteResult<void>>
  resumeAll(input: { instanceId: string; resumePrompt?: string }): Promise<RemoteResult<void>>
  pauseStep(input: { instanceId: string; stepId: string }): Promise<RemoteResult<void>>
  resumeStep(input: { instanceId: string; stepId: string; resumePrompt?: string }): Promise<RemoteResult<void>>
  retryStep(input: { instanceId: string; stepId: string; mode: RetryMode; message: string; revertBoundary?: number }): Promise<RemoteResult<void>>
  listRevertBoundaries(input: { instanceId: string; stepId: string }): Promise<RemoteResult<RevertBoundaryOption[]>>
  sendStepMessage(input: { instanceId: string; stepId: string; message: string }): Promise<RemoteResult<void>>
  replyQuestion(input: { instanceId: string; requestId: string; answers: unknown }): Promise<RemoteResult<void>>
  rejectQuestion(input: { instanceId: string; requestId: string }): Promise<RemoteResult<void>>
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

  // Round 12：卸载标记（焦点/可见性回调中检查）。
  const disposedRef = useRef(false)

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

  // 事件驱动即时刷新：step-phase 事件到达立即 RPC（宿主 session 打开时生效）。
  const forceRefresh = useCallback(async (): Promise<void> => {
    if (disposedRef.current) return
    await refresh()
  }, [refresh])

  // Round 12：焦点/可见性恢复刷新
  useFocusRefresh(forceRefresh)

  // 主刷新循环：首次加载 + 30s 超低频兜底（终态自动停止）。
  useEffect(() => {
    disposedRef.current = false
    setLoadState({ kind: 'loading' })
    // 首次加载
    void refresh()

    // 30s 超低频兜底（终态自动停）
    const timer = setInterval(async () => {
      if (disposedRef.current) { clearInterval(timer); return }
      const status = await refresh()
      if (status !== undefined && !isRunningStatus(status)) {
        clearInterval(timer) // 终态停
      }
    }, STALE_POLL_MS)

    return () => {
      disposedRef.current = true
      clearInterval(timer)
    }
  }, [refresh])

  // SSE 事件通道订阅：引擎 `/sandore/events` 推送即时刷新。
  // Round 25：宿主会话不再承载 sandore/* 事件（去污染），step-phase conversationEvents
  // 通道随 sandoreStepDefinition/stepPhaseDefinition 一并移除——SSE 为唯一即时刷新源。
  useEffect(() => {
    return subscribeSandoreSse((_type, _data) => {
      if (disposedRef.current) return
      // 收到任何 sandore/* 事件都触发刷新（终态/阶段流转/Step 状态变更等）。
      void forceRefresh()
    })
  }, [forceRefresh])

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    setActionState({ kind: 'pending' })
    try {
      await action()
    } catch (error) {
      setActionState({ kind: 'error', message: describeError(error) })
      return
    }
    setActionState({ kind: 'idle' })
    await refresh()
  }

  const pauseAll = (): void => { void runAction(async () => { unwrap(await remote.pauseAll({ instanceId })) }) }
  const resumeAll = (resumePrompt: string): void => { void runAction(async () => { unwrap(await remote.resumeAll({ instanceId, resumePrompt })) }) }
  const abort = (): void => { void runAction(async () => { unwrap(await remote.abortInstance(instanceId)) }) }
  const resumeStep = (stepId: string, resumePrompt: string): void => { void runAction(async () => { unwrap(await remote.resumeStep({ instanceId, stepId, resumePrompt })) }) }
  const retryStep = (stepId: string, mode: RetryMode, message: string, revertBoundary?: number): void => { void runAction(async () => { unwrap(await remote.retryStep({ instanceId, stepId, mode, message, ...(revertBoundary === undefined ? {} : { revertBoundary }) })) }) }
  const sendStepMessage = (stepId: string, message: string): void => { void runAction(async () => { unwrap(await remote.sendStepMessage({ instanceId, stepId, message })) }) }
  // listRevertBoundaries 是只读查询，不经 runAction（避免禁用 composer）；失败内联回传错误信息。
  const listRevertBoundaries = async (stepId: string): Promise<RevertBoundaryOption[]> => {
    return unwrap(await remote.listRevertBoundaries({ instanceId, stepId }))
  }
  const replyQuestion = (requestId: string, answers: AnswerItem[]): void => {
    void runAction(async () => { unwrap(await remote.replyQuestion({ instanceId, requestId, answers: { answers } })) })
  }
  const rejectQuestion = (requestId: string): void => {
    void runAction(async () => { unwrap(await remote.rejectQuestion({ instanceId, requestId })) })
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

  // 贴底跟随（对齐 DSH ChatView 的 pinned-scroll）：滚动时记录是否贴底，贴底态下
  // 新消息到达自动跟随到底，上滚即停止。「加载更早」prepend 保位后 scrollTop 远离
  // 底部 → atBottom 自然转 false，不会误触发跟随（逻辑自洽）。
  const feedScrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const handleFeedScroll = useCallback(() => {
    const el = feedScrollRef.current
    if (el === null) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD
  }, [])

  // timeline 引用变化（新一批派生数据到达）且处于贴底态 → 下一帧滚到底（等 DOM
  // 提交后再量 scrollHeight）。
  useEffect(() => {
    const el = feedScrollRef.current
    if (el === null || !atBottomRef.current) return
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
  }, [timeline])

  // 首次 ready 后也滚到底一次（进入执行详情默认看最新消息）。
  useEffect(() => {
    if (loadState.kind !== 'ready') return
    const el = feedScrollRef.current
    if (el === null || !atBottomRef.current) return
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
  }, [loadState.kind])

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
          {/* 消息滚动区（独立滚动）：ref + onScroll 供贴底跟随；ref 下传 UnifiedTimeline
              供「加载更早」扩窗 prepend 保位。 */}
          <div ref={feedScrollRef} className={css.feedScroll} onScroll={handleFeedScroll}>
            <div className={css.column}>
              {loadState.kind === 'loading' && <p className={css.loading}>{t('run.loading')}</p>}
              {loadState.kind === 'error' && <p className={css.error} role="alert">{t('run.error', { message: loadState.message })}</p>}
              {actionState.kind === 'error' && <p className={css.error} role="alert">{actionState.message}</p>}

              {loadState.kind === 'ready' && state !== undefined && (
                <UnifiedTimeline t={t} items={timeline} openSession={openSession} scrollContainerRef={feedScrollRef} />
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
                onSendStepMessage={sendStepMessage}
                onListRevertBoundaries={listRevertBoundaries}
                onReplyQuestion={replyQuestion}
                onRejectQuestion={rejectQuestion}
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
