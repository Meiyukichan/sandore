/**
 * composer-bar-render.spec（B4b + 批 B1；@vitest-environment jsdom）：ComposerBar 的
 * 组件级行为回归。
 *
 * B4b（降级路径／无 binding）：展示条件（open+running 才显示）、输入→发送（桩 send
 * 被调且参数为草稿文本）、成功清空 / 失败错误行 / 发送中禁用、Enter vs Shift+Enter、
 * IME/空草稿守卫。
 *
 * 批 B1（内核路径／有 binding）：**内核可用 → contenteditable 壳 + 绑定 DSH 编辑器**
 * （`setRootElement(el)` 被调、`setEditable` 随相位）、草稿订阅驱动禁用态、发送/Enter
 * → `kernel.submit('queue')`、**壳内不存在 `+`（指令）按钮**（自绘壳的结构性保证）、
 * 编辑器根被别处占用 → 只读降级、**宿主原生对话页占着同一根 → 不绑内核**（绑定前
 * 守卫）；**内核缺失 → textarea 降级路径仍可发送**。
 *
 * 需求 1 说明：本组件**当前不被面板挂载**（面板内嵌输入框已移除；StepChatPanel 只
 * 保留重试行），本 spec 因此是它唯一的行为守护者——保留为「恢复面板输入框」的回归网
 * （见 ComposerBar.tsx 文件头「需求 1」段）。
 *
 * 沿用 step-view-render.spec 的模式（@vitest-environment jsdom + react-dom/client +
 * act；无真实排版断言，视觉由真实宿主 + CSS 承担）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/composer-bar-render.spec
 */
// @vitest-environment jsdom
// React 18 需要显式声明 act 环境（否则每个 act 调用打 warning）。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import { zh } from '../locales.ts'
import { ComposerBar } from './ComposerBar.tsx'
import type { StepChatComposerSend } from './composer-bar.ts'
import type { StepComposerInputStateLike } from './dsh-composer.ts'

/** sandore zh 字典桩翻译（与 step-view-render.spec 同款）。 */
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
})

function render(element: ReactNode): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => { root.render(element) })
  return host
}

