/**
 * StepSessionChat：在 sandore 执行详情时间线里，直接内嵌 DSH 子代理会话对话页。
 *
 * 复用 DSH 渲染栈（不重新实现消息渲染）：
 * - `ChatView`（`@deepseek-ai/dsh-client-ui-conversation` 源码，tsdown 构建期经
 *   `dshSourceAlias` 指向 deepseek-harness 工作区源码内联；类型面经
 *   `dsh-chat-shim.d.ts` ambient 垫片指向 registry 包 `./client` 的
 *   `ChatViewSlotProps`）
 * - `observableHook`（`@deepseek-ai/dsh-client-ui-renderer` 源码，同上）
 * - `sessions.binding(id).session` 的 `ObservableSnapshot` 订阅面（开窗 cast 见
 *   `step-session-chat.ts`）
 *
 * 手写最小面：chat store（selection 读写）、keyed renderSlot 派发（对齐 DSH
 * renderer 的 single/keyed/list/chain 语义 + spec 级 inject hooks 绑定）、滚动容器。
 * 挂载/切换会话时开窗触发拉历史；step 完成/失败卸载即回收订阅（uSES 自动清理）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/StepSessionChat
 */
import {
  Component, useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode,
} from 'react'
import type { Translate, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ConversationSnapshot, SessionFace, SessionId, SessionListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  CallId, ChatStoreState, ChatViewSlotProps, SelectionTarget,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ChatView } from '@deepseek-ai/dsh-client-ui-conversation/src/client/chat/ChatView'
import { observableHook } from '@deepseek-ai/dsh-client-ui-renderer/src/client/session-provider'

import {
  createChatScrollMemory, createChatStoreLike, forkSessionAt, openSubagentSession,
  resolveWorkspacePath,
} from './step-session-chat.ts'
import { getStepChatHost, type StepChatHost } from './step-session-chat-host.ts'
import css from './timeline.module.css'

/** renderSlot 派发选项（对齐 DSH `RenderOpts` 的最小面）。 */
interface RenderOptsLike {
  entryKey?: string | undefined
  only?: string | undefined
  fallback?: ReactNode
  hookContext?: unknown
}

/** 注册条目最小面（对齐 DSH `StoredEntry` 的渲染读面）。 */
interface SlotEntryLike {
  component: unknown
  options: { key?: string | undefined; id?: string | undefined; order?: number | undefined }
  inject?: ((...args: never[]) => Record<string, unknown>) | undefined
  select?: ((owner: never) => unknown) | undefined
}

/** 每个 slot 条目收到的标准 kit（对齐 DSH renderer 的 standard kit 最小面）。 */
interface ChatKit {
  useSession: (selector: (snapshot: ConversationSnapshot) => unknown) => unknown
  useSessions: (selector: (snapshot: SessionListState) => unknown) => unknown
  useStore: (selector: (snapshot: ChatStoreState) => unknown) => unknown
  sessionId: SessionId
  t: Translate
  useProjection: (key: string, selector?: (value: unknown) => unknown) => unknown
  renderSlot: (key: string, owner: object, opts?: RenderOptsLike) => ReactNode
}

/** 条目级 error boundary：单个渲染器崩溃只黑掉该行，不拖垮整条时间线。 */
class SlotEntryBoundary extends Component<{ slotKey: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    console.error(`[sandore] step-session-chat slot entry crashed in '${this.props.slotKey}':`, error)
  }

  override render(): ReactNode {
    if (this.state.failed) return <div data-slot-error={this.props.slotKey} />
    return this.props.children
  }
}

/**
 * 绑定 spec 级 inject hooks 隔间（对齐 DSH renderer 的 `cachedSlotInject`）：
 * `hooks` 下函数值 = 工厂（收 standard kit + hookContext，返回真正 Hook）；
 * 可观测值 = `use<Name>` selector 钩子（observableHook 绑定）。
 */
function bindSpecInjectHooks(
  specInject: object | undefined,
  kit: ChatKit,
  hookContext: unknown,
): Record<string, unknown> {
  const hooks = (specInject as { hooks?: Record<string, unknown> } | undefined)?.hooks
  if (hooks === undefined) return {}
  const bound: Record<string, unknown> = {}
  for (const [name, definition] of Object.entries(hooks)) {
    const hookName = `use${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`
    if (typeof definition === 'function') {
      bound[hookName] = (definition as (standard: object, ctx: unknown) => unknown)(kit, hookContext)
    } else {
      bound[hookName] = observableHook(definition as { getSnapshot(): unknown; subscribe(fn: () => void): () => void })
    }
  }
  return bound
}

