/**
 * unified-timeline-remount.spec（批 B2；@vitest-environment jsdom）：面板**换挂**契约。
 *
 * 为什么需要：fork/revert 重试会换 `sessionMeta.childId`（引擎 forkSession + createAgent），
 * 时间线随后送来同一个 stepId 但新 childId 的段。若面板实例被 React 复用，它仍持着旧
 * binding/开窗结果（旧会话已被 DSH dispose），会停在 loading/错误占位上——所以
 * `UnifiedTimeline` 的每个 StepChatPanel 挂载点都必须带 `key={item.childId ?? item.stepId}`：
 * key 换值 → 老面板卸载、新面板挂载（重新解析 binding/开窗/重探输入内核）。
 *
 * 测法：把 `./StepChatPanel.tsx` 换成桩（**只在真正新实例化时**记录一条构造日志——
 * 用 useState 初始化器，而不是 effect：effect 在「同实例换 props」时也会重跑，无法区分
 * 复用与重挂）。于是「childId 变化 → 构造日志 +1 且 DOM 节点换新」就是 key 生效的证据。
 *
 * 同时锁：failed 的真实子代理段现在也内嵌面板（批 B2 重试入口所在），合成会话（shell）
 * 仍不渲染面板。
 *
 * **需求 3（本次变更）**：completed 的真实子代理段**也**挂面板（不再用收尾总结替换
 * step 下方的会话区），且此时不渲染「Agent 输出」摘要（compressedOutput / outputText）；
 * 合成会话（shell）保持原样——不挂面板、completed 仍显示命令输出。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/unified-timeline-remount.spec
 */
// @vitest-environment jsdom
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

/** 面板桩的构造/卸载日志（vi.hoisted：mock 工厂与用例共享同一对象）。 */
const panelLog = vi.hoisted(() => ({
  /** 每次**新实例化**推一次会话 id（React 复用实例时不会新增）。 */
  constructed: [] as string[],
  /** 卸载（effect cleanup）推一次会话 id。 */
  unmounted: [] as string[],
}))

// primitives 全部替换为最小行为桩（primitives 发布产物自带 *.module.css）。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement: el, Fragment: F } = await import('react')
  const icon = (label: string) => () => el('svg', { 'data-icon': label, 'aria-hidden': true })
  return {
    MarkdownText: (props: { text?: string }) => el('p', null, props.text),
    ReferenceIcon: () => el('span'),
    Tooltip: (props: { children?: ReactNode }) => el(F, null, props.children),
    IconSparkle16: icon('sparkle'),
    // 主代理卡片卡头的折叠箭头（整条卡头是折叠开关，见 MainAgentChatBlock）。
    IconChevronDownOutline14: icon('chevron-down'),
  }
})

// 面板桩：真正的「新实例」只有 useState 初始化器能观察到（effect 在同实例换 props 时也跑）。
// 主代理卡片也会渲染同一个 StepChatPanel（`variant="main"`），且它的状态 chip 需要
// `stepChatSessionsOf()`——桩里一并给出（无 sessions 服务 → 视为空闲，chip 显示「已就绪」）。
vi.mock('./StepChatPanel.tsx', async () => {
  const { createElement, useEffect, useState } = await import('react')
  return {
    stepChatSessionsOf: () => undefined,
    StepChatPanel: (props: {
      readonly sessionId?: string
      readonly instanceId?: string
      readonly parentSessionId?: string
      readonly retry?: unknown
      readonly variant?: string
    }) => {
      const [mountedId] = useState(() => {
        const id = String(props.sessionId)
        panelLog.constructed.push(id)
        return id
      })
      useEffect(() => () => { panelLog.unmounted.push(mountedId) }, [mountedId])
      return createElement('div', {
        'data-stub-step-chat': mountedId,
        'data-stub-has-retry': props.retry === undefined ? 'no' : 'yes',
        'data-stub-variant': props.variant ?? 'subagent',
      })
    },
  }
})

