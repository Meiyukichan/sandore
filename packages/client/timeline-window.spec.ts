/**
 * timeline-window.ts 的纯逻辑单元测试：尾部窗口计算边界、贴底阈值导出、
 * 展示等价比较（引用稳定缓存的判定函数）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/timeline-window.spec
 */
import { describe, expect, it } from 'vitest'

import {
  FOLLOW_THRESHOLD, TIMELINE_MAX_STEPS, TIMELINE_STEPS_PAGE, timelineValueEqual, visibleTimelineWindow,
} from './timeline-window.ts'

/** 构造测试条目（kind: 'user' = user 气泡，其余 = step agent）。 */
function entry(kind: 'user' | 'step'): { kind: string } {
  return { kind }
}

describe('visibleTimelineWindow（step agent 粒度）', () => {
  it('items 为空 → 空窗口（无渲染、无隐藏）', () => {
    expect(visibleTimelineWindow([], () => false, TIMELINE_MAX_STEPS)).toEqual({ start: 0, hidden: 0 })
  })

  it('step 总数不足 maxSteps → 全量渲染（start=0，无隐藏）', () => {
    const items = [entry('step'), entry('user'), entry('step'), entry('user')]
    expect(visibleTimelineWindow(items, item => item.kind === 'step', TIMELINE_MAX_STEPS))
      .toEqual({ start: 0, hidden: 0 })
  })

  it('step 总数等于 maxSteps → 全量渲染且无隐藏', () => {
    const items = [
      entry('user'), entry('step'), entry('user'), entry('step'),
      entry('step'), entry('step'), entry('step'),
    ]
    expect(visibleTimelineWindow(items, item => item.kind === 'step', TIMELINE_MAX_STEPS))
      .toEqual({ start: 0, hidden: 0 })
  })

  it('step 超过 maxSteps → start 落在第 N 个（从尾数）step 上，其余计入 hidden', () => {
    // 8 个 step（索引 0/2/4/6/8/10/12/14）夹 7 条 user：maxSteps=5 → 从尾数第 5 个
    // step 在索引 6，其与尾部之间的 user 消息一并可见。
    const items = [
      entry('step'), entry('user'), entry('step'), entry('user'), entry('step'),
      entry('user'), entry('step'), entry('user'), entry('step'), entry('user'),
      entry('step'), entry('user'), entry('step'), entry('user'), entry('step'),
    ]
    expect(visibleTimelineWindow(items, item => item.kind === 'step', 5))
      .toEqual({ start: 6, hidden: 6 })
  })

  it('maxSteps 为 0 → 全隐藏（防御非法入参，不抛错）', () => {
    const items = [entry('step'), entry('user'), entry('step')]
    expect(visibleTimelineWindow(items, item => item.kind === 'step', 0))
      .toEqual({ start: 3, hidden: 3 })
  })

  it('扩窗步长逐次逼近：hidden 递减、覆盖全量后稳定为 start=0', () => {
    const items: Array<{ kind: string }> = []
    for (let i = 0; i < 8; i++) {
      items.push(entry('user'), entry('step'))
    }
    const isStep = (item: { kind: string }): boolean => item.kind === 'step'
    let maxSteps = TIMELINE_MAX_STEPS
    // 第一次：可见最后 5 个 step（step 索引 1/3/5/7/9/11/13/15，从尾数第 5 个 = 7）。
    const first = visibleTimelineWindow(items, isStep, maxSteps)
    expect(first.start).toBe(7)
    expect(first.hidden).toBe(7)
    maxSteps += TIMELINE_STEPS_PAGE
    // 第二次：8 个 step 全可见。
    const second = visibleTimelineWindow(items, isStep, maxSteps)
    expect(second).toEqual({ start: 0, hidden: 0 })
  })

  it('连续多个 step 中间无 user → start 同样按 step 计数', () => {
    const items = [
      entry('user'), entry('step'), entry('step'), entry('step'),
      entry('step'), entry('step'), entry('step'),
    ]
    // step 索引 1-6：从尾数第 5 个 = 2。
    expect(visibleTimelineWindow(items, item => item.kind === 'step', 5))
      .toEqual({ start: 2, hidden: 2 })
  })
})

