/**
 * main-agent-composer.spec（呈现层统一 · 决策变更后；@vitest-environment jsdom）：
 * 运行页底部输入区的**接线**回归（输入框自身的行为见 main-agent-input.spec.ts）。
 *
 * 用户决策变更后的新语义：「运行页 discussion 的输入框**不再复用/接管 DSH 会话输入壳**，
 * 重新实现一个一模一样的输入框」。故本 spec 锁四件事（都是接线/结构，不是纯函数）：
 * 1. **席位接线**：`[data-sandore-disc-input]` 里有「主代理」标识行 + **独立输入框**
 *    （`[data-sandore-main-input]`），其文本面是原生 `textarea`、**没有** DSH 内核锚点
 *    （`[data-composer-input]` / `[data-composer-kernel]` 等）——运行页输入框与 DSH 输入壳
 *    彻底隔离；
 * 2. **发送投递到主代理会话**：通道来自 `sessions.binding(hostSessionId)` 的
 *    `conversation.send`（`stepChatComposerSendOf` 的首选路），点发送即被调用；成功清空草稿；
 * 3. **不再有根接管**：宿主会话的编辑器面（`editor.setRootElement`）**从不被调用**，
 *    先占着根的那个元素（DSH 中心列 InputBar）**始终还是根**——这是「隔离」的硬证据
 *    （旧实现的 `takeRoot` / `setRootElement(prev)` 归还逻辑已随决策变更整块删除）；
 * 4. **需求 2/4（真机反馈第三轮后）**：无 `@step` 选择器与触发菜单；输入框区**没有任何**
 *    暂停/停止/中止按钮（只剩权限下拉 + 模型下拉 + 发送钮），
 *    暂停入口改为 DSH 中心列自带的「停止生成」（真机断言在 m5）。
 *
 * 装配方式与 step-chat-composer-wiring.spec 一致：jsdom + react-dom/client + primitives 桩
 * （primitives 的发布产物自带 *.module.css，vitest 默认外置 node_modules 不处理 CSS）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/main-agent-composer.spec
 */
// @vitest-environment jsdom
// React 18 需要显式声明 act 环境（否则每个 act 调用打 warning）。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

// primitives 全部替换为最小行为桩（同 step-chat-composer-wiring.spec 的做法与理由：
// DiscussionInput 的模块图经 StepChatPanel 拉进 step-view 行组件，桩必须覆盖它们用到的
// 全部 primitives 导出，否则 vi.mock 的「未定义导出」会在 import 期炸掉整个 suite）。
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

import { zh } from './locales.ts'
import { DiscussionInput } from './DiscussionInput.tsx'
import { installStepChatSessions } from './StepChatPanel.tsx'

/** sandore zh 字典桩翻译。 */
function makeT() {
  const lookup = zh as unknown as Record<string, string>
  return (key: string, params?: Record<string, unknown>): string => {
    let text = lookup[key] ?? key
    if (params !== undefined) {
      for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
    }
    return text
  }
}
const t = makeT() as never

/** 宿主（主代理）会话 id（= 实例宿主会话）。 */
const HOST_SESSION = 'host-session-1'

/**
 * 会话绑定桩：`conversation.send` 是发送通道的首选路；`input.for` 只为「万一有人改回挂内核」
 * 时能探测到，并让 {@link sessionStub.editor} 记录任何 `setRootElement` 调用（根接管取证）。
 */
