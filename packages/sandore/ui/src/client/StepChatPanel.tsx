/**
 * StepChatPanel：内嵌子代理消息面板——「看起来就是 DSH 子代理会话页的对话区」。
 *
 * 数据面与 DSH ChatView 同源：`sessions.binding(childId).session` 是
 * `ISession & ObservableSnapshot<ConversationSnapshot>`（`@deepseek-ai/dsh-client-runtime/client`
 * 公开面），经 `useSyncExternalStore` 订阅；挂载时 cast 调用 `Session.open()` 开窗
 * （拉历史 + 消费 mux 帧，幂等 + 失败静默）。
 *
 * 渲染面抄自 DSH 源码（`packages/sandore/ui/src/client/chat/` 与 `tool/`）：
 * - 用户消息左侧行式（UserMessageRow：用户图标 + User Message 标签 + 分隔点 + 单行省略
 *   摘要 + 时钟，点击展开完整文本/图片/附加块文本框；与工具行/上下文注入行同一
 *   DisclosureRow 行式体系，DSH 的右气泡形态按面板需求改造）
 * - agent 消息左对齐 markdown 正文（AssistantMarkdown + ReasoningRow Think 行 + 图片），
 *   流式 partial 经 `streaming` 标记增量渲染
 * - 工具调用（GenericToolCard + ToolRow：16px leading + 标题 + 摘要 + IN/OUT 展开 +
 *   terminal/read/diff/search/web 卡片材质 + 文件路径打开链接，运行中 sweep、失败红字），
 *   与 tool-result 配对为同一行
 * - 命令行（GenericCommandCard）；上下文注入（ContextInjectionRow + ContextBody 各 form）
 * - compaction 标记 / model-retry 披露 / turn-error / turn-max-tokens / unknown JSON 行
 * - turn-tail（已完结 turn 的尾部：时钟 + 运行时长/TTFT/吞吐 + 复制 + branch(fork)）
 * - 运行中 TurnStatus（Deep diving… 呼吸灯 + 计时）
 * - 消息行直接平铺在 step 卡下（无内部滚动容器、无 toBottom 跟随按钮，
 *   整体随 UnifiedTimeline 滚动）
 *
 * 唯一裁剪：外层只渲染 `snapshot.nodes` 的**最新 10 条**节点（`buildStepChatFlow`），
 * 因此不提供 loadOlder 分页（加载更早不会改变最新 10 条窗口）。
 * 时间线组件树不携带 cordis ctx，`apply()` 时经 `installStepChatSessions` /
 * `installStepChatWorkspaces` 注入 sessions / workspaces 服务到模块级单例
 * （install/dispose 配对保证 HMR/卸载不串台）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/StepChatPanel
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  type ConversationTimelineSnapshot, type ISessions, type SessionFace, type SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'

import { buildStepChatFlow, type StepChatFlowRow, type StepChatTailData } from './chat-flow.ts'
import { resolveWorkspacePath } from './workspace-path.ts'
import { formatOpenError, stepChatRebindDelayMs, stepChatRetryDelayMs } from './step-chat-retry.ts'
import { AssistantMarkdown } from './chat/AssistantMarkdown.tsx'
import {
  CompactionNodeView, ContextMessageNodeView, RetryNodeView, TurnErrorNodeView,
  TurnMaxTokensNodeView, UnknownNodeView,
} from './chat/MessageItem.tsx'
import { UserMessageRow } from './chat/UserMessageRow.tsx'
import { GenericCommandCard } from './chat/GenericCommandCard.tsx'
import { TurnTailNodeView } from './chat/TurnTailNodeView.tsx'
import { formatRunDuration } from './chat/message-chrome.ts'
import { GenericToolCard } from './tool/GenericToolCard.tsx'
import { ImageGallery, type SandoreRenderMessageImages } from './chat/attachment/MessageImage.tsx'
import { createImageLoader, type SandoreImageAttachmentRef } from './chat/attachment/image-attachment.ts'
import { messageImageLabels } from './chat/attachment/image-labels.ts'
import chatCss from './chat/ChatView.module.css'
import css from './timeline.module.css'

/** sessions 服务未安装时的空订阅（useSyncExternalStore subscribe 侧）。 */
const NOOP_SUBSCRIBE = (): (() => void) => () => undefined

