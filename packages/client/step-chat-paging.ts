/**
 * step-chat-paging：StepChatPanel 的「更早历史分页」适配层（批 A）。
 *
 * 背景：面板此前只渲染会话加载窗（一页 50 条），真正的截断是 **DSH 会话加载窗**
 * （`session.getSnapshot().hasMore` + `session.loadOlder()` prepend 更早一页；
 * 见 `@deepseek-ai/dsh-client-runtime/client` 的 ConversationSnapshot/ISession），
 * 不是面板自己的裁剪——旧 `chat-flow.ts` 的「最新 10 条」限制已随清理消失。
 *
 * 本模块提供两件事（其余渲染/交互在 StepChatBody 内）：
 * 1. **分页读取面**（`stepChatPagingOf`）：从 `SessionFace.getSnapshot()` 结构读取
 *    `hasMore`/`loadingOlder`（两字段在 ConversationSnapshot 公开面上，运行时缺字段
 *    时保守取 false）——面板据此渲染 rc.1 ChatView 同款「加载更早」按钮；
 * 2. **prepend 保位**（`stepChatPrependAnchor`）：`loadOlder()` 把更早一页**前插**
 *    到列表头部，滚动容器的 scrollHeight 增长——不做补偿时读者视线被推走。
 *
 * prepend 保位实现（DSH ChatView 同款语义，见只读参考
 * `ui-chat/src/client/chat/ChatView.tsx` 的 PagingAnchor/anchorRef + prepend 分支）：
 * - 点击前记 anchor 行 key + 该行相对滚动视口 top（`anchorOf`）；
 * - prepend 落地后按 `scrollTop += flowTop(row) − anchor.top` 复原同一行到原位置。
 *
 * 面板另有**更便宜且等价**的一条路径：prepend 只发生在列表头部、且不改变尾部
 * 内容，故 `scrollHeight` 的增长量 == 头部新增内容的高度 == 需要补回的位移。
 * `stepChatPrependScrollTopOf` 即该语义的纯函数（`scrollTop + ΔscrollHeight`），
 * 面板按「加载前记 scrollHeight → prepend 落地后按 Δ 补位」落地，避免对
 * `[data-chat-anchor-key]` 做行级测量与跨帧锚点持有（面板行可能因进程折叠
 * `hidden="until-found"` 而不参与布局，行级锚点在折叠态下本身就不可靠）。
 *
 * 两代运行时差异：rc.6 公开面（本仓库锁定的 `dsh-client-runtime@0.1.1-rc.2`）
 * 的 `ISession` 只有 `loadOlder()`；rc.1 harness 源码另有 `loadThrough(seq)`
 * （按事件 seq 翻到指定位置，轮次轴未加载轮次跳转用）。面板保留
 * `loadThrough` 的**能力出口**（`StepChatSessionPaging.loadThrough`，方法缺失时
 * 静默 no-op），本批不接 UI——B4a 轮次轴的 unloaded 锚点分支后续接手。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-chat-paging
 */

// ── 分页读取面 ────────────────────────────────────────────────────────────────

/**
 * 分页状态读取面（`SessionFace.getSnapshot()` 的 ConversationSnapshot 结构探测；
 * 字段缺失/形状不符 → 保守 false，面板不渲染分页按钮）。
 */
export interface StepChatPagingState {
  /** 窗口之外仍存在更早历史（= rc.1 ChatView 的 hasMore，同时是进程折叠的守卫）。 */
  readonly hasMore: boolean
  /** 一次 loadOlder 正在飞行（按钮 disabled；rc.1 ChatView 同款）。 */
  readonly loadingOlder: boolean
}

/** 未分页常量（快照不可读/字段缺失时的稳定引用）。 */
export const STEP_CHAT_NO_PAGING: StepChatPagingState = { hasMore: false, loadingOlder: false }

/** 快照上的分页字段探测（只读叶子布尔；非布尔一律 false）。 */
export function stepChatPagingOf(snapshot: unknown): StepChatPagingState {
  if (typeof snapshot !== 'object' || snapshot === null) return STEP_CHAT_NO_PAGING
  const raw = snapshot as { hasMore?: unknown; loadingOlder?: unknown }
  const hasMore = raw.hasMore === true
  const loadingOlder = raw.loadingOlder === true
  if (!hasMore && !loadingOlder) return STEP_CHAT_NO_PAGING
  return { hasMore, loadingOlder }
}

