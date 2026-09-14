/**
 * turn-rail（B4a）：右侧轮次轴（TurnNavigator）的「纯数据 + 容器 DOM」辅助层。
 *
 * 只读参考（deepseek-harness，勿改 DSH 源码）：ui-chat `chat/turn-rail-items.ts`
 * （mergeTurnRailItems）与 `chat/ChatView.tsx` 的「滚动采样（syncActiveTurn /
 * turnAtLine）+ landOnRow」。
 *
 * 数据面裁剪（面板无 outline/分页）：
 * - rc.1 的 mergeTurnRailItems 把 host `turnOutline` 投影并入 loaded 窗（unloaded
 *   锚点要先 loadThrough 把历史翻进窗口）；面板的 view 面只有当前 loaded 窗
 *   （ChatSnapshot.navigation.items()：per turn { turn, anchorKey, prompt≤50,
 *   response≤120 }，见 step-chat-source.ts / turn-navigation.ts），无 outline
 *   投影、无 loadOlder/loadThrough —— B4a 只产出 loaded 锚点
 *   （anchor: { kind:'loaded', key }），unloaded 分支整体剪裁并注释于此。
 * - 每条 mark 顺带 best-effort `runMs`（timeline turns map 的 start/end 差；
 *   缺边界/形状不符 → undefined）：当前仅作 rail 数据保留，不渲染（rc.1 预览卡
 *   只有 prompt/response 两行）；B4b+ 需要轮次读数时直接消费。
 *
 * 采样/定位（移植 rc.1 ChatView 的「采样/定位」，实现改为面板容器内实现——
 * 容器即滚动视口 .stepChatScroll，scrollTop/scrollTo 全部作用其上；行可能带
 * hidden="until-found"，用 querySelector 按 data-chat-anchor-key 精确取值）：
 * - activeTurn 判定 = rc.1 syncActiveTurn 语义：滚动视口近底部 → 最新 turn；
 *   否则按「阅读线」（视口顶 + min(96, clientHeight×0.2)）下的行取 turn
 *   （elementsFromPoint 命中 [data-chat-turn]，布局未就绪/jsdom 回退按行 top
 *   顺序扫描），再取「≤ 该 turn 的最新 rail offer」（行 turn 可能比 offer 密）。
 * - 定位 = rc.1 landOnRow：scrollTop += flowTop(row) − 24（flowTop = 行 top 相对
 *   滚动视口 top）。锚点行 hidden 时的回退策略见 StepChatPanel.tsx（B4a 注释）：
 *   先按 key 找可见行，失败再按同 turn 找第一可见行，仍未命中则放弃。
 *
 * DOM 读取集中在 *Of/In/To 的薄包装里，判定/换算全部下沉为纯函数（可单测），
 * 不携带任何引擎引用。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/turn-rail
 */

// ── 常量（几何/时间预算；rc.1 同值） ─────────────────────────────────────────

/** 采样节流间隔（rc.1 SCROLL_SAMPLE_INTERVAL_MS=500：滚动事件只登记，超时后采样一次）。 */
export const STEP_CHAT_SAMPLE_INTERVAL_MS = 500

/** 定位补偿：目标行 top 与滚动视口顶的距离（rc.1 landOnRow 的 −24）。 */
export const STEP_CHAT_LANDING_CLEARANCE_PX = 24

/** 「贴底」判定阈值（rc.1 FOLLOW_THRESHOLD=24；比较式为 ≤ threshold + 1）。 */
export const STEP_CHAT_FOLLOW_THRESHOLD_PX = 24

/** 阅读线距视口顶的最大/比例预算（rc.1 syncActiveTurn 的 min(96, h×0.2)）。 */
const STEP_CHAT_READING_LINE_OFFSET_PX = 96
const STEP_CHAT_READING_LINE_FRACTION = 0.2

// ── 类型与空常量 ──────────────────────────────────────────────────────────────

/**
 * 面板的轮次轴条目（loaded-only；rc.1 TurnRailItem 的 unloaded 锚点分支被剪裁）。
 * 升序按 turn；同 turn 去重（引擎不产重复，防御性保留）。
 */
export interface StepChatTurnRailItem {
  /** 条目地址的轮次号。 */
  readonly turn: number
  /** 该轮用户提问的限长预览（引擎已按 ≤50 预算截断）；可为空串。 */
  readonly prompt: string
  /** 该轮答复的限长预览（引擎已按 ≤120 预算截断）；空串 = 无答复文本。 */
  readonly response: string
  /** 可达方式：loaded 锚点 = 窗口内可见行（按行壳 data-chat-anchor-key 定位）。 */
  readonly anchor: { readonly kind: 'loaded'; readonly key: string }
  /** 该轮壁钟时长（timeline turns map 的 start/end 差；边界缺失 → undefined）。 */
  readonly runMs?: number | undefined
}

