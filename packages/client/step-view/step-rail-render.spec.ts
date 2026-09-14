// @vitest-environment jsdom
/**
 * step-rail-render.spec（jsdom）：每-step 轮次条的**渲染契约**。
 *
 * 用户需求（真机）：
 * - 项数 = step 数（每 step 一档，顺序同执行顺序）；
 * - 单档不画轴（与 DSH 轮次条「单轮只挂零高槽位」同策略）；
 * - 点击第 N 档 → 滚动容器定位到该 step 卡片（`[data-tl-step][data-step-id]`）；
 * - 滚动后 active 档随之变化（`data-active="true"` 只有一档）。
 *
 * jsdom 没有布局（`getBoundingClientRect` 全 0），故用**可赋值的 top 覆盖**模拟布局：
 * 卡片 top 相对滚动容器 top 给出确定值，阅读线（视口顶 + min(96, h×0.2)）即可命中。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/step-rail-render.spec
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import { StepRail, STEP_RAIL_CARD_SELECTOR } from './StepRail.tsx'

/** 桩翻译：键 + 参数（便于断言 aria-label 带 step 名）。 */
const t = ((key: string, params?: Record<string, unknown>) =>
  (params === undefined ? key : `${key}:${String(params.name ?? '')}`)) as unknown as TranslateNS<'sandore'>

let host: HTMLDivElement
let root: Root
/** 滚动容器（= RunView 的 `.feedScroll` 等价物）。 */
let scroller: HTMLDivElement

/** 造一张 step 卡片（带轮次条定位用的两个属性）。 */
function makeCard(stepId: string, attempt: number, top: number): HTMLDivElement {
  const card = document.createElement('div')
  card.setAttribute('data-tl-step', '')
  card.dataset.stepId = stepId
  card.dataset.stepAttempt = String(attempt)
  // jsdom 无布局：直接赋一个 top（相对滚动容器），供阅读线扫描消费。
  card.getBoundingClientRect = () => ({ top, height: 100 } as DOMRect)
  return card
}

/** 渲染轮次条（`segments` 为轴数据）。 */
function renderRail(segments: readonly { stepId: string; attemptIndex?: number; name?: string }[]): void {
  root.render(createElement(StepRail, {
    segments: segments.map(segment => ({ ...segment, status: 'completed' })),
    scrollContainerRef: { current: scroller },
    t,
  }))
}

/** 等一个宏任务（其前全部微任务已排空）。 */
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

/** 触发滚动采样（滚动事件 + scrollend 立刻补样）。 */
async function fireScroll(): Promise<void> {
  scroller.dispatchEvent(new Event('scroll'))
  scroller.dispatchEvent(new Event('scrollend'))
  await tick()
  await tick()
}

beforeEach(() => {
  host = document.createElement('div')
  scroller = document.createElement('div')
  document.body.append(scroller, host)
  // 视口几何：clientHeight 240 ⇒ 阅读线偏移 min(96, 48) = 48，视口顶 = 0。
  Object.defineProperty(scroller, 'clientHeight', { value: 240, configurable: true })
  Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true })
  scroller.scrollTop = 0
  scroller.getBoundingClientRect = () => ({ top: 0, height: 240 } as DOMRect)
  root = createRoot(host)
})

afterEach(() => {
  root.unmount()
  host.remove()
  scroller.remove()
})

