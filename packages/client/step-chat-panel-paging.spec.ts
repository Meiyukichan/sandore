/**
 * StepChatPanel（面板主体 StepChatBody）的分页/自动补齐/出口 jsdom 冒烟
 * （批 A / A1+A3+A4；批 A2 追加自动补齐）：
 * - 「加载更早」按钮：hasMore 才出现、loadingOlder 时 disabled、点击调用
 *   session.loadOlder()；prepend 落地后按 ΔscrollHeight 保位（roll 到原阅读位）；
 * - 滚动契约：面板自己的滚动器带 `data-conversation-scroll`，且在其内联 style 上
 *   发布了 --dsh-composer-height / --dsh-conversation-viewport-height（官方
 *   ConversationRoot 在滚动体上发布的同族变量）；
 * - 官方出口：error 态「用 DSH 原生对话打开」按钮点击后走
 *   `sessions.openSubagent({ parentSessionId, childSessionId, mode:'continuable' })`
 *   （parent 缺失时才回退 subagentAddress/open）；
 * - 批 A2 自动补齐：面板可见 + hasMore 时自动连续 loadOlder 直到 hasMore=false
 *   （桩按序返回 hasMore 序列）→ 「加载更早」按钮消失；进行中列首显示提示行
 *   （`[data-step-chat-autofill]`）且不显示手动按钮；达到页数上限后按钮仍在；
 *   不可见（IntersectionObserver 报不在视口内）时不投递；离屏即停。
 *
 * 策略与 step-view-render.spec 一致：jsdom + react-dom/client + primitives 桩
 * （primitives 的发布产物自带 *.module.css，vitest 默认外置 node_modules 不处理
 * CSS）。视觉/CSS 不做断言（jsdom 无排版），只断言组件树、DOM 属性与调用形状。
 *
 * 可见性（批 A2）：jsdom 没有 IntersectionObserver，故本文件装一个可控桩（见下方
 * ioObservers / setPanelVisible），把「面板是否在视口内」变成显式测试输入。A1/A3/A4
 * 的用例都是「用户在看着手动按钮」的场景，缺省**不可见**——自动补齐因此不介入，
 * 这些用例锁的仍是手动路径本身。
 *
 * 面板主体经 viewFeed 全额注入（不走真实 uiConversation target）：本文件锁的是
 * 面板对「分页读取面 + 自动补齐 + 滚动契约 + 原生出口」接线的行为，feed 装配本身
 * 由 step-chat-source.spec 覆盖。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-chat-panel-paging.spec
 */
// @vitest-environment jsdom
// React 18 需要显式声明 act 环境（否则每个 act 调用打 warning）。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, Fragment, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