/** 等待 send 承诺链落盘（微任务刷新；React 状态更新在此 flush）。 */
async function flushAsync(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

/** 受控 textarea 输入：native setter + input 事件（React onChange 通道）。 */
function typeInto(area: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    setter?.call(area, value)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 挂一个 open+running 的 ComposerBar；返回 {host, area, button}。 */
function mountComposer(send: StepChatComposerSend): {
  host: HTMLElement
  area: HTMLTextAreaElement
  button: HTMLButtonElement
} {
  const host = render(h(ComposerBar, { openState: 'open', running: true, send, t }))
  const area = host.querySelector('textarea')
  const button = host.querySelector('button')
  expect(area).not.toBeNull()
  expect(button).not.toBeNull()
  return { host, area: area as HTMLTextAreaElement, button: button as HTMLButtonElement }
}

describe('ComposerBar render smoke（jsdom）', () => {
  it('renders the simplified composer only while open and running', () => {
    const send: StepChatComposerSend = vi.fn(async () => ({ ok: true }))
    const host = render(h(ComposerBar, { openState: 'open', running: true, send, t }))
    const root = host.querySelector('[data-step-chat-composer]')
    expect(root).not.toBeNull()
    expect(host.querySelector('[data-composer-input]')).not.toBeNull()
  })

  it('renders nothing when not open or not running (paused/completed/loading/error)', () => {
    const send: StepChatComposerSend = vi.fn(async () => ({ ok: true }))
    for (const props of [
      { openState: 'open', running: false },
      { openState: 'loading', running: true },
      { openState: 'error', running: true },
      { openState: 'cold', running: true },
      { openState: undefined, running: true },
    ]) {
      const host = render(h(ComposerBar, {
        ...props,
        send,
        t,
      } as never))
      expect(host.querySelector('[data-step-chat-composer]')).toBeNull()
    }
  })

  it('shows the rc.1-aligned placeholder, send button and queue hint copy', () => {
    const send: StepChatComposerSend = vi.fn(async () => ({ ok: true }))
    const { host, area } = mountComposer(send)
    // 占位：rc.1 composer placeholder.default 前半段（@/slash 指令已裁剪）
    expect(area.getAttribute('placeholder')).toBe('发消息或做任务…')
    expect(area.getAttribute('aria-label')).toBe('发消息或做任务…') // rc.1：placeholder 兼作可访问名
    const button = host.querySelector('[data-composer-send]')
    expect(button?.getAttribute('aria-label')).toBe('发送消息') // rc.1 input.send
    expect(host.textContent ?? '').toContain('排队发送') // 运行中排队语义提示
    expect(host.querySelector('[data-composer-status]')).toBeNull() // 空闲无状态行
  })
})

describe('ComposerBar send state machine（jsdom）', () => {
  it('disables the send button on an empty draft', () => {
    const send: StepChatComposerSend = vi.fn(async () => ({ ok: true }))
    const { button } = mountComposer(send)
    expect(button.disabled).toBe(true)
  })

  it('sends typed text through the stub and clears the draft on success', async () => {
    const send = vi.fn(async () => ({ ok: true } as const))
    const { area, button } = mountComposer(send)
    typeInto(area, '你好，继续执行')
    expect(button.disabled).toBe(false)
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('你好，继续执行') // 组件传原始草稿；文本块成型在发送通道
    expect(area.value).toBe('') // 成功清空
    expect(button.disabled).toBe(true)
    expect(hostStatus(area)).toBeNull()
  })

  it('sends on plain Enter and never on Shift+Enter', async () => {
    const send = vi.fn(async () => ({ ok: true } as const))
    const { area } = mountComposer(send)
    typeInto(area, '回车发送')
    await act(async () => {
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('回车发送')

    typeInto(area, '继续')
    await act(async () => {
      area.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', shiftKey: true, bubbles: true,
      }))
      await Promise.resolve()
    })
    expect(send).toHaveBeenCalledTimes(1) // Shift+Enter：换行不发送
  })

  it('ignores Enter on empty/whitespace drafts and does not send while in flight', async () => {
    const send = vi.fn(async () => ({ ok: true } as const))
    const { area, button } = mountComposer(send)
    // 空草稿 Enter 不发送（IME 组合期的 Enter 由 nativeEvent.isComposing 守卫，
    // jsdom 无法构造该标志，真机冒烟目检项覆盖）
    await act(async () => {
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })
    expect(send).not.toHaveBeenCalled()
    // 全空白草稿：按钮禁用，点击不发送
    typeInto(area, '   ')
    expect(button.disabled).toBe(true)
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('shows a send-failed error line (message (code)) and keeps the draft', async () => {
    const send: StepChatComposerSend = vi.fn(async () => ({
      ok: false,
      message: 'prompt rejected',
      code: 'session/agent-busy',
    }))
    const { host, area, button } = mountComposer(send)
    typeInto(area, '会失败的内容')
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    const status = host.querySelector('[data-composer-status]')
    expect(status?.getAttribute('role')).toBe('alert')
    expect(status?.textContent).toBe('prompt rejected (session/agent-busy)')
    expect(area.value).toBe('会失败的内容') // 失败保留草稿供重发
    // 再次输入清除错误行
    typeInto(area, '会失败的内容2')
    expect(host.querySelector('[data-composer-status]')).toBeNull()
  })

  it('disables the button with sending copy while the prompt is in flight', async () => {
    let resolveSend: ((value: { ok: true }) => void) | undefined
    const send = vi.fn(() => new Promise<{ ok: true }>((resolve) => { resolveSend = resolve }))
    const { host, area, button } = mountComposer(send)
    typeInto(area, '慢速消息')
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushAsync()
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(button.disabled).toBe(true) // sending：禁用按钮
    expect(button.getAttribute('aria-label')).toBe('发送中…')
    expect(host.querySelector('[data-composer-status]')?.textContent).toBe('发送中…')
    // 完成后恢复 idle（可再次发送）
    await act(async () => {
      resolveSend?.({ ok: true })
      await Promise.resolve()
    })
    expect(button.getAttribute('aria-label')).toBe('发送消息')
    expect(host.querySelector('[data-composer-status]')).toBeNull()
  })
})

/** 读状态行元素（错误 alert / 发送中 status）。 */
function hostStatus(area: HTMLTextAreaElement): Element | null {
  return area.closest('[data-step-chat-composer]')?.querySelector('[data-composer-status]') ?? null
}

// ── 批 B1：内核路径（DSH 输入内核 + 自绘壳） ────────────────────────────────

/** 内核桩（SessionInputShell 的结构子集；记录动作与编辑器绑定）。 */
function kernelStub() {
  const listeners = new Set<() => void>()
  let state: StepComposerInputStateLike & { queue?: readonly unknown[] } = { draft: '', phase: 'plain' }
  const calls = { submit: [] as Array<string | undefined>, setRoot: [] as Array<HTMLElement | null>, editable: [] as boolean[], arbitrate: [] as string[], space: 0, dismissPopup: 0, steerQueue: 0 }
  let root: HTMLElement | null = null
  const editor = {
    setRootElement: (el: HTMLElement | null) => { calls.setRoot.push(el); root = el },
    getRootElement: () => root,
    setEditable: (value: boolean) => { calls.editable.push(value) },
    getDecorators: () => ({}),
    registerDecoratorListener: () => () => undefined,
    getElementByKey: () => null,
    focus: () => undefined,
  }
  const shell = {
    state: {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    editor,
    setDraft: (text: string) => { state = { ...state, draft: text }; publish() },
    submit: (mode?: string) => { calls.submit.push(mode) },
    arbitrate: (key: string) => { calls.arbitrate.push(key); return 'pass' as const },
    space: () => { calls.space += 1; return false },
    dismissPopup: () => { calls.dismissPopup += 1 },
    steerQueue: () => { calls.steerQueue += 1 },
    caretSpan: () => ({ start: 0, end: 0 }),
  }
  const publish = (): void => { for (const listener of [...listeners]) listener() }
  return {
    calls,
    editor,
    /** 组装 binding（`ctx.conversation.input.for(ctx)` → shell）。 */
    binding: { session: {}, ctx: { conversation: { input: { for: () => shell } } } } as never,
    /** 模拟内核发布新状态（草稿/相位/队列变化 → 组件重渲）。 */
    setState: (next: StepComposerInputStateLike & { queue?: readonly unknown[] }) => {
      state = next
      publish()
    },
    /** 模拟「根已被别处占用」（宿主原生会话页同时打开该子代理）。 */
    occupyRoot: (el: HTMLElement) => { editor.setRootElement(el) },
    getRoot: () => root,
  }
}

describe('ComposerBar kernel path（批 B1：DSH 输入内核 + 自绘壳）', () => {
  it('binds the DSH editor to a contenteditable shell and never renders the `+` command button', () => {
    const kernel = kernelStub()
    const send = vi.fn(async () => ({ ok: true } as const))
    const host = render(h(ComposerBar, { openState: 'open', running: true, send, binding: kernel.binding, t }))
    const shell = host.querySelector('[data-step-chat-composer]')
    expect(shell?.getAttribute('data-composer-kernel')).toBe('dsh')
    const surface = shell?.querySelector('[data-composer-input]')
    expect(surface?.tagName).toBe('DIV')
    expect(surface?.getAttribute('contenteditable')).toBe('true')
    expect(surface?.getAttribute('role')).toBe('textbox')
    expect(surface?.getAttribute('aria-label')).toBe('发消息或做任务…')
    expect(surface?.getAttribute('data-placeholder')).toBe('发消息或做任务…')
    // 文本面已交给内核编辑器（绑定 + 可编辑；首次绑定可能先经过一帧 pending=false）。
    expect(kernel.calls.setRoot).toContain(surface as HTMLElement)
    expect(kernel.getRoot()).toBe(surface as HTMLElement)
    expect(kernel.calls.editable[kernel.calls.editable.length - 1]).toBe(true)
    // 自绘壳结构性保证：壳内没有任何 `+`/「指令」入口（DSH InputBar 的 .tools > .add）。
    const buttons = [...(shell?.querySelectorAll('button') ?? [])]
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.hasAttribute('data-composer-send')).toBe(true)
    expect((shell?.textContent ?? '').includes('指令')).toBe(false)
    // 降级路径的 textarea 不在内核路径里出现。
    expect(shell?.querySelector('textarea')).toBeNull()
  })

  it('drives the draft and the disabled state from the kernel state store', () => {
    const kernel = kernelStub()
    const send = vi.fn(async () => ({ ok: true } as const))
    const host = render(h(ComposerBar, { openState: 'open', running: true, send, binding: kernel.binding, t }))
    const button = host.querySelector('[data-composer-send]') as HTMLButtonElement
    expect(button.disabled).toBe(true) // 空草稿
    act(() => { kernel.setState({ draft: '继续执行', phase: 'plain' }) })
    expect(button.disabled).toBe(false)
    // 忙碌相位（adjudicating/submitting）：禁用 + 发送中文案 + 状态行。
    act(() => { kernel.setState({ draft: '继续执行', phase: 'submitting' }) })
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-label')).toBe('发送中…')
    expect(host.querySelector('[data-composer-status]')?.textContent).toBe('发送中…')
    act(() => { kernel.setState({ draft: '', phase: 'plain' }) })
    expect(host.querySelector('[data-composer-status]')).toBeNull()
  })

  it('submits through the kernel in queue mode on click and on Enter, never on Shift+Enter', () => {
    const kernel = kernelStub()
    const send = vi.fn(async () => ({ ok: true } as const))
    const host = render(h(ComposerBar, { openState: 'open', running: true, send, binding: kernel.binding, t }))
    const surface = host.querySelector('[data-composer-input]') as HTMLElement
    act(() => { kernel.setState({ draft: '你好', phase: 'plain' }) })
    act(() => { (host.querySelector('[data-composer-send]') as HTMLButtonElement).click() })
    expect(kernel.calls.submit).toEqual(['queue'])
    // 降级通道（conversation.send）在内核路径下**不得**被调用（唯一发送口是内核）。
    expect(send).not.toHaveBeenCalled()

    // Enter 经 DOM capture 拦截 → kernel.submit('queue')；Shift+Enter 放行不提交。
    act(() => { surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(kernel.calls.submit).toEqual(['queue', 'queue'])
    act(() => { surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })) })
    expect(kernel.calls.submit).toEqual(['queue', 'queue'])
    // IME 组合期 Enter 同样不提交。
    act(() => { surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })) })
    expect(kernel.calls.submit).toEqual(['queue', 'queue'])
    // 菜单键走内核仲裁（Enter 先问菜单是否消费，未消费才落到提交；方向键同理放行；
    // IME 组合期与 Shift+Enter 完全不进仲裁）。
    act(() => { surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    expect(kernel.calls.arbitrate).toEqual(['enter', 'down'])  })

  it('keeps the composer alive while queued messages remain (running flap)', () => {
    const kernel = kernelStub()
    const send = vi.fn(async () => ({ ok: true } as const))
    act(() => { kernel.setState({ draft: '', phase: 'plain', queue: [{ id: 'q1' }] }) })
    const host = render(h(ComposerBar, { openState: 'open', running: false, send, binding: kernel.binding, t }))
    expect(host.querySelector('[data-step-chat-composer]')).not.toBeNull()
    // 队列清空且未运行 → 隐藏（回到「仅运行中注入」的默认语义）。
    act(() => { kernel.setState({ draft: '', phase: 'plain', queue: [] }) })
    expect(host.querySelector('[data-step-chat-composer]')).toBeNull()
  })

  it('degrades to read-only when the editor root is already claimed elsewhere', () => {
    const kernel = kernelStub()
    const foreign = document.createElement('div')
    kernel.occupyRoot(foreign) // 宿主原生会话页已绑同一个输入壳
    const send = vi.fn(async () => ({ ok: true } as const))
    const host = render(h(ComposerBar, { openState: 'open', running: true, send, binding: kernel.binding, t }))
    const surface = host.querySelector('[data-composer-input]')
    expect(surface?.getAttribute('contenteditable')).toBe('false')
    expect(surface?.hasAttribute('data-composer-readonly')).toBe(true)
    expect((host.querySelector('[data-composer-send]') as HTMLButtonElement).disabled).toBe(true)
    // 不抢根：内核的根仍是外部元素（不 setRootElement 到本卡）。
    expect(kernel.getRoot()).toBe(foreign)
    expect(kernel.calls.setRoot).toEqual([foreign])
  })

  // 绑定**前**的根抢占守卫（批 B2：「宿主原生对话页正显示本子代理会话」）——原本只在
  // 面板层（step-chat-retry-wiring.spec）覆盖；需求 1 把面板侧的接线删掉后，本组件
  // （保留为面板输入框的恢复入口）仍带这道守卫，故覆盖随之下移到本文件。
  it('never binds the kernel when the host chat page shows this child session', () => {
    const kernel = kernelStub()
    const send = vi.fn(async () => ({ ok: true } as const))
    const host = render(h(ComposerBar, {
      openState: 'open',
      running: true,
      send,
      binding: kernel.binding,
      sessionId: 'child-1',
      hostSessionId: 'child-1', // sessions.list.getSnapshot().current === 本子会话
      t,
    }))
    const surface = host.querySelector('[data-composer-input]')
    // 未绑内核：根留空（不抢宿主页的 editor），文本面只读并留痕。
    expect(kernel.calls.setRoot).toEqual([])
    expect(kernel.getRoot()).toBeNull()
    expect(surface?.getAttribute('contenteditable')).toBe('false')
    expect(surface?.hasAttribute('data-composer-readonly')).toBe(true)
    expect(surface?.hasAttribute('data-composer-host-claimed')).toBe(true)
    expect((host.querySelector('[data-composer-send]') as HTMLButtonElement).disabled).toBe(true)
    expect(host.querySelector('[data-composer-readonly-hint]')?.textContent)
      .toBe('宿主对话页正打开该子代理会话，此处只读')
  })

  it('binds the kernel when the host shows a different session (the normal case)', () => {
    const kernel = kernelStub()
    const send = vi.fn(async () => ({ ok: true } as const))
    const host = render(h(ComposerBar, {
      openState: 'open',
      running: true,
      send,
      binding: kernel.binding,
      sessionId: 'child-1',
      hostSessionId: 'host-main',
      t,
    }))
    const surface = host.querySelector('[data-composer-input]')
    expect(kernel.calls.setRoot).toContain(surface as HTMLElement)
    expect(kernel.getRoot()).toBe(surface as HTMLElement)
    expect(surface?.getAttribute('contenteditable')).toBe('true')
    expect(surface?.hasAttribute('data-composer-host-claimed')).toBe(false)
    expect(host.querySelector('[data-composer-readonly-hint]')).toBeNull()
  })

  it('binds the kernel when the host current is unknown (non-browser / list not ready)', () => {
    const kernel = kernelStub()
    const send = vi.fn(async () => ({ ok: true } as const))
    const host = render(h(ComposerBar, {
      openState: 'open',
      running: true,
      send,
      binding: kernel.binding,
      sessionId: 'child-1',
      t,
    }))
    expect(kernel.calls.setRoot).toContain(host.querySelector('[data-composer-input]') as HTMLElement)
  })

  it('releases the editor root on unmount', () => {
    const kernel = kernelStub()
    const send = vi.fn(async () => ({ ok: true } as const))
    const host = render(h(ComposerBar, { openState: 'open', running: true, send, binding: kernel.binding, t }))
    const surface = host.querySelector('[data-composer-input]')
    const root = roots[roots.length - 1]!
    act(() => { root.unmount() })
    roots.splice(roots.indexOf(root), 1)
    expect(kernel.calls.setRoot[kernel.calls.setRoot.length - 1]).toBeNull()
    expect(kernel.getRoot()).toBeNull()
    expect(surface).not.toBeNull()
  })
})

describe('ComposerBar fallback path（批 B1：内核缺失 → textarea 降级）', () => {
  it('falls back to the textarea implementation when the kernel probe fails', async () => {
    const send = vi.fn(async () => ({ ok: true } as const))
    // binding 缺 conversation（旧宿主）→ 内核探测失败 → 走 B4b 的 textarea 通道。
    const host = render(h(ComposerBar, {
      openState: 'open',
      running: true,
      send,
      binding: { session: {}, ctx: {} } as never,
      t,
    }))
    const shell = host.querySelector('[data-step-chat-composer]')
    expect(shell?.getAttribute('data-composer-kernel')).toBe('fallback')
    const area = shell?.querySelector('textarea')
    expect(area).not.toBeNull()
    typeInto(area as HTMLTextAreaElement, '降级也能发')
    await act(async () => {
      (host.querySelector('[data-composer-send]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(send).toHaveBeenCalledWith('降级也能发')
  })
})

// ── 主代理席位模式：**已随决策变更整块删除** ──────────────────────────────────
//
// 本批一度给本组件加过一套「主代理席位」参数（`forceShow` / `owner` / `takeRoot` /
// `trailing` / `queueHint` / `placeholder` / `onSubmitted`）与**编辑器根接管 + 卸载归还**
// 逻辑，用来把运行页输入框做成「主代理会话的输入壳（共享草稿）」。真机验收后用户否决了
// 这个形态（观感与行为都"诡异"），运行页改用 `packages/client/main-agent-input.tsx` 的
// **独立输入框**（不挂内核、不碰编辑器根），故那套参数与逻辑已从本组件删除——
// 对应断言随之移到 `packages/client/main-agent-input.spec.ts` / `main-agent-composer.spec.ts`
// （新语义：结构/Enter 发送/失败错误行/草稿独立/无根接管），本文件不再覆盖它们。

