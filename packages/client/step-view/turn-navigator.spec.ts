/**
 * turn-navigator.spec：B4a 轮次轴的 jsdom 冒烟（@vitest-environment jsdom）——
 * 锁定：
 * - TurnNavigator 渲染 N 个等距 mark（aria-label/active 态）、单轮不渲染刻度、
 *   focus/blur 预览 tooltip 的显隐；
 * - 点击 mark → onNavigate（StepChatBody 同款接线：锚点行定位，hidden 锚点回退
 *   同轮可见行，容器 scrollTo 被桩调用并携带补偿后的 scrollTop）；
 * - 滚动采样（scrollend flush 路径，与 StepChatBody 相同的 schedule/flush 端口）
 *   驱动 activeTurn 更新函数被调用、rail 的 aria-current 随之移动（阅读线命中
 *   场景 + 贴底场景）。
 *
 * 说明：jsdom 无排版/无 elementsFromPoint，采样走「行 top 扫描」回退分支——本
 * 测试以桩化 getBoundingClientRect / clientHeight / scrollTop / scrollHeight 提供
 * 几何；真实排版级验证留给 playwright（仓库已有 devDep）。CSS module 在 vitest
 * css:false 下被置空，故只断言结构与 data/aria 面，不断言样式。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/turn-navigator.spec
 */
// @vitest-environment jsdom
// React 18 需要显式声明 act 环境（否则每个 act 调用打 warning）。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import { zh } from '../locales.ts'
import { TurnNavigator } from './TurnNavigator.tsx'
import {
  stepChatAnchorRowIn,
  stepChatSampleTurnAt,
  stepChatTurnRowIn,
  type StepChatTurnRailItem,
} from './turn-rail.ts'

/** sandore zh 字典桩翻译（与 step-view-render.spec 同款；{param} 插值）。 */
function makeT() {
  const lookup = zh as unknown as Record<string, string>
  return (key: string, params?: Record<string, unknown>): string => {
    let text = lookup[key] ?? key
    if (params !== undefined) {
      for (const [name, value] of Object.entries(params)) {
        text = text.replaceAll(`{${name}}`, String(value))
      }
    }
    return text
  }
}
const t = makeT() as never

const railItems = (): StepChatTurnRailItem[] => [
  { turn: 1, prompt: '先看看仓库结构', response: '好的，先读取 AGENTS.md', anchor: { kind: 'loaded', key: 'k1' } },
  { turn: 2, prompt: '继续', response: '', anchor: { kind: 'loaded', key: 'k2' } },
  { turn: 3, prompt: '执行 B4a', response: '已完成右侧轮次轴', anchor: { kind: 'loaded', key: 'k3' } },
]

const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
})

function render(element: ReactNode): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => { root.render(element) })
  return host
}

/** 行描述：渲染为带 data-chat-anchor-key / data-chat-turn 的 div（hidden 可选）。 */
interface FakeRow {
  readonly key: string
  readonly turn: number
  readonly hidden?: boolean
}

/** 桩化一行（或容器）的 getBoundingClientRect：仅采样/定位用到的几何叶子。 */
function stubRect(element: HTMLElement, top: number, width = 600): void {
  const rect = {
    top, bottom: top + 20, left: 0, right: width, width, height: 20, x: 0, y: top,
  }
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect as DOMRect)
}

/** 桩化滚动视口度量（jsdom 恒 0，采样需要真实几何）。 */
function stubScrollport(
  container: HTMLElement,
  metrics: { clientHeight?: number; scrollHeight?: number; scrollTop?: number },
): void {
  if (metrics.clientHeight !== undefined) {
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: metrics.clientHeight })
  }
  if (metrics.scrollHeight !== undefined) {
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: metrics.scrollHeight })
  }
  if (metrics.scrollTop !== undefined) {
    Object.defineProperty(container, 'scrollTop', { configurable: true, value: metrics.scrollTop })
  }
}

/**
 * StepChatBody 同款接线的微型宿主：容器 = 滚动视口；TurnNavigator 为容器首子
 * 节点；scroll 事件登记 pending（500ms 采样）、scrollend 立即 flush；activeTurn
 * 状态回写 TurnNavigator；点击刻度做锚点行定位（hidden 锚点回退同轮可见行）。
 */