import { zh } from './locales.ts'
import type { TimelineItem, TimelineStepItem } from './run-view-model.ts'
import { UnifiedTimeline } from './UnifiedTimeline.tsx'
import type { StepRetryActions } from './step-view/step-retry.ts'

/** sandore zh 字典桩翻译（与其它 client spec 同款）。 */
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

beforeEach(() => {
  panelLog.constructed.length = 0
  panelLog.unmounted.length = 0
})

const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
})

/** 一条 step 时间线项（默认：failed 的真实子代理段）。 */
function stepItem(overrides: Partial<TimelineStepItem> = {}): TimelineStepItem {
  return {
    kind: 'step',
    stepId: 'step-a',
    name: '构建',
    status: 'failed',
    visitCount: 1,
    error: 'boom',
    childId: 'child-1',
    commandType: 'prompt',
    synthetic: false,
    ...overrides,
  }
}

/** 可重渲染的宿主（同一 React root：重挂断言需要跨渲染比较）。 */
function mount(items: readonly TimelineItem[], retry?: StepRetryActions, main?: {
  readonly hostSessionId?: string
  readonly shown: boolean
  readonly outputCount?: number
  readonly terminal?: boolean
}, extras?: {
  /** 打开会话的探针（收尾/门禁/判断徽标断言用）。 */
  readonly openSession?: (id: string, parentSessionId?: string) => void
  /** 实例 id（= 宿主主代理会话 id，徽标的 durable parent）。 */
  readonly instanceId?: string
}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  const render = (next: readonly TimelineItem[], mainNext?: {
    readonly shown: boolean
    readonly outputCount?: number
    readonly terminal?: boolean
  }): void => {
    const effective = mainNext ?? main
    act(() => {
      root.render(h(UnifiedTimeline, {
        t,
        items: next,
        openSession: extras?.openSession ?? (() => {}),
        ...(retry === undefined ? {} : { retry }),
        ...(extras?.instanceId === undefined ? {} : { instanceId: extras.instanceId }),
        ...(effective === undefined
          ? {}
          : {
            hostSessionId: main?.hostSessionId ?? 'host-1',
            mainChat: {
              shown: effective.shown,
              ...(effective.outputCount === undefined ? {} : { outputCount: effective.outputCount }),
              ...(effective.terminal === undefined ? {} : { terminal: effective.terminal }),
            },
          }),
      }))
    })
  }
  render(items)
  return { host, render }
}

