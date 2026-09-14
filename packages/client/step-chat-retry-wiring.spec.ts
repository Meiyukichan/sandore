/**
 * step-chat-retry-wiring.spec（批 B2；**需求 1 改写**；@vitest-environment jsdom）：
 * 面板把「重试端口 + 本段定位片段」接到重试行的组件级回归。
 *
 * 锁三件事（都属接线，不是纯函数）：
 * 1. **重试行接线**：failed 的真实子代理段（target = failed + prompt）→ 面板**底部
 *    动作位**（`data-step-chat-retry-seat`）内出现重试行；点击重试把
 *    `{stepId, mode, message}` 交给端口，`message` 是**固定默认串**（需求 1：面板不再
 *    有输入框，草稿概念随之消失）。running 段与 shell 合成段不出现重试行（可见性由
 *    `stepRetryVisible` 收窄）。
 * 2. **错误行**：端口拒绝 → 面板内 `data-step-chat-retry-error` 展示引擎原文（F1）。
 * 3. **需求 1（本次变更）**：面板内**不存在任何输入面**——`data-step-chat-composer-seat`
 *    计数为 0、没有 `[data-step-chat-composer]` 壳、没有 textarea / contenteditable /
 *    发送按钮 / `@` 触发菜单锚点；未给重试端口时底部动作位也不存在（不新增 DOM）。
 *
 * 注：宿主编辑器根抢占守卫（`hostSessionId === 子会话 id`）原本在本文件覆盖，需求 1
 * 删掉面板侧接线后该守卫只剩 ComposerBar 本体，覆盖已下移到
 * composer-bar-render.spec（三例：命中 / 不同会话 / current 未知）。
 *
 * 策略与 step-chat-panel-paging.spec 一致：jsdom + react-dom/client + primitives 桩
 * （primitives 的发布产物自带 *.module.css，vitest 默认外置 node_modules 不处理 CSS）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-chat-retry-wiring.spec
 */
// @vitest-environment jsdom
// React 18 需要显式声明 act 环境（否则每个 act 调用打 warning）。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

// primitives 全部替换为最小行为桩（同 step-chat-panel-paging.spec 的理由与做法）。
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
  }
})

import type { StepChatViewFeed } from './chat-view-contract.ts'
import { zh } from './locales.ts'
import { clearStepChatRegistry } from './step-chat-registry.ts'
import { StepChatBody } from './StepChatPanel.tsx'
import type {
  StepChatRetryPort,
  StepRetryBoundaryOptionLike,
  StepRetryRequest,
} from './step-view/step-retry.ts'

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

const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  clearStepChatRegistry()
})

/** 会话桩：openState='open' + running 可控的最小 subscribe/getSnapshot。 */
function makeSession(running = false) {
  const snapshot = {
    openState: 'open',
    running,
    hasMore: false,
    loadingOlder: false,
    openError: undefined,
  }
  return {
    session: {
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      loadOlder: () => Promise.resolve(),
    },
  }
}

/** 空 view feed（order 空 → 空态占位；接线用例只需面板主体与底部动作位）。 */
function makeFeed(): StepChatViewFeed {
  const read = { ok: true, order: [] as readonly string[] }
  return {
    subscribe: () => () => undefined,
    read: () => read,
    node: () => undefined,
    nodeSource: () => undefined,
    processOf: () => undefined,
    timeline: () => undefined,
    nodesSnapshot: () => [],
    navigationItems: () => [],
  } as unknown as StepChatViewFeed
}

/** 重试端口桩（记录请求；可注入拒绝/回退点候选）。 */
function retryPortStub(options: {
  readonly status?: string
  readonly commandType?: string
  readonly synthetic?: boolean
  readonly rejectRetry?: unknown
  readonly boundaries?: readonly StepRetryBoundaryOptionLike[]
} = {}) {
  const retry = vi.fn((_input: StepRetryRequest): Promise<void> => (
    options.rejectRetry === undefined ? Promise.resolve() : Promise.reject(options.rejectRetry)
  ))
  const listBoundaries = vi.fn((): Promise<readonly StepRetryBoundaryOptionLike[]> => (
    Promise.resolve(options.boundaries ?? [])
  ))
  const port: StepChatRetryPort = {
    target: {
      stepId: 'step-a',
      status: options.status ?? 'failed',
      commandType: options.commandType ?? 'prompt',
      synthetic: options.synthetic ?? false,
    },
    retry,
    listBoundaries,
  }
  return { port, retry, listBoundaries }
}

function render(element: ReactNode): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => { root.render(element) })
  return host
}

/** 渲染面板主体，可按需注入会话运行态 / 重试端口。 */
function renderBody(extra: {
  readonly running?: boolean
  readonly retry?: StepChatRetryPort | undefined
} = {}): HTMLElement {
  const session = makeSession(extra.running ?? false)
  return render(h(StepChatBody, {
    session: session.session as never,
    viewFeed: makeFeed(),
    sessionId: 'child-1',
    ...(extra.retry === undefined ? {} : { retry: extra.retry }),
    t,
    onOpenSession: () => {},
    onOpenNative: () => {},
  }))
}

