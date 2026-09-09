/**
 * 时间线窗口化渲染的纯函数模块（无 React 依赖，vitest node 可测）。
 *
 * 对齐 DSH ChatView 的「尾部一窗 + 加载更早」分页机制：长实例的消息流含
 * MarkdownText / StepChatPanel 等重组件，全量渲染时首渲染与轮询压力大——
 * 默认只渲染时间线尾部一窗，顶部「加载更早」按钮逐次向历史方向扩窗。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/timeline-window
 */

/** 初始尾部窗口：首屏最多渲染最近 5 个 step agent（含夹在中间的 user 消息）。 */
export const TIMELINE_MAX_STEPS = 5

/** 每次「加载更早」的扩窗步长（再向历史方向多放 5 个 step agent）。 */
export const TIMELINE_STEPS_PAGE = 5

/** 贴底判定阈值（px）：`scrollHeight - scrollTop - clientHeight` ≤ 阈值视为贴底
 * （对齐 DSH ChatView 的 FOLLOW_THRESHOLD）。 */
export const FOLLOW_THRESHOLD = 24

/** 可见窗口计算结果。 */
export interface TimelineWindowRange {
  /** 渲染起点（`items.slice(start)` 的 start；0 = 全量渲染）。 */
  readonly start: number
  /** 未渲染的更早条数（>0 时时间线顶部显示「加载更早」）。 */
  readonly hidden: number
}

/**
 * 计算时间线尾部可见窗口（**step agent 粒度**）。
 *
 * step agent 是消息流的重组件单元（内嵌对话流 / Markdown 全文），窗口按「最多
 * N 个 step」计数而不是按消息条数——step 内部的消息本就只渲染最近几条
 * （StepChatPanel 最新 10 条 / LastMessages 5 条），user 气泡是轻量节点不需限窗。
 * 实现：从尾部向前数第 `maxSteps` 个 step 条目（`isStep` 命中）的索引为渲染起点，
 * 其与尾部之间的全部 user 消息一并可见。
 * @param items - 时间线条目（原样传入，配合 `isStep` 谓词判定）。
 * @param isStep - step agent 判定（TimelineItem 的 `kind !== 'user'`）。
 * @param maxSteps - 可见的最大 step 数（自动封顶为实际 step 总数、下限 0）。
 * @returns slice 起点与未渲染条数。
 */
export function visibleTimelineWindow<T>(
  items: readonly T[],
  isStep: (item: T) => boolean,
  maxSteps: number,
): TimelineWindowRange {
  const capped = Math.max(maxSteps, 0)
  // 防御非法入参（maxSteps<=0）：全隐藏，不渲染任何条目。
  if (capped === 0) return { start: items.length, hidden: items.length }
  let seen = 0
  let candidate: number | undefined
  for (let index = items.length - 1; index >= 0; index--) {
    if (!isStep(items[index] as T)) continue
    seen += 1
    if (seen === capped) {
      // 数到第 maxSteps 个 step：先记为候选起点，继续扫描确认前方是否还有
      // 更早的 step——没有（step 总数恰等于 maxSteps）则全量渲染、不显示「加载更早」。
      candidate = index
      continue
    }
    if (seen > capped) return { start: candidate as number, hidden: candidate as number }
  }
  return { start: 0, hidden: 0 }
}

/**
 * 展示等价比较（buildTimeline 引用稳定缓存的判定函数）。
 *
 * 原始值用 `===`；普通对象/数组在限定深度内逐字段比较——TimelineItem 的嵌套
 * （finalizeAssessResult、messages 的 ChatLine 元素等）均为 JSON 反序列化的
 * 扁平结构，默认深度内可判定；超深结构回退引用比较，防御环/异常输入。
 * @param a - 比较左值（上次缓存 item）。
 * @param b - 比较右值（本次派生 item）。
 * @param depth - 剩余递归深度（默认 4，足够覆盖 TimelineItem 的实际嵌套）。
 * @returns 展示等价（可复用旧引用）返回 true。
 */
export function timelineValueEqual(a: unknown, b: unknown, depth = 4): boolean {
  if (a === b) return true
  if (depth <= 0) return false
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  // 数组只能与数组等价（防 { 0: 'x' } 与 ['x'] 同构误判）。
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!timelineValueEqual(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      depth - 1,
    )) return false
  }
  return true
}