describe('StepRail 渲染', () => {
  it('项数 = step 数，顺序同执行顺序，锚点带 data-step-id / data-step-attempt', async () => {
    scroller.append(
      makeCard('step-a', 0, -50),
      makeCard('step-b', 0, -10),
      makeCard('step-c', 0, 300),
    )
    renderRail([{ stepId: 'step-a', name: '第一步' }, { stepId: 'step-b', name: '第二步' }, { stepId: 'step-c', name: '第三步' }])
    await tick()
    const items = [...host.querySelectorAll('[data-sandore-step-rail-item]')]
    expect(items).toHaveLength(3)
    expect(items.map(item => item.getAttribute('data-step-id'))).toEqual(['step-a', 'step-b', 'step-c'])
    expect(items.map(item => item.getAttribute('aria-label')))
      .toEqual(['run.step.rail.jump:第一步', 'run.step.rail.jump:第二步', 'run.step.rail.jump:第三步'])
    // 根锚点 + 档数属性（e2e 直接对照 step 数）。
    const rail = host.querySelector('[data-sandore-step-rail]')
    expect(rail?.getAttribute('data-step-rail-count')).toBe('3')
  })

  it('重试/回退的同 step 多段 = 多档（用 attempt 区分）', async () => {
    scroller.append(makeCard('step-a', 0, -50), makeCard('step-a', 1, 10), makeCard('step-b', 0, 300))
    renderRail([
      { stepId: 'step-a', attemptIndex: 0, name: '第一步' },
      { stepId: 'step-a', attemptIndex: 1, name: '第一步' },
      { stepId: 'step-b', name: '第二步' },
    ])
    await tick()
    const items = [...host.querySelectorAll('[data-sandore-step-rail-item]')]
    expect(items.map(item => item.getAttribute('data-step-attempt'))).toEqual(['0', '1', '0'])
  })

  it('单档照常画刻度（档数恒等于 step 数；用户口径：每个 step 一项）', async () => {
    scroller.append(makeCard('step-a', 0, 0))
    renderRail([{ stepId: 'step-a', name: '第一步' }])
    await tick()
    expect(host.querySelector('[data-sandore-step-rail]')?.getAttribute('data-step-rail-count')).toBe('1')
    const items = [...host.querySelectorAll('[data-sandore-step-rail-item]')]
    expect(items).toHaveLength(1)
    expect(items[0]?.getAttribute('data-step-id')).toBe('step-a')
  })

  it('零档只挂零高槽位（无刻度）', async () => {
    renderRail([])
    await tick()
    expect(host.querySelector('[data-sandore-step-rail]')?.getAttribute('data-step-rail-count')).toBe('0')
    expect(host.querySelectorAll('[data-sandore-step-rail-item]')).toHaveLength(0)
  })

  it('滚动后 active 随「视口内最后一个 step」变化', async () => {
    // 未滚动：卡片视口 top（= 滚动视口顶 + flowTop）。
    scroller.append(
      makeCard('step-a', 0, 0),
      makeCard('step-b', 0, 20),
      makeCard('step-c', 0, 400),
    )
    renderRail([{ stepId: 'step-a' }, { stepId: 'step-b' }, { stepId: 'step-c' }])
    await tick()
    await fireScroll()
    // 阅读线 = 0 + 48；top ≤ 48 的最后一档是 step-b（top=20）。
    expect(host.querySelector('[data-sandore-step-rail-item][data-active="true"]')?.getAttribute('data-step-id'))
      .toBe('step-b')
    // 滚动 400：所有卡片相对视口上移 400（flowTop 各 −400）——
    // 于是 step-c 从 400 到 0（越过阅读线），step-a/step-b 落到线之上。
    for (const [index, card] of [...scroller.querySelectorAll<HTMLElement>(STEP_RAIL_CARD_SELECTOR)].entries()) {
      card.getBoundingClientRect = () => ({ top: [0, 20, 400][index]! - 400, height: 100 } as DOMRect)
    }
    await fireScroll()
    expect(host.querySelector('[data-sandore-step-rail-item][data-active="true"]')?.getAttribute('data-step-id'))
      .toBe('step-c')
    // 同一时刻只有一档是 active。
    expect(host.querySelectorAll('[data-sandore-step-rail-item][data-active="true"]')).toHaveLength(1)
  })

  it('点击第 N 档 → 滚动容器定位到该 step 卡片（scrollTop += flowTop − 24）', async () => {
    scroller.append(
      makeCard('step-a', 0, -100),
      makeCard('step-b', 0, 500),
      makeCard('step-c', 0, 900),
    )
    renderRail([{ stepId: 'step-a' }, { stepId: 'step-b' }, { stepId: 'step-c' }])
    await tick()
    await fireScroll()
    // 模拟真实滚动：滚动后滚动视口向上移动、卡片相对视口上移同样距离
    // （jsdom 不会自己动，故由 scrollTo 实现里同步卡片 top —— 否则点击后的
    //  采样会立刻把 active 打回滚动前的档）。
    const scrollTo = vi.fn((options: { top: number }) => {
      const delta = options.top - scroller.scrollTop
      scroller.scrollTop = options.top
      for (const card of scroller.querySelectorAll<HTMLElement>(STEP_RAIL_CARD_SELECTOR)) {
        const current = card.getBoundingClientRect().top
        card.getBoundingClientRect = () => ({ top: current - delta, height: 100 } as DOMRect)
      }
    })
    Object.defineProperty(scroller, 'scrollTo', { value: scrollTo, configurable: true })
    const second = [...host.querySelectorAll<HTMLElement>('[data-sandore-step-rail-item]')][1]
    second!.click()
    // flowTop = 500 − 0 = 500 ⇒ top = max(0, 0 + 500 − 24) = 476。
    expect(scrollTo).toHaveBeenCalledWith({ top: 476, behavior: 'auto' })
    // 点击后该档立即成为 active（滚动容器也已落到该卡片）；等 React 落定再读 DOM。
    expect(scroller.scrollTop).toBe(476)
    await tick()
    await tick()
    expect(host.querySelector('[data-sandore-step-rail-item][data-active="true"]')?.getAttribute('data-step-id'))
      .toBe('step-b')
  })

  it('卡片选择器只用 step 卡片锚点（不误伤主代理卡片）', () => {
    expect(STEP_RAIL_CARD_SELECTOR).toBe('[data-tl-step][data-step-id]')
  })
})
