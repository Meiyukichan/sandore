/**
 * step-rail：discussion（运行页对话区）右侧**每 step 一档**的轮次轴——纯数据 + 几何判定层。
 *
 * ## 与 turn-rail（旧的每轮刻度）的关系
 * 用户真机要求：discussion 里的旧「每轮」刻度条（`step-view/TurnNavigator.tsx`，
 * 每 turn 一个 `aria-label="跳转到第 N 轮"`）**去掉**，改成「**每个 step 一项**」，
 * 顺序同执行顺序，点击定位到对应的 step 卡片（`[data-tl-step]`）。
 * 旧的 `TurnNavigator` 仍保留给 **step 子代理面板**（`variant='subagent'`）使用，
 * 只有 discussion（`variant='main'`）不再渲染它。
 *
 * ## 数据面（零新 RPC）
 * 条目直接来自 `RunView` 已有的活跃 step 段（`run-view-model.ts` 的
 * `lastActiveSegmentsOf(state.executedSteps)`，按 stepId 取 attemptIndex 最大者）——
 * **不读 DSH 会话的导航/分页面**（那是「轮」的概念，与 step 无关），也不新增任何
 * RPC。条目顺序 = 段的执行顺序（引擎写入顺序），因此与左栏树、时间线卡片顺序一致。
 *
 * ## 视觉与交互（与 DSH 轮次条一致）
 * 刻度、等距、active 高亮、点击定位全部照 `step-view/TurnNavigator.tsx` 的既有实现
 * （那是 DSH `ui-chat chat/TurnNavigator` 的 1:1 移植）：同一份间距常量、同一套
 * `turn-navigator.module.css` 类名，只是每项语义从「轮」换成「step」。
 * 判定/换算集中在本文件的纯函数里（可单测），组件只做 DOM 读写。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/step-rail
 */
import type { ExecutedStep } from '../run-view-model.ts'

/** 轴上一个 step 档（执行顺序）。 */
export interface StepRailItem {
  /** Step 定义 id（`[data-tl-step]` 卡片上的 `data-step-id`）；点击定位用它。 */
  readonly stepId: string
  /** 第几次执行（同 step 重试/回退会产生多个段；用于 key 与显示）。 */
  readonly attemptIndex: number
  /** 展示名（空 → 回退 stepId）。 */
  readonly label: string
  /** 段状态（活跃态/终态；组件据此给状态点同族语义，当前只用于 aria/诊断）。 */
  readonly status: string
}

/** 空轴常量（未就绪/无段时的稳定引用）。 */
export const STEP_RAIL_EMPTY: readonly StepRailItem[] = []

/** 轴上一条目录项的最小形状（`ExecutedStep` 子集；便于单测构造）。
 *  `stepId` 在引擎类型里是可选的（历史段可能缺），故这里也留可选并回退 `id`。 */
export interface StepRailSource {
  readonly stepId?: string | undefined
  /** 段 id（`stepId` 缺失时的回退锚点）。 */
  readonly id?: string | undefined
  readonly attemptIndex?: number | undefined
  readonly name?: string | undefined
  readonly status?: string | undefined
}

/**
 * 段列表 → 轴条目（顺序 = 传入顺序 = 执行顺序；**不去重**：同一 step 的多次执行
 * 在轴上就是多档，与「点击定位到卡片」一一对应）。
 * @param segments - 活跃 step 段（`lastActiveSegmentsOf` 的输出或等价列表）。
 * @returns 轴条目（拿不到任何 id 的段被丢弃）；空输入 → 稳定空常量。
 */
export function stepRailItemsOf(segments: readonly StepRailSource[] | readonly ExecutedStep[]): readonly StepRailItem[] {
  if (segments.length === 0) return STEP_RAIL_EMPTY
  const items: StepRailItem[] = []
  for (const segment of segments) {
    const stepId = typeof segment.stepId === 'string' && segment.stepId !== ''
      ? segment.stepId
      : (typeof segment.id === 'string' ? segment.id : '')
    if (stepId === '') continue
    const attemptIndex = typeof segment.attemptIndex === 'number' ? segment.attemptIndex : 0
    const name = typeof segment.name === 'string' ? segment.name.trim() : ''
    items.push({
      stepId,
      attemptIndex,
      label: name === '' ? stepId : name,
      status: typeof segment.status === 'string' ? segment.status : 'pending',
    })
  }
  return items.length === 0 ? STEP_RAIL_EMPTY : items
}

/**
 * 两条轴是否等价（组件侧做恒等缓存，避免流式帧重建刻度 DOM）。
 * @param left - 旧条目。
 * @param right - 新条目。
 */
export function sameStepRailItems(
  left: readonly StepRailItem[],
  right: readonly StepRailItem[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined || b === undefined) return false
    if (a.stepId !== b.stepId || a.attemptIndex !== b.attemptIndex) return false
    if (a.label !== b.label || a.status !== b.status) return false
  }
  return true
}

/**
 * 轴条目的稳定 key（同 step 多段时区分开）。
 * @param item - 轴条目。
 */
export function stepRailKeyOf(item: StepRailItem): string {
  return `${item.stepId}#${String(item.attemptIndex)}`
}

// ── active 判定（照 turn-rail 的「阅读线」语义，但单位是 step） ─────────────────

/** 阅读线扫描的输入行（DOM 顺序即视觉顺序，top 升序）。 */
export interface StepRailReadingEntry {
  /** 行 top（滚动视口坐标系）。 */
  readonly top: number
  /** 该行对应的轴条目 key（`stepRailKeyOf`）。 */
  readonly key: string
}

/**
 * 阅读线下的 active key（照 `turn-rail.ts` 的 `stepChatTurnAtReading`）：
 * 取「最后一个 top ≤ 阅读线」的条目；首个条目已越线 → null。
 * @param entries - 可见卡片条目（视觉顺序）。
 * @param lineTop - 阅读线 y（滚动视口坐标系）。
 * @returns active key；无线/无条目 → null。
 */
export function stepRailActiveKeyAt(
  entries: readonly StepRailReadingEntry[],
  lineTop: number,
): string | null {
  let found: string | null = null
  for (const entry of entries) {
    if (entry.top > lineTop) break
    found = entry.key
  }
  return found
}

/**
 * active key 兜底（照 turn-rail 的 `stepChatActiveTurnOf`）：阅读线没命中任何卡片
 * （线在首卡之上 / 卡片都在线下方）时，回退到**首档**（流头占有刻度）。
 * @param items - 轴条目。
 * @param reading - 阅读线命中的 key（null = 未命中）。
 * @returns active key；空轴 → null。
 */
export function stepRailActiveKeyOf(
  items: readonly StepRailItem[],
  reading: string | null,
): string | null {
  const first = items[0]
  if (first === undefined) return null
  if (reading === null) return stepRailKeyOf(first)
  return items.some(item => stepRailKeyOf(item) === reading) ? reading : stepRailKeyOf(first)
}

/** 阅读线距滚动视口顶的偏移（照 turn-rail：min(96, clientHeight×0.2)）。 */
export function stepRailReadingLineOffsetPx(clientHeight: number): number {
  return Math.min(96, Math.max(0, clientHeight * 0.2))
}

/** 定位换算（照 turn-rail 的 `stepChatLandingTopOf`：scrollTop += flowTop − clearance）。 */
export function stepRailLandingTopOf(
  scrollTop: number,
  flowTop: number,
  clearance = 24,
): number {
  return Math.max(0, scrollTop + flowTop - clearance)
}