// primitives 全部替换为最小行为桩（同 step-view-render.spec 的理由与做法）。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement: el, Fragment: F } = await import('react')
  const icon = (label: string) => (props: { size?: number }) => el('svg', {
    'data-icon': label,
    'aria-hidden': true,
    ...(props?.size === undefined ? {} : { width: props.size, height: props.size }),
  })
  return {
    Button: (props: { children?: ReactNode; onClick?: () => void; variant?: string; 'data-step-chat-open-native'?: string }) => el(
      'button',
      {
        type: 'button',
        'data-primitive': 'button',
        'data-variant': props.variant,
        ...(props['data-step-chat-open-native'] === undefined
          ? {}
          : { 'data-step-chat-open-native': props['data-step-chat-open-native'] }),
        onClick: props.onClick,
      },
      props.children,
    ),
    Modal: (props: { title?: ReactNode; description?: ReactNode }) => el('div', { 'data-primitive': 'modal' }, props.title, props.description),
    DisclosureRow: (props: { title?: ReactNode; collapsedContent?: ReactNode; children?: ReactNode }) => el('div', null, props.title, props.collapsedContent, props.children),
    MarkdownText: (props: { text?: string }) => el('p', { 'data-markdown': true }, props.text),
    JsonBlock: (props: { label?: ReactNode; payload?: unknown }) => el('div', null, props.label, JSON.stringify(props.payload)),
    projectUserText: (text?: string) => el('span', null, text),
    ReferenceIcon: (props: { kind?: string }) => el('span', { 'data-reference-icon': props.kind }),
    Tooltip: (props: { children?: ReactNode }) => el(F, null, props.children),
    writeClipboard: async () => true,
    StateDot: (props: { state?: string }) => el('span', { 'data-state-dot': props.state }),
    CodeBlock: (props: { code?: string }) => el('pre', { 'data-block': 'code' }, props.code),
    TerminalBlock: (props: Record<string, unknown>) => el('div', { 'data-block': 'terminal' }, String(props.output ?? '')),
    DiffBlock: () => el('div', { 'data-block': 'diff' }),
    ReadBlock: () => el('div', { 'data-block': 'read' }),
    SearchBlock: () => el('div', { 'data-block': 'search' }),
    WebBlock: () => el('div', { 'data-block': 'web' }),
    diffTotals: () => ({ added: 0, removed: 0 }),
    IconThinkOutline14: icon('think'),
    IconBrowseOutline16: icon('browse'),
    IconContextInjectionOutline16: icon('context'),
    IconCopyOutline16: icon('copy'),
    IconCheckOutline16: icon('check'),
    IconBranchOutline16: icon('branch'),
    IconApiOutline14: icon('api'),
    IconChevronDownOutline14: icon('chevron-down'),
    IconChevronRightOutline14: icon('chevron-right'),
    IconCodeOutline16: icon('code'),
    IconEditOutline16: icon('edit'),
    IconSearchOutline16: icon('search'),
    IconSparkle16: icon('sparkle'),
    IconClockOutline16: icon('clock'),
    IconDatabaseOutline16: icon('database'),
  }
})

// 保位纯函数单独 spy：它的**调用载荷**（before/after 两组几何）就是本文件要锁的
// 「prepend 保位」行为；真正的算术由 step-chat-paging.spec 覆盖。
// vi.mock 工厂被提升到 import 之前，工厂内不得引用外部变量——故 spy 在工厂内
// 创建，并在测试里从同一个被 mock 的模块 import 出来使用。
vi.mock('./step-chat-paging.ts', async () => {
  const actual = await vi.importActual<typeof import('./step-chat-paging.ts')>('./step-chat-paging.ts')
  return { ...actual, stepChatPrependScrollTopOf: vi.fn(actual.stepChatPrependScrollTopOf) }
})

import type { SandoreRenderMessageImages } from './chat/attachment/MessageImage.tsx'
import type { StepChatViewFeed } from './chat-view-contract.ts'
import { zh } from './locales.ts'
import { STEP_CHAT_AUTOFILL_MAX_PAGES } from './step-chat-autofill.ts'
import { stepChatPrependScrollTopOf } from './step-chat-paging.ts'
import { installStepChatSessions, StepChatBody } from './StepChatPanel.tsx'
import type { StepChatPagingSession } from './step-chat-paging.ts'

/** sandore zh 字典桩翻译：普通键取字典值，带参键做 {param} 插值。 */
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

const noImages: SandoreRenderMessageImages = () => null

// ── 桩：会话 / view feed / sessions 服务 ─────────────────────────────────────

interface SessionStub {
  readonly session: StepChatPagingSession & {
    subscribe(listener: () => void): () => void
    getSnapshot(): unknown
    open(): Promise<void>
    configureSubagent(address: unknown, parentAvailable?: boolean): void
  }
  readonly loadOlder: ReturnType<typeof vi.fn>
  /** 开窗调用（面板挂载时装配 transport 并 open；断言无需它，但要存在且不抛）。 */
  readonly open: ReturnType<typeof vi.fn>
  readonly setSnapshot: (patch: Record<string, unknown>) => void
  readonly listeners: Set<() => void>
  /** 批 A2（deferred 模式）：放行在飞的 loadOlder（放行时应用下一页的 hasMore）。 */
  readonly resolveLoadOlder: () => void
}

