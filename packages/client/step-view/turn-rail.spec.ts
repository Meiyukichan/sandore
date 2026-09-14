/**
 * turn-rail.spec：B4a 轮次轴数据/判定的纯函数单测（对齐 rc.1 语义：
 * mergeTurnRailItems 的 loaded 半边 + ChatView.syncActiveTurn/turnAtLine/
 * landOnRow 拆出的纯逻辑）。DOM 薄包装与 jsdom 冒烟在 turn-navigator.spec.ts。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/turn-rail.spec
 */
import { describe, expect, it } from 'vitest'

import {
  STEP_CHAT_EMPTY_RAIL_ITEMS,
  STEP_CHAT_FOLLOW_THRESHOLD_PX,
  STEP_CHAT_LANDING_CLEARANCE_PX,
  stepChatActiveTurnOf,
  stepChatLandingTopOf,
  stepChatNearBottomMetricsOf,
  stepChatRailItemsOf,
  stepChatReadingLineOffsetPx,
  stepChatSameRailItems,
  stepChatTurnAtReading,
  stepChatTurnRunMsOf,
  type StepChatReadingEntry,
  type StepChatTurnRailItem,
} from './turn-rail.ts'

/** 一条导航原始项（feed.navigationItems() 的成员形状）。 */
function rawItem(turn: number, anchorKey: string, prompt = '', response = ''): Record<string, unknown> {
  return { turn, anchorKey, prompt, response }
}

/** timeline turns map 形状（engine 为 ReadonlyMap；此处用 get 函数探测同构体）。 */
function timelineWith(turns: Record<number, { start?: { time: number }; end?: { time: number } }>): unknown {
  return {
    turnOrder: [1, 2, 3],
    turns: { get(key: number) { return turns[key] } },
  }
}

describe('stepChatRailItemsOf（navigation.items() → loaded rail items）', () => {
  it('returns the stable empty constant for empty/non-array input', () => {
    expect(stepChatRailItemsOf([])).toBe(STEP_CHAT_EMPTY_RAIL_ITEMS)
    expect(stepChatRailItemsOf([], undefined)).toBe(STEP_CHAT_EMPTY_RAIL_ITEMS)
    expect(stepChatRailItemsOf({} as unknown as readonly unknown[])).toBe(STEP_CHAT_EMPTY_RAIL_ITEMS)
    expect(stepChatRailItemsOf(null as unknown as readonly unknown[])).toBe(STEP_CHAT_EMPTY_RAIL_ITEMS)
  })

  it('maps loaded navigation items into { turn, prompt, response, anchor:{loaded,key} }', () => {
    const items = stepChatRailItemsOf([
      rawItem(1, 'user:1', '先分析', '已分析'),
      rawItem(2, 'assistant:2'),
    ])
    expect(items).toEqual([
      { turn: 1, prompt: '先分析', response: '已分析', anchor: { kind: 'loaded', key: 'user:1' } },
      { turn: 2, prompt: '', response: '', anchor: { kind: 'loaded', key: 'assistant:2' } },
    ])
  })

  it('filters turns that cannot exist/jump: junk, non-object, bad turn, empty anchor key', () => {
    const items = stepChatRailItemsOf([
      undefined,
      null,
      'x',
      3,
      {},
      { prompt: 'p' },
      rawItem(-1, 'k'),
      rawItem(1.5, 'k'),
      rawItem(Number.NaN, 'k'),
      { turn: 2, anchorKey: '' },
      { turn: 2, anchorKey: 5 },
      { turn: 3, anchorKey: '', prompt: 1, response: 2 },
      rawItem(4, 'ok'),
    ])
    expect(items).toEqual([{ turn: 4, prompt: '', response: '', anchor: { kind: 'loaded', key: 'ok' } }])
  })

  it('sorts ascending by turn and dedupes by turn (last entry wins)', () => {
    const items = stepChatRailItemsOf([
      rawItem(3, 'c'),
      rawItem(1, 'a', '第一'),
      rawItem(2, 'old'),
      rawItem(2, 'new', '第二'),
    ])
    expect(items.map(item => [item.turn, item.anchor.key])).toEqual([[1, 'a'], [2, 'new'], [3, 'c']])
    expect(items[1]).toMatchObject({ turn: 2, prompt: '第二', anchor: { kind: 'loaded', key: 'new' } })
  })

  it('keeps non-string previews degraded to empty strings (decorative fallback)', () => {
    const items = stepChatRailItemsOf([
      { turn: 1, anchorKey: 'a', prompt: 42, response: null },
    ])
    expect(items[0]).toMatchObject({ turn: 1, prompt: '', response: '' })
  })
})