/** workspaces 服务的最小注入面（`openPath` 为主；runtime WorkspaceRuntime 结构满足）。 */
export interface StepChatWorkspacesLike {
  openPath(path: string): Promise<void>
}

// ── 模块级 sessions/workspaces 持有（apply() 注入，卸载清除） ──────────────

let sessionsService: ISessions | undefined
let workspacesService: StepChatWorkspacesLike | undefined

/**
 * 安装 sessions 服务到模块级单例（插件 apply 时经 ctx.effect 调用）。
 * @param sessions - `ctx.sessions`（ISessions 公开面）。
 * @returns disposer：插件卸载时清除（避免残留引用串台）。
 */
export function installStepChatSessions(sessions: ISessions): () => void {
  sessionsService = sessions
  return () => {
    if (sessionsService === sessions) sessionsService = undefined
  }
}

/**
 * 安装 workspaces 服务到模块级单例（插件 apply 时经 ctx.effect 调用；文件路径打开用）。
 * @param workspaces - `ctx.workspaces`（openPath 面）。
 * @returns disposer：插件卸载时清除。
 */
export function installStepChatWorkspaces(workspaces: StepChatWorkspacesLike): () => void {
  workspacesService = workspaces
  return () => {
    if (workspacesService === workspaces) workspacesService = undefined
  }
}

/** 读取 sessions 服务（未安装返回 undefined，面板渲染降级占位）。 */
function getStepChatSessions(): ISessions | undefined {
  return sessionsService
}

/** 读取 workspaces 服务（未安装返回 undefined，文件链接降级为纯文本）。 */
function getStepChatWorkspaces(): StepChatWorkspacesLike | undefined {
  return workspacesService
}

/** 会话绑定面（`sessions.binding` 返回；含开窗 cast 所需的 open）。 */
interface StepChatBindingLike {
  readonly session: SessionFace
}

/** 开窗：Session.open() 在具体类上（不在 ISession 接口面），cast 调用；失败静默。 */
function openSessionWindow(binding: StepChatBindingLike): void {
  const session = binding.session as unknown as { open(): Promise<void> }
  session.open().catch(() => {
    // 开窗失败走快照 openState='error'，面板降级占位；无需在此抛错。
  })
}

/** 面板内文件打开的错误对话框文案（与 ChatView 的 FileOpenErrorDialog 同族）。 */
function openFailureMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return message === '' ? fallback : message
}

/** ProducedFiles 打开会话工作区 `.`（与 ChatView 一致）。 */
function isFolderOpenPath(path: string): boolean {
  return path === '.'
}

/** 运行中 turn 的 turn/start 时间（TurnStatus 锚点；与 ChatView 一致）。 */
function runningTurnStartTime(timeline: ConversationTimelineSnapshot): number | null {
  let latest: number | null = null
  for (const turn of timeline.turns.values()) {
    if (turn.status === 'open' && turn.start !== undefined) latest = turn.start.time
  }
  return latest
}

/** Turn 级模型活动标签（抄自 ChatView 的 TurnStatus：整轮运行期间不闪烁）。 */
function TurnStatus({ startTime, t }: {
  /** 运行中 turn 的 turn/start 时间；null 回退到挂载时间。 */
  startTime: number | null
  t: TranslateNS<'sandore'>
}) {
  const [mountedAt] = useState(() => Date.now())
  // Anchored to turn/start so a mid-turn reload keeps the real
  // elapsed time and the final footer's Ran-for label matches this clock.
  const anchor = startTime ?? mountedAt
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - anchor))
  useEffect(() => {
    const tick = (): void => {
      setElapsedMs(Math.max(0, Date.now() - anchor))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => { clearInterval(id) }
  }, [anchor])
  // Short turns keep the plain label; the clock only appears once the turn
  // has clearly been running for a while.
  const showClock = elapsedMs >= 15_000
  return (
    <div className={chatCss.turnStatus} role="status" aria-live="polite">
      Deep diving...
      {showClock && (
        <span className={chatCss.turnStatusClock} aria-hidden>
          {formatRunDuration(elapsedMs, t)}
        </span>
      )}
    </div>
  )
}