function RailHost({ items, rows, onSample }: {
  readonly items: StepChatTurnRailItem[]
  readonly rows: readonly FakeRow[]
  readonly onSample?: (active: number | null) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [activeTurn, setActiveTurn] = useState<number | null>(null)
  const pendingRef = useRef(false)
  const timerRef = useRef<number | undefined>(undefined)
  const sampleRef = useRef<() => void>(() => {})
  const flushRef = useRef<() => void>(() => {})
  sampleRef.current = () => {
    const container = containerRef.current
    if (container === null || items.length === 0) {
      setActiveTurn(null)
      onSample?.(null)
      return
    }
    const next = stepChatSampleTurnAt(container, items)
    setActiveTurn(current => current === next ? current : next)
    onSample?.(next)
  }
  flushRef.current = () => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
    pendingRef.current = false
    sampleRef.current()
  }
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return undefined
    const schedule = (): void => {
      if (pendingRef.current) return
      pendingRef.current = true
      timerRef.current ??= window.setTimeout(() => {
        timerRef.current = undefined
        pendingRef.current = false
        sampleRef.current()
      }, 500)
    }
    const flush = (): void => { flushRef.current() }
    container.addEventListener('scroll', schedule, { passive: true })
    container.addEventListener('scrollend', flush, { passive: true })
    flushRef.current()
    return () => {
      container.removeEventListener('scroll', schedule)
      container.removeEventListener('scrollend', flush)
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
      pendingRef.current = false
    }
  }, [])
  const navigate = (item: StepChatTurnRailItem): void => {
    const container = containerRef.current
    if (container === null || item.anchor.kind !== 'loaded') return
    const row = stepChatAnchorRowIn(container, item.anchor.key)
      ?? stepChatTurnRowIn(container, item.turn)
    if (row === null) return
    // stepChatScrollRowTo：scrollTo（桩）或 scrollTop 回退。
    const flowTop = row.getBoundingClientRect().top - container.getBoundingClientRect().top
    const target = Math.max(0, container.scrollTop + flowTop - 24)
    if (typeof container.scrollTo === 'function') {
      container.scrollTo({ top: target, behavior: 'auto' })
    } else {
      container.scrollTop = target
    }
    setActiveTurn(current => current === item.turn ? current : item.turn)
  }
  return h(
    'div',
    { ref: containerRef, 'data-rail-scrollport': true },
    h(TurnNavigator, { items, activeTurn, onNavigate: navigate, t }),
    rows.map(row => h('div', {
      key: row.key,
      'data-chat-anchor-key': row.key,
      'data-chat-turn': String(row.turn),
      hidden: row.hidden === true || undefined,
    })),
  )
}

describe('TurnNavigator 渲染（jsdom 冒烟）', () => {
  it('renders one mark per rail item with active/focus states and a preview tooltip', () => {
    const host = render(h(TurnNavigator, {
      items: railItems(),
      activeTurn: 1,
      onNavigate: () => {},
      t,
    }))
    const nav = host.querySelector('nav')
    expect(nav).not.toBeNull()
    expect(nav?.getAttribute('aria-label')).toBe('轮次导航')
    const buttons = host.querySelectorAll('nav button')
    expect(buttons).toHaveLength(3)
    const labels = Array.from(buttons).map(button => button.getAttribute('aria-label'))
    expect(labels).toContain('跳转到第 1 轮')
    expect(labels).toContain('跳转到第 3 轮')
    // active 态（aria-current；样式态由 CSS 承担，jsdom 不断言）。
    const active = Array.from(buttons).find(button => button.getAttribute('aria-current') === 'true')
    expect(active?.getAttribute('aria-label')).toBe('跳转到第 1 轮')

    // focus 预览：prompt + response 出现在 tooltip，blur 后消失。
    const second = Array.from(buttons).find(button => button.getAttribute('aria-label') === '跳转到第 2 轮')
    act(() => { second?.focus() })
    const tooltip = host.querySelector('[role="tooltip"]')
    expect(tooltip).not.toBeNull()
    expect(tooltip?.textContent).toContain('继续')
    act(() => { (document.activeElement as HTMLElement | null)?.blur() })
    expect(host.querySelector('[role="tooltip"]')).toBeNull()

    // 无 response 的轮次 tooltip 只显示 prompt 回退；focus 清空后再次验证。
    const third = Array.from(buttons).find(button => button.getAttribute('aria-label') === '跳转到第 3 轮')
    act(() => { third?.focus() })
    const tooltip3 = host.querySelector('[role="tooltip"]')
    expect(tooltip3?.textContent).toContain('执行 B4a')
    expect(tooltip3?.textContent).toContain('已完成右侧轮次轴')
    act(() => { (document.activeElement as HTMLElement | null)?.blur() })
  })

  it('keeps only the zero-height slot (no marks) for a single turn', () => {
    const host = render(h(TurnNavigator, {
      items: [railItems()[0]!],
      activeTurn: 1,
      onNavigate: () => {},
      t,
    }))
    expect(host.querySelector('nav')).toBeNull()
    expect(host.querySelectorAll('nav button')).toHaveLength(0)
  })
})