describe('stepChatTurnRunMsOf（runMs best-effort 读取）', () => {
  it('computes wall-clock ms from timeline turns start/end', () => {
    expect(stepChatTurnRunMsOf(timelineWith({ 1: { start: { time: 100 }, end: { time: 3_400 } } }), 1))
      .toBe(3_300)
  })

  it('returns undefined when a boundary is missing or shapes mismatch', () => {
    expect(stepChatTurnRunMsOf(timelineWith({ 1: { start: { time: 100 } } }), 1)).toBeUndefined()
    expect(stepChatTurnRunMsOf(timelineWith({ 1: {} }), 1)).toBeUndefined()
    expect(stepChatTurnRunMsOf(timelineWith({}), 2)).toBeUndefined()
    expect(stepChatTurnRunMsOf(undefined, 1)).toBeUndefined()
    expect(stepChatTurnRunMsOf({ turns: [] }, 1)).toBeUndefined()
    expect(stepChatTurnRunMsOf({}, 1)).toBeUndefined()
    expect(stepChatTurnRunMsOf({ turns: { get: 'nope' } }, 1)).toBeUndefined()
    expect(stepChatTurnRunMsOf({ turns: { get: () => { throw new Error('x') } } }, 1)).toBeUndefined()
  })

  it('attaches runMs into rail items when readable', () => {
    const items = stepChatRailItemsOf(
      [rawItem(1, 'a')],
      timelineWith({ 1: { start: { time: 100 }, end: { time: 500 } } }),
    )
    expect(items[0]?.runMs).toBe(400)
    expect(stepChatRailItemsOf([rawItem(1, 'a')], undefined)[0]?.runMs).toBeUndefined()
  })
})

describe('stepChatSameRailItems（恒等缓存判等）', () => {
  const a: readonly StepChatTurnRailItem[] = [
    { turn: 1, prompt: 'p1', response: 'r1', anchor: { kind: 'loaded', key: 'k1' }, runMs: 12 },
    { turn: 2, prompt: '', response: '', anchor: { kind: 'loaded', key: 'k2' } },
  ]

  it('accepts identity and equal content; rejects any drift', () => {
    expect(stepChatSameRailItems(a, a)).toBe(true)
    expect(stepChatSameRailItems(a, [
      { turn: 1, prompt: 'p1', response: 'r1', anchor: { kind: 'loaded', key: 'k1' }, runMs: 12 },
      { turn: 2, prompt: '', response: '', anchor: { kind: 'loaded', key: 'k2' } },
    ])).toBe(true)
    expect(stepChatSameRailItems(a, [a[0]!])).toBe(false) // 长度变化
    expect(stepChatSameRailItems(a, [
      { turn: 1, prompt: 'P1', response: 'r1', anchor: { kind: 'loaded', key: 'k1' }, runMs: 12 },
      a[1]!,
    ])).toBe(false)
    expect(stepChatSameRailItems(a, [
      { turn: 1, prompt: 'p1', response: 'r1', anchor: { kind: 'loaded', key: 'other' }, runMs: 12 },
      a[1]!,
    ])).toBe(false)
    expect(stepChatSameRailItems(a, [
      { turn: 1, prompt: 'p1', response: 'r1', anchor: { kind: 'loaded', key: 'k1' } },
      a[1]!,
    ])).toBe(false) // runMs 丢失
    expect(stepChatSameRailItems(a, [])).toBe(false)
    expect(stepChatSameRailItems(STEP_CHAT_EMPTY_RAIL_ITEMS, STEP_CHAT_EMPTY_RAIL_ITEMS)).toBe(true)
    expect(stepChatSameRailItems(a, [
      { turn: 3, prompt: 'p1', response: 'r1', anchor: { kind: 'loaded', key: 'k1' }, runMs: 12 },
      a[1]!,
    ])).toBe(false)
  })
})