describe('面板内重试行接线（StepChatBody → 底部动作位）', () => {
  it('renders the retry row in the panel action seat for a failed real subagent segment', async () => {
    const stub = retryPortStub()
    const host = renderBody({ retry: stub.port })
    const seat = host.querySelector('[data-step-chat-retry-seat]')
    expect(seat).not.toBeNull()
    const row = host.querySelector('[data-step-chat-retry-row]')
    expect(row).not.toBeNull()
    expect(row?.closest('[data-step-chat-retry-seat]')).toBe(seat)
    // 需求 1：面板内没有任何输入面（seat 不在了，壳/输入面/发送钮都没有）。
    expect(host.querySelector('[data-step-chat-composer-seat]')).toBeNull()
    expect(host.querySelector('[data-step-chat-composer]')).toBeNull()
    expect(host.querySelector('[data-composer-input]')).toBeNull()
    expect(host.querySelector('[data-composer-send]')).toBeNull()
    // 点击重试 → 端口收到本段 stepId + **固定默认 message**（需求 1：没有草稿）。
    await act(async () => {
      (host.querySelector('[data-step-chat-retry-submit]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(stub.retry).toHaveBeenCalledTimes(1)
    expect(stub.retry.mock.calls[0]?.[0]).toEqual({
      stepId: 'step-a',
      mode: 'continue',
      message: '请重试该步骤',
    })
  })

  it('keeps the retry row out of running and shell segments, and adds no seat without a port', () => {
    const running = retryPortStub({ status: 'running' })
    const runningHost = renderBody({ running: true, retry: running.port })
    expect(runningHost.querySelector('[data-step-chat-retry-row]')).toBeNull()
    // 端口不可重试（running）→ 底部动作位也不渲染（不新增空 DOM）。
    expect(runningHost.querySelector('[data-step-chat-retry-seat]')).toBeNull()
    const shell = retryPortStub({ commandType: 'shell', synthetic: true })
    expect(renderBody({ retry: shell.port }).querySelector('[data-step-chat-retry-row]')).toBeNull()
    // 无端口的旧调用方（paused 等）同样不出现重试行/动作位。
    const plain = renderBody({ running: true })
    expect(plain.querySelector('[data-step-chat-retry-row]')).toBeNull()
    expect(plain.querySelector('[data-step-chat-retry-seat]')).toBeNull()
  })

  it('renders the engine error text inside the panel when the retry is rejected', async () => {
    const stub = retryPortStub({
      rejectRetry: new Error("INVALID_OPERATION: step 'step-a' 的子代理会话已销毁（无法续跑），不能重试"),
    })
    const host = renderBody({ retry: stub.port })
    await act(async () => {
      (host.querySelector('[data-step-chat-retry-submit]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    const error = host.querySelector('[data-step-chat-retry-error]')
    expect(error?.textContent).toContain('子代理会话已销毁')
    expect(host.querySelector('[data-step-chat-retry-disposed]')).not.toBeNull()
    // 面板仍在（错误行不吞掉会话区），可改模式后重试。
    expect(host.querySelector('[data-step-chat]')).not.toBeNull()
    expect(host.querySelector('[data-step-chat-retry-seat]')).not.toBeNull()
  })

  it('lists the revert boundaries for the segment when revert is picked', async () => {
    const stub = retryPortStub({ boundaries: [{ seq: 42, turn: 0 }] })
    const host = renderBody({ retry: stub.port })
    await act(async () => {
      (host.querySelector('[data-step-chat-retry-mode="revert"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(stub.listBoundaries).toHaveBeenCalledWith('step-a')
    expect(host.querySelector('[data-step-chat-retry-boundary]')).not.toBeNull()
  })
})

describe('需求 1：面板内不再有任何输入面', () => {
  it('renders no composer shell, input, send button or trigger menu anchor', () => {
    // 既不看 composerSend/composerBinding（props 已删除），也不看开关：面板不挂载
    // ComposerBar，故与「有没有发送通道」无关——输入面在结构上不存在。
    const stub = retryPortStub()
    const host = renderBody({ running: true, retry: stub.port })
    for (const selector of [
      '[data-step-chat-composer-seat]',
      '[data-step-chat-composer]',
      '[data-composer-input]',
      '[data-composer-send]',
      '[data-composer-queue-hint]',
      '[data-composer-menu-anchor]',
      '[data-trigger-menu]',
    ]) {
      expect(host.querySelector(selector), `${selector} 不应出现在面板内`).toBeNull()
    }
    expect(host.querySelector('textarea')).toBeNull()
    // 面板本身仍在（只是没有输入面）。
    expect(host.querySelector('[data-step-chat]')).not.toBeNull()
    // 滚动契约的底部避让变量改由动作位度量（无动作位时 0px，键恒在）。
    const scroller = host.querySelector('[data-conversation-scroll]') as HTMLElement
    expect(scroller.style.getPropertyValue('--dsh-composer-height')).toBe('0px')
  })
})
