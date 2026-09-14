/**
 * main-agent-card.spec（呈现层统一 · 真机反馈修正；@vitest-environment jsdom）：
 * **主代理卡片的出现条件**（需求 3 修正版）组件级回归。
 *
 * 用户原话：「主代理的消息**只有在主代理有消息更新的时候**才插入到 discuss，作为一个 step
 * 插入」——故本 spec 锁三条：
 * 1. 主代理**还没有任何助手消息**时不出现（**连空壳/标题都不要**）；
 * 2. 主代理产出助手消息（含启动汇报「工作流已启动…」）就出现——**不再要求用户先发过消息**
 *    （上一版的两条硬条件会把启动汇报吞掉，真机上表现为「卡片怎么都不出来」）；
 * 3. 之后每来一条新的助手消息，仍是**同一张卡片**在刷新（`shown` 保持 true，不新增实例）。
 *
 * 数据面走真实的那条链：`sessions.binding(hostSessionId)` →
 * `uiConversation.binding(binding).target('chat')`（`createStepChatViewSource`）→
 * `read().order` + `node(key).kind`。这里用桩 target 驱动节点增删，与真机同形。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/main-agent-card.spec
 */
// @vitest-environment jsdom
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

// primitives 桩：本 spec 只挂钩子，但 DiscussionInput/StepChatPanel 的模块图会被间接引入，
// 故与 main-agent-composer.spec 保持同一套最小导出（缺一个就会在 import 期炸掉整个 suite）。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement: el, Fragment: F } = await import('react')
  const icon = (label: string) => () => el('svg', { 'data-icon': label, 'aria-hidden': true })
  return {
    Button: (props: { children?: ReactNode }) => el('button', { type: 'button' }, props.children),
    Modal: (props: { title?: ReactNode }) => el('div', null, props.title),
    DisclosureRow: (props: { title?: ReactNode; children?: ReactNode }) => el('div', null, props.title, props.children),
    MarkdownText: (props: { text?: string }) => el('p', null, props.text),
    JsonBlock: (props: { payload?: unknown }) => el('div', null, JSON.stringify(props.payload)),
    projectUserText: (text?: string) => el('span', null, text),
    ReferenceIcon: () => el('span'),
    Tooltip: (props: { children?: ReactNode }) => el(F, null, props.children),
    writeClipboard: async () => true,
    StateDot: () => el('span'),
    CodeBlock: (props: { code?: string }) => el('pre', null, props.code),
    TerminalBlock: () => el('div'),
    DiffBlock: () => el('div'),
    ReadBlock: () => el('div'),
    SearchBlock: () => el('div'),
    WebBlock: () => el('div'),
    diffTotals: () => ({ added: 0, removed: 0 }),
    IconThinkOutline14: icon('think'),
    IconUserOutline16: icon('user'),
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
    IconStopFill16: icon('stop'),
    IconChevronUpOutline14: icon('chevron-up'),
    IconChevronLeftOutline14: icon('chevron-left'),
    IconCloseOutline16: icon('close'),
  }
})

import { installStepChatSessions } from './StepChatPanel.tsx'
import { useMainAgentCard } from './main-agent-card.ts'

const HOST_SESSION = 'host-card-1'

/**
 * 会话视图桩：一个最小的 rc.1 ChatSnapshot（`order` + `nodes` 的 get/source/processSource）。
 * `appendAssistant()` 模拟「主代理产出一条助手消息」。
 * @param options - `cold: true` 时初始快照为 undefined（= 会话视图还没装配，`read().ok` 假），
 *   `warmUp()` 之后才产出 ChatSnapshot（对齐「未开窗 → 开窗」的真实两段式）。
 */
function chatStub(options: { cold?: boolean } = {}) {
  const listeners = new Set<() => void>()
  const kinds = new Map<string, string>([['ctx-1', 'context'], ['user-1', 'user']])
  const order: string[] = ['ctx-1', 'user-1']
  /** 会话对象上的 open() 调用次数（开窗探测的证据）。 */
  const openCalls: number[] = []
  let warm = options.cold !== true
  /** 当前快照对象（**身份必须稳定**：uSES 的 getSnapshot 每次返回新对象会无限重渲）。 */
  let current: unknown
  const publish = (): void => {
    // 只在这里换快照身份（对齐真实 target：每次发布换一次身份）。
    // 节点形状必须满足 chat-view-contract 的 `stepChatViewNodeOf`（key/kind/anchorSeq 必备）。
    current = warm
      ? {
          order: [...order],
          nodes: {
            get: (key: string) => (kinds.has(key)
              ? { key, kind: kinds.get(key), data: undefined, anchorSeq: 0, location: undefined }
              : undefined),
            source: () => undefined,
            processSource: () => undefined,
          },
        }
      : undefined
    for (const listener of [...listeners]) listener()
  }
  publish()
  const target = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => current,
  }
  return {
    binding: {
      session: {
        open: () => { openCalls.push(openCalls.length); return Promise.resolve() },
        subscribe: () => () => undefined,
        getSnapshot: () => ({ running: false }),
      },
      ctx: { get: (name: string) => (name === 'uiConversation' ? { binding: () => ({ target: () => target }) } : undefined) },
    },
    /** 追加一条助手输出（= 主代理回话）。 */
    appendAssistant(): void {
      const key = `assistant-${String(kinds.size)}`
      kinds.set(key, 'assistant-step')
      order.push(key)
      publish()
    },
    /** 会话视图就绪（= 开窗后装配出 ChatSnapshot）。 */
    warmUp(): void {
      warm = true
      publish()
    },
    /** `open()` 调用次数（开窗探测）。 */
    openCalls,
  }
}