function sessionStub() {
  const send = vi.fn(async () => undefined)
  const rootCalls: Array<HTMLElement | null> = []
  let root: HTMLElement | null = null
  const editor = {
    setRootElement: (el: HTMLElement | null) => { rootCalls.push(el); root = el },
    getRootElement: () => root,
    setEditable: () => undefined,
    getDecorators: () => ({}),
    registerDecoratorListener: () => () => undefined,
    getElementByKey: () => null,
    focus: () => undefined,
  }
  const sessionSnapshot = { openState: 'open', running: false, hasMore: false, loadingOlder: false }
  return {
    send,
    rootCalls,
    getRoot: () => root,
    /** 模拟「DSH 中心列的 InputBar 已经占着编辑器根」（旧实现会被接管走）。 */
    occupyRoot: (el: HTMLElement) => { editor.setRootElement(el) },
    binding: {
      session: { subscribe: () => () => undefined, getSnapshot: () => sessionSnapshot },
      ctx: {
        get: (name: string) => (name === 'conversation'
          ? {
            send,
            input: {
              for: () => ({
                state: { getSnapshot: () => ({ draft: '', phase: 'plain' }), subscribe: () => () => undefined },
                editor,
                submit: () => undefined,
              }),
            },
          }
          : undefined),
      },
    },
  }
}

/** 会话列表桩（binding 恒命中；快照身份稳定，避免 uSES 无限重渲）。 */
function sessionsStub(binding: unknown) {
  const snapshot = { current: HOST_SESSION, byId: {} as Record<string, unknown> }
  return {
    list: { subscribe: () => () => undefined, getSnapshot: () => snapshot },
    binding: () => binding,
  }
}

const roots: ReturnType<typeof createRoot>[] = []
const disposers: Array<() => void> = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const dispose of disposers.splice(0)) dispose()
})

/** 渲染运行页底部输入区（可按需覆盖 props）。 */
/** 席位 face 桩：模型目录（**可路由** → 触发器渲染）/ 权限投影（三档预设）/ 命令通路。 */
function seatFacesStub() {
  const directorySnapshot = {
    current: { provider: 'e2e-mock', model: 'mock-1' },
    routable: true,
    groups: [{ id: 'e2e-mock', name: 'E2E Mock', models: [{ id: 'mock-1', name: 'E2E Mock' }] }],
    failures: [],
    status: 'ready' as const,
    error: null,
  }
  const permissionSnapshot = {
    options: [
      { value: 'read-only', name: 'read-only' },
      { value: 'workspace-write', name: 'workspace-write' },
      { value: 'danger-full-access', name: 'danger-full-access' },
    ],
    currentValue: 'workspace-write',
  }
  return {
    directorySnapshot,
    permissionSnapshot,
    modelDirectory: () => ({
      store: { getSnapshot: () => directorySnapshot, subscribe: () => () => undefined },
      load: async () => directorySnapshot,
      select: async () => undefined,
      dispose: () => undefined,
    }),
    permissionFace: () => ({
      getSnapshot: () => permissionSnapshot,
      subscribe: () => () => undefined,
    }),
    runCommand: async () => true,
    setInstancePermission: async () => undefined,
    queryPermission: async () => permissionSnapshot,
  }
}

function renderDiscussion(extra: {
  readonly status?: string
  readonly binding?: unknown
} = {}): HTMLElement {
  disposers.push(installStepChatSessions(sessionsStub(extra.binding) as never))
  const faces = seatFacesStub()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => {
    root.render(h(DiscussionInput, {
      t,
      status: (extra.status ?? 'running') as never,
      steps: [],
      questions: [],
      permissions: [],
      pending: false,
      onReplyQuestion: () => {},
      onRejectQuestion: () => {},
      onReplyPermission: () => {},
      hostSessionId: HOST_SESSION,
      modelDirectory: faces.modelDirectory,
      permissionFace: faces.permissionFace,
      runCommand: faces.runCommand,
      setInstancePermission: faces.setInstancePermission,
      queryPermission: faces.queryPermission,
    } as never))
  })
  return host
}