describe('StepChatPanel 挂载 key（childId 变化 → 重挂）', () => {
  it('renders the panel for a failed real subagent segment (B2 retry entry)', () => {
    const { host } = mount([stepItem()])
    const panel = host.querySelector('[data-stub-step-chat]')
    expect(panel?.getAttribute('data-stub-step-chat')).toBe('child-1')
    // 失败原因仍在（面板是追加，不替换错误块）。
    expect(host.textContent).toContain('boom')
  })

  it('remounts the panel when the retry swaps the child session id', () => {
    const { host, render } = mount([stepItem()])
    const before = host.querySelector('[data-stub-step-chat]')
    expect(panelLog.constructed).toEqual(['child-1'])
    // fork/revert 重试落地：同 stepId、同状态分支、**新 childId**（引擎 forkSession +
    // createAgent；重试失败也会以新 childId 的 failed 段定格）。同分支同位置 → 唯一
    // 让 React 换实例的机制就是 key：没有 key 时这里会复用旧实例（旧 binding 已随子
    // 会话 dispose 失效，面板会停在 loading）。
    render([stepItem({ childId: 'child-2' })])
    expect(panelLog.constructed).toEqual(['child-1', 'child-2'])
    expect(panelLog.unmounted).toEqual(['child-1'])
    const after = host.querySelector('[data-stub-step-chat]')
    expect(after?.getAttribute('data-stub-step-chat')).toBe('child-2')
    expect(after).not.toBe(before)
  })

  it('shows the new child session when the retried segment comes back running', () => {
    // 真实闭环的常见形态：failed → 重试受理 → 新段 running（childId 已换）。
    const { host, render } = mount([stepItem()])
    render([stepItem({ childId: 'child-2', status: 'running' })])
    expect(host.querySelector('[data-stub-step-chat]')?.getAttribute('data-stub-step-chat')).toBe('child-2')
    expect(host.querySelector('[data-stub-step-chat]')).not.toBeNull()
  })

  it('keeps the same panel instance while the child session id is unchanged', () => {
    const { host, render } = mount([stepItem()])
    const before = host.querySelector('[data-stub-step-chat]')
    // 同 childId 的轮询刷新（内容变化但会话没变）：不得重挂（保留滚动位置 / 重试行态 /
    // 会话 binding 与已加载历史）。
    render([stepItem({ error: 'boom2' })])
    expect(panelLog.constructed).toEqual(['child-1'])
    expect(host.querySelector('[data-stub-step-chat]')).toBe(before)
    expect(host.textContent).toContain('boom2')
  })

  it('passes the retry port down to the panel', () => {
    const retry: StepRetryActions = {
      retry: async () => undefined,
      listBoundaries: async () => [],
    }
    const { host } = mount([stepItem()], retry)
    expect(host.querySelector('[data-stub-step-chat]')?.getAttribute('data-stub-has-retry')).toBe('yes')
    // 不给端口（旧调用方）→ 面板收不到 retry（内部按可见性收窄后不渲染重试行）。
    const plain = mount([stepItem()])
    expect(plain.host.querySelector('[data-stub-step-chat]')?.getAttribute('data-stub-has-retry')).toBe('no')
  })
})

describe('合成会话 / 其它状态的面板可见性', () => {
  it('never renders the panel for a synthetic shell segment', () => {
    const { host } = mount([stepItem({ synthetic: true, commandType: 'shell', childId: 'shell-1' })])
    expect(host.querySelector('[data-stub-step-chat]')).toBeNull()
    expect(panelLog.constructed).toEqual([])
  })

  it('still renders the panel for paused real subagent segments', () => {
    const { host } = mount([stepItem({ status: 'paused' })])
    expect(host.querySelector('[data-stub-step-chat]')).not.toBeNull()
  })
})

describe('需求 3：completed 段保留会话区、不再用收尾总结替换', () => {
  /** completed 段（带收尾总结 compressedOutput + 原始 output）。 */
  function completedItem(overrides: Partial<TimelineStepItem> = {}): TimelineStepItem {
    return stepItem({
      status: 'completed',
      error: undefined,
      outputText: 'AGENT-OUTPUT-RAW',
      finalizeAssessResult: { assessmentRaw: '{}', compressedOutput: 'AGENT-OUTPUT-SUMMARY' },
      ...overrides,
    })
  }

  it('mounts the panel for a completed real subagent segment', () => {
    const { host } = mount([completedItem()])
    expect(host.querySelector('[data-stub-step-chat]')?.getAttribute('data-stub-step-chat')).toBe('child-1')
  })

  it('never renders the收尾总结 summary in place of the会话区', () => {
    const { host } = mount([completedItem()])
    // 关键断言：收尾总结（compressedOutput）与原始 output 都**不再**显示在卡片下方
    // ——它们仍照旧作为传给后续 step 的输出内容留在引擎数据层（本用例不碰引擎）。
    expect(host.textContent ?? '').not.toContain('AGENT-OUTPUT-SUMMARY')
    expect(host.textContent ?? '').not.toContain('AGENT-OUTPUT-RAW')
    // 会话区在（而不是只剩一段总结文本）。
    expect(host.querySelector('[data-stub-step-chat]')).not.toBeNull()
  })

  it('keeps the shell behaviour: completed shell step shows its output and no panel', () => {
    const { host } = mount([stepItem({
      status: 'completed',
      error: undefined,
      outputText: 'SHELL-ECHO-OUT',
      synthetic: true,
      commandType: 'shell',
      childId: 'shell-1',
    })])
    expect(host.querySelector('[data-stub-step-chat]')).toBeNull()
    expect(host.textContent ?? '').toContain('SHELL-ECHO-OUT')
  })

  it('does not remount the panel when the segment settles running → completed', () => {
    // 单点挂载位的意义：状态翻转（running → completed）不重挂面板，同一实例继续持有
    // 会话 binding 与已加载历史（否则每完成一次都会重新开窗/重拉历史）。
    const { host, render } = mount([stepItem({ status: 'running', error: undefined })])
    expect(panelLog.constructed).toEqual(['child-1'])
    render([completedItem()])
    expect(panelLog.constructed).toEqual(['child-1'])
    expect(panelLog.unmounted).toEqual([])
    expect(host.querySelector('[data-stub-step-chat]')).not.toBeNull()
  })
})