const roots: ReturnType<typeof createRoot>[] = []
const disposers: Array<() => void> = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const dispose of disposers.splice(0)) dispose()
})

/** 渲染一个只输出 `shown` 的探测组件（把钩子的返回值落到 DOM 属性上便于断言）。 */
function renderGate(hostSessionId: string, onGate: (gate: ReturnType<typeof useMainAgentCard>) => void): void {
  function Probe() {
    const gate = useMainAgentCard(hostSessionId)
    onGate(gate)
    return h('div', { 'data-shown': String(gate.shown) })
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => { root.render(h(Probe)) })
}

/** 每次渲染都把最新 gate 记下来（重渲染后取最新值断言）。 */
function gateRecorder(): { current: ReturnType<typeof useMainAgentCard> | undefined } {
  const box: { current: ReturnType<typeof useMainAgentCard> | undefined } = { current: undefined }
  return box
}

describe('useMainAgentCard：主代理有助手消息就出现卡片（真机反馈修正版）', () => {
  it('stays hidden while the main agent has produced no assistant message (no empty shell)', () => {
    const chat = chatStub()
    disposers.push(installStepChatSessions({ list: listStub(chat), binding: () => chat.binding } as never))
    // 宿主会话里只有上下文注入 + 用户消息，没有助手输出 → 不渲染（连空壳/标题都不要）。
    const gate = gateRecorder()
    renderGate(HOST_SESSION, value => { gate.current = value })
    expect(gate.current?.shown).toBe(false)
  })

  it('appears from the startup report alone (no user message required)', () => {
    const chat = chatStub()
    disposers.push(installStepChatSessions({ list: listStub(chat), binding: () => chat.binding } as never))
    // 启动注入让主代理自己汇报「工作流已启动…」——真机反馈：这条就该带出卡片，
    // 不再要求「用户先在运行页发过消息」。
    act(() => { chat.appendAssistant() })
    const gate = gateRecorder()
    renderGate(HOST_SESSION, value => { gate.current = value })
    expect(gate.current?.shown).toBe(true)
  })

  it('refreshes on every new assistant message (the same single card)', () => {
    const chat = chatStub()
    disposers.push(installStepChatSessions({ list: listStub(chat), binding: () => chat.binding } as never))
    const gate = gateRecorder()
    renderGate(HOST_SESSION, value => { gate.current = value })
    expect(gate.current?.shown).toBe(false)
    act(() => { chat.appendAssistant() })
    expect(gate.current?.shown, '第一条助手消息 → 出现').toBe(true)
    act(() => { chat.appendAssistant() })
    expect(gate.current?.shown, '后续助手消息 → 仍是同一张卡片（shown 保持 true）').toBe(true)
  })

  it('surfaces the assistant-message count (the card collapse state machine needs it)', () => {
    const chat = chatStub()
    disposers.push(installStepChatSessions({ list: listStub(chat), binding: () => chat.binding } as never))
    const gate = gateRecorder()
    renderGate(HOST_SESSION, value => { gate.current = value })
    expect(gate.current?.outputCount, '没有助手消息 → 0').toBe(0)
    act(() => { chat.appendAssistant() })
    expect(gate.current?.outputCount).toBe(1)
    act(() => { chat.appendAssistant() })
    // 条数增加 ⇒ 卡片侧据此自动展开（真机反馈：有新消息就展开）。
    expect(gate.current?.outputCount).toBe(2)
    expect(gate.current?.shown).toBe(true)
  })

  it('never surfaces when the host session is unavailable (no sessions service / no chat target)', () => {
    const gate = gateRecorder()
    renderGate(HOST_SESSION, value => { gate.current = value })
    expect(gate.current?.shown).toBe(false)
  })

  it('opens the host session window on mount so the chat view is live', () => {
    const chat = chatStub({ cold: true })
    disposers.push(installStepChatSessions({ list: listStub(chat), binding: () => chat.binding } as never))
    const gate = gateRecorder()
    // 挂载即开窗（幂等）：不开窗时快照恒空 ⇒ `read().ok` 恒假、条数恒 0 ⇒ 卡片永远不会出现
    // （真机 m7 ② 的现象）。
    renderGate(HOST_SESSION, value => { gate.current = value })
    expect(chat.openCalls.length, '挂载时应调用一次宿主会话开窗').toBe(1)
    expect(gate.current?.shown).toBe(false)
  })

  it('surfaces once a cold view warms up with assistant history (the startup report)', () => {
    const chat = chatStub({ cold: true })
    disposers.push(installStepChatSessions({ list: listStub(chat), binding: () => chat.binding } as never))
    const gate = gateRecorder()
    renderGate(HOST_SESSION, value => { gate.current = value })
    expect(gate.current?.shown, '视图未就绪 → 不留空壳').toBe(false)
    // 视图随后就绪，并一次带出启动汇报（助手输出）→ 出现。
    act(() => { chat.appendAssistant() })
    act(() => { chat.warmUp() })
    expect(gate.current?.shown).toBe(true)
  })
})

/** 会话列表桩（binding 恒命中；list 订阅用于「会话晚出现」的重解析）。 */
function listStub(chat: ReturnType<typeof chatStub>): unknown {
  // 快照对象身份必须稳定（uSES 的 getSnapshot 每次返回新对象会无限重渲；真实 list 也是稳定的）。
  const snapshot = { current: HOST_SESSION, byId: { [HOST_SESSION]: { cwd: undefined } } }
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    _chat: chat,
  }
}