/** 渲染**接管态**（ask 问题选择 / permission 权限申请）——宽度规则的落点。 */
function renderDiscussionWithTakeover(
  kind: 'question' | 'approval',
  binding: unknown,
): HTMLElement {
  disposers.push(installStepChatSessions(sessionsStub(binding) as never))
  const faces = seatFacesStub()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  const question = {
    id: 'q-1', stageId: 'stg-1', stepId: 'step-a', sessionId: 'child-a', requestId: 'req-1',
    kind: 'question', status: 'pending',
    payload: { questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '是' }] }] },
  }
  const permission = {
    id: 'p-1', stageId: 'stg-1', stepId: 'step-a', sessionId: 'child-a', requestId: 'req-2',
    kind: 'permission', status: 'pending',
    payload: { command: 'bash', description: '运行命令', args: 'ls' },
  }
  act(() => {
    root.render(h(DiscussionInput, {
      t,
      status: 'running' as never,
      steps: [],
      questions: kind === 'question' ? [question] : [],
      permissions: kind === 'approval' ? [permission] : [],
      pending: false,
      onReplyQuestion: () => {},
      onRejectQuestion: () => {},
      onReplyPermission: () => {},
      hostSessionId: HOST_SESSION,
      modelDirectory: faces.modelDirectory,
      permissionFace: faces.permissionFace,
      runCommand: faces.runCommand,
      setInstancePermission: faces.setInstancePermission,
      queryPermission: faces.queryPermission,
    } as never))
  })
  return host
}