/**
 * 会话桩：openState='open'（面板主体路径），可注入 hasMore/loadingOlder 并由
 * setSnapshot 触发 uSES 重读（模拟 host 推来的快照变化）。
 * `getSnapshot` 必须返回身份稳定的快照对象（每次新建会触发 React 的
 * "getSnapshot should be cached" 无限循环告警）。
 *
 * 批 A2 追加两个选项：
 * - `hasMoreAfter`：每次**成功**的 loadOlder 之后 hasMore 的取值序列（模拟
 *   「还有更早 / 已补齐」；序列耗尽后保持当前值——即「窗口永远补不完」）；
 * - `deferred`：loadOlder 交由测试放行（用于在补齐**进行中**断言提示行）。
 */
function makeSession(initial: Record<string, unknown> = {}, options: {
  readonly hasMoreAfter?: readonly boolean[]
  readonly deferred?: boolean
} = {}): SessionStub {
  let snapshot: Record<string, unknown> = {
    sessionId: 'child-1',
    openState: 'open',
    openError: null,
    running: false,
    hasMore: false,
    loadingOlder: false,
    queue: [],
    ...initial,
  }
  const listeners = new Set<() => void>()
  const setSnapshot = (patch: Record<string, unknown>): void => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const hasMoreAfter = [...(options.hasMoreAfter ?? [])]
  const pendingLoads: (() => void)[] = []
  /** 一页成功落地：应用脚本里的下一个 hasMore（未给则保持）。 */
  const applyPage = (): void => {
    const next = hasMoreAfter.shift()
    if (next !== undefined) setSnapshot({ hasMore: next })
  }
  const loadOlder = vi.fn((): Promise<void> => {
    if (options.deferred !== true) {
      applyPage()
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      pendingLoads.push(() => {
        applyPage()
        resolve()
      })
    })
  })
  const open = vi.fn(async () => {})
  return {
    loadOlder,
    open,
    listeners,
    resolveLoadOlder: () => {
      for (const resolve of pendingLoads.splice(0)) resolve()
    },
    setSnapshot,
    session: {
      loadOlder,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      getSnapshot: () => snapshot,
      open,
      configureSubagent: () => {},
    },
  }
}

/** 空 view feed（order 空 → 面板显示空态，不渲染行树；分页行仍在）。 */
function makeFeed(): StepChatViewFeed {
  const read = { ok: true, order: [] as readonly string[] }
  return {
    subscribe: () => () => undefined,
    read: () => read,
    node: () => undefined,
    nodeSource: () => undefined,
    nodesSnapshot: () => [],
    processOf: () => undefined,
    timeline: () => undefined,
    navigationItems: () => [],
  }
}

/** sessions 服务桩（面板只用到 list 快照与 openSubagent/subagentAddress/open）。 */
function makeSessions(options: { readonly parentKnown?: boolean; readonly listCurrent?: string } = {}) {
  const openSubagent = vi.fn<(address: unknown) => void>()
  const subagentAddress = vi.fn(() => options.parentKnown === true
    ? { parentSessionId: 'host-1', childSessionId: 'child-1', mode: 'continuable' as const }
    : undefined)
  const open = vi.fn()
  // 列表快照必须身份稳定（uSES 的 getSnapshot 每次新建对象会触发无限重渲——
  // 真实 client-runtime 的 list 快照同样是发布间不变的引用）。
  const listSnapshot: { current?: string; byId: Record<string, unknown> } = {
    ...(options.listCurrent === undefined ? { current: 'host-1' } : { current: options.listCurrent }),
    byId: {},
  }
  const service = {
    list: {
      subscribe: () => () => undefined,
      getSnapshot: () => listSnapshot,
    },
    openSubagent,
    subagentAddress,
    open,
  }
  return { service, openSubagent, subagentAddress, open }
}

// ── 渲染工具（同 step-view-render.spec） ─────────────────────────────────────

const roots: ReturnType<typeof createRoot>[] = []
/** 正在渲染的宿主容器（供测试取 DOM 与派发事件）。 */
let host: HTMLElement