/**
 * 面板根：解析 binding（订阅会话列表——子代理会话可能晚于 step 出现，host 流推送
 * 进列表后 binding 才可解析），绑定可用后挂载 `StepChatBody`。
 *
 * Round 25：binding 缺失（子代理 settle/dispose 后 host 广播 `session-removed` →
 * client 列表移除该 child）时按退避序列有界重拉 host 会话列表（`sessions.refresh()`，
 * host 列表包含持久化冷会话，refresh 后 child 可重新绑定）；达上限后停在 loading
 * 占位，避免对已删除 child 空转。
 */
export function StepChatPanel({ sessionId, t }: {
  readonly sessionId: string
  readonly t: TranslateNS<'sandore'>
}) {
  const sessions = getStepChatSessions()

  // Round 25：binding 重解析纪元（refresh 完成后 +1 强制重渲染以重解析 binding）。
  const [rebindEpoch, setRebindEpoch] = useState(0)
  const rebindAttempt = useRef(0)

  // 订阅会话列表快照：binding 可用性由「列表包含 / 已 scoped」决定，列表变化时
  // 重解析 binding（子代理会话新建后由 host 流推送进列表）。
  useSyncExternalStore(
    sessions === undefined ? NOOP_SUBSCRIBE : sessions.list.subscribe,
    () => (sessions === undefined ? undefined : sessions.list.getSnapshot()),
  )

  const binding = sessions?.binding(sessionId as SessionId)

  // 挂载 / binding 变为可用时开窗：拉历史 + 消费 mux 帧，保证 cold 会话能出消息。
  useEffect(() => {
    if (binding === undefined) return
    openSessionWindow(binding)
  }, [binding])

  // Round 25：binding 缺失时按退避序列重拉 host 会话列表（有界）。成功恢复绑定或
  // 列表重新包含该 child 后计数清零；child 确已删除则停在 loading 占位。
  // 注：`sessions.refresh()` 在 client-runtime 公开面（ISessions）未导出（rc.6），
  // 但运行时具体类存在且幂等只读（仅重拉 session.list，不改变 history transport
  // 路由）；cast 调用，缺失时降级为等待列表自然变化。
  useEffect(() => {
    if (sessions === undefined) return
    if (binding !== undefined) {
      rebindAttempt.current = 0
      return
    }
    const delay = stepChatRebindDelayMs(rebindAttempt.current)
    if (delay === undefined) return
    rebindAttempt.current += 1
    const timer = setTimeout(() => {
      const refreshList = (sessions as unknown as { refresh?(): Promise<void> }).refresh
      if (refreshList === undefined) return // 公开面缺失：等待列表自然变化（host 推送）
      void refreshList.call(sessions as never)
        .then(() => { setRebindEpoch(value => value + 1) })
        .catch(() => {
          // 重拉失败：等待下一轮退避重试。
        })
    }, delay)
    return () => { clearTimeout(timer) }
  }, [sessions, sessionId, binding, rebindEpoch])

  if (binding === undefined) {
    return (
      <div className={css.stepChatPanel} data-step-chat>
        <div className={css.stepChatLoading}>{t('run.step.chat.loading')}</div>
      </div>
    )
  }

  return <StepChatBody session={binding.session} sessionId={sessionId} t={t} />
}