/** 空轴常量（未就绪/过滤后无条目的稳定引用）。 */
export const STEP_CHAT_EMPTY_RAIL_ITEMS: readonly StepChatTurnRailItem[] = []

/** 阅读线扫描的输入行（DOM 顺序即视觉顺序，top 升序）。 */
export interface StepChatReadingEntry {
  /** 行 top（滚动视口坐标系）。 */
  readonly top: number
  /** 行壳 data-chat-turn 的轮次号（已整数化）。 */
  readonly turn: number
}

// ── 守卫 ──────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 轮次号守卫：非负安全整数（对齐 rc.1 loaded 条目的 turn 预算）。 */
function isTurnNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

// ── 数据：navigation.items()（unknown）→ 面板 loaded rail items ────────────────

/**
 * 单条 loaded 导航项的最小叶子（对齐 rc.1 TurnNavigationItem 形状）。
 * 关键叶子缺失（turn/anchorKey）→ 整条丢弃（一个刻度没有它们就无法存在/跳转）；
 * 预览是装饰性的，形状不符降级为空串（轮次仍可按编号跳转）——语义照抄
 * rc.1 outlineEntry 的「损坏丢弃/装饰降级」分界，只是锚点必须为 loaded key。
 */
function stepChatTurnNavigationLeaf(raw: unknown): {
  readonly turn: number
  readonly anchorKey: string
  readonly prompt: string
  readonly response: string
} | undefined {
  if (!isRecord(raw)) return undefined
  if (!isTurnNumber(raw.turn)) return undefined
  const anchorKey = raw.anchorKey
  if (typeof anchorKey !== 'string' || anchorKey === '') return undefined
  return {
    turn: raw.turn,
    anchorKey,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    response: typeof raw.response === 'string' ? raw.response : '',
  }
}

/**
 * 该轮壁钟时长（timeline.turns 的 start/end 差；rc.1 turn-tail 的
 * stepChatTailRunMsOf 同源读取，终点改用 location.end 而非 tail 自身 time）。
 * @param timeline - 原始 ChatSnapshot.timeline（unknown 结构探测）。
 * @param turn - 轮次号。
 * @returns 壁钟时长 ms；缺 start/end 边界或形状不符 → undefined。
 */
export function stepChatTurnRunMsOf(timeline: unknown, turn: number): number | undefined {
  if (!isRecord(timeline) || !isRecord(timeline.turns)) return undefined
  const get = (timeline.turns as unknown as { get?(key: number): unknown }).get
  if (typeof get !== 'function') return undefined
  let entry: unknown
  try {
    entry = get.call(timeline.turns as never, turn)
  } catch {
    return undefined
  }
  if (!isRecord(entry)) return undefined
  const start = isRecord(entry.start) ? entry.start.time : undefined
  const end = isRecord(entry.end) ? entry.end.time : undefined
  if (typeof start !== 'number' || typeof end !== 'number') return undefined
  const runMs = end - start
  return runMs > 0 ? runMs : undefined
}

/**
 * 组面板 rail items：navigation.items() raw 列表 → loaded TurnRailItem[]。
 * 过滤不可达 turn（leaf 断言失败）、按 turn 去重（后到覆盖）并按 turn 升序
 * （rc.1 merge 的 byTurn+sort 语义；unloaded/outline 半边不参与）。
 * @param rawItems - feed.navigationItems() 的返回（unknown[]；非数组 → 空轴）。
 * @param timeline - 原始 timeline（可选；供 runMs best-effort 读取）。
 * @returns 升序 items；空/全过滤 → 稳定空常量。
 */
export function stepChatRailItemsOf(
  rawItems: readonly unknown[],
  timeline?: unknown,
): readonly StepChatTurnRailItem[] {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return STEP_CHAT_EMPTY_RAIL_ITEMS
  const byTurn = new Map<number, StepChatTurnRailItem>()
  for (const raw of rawItems) {
    const leaf = stepChatTurnNavigationLeaf(raw)
    if (leaf === undefined) continue
    const runMs = stepChatTurnRunMsOf(timeline, leaf.turn)
    byTurn.set(leaf.turn, {
      turn: leaf.turn,
      prompt: leaf.prompt,
      response: leaf.response,
      anchor: { kind: 'loaded', key: leaf.anchorKey },
      ...(runMs === undefined ? {} : { runMs }),
    })
  }
  if (byTurn.size === 0) return STEP_CHAT_EMPTY_RAIL_ITEMS
  return [...byTurn.values()].sort((left, right) => left.turn - right.turn)
}