describe('FOLLOW_THRESHOLD', () => {
  it('导出贴底判定阈值（px，对齐 DSH ChatView）', () => {
    expect(FOLLOW_THRESHOLD).toBe(24)
  })
})

describe('timelineValueEqual（引用稳定判定）', () => {
  it('原始值相同 → true；不同 → false', () => {
    expect(timelineValueEqual('a', 'a')).toBe(true)
    expect(timelineValueEqual(1, 1)).toBe(true)
    expect(timelineValueEqual(undefined, undefined)).toBe(true)
    expect(timelineValueEqual(1, 2)).toBe(false)
    expect(timelineValueEqual(undefined, null)).toBe(false)
    expect(timelineValueEqual('1', 1)).toBe(false)
  })

  it('字段全同但引用不同 → true（旧引用可复用）', () => {
    const cached = { kind: 'step', stepId: 's1', status: 'running' }
    const derived = { kind: 'step', stepId: 's1', status: 'running' }
    expect(cached).not.toBe(derived)
    expect(timelineValueEqual(cached, derived)).toBe(true)
  })

  it('字段值变化 → false（需返回新对象）', () => {
    expect(timelineValueEqual({ status: 'running' }, { status: 'completed' })).toBe(false)
  })

  it('键数量不同 → false', () => {
    expect(timelineValueEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(timelineValueEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false)
  })

  it('一层嵌套对象字段相同 → true（finalizeAssessResult 场景）', () => {
    expect(timelineValueEqual(
      { status: 'completed', finalizeAssessResult: { assessmentRaw: 'ok', compressedOutput: '# hi' } },
      { status: 'completed', finalizeAssessResult: { assessmentRaw: 'ok', compressedOutput: '# hi' } },
    )).toBe(true)
    expect(timelineValueEqual(
      { finalizeAssessResult: { assessmentRaw: 'ok' } },
      { finalizeAssessResult: { assessmentRaw: 'changed' } },
    )).toBe(false)
  })

  it('数组逐元素比较（messages / ChatLine 场景）', () => {
    expect(timelineValueEqual(
      { messages: [{ who: 'a · agent', text: 'hi', kind: 'assistant' }] },
      { messages: [{ who: 'a · agent', text: 'hi', kind: 'assistant' }] },
    )).toBe(true)
    expect(timelineValueEqual(
      { messages: [{ who: 'a · agent', text: 'hi', kind: 'assistant' }] },
      { messages: [{ who: 'a · agent', text: 'changed', kind: 'assistant' }] },
    )).toBe(false)
    expect(timelineValueEqual(
      { messages: [{ who: 'a', text: 'hi', kind: 'assistant' }] },
      { messages: [] },
    )).toBe(false)
  })

  it('数组与非数组同构 → false（防 { 0: x } 与 [x] 误判）', () => {
    expect(timelineValueEqual({ 0: 'x' }, ['x'])).toBe(false)
    expect(timelineValueEqual(['x'], { 0: 'x' })).toBe(false)
  })

  it('超深嵌套超出递归深度 → 回退引用比较（false，防御环/异常输入）', () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } }
    const same = { a: { b: { c: { d: { e: 1 } } } } }
    expect(timelineValueEqual(deep, same)).toBe(false)
    // 同引用始终相等（=== 短路，不受深度限制）。
    expect(timelineValueEqual(deep, deep)).toBe(true)
  })

  it('null 与对象不误判', () => {
    expect(timelineValueEqual(null, {})).toBe(false)
    expect(timelineValueEqual({}, null)).toBe(false)
    expect(timelineValueEqual(null, null)).toBe(true)
  })
})
