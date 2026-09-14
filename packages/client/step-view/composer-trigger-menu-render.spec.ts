/**
 * composer-trigger-menu-render.spec（@vitest-environment jsdom）：触发词菜单的
 * **渲染 + 指针 + 键盘仲裁**回归。
 *
 * 覆盖两条用例目标（验收口径）：
 * 1. **菜单渲染**：控制器 store 打开 → `[data-trigger-menu]` 出现（DSH 同款锚点），
 *    `role="listbox"` + `role="option"` 候选行、section 分组标题「步骤」、分组标题
 *    （其它 source）、下钻行箭头、活动行 `aria-selected` + listbox 的
 *    `aria-activedescendant`；关闭 → DOM 消失。
 * 2. **指针**：行 `mousedown` → `pick(source,index)`（并 preventDefault，保住编辑器焦点）；
 *    行 `mousemove` → `hover`；面包屑 `mousedown` → `pickCrumb`；菜单外 pointerdown →
 *    `dismiss`，而菜单内 / composer 卡内点击**不**关闭。
 *
 * 再加一条**接线**用例（ComposerBar 内核路径）：控制器经模块级单例注入后面板真的把菜单
 * 渲染在自己的输入卡上方（锚点 `[data-composer-menu-anchor]`），并且 ↑↓/Enter/Esc 经
 * `kernel.arbitrate` 落到同一个控制器上（生产链：DOM capture →
 * composer-keydown.ts → `SessionInputShell.arbitrate` → `controller.arbitrate`；本用例用
 * 桩内核直连，语义等价），空格经 `kernel.space` 询问后**不**拦截（本 source 无
 * matchSpace）。
 *
 * 控制器桩按 DSH `InputTriggerController` 的**公开语义**实现（menu 快照 + move/close/pick），
 * 只用于驱动本模块：被测的是「DOM 是否忠实反映菜单状态 + 指针/键路是否接到控制器」。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/composer-trigger-menu-render.spec
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
import {
  clearStepComposerTriggers,
  installStepComposerTriggers,
  type StepComposerMenuCrumbLike,
  type StepComposerMenuStateLike,
  type StepComposerTriggerControllerLike,
} from './composer-trigger-menu.ts'
import { ComposerTriggerMenu } from './ComposerTriggerMenu.tsx'
import type { StepComposerInputStateLike } from './dsh-composer.ts'

/** sandore zh 字典桩翻译（与 composer-bar-render.spec 同款）。 */
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
  clearStepComposerTriggers()
  vi.restoreAllMocks()
})

function render(element: ReactNode): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => { root.render(element) })
  return host
}

/** 可观察 store 桩（与 DSH SnapshotStore 的 getSnapshot/subscribe 同形）。 */
function storeOf<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next: T) => { value = next; for (const listener of [...listeners]) listener() },
  }
}

