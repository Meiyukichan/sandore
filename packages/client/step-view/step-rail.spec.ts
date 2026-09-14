/**
 * step-rail.spec：discussion 右侧「每 step 一档」轮次条的**模型层**单测。
 *
 * 用户需求（真机）：
 * 1. 旧的「每轮」刻度（`aria-label="跳转到第 N 轮"`）在 discussion 里去掉；
 * 2. 改成**每 step 一档**，顺序 = 执行顺序；
 * 3. active 计算 = 当前视口内最后一个 step（阅读线语义）；
 * 4. 点击某项 → 定位到该 step 卡片（`stepId#attemptIndex`）。
 *
 * 本文件只测纯函数（条目构造/顺序/等价/active/定位换算），组件渲染与真实滚动
 * 在 `StepRail.tsx` + e2e 覆盖。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/step-rail.spec
 */
import { describe, expect, it } from 'vitest'

import {
  STEP_RAIL_EMPTY, sameStepRailItems, stepRailActiveKeyAt, stepRailActiveKeyOf,
  stepRailItemsOf, stepRailKeyOf, stepRailLandingTopOf, stepRailReadingLineOffsetPx,
  type StepRailItem, type StepRailReadingEntry,
} from './step-rail.ts'

/** 造一个段（引擎 `ExecutedStep` 的最小子集）。 */
function segment(stepId: string, attemptIndex = 0, name?: string, status = 'completed') {
  return { stepId, attemptIndex, ...(name === undefined ? {} : { name }), status }
}

describe('stepRailItemsOf', () => {
  it('每 step 一档，顺序 = 执行顺序（不排序、不按 turn 分组）', () => {
    const items = stepRailItemsOf([
      segment('step-a', 0, '第一步'),
      segment('step-b', 0, '第二步'),
      segment('step-c', 0, '第三步'),
    ])
    expect(items.map(item => item.stepId)).toEqual(['step-a', 'step-b', 'step-c'])
    expect(items.map(item => item.label)).toEqual(['第一步', '第二步', '第三步'])
  })

  it('同一 step 的多次执行 = 多档（重试/回退后仍能逐档定位）', () => {
    const items = stepRailItemsOf([
      segment('step-a', 0, '第一步'),
      segment('step-a', 1, '第一步'),
      segment('step-b', 0, '第二步'),
    ])
    expect(items.map(item => stepRailKeyOf(item))).toEqual(['step-a#0', 'step-a#1', 'step-b#0'])
  })

  it('名字缺失回退 stepId；stepId 缺失回退段 id；都没有则丢弃该段', () => {
    const items = stepRailItemsOf([
      { stepId: 'step-a' },
      { id: 'seg-1' },
      { name: 'no id' },
    ])
    expect(items.map(item => item.stepId)).toEqual(['step-a', 'seg-1'])
  })

  it('空输入 → 稳定空常量（不新建数组）', () => {
    expect(stepRailItemsOf([])).toBe(STEP_RAIL_EMPTY)
  })
})

describe('sameStepRailItems（渲染侧恒等缓存）', () => {
  it('内容相同（含 label/status）判等价；任一档不同判不等价', () => {
    const base = stepRailItemsOf([segment('step-a'), segment('step-b')])
    const same = stepRailItemsOf([segment('step-a'), segment('step-b')])
    expect(sameStepRailItems(base, same)).toBe(true)
    expect(sameStepRailItems(base, stepRailItemsOf([segment('step-a')]))).toBe(false)
    expect(sameStepRailItems(base, stepRailItemsOf([segment('step-a'), segment('step-b', 1)]))).toBe(false)
    const renamed: readonly StepRailItem[] = [{ ...base[0]!, label: '改名' }, base[1]!]
    expect(sameStepRailItems(base, renamed)).toBe(false)
  })
})

describe('active 计算（阅读线语义）', () => {
  const items = stepRailItemsOf([segment('step-a'), segment('step-b'), segment('step-c')])

  it('取「当前视口内最后一个 step」（最后一个 top ≤ 阅读线的档）', () => {
    const entries: readonly StepRailReadingEntry[] = [
      { top: -200, key: 'step-a#0' },
      { top: -50, key: 'step-b#0' },
      { top: 120, key: 'step-c#0' },
    ]
    expect(stepRailActiveKeyAt(entries, 0)).toBe('step-b#0')
    expect(stepRailActiveKeyAt(entries, 200)).toBe('step-c#0')
  })

  it('线在首档之上 → null（回退到首档）', () => {
    const entries: readonly StepRailReadingEntry[] = [{ top: 40, key: 'step-a#0' }]
    expect(stepRailActiveKeyAt(entries, 0)).toBeNull()
    expect(stepRailActiveKeyOf(items, null)).toBe('step-a#0')
  })

  it('阅读线命中的 key 不在轴上（卡片比档密）→ 回退首档', () => {
    expect(stepRailActiveKeyOf(items, 'unknown#0')).toBe('step-a#0')
  })

  it('空轴 → null', () => {
    expect(stepRailActiveKeyOf(STEP_RAIL_EMPTY, 'step-a#0')).toBeNull()
  })
})

describe('几何换算', () => {
  it('阅读线偏移 = min(96, clientHeight×0.2)', () => {
    expect(stepRailReadingLineOffsetPx(1000)).toBe(96)
    expect(stepRailReadingLineOffsetPx(100)).toBe(20)
    expect(stepRailReadingLineOffsetPx(0)).toBe(0)
  })

  it('定位 = scrollTop + flowTop − 24，地板钳 0', () => {
    expect(stepRailLandingTopOf(1000, 300)).toBe(1276)
    expect(stepRailLandingTopOf(10, 5)).toBe(0)
  })
})