/** 单条展示行 → DSH 渲染组件（flowItem 包裹，key 稳定）。 */
function FlowRow({ row, t, renderMessageImages, cwd, onOpenFile, onFork }: {
  readonly row: StepChatFlowRow
  readonly t: TranslateNS<'sandore'>
  readonly renderMessageImages: SandoreRenderMessageImages
  readonly cwd: string | undefined
  readonly onOpenFile: (path: string) => void
  readonly onFork: (seq: number) => void
}): ReactNode {
  const body = ((): ReactNode => {
    switch (row.kind) {
      case 'user':
        // 用户/steering 消息 → 左侧行式（用户图标 + 标签 + 单行省略摘要，点击展开完整文本框）。
        return <UserMessageRow node={row.node} renderMessageImages={renderMessageImages} t={t} />
      case 'agent':
        return (
          <AssistantMarkdown
            blocks={row.blocks}
            streaming={row.streaming}
            interrupted={row.interrupted}
            renderMessageImages={renderMessageImages}
            t={t}
          />
        )
      case 'tool':
        return <GenericToolCard toolName={row.toolName} block={row.block} cwd={cwd} openFile={onOpenFile} t={t} />
      case 'command':
        return <GenericCommandCard node={row.node} t={t} />
      case 'context':
        return <ContextMessageNodeView node={row.node} t={t} />
      case 'compaction':
        return <CompactionNodeView node={row.node} t={t} />
      case 'retry':
        return <RetryNodeView node={row.node} t={t} />
      case 'turn-error':
        return <TurnErrorNodeView node={row.node} t={t} />
      case 'turn-max-tokens':
        return <TurnMaxTokensNodeView t={t} />
      case 'unknown':
        return <UnknownNodeView node={row.node} t={t} />
      case 'tail':
        return <TurnTailNodeView data={row.data} onBranch={onFork} t={t} />
    }
  })()
  return (
    <div className={chatCss.flowItem} data-chat-anchor-key={row.key} data-chat-flow-key={row.key}>
      {body}
    </div>
  )
}

