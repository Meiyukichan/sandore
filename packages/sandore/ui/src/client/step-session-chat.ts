/**
 * StepSessionChat 的可测纯逻辑（无 React / 无 DSH harness 源码依赖，vitest node 环境可跑）。
 *
 * 职责：把「内嵌子代理会话页」所需的粘合动作抽成纯函数——开窗（触发拉历史 +
 * 消费 mux 帧）、最小 chat store（selection 读写面）、逐会话滚动记忆、工作区
 * 相对路径解析、fork 跳转。`StepSessionChat.tsx` 只做 React 装配，本模块负责逻辑。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-session-chat
 */
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  CallId, ChatStoreState, SelectionTarget,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** 滚动记忆位置（rc.6 client 面未再导出 `ChatScrollPosition`，按结构对齐其契约）。 */
export interface ChatScrollPositionLike {
  /** 稳定渲染节点/调用标识（翻页锚点）。 */
  readonly anchorKey: string
  /** 锚点相对滚动视口的 top（保存时）。 */
  readonly anchorTop: number
  /** 近似偏移（语义锚点未测量前使用）。 */
  readonly scrollTop: number
}

/** 会话面最小契约（SessionFace 的 open 不在接口面，需收窄 cast；loadOlder 公开）。 */
export interface StepChatSessionLike {
  /** 会话 id（身份轴）。 */
  readonly sessionId: SessionId
  /** 首开：拉尾页历史（幂等；具体类公开方法，接口面缺失）。 */
  open?(): Promise<void>
  /** 向前翻页（接口面公开）。 */
  loadOlder?(): Promise<void>
}

/**
 * 打开子代理会话（触发拉历史 + 消费 mux 帧）。
 *
 * `Session.open()` 只存在于具体类（`sessions/session.ts`），不在 `SessionFace`
 * 接口面——这里经可选方法收窄 cast，失败静默（开窗是尽力而为：历史窗口打不开
 * 只影响流式渲染，不影响时间线其余部分）。
 * @param session - 会话面（SessionBinding.session）。
 */
export function openSubagentSession(session: StepChatSessionLike): void {
  const opener = (session as { open?: () => Promise<void> }).open
  if (opener === undefined) return
  opener.call(session).catch(() => {
    // 开窗失败静默：openState 会落到 error，ChatView 自绘错误提示。
  })
}

/** 最小 chat store 的读写面（对齐 `PropsStore<ChatStore>` 的 useStore/actions 契约）。 */
export interface ChatStoreLike {
  /** 取当前快照（uSES getSnapshot 侧）。 */
  getSnapshot(): ChatStoreState
  /** 订阅变更（uSES subscribe 侧）。 */
  subscribe(fn: () => void): () => void
  /** draft-stripped 动作面（ChatView 经 `actions` 收 selection 写入）。 */
  actions: {
    select(target: SelectionTarget | null): void
    setDraft(text: string): void
    setView(view: string | null): void
    setInspect(target: { callId: CallId } | null): void
  }
}

/** 手写最小 chat store（不依赖 DSH `defineStore`——其运行时只存在于 bundle 内部）。 */
export function createChatStoreLike(): ChatStoreLike {
  let state: ChatStoreState = { selection: null, draft: '', view: null, inspect: null }
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const fn of [...listeners]) fn()
  }
  return {
    getSnapshot: () => state,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    actions: {
      select: (target) => { state = { ...state, selection: target }; notify() },
      setDraft: (text) => { state = { ...state, draft: text }; notify() },
      setView: (view) => { state = { ...state, view }; notify() },
      setInspect: (target) => { state = { ...state, inspect: target }; notify() },
    },
  }
}

/** 逐会话滚动记忆（ChatViewInjected.chatScroll 的最小实现；内存态，不持久化）。 */
export interface ChatScrollMemory {
  /** 记录读者位置；null 表示钉在底部（清除）。 */
  save(position: ChatScrollPositionLike | null): void
  /** 上次读者位置；null = 钉底或从未记录。 */
  read(): ChatScrollPositionLike | null
}

/** 建一个滚动记忆（组件按会话 id 各持一个实例，天然隔离）。 */
export function createChatScrollMemory(): ChatScrollMemory {
  let position: ChatScrollPositionLike | null = null
  return {
    save: (next) => { position = next },
    read: () => position,
  }
}

/**
 * 把工作区相对路径解析为 Host 可打开的绝对路径（对齐 DSH `resolveWorkspacePath`）。
 * 绝对路径 / Windows 盘符 / UNC 原样返回；无工作区根时原样返回。
 * @param cwd - 会话工作区根（可能缺省）。
 * @param path - 绝对或工作区相对路径。
 * @returns 可交给 `workspaces.openPath` 的路径。
 */
export function resolveWorkspacePath(cwd: string | undefined, path: string): string {
  if (path.startsWith('/') || isWindowsStylePath(path)) return path
  if (cwd === undefined || cwd === '') return path
  const base = cwd.replace(/[/\\]+$/, '')
  const rel = path.replace(/^[/\\]+/, '')
  return `${base}/${rel}`
}

/** 盘符（`C:\`）或 UNC（`\\`）路径：不按相对路径拼接。 */
function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\')
}

/** fork 跳转所需的最小 sessions 面（ISessions 的 fork/open 子集）。 */
export interface StepChatSessionsForkLike {
  fork(opts: { sessionId: SessionId; atSeq?: number; increaseTitle?: boolean }): Promise<SessionId>
  open(id: SessionId): void
}

/**
 * 从完成 turn 的 `seq` fork 出子会话并打开（ChatViewInjected.forkAt）。
 * fork 或子会话打开失败静默（保留源会话视图不动）。
 * @param sessions - sessions 服务最小面。
 * @param sessionId - 源会话 id。
 * @param seq - 锚定 cut 的事件 seq。
 */
export function forkSessionAt(
  sessions: StepChatSessionsForkLike,
  sessionId: SessionId,
  seq: number,
): void {
  sessions.fork({ sessionId, atSeq: seq, increaseTitle: true })
    .then((childId) => { sessions.open(childId) })
    .catch(() => {
      // fork 或子会话标题重命名失败：源会话视图保持不动。
    })
}