describe('点击刻度 → onNavigate（StepChatBody 接线同款：锚点行定位）', () => {
  it('scrolls the container to the anchor row; hidden anchor falls back to the first visible row of the turn', () => {
    const rows: FakeRow[] = [
      { key: 'k1', turn: 1 },
      // turn 2 的锚点行是 hidden（进程折叠语义：hidden="until-found" 保留 DOM）…
      { key: 'k2', turn: 2, hidden: true },
      // …但同轮仍有可见行（披露头/后续行），定位回退到它。
      { key: 'k2-visible', turn: 2 },
      { key: 'k3', turn: 3 },
    ]
    const host = render(h(RailHost, { items: railItems(), rows }))
    const container = host.querySelector<HTMLElement>('[data-rail-scrollport]')
    expect(container).not.toBeNull()
    const port = container as HTMLElement

    // 直接断言 key 查找只认可见行、同轮回退找第一可见行。
    expect(stepChatAnchorRowIn(port, 'k2')).toBeNull()
    expect(stepChatAnchorRowIn(port, 'k3')?.dataset.chatAnchorKey).toBe('k3')
    expect(stepChatTurnRowIn(port, 2)?.dataset.chatAnchorKey).toBe('k2-visible')

    // 桩化几何 + scrollTo。
    stubScrollport(port, { clientHeight: 400, scrollHeight: 2000, scrollTop: 0 })
    const scrollTo = vi.fn()
    ;(port as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo
    // 容器 top 50、回退行 top 170 → flowTop 120 → 目标 0 + 120 − 24 = 96。
    stubRect(port, 50)
    const fallbackRow = port.querySelector<HTMLElement>('[data-chat-anchor-key="k2-visible"]')
    expect(fallbackRow).not.toBeNull()
    stubRect(fallbackRow as HTMLElement, 170)

    const second = Array.from(port.querySelectorAll('nav button'))
      .find(button => button.getAttribute('aria-label') === '跳转到第 2 轮')
    act(() => { second?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ top: 96, behavior: 'auto' })
    // 定位后 active 轮次立即落到目标（rail 的 aria-current 移动）。
    const active = Array.from(port.querySelectorAll('nav button'))
      .find(button => button.getAttribute('aria-current') === 'true')
    expect(active?.getAttribute('aria-label')).toBe('跳转到第 2 轮')
  })
})

describe('滚动采样（StepChatBody 同款端口；阅读线 + 贴底）', () => {
  const rows: FakeRow[] = [
    { key: 'r1', turn: 1 },
    { key: 'r2', turn: 2 },
    { key: 'r3', turn: 3 },
  ]

  it('scrollend flush samples the row under the reading line and updates active', () => {
    const onSample = vi.fn<(active: number | null) => void>()
    const host = render(h(RailHost, { items: railItems(), rows, onSample }))
    const container = host.querySelector<HTMLElement>('[data-rail-scrollport]')
    const port = container as HTMLElement

    // 阅读线 = containerTop(0) + min(96, 400×0.2=80) = 80；行 top 20/200/480 →
    // 扫描落在 turn 1（200 > 80 断开）→ active 1。
    stubScrollport(port, { clientHeight: 400, scrollHeight: 2000, scrollTop: 0 })
    const visible = Array.from(port.querySelectorAll<HTMLElement>('[data-chat-turn]:not([hidden])'))
    stubRect(visible[0] as HTMLElement, 20)
    stubRect(visible[1] as HTMLElement, 200)
    stubRect(visible[2] as HTMLElement, 480)

    act(() => { port.dispatchEvent(new Event('scrollend')) })
    expect(onSample).toHaveBeenLastCalledWith(1)
    const active = Array.from(port.querySelectorAll('nav button'))
      .find(button => button.getAttribute('aria-current') === 'true')
    expect(active?.getAttribute('aria-label')).toBe('跳转到第 1 轮')

    // 贴底：scrollTop 600 + clientHeight 400 距底 0 ≤ 25 → active = 最新 offer 3
    // （阅读线场景同时失效：即使行 top 不变也以最新为准）。
    stubScrollport(port, { clientHeight: 400, scrollHeight: 1000, scrollTop: 600 })
    act(() => { port.dispatchEvent(new Event('scrollend')) })
    expect(onSample).toHaveBeenLastCalledWith(3)
    const activeBottom = Array.from(port.querySelectorAll('nav button'))
      .find(button => button.getAttribute('aria-current') === 'true')
    expect(activeBottom?.getAttribute('aria-label')).toBe('跳转到第 3 轮')
  })

  it('keeps the flow-head mark while no visible row covers the reading line', () => {
    const onSample = vi.fn<(active: number | null) => void>()
    const host = render(h(RailHost, { items: railItems(), rows, onSample }))
    const container = host.querySelector<HTMLElement>('[data-rail-scrollport]')
    const port = container as HTMLElement

    // 阅读线下方没有任何行（首行 top 300 > 80）且未贴底 → 流头（第 1 轮）占有。
    stubScrollport(port, { clientHeight: 400, scrollHeight: 2000, scrollTop: 0 })
    const visible = Array.from(port.querySelectorAll<HTMLElement>('[data-chat-turn]:not([hidden])'))
    for (const row of visible) stubRect(row, 300)

    act(() => { port.dispatchEvent(new Event('scrollend')) })
    expect(onSample).toHaveBeenLastCalledWith(1)
  })
})
