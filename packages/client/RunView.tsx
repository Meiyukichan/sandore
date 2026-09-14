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
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ArtifactEntry, InstanceSummary } from '@meiyukichan/dsh-sandore/remote'
import type { RevertBoundaryOption } from '@meiyukichan/dsh-sandore/types'
import type { PendingPermissionEntry, PendingQuestionEntry, WorkflowTaskState } from '@meiyukichan/dsh-sandore/schema'

import { unwrap } from './remote.ts'
import { describeError } from './describe-error.ts'
import { instanceBoundToHost } from './main-agent-workflow-model.ts'
import { FOLLOW_THRESHOLD } from './timeline-window.ts'
import {
  buildTimeline, buildRunTree, isRunningStatus, lastActiveSegmentsOf, partitionInteractions,
  type AnswerItem, type DagRunStatus, type ExecutedStep, type RetryMode,
} from './run-view-model.ts'
import { TreeNav, type TreeLeafSelection } from './TreeNav.tsx'
import { StepRail } from './step-view/StepRail.tsx'
import { UnifiedTimeline } from './UnifiedTimeline.tsx'
import { DiscussionInput } from './DiscussionInput.tsx'
import { subscribeSandoreSse } from './sandore-sse.ts'
import { stepChatReuseSegments } from './step-chat-registry.ts'
// 主代理席位（呈现层统一）：宿主会话 id 解析 / 主代理卡片的出现条件探测
// （需求 1/3；「中止主代理当前 turn」的动作探测已随输入框停止按钮删除，暂停入口改为
//  DSH 中心列的「停止生成」→ 引擎 host-turn-abort 判 paused，见 DiscussionInput.tsx 文件头）。
import { mainAgentSessionIdOf } from './main-agent-chat.ts'
import { useMainAgentCard } from './main-agent-card.ts'
import { useMessageColumnWidthPublisher } from './main-agent-input-metrics.ts'
// sessions 服务（模块级单例，apply() 时注入）：主代理输入框席位解析宿主会话 binding 用。
import { stepChatSessionsOf } from './StepChatPanel.tsx'
// 批 B2：面板内重试的调用面（TimeLine → StepChatPanel 的重试行；**零新 RPC**，
// 装配既有 remote.retryStep / remote.listRevertBoundaries）。
import type { StepRetryActions } from './step-view/step-retry.ts'
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

/** 终态实例状态（标题栏的中止按钮据此隐藏；与 engine 的 TERMINAL_STATUSES 同义）。 */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'aborted'])

/** RunView 所需的最小 `ctx.remote.sandore` 访问面。 */
export interface RunViewRemote {
  getInstanceState(instanceId: string): Promise<RemoteResult<unknown>>
  /**
   * 实例摘要清单（`hostFilter` 模式下的**唯一**数据源：本视图不接收 instanceId，只按
   * 宿主会话 id 认领属于自己的那一条；非 `hostFilter` 宿主不调用它）。
   */
  listInstances(): Promise<RemoteResult<InstanceSummary[]>>
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
  /** 运行页权限下拉：引擎侧同步实例权限模式（宿主 session + hostAgent 重新应用）。 */
  updateInstancePermissionMode(input: { instanceId: string; mode: string }): Promise<RemoteResult<void>>
}