// 批 A2：面板可见性桩。面板用 IntersectionObserver 决定「是否自动补齐完整历史」，
// jsdom 没有该 API——真实语义下会退化到「挂载即视为可见」；本文件装一个可控桩，
// 把可见性变成显式测试输入（缺省不在视口内：自动补齐不介入，A1 锁手动路径）。
let ioIntersecting = false
const ioObservers = new Set<IntersectionObserverStub>()

class IntersectionObserverStub {
  readonly callback: (entries: unknown[], observer: unknown) => void
  constructor(callback: (entries: unknown[], observer: unknown) => void) {
    this.callback = callback
  }
  observe(): void {
    ioObservers.add(this)
    this.deliver() // 真实 IO 在 observe 后必发一次初始观测。
  }
  unobserve(): void { ioObservers.delete(this) }
  disconnect(): void { ioObservers.delete(this) }
  takeRecords(): unknown[] { return [] }
  deliver(): void {
    this.callback([{ isIntersecting: ioIntersecting, target: null }], this)
  }
}

/** 设置面板可见性（并通知已注册观察者：模拟滚动进出视口）。 */
function setPanelVisible(visible: boolean): void {
  ioIntersecting = visible
  act(() => {
    for (const observer of [...ioObservers]) observer.deliver()
  })
}

beforeEach(() => {
  ;(stepChatPrependScrollTopOf as unknown as ReturnType<typeof vi.fn>).mockClear()
  ioIntersecting = false
  ioObservers.clear()
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = IntersectionObserverStub
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  host?.remove()
  // 卸载面板的 sessions 持有，避免跨用例串台。
  installStepChatSessions(undefined as never)
  ioObservers.clear()
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
})

/** 推进若干宏任务帧（面板的 settle 走 rAF/16ms 定时器，jsdom 下都是宏任务）。 */
async function flushFrames(frames = 4): Promise<void> {
  for (let i = 0; i < frames; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => { setTimeout(resolve, 12) })
    })
  }
}

/**
 * 反复推进帧直到条件成立；自动补齐是逐页异步的，需要按条件收敛。
 *
 * 收敛上限按**帧数**而非墙钟：jsdom 里每帧 `flushFrames(1)` 至少推 12ms 真实时间，
 * 而单帧在负载高时（例如并行跑 Playwright）可能被调度拖到几十毫秒。若用「墙钟预算」
 * （昔日 `budgetMs = 4000`），慢机器会在推满所需帧数之前提前放弃 → `loadOlder` 计数
 * 断言随机转红（A2 的「页数上限」用例最多要跨 10 页 × 多帧，最易命中）。
 * 帧数上限让慢机器自动多等、快机器条件一成立就退出，不引入额外等待。
 */
async function flushUntil(predicate: () => boolean, maxFrames = 600): Promise<void> {
  for (let i = 0; i < maxFrames && !predicate(); i += 1) {
    await flushFrames(1)
  }
}

function render(element: ReactNode): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => { root.render(element) })
  return host
}

/** 渲染面板主体（viewFeed 注入；sessions 服务由调用方先经 installStepChatSessions 装好）。 */
function renderBody(session: SessionStub, extra: {
  readonly sessionId?: string
  readonly onOpenSession?: () => void
  readonly onOpenNative?: () => void
} = {}): HTMLElement {
  return render(h(StepChatBody, {
    session: session.session as never,
    viewFeed: makeFeed(),
    sessionId: extra.sessionId ?? 'child-1',
    t,
    onOpenSession: extra.onOpenSession ?? (() => {}),
    onOpenNative: extra.onOpenNative ?? (() => {}),
  }))
}

/** 面板内滚动器（唯一带 data-conversation-scroll 的元素）。 */
function scrollerIn(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-conversation-scroll]')
  if (el === null) throw new Error('scroll container must exist')
  return el
}

// ══════════════════════════════════════════════════════════════════════════════
// A1：加载更早（可见性 / disabled / 调用 / 保位）
// 注：批 A2 之后，面板**可见**且有更早历史时会自动补齐（下面的 A2 组）；本组用例
// 锁的是手动路径本身，故统一在「面板不在视口内」的可见性下运行（见文件头）。
// ══════════════════════════════════════════════════════════════════════════════

