/**
 * step-chat-retry-placeholder.spec（批 B3；@vitest-environment jsdom）：**占位态**
 * 重试行的组件级回归——B2 遗留的唯一实质风险：重试行原本只挂 composer seat，而 seat
 * 只随 `openState === 'open'` 渲染，于是 F1 场景（failed 段的子代理已被 DSH dispose，
 * binding 重拉耗尽/open 恒被拒，面板长期停在 loading/error 占位）里唯一的恢复入口
 * 不可见、引擎「子代理会话已销毁」也无处展示。
 *
 * 本 spec 锁的语义：
 * 1. `openState='loading'`（含 agent-busy 那个刻意渲染成 loading 的分支）+ failed
 *    真实子代理段 → 占位文案下方出现重试行；点击把「默认 message + 本段 stepId」交给
 *    端口；端口拒绝时引擎原文在**占位态内**可见（F1 引导行同现）。
 * 2. `openState='error'`（非 agent-busy）+ failed 段 → 重试行与既有两个出口按钮
 *    （查看会话 / 用 DSH 原生对话打开）**并存**，且不重复渲染冲突按钮组。
 * 3. `openState='open'` → 仍只出现一份（`[data-step-chat-retry-row]` 计数为 1），且
 *    落在**面板底部动作位** `[data-step-chat-retry-seat]` 内（需求 1：那个位置原本是
 *    输入框 seat，现在归重试行）；占位分支完全不参与。
 * 4. `retry` 缺失 / 目标不可重试（shell 合成段、非 failed、非子代理 command）→ 占位态
 *    与批 B2 前完全一致（不出现重试行，也不出现占位重试行的包裹层）。
 *
 * 需求 1：面板内不再有任何输入面（`data-step-chat-composer-seat` 与
 * `data-step-chat-composer` 在**两条**路径下都必须缺席），重试 message 恒为固定默认串
 * （面板没有草稿）——两态都据此断言。
 *
 * 策略与 step-chat-retry-wiring.spec 一致：jsdom + react-dom/client + primitives 桩
 * （primitives 的发布产物自带 *.module.css，vitest 默认外置 node_modules 不处理 CSS）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-chat-retry-placeholder.spec
 */
// @vitest-environment jsdom
// React 18 需要显式声明 act 环境（否则每个 act 调用打 warning）。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