/** 控制器桩（见文件头：按 DSH InputTriggerController 的公开语义）。 */
function controllerStub(initial: StepComposerMenuStateLike, headers?: ReadonlyMap<string, readonly StepComposerMenuCrumbLike[]>) {
  const state = storeOf(initial)
  const crumbStore = storeOf(headers ?? new Map<string, readonly StepComposerMenuCrumbLike[]>())
  const calls = {
    pick: [] as Array<[string, number, string | undefined]>,
    hover: [] as Array<[string, number]>,
    crumb: [] as Array<[string, number]>,
    dismiss: 0,
    arbitrate: [] as string[],
    space: 0,
  }
  const pick = (source: string, index: number, action?: string): void => {
    calls.pick.push([source, index, action])
    // DSH 语义：pick 后菜单关闭（drill 除外——本桩不用 drill 路径）。
    if (action !== 'drill') state.set({ ...state.getSnapshot(), open: false })
    else state.set({ ...state.getSnapshot() })
  }
  const controller: StepComposerTriggerControllerLike & {
    arbitrate(key: string): 'consumed' | 'pick-highlighted' | 'pass'
    space(): boolean
  } = {
    menu: state,
    headers: crumbStore,
    pick,
    hover: (source, index) => {
      calls.hover.push([source, index])
      state.set({ ...state.getSnapshot(), highlight: { source, index } })
    },
    pickCrumb: (source, index) => { calls.crumb.push([source, index]) },
    dismiss: () => { calls.dismiss += 1; state.set({ ...state.getSnapshot(), open: false }) },
    // ↓ DSH 控制器的键盘仲裁（`controller.arbitrate`）语义：move / close / pick。
    arbitrate: (key) => {
      calls.arbitrate.push(key)
      const snapshot = state.getSnapshot()
      if (!snapshot.open) return 'pass'
      if (key === 'up' || key === 'down') {
        const flat: Array<{ source: string; index: number }> = []
        for (const group of snapshot.groups) {
          if (group.status !== 'ready') continue
          group.items.forEach((_item, index) => flat.push({ source: group.source, index }))
        }
        if (flat.length === 0) return 'pass'
        const at = snapshot.highlight === null
          ? -1
          : flat.findIndex(slot => slot.source === snapshot.highlight?.source && slot.index === snapshot.highlight?.index)
        const step = key === 'down' ? 1 : -1
        const next = flat[(at + step + flat.length) % flat.length]
        if (next === undefined) return 'pass'
        state.set({ ...snapshot, highlight: next })
        return 'consumed'
      }
      if (key === 'escape') {
        state.set({ ...snapshot, open: false })
        return 'consumed'
      }
      if (key === 'enter' || key === 'tab') {
        const highlight = snapshot.highlight
        if (highlight === null) return 'pass'
        pick(highlight.source, highlight.index)
        return 'pick-highlighted'
      }
      return 'pass'
    },
    /** 本 source 没有 matchSpace（DSH 空格仲裁只服务「前置 token 认领」）。 */
    space: () => { calls.space += 1; return false },
  }
  return { controller, calls, state, crumbStore }
}

/** 一份带 @step 组（section「步骤」）与一个无 section 的 reference 组的打开态快照。 */
function openMenuState(highlight: StepComposerMenuStateLike['highlight'] = null): StepComposerMenuStateLike {
  return {
    open: true,
    groups: [
      { source: 'reference', status: 'ready', items: [{ name: 'a.md', description: '文件', icon: 'file', value: 'a.md' }] },
      {
        source: 'step',
        showGroupTitle: true,
        status: 'ready',
        items: [
          { name: '构建', description: '已完成 · 2 个产物', icon: 'session', value: '{"instanceId":"i1","stepId":"s1"}', section: '步骤' },
          { name: '测试', description: '运行中 · 无产物', icon: 'session', value: '{"instanceId":"i1","stepId":"s2"}', section: '步骤' },
        ],
      },
    ],
    highlight,
  }
}

/** 在宿主里派发一次 pointerdown（jsdom 无 PointerEvent，用通用 Event 即可命中监听）。 */
function pointerDown(target: Element): void {
  act(() => { target.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
}

/** 一次键击（capture 阶段的 DOM 拦截）。 */
function key(target: Element, keyName: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true })
  act(() => { target.dispatchEvent(event) })
  return event
}

