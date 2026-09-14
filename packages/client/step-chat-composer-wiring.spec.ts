/**
 * step-chat-composer-wiring.spec（批 B1；**需求 1 改写**；@vitest-environment jsdom）：
 * 面板把「实例 Step 快照」接到 `@step` 提及源的组件级回归，以及**需求 1 之后面板
 * 内输入面确实不存在**的结构断言。
 *
 * 锁两件事（都属接线，不是纯函数）：
 * 1. **@step 登记接线**：StepChatBody 挂载 → 本实例的 Step 条目进 step-chat-registry
 *    （@step source 的 `candidates` 立即能读到）；传空/缺 instanceId 时不登记；卸载后
 *    登记被清理（不留下幽灵候选）；steps 变化时更新。登记面按**子会话 id** 索引，故
 *    凡是作用域落在该子会话的输入面（宿主原生对话页 / 未来恢复的面板输入框）都能读到
 *    同一份候选——需求 1 移除面板输入框不影响这条数据面。
 * 2. **需求 1：面板内没有输入面**——`composerSend` / `composerBinding` / `hostSessionId`
 *    三个接线 props 已从 `StepChatBody` 删除（本 spec 的 renderBody 不再传），面板不再
 *    挂载 ComposerBar，故结构上不存在输入壳 / 输入面 / 发送按钮 / 触发菜单锚点 /
 *    输入区 seat。文本面绑定（`editor.setRootElement`）与 textarea 降级路径的回归
 *    覆盖移回组件本体 spec（step-view/composer-bar-render.spec.ts）。
 *
 * 策略与 step-chat-panel-paging.spec 一致：jsdom + react-dom/client + primitives 桩
 * （primitives 的发布产物自带 *.module.css，vitest 默认外置 node_modules 不处理 CSS）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-chat-composer-wiring.spec
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
import { createStepMentionSource, STEP_MENTION_SOURCE } from './step-mention-source.ts'
import {
  clearStepChatRegistry,
  stepChatEntriesOf,
  stepChatInstanceOf,
  type StepMentionStepLike,
} from './step-chat-registry.ts'
import { StepChatBody } from './StepChatPanel.tsx'
import type { StepChatRetryPort } from './step-view/step-retry.ts'

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
/** 供 @step source 用的同一字典（断候选描述）。 */
const sourceT = t

const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  clearStepChatRegistry()
})

/** 会话桩：openState='open' + 可 ignore 的最小 subscribe/getSnapshot。 */
function makeSession() {
  const snapshot = {
    openState: 'open',
    running: true,
    hasMore: false,
    loadingOlder: false,
    openError: undefined,
  }
  return {
    snapshot,
    session: {
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      loadOlder: () => Promise.resolve(),
    },
  }
}

/** 空 view feed（order 空 → 空态占位；行树不渲染，接线用例只需面板主体）。 */
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

/** 两个 Step 段（step-a 有输出+产物；step-b 合成会话，应被跳过）。 */
const STEPS: readonly StepMentionStepLike[] = [
  {
    id: 'seg-1',
    stepId: 'step-a',
    name: '构建',
    status: 'completed',
    output: [{ type: 'text', text: '构建完成' }],
    artifacts: ['/tmp/out.txt'],
    sessionMeta: { childId: 'child-1', synthetic: false },
  },
  {
    id: 'seg-2',
    stepId: 'step-b',
    name: '部署',
    status: 'running',
    sessionMeta: { childId: 'child-2', synthetic: false },
  },
  {
    id: 'seg-shell',
    stepId: 'step-shell',
    name: 'echo',
    status: 'completed',
    sessionMeta: { synthetic: true },
  },
]

function render(element: ReactNode): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => { root.render(element) })
  return host
}