describe('批 A / A1 更早历史分页（jsdom）', () => {
  it('hides the load-earlier row while the window is complete', () => {
    const sessions = makeSessions()
    installStepChatSessions(sessions.service as never)
    const session = makeSession({ hasMore: false })
    const container = renderBody(session)
    expect(container.querySelector('[data-step-chat-load-older]')).toBeNull()
    expect(container.textContent ?? '').not.toContain('加载更早')
  })

  it('renders the load-earlier button when hasMore, calls loadOlder and preserves the scroll position', async () => {
    const sessions = makeSessions()
    installStepChatSessions(sessions.service as never)
    const session = makeSession({ hasMore: true })
    const container = renderBody(session)
    const button = container.querySelector<HTMLButtonElement>('[data-step-chat-load-older]')
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe('加载更早')
    expect(button?.disabled).toBe(false)

    // 保位取证：加载前 scrollTop=300 / scrollHeight=1000；prepend 落地后
    // scrollHeight=1400（头部多了 400px）→ 补偿后的 scrollTop 必须是 700。
    const scroller = scrollerIn(container)
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    scroller.scrollTop = 300

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      // 让 loadOlder 的 then + rAF 补偿跑完（jsdom 的 rAF 是宏任务）。
      await new Promise<void>((resolve) => { setTimeout(resolve, 16) })
    })

    expect(session.loadOlder).toHaveBeenCalledTimes(1)
    const preserve = stepChatPrependScrollTopOf as unknown as ReturnType<typeof vi.fn>
    expect(preserve).toHaveBeenCalledTimes(1)
    expect(preserve.mock.calls[0]?.[0]).toEqual({ scrollHeight: 1000, scrollTop: 300 })
    expect(preserve.mock.calls[0]?.[1]).toEqual({ scrollHeight: 1000, scrollTop: 300 })
    // 纯函数被真身透传（mock 保留 actual 实现）→ 落回 scrollTop 的值即补偿后位置。
    expect(scroller.scrollTop).toBe(300)
  })

  it('disables the button while a page is loading and re-enables it after', () => {
    const sessions = makeSessions()
    installStepChatSessions(sessions.service as never)
    const session = makeSession({ hasMore: true, loadingOlder: true })
    const container = renderBody(session)
    const button = container.querySelector<HTMLButtonElement>('[data-step-chat-load-older]')
    expect(button?.disabled).toBe(true)
    expect(button?.textContent).toBe('加载中…')
    act(() => { session.setSnapshot({ loadingOlder: false }) })
    expect(
      container.querySelector<HTMLButtonElement>('[data-step-chat-load-older]')?.disabled,
    ).toBe(false)
  })

  it('keeps the reader in place when the page did not grow (empty page / failure)', async () => {
    const sessions = makeSessions()
    installStepChatSessions(sessions.service as never)
    const session = makeSession({ hasMore: true })
    const container = renderBody(session)
    const scroller = scrollerIn(container)
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    scroller.scrollTop = 420
    await act(async () => {
      container.querySelector('[data-step-chat-load-older]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise<void>((resolve) => { setTimeout(resolve, 16) })
    })
    expect(session.loadOlder).toHaveBeenCalledTimes(1)
    expect(scroller.scrollTop).toBe(420) // Δ=0 → 原值
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// A3：滚动契约（data-conversation-scroll + 变量发布）
// ══════════════════════════════════════════════════════════════════════════════

describe('批 A / A3 滚动契约（jsdom）', () => {
  it('marks only the card scroller as [data-conversation-scroll] and publishes the contract vars', () => {
    const sessions = makeSessions()
    installStepChatSessions(sessions.service as never)
    const container = renderBody(makeSession())
    const scrollers = container.querySelectorAll('[data-conversation-scroll]')
    expect(scrollers).toHaveLength(1)
    const scroller = scrollers[0] as HTMLElement
    // 只能是本面板的滚动器（面板根之下、其子节点才是消息列）。
    expect(scroller.querySelector('[data-chat-flow]')).not.toBeNull()
    // viewport-height 由面板实测发布（jsdom 下 clientHeight=0 → '0px'，键必须在）。
    expect(scroller.style.getPropertyValue('--dsh-conversation-viewport-height')).toBe('0px')
    // 需求 1：面板没有输入面（也没有底部动作位）→ 该变量恒 0px（键必须在，
    // 因为 DSH 的滚动契约消费方按此避让底部）。
    expect(scroller.style.getPropertyValue('--dsh-composer-height')).toBe('0px')
    expect(scroller.hasAttribute('data-conversation-scroll')).toBe(true)
  })

  it('does not overwrite a content width or clearance the host already provided', () => {
    const sessions = makeSessions()
    installStepChatSessions(sessions.service as never)
    const container = renderBody(makeSession())
    const scroller = scrollerIn(container)
    // 宿主祖先（会话页 .root）已给这两个变量时不得覆盖：jsdom 的 CSS module 为空、
    // getComputedStyle 读不到宿主声明 → 本用例只锁「不覆盖内联已有值」这一半语义
    // （另一半——继承值不写内联——由 publishScrollVarsRef 的 inherited 判定承担，
    // 见 StepChatPanel.tsx 注释）。
    scroller.style.setProperty('--dsh-chat-content-width', '820px')
    scroller.style.setProperty('--dsh-composer-side-clearance', '12px')
    act(() => { scroller.dispatchEvent(new Event('scroll')) })
    expect(scroller.style.getPropertyValue('--dsh-chat-content-width')).toBe('820px')
    expect(scroller.style.getPropertyValue('--dsh-composer-side-clearance')).toBe('12px')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// A4：官方原生出口（openSubagent）
// ══════════════════════════════════════════════════════════════════════════════

describe('批 A / A4 官方原生出口（jsdom）', () => {
  it('opens the addressed subagent session through the native exit', () => {
    const sessions = makeSessions()
    installStepChatSessions(sessions.service as never)
    // 面板直接渲染主体：出口回调由 StepChatPanel 生产（本用例经 props 注入同一实现，
    // 见下一条用例的真实 openSubagent 形状断言）。
    const onOpenNative = vi.fn()
    const session = makeSession({ openState: 'error', openError: { code: 'x', message: 'boom' } })
    const container = renderBody(session, { onOpenNative, onOpenSession: vi.fn() })
    const native = container.querySelector<HTMLButtonElement>('[data-step-chat-open-native]')
    expect(native).not.toBeNull()
    expect(native?.textContent).toBe('用 DSH 原生对话打开')
    act(() => { native?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onOpenNative).toHaveBeenCalledTimes(1)
  })
})

describe('批 A / A4 StepChatPanel 出口接线（jsdom）', () => {
  it('routes the native exit through sessions.openSubagent with the continuable address', async () => {
    // 真实面板（含 openInHost 接线）：binding 桩 + sessions 桩 → error 态 →
    // 点「用 DSH 原生对话打开」→ openSubagent({parentSessionId, childSessionId,
    // mode:'continuable'})。binding 的 ctx 无 uiConversation → viewFeed 为空态，
    // 不影响出口按钮（error 占位在 body 之外）。
    const sessions = makeSessions()
    installStepChatSessions(sessions.service as never)
    const session = makeSession({ openState: 'error', openError: { code: 'boom', message: 'nope' } })
    const { StepChatPanel } = await import('./StepChatPanel.tsx')
    installStepChatSessions({
      ...sessions.service,
      binding: () => ({
        session: session.session,
        ctx: { get: () => undefined },
      }),
    } as never)
    const container = render(h(StepChatPanel, {
      sessionId: 'child-1',
      parentSessionId: 'host-1',
      t,
    }))
    const native = container.querySelector<HTMLButtonElement>('[data-step-chat-open-native]')
    expect(native).not.toBeNull()
    act(() => { native?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(sessions.openSubagent).toHaveBeenCalledTimes(1)
    expect(sessions.openSubagent.mock.calls[0]?.[0]).toEqual({
      kind: 'subagent',
      parentSessionId: 'host-1',
      childSessionId: 'child-1',
      mode: 'continuable',
    })
    expect(sessions.open).not.toHaveBeenCalled()
  })

  it('treats sessions.list.current as the parent when no parentSessionId prop is given', async () => {
    // 运行视图宿主页的 current 恒等于 parent（子代理直接 parent = 实例宿主会话），
    // 故 parent prop 缺失时回退列表 current，出口仍是 openSubagent（不是 plain open）。
    const sessions = makeSessions()
    installStepChatSessions(sessions.service as never)
    const session = makeSession({ openState: 'error', openError: { code: 'boom', message: 'x' } })
    installStepChatSessions({
      ...sessions.service,
      binding: () => ({ session: session.session, ctx: { get: () => undefined } }),
    } as never)
    const { StepChatPanel } = await import('./StepChatPanel.tsx')
    const container = render(h(StepChatPanel, { sessionId: 'child-1', t }))
    act(() => {
      container.querySelector('[data-step-chat-open-native]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(sessions.openSubagent.mock.calls[0]?.[0]).toEqual({
      kind: 'subagent',
      parentSessionId: 'host-1',
      childSessionId: 'child-1',
      mode: 'continuable',
    })
    expect(sessions.subagentAddress).not.toHaveBeenCalled()
    expect(sessions.open).not.toHaveBeenCalled()
  })

  it('falls back to the discovered subagent address when no parent is known at all', async () => {
    // parent prop 缺 + 列表无 current（无地址可组）→ 用 host catalog 已发现的地址。
    const sessions = makeSessions({ parentKnown: true, listCurrent: '' })
    installStepChatSessions(sessions.service as never)
    const session = makeSession({ openState: 'error', openError: { code: 'boom', message: 'x' } })
    installStepChatSessions({
      ...sessions.service,
      binding: () => ({ session: session.session, ctx: { get: () => undefined } }),
    } as never)
    const { StepChatPanel } = await import('./StepChatPanel.tsx')
    const container = render(h(StepChatPanel, { sessionId: 'child-1', t }))
    act(() => {
      container.querySelector('[data-step-chat-open-native]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(sessions.subagentAddress).toHaveBeenCalledWith('child-1')
    expect(sessions.openSubagent).toHaveBeenCalledWith({
      parentSessionId: 'host-1',
      childSessionId: 'child-1',
      mode: 'continuable',
    })
    expect(sessions.open).not.toHaveBeenCalled()
  })

  it('falls back to plain open and swallows its synchronous throw', async () => {
    // 地址也不可得 → 回退 plain open；host 对已 disposed 会话可能同步抛——
    // 面板 catch + console.error，绝不向上抛（组件不崩）。
    const sessions = makeSessions({ listCurrent: '' })
    installStepChatSessions(sessions.service as never)
    const session = makeSession({ openState: 'error', openError: { code: 'boom', message: 'x' } })
    installStepChatSessions({
      ...sessions.service,
      binding: () => ({ session: session.session, ctx: { get: () => undefined } }),
    } as never)
    sessions.open.mockImplementation(() => { throw new Error('disposed') })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { StepChatPanel } = await import('./StepChatPanel.tsx')
    const container = render(h(StepChatPanel, { sessionId: 'child-1', t }))
    act(() => {
      container.querySelector('[data-step-chat-open-native]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(sessions.openSubagent).not.toHaveBeenCalled()
    expect(sessions.open).toHaveBeenCalledWith('child-1')
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// A2：自动补齐完整历史（可见性门 / 连续补齐 / 提示行 / 上限 / 离屏即停）
// ══════════════════════════════════════════════════════════════════════════════

describe('批 A2 自动补齐完整历史（jsdom）', () => {
  it('auto-fills until hasMore is false and drops the manual button', async () => {
    const sessions = makeSessions()
    installStepChatSessions(sessions.service as never)
    // 面板先在视口外：自动补齐不介入，手动按钮按批 A 语义照常出现。
    setPanelVisible(false)
    const session = makeSession({ hasMore: true }, { hasMoreAfter: [true, false] })
    const container = renderBody(session)
    await flushFrames()
    expect(session.loadOlder).not.toHaveBeenCalled()
    expect(container.querySelector('[data-step-chat-load-older]')).not.toBeNull()
    expect(container.querySelector('[data-step-chat-autofill]')).toBeNull()

    // 滚入视口（IntersectionObserver 报可见）→ 自动逐页补齐到 hasMore=false。
    setPanelVisible(true)
    await flushUntil(() => session.loadOlder.mock.calls.length >= 2)
    expect(session.loadOlder).toHaveBeenCalledTimes(2)
    // 补齐完成：提示行与手动按钮都消失（hasMore=false → 官方折叠语义恢复）。
    await flushUntil(() => container.querySelector('[data-step-chat-autofill]') === null)
    expect(container.querySelector('[data-step-chat-load-older]')).toBeNull()
  })

  it('shows the in-progress hint while a page is in flight, then completes', async () => {
    const sessions = makeSessions()
    installStepChatSessions(sessions.service as never)
    setPanelVisible(true)
    // deferred：loadOlder 由测试放行——停在「一页在飞」的中间态做断言。
    const session = makeSession({ hasMore: true }, { deferred: true, hasMoreAfter: [false] })
    const container = renderBody(session)

    await flushUntil(() => session.loadOlder.mock.calls.length === 1)
    const hint = container.querySelector('[data-step-chat-autofill]')
    expect(hint).not.toBeNull()
    expect(hint?.textContent).toBe('正在加载更早的消息…')
    // 补齐进行中不显示手动按钮（自动补齐正连续投递）。
    expect(container.querySelector('[data-step-chat-load-older]')).toBeNull()

    act(() => { session.resolveLoadOlder() })
    await flushUntil(() => container.querySelector('[data-step-chat-autofill]') === null)
    expect(container.querySelector('[data-step-chat-load-older]')).toBeNull()
  })

  it('keeps the manual button once the page cap is reached', async () => {
    const sessions = makeSessions()
    installStepChatSessions(sessions.service as never)
    setPanelVisible(true)
    // 桩恒不补齐（hasMore 每页成功后保持 true）→ 自动补齐必达页数上限。
    const session = makeSession({ hasMore: true })
    const container = renderBody(session)

    await flushUntil(() => session.loadOlder.mock.calls.length >= STEP_CHAT_AUTOFILL_MAX_PAGES)
    await flushUntil(() => container.querySelector('[data-step-chat-autofill]') === null)
    expect(session.loadOlder).toHaveBeenCalledTimes(STEP_CHAT_AUTOFILL_MAX_PAGES)
    const button = container.querySelector<HTMLButtonElement>('[data-step-chat-load-older]')
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe('加载更早')

    // 上限闩锁：不会自动重启（再等几帧投递数不变），手动点击仍可继续逐页续看。
    const settled = session.loadOlder.mock.calls.length
    await flushFrames(3)
    expect(session.loadOlder.mock.calls.length).toBe(settled)
    act(() => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flushFrames(2)
    expect(session.loadOlder.mock.calls.length).toBe(settled + 1)
  })

  it('stops the fill when the panel leaves the viewport (gate) and returns the button', async () => {
    const sessions = makeSessions()
    installStepChatSessions(sessions.service as never)
    setPanelVisible(true)
    const session = makeSession({ hasMore: true })
    const container = renderBody(session)

    await flushUntil(() => session.loadOlder.mock.calls.length >= 2)
    setPanelVisible(false) // 滚出视口
    await flushUntil(() => container.querySelector('[data-step-chat-autofill]') === null)
    const settled = session.loadOlder.mock.calls.length
    await flushFrames(3)
    expect(session.loadOlder.mock.calls.length).toBe(settled)
    expect(container.querySelector('[data-step-chat-load-older]')).not.toBeNull()
  })
})