/**
 * 两条 items 列表是否载相同 rail 状态（rc.1 sameTurnNavigationItem 的列表级
 * 版本）：StepChatBody 用它做恒等缓存——发布间内容未变时复用旧数组引用，memo 的
 * TurnNavigator 不会在流式帧上重建刻度 DOM。
 */
export function stepChatSameRailItems(
  left: readonly StepChatTurnRailItem[],
  right: readonly StepChatTurnRailItem[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    const a = left[i]
    const b = right[i]
    if (a === undefined || b === undefined) return false
    if (a.turn !== b.turn || a.prompt !== b.prompt || a.response !== b.response) return false
    if (a.anchor.kind !== 'loaded' || b.anchor.kind !== 'loaded') return false
    if (a.anchor.kind === 'loaded' && b.anchor.kind === 'loaded' && a.anchor.key !== b.anchor.key) return false
    if (a.runMs !== b.runMs) return false
  }
  return true
}

// ── 纯判定（rc.1 syncActiveTurn 拆出的纯函数） ────────────────────────────────

/**
 * active 轮次判定（rc.1 syncActiveTurn 的「非贴底」分支）：
 * - reading 为 null（没有行覆盖阅读线）→ 轴首项（流头占有刻度）；
 * - 否则从首项起取「≤ reading 的最新 offer」——阅读行所在轮次可能不是轴 offer
 *   （整轮行都折叠等），此时回退到其上方最近的 offer。
 * @param items - 升序 rail items（空 → null）。
 * @param reading - 阅读线下行所属轮次（null = 无线/未布局）。
 * @returns active 轮次。
 */
export function stepChatActiveTurnOf(
  items: readonly StepChatTurnRailItem[],
  reading: number | null,
): number | null {
  const first = items[0]
  if (first === undefined) return null
  if (reading === null) return first.turn
  let next = first.turn
  for (const item of items) {
    if (item.turn > reading) break
    next = item.turn
  }
  return next
}

/** 近底部度量（纯；rc.1 的 scrollHeight − scrollTop − clientHeight ≤ threshold + 1）。 */
export function stepChatNearBottomMetricsOf(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = STEP_CHAT_FOLLOW_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold + 1
}

/** 阅读线距滚动视口顶的偏移（纯；rc.1 的 min(96, clientHeight×0.2)）。 */
export function stepChatReadingLineOffsetPx(clientHeight: number): number {
  return Math.min(
    STEP_CHAT_READING_LINE_OFFSET_PX,
    Math.max(0, clientHeight * STEP_CHAT_READING_LINE_FRACTION),
  )
}

/**
 * 阅读线扫描（纯；rc.1 turnAtLine 的 fallback 语义）：按 top 升序遍历，取
 * 「最后一个 top ≤ line」的 turn；首个条目已越线 → null（线在流头之上）。
 * @param entries - 行条目（视觉顺序 → top 升序；DOM 包装保证）。
 * @param lineTop - 阅读线的 y。
 */
export function stepChatTurnAtReading(
  entries: readonly StepChatReadingEntry[],
  lineTop: number,
): number | null {
  let found: number | null = null
  for (const entry of entries) {
    if (entry.top > lineTop) break
    found = entry.turn
  }
  return found
}

/** 定位换算（纯；rc.1 landOnRow 的 scrollTop += flowTop − clearance，地板钳 0）。 */
export function stepChatLandingTopOf(
  scrollTop: number,
  flowTop: number,
  clearance = STEP_CHAT_LANDING_CLEARANCE_PX,
): number {
  return Math.max(0, scrollTop + flowTop - clearance)
}

// ── 容器 DOM 读取/写（薄包装；值逻辑全部走上面的纯函数） ──────────────────────

/** 滚动视口是否贴底（rc.1 atBottom 同款 +1 容差）。 */
export function stepChatNearBottomOf(
  scrollport: HTMLElement,
  threshold = STEP_CHAT_FOLLOW_THRESHOLD_PX,
): boolean {
  return stepChatNearBottomMetricsOf(
    scrollport.scrollTop,
    scrollport.scrollHeight,
    scrollport.clientHeight,
    threshold,
  )
}

/** 阅读线 y（滚动视口坐标系；rc.1 的 elRect.top + min(96, h×0.2)）。 */
export function stepChatReadingLineTopOf(scrollport: HTMLElement): number {
  return scrollport.getBoundingClientRect().top + stepChatReadingLineOffsetPx(scrollport.clientHeight)
}