/** RunView 接收的普通业务 props（instanceId + 跳会话回调 + remote 访问面 + locale）。 */
export interface RunViewProps {
  /** 类型化的翻译函数（sandore 命名空间）。 */
  t: TranslateNS<'sandore'>
  /**
   * 目标工作流实例 id（宿主 Session id == instanceId）。`hostFilter` 模式下**忽略**
   * （实例由本视图按宿主会话过滤认领，见 {@link RunViewProps.hostFilter}）。
   */
  instanceId: string
  /**
   * **宿主会话过滤**（两个 WebUI 宿主共用本实现的开关，二选一传）：
   * - 缺省（侧栏工作流页 `EditorPane` 那条：选中态驱动）：直接渲染 `instanceId`；
   * - 传值（主代理会话内的「工作流」tab）：先 `listInstances()`，只认领
   *   `instanceId === hostFilter` 的那一条（引擎恒等式 `hostSessionId ≡ instanceId`），
   *   认领不到则给与列表页同族的空态，绝不显示别的会话的实例。
   *
   * **不复制第二份 RunView**：过滤/空态只是本组件的一条前置分支，树导航、执行详情、
   * 时间线、刷新通道（SSE + 兜底轮询 + 焦点恢复）全部同一份实现。
   */
  hostFilter?: string | undefined
  /**
   * 是否渲染底部讨论输入面（`DiscussionInput`：主代理输入框 + ask/permission 接管卡）。
   * 缺省 `true`（**既有宿主保持现状**：侧栏工作流页照旧带输入框）；主代理会话内的 tab
   * 传 `false`——该 tab 里不应出现任何输入面（用户规格），会话本身的输入框在中心列，
   * 两处并存会让人以为在往不同地方发消息。
   */
  showDiscussionInput?: boolean | undefined
  /** 跳会话回调（agent 标题 → DSH 现成子代理会话页）。`parentSessionId` 为 durable 直接父
   *  （引擎 `sessionMeta.hostSessionId`）——**打开与历史加载必须装配同一个 durable 地址**。 */
  openSession(id: string, parentSessionId?: string): void
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

/**
 * 宿主认领状态（仅 `hostFilter` 模式用）：本会话绑定实例的解析结果。
 *
 * - `pending`：首次 `listInstances()` 尚未返回；
 * - `none`：清单已回，但没有 `instanceId === hostFilter` 的行（空态）；
 * - `found`：认领到实例（`instanceId` + `originalInput` 供空态/诊断）。
 */
type HostClaim =
  | { readonly kind: 'pending' }
  | { readonly kind: 'none' }
  | { readonly kind: 'found'; readonly instanceId: string; readonly originalInput: string }

/** `hostFilter` 未传时的恒等占位（保持 hook 依赖与调用次数在两种模式下完全一致）。 */
const NO_HOST_FILTER = ''

/** 渲染 RunView（树形导航 + 执行详情页）。 */
// 四个席位 face（`modelDirectory` / `permissions` / `runCommand` / `queryPermission`）由
// packages/client/index.ts 组装（复用 DSH 的 `ctx.modelDirectories`、会话 projections 与
// `remote.commands`）——运行页输入框把它们渲染成 DSH 同款的**权限下拉（左）+ 模型下拉（右）**，
// 两个下拉都是真功能：模型经 `session.selectModel` 落到主代理会话（下一次请求生效），
// 权限经 DSH `/permission <id>` + 引擎 `updateInstancePermissionMode` 双通路落下。
export function RunView({
  t, instanceId, openSession, remote, hostFilter, showDiscussionInput = true,
  modelDirectory, permissions: permissionFace, runCommand, queryPermission,
}: RunViewProps) {
  const [loadState, setLoadState] = useState<RunLoadState>({ kind: 'loading' })
  const [actionState, setActionState] = useState<ActionState>({ kind: 'idle' })
  // 宿主过滤模式（主代理会话内的 tab）：实例由本视图按宿主会话 id 认领，
  // `instanceId` 退居默认值。侧栏工作流页不传 `hostFilter`，行为与改动前逐字节一致。
  const hostMode = hostFilter !== undefined
  const [hostClaim, setHostClaim] = useState<HostClaim>({ kind: 'pending' })
  // 本视图真正要渲染的实例：`hostFilter` 模式取认领结果，否则取 props 的 `instanceId`。
  const targetInstanceId = hostMode
    ? (hostClaim.kind === 'found' ? hostClaim.instanceId : NO_HOST_FILTER)
    : instanceId

  const previewWidth = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().previewWidth)
  const preview = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().preview)

  // Round 12：卸载标记（焦点/可见性回调中检查）。
  const disposedRef = useRef(false)

  const refresh = useCallback(async (): Promise<DagRunStatus | undefined> => {
    try {
      const [stateResult, artifactsResult] = await Promise.all([
        remote.getInstanceState(targetInstanceId),
        remote.getArtifacts(targetInstanceId),
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
  }, [targetInstanceId, remote])

  /**
   * 宿主认领（仅 `hostFilter` 模式）：`listInstances()` + 恒等式过滤。
   *
   * 为什么用**独立的** effect（而不是塞进主刷新循环）：两种模式的刷新语义不同——
   * 侧栏那条刷新的是「已选中实例的状态」，这里刷新的是「本会话有没有实例」。
   * 认领成功后本 effect 因 `targetInstanceId` 变化而停止（`claimed === true` 早退），
   * 后续状态刷新完全交给下面那条既有的主刷新循环，不产生第二条轮询。
   */
  const claimed = hostClaim.kind === 'found'
  useEffect(() => {
    if (!hostMode) return
    if (claimed) return
    let cancelled = false
    const claim = async (): Promise<void> => {
      try {
        const instances = unwrap(await remote.listInstances())
        if (cancelled) return
        const mine = instances.find(instance => instanceBoundToHost(instance, hostFilter))
        setHostClaim(mine === undefined
          ? { kind: 'none' }
          : { kind: 'found', instanceId: mine.instanceId, originalInput: mine.originalInput })
      } catch (error) {
        if (cancelled) return
        // 认领失败按「本会话暂无实例」呈现（同族错误已在主刷新循环里报；这里不额外
        // 造错误态，避免列表 RPC 抖动把整个 tab 变成错误页）。
        setHostClaim({ kind: 'none' })
        void error
      }
    }
    void claim()
    // 认领前的低频兜底（30s）：实例在该会话里被创建时无需刷新页面就能出现
    // （SSE 只在终态/阶段流转推送，实例创建那一刻不一定有帧）。
    const timer = setInterval(() => { void claim() }, STALE_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [hostMode, claimed, hostFilter, remote])

  // 事件驱动即时刷新：step-phase 事件到达立即 RPC（宿主 session 打开时生效）。
  const forceRefresh = useCallback(async (): Promise<void> => {
    if (disposedRef.current) return
    if (hostMode && !claimed) return
    await refresh()
  }, [refresh, hostMode, claimed])

  // Round 12：焦点/可见性恢复刷新
  useFocusRefresh(forceRefresh)

  // 主刷新循环：首次加载 + 30s 超低频兜底（终态自动停止）。
  //
  // `hostFilter` 模式下 `targetInstanceId` 在认领前是空串（本会话还没有实例）——
  // 此时**不发**任何实例 RPC（`getInstanceState('')` 必然 NODE_NOT_FOUND），只把加载态
  // 置为占位；认领成功（`targetInstanceId` 变化）后本循环自动重跑并接管刷新。
  const awaitingHostClaim = hostMode && !claimed
  useEffect(() => {
    disposedRef.current = false
    setLoadState({ kind: 'loading' })
    if (awaitingHostClaim) return

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
  }, [refresh, awaitingHostClaim])

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

  const abort = (): void => { void runAction(async () => { unwrap(await remote.abortInstance(targetInstanceId)) }) }
  // 批 B2：**面板内重试**的调用面（UnifiedTimeline → StepChatPanel 的重试行）。
  //
  // 为什么另起一份而不复用上面的 `retryStep`：上面那份走 runAction——它把整卡动作态
  // 拉到 pending（连带禁用底部 composer）并把错误落到页面级错误行；而面板内的重试
  // 需要「面板自持进行中/错误行」：错误行要展示**引擎原文**（尤其 F1 的「子代理会话
  // 已销毁…不能重试」），失败后面板仍停在原段（可改模式重试——需求 1 起载荷是固定
  // 默认串，面板没有草稿）。故这份端口直接 unwrap，
  // 让拒绝冒泡到 StepRetryRow 的错误行；成功/失败都在 finally 触发既有 refresh()，
  // 让新段（fork/revert 会换 childId）尽快落地——UnifiedTimeline 的 key 随之换值重挂
  // 面板。查询侧（listBoundaries）与上面那份同语义：只读、不经 runAction。
  const stepRetryActions = useMemo<StepRetryActions>(() => ({
    retry: async (input) => {
      try {
        // revertBoundary 显式条件展开：exactOptionalPropertyTypes 下不能把
        // `number | undefined` 直接喂给 `revertBoundary?: number` 的入参面。
        unwrap(await remote.retryStep({
          instanceId: targetInstanceId,
          stepId: input.stepId,
          mode: input.mode,
          message: input.message,
          ...(input.revertBoundary === undefined ? {} : { revertBoundary: input.revertBoundary }),
        }))
      } finally {
        // 失败也可能已改动状态（引擎 prepare 失败会回退为 failed 段）：无条件重拉。
        void refresh()
      }
    },
    listBoundaries: async stepId => unwrap(await remote.listRevertBoundaries({ instanceId: targetInstanceId, stepId })),
  }), [targetInstanceId, remote, refresh])
  const replyQuestion = (requestId: string, answers: AnswerItem[]): void => {
    void runAction(async () => { unwrap(await remote.replyQuestion({ instanceId: targetInstanceId, requestId, answers: { answers } })) })
  }
  const rejectQuestion = (requestId: string): void => {
    void runAction(async () => { unwrap(await remote.rejectQuestion({ instanceId: targetInstanceId, requestId })) })
  }
  const replyPermission = (requestId: string, reply: 'once' | 'always' | 'reject'): void => {
    void runAction(async () => { unwrap(await remote.replyPermission({ instanceId: targetInstanceId, requestId, reply })) })
  }

  const state = loadState.kind === 'ready' ? loadState.state : undefined
  const tree = useMemo(() => (state === undefined ? [] : buildRunTree(state)), [state])
  const timeline = useMemo(() => (state === undefined ? [] : buildTimeline(state)), [state])
  const { questions, permissions } = state === undefined
    ? { questions: [], permissions: [] }
    : partitionInteractions(state.pendingInteractions)

  // 批 B1：活跃 Step 段（同 stepId 取 attemptIndex 最大者）——DiscussionInput 的
  // @Step 目标选择与内嵌 StepChatPanel 的 @step 提及共用同一份片段（后者再经
  // UnifiedTimeline → StepChatPanel 登记进 step-chat-registry）。**零新 RPC**：
  // 数据就是本组件既有 getInstanceState 轮询结果。
  //
  // 引用稳定化（必要）：这份片段要逐行下传（AgentMsg 的 props）+ 作为面板登记内容，
  // 而每轮轮询都会重建数组与段对象——不归一就会击穿行级 React.memo（整列重渲，
  // 含 StepChatPanel 的消息树）。stepChatReuseSegments 按展示等价复用上一份引用。
  // 归一写入 ref 放在**渲染后的 effect**（不在 useMemo 里写 ref：渲染必须无副作用，
  // 并发/StrictMode 下会被放大）。
  const segmentsRef = useRef<readonly ExecutedStep[]>([])
  const normalizedSegments = useMemo(() => {
    const next = state === undefined ? [] : lastActiveSegmentsOf(state.executedSteps)
    return stepChatReuseSegments(segmentsRef.current, next)
  }, [state])
  useEffect(() => { segmentsRef.current = normalizedSegments }, [normalizedSegments])
  const activeSegments = normalizedSegments

  // ── 主代理席位（呈现层统一 · 本批；真机验收修正后的形态）─────────────────────
  // 宿主（主代理）会话 id：段上持久化的 `sessionMeta.hostSessionId` 优先（run-view-model
  // 把它映射成 `parentSessionId`），全部缺失时回退 `instanceId`——引擎侧的恒等式是
  // `hostSessionId ≡ instanceId`（见 main-agent-chat.ts 的解析函数与注释）。
  const hostSessionId = mainAgentSessionIdOf(activeSegments, targetInstanceId)
  // 主代理卡片的出现条件（真机反馈修正版）：**主代理会话里有助手消息就出现**
  // （启动注入后主代理自己汇报「工作流已启动」也算——不再要求用户先在运行页发过消息）。
  // 判定全在 `useMainAgentCard`（订阅宿主会话视图，见 main-agent-card.ts / main-agent-chat.ts）。
  const mainAgentCard = useMainAgentCard(hostSessionId)
  // 宽度基准（真机反馈）：以运行视图里 step 消息列为准——给 `.column` 挂 ResizeObserver，
  // 把它的**内容宽**发布到 `.feedCol`（输入卡与 ask/permission 接管卡都读这个变量，
  // 于是三者同宽同轴心，只比消息宽 24px）。
  const feedColRef = useRef<HTMLDivElement>(null)
  const publishMessageColumn = useMessageColumnWidthPublisher(feedColRef)
  /**
   * 权限下拉 → 引擎侧同步：`updateInstancePermissionMode` 对宿主 session + hostAgent 重新应用
   * sandbox 模式与审批策略，并把 `state.permission` 持久化（终态实例会拒——DSH 官方
   * `/permission` 命令那条路已经生效，故这里吞掉拒绝，不让 UI 出现假失败）。
   */
  const setInstancePermission = useCallback(async (mode: string): Promise<void> => {
    unwrap(await remote.updateInstancePermissionMode({ instanceId: targetInstanceId, mode }))
  }, [targetInstanceId, remote])

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

  const workflowName = state?.workflowName ?? state?.workflowId ?? ''
  const rawInput = state?.originalInput ?? ''
  // 底部分栏的渲染条件：`hostFilter` 模式在**本会话没有绑定实例**时不渲染执行详情分栏
  // （左树/右详情都会是空数据）。
  //
  // 这一支的文案**不是**「工作流页的空态」：主代理会话内的「工作流」tab 渲染的是侧栏那套
  // **完整页面**（`WorkflowOverlay`：实例列表 + 编排列表 + 模式切换 + 搜索 + 运行工作流/
  // 新增定义），本视图只负责它右栏的执行详情位。所以这里只需说明「本会话没有绑定的实例」
  // —— 也就是用户该去左侧列表里运行一个工作流。
  // 非 `hostFilter` 模式恒为 true（侧栏工作流页的渲染完全不变）。
  const showSplit = !awaitingHostClaim && !(hostMode && hostClaim.kind === 'none')

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
          {/* 中止实例：真机反馈后从输入框旁（与「停止生成」挤在一起）移到标题栏——
              能力保留、位置不再与停止按钮混淆。终态隐藏（没什么可中止）。 */}
          {state !== undefined && !TERMINAL_RUN_STATUSES.has(state.status) && (
            <button
              type="button"
              className={css.abortBtn}
              title={t('run.abort')}
              aria-label={t('run.abort')}
              disabled={pending}
              data-sandore-abort
              onClick={abort}
            >
              {t('run.abort')}
            </button>
          )}
        </div>
      </header>

      {/* 无绑定实例（仅 `hostFilter` 模式）：本会话没有属于它的实例 ⇒ 执行详情位给一句话。
          页面本体的空态/交互入口由**外层页面**负责（主代理会话 tab 渲染的是侧栏那套完整
          `WorkflowOverlay`：实例列表 + 编排列表 + 模式切换 + 搜索 + 运行工作流/新增定义），
          本视图只是它右栏的执行详情位。 */}
      {!showSplit && (
        <div className={css.detailSplit} data-sandore-run-empty="host">
          <div className={css.editorPlaceholder}>{t('tab.workflow.empty.hint')}</div>
        </div>
      )}

      {/* 左右分栏（无分割线）：左 = 工作流导航，右 = 对话消息列表。 */}
      {showSplit && (
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

          <div ref={feedColRef} className={css.feedCol}>
            {/* 每 step 一档的轮次条（需求修正：discussion 的轮次条改按 step，垂直居中
                贴右缘；旧「每轮」刻度已从 discussion 的 StepChatPanel 里撤掉）。
                点击定位到对应 step 卡片（`[data-tl-step][data-step-id]`），滚动时
                当前档高亮——判定/换算见 `step-view/step-rail.ts`。 */}
            <StepRail segments={activeSegments} scrollContainerRef={feedScrollRef} t={t} />
            {/* 消息滚动区（独立滚动）：ref + onScroll 供贴底跟随；ref 下传 UnifiedTimeline
                供「加载更早」扩窗 prepend 保位。 */}
            <div ref={feedScrollRef} className={css.feedScroll} onScroll={handleFeedScroll}>
              <div ref={publishMessageColumn} className={css.column}>
                {loadState.kind === 'loading' && <p className={css.loading}>{t('run.loading')}</p>}
                {loadState.kind === 'error' && <p className={css.error} role="alert">{t('run.error', { message: loadState.message })}</p>}
                {actionState.kind === 'error' && <p className={css.error} role="alert">{actionState.message}</p>}

                {loadState.kind === 'ready' && state !== undefined && (
                  <UnifiedTimeline
                    t={t}
                    items={timeline}
                    openSession={openSession}
                    scrollContainerRef={feedScrollRef}
                    instanceId={targetInstanceId}
                    steps={activeSegments}
                    retry={stepRetryActions}
                    hostSessionId={hostSessionId}
                    mainChat={{
                      shown: mainAgentCard.shown,
                      outputCount: mainAgentCard.outputCount,
                      // 终态（completed/failed/aborted）⇒ 卡片强制展开（用户规格：终态默认展开。
                      // 顺带修掉真机缺陷「完成后卡体为空」——旧实现里卡片在终态重挂后停在默认折叠态）。
                      terminal: TERMINAL_RUN_STATUSES.has(state.status),
                    }}
                  />
                )}
              </div>
            </div>

            {/* 输入框：固定在对话列最底部（照 DSH 主会话输入框位置），与消息区隔离。
                呈现层统一（需求 1）：这是**主代理输入框**（独立实现，视觉细节逐值照抄 DSH
                InputBar；宽度以本视图的 step 消息列为基准 + 24px、同轴心）。
                主代理一旦产出消息，UnifiedTimeline 就把主代理卡片作为**最后一张**卡片渲染
                （真机反馈：主代理只有一个，固定放在最下面）。
                运行中唯一的停止按钮（DSH 停止席位同款）语义见 DiscussionInput.tsx 与 pauseAll 注释。
                **两个宿主的参数差异**：侧栏工作流页缺省渲染（`showDiscussionInput` 未传）；
                主代理会话内的「工作流」tab 传 `false`——该 tab 里不得出现任何输入面（用户规格），
                会话自己的输入框就在中心列，两处并存会让人以为在往不同地方发消息。 */}
            {showDiscussionInput && loadState.kind === 'ready' && state !== undefined && (
              <div className={css.composerWrap}>
                <DiscussionInput
                  t={t}
                  status={state.status}
                  steps={activeSegments}
                  questions={questions}
                  permissions={permissions}
                  pending={pending}
                  onReplyQuestion={replyQuestion}
                  onRejectQuestion={rejectQuestion}
                  onReplyPermission={replyPermission}
                  hostSessionId={hostSessionId}
                  modelDirectory={modelDirectory}
                  permissionFace={permissionFace}
                  runCommand={runCommand}
                  setInstancePermission={setInstancePermission}
                  queryPermission={queryPermission}
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
      )}
    </section>
  )
}