describe('呈现层统一 · 需求 3（三轮真机修正）：主代理卡片 = 独立卡片、始终最后、默认折叠', () => {
  /** 一条 running + 一条 completed 的真实子代理段（真机场景：sce1 跑、sce2 已完成）。 */
  function mixedSteps(): readonly TimelineItem[] {
    return [
      stepItem({ stepId: 'step-a', name: '构建', status: 'running', error: undefined, childId: 'child-a' }),
      stepItem({ stepId: 'step-b', name: '部署', status: 'completed', error: undefined, childId: 'child-b' }),
    ]
  }

  it('renders the card as a SIBLING at the very END of the step list (never inside any step card)', () => {
    const { host } = mount(mixedSteps(), undefined, { shown: true })
    const flow = host.querySelector('[data-sandore-timeline]')!
    const children = [...flow.children]
    const cardIndex = children.findIndex(child => child.hasAttribute('data-tl-main-agent'))
    // ① 同级：主代理卡片是步骤列表容器的**直接子节点**（不是任何 step 卡片的后代）。
    expect(cardIndex).toBeGreaterThanOrEqual(0)
    expect(host.querySelector('[data-tl-step] [data-tl-main-agent]')).toBeNull()
    expect(host.querySelector('[data-tl-step] [data-main-agent-chat]')).toBeNull()
    // ② 位置：**始终最后一张**（真机反馈：「主代理只有一个，一直放到最下面的 step」）。
    expect(cardIndex).toBe(children.length - 1)
    // ③ 内容：卡头（头像字母 M + 标题「主代理」）常驻；卡体默认**折叠**。
    const card = children[cardIndex]!
    expect(card.querySelector('[data-tl-main-agent-avatar]')?.textContent).toBe('M')
    expect(card.querySelector('[data-tl-main-agent-title]')?.textContent).toBe('主代理')
    expect(card.querySelector('[data-tl-main-agent-toggle]')?.getAttribute('aria-expanded')).toBe('false')
    expect(card.querySelector('[data-stub-step-chat]')).toBeNull()
  })

  it('expands on a new message, auto-collapses after 3s of silence, and re-expands on the next one', () => {
    vi.useFakeTimers()
    try {
      // 首帧：主代理已有 1 条消息（卡片刚出现）⇒ 默认折叠。
      const { host, render } = mount(mixedSteps(), undefined, { shown: true, outputCount: 1 })
      const toggle = (): Element | null => host.querySelector('[data-tl-main-agent-toggle]')
      const cardBody = (): Element | null =>
        host.querySelector('[data-tl-main-agent] [data-stub-step-chat]')
      expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
      expect(cardBody(), '折叠时卡体（消息区）不渲染').toBeNull()
      // 主代理又来一条 ⇒ 展开（卡体渲染宿主会话面板）。
      render(mixedSteps(), { shown: true, outputCount: 2 })
      expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
      expect(cardBody()?.getAttribute('data-stub-step-chat'), '展开后卡体渲染的是宿主会话').toBe('host-1')
      // **消息不再更新 3 秒 → 自动折叠**（用户规格常量 MAIN_AGENT_AUTO_COLLAPSE_MS = 3000）。
      act(() => { vi.advanceTimersByTime(2_900) })
      expect(toggle()?.getAttribute('aria-expanded'), '不满 3s 不折叠').toBe('true')
      act(() => { vi.advanceTimersByTime(200) })
      expect(toggle()?.getAttribute('aria-expanded'), '满 3s 自动折叠').toBe('false')
      expect(cardBody()).toBeNull()
      // 又来一条新消息 ⇒ 再次展开（并重新计时）。
      render(mixedSteps(), { shown: true, outputCount: 3 })
      expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
      act(() => { vi.advanceTimersByTime(3_100) })
      expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps manual collapse until a NEW message arrives (manual decision wins)', () => {
    vi.useFakeTimers()
    try {
      const { host, render } = mount(mixedSteps(), undefined, { shown: true, outputCount: 1 })
      const toggle = (): Element | null => host.querySelector('[data-tl-main-agent-toggle]')
      render(mixedSteps(), { shown: true, outputCount: 2 })
      expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
      // 手动折叠 → 立即生效，且**取消挂起的自动折叠计时**（不会因为计时器到点而反复）。
      act(() => { (toggle() as HTMLElement).click() })
      expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
      // 同一条消息的重渲染（条数不变）**不会**把它弹开（手动优先）。
      render(mixedSteps(), { shown: true, outputCount: 2 })
      act(() => { vi.advanceTimersByTime(5_000) })
      expect(toggle()?.getAttribute('aria-expanded'), '手动折叠后不被同一条消息弹开').toBe('false')
      // 手动展开 → 也不会被自动折叠（计时器已取消）。
      act(() => { (toggle() as HTMLElement).click() })
      act(() => { vi.advanceTimersByTime(5_000) })
      expect(toggle()?.getAttribute('aria-expanded'), '手动展开不会被自动折叠').toBe('true')
      // 又来**新**消息 → 仍然展开（本来就是展开态，这里只验证不冲突）。
      render(mixedSteps(), { shown: true, outputCount: 3 })
      expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
    } finally {
      vi.useRealTimers()
    }
  })

  it('forces the card open at terminal status and never auto-collapses afterwards', () => {
    vi.useFakeTimers()
    try {
      // 终态 + 已有消息：**强制展开**（覆盖自动折叠）——同时修掉真机缺陷「完成后卡体为空」。
      const { host } = mount(mixedSteps(), undefined, {
        shown: true,
        outputCount: 2,
        terminal: true,
      })
      const toggle = (): Element | null => host.querySelector('[data-tl-main-agent-toggle]')
      expect(toggle()?.getAttribute('aria-expanded'), '终态默认展开').toBe('true')
      expect(
        host.querySelector('[data-tl-main-agent] [data-stub-step-chat]')?.getAttribute('data-stub-step-chat'),
        '终态卡体必须真的渲染宿主会话（内容不为空）',
      ).toBe('host-1')
      // 终态后即使再过很久也不自动折叠。
      act(() => { vi.advanceTimersByTime(30_000) })
      expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
      // 终态下用户仍可手动折叠（手动优先），但不会自动弹回。
      act(() => { (toggle() as HTMLElement).click() })
      expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
    } finally {
      vi.useRealTimers()
    }
  })

  it('toggles from EVERY region of the card head (avatar / title / status / chevron / blank)', () => {
    // 真机缺陷（本轮修复）：原先只有窄窄的状态 chip 绑了 onClick —— 点头像/标题/空白处
    // 都没反应，用户报「点击没法展开」。现在整条卡头是一个 `<button>`，其内任意子区域
    // 的点击都会冒泡到它；本用例逐区域点击验证（每次都从折叠态开始）。
    const { host } = mount(mixedSteps(), undefined, { shown: true, outputCount: 2 })
    const toggle = (): Element | null => host.querySelector('[data-tl-main-agent-toggle]')
    const cardBody = (): Element | null =>
      host.querySelector('[data-tl-main-agent] [data-stub-step-chat]')
    const regions: readonly (readonly [string, string | null])[] = [
      ['avatar', '[data-tl-main-agent-avatar]'],
      ['title', '[data-tl-main-agent-title]'],
      ['status chip', '[data-tl-main-agent-status]'],
      ['chevron', '[data-tl-main-agent-chevron]'],
      ['整条卡头（空白处）', null],
    ]
    for (const [label, selector] of regions) {
      // 先手动折叠到一个确定的起点（终态未给 ⇒ 不会强制展开）。
      if (toggle()?.getAttribute('aria-expanded') === 'true') {
        act(() => { (toggle() as HTMLElement).click() })
      }
      expect(toggle()?.getAttribute('aria-expanded'), `${label}：起点应为折叠`).toBe('false')
      const target = selector === null ? (toggle() as HTMLElement) : (host.querySelector(selector) as HTMLElement)
      expect(target, `${label}：应能找到可点元素`).not.toBeNull()
      // 点击**子区域**（冒泡到卡头按钮）——正是真机上点不到的那些位置。
      act(() => { target.click() })
      expect(toggle()?.getAttribute('aria-expanded'), `点击「${label}」应展开`).toBe('true')
      expect(cardBody(), `点击「${label}」后卡体应渲染`).not.toBeNull()
    }
    // 卡头是真正的按钮（键盘可达）+ aria-expanded 语义。
    expect(toggle()?.tagName).toBe('BUTTON')
    expect(toggle()?.getAttribute('type')).toBe('button')
  })

  it('keeps the manual expansion for good (no pending auto-collapse timer survives the click)', () => {
    vi.useFakeTimers()
    try {
      const { host, render } = mount(mixedSteps(), undefined, { shown: true, outputCount: 1 })
      const toggle = (): Element | null => host.querySelector('[data-tl-main-agent-toggle]')
      // 新消息 → 展开并起 3s 自动折叠计时……
      render(mixedSteps(), { shown: true, outputCount: 2 })
      expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
      // ……用户在计时到点前手动折叠再展开：挂起的计时必须被取消，
      // 否则展开会在 3 秒内被自动收回（真机上就是「点不开/刚开就收」）。
      act(() => { (toggle() as HTMLElement).click() })
      act(() => { (toggle() as HTMLElement).click() })
      expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
      act(() => { vi.advanceTimersByTime(10_000) })
      expect(toggle()?.getAttribute('aria-expanded'), '手动展开后 >3s 仍应保持展开').toBe('true')
      // 卡体仍在 DOM（桩面板；真实面板的锚点由 e2e 断言）。
      expect(host.querySelector('[data-tl-main-agent] [data-stub-step-chat]')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the card out of the timeline entirely until it is shown', () => {
    const { host } = mount(mixedSteps(), undefined, { shown: false })
    expect(host.querySelector('[data-tl-main-agent]')).toBeNull()
    // 连空壳/标题都没有（用户要求「主代理有消息才插入」）。
    expect(host.textContent ?? '').not.toContain('工作流宿主会话')
  })

  it('stays last when execution advances (no more moving around the list)', () => {
    const { host, render } = mount(mixedSteps(), undefined, { shown: true })
    const flow = host.querySelector('[data-sandore-timeline]')!
    expect([...flow.children].findIndex(child => child.hasAttribute('data-tl-main-agent')))
      .toBe(flow.children.length - 1)
    // 执行推进：step-a 完成、step-b 开始 → 卡片仍在最末（真机反馈后不再跟随执行锚点）。
    render([
      stepItem({ stepId: 'step-a', name: '构建', status: 'completed', error: undefined, childId: 'child-a' }),
      stepItem({ stepId: 'step-b', name: '部署', status: 'running', error: undefined, childId: 'child-b' }),
    ])
    const after = [...host.querySelectorAll('[data-sandore-timeline] > *')]
    expect(after.findIndex(child => child.hasAttribute('data-tl-main-agent'))).toBe(after.length - 1)
    expect(host.querySelector('[data-tl-step] [data-tl-main-agent]')).toBeNull()
  })

  it('keeps exactly ONE card while collapsed and while toggling (no duplicate instances)', () => {
    const { host } = mount(mixedSteps(), undefined, { shown: true, outputCount: 1 })
    const toggle = (): Element | null => host.querySelector('[data-tl-main-agent-toggle]')
    // 折叠态：全局仍恰 1 张，且仍在最后。
    expect(host.querySelectorAll('[data-tl-main-agent]')).toHaveLength(1)
    const flow = host.querySelector('[data-sandore-timeline]')!
    expect(flow.lastElementChild?.hasAttribute('data-tl-main-agent')).toBe(true)
    // 反复开合不产生第二张卡片（真机反馈的「每步一张」防复发）。
    act(() => { (toggle() as HTMLElement).click() })
    expect(host.querySelectorAll('[data-tl-main-agent]')).toHaveLength(1)
    act(() => { (toggle() as HTMLElement).click() })
    expect(host.querySelectorAll('[data-tl-main-agent]')).toHaveLength(1)
    expect(host.querySelector('[data-tl-step] [data-tl-main-agent]')).toBeNull()
  })
})

describe('Step 卡片收尾 / 门禁 / 判断徽标（点击进入子代理会话）', () => {
  /** 三个阶段徽标都处于「进行中」的 step 项（各自带自己的子代理会话 id）。 */
  const phaseItem = (): TimelineStepItem => stepItem({
    status: 'running',
    childId: 'child-step',
    assessStatus: 'running',
    finalizeAssessSessionId: 'assess-1',
    gateStatus: 'running',
    finalizeGateSessionId: 'gate-1',
    routingStatus: 'running',
    finalizeRoutingSessionId: 'route-1',
  })

  it('opens the matching subagent with the host session as durable parent (all three badges)', () => {
    const calls: Array<readonly [string, string | undefined]> = []
    const { host } = mount([phaseItem()], undefined, undefined, {
      openSession: (id, parentSessionId) => { calls.push([id, parentSessionId]) },
      instanceId: 'inst-host',
    })
    for (const phase of ['finalizing', 'gating', 'routing']) {
      const badge = host.querySelector(`[data-tl-step-phase="${phase}"]`)
      expect(badge, `${phase} 徽标应是按钮（可点进子代理会话）`).not.toBeNull()
      act(() => { (badge as HTMLElement).click() })
    }
    // 三条 lane 一律带 durable 父（宿主主代理会话）：收尾 fork / 门禁 continuable / 路由 fork
    // 都由引擎建在宿主主代理名下（`meta.parentSession = hostAgent.id ≡ instanceId`），
    // 少传 parent 会走普通 open → 宿主 validateAddress 恒拒（真机「历史加载失败：
    // subagent Sessions require their durable parent address」）。
    expect(calls).toEqual([
      ['assess-1', 'inst-host'],
      ['gate-1', 'inst-host'],
      ['route-1', 'inst-host'],
    ])
  })

  it('does not collapse the step card when a phase badge is clicked (only the status button folds)', () => {
    const { host } = mount([phaseItem()], undefined, undefined, {
      openSession: () => {},
      instanceId: 'inst-host',
    })
    // 未折叠：卡体（面板桩）在 DOM 里。
    expect(host.querySelector('[data-stub-step-chat]')).not.toBeNull()
    act(() => { (host.querySelector('[data-tl-step-phase="gating"]') as HTMLElement).click() })
    // 点标签不得折叠：卡体仍在。
    expect(host.querySelector('[data-stub-step-chat]'), '点标签不应把 step 卡片折叠').not.toBeNull()
    // 头部状态按钮仍能折叠（折叠功能没被弄坏）——它是头部里唯一带 aria-expanded 的按钮。
    const status = host.querySelector('[data-tl-step] button[aria-expanded]')
    expect(status).not.toBeNull()
    act(() => { (status as HTMLElement).click() })
    expect(host.querySelector('[data-stub-step-chat]'), '点状态按钮应折叠卡体').toBeNull()
  })

  it('keeps completed-phase badges clickable with the same durable parent', () => {
    const calls: Array<readonly [string, string | undefined]> = []
    const { host } = mount([stepItem({
      status: 'completed',
      childId: 'child-step',
      assessStatus: 'done',
      finalizeAssessSessionId: 'assess-1',
      gateStatus: 'done',
      finalizeGateSessionId: 'gate-1',
      routingStatus: 'done',
      finalizeRoutingSessionId: 'route-1',
    })], undefined, undefined, {
      openSession: (id, parentSessionId) => { calls.push([id, parentSessionId]) },
      instanceId: 'inst-host',
    })
    for (const phase of ['finalizing', 'gating', 'routing']) {
      const badge = host.querySelector(`[data-tl-step-phase="${phase}"]`)
      expect(badge, `已完成态的 ${phase} 徽标也应可点`).not.toBeNull()
      act(() => { (badge as HTMLElement).click() })
    }
    expect(calls).toEqual([
      ['assess-1', 'inst-host'],
      ['gate-1', 'inst-host'],
      ['route-1', 'inst-host'],
    ])
  })
})

describe('UserMsg 徽标（只认 kind:input）', () => {
  /** 一条用户消息项（`messageKind` 可覆盖成遗留 kind，模拟「过滤前先到组件」）。 */
  function userItem(overrides: Partial<Extract<TimelineItem, { readonly kind: 'user' }>> = {})
    : Extract<TimelineItem, { readonly kind: 'user' }> {
    return {
      kind: 'user',
      content: '原始需求 do it',
      time: '2026-01-01T00:00:02.000Z',
      messageKind: 'input',
      target: '',
      ...overrides,
    }
  }

  it('renders the 需求 badge for a real user input row', () => {
    const { host } = mount([userItem()])
    const row = host.querySelector('[data-tl-user]')
    expect(row).not.toBeNull()
    expect(row?.textContent).toContain('原始需求 do it')
    // 徽标是行内的一个标签（`data-tl-user-kind` 挂在徽标 span 上），文案取自 zh 字典。
    const badge = row?.querySelector('[data-tl-user-kind]')
    expect(badge?.getAttribute('data-tl-user-kind')).toBe('input')
    expect(badge?.textContent).toBe('需求')
  })

  it('renders no kind badge for a legacy kind (badge never claims a legacy label)', () => {
    // buildTimeline 已把遗留 kind 过滤掉（run-view-model.spec 锁那里的口径）；这里额外锁
    // 组件自身的防线：即便遗留 kind 的 item 直接送进来，也只会是一行**无徽标**的用户气泡，
    // 不会再出现「继续/重试/回答/讨论」这类指令性徽标。
    for (const legacy of ['resume', 'retry', 'answer', 'message']) {
      const { host } = mount([userItem({ messageKind: legacy, content: `遗留 ${legacy}` })])
      const row = host.querySelector('[data-tl-user]')
      expect(row?.textContent).toContain(`遗留 ${legacy}`)
      expect(row?.querySelector('[data-tl-user-kind]'), `${legacy} 不应带 kind 徽标`).toBeNull()
      expect(row?.textContent).not.toContain('需求')
    }
  })

  it('renders no badge for an item without messageKind (older snapshots)', () => {
    const { host } = mount([userItem({ messageKind: undefined })])
    expect(host.querySelector('[data-tl-user] [data-tl-user-kind]')).toBeNull()
  })
})