describe('stepChatActiveTurnOf（rc.1 syncActiveTurn 的判定语义）', () => {
  const items: readonly StepChatTurnRailItem[] = [
    { turn: 1, prompt: '', response: '', anchor: { kind: 'loaded', key: 'k1' } },
    { turn: 3, prompt: '', response: '', anchor: { kind: 'loaded', key: 'k3' } },
    { turn: 7, prompt: '', response: '', anchor: { kind: 'loaded', key: 'k7' } },
  ]

  it('returns null for an empty rail', () => {
    expect(stepChatActiveTurnOf(STEP_CHAT_EMPTY_RAIL_ITEMS, null)).toBeNull()
    expect(stepChatActiveTurnOf(STEP_CHAT_EMPTY_RAIL_ITEMS, 3)).toBeNull()
  })

  it('keeps the flow-head (first offered) turn when no row covers the reading line', () => {
    expect(stepChatActiveTurnOf(items, null)).toBe(1)
  })

  it('picks the newest offered turn at or below the reading turn', () => {
    expect(stepChatActiveTurnOf(items, 1)).toBe(1)
    expect(stepChatActiveTurnOf(items, 2)).toBe(1) // 阅读行在 1/3 之间
    expect(stepChatActiveTurnOf(items, 3)).toBe(3)
    expect(stepChatActiveTurnOf(items, 6)).toBe(3)
    expect(stepChatActiveTurnOf(items, 9)).toBe(7) // 越过最后一个 offer
  })

  it('falls back to the first offer when the reading turn predates it', () => {
    expect(stepChatActiveTurnOf(items, 0)).toBe(1)
  })
})

describe('stepChatTurnAtReading（行扫描纯逻辑；rc.1 turnAtLine fallback）', () => {
  const entries: readonly StepChatReadingEntry[] = [
    { top: 10, turn: 1 },
    { top: 40, turn: 1 },
    { top: 120, turn: 2 },
    { top: 400, turn: 3 },
  ]

  it('returns the last entry whose top is at or above the line', () => {
    expect(stepChatTurnAtReading(entries, 5)).toBeNull()
    expect(stepChatTurnAtReading(entries, 10)).toBe(1)
    expect(stepChatTurnAtReading(entries, 39)).toBe(1)
    expect(stepChatTurnAtReading(entries, 200)).toBe(2)
    expect(stepChatTurnAtReading(entries, 10_000)).toBe(3)
  })

  it('returns null for empty input', () => {
    expect(stepChatTurnAtReading([], 10)).toBeNull()
  })
})

describe('几何换算纯函数（rc.1 数值逐字）', () => {
  it('stepChatNearBottomMetricsOf: margin <= threshold + 1 counts as bottom', () => {
    expect(stepChatNearBottomMetricsOf(500, 800, 300)).toBe(true) // 0 ≤ 25
    expect(stepChatNearBottomMetricsOf(501, 800, 300)).toBe(true) // −1 ≤ 25
    expect(stepChatNearBottomMetricsOf(475, 800, 300)).toBe(true) // 25
    expect(stepChatNearBottomMetricsOf(474, 800, 300)).toBe(false) // 26
    expect(stepChatNearBottomMetricsOf(0, 1000, 300)).toBe(false)
    expect(stepChatNearBottomMetricsOf(0, 300, 300)).toBe(true) // 内容不超高
    expect(stepChatNearBottomMetricsOf(700, 1000, 300)).toBe(true)
    expect(stepChatNearBottomMetricsOf(0, 0, 0)).toBe(true)
    expect(stepChatNearBottomMetricsOf(0, 800, 300, 0)).toBe(false) // 自定义阈值 0 → 500>1
  })

  it('stepChatReadingLineOffsetPx: min(96, max(0, clientHeight × 0.2))', () => {
    expect(stepChatReadingLineOffsetPx(0)).toBe(0)
    expect(stepChatReadingLineOffsetPx(300)).toBe(60)
    expect(stepChatReadingLineOffsetPx(480)).toBe(96)
    expect(stepChatReadingLineOffsetPx(2000)).toBe(96)
  })

  it('stepChatLandingTopOf: scrollTop + flowTop - clearance, floored at 0', () => {
    expect(stepChatLandingTopOf(100, 60)).toBe(136)
    expect(stepChatLandingTopOf(0, 0)).toBe(0)
    expect(stepChatLandingTopOf(10, 5)).toBe(0) // 负值地板
    expect(stepChatLandingTopOf(0, 120, 24)).toBe(96)
    expect(stepChatLandingTopOf(0, 120, STEP_CHAT_LANDING_CLEARANCE_PX)).toBe(96)
    expect(STEP_CHAT_FOLLOW_THRESHOLD_PX).toBe(24)
  })
})