/** 渲染面板主体，可按需注入 instanceId/steps/重试端口（需求 1 起没有输入面 props）。 */
function renderBody(extra: {
  readonly instanceId?: string | undefined
  readonly steps?: readonly StepMentionStepLike[] | undefined
  readonly retry?: StepChatRetryPort | undefined
} = {}): HTMLElement {
  const session = makeSession()
  return render(h(StepChatBody, {
    session: session.session as never,
    viewFeed: makeFeed(),
    sessionId: 'child-1',
    ...(extra.instanceId === undefined ? {} : { instanceId: extra.instanceId }),
    ...(extra.steps === undefined ? {} : { steps: extra.steps }),
    ...(extra.retry === undefined ? {} : { retry: extra.retry }),
    t,
    onOpenSession: () => {},
    onOpenNative: () => {},
  }))
}

describe('@step 登记接线（面板 → registry → source）', () => {
  it('registers the instance steps on mount so the @step source can serve candidates', () => {
    renderBody({ instanceId: 'inst-1', steps: STEPS })
    expect(stepChatInstanceOf('child-1')).toBe('inst-1')
    expect(stepChatInstanceOf('child-2')).toBe('inst-1')
    expect(stepChatEntriesOf('child-1').map(entry => entry.stepId)).toEqual(['step-a', 'step-b'])
    const source = createStepMentionSource(sourceT)
    expect(source.trigger).toBe('@')
    expect(source.name).toBe(STEP_MENTION_SOURCE)
    return source.candidates({ sessionId: 'child-1' }, { query: '' }).then((items) => {
      expect(items.map(item => item.name)).toEqual(['构建', '部署'])
      expect(items[0]?.description).toBe('已完成 · 1 个产物')
    })
  })

  it('does not register without an instanceId or without real step sessions', () => {
    renderBody({ steps: STEPS })
    expect(stepChatInstanceOf('child-1')).toBeUndefined()
    const second = renderBody({ instanceId: 'inst-2', steps: [] })
    expect(second.querySelectorAll('[data-step-chat]').length).toBe(1)
    expect(stepChatInstanceOf('child-1')).toBeUndefined()
  })

  it('clears the registration on unmount (no ghost candidates)', () => {
    renderBody({ instanceId: 'inst-1', steps: STEPS })
    expect(stepChatInstanceOf('child-1')).toBe('inst-1')
    const root = roots[roots.length - 1]!
    act(() => { root.unmount() })
    roots.splice(roots.indexOf(root), 1)
    expect(stepChatInstanceOf('child-1')).toBeUndefined()
    expect(stepChatEntriesOf('child-1')).toEqual([])
  })
})

describe('需求 1：面板内不再挂载输入框（composerBinding / composerSend 通道已删除）', () => {
  it('renders no composer shell, input surface, send button or trigger menu', () => {
    // 面板**结构性**没有输入面：不传任何发送/内核绑定 props（它们已从 StepChatBody
    // 的类型面删除）也照样没有输入 DOM——与「通道是否可用」无关。
    const host = renderBody({ instanceId: 'inst-1', steps: STEPS })
    for (const selector of [
      '[data-step-chat-composer-seat]',
      '[data-step-chat-composer]',
      '[data-composer-input]',
      '[data-composer-send]',
      '[data-composer-queue-hint]',
      '[data-composer-menu-anchor]',
      '[data-trigger-menu]',
      '[data-composer-readonly-hint]',
    ]) {
      expect(host.querySelector(selector), `${selector} 不应出现在面板内`).toBeNull()
    }
    expect(host.querySelector('textarea')).toBeNull()
    // 面板本体仍在（Running 态会话区的容器与滚动契约都不受影响）。
    expect(host.querySelector('[data-step-chat]')).not.toBeNull()
    expect(host.querySelector('[data-conversation-scroll]')).not.toBeNull()
    // 底部动作位只在有可重试段时才存在（需求 1：这个位置不再有输入框占位）。
    expect(host.querySelector('[data-step-chat-retry-seat]')).toBeNull()
  })

  it('keeps the @step data plane while the input surface is gone', () => {
    // 一条反向对照：面板没有输入面，但 @step 的**数据面**照旧登记（宿主原生对话页/
    // 未来恢复的输入框仍可读到候选）——「去掉输入框」不等于「去掉 @step 能力」。
    renderBody({ instanceId: 'inst-1', steps: STEPS })
    expect(stepChatEntriesOf('child-1').map(entry => entry.stepId)).toEqual(['step-a', 'step-b'])
  })
})