/** 面板主体：订阅会话快照（ObservableSnapshot 的 uSES 两侧），渲染最新 10 条节点。 */
function StepChatBody({ session, sessionId, t }: {
  readonly session: SessionFace
  readonly sessionId: string
  readonly t: TranslateNS<'sandore'>
}) {
  // Session.subscribe/getSnapshot 是原型方法（依赖 this），须经箭头包装再交给
  // uSES（DSH 消费侧同样 `fn => session.subscribe(fn)`）。
  const snapshot = useSyncExternalStore(
    (onStoreChange) => session.subscribe(onStoreChange),
    () => session.getSnapshot(),
  )
  const rows = useMemo(() => buildStepChatFlow(snapshot), [snapshot])

  // Round 25：open 失败粘滞自愈——openState='error' 时有界退避重试 open()。
  // Session.open() 对 'error' 会重跑 doOpen（瞬时失败——短 turn 子代理
  // settle/dispose 过渡窗口——可自愈）；成功（'open'）后计数清零；达上限后停在
  // error 占位并展示 openError（便于现场锁定确切错误码）。
  const retryAttempt = useRef(0)
  useEffect(() => {
    if (snapshot.openState === 'open') {
      retryAttempt.current = 0
      return
    }
    if (snapshot.openState !== 'error') return
    const delay = stepChatRetryDelayMs(retryAttempt.current)
    if (delay === undefined) return // 已达重试上限：停在 error 占位（openError 可见）。
    retryAttempt.current += 1
    const timer = setTimeout(() => {
      const opener = session as unknown as { open(): Promise<void> }
      void opener.open().catch(() => {
        // 重试失败：openState 保持 error，退避序列在下次 error 触发时继续。
      })
    }, delay)
    return () => { clearTimeout(timer) }
  }, [snapshot.openState, session])

  const [fileOpenError, setFileOpenError] = useState<{ path: string; message: string } | null>(null)
  const [fileOpenBusy, setFileOpenBusy] = useState(false)
  const fileOpenRequest = useRef(0)
  const sessions = getStepChatSessions()

  // 会话 cwd（workspace root）：路径摘要相对其显示；与 ChatView 的
  // `useSessions(s => s.byId[sessionId]?.cwd)` 同源。
  const cwd = sessions?.list.getSnapshot().byId[sessionId as SessionId]?.cwd

  // 文件打开：解析 cwd 后经 workspaces.openPath 打开宿主默认应用；失败弹对话框。
  const requestOpenFile = useCallback((path: string) => {
    const id = ++fileOpenRequest.current
    setFileOpenBusy(true)
    const workspaces = getStepChatWorkspaces()
    if (workspaces === undefined) {
      setFileOpenError(null)
      setFileOpenBusy(false)
      return
    }
    const listCwd = sessions?.list.getSnapshot().byId[sessionId as SessionId]?.cwd
    void workspaces.openPath(resolveWorkspacePath(listCwd, path)).then(
      () => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError(null)
        setFileOpenBusy(false)
      },
      (error: unknown) => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError({
          path,
          message: openFailureMessage(
            error,
            t(isFolderOpenPath(path) ? 'fileOpen.folderUnknown' : 'fileOpen.unknown'),
          ),
        })
        setFileOpenBusy(false)
      },
    )
  }, [sessions, sessionId, t])

  const closeFileOpenError = useCallback(() => {
    fileOpenRequest.current += 1
    setFileOpenError(null)
  }, [])

  // 分支（fork）：以结算 seq 为锚 fork 会话并在列表中就绪后打开（与 DSH forkAt 同语义）。
  const forkAt = useCallback((seq: number) => {
    const sessionsService = getStepChatSessions()
    if (sessionsService === undefined) return
    sessionsService.fork({ sessionId: sessionId as SessionId, atSeq: seq, increaseTitle: true })
      .then((childId) => { sessionsService.open(childId) })
      .catch(() => {
        // Fork 或子会话重命名失败保持原会话视图不动（DSH 同）。
      })
  }, [sessionId])

  // 历史图片加载器：session.readAttachment → blob/data URL，卸载释放。
  const imageLoader = useMemo(() => createImageLoader(session), [session])
  useEffect(() => () => { imageLoader.dispose() }, [imageLoader])
  const renderMessageImages = useCallback<SandoreRenderMessageImages>(
    owner => (
      <ImageGallery
        images={owner.images as readonly { attachment: SandoreImageAttachmentRef }[]}
        load={imageLoader.load}
        align={owner.align}
        labels={messageImageLabels(t)}
      />
    ),
    [imageLoader, t],
  )

  if (snapshot.openState === 'cold' || snapshot.openState === 'loading') {
    return (
      <div className={css.stepChatPanel} data-step-chat>
        <div className={css.stepChatLoading}>{t('run.step.chat.loading')}</div>
      </div>
    )
  }
  if (snapshot.openState === 'error') {
    // Round 25：error 占位附带 openError（code/message），便于现场锁定确切错误码；
    // 有界退避重试进行中时此处维持占位，恢复后自动切回对话流。
    const detail = formatOpenError(snapshot.openError)
    return (
      <div className={css.stepChatPanel} data-step-chat>
        <div className={css.stepChatError}>{t('run.step.chat.error')}</div>
        {detail !== undefined && (
          <div className={css.stepChatErrorDetail} data-step-chat-error-detail>{detail}</div>
        )}
      </div>
    )
  }

  const runningTurnStart = runningTurnStartTime(snapshot.chat.timeline)

  return (
    <div className={css.stepChatPanel} data-step-chat>
      <div className={chatCss.column} data-chat-flow="">
        {rows.length === 0 && <div className={css.stepChatEmpty}>{t('run.step.chat.empty')}</div>}
        {rows.map((row) => (
          <FlowRow
            key={row.key}
            row={row}
            t={t}
            renderMessageImages={renderMessageImages}
            cwd={cwd}
            onOpenFile={requestOpenFile}
            onFork={forkAt}
          />
        ))}
        {/* Turn 级加载信号（与 ChatView 一致：整轮运行期间不闪烁）。 */}
        {snapshot.running && <TurnStatus startTime={runningTurnStart} t={t} />}
      </div>
      {fileOpenError !== null && (
        <FileOpenErrorDialog
          path={fileOpenError.path}
          message={fileOpenError.message}
          busy={fileOpenBusy}
          onClose={closeFileOpenError}
          onRetry={() => { requestOpenFile(fileOpenError.path) }}
          t={t}
        />
      )}
    </div>
  )
}

/** 宿主拒绝打开路径时的页内对话框（抄自 ChatView 的 FileOpenErrorDialog）。 */
function FileOpenErrorDialog({ path, message, busy, onClose, onRetry, t }: {
  path: string
  message: string
  busy: boolean
  onClose: () => void
  onRetry: () => void
  t: TranslateNS<'sandore'>
}) {
  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t('close')}
      title={t(isFolderOpenPath(path) ? 'fileOpen.folderTitle' : 'fileOpen.title')}
      description={message}
      footer={(
        <>
          <Button variant="outline" className={chatCss.modalAction} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" className={chatCss.modalAction} disabled={busy} onClick={onRetry}>{t('retry')}</Button>
        </>
      )}
    />
  )
}

/** 类型导出：turn-tail 数据（供 FlowRow 外部引用时使用）。 */
export type { StepChatTailData }