// primitives 全部替换为最小行为桩（同 step-chat-retry-wiring.spec 的理由与做法）。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement: el, Fragment: F } = await import('react')
  const icon = (label: string) => () => el('svg', { 'data-icon': label, 'aria-hidden': true })
  return {
    Button: (props: { children?: ReactNode } & Record<string, unknown>) => {
      // 行为桩：透传 DOM 属性（data-* 锚点/onClick 等），只丢掉非 DOM 的 variant。
      const { children, variant: _variant, ...rest } = props
      return el('button', { type: 'button', ...rest }, children)
    },
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

/** 会话桩：开窗态可控的 snapshot（占位态即 openState ≠ 'open'）。 */
function makeSession(openState: string, openError?: { code?: string; message?: string }) {
  const snapshot = {
    openState,
    running: false,
    hasMore: false,
    loadingOlder: false,
    openError,
  }
  return {
    session: {
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      loadOlder: () => Promise.resolve(),
      // Round 25 的有界退避与 agent-busy 的 settle 重开都会调 Session.open()
      // （原型方法，面板 cast 调用）——桩必须提供，否则占位态挂载即抛。
      open: () => Promise.resolve(),
    },
  }
}

/** 空 view feed（order 空 → 空态占位；接线用例只需面板主体与占位分支）。 */
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

/** 重试端口桩（记录请求；可注入拒绝/回退点候选/目标字段）。 */
function retryPortStub(options: {
  readonly status?: string
  readonly commandType?: string
  readonly synthetic?: boolean
  readonly stepId?: string
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
      stepId: options.stepId ?? 'step-a',
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

/** 渲染面板主体（占位态可控 + 可注入重试端口）。 */
function renderBody(extra: {
  readonly openState?: string
  readonly openError?: { code?: string; message?: string }
  readonly retry?: StepChatRetryPort | undefined
} = {}): HTMLElement {
  const session = makeSession(extra.openState ?? 'loading', extra.openError)
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

/** 点击重试按钮并 flush 承诺链（端口调用/错误行在此落盘）。 */
async function clickRetry(host: HTMLElement): Promise<void> {
  await act(async () => {
    (host.querySelector('[data-step-chat-retry-submit]') as HTMLButtonElement).click()
    await Promise.resolve()
  })
}

describe('占位态（loading / agent-busy loading）的重试行', () => {
  it('renders the retry row under the loading placeholder for a failed segment', async () => {
    const stub = retryPortStub()
    const host = renderBody({ openState: 'loading', retry: stub.port })
    // 占位文案原样保留（既有断言不受影响）。
    expect(host.querySelector('[data-step-chat]')).not.toBeNull()
    const row = host.querySelector('[data-step-chat-retry-row]')
    expect(row).not.toBeNull()
    expect(row?.getAttribute('data-step-chat-retry-step')).toBe('step-a')
    // 归位：在占位文案**下方**（DOM 顺序上排在 loading 文案之后）。
    const placeholder = host.querySelector('[data-step-chat] > div')
    expect(placeholder?.textContent).toBe('正在加载子代理会话…')
    expect(
      (placeholder?.compareDocumentPosition(row as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // 占位态没有输入面（需求 1）：重试行不落在任何输入区 seat 内（面板里没有那种
    // 节点了），面板底部动作位也不参与占位分支。
    expect(row?.closest('[data-step-chat-composer-seat]')).toBeNull()
    expect(host.querySelector('[data-step-chat-composer-seat]')).toBeNull()
    expect(host.querySelector('[data-step-chat-composer]')).toBeNull()
    expect(host.querySelector('[data-step-chat-retry-seat]')).toBeNull()
    // 提交走固定默认 message（需求 1：面板没有草稿）。
    await clickRetry(host)
    expect(stub.retry).toHaveBeenCalledTimes(1)
    expect(stub.retry.mock.calls[0]?.[0]).toEqual({
      stepId: 'step-a',
      mode: 'continue',
      message: '请重试该步骤',
    })
  })

  it('shows the retry row for the cold placeholder too (no session window at all)', () => {
    const stub = retryPortStub()
    const host = renderBody({ openState: 'cold', retry: stub.port })
    const row = host.querySelector('[data-step-chat-retry-row]')
    expect(row).not.toBeNull()
    expect(host.querySelector('[data-step-chat] > div')?.textContent).toBe('正在加载子代理会话…')
    expect(host.querySelectorAll('[data-step-chat-retry-row]').length).toBe(1)
  })

  it('renders the retry row in the agent-busy loading branch too', () => {
    const stub = retryPortStub()
    // host 以 session/agent-busy 拒绝 open：面板刻意渲染成 loading 占位（非 error）。
    const host = renderBody({
      openState: 'error',
      openError: { code: 'session/agent-busy', message: 'session is busy' },
      retry: stub.port,
    })
    // agent-busy 分支：占位文案是 loading，且不出现 error 的两个出口按钮。
    expect(host.querySelector('[data-step-chat-error-detail]')).toBeNull()
    expect(host.querySelector('[data-step-chat-open-native]')).toBeNull()
    expect(host.querySelector('[data-step-chat-retry-row]')).not.toBeNull()
  })

  it('shows the engine F1 error inside the placeholder when the retry is rejected', async () => {
    const stub = retryPortStub({
      rejectRetry: new Error("INVALID_OPERATION: step 'step-a' 的子代理会话已销毁（无法续跑），不能重试"),
    })
    const host = renderBody({ openState: 'loading', retry: stub.port })
    await clickRetry(host)
    const error = host.querySelector('[data-step-chat-retry-error]')
    expect(error?.getAttribute('role')).toBe('alert')
    expect(error?.textContent).toContain('子代理会话已销毁') // 引擎原话在占位态内可见
    expect(host.querySelector('[data-step-chat-retry-disposed]')).not.toBeNull()
    // 面板仍是占位态（错误行不把占位推走）。
    expect(host.querySelector('[data-step-chat]')).not.toBeNull()
  })

  it('lists the revert boundaries from the placeholder row (revert mode path intact)', async () => {
    const stub = retryPortStub({ boundaries: [{ seq: 7, turn: 0 }] })
    const host = renderBody({ openState: 'loading', retry: stub.port })
    await act(async () => {
      (host.querySelector('[data-step-chat-retry-mode="revert"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(stub.listBoundaries).toHaveBeenCalledWith('step-a')
    expect(host.querySelector('[data-step-chat-retry-boundary]')).not.toBeNull()
  })
})

describe('占位态（error）的重试行与既有出口并存', () => {
  it('keeps both escape buttons and appends the retry row below them', () => {
    const stub = retryPortStub()
    const host = renderBody({
      openState: 'error',
      openError: { code: 'session/not-found', message: 'INVALID_OPERATION: session not found' },
      retry: stub.port,
    })
    // 既有 error 占位结构原样保留：文案 + 详情 + 两个出口按钮。
    expect(host.querySelector('[data-step-chat-error-detail]')?.textContent)
      .toContain('session not found')
    expect(host.querySelector('[data-step-chat-open-native]')?.textContent)
      .toBe('用 DSH 原生对话打开')
    const actions = host.querySelectorAll('[data-step-chat] > div')[2]
    expect(actions?.textContent).toContain('查看会话')
    // 重试行追加在出口按钮组**下方**，且不重复渲染任何出口按钮。
    const row = host.querySelector('[data-step-chat-retry-row]')
    expect(row).not.toBeNull()
    expect((actions?.compareDocumentPosition(row as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
    expect(host.querySelectorAll('[data-step-chat-open-native]').length).toBe(1)
    expect(host.querySelectorAll('[data-step-chat-retry-row]').length).toBe(1)
    // 重试行只有三模式 + 重试按钮这一组（不与出口按钮冲突）。
    const rowButtons = [...(row?.querySelectorAll('button') ?? [])]
    expect(rowButtons.map(node => node.textContent)).toEqual(['继续', '回退', '分叉', '重试'])
  })
})

describe('两态互斥与去重', () => {
  it('renders exactly one retry row (inside the panel action seat) when the session is open', () => {
    const stub = retryPortStub()
    const host = renderBody({ openState: 'open', retry: stub.port })
    const rows = host.querySelectorAll('[data-step-chat-retry-row]')
    expect(rows.length).toBe(1)
    // 需求 1：open 态的重试行落在面板底部动作位（原 composer seat 的位置），
    // 面板内不存在输入面。
    expect(rows[0]?.closest('[data-step-chat-retry-seat]')).not.toBeNull()
    expect(host.querySelector('[data-step-chat-composer-seat]')).toBeNull()
    expect(host.querySelector('[data-step-chat-composer]')).toBeNull()
    // 占位槽位不参与 open 态。
    expect(host.querySelector('[data-step-chat-retry-placeholder]')).toBeNull()
  })

  it('renders exactly one retry row (in the placeholder slot) while the session is not open', () => {
    const stub = retryPortStub()
    const host = renderBody({ openState: 'error', retry: stub.port })
    const rows = host.querySelectorAll('[data-step-chat-retry-row]')
    expect(rows.length).toBe(1)
    expect(rows[0]?.closest('[data-step-chat-retry-placeholder]')).not.toBeNull()
    // 未开窗时滚动器不渲染 → 底部动作位也不渲染（两态互斥、无重复 DOM）。
    expect(host.querySelector('[data-step-chat-retry-seat]')).toBeNull()
    expect(host.querySelector('[data-step-chat-composer-seat]')).toBeNull()
  })
})

describe('不可重试时占位态不新增 DOM', () => {
  it('stays byte-identical without a retry port', () => {
    for (const openState of ['cold', 'loading']) {
      const host = renderBody({ openState })
      expect(host.querySelector('[data-step-chat-retry-row]')).toBeNull()
      expect(host.querySelector('[data-step-chat-retry-placeholder]')).toBeNull()
      expect(host.querySelector('[data-step-chat]')?.children.length).toBe(1)
    }
    const error = renderBody({ openState: 'error', openError: { code: 'session/not-found' } })
    expect(error.querySelector('[data-step-chat-retry-row]')).toBeNull()
    expect(error.querySelector('[data-step-chat-retry-placeholder]')).toBeNull()
  })

  it('renders no retry row for a shell synthetic segment or a non-failed segment', () => {
    const shell = retryPortStub({ commandType: 'shell', synthetic: true })
    const host = renderBody({ openState: 'loading', retry: shell.port })
    expect(host.querySelector('[data-step-chat-retry-row]')).toBeNull()
    expect(host.querySelector('[data-step-chat-retry-placeholder]')).toBeNull()

    const running = retryPortStub({ status: 'running' })
    const host2 = renderBody({ openState: 'error', retry: running.port })
    expect(host2.querySelector('[data-step-chat-retry-row]')).toBeNull()

    const foreign = retryPortStub({ commandType: 'http' })
    const host3 = renderBody({ openState: 'error', retry: foreign.port })
    expect(host3.querySelector('[data-step-chat-retry-row]')).toBeNull()
  })
})