describe('ComposerTriggerMenu 渲染（jsdom）', () => {
  it('renders the DSH-shaped menu: listbox, section title, option rows and the active row', () => {
    const { controller } = controllerStub(openMenuState({ source: 'step', index: 1 }))
    const host = render(h(ComposerTriggerMenu, { controller, t }))

    const menu = host.querySelector('[data-trigger-menu]')
    expect(menu).not.toBeNull()
    // sandore 自己的定位锚点（e2e 用），与 DSH 同款锚点并存。
    expect(host.querySelector('[data-step-composer-menu]')).toBe(menu)

    const listbox = menu?.querySelector('[role="listbox"]')
    expect(listbox?.getAttribute('aria-label')).toBe('触发候选建议')
    // 活动行 = 控制器 highlight（键盘/指针共用一个来源）。
    expect(listbox?.getAttribute('aria-activedescendant')).toBe('dsh-slash-option-step-1')

    const options = [...(menu?.querySelectorAll('[role="option"]') ?? [])]
    expect(options.map(option => option.getAttribute('data-trigger-option'))).toEqual(['a.md', '构建', '测试'])
    expect(options.map(option => option.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true'])

    // 分组标题（reference 无 section → 显示 source 名经翻译/回原名）。
    const titles = [...(menu?.querySelectorAll('[role="presentation"]') ?? [])].map(node => node.textContent)
    expect(titles).toEqual(['reference', '步骤'])
    // 行文本 = 名称 + 描述（描述来自 @step 候选的「状态 · 产物」摘要）。
    expect(options[1]?.textContent).toBe('构建已完成 · 2 个产物')
    // step 组带 section → 不渲染重复的分组标题（DSH 同规则）。
    expect(titles.filter(title => title === 'step')).toHaveLength(0)
  })

  it('translates group titles through the injected titleOf and renders nothing while closed', () => {
    const titled = controllerStub(openMenuState())
    const host = render(h(ComposerTriggerMenu, {
      controller: titled.controller,
      t,
      titleOf: (source: string) => (source === 'reference' ? '文件' : source),
    }))
    const titles = [...(host.querySelectorAll('[role="presentation"]') ?? [])].map(node => node.textContent)
    expect(titles).toEqual(['文件', '步骤'])

    const closed = controllerStub({ open: false, groups: [], highlight: null })
    const closedHost = render(h(ComposerTriggerMenu, { controller: closed.controller, t }))
    expect(closedHost.querySelector('[data-trigger-menu]')).toBeNull()
    act(() => { closed.state.set(openMenuState()) })
    expect(closedHost.querySelector('[data-trigger-menu]')).not.toBeNull()
    act(() => { closed.state.set({ open: false, groups: [], highlight: null }) })
    expect(closedHost.querySelector('[data-trigger-menu]')).toBeNull()
  })

  it('routes pointer picks (mousedown, preventDefault) and hover (mousemove) back to the controller', () => {
    const { controller, calls, state } = controllerStub(openMenuState())
    const host = render(h(ComposerTriggerMenu, { controller, t }))
    const rows = [...host.querySelectorAll('[role="option"]')]

    // hover：未激活行上的真实指针移动 → hover(source,index) → 高亮跟着走。
    act(() => { rows[1]?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })) })
    expect(calls.hover).toEqual([['step', 0]])
    expect(state.getSnapshot().highlight).toEqual({ source: 'step', index: 0 })

    // pick：mousedown 选中（阻止默认以保住编辑器焦点）+ 菜单关闭。
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    act(() => { rows[0]?.dispatchEvent(down) })
    expect(down.defaultPrevented).toBe(true)
    expect(calls.pick).toEqual([['reference', 0, undefined]])
    expect(host.querySelector('[data-trigger-menu]')).toBeNull()
  })

  it('renders crumb navigation and routes a non-current crumb through pickCrumb', () => {
    const { controller, calls } = controllerStub(
      openMenuState(),
      new Map([['reference', [
        { label: 'src', value: 'src' },
        { label: 'lib', value: 'src/lib', current: true },
      ]]]),
    )
    const host = render(h(ComposerTriggerMenu, { controller, t }))
    const nav = host.querySelector('[data-trigger-menu] nav')
    expect(nav?.getAttribute('aria-label')).toBe('目录导航')
    const crumbs = [...(nav?.querySelectorAll('button') ?? [])]
    expect(crumbs.map(crumb => crumb.textContent)).toEqual(['src', 'lib'])
    // 当前层是标签（disabled），不可点。
    expect((crumbs[1] as HTMLButtonElement).disabled).toBe(true)
    act(() => { crumbs[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
    expect(calls.crumb).toEqual([['reference', 0]])
  })

  it('renders the drill affordance and keeps the row pick separate from the drill pick', () => {
    const drillState: StepComposerMenuStateLike = {
      open: true,
      groups: [{
        source: 'reference',
        showGroupTitle: false,
        status: 'ready',
        items: [{ name: 'src', description: '目录', icon: 'folder', value: 'src', drill: true }],
      }],
      highlight: null,
    }
    const { controller, calls } = controllerStub(drillState)
    const host = render(h(ComposerTriggerMenu, { controller, t }))
    const arrow = host.querySelector('[aria-label="进入目录"]')
    expect(arrow).not.toBeNull()
    act(() => { arrow?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
    // drill 只走 drill 动作，不冒泡成一次正常 pick。
    expect(calls.pick).toEqual([['reference', 0, 'drill']])
  })

  it('dismisses on an outside pointerdown but not on a click inside the menu or the composer card', () => {
    const { controller, calls } = controllerStub(openMenuState())
    const card = document.createElement('div')
    card.setAttribute('data-step-chat-composer', '')
    const host = document.createElement('div')
    card.appendChild(host)
    document.body.appendChild(card)
    const root = createRoot(host)
    roots.push(root)
    act(() => { root.render(h(ComposerTriggerMenu, { controller, t })) })

    // 卡内（菜单外）点击：不关（点输入框/发送钮不应关菜单）。
    const inside = document.createElement('button')
    card.appendChild(inside)
    pointerDown(inside)
    expect(calls.dismiss).toBe(0)

    // 菜单内点击：不关。
    const row = host.querySelector('[role="option"]')
    if (row !== null) pointerDown(row)
    expect(calls.dismiss).toBe(0)

    // 菜单与卡之外：关。
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    pointerDown(outside)
    expect(calls.dismiss).toBe(1)
  })
})

// ── 接线：ComposerBar 内核路径 + 控制器单例 + 键路 ───────────────────────────

/** 内核桩（SessionInputShell 的结构子集；与 composer-bar-render.spec 同款）。 */
function kernelStub(controller: { arbitrate(key: string): 'consumed' | 'pick-highlighted' | 'pass'; space(): boolean }) {
  const listeners = new Set<() => void>()
  let state: StepComposerInputStateLike & { queue?: readonly unknown[] } = { draft: '', phase: 'plain' }
  const calls = { submit: [] as Array<string | undefined>, arbitrate: [] as string[], space: 0 }
  let root: HTMLElement | null = null
  const editor = {
    setRootElement: (el: HTMLElement | null) => { root = el },
    getRootElement: () => root,
    setEditable: () => undefined,
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
    // 生产链：SessionInputShell.arbitrate/space 转发到本会话的 InputTriggerController。
    arbitrate: (key: string) => { calls.arbitrate.push(key); return controller.arbitrate(key) },
    space: () => { calls.space += 1; return controller.space() },
    dismissPopup: () => undefined,
    steerQueue: () => undefined,
    caretSpan: () => ({ start: 0, end: 0 }),
  }
  const publish = (): void => { for (const listener of [...listeners]) listener() }
  return {
    calls,
    binding: { session: {}, ctx: { conversation: { input: { for: () => shell } } } } as never,
    setState: (next: StepComposerInputStateLike & { queue?: readonly unknown[] }) => { state = next; publish() },
  }
}

describe('ComposerBar 接线（批 B3：菜单渲染在面板输入卡上方 + 键路直通控制器）', () => {
  it('renders the injected controller menu inside the panel composer and drives it from the keyboard', () => {
    const { controller, calls, state } = controllerStub(openMenuState({ source: 'step', index: 0 }))
    // 安装单例：sessions.scope → inputTriggers.sessionOf → 本桩控制器。
    installStepComposerTriggers({
      sessions: { scope: (id: string) => (id === 'child-9' ? { id } : undefined) },
      inputTriggers: () => ({ sessionOf: () => controller }),
    })
    const kernel = kernelStub(controller)
    const send: StepChatComposerSend = vi.fn(async () => ({ ok: true }))
    const host = render(h(ComposerBar, {
      openState: 'open',
      running: true,
      send,
      binding: kernel.binding,
      sessionId: 'child-9',
      t,
    }))
    // 菜单锚点在输入卡容器内（浮层是它的 absolute 子元素）。
    const anchor = host.querySelector('[data-composer-menu-anchor]')
    expect(anchor).not.toBeNull()
    // 锚点在本面板 composer 根内，且包含输入卡（浮层与卡同宽、坐在卡上缘之上）。
    expect(host.querySelector('[data-step-chat-composer]')?.querySelector('[data-composer-menu-anchor]')).toBe(anchor)
    expect(anchor?.querySelector('[data-composer-input]')).not.toBeNull()
    const menu = anchor?.querySelector('[data-trigger-menu]')
    expect(menu).not.toBeNull()
    // 菜单在 DOM 上排在输入卡**之前**（浮层靠 bottom:100% 坐在卡上方）。
    const card = anchor?.querySelector('[data-composer-input]')
    expect(menu !== null && card !== null && (menu?.compareDocumentPosition(card as Node) ?? 0) & 4).toBeTruthy()

    const surface = host.querySelector('[data-composer-input]') as HTMLElement
    // 初始 highlight = step#0；↓ → step#1（consumed，DOM 跟上）。
    const listbox = () => host.querySelector('[role="listbox"]')
    expect(listbox()?.getAttribute('aria-activedescendant')).toBe('dsh-slash-option-step-0')
    const downEvent = key(surface, 'ArrowDown')
    expect(downEvent.defaultPrevented).toBe(true)
    expect(kernel.calls.arbitrate).toEqual(['down'])
    expect(state.getSnapshot().highlight).toEqual({ source: 'step', index: 1 })
    expect(listbox()?.getAttribute('aria-activedescendant')).toBe('dsh-slash-option-step-1')

    // ↑ 回到 step#0。
    key(surface, 'ArrowUp')
    expect(state.getSnapshot().highlight).toEqual({ source: 'step', index: 0 })

    // 空格：控制器未认领（本 source 无 matchSpace）→ 不拦截、不提交。
    const spaceEvent = key(surface, ' ')
    expect(spaceEvent.defaultPrevented).toBe(false)
    expect(kernel.calls.space).toBe(1)
    expect(kernel.calls.submit).toEqual([])

    // Esc：控制器消费 → 菜单关（DOM 消失），且不提交。
    const escapeEvent = key(surface, 'Escape')
    expect(escapeEvent.defaultPrevented).toBe(true)
    expect(state.getSnapshot().open).toBe(false)
    expect(host.querySelector('[data-trigger-menu]')).toBeNull()
    expect(kernel.calls.submit).toEqual([])

    // 重新打开菜单（模拟用户又打出 `@`），Enter：控制器 pick 当前高亮行 → 菜单关。
    act(() => { state.set(openMenuState({ source: 'step', index: 1 })) })
    expect(host.querySelector('[data-trigger-menu]')).not.toBeNull()
    const enterEvent = key(surface, 'Enter')
    expect(enterEvent.defaultPrevented).toBe(true)
    expect(calls.pick).toEqual([['step', 1, undefined]])
    expect(host.querySelector('[data-trigger-menu]')).toBeNull()
    // 菜单消费了这次 Enter → **不得**落成一次发送。
    expect(kernel.calls.submit).toEqual([])
  })

  it('degrades silently when no controller can be resolved (no menu, composer still works)', () => {
    // 未安装单例 → stepComposerTriggerOf 恒 undefined。
    const kernel = kernelStub({ arbitrate: () => 'pass', space: () => false })
    const send: StepChatComposerSend = vi.fn(async () => ({ ok: true }))
    const host = render(h(ComposerBar, {
      openState: 'open',
      running: true,
      send,
      binding: kernel.binding,
      sessionId: 'child-missing',
      t,
    }))
    expect(host.querySelector('[data-composer-menu-anchor]')).not.toBeNull()
    expect(host.querySelector('[data-trigger-menu]')).toBeNull()
    // 输入/发送不受影响：草稿可见 + Enter 仍提交。
    act(() => { kernel.setState({ draft: '继续', phase: 'plain' }) })
    key(host.querySelector('[data-composer-input]') as HTMLElement, 'Enter')
    expect(kernel.calls.submit).toEqual(['queue'])
  })
})