/** 渲染一个 slot 条目：kit + 条目 inject + spec 级 hooks + owner 货币。 */
function EntryView({ host, kit, slotKey, entry, owner, hookContext }: {
  host: StepChatHost
  kit: ChatKit
  slotKey: string
  entry: SlotEntryLike
  owner: object
  hookContext: unknown
}) {
  const spec = host.slots.spec(slotKey)
  const injected = useMemo(() => {
    const face: Record<string, unknown> = {}
    try {
      const entryInject = entry.inject as ((...args: unknown[]) => Record<string, unknown>) | undefined
      const entryFace = entryInject?.(kit.sessionId)
      if (entryFace !== undefined) Object.assign(face, entryFace)
    } catch {
      // 条目级 inject 失败：仅丢该条目的 face，其余照常渲染。
    }
    Object.assign(face, bindSpecInjectHooks(spec?.inject, kit, hookContext))
    return face
    // kit/spec/hookContext 身份稳定：条目与发生点不变时结果可复用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, spec, kit, hookContext])

  const Comp = entry.component as unknown as (props: object) => ReactNode
  return (
    <SlotEntryBoundary slotKey={slotKey}>
      <Comp {...kit} {...injected} {...owner} />
    </SlotEntryBoundary>
  )
}

/** 一个 slot 渲染点：按声明规格派发（keyed/single/list/chain），未注册回退 fallback。 */
function SlotOutlet({ host, kit, slotKey, ownerProps, opts }: {
  host: StepChatHost
  kit: ChatKit
  slotKey: string
  ownerProps: object
  opts?: RenderOptsLike | undefined
}) {
  // 注册变更（microtask 批处理）驱动 entriesOfSlot 重读。
  useSyncExternalStore(
    useCallback((fn: () => void) => host.slots.subscribe(slotKey, fn), [host, slotKey]),
    useCallback(() => host.slots.getVersion(slotKey), [host, slotKey]),
  )
  const spec = host.slots.spec(slotKey)
  if (spec === undefined) return <>{opts?.fallback ?? null}</>

  if (spec.kind === 'chain') {
    // 选举：按优先级依次跑 select，首个非 null 命中的条目接管；全弃权回退。
    const entries = host.slots.entries(slotKey) as readonly SlotEntryLike[]
    for (const entry of entries) {
      let matched: unknown
      try {
        matched = entry.select?.(ownerProps as never)
      } catch {
        continue // 选择器抛错视为弃权（对齐 DSH chain 语义）。
      }
      if (matched !== null) {
        return (
          <EntryView
            host={host} kit={kit} slotKey={slotKey} entry={entry}
            owner={{ ...ownerProps, matched }} hookContext={opts?.hookContext}
          />
        )
      }
    }
    return <>{opts?.fallback ?? null}</>
  }

  const winners = host.slots.entriesOfSlot(slotKey) as readonly SlotEntryLike[]
  if (spec.kind === 'keyed') {
    const entry = winners.find(candidate => candidate.options.key === opts?.entryKey)
    if (entry === undefined) return <>{opts?.fallback ?? null}</>
    return <EntryView host={host} kit={kit} slotKey={slotKey} entry={entry} owner={ownerProps} hookContext={opts?.hookContext} />
  }
  if (spec.kind === 'single') {
    const entry = winners[0]
    if (entry === undefined) return <>{opts?.fallback ?? null}</>
    return <EntryView host={host} kit={kit} slotKey={slotKey} entry={entry} owner={ownerProps} hookContext={opts?.hookContext} />
  }
  // list：按 order 升序，`only` 过滤。
  let rows = [...winners].sort((a, b) => (a.options.order ?? 0) - (b.options.order ?? 0))
  if (opts?.only !== undefined) rows = rows.filter(row => row.options.id === opts.only)
  if (rows.length === 0) return <>{opts?.fallback ?? null}</>
  return (
    <>
      {rows.map((row, index) => (
        <EntryView
          key={row.options.id ?? index} host={host} kit={kit} slotKey={slotKey}
          entry={row} owner={ownerProps} hookContext={opts?.hookContext}
        />
      ))}
    </>
  )
}

/** 内嵌会话聊天页（binding 已解析；所有 hooks 在此层稳定）。 */
function SessionChatView({ host, sessionId, session }: {
  host: StepChatHost
  sessionId: SessionId
  session: SessionFace
}) {
  // 最小 chat store + 滚动记忆按会话隔离（会话切换即重建）。
  const store = useMemo(() => createChatStoreLike(), [sessionId])
  const scrollMemory = useMemo(() => createChatScrollMemory(), [sessionId])

  // 标准钩子：observableHook 按源身份缓存，源稳定 → 钩子稳定，无重订阅抖动。
  const useSession = useMemo(() => observableHook(session), [session])
  const useSessions = useMemo(() => observableHook(host.sessions.list), [host])
  const useStore = useMemo(() => observableHook(store), [store])
  // conversation 命名空间 t（bind 读当前 locale，切换语言时经修订号订阅重渲染）。
  const t = useMemo(() => host.bindLocale('conversation'), [host])
  useSyncExternalStore(
    useCallback((fn: () => void) => host.locale.subscribe(fn), [host]),
    useCallback(() => host.locale.getSnapshot().revision, [host]),
  )

  // renderSlot 自引用 kit：SlotOutlet 递归派发时共享同一套标准钩子。
  const kitRef = useRef<ChatKit | null>(null)
  const kit = useMemo<ChatKit>(() => {
    const self: ChatKit = {
      useSession: useSession as (selector: (snapshot: ConversationSnapshot) => unknown) => unknown,
      useSessions: useSessions as (selector: (snapshot: SessionListState) => unknown) => unknown,
      useStore: useStore as (selector: (snapshot: ChatStoreState) => unknown) => unknown,
      sessionId,
      t,
      // 本插件无 projection 提供者：一律读 absent（undefined），能力缺失。
      useProjection: (_key, selector) => (selector === undefined ? undefined : selector(undefined)),
      renderSlot: (key, owner, opts) => {
        const selfKit = kitRef.current ?? self
        return <SlotOutlet host={host} kit={selfKit} slotKey={key} ownerProps={owner} opts={opts} />
      },
    }
    return self
  }, [useSession, useSessions, useStore, sessionId, t, host])
  useEffect(() => { kitRef.current = kit })

  // ChatViewInjected：openFile 走 Host 打开路径（相对路径按会话 cwd 解析）；
  // loadOlder/forkAt 走会话面与 sessions 服务；openDetails/inspectCall 落本地
  // chat store（details 面板几何不在 overlay 内，仅保留选择联动）。
  const openFile = useCallback((path: string): Promise<void> => {
    const cwd = host.sessions.list.getSnapshot().byId[sessionId]?.cwd
    return host.workspaces.openPath(resolveWorkspacePath(cwd, path))
  }, [host, sessionId])
  const loadOlder = useCallback(() => { void session.loadOlder() }, [session])
  const loadImage = useCallback(async () => {
    throw new Error('sandore：时间线内嵌会话未接入附件图片加载（conversation.message.images 槽未占用）')
  }, [])
  const openDetails = useCallback((target: SelectionTarget) => { store.actions.select(target) }, [store])
  const inspectCall = useCallback((callId: CallId) => { store.actions.setInspect({ callId }) }, [store])
  const forkAt = useCallback((seq: number) => { forkSessionAt(host.sessions, sessionId, seq) }, [host, sessionId])
  const fileMentions = useCallback(() => undefined, [])

  const chatProps: ChatViewSlotProps = {
    sessionId,
    useSession,
    useSessions,
    useStore,
    renderSlot: kit.renderSlot,
    t,
    openDetails,
    openFile,
    loadOlder,
    loadImage,
    inspectCall,
    chatScroll: scrollMemory,
    forkAt,
    fileMentions,
    actions: store.actions,
    // rc.6 SessionStandardProps 的框架座（ChatView 不消费，填空实现）：
    // useProjection 本插件无投影源（读 absent）；useInput/inputActions 是输入机
    // 状态面，时间线内嵌页不提供输入，给恒 undefined 占位；useWorkspaces 同理；
    // SessionProvider 是框架自接线座，ChatView 直接渲染节点不经过它。
    useProjection: kit.useProjection,
    useInput: ((_selector: unknown, _equal?: unknown) => undefined) as never,
    inputActions: {} as never,
    useWorkspaces: ((_selector: unknown, _equal?: unknown) => undefined) as never,
    SessionProvider: ((_props: unknown) => null) as never,
  }

  // 外层可滚动容器带 `[data-conversation-scroll]`：ChatView 自动识别外部滚动宿主，
  // 自己不做 overflow（对齐主会话列行为；底部跟随/翻页锚点都落在本容器上）。
  return (
    <div className={css.stepSessionChat} data-conversation-scroll="">
      <ChatView {...chatProps} />
    </div>
  )
}

/**
 * 内嵌 DSH 子代理会话对话页（运行中 step 详情区）。
 * @param props.sessionId - 子代理真实会话 id（TimelineStepItem.childId）。
 * @param props.t - sandore 命名空间翻译（降级文案用；缺省回退硬编码文本）。
 */
export function StepSessionChat({ sessionId, t }: {
  sessionId: string
  t?: TranslateNS<'sandore'> | undefined
}) {
  const host = getStepChatHost()
  const binding = host?.sessions.binding(sessionId as SessionId)
  const session = binding?.session

  // 开窗：挂载 / sessionId 变化时触发拉历史 + 消费 mux 帧（幂等，失败静默）。
  useEffect(() => {
    if (session === undefined) return
    openSubagentSession(session)
  }, [session])

  if (host === undefined || session === undefined) {
    // 宿主未装（apply 前）/会话不在列表：降级为纯文本占位，不崩时间线。
    return (
      <div className={css.stepSessionChatEmpty} data-step-session-chat-empty>
        {t !== undefined ? t('run.step.chat.unavailable') : '子代理会话不可用'}
      </div>
    )
  }
  return <SessionChatView host={host} sessionId={sessionId as SessionId} session={session} />
}