// ── 分页行为面（loadOlder / loadThrough） ─────────────────────────────────────

/**
 * 会话实例的分页方法探测面。`loadOlder` 在 rc.6 公开面（ISession）内；`loadThrough`
 * 只在 rc.1 harness 运行时存在（本仓库类型面未导出）——一律结构探测 + cast，跨包
 * 不静态依赖实现类型（风格同 step-chat-source.ts）。
 */
export interface StepChatPagingSession {
  loadOlder?(): Promise<void>
  loadThrough?(seq: number): Promise<void>
}

/** 面板持有的分页能力（缺失的方法返回已 settle 的 no-op promise，调用方无需判空）。 */
export interface StepChatSessionPaging {
  /** 拉更早一页（prepend）。方法缺失/抛错 → 静默完成（失败落在快照 openState）。 */
  loadOlder(): Promise<void>
  /** 按事件 seq 翻到指定位置（轮次轴未加载轮次跳转预留；rc.6 运行时缺失 → no-op）。 */
  loadThrough(seq: number): Promise<void>
}

/**
 * 从会话实例装配分页能力（结构探测 + cast，参照 step-chat-source.ts 既有风格）。
 * 两方法皆缺失时仍返回对象：调用方（面板）不需要分支，行为退化为静默 no-op。
 * @param session - `binding.session`（SessionFace；内部转 StepChatPagingSession 探测）。
 * @returns 稳定的分页能力面（每次调用返回新对象，方法内部每次重读会话实例）。
 */
export function stepChatPagingOfSession(session: unknown): StepChatSessionPaging {
  const probe = session as StepChatPagingSession | undefined
  const noop = Promise.resolve()
  return {
    loadOlder: () => (typeof probe?.loadOlder === 'function'
      ? probe.loadOlder()
      : noop),
    loadThrough: (seq: number) => (typeof probe?.loadThrough === 'function'
      ? probe.loadThrough(seq)
      : noop),
  }
}

// ── prepend 保位（纯函数） ────────────────────────────────────────────────────

/**
 * 滚动视口的最小几何读取面（`HTMLElement` 结构满足；单测可用字面量）。
 * jsdom 的 scrollHeight 恒为 0（无排版），面板/单测可覆写属性值。
 */
export interface StepChatScrollMetrics {
  /** 内容总高（含不可见部分）。 */
  readonly scrollHeight: number
  /** 当前滚动偏移。 */
  readonly scrollTop: number
}

/**
 * prepend 保位：`loadOlder()` 前插更早内容后，把滚动偏移补回同一阅读位置。
 *
 * 语义（DSH ChatView 的 prepend 分支等价形式）：prepend 只在列表头部插入，
 * 尾部内容不动，故 `scrollHeight` 的增长量就是头部新增内容的高度，读者的
 * `scrollTop` 需要等量后移，视线才停在原来那一行。
 *
 * @param before - 点击「加载更早」之前量到的几何。
 * @param after - prepend 落地（DOM 已提交）之后量到的几何。
 * @returns 补偿后的 scrollTop（ΔscrollHeight ≤ 0 → 原值，绝不倒退）。
 */
export function stepChatPrependScrollTopOf(
  before: StepChatScrollMetrics,
  after: StepChatScrollMetrics,
): number {
  return before.scrollTop + stepChatPrependDeltaOf(before, after)
}

/**
 * 补偿量（ΔscrollHeight；负数/NaN 归 0）——面板在请求发出前记录 `scrollHeight`，
 * 落地后由 `stepChatPrependScrollTopOf` 消费；同时暴露给单测断言「保位载荷正确」。
 * @param before - prepend 前的几何。
 * @param after - prepend 后的几何。
 * @returns 需要补回的像素数（无增长 → 0）。
 */
export function stepChatPrependDeltaOf(
  before: StepChatScrollMetrics,
  after: StepChatScrollMetrics,
): number {
  const delta = after.scrollHeight - before.scrollHeight
  return Number.isFinite(delta) && delta > 0 ? delta : 0
}