/** 受控 textarea 输入（React onChange 通道）。 */
function typeInto(area: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    setter?.call(area, value)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('决策变更：运行页输入框是独立输入框（不挂 DSH 输入壳）', () => {
  it('renders the independent input with no seat label row and no DSH-kernel surface', () => {
    const session = sessionStub()
    const host = renderDiscussion({ binding: session.binding })
    const disc = host.querySelector('[data-sandore-disc-input]')
    expect(disc).not.toBeNull()
    // 真机反馈修正：输入框上方那行标签**已删除**（用户明确不要）。
    expect(disc?.querySelector('[data-sandore-main-input-label]'), '标签行不应存在').toBeNull()
    // 独立输入框（DSH InputBar 同款壳）：原生 textarea + 发送钮。
    const seat = disc?.querySelector('[data-sandore-main-input]')
    expect(seat).not.toBeNull()
    expect(seat?.querySelector('[data-main-agent-input]')?.tagName).toBe('TEXTAREA')
    expect(seat?.querySelector('[data-main-agent-send]')).not.toBeNull()
    // 与 DSH 输入壳隔离：没有任何内核锚点/可编辑内核面。
    for (const selector of [
      '[data-composer-input]',
      '[data-composer-kernel]',
      '[data-composer-took-root]',
      '[contenteditable="true"]',
    ]) {
      expect(disc?.querySelector(selector), `${selector} 不应出现（独立输入框）`).toBeNull()
    }
  })

  it('delivers the message through the host session channel (conversation.send)', async () => {
    const session = sessionStub()
    const host = renderDiscussion({ binding: session.binding })
    const area = host.querySelector('[data-main-agent-input]') as HTMLTextAreaElement
    const send = host.querySelector('[data-main-agent-send]') as HTMLButtonElement
    typeInto(area, '给主代理的一句话')
    await act(async () => {
      send.click()
      await Promise.resolve()
    })
    expect(session.send).toHaveBeenCalledWith('给主代理的一句话')
    expect(area.value).toBe('')
  })

  it('never touches the host session editor root (no root takeover, DSH column keeps its root)', () => {
    const session = sessionStub()
    // 先模拟 DSH 中心列的 InputBar 已经占着编辑器根。
    const dshSurface = document.createElement('div')
    document.body.appendChild(dshSurface)
    session.occupyRoot(dshSurface)
    session.rootCalls.length = 0 // 占根那一步本身会调用一次；只看本次渲染之后的行为。

    const host = renderDiscussion({ binding: session.binding })
    const area = host.querySelector('[data-main-agent-input]') as HTMLTextAreaElement
    typeInto(area, '输入并发送')
    act(() => { (host.querySelector('[data-main-agent-send]') as HTMLButtonElement).click() })
    const root = roots[roots.length - 1]!
    act(() => { root.unmount() })
    roots.splice(roots.indexOf(root), 1)
    // 关键证据：渲染 → 输入 → 发送 → 卸载，全程**没有**任何 setRootElement 调用，
    // 根始终是 DSH 中心列那个元素（隔离，而不是旧实现的「接管 + 归还」）。
    expect(session.rootCalls).toEqual([])
    expect(session.getRoot()).toBe(dshSurface)
  })

  it('shows an explicit disabled state when the host session is not ready (no channel)', () => {
    const host = renderDiscussion({ binding: undefined })
    // 输入框仍在（结构稳定），但发送被禁用——绝不出现「永远发不出去」的交互。
    const area = host.querySelector('[data-main-agent-input]') as HTMLTextAreaElement
    const send = host.querySelector('[data-main-agent-send]') as HTMLButtonElement
    expect(area).not.toBeNull()
    expect(send.disabled).toBe(true)
    // 输入框区不再有任何工作流动作按钮（真机反馈第三轮：连唯一的「停止生成」也去掉了）；
    // 发送钮禁用只是「空草稿」语义，不是缺控件。
    expect(host.querySelector('[data-sandore-stop]')).toBeNull()
  })
})

describe('需求 2：@step 结构化引用已退役（运行页无选择器、无触发菜单）', () => {
  it('renders no step picker and no trigger menu', () => {
    const session = sessionStub()
    const host = renderDiscussion({ binding: session.binding })
    expect(host.querySelector('[data-sandore-step-picker]')).toBeNull()
    expect(host.querySelector('[data-trigger-menu]')).toBeNull()
    expect(host.querySelector('[data-composer-menu-anchor]')).toBeNull()
    expect(host.textContent ?? '').not.toContain('广播（所有 Step）')
  })
})

describe('需求 4（真机反馈第三轮）：输入框区**没有任何**暂停/停止/中止按钮', () => {
  it('renders ZERO pause/stop/abort buttons in the input area', () => {
    const session = sessionStub()
    const host = renderDiscussion({ binding: session.binding })
    const disc = host.querySelector('[data-sandore-disc-input]')!
    // 三个锚点都不存在（真机原话：「还是有个暂停按钮在输入框那里……去掉这个按钮」）。
    expect(disc.querySelector('[data-sandore-stop]')).toBeNull()
    for (const label of ['暂停', '停止生成', '中止', 'Pause', 'Abort', 'Stop generating']) {
      expect(
        disc.querySelector(`button[aria-label="${label}"]`),
        `输入框区不应有 aria-label="${label}" 的按钮`,
      ).toBeNull()
    }
    // 逐按钮扫 aria-label/文案（防漏网：任何命中暂停/停止/中止字样的按钮都不允许）。
    const suspicious = [...disc.querySelectorAll('button')].filter((button) => {
      const text = `${button.getAttribute('aria-label') ?? ''}${button.getAttribute('title') ?? ''}${button.textContent ?? ''}`
      return /暂停|停止|中止|Pause|Abort|Stop/i.test(text)
    })
    expect(suspicious.map(node => node.getAttribute('aria-label') ?? node.textContent)).toEqual([])
    // 非运行态同样没有（这条曾是「只在 running 显示」的语义，现在任何态都没有）。
    for (const status of ['paused', 'completed', 'failed', 'aborted', 'running']) {
      const other = renderDiscussion({ binding: session.binding, status })
      expect(other.querySelectorAll('[data-sandore-stop]'), `${status} 态不应有停止按钮`).toHaveLength(0)
      expect(other.querySelector('[data-main-agent-input]'), `${status} 态输入框仍在`).not.toBeNull()
    }
  })

  it('keeps exactly the permission seat, the model seat and the send button in the action row', () => {
    const session = sessionStub()
    const host = renderDiscussion({ binding: session.binding })
    const disc = host.querySelector('[data-sandore-disc-input]')!
    expect(disc.querySelector('[data-main-agent-access]'), '左侧权限下拉仍在').not.toBeNull()
    expect(disc.querySelector('[data-main-agent-model-trigger]'), '右侧模型下拉仍在').not.toBeNull()
    expect(disc.querySelector('[data-main-agent-send]'), '发送钮仍在').not.toBeNull()
    // 动作行里的按钮**只有**这三个（权限触发 / 模型触发 / 发送）——多一个就是又塞了动作按钮。
    const row = disc.querySelector('[data-main-agent-input-card]')!
    const buttons = [...row.querySelectorAll('button')]
      .map(node => (node.hasAttribute('data-main-agent-send')
        ? 'send'
        : node.closest('[data-main-agent-access]') !== null
          ? 'access'
          : node.closest('[data-main-agent-model-trigger]') !== null ? 'model' : 'UNEXPECTED'))
    expect(buttons.sort()).toEqual(['access', 'model', 'send'])
  })

  it('documents the removal: no .stopBtn style and no stale locale keys remain (no dead code)', () => {
    const css = readFileSync(resolve(process.cwd(), 'packages/client/input.module.css'), 'utf8')
    // 样式块删除并留「已删除」标记注释（保留历史线索，不留半死代码）。
    expect(css).not.toMatch(/\n\.stopBtn \{/)
    expect(css).toContain('已删除：输入框区的停止/暂停按钮')
    const locales = readFileSync(resolve(process.cwd(), 'packages/client/locales.ts'), 'utf8')
    for (const key of ["'composer.stop'", "'run.pause.title'", "'input.pause'"]) {
      expect(locales, `${key} 已随按钮删除`).not.toContain(key)
    }
    // 暂停入口的说明必须留在源码里（能力不丢，别的入口承接）。
    expect(css).toContain('停止生成')
    expect(locales).toContain('停止按钮')
  })

  it('keeps the takeover cards on the same width rule as the input (ask / permission)', () => {
    // 接管卡（ask 问题选择 / permission 权限申请）与输入卡共用同一条宽度规则：
    // `min(calc(消息列内容宽 + 24px), 100%)` + 同轴心（真机反馈：「弹出的权限申请和问题选择，
    // 为啥没有和输入框保持统一宽度？」）。jsdom 不加载 CSS module，故断言锚点 + 样式源。
    const css = readFileSync(resolve(process.cwd(), 'packages/client/input.module.css'), 'utf8')
    for (const selector of ['.approvalCard', '.questionCard']) {
      const block = new RegExp(`\\n\\${selector} \\{([\\s\\S]*?)\\n\\}`).exec(css)?.[1] ?? ''
      expect(block, `${selector} 应与输入卡同宽（基准 + 24px）`).toContain('var(--sandore-msg-content-width, 100%) + 24px')
      expect(block, `${selector} 应与输入卡同轴心`).toContain('margin-inline: auto')
      // border-box：1px 描边算进宽度，与输入卡逐像素相同（否则会宽 2px）。
      expect(block, `${selector} 应使用 border-box`).toContain('box-sizing: border-box')
    }
    // 接管态渲染时锚点在（ask / permission 两类各一个）。
    const session = sessionStub()
    const host = renderDiscussionWithTakeover('question', session.binding)
    expect(host.querySelector('[data-sandore-takeover="question"]')).not.toBeNull()
    expect(host.querySelector('[class*="questionCard"]')).not.toBeNull()
  })

  it('renders the permission takeover card with the same width contract', () => {
    const session = sessionStub()
    const host = renderDiscussionWithTakeover('approval', session.binding)
    expect(host.querySelector('[data-sandore-takeover="approval"]')).not.toBeNull()
    expect(host.querySelector('[class*="approvalCard"]')).not.toBeNull()
  })
})