/** 可见行条目（DOM 顺序即视觉顺序；hidden="until-found" 的折叠行不算可见）。 */
export function stepChatVisibleTurnEntries(scope: HTMLElement): StepChatReadingEntry[] {
  const entries: StepChatReadingEntry[] = []
  for (const row of scope.querySelectorAll<HTMLElement>('[data-chat-turn]:not([hidden])')) {
    const turn = Number(row.dataset.chatTurn)
    if (!Number.isSafeInteger(turn)) continue
    entries.push({ top: row.getBoundingClientRect().top, turn })
  }
  return entries
}

/**
 * 阅读线下的轮次（rc.1 turnAtLine 移植）：
 * - elementsFromPoint 命中 [data-chat-turn]（真浏览器首路径；只可能命中可见行）；
 * - 未命中/未布局/jsdom → 按可见行 top 顺序扫描回退。
 */
export function stepChatTurnAtReadingLine(scope: HTMLElement, lineTop: number): number | null {
  const content = scope.getBoundingClientRect()
  if (content.width > 0
    && typeof document !== 'undefined'
    && typeof document.elementsFromPoint === 'function') {
    const x = content.left + content.width / 2
    for (const element of document.elementsFromPoint(x, lineTop)) {
      const row = element instanceof HTMLElement
        ? element.closest<HTMLElement>('[data-chat-turn]')
        : null
      const turn = Number(row?.dataset.chatTurn)
      if (row !== null && scope.contains(row) && Number.isSafeInteger(turn)) return turn
    }
  }
  return stepChatTurnAtReading(stepChatVisibleTurnEntries(scope), lineTop)
}

/**
 * 一次采样（StepChatBody 的 onScroll 采样直接消费；rc.1 syncActiveTurn 语义）：
 * 贴底 → 最新 offer；否则按阅读线下的行取 active。items 空 → null（无轴无标记）。
 */
export function stepChatSampleTurnAt(
  scrollport: HTMLElement,
  items: readonly StepChatTurnRailItem[],
): number | null {
  if (items.length === 0) return null
  if (stepChatNearBottomOf(scrollport)) return items.at(-1)?.turn ?? null
  const reading = stepChatTurnAtReadingLine(scrollport, stepChatReadingLineTopOf(scrollport))
  return stepChatActiveTurnOf(items, reading)
}

/**
 * 按锚点 key 找可见行（rc.1 anchorElement 移植：不插值 selector，遍历比对
 * data-chat-anchor-key——key 是引擎任意字符串，querySelector 转义不可靠）。
 * 行可能 hidden="until-found"（折叠的进程成员行），此函数只认可见行。
 */
export function stepChatAnchorRowIn(scope: HTMLElement, key: string): HTMLElement | null {
  for (const row of scope.querySelectorAll<HTMLElement>('[data-chat-anchor-key]:not([hidden])')) {
    if (row.dataset.chatAnchorKey === key) return row
  }
  return null
}

/** 同轮次的第一个可见行（锚点行 hidden 时的降级定位目标；无可见行 → null）。 */
export function stepChatTurnRowIn(scope: HTMLElement, turn: number): HTMLElement | null {
  for (const row of scope.querySelectorAll<HTMLElement>('[data-chat-turn]:not([hidden])')) {
    if (Number(row.dataset.chatTurn) === turn) return row
  }
  return null
}

/** 行 top 相对滚动视口 top（viewport 无关坐标；rc.1 flowTop）。 */
export function stepChatFlowTopOf(row: HTMLElement, scrollport: HTMLElement): number {
  return row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
}

/**
 * 把目标行定位到阅读线附近（rc.1 landOnRow 移植）：scrollTo 目标 =
 * scrollTop + flowTop − clearance（行 hidden 的降级处理在调用方，见
 * StepChatPanel.tsx 的 navigateToTurn 注释）。jsdom 无元素级 scrollTo 时回退
 * 直接赋值 scrollTop。
 */
export function stepChatScrollRowTo(
  scrollport: HTMLElement,
  row: HTMLElement,
  clearance = STEP_CHAT_LANDING_CLEARANCE_PX,
): void {
  const top = stepChatLandingTopOf(scrollport.scrollTop, stepChatFlowTopOf(row, scrollport), clearance)
  if (typeof scrollport.scrollTo === 'function') {
    scrollport.scrollTo({ top, behavior: 'auto' })
  } else {
    scrollport.scrollTop = top
  }
}
