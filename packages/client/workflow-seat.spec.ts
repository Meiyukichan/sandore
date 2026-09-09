// @vitest-environment jsdom
/**
 * workflow-seat 席位逻辑单测（jsdom，手搭最小 DOM）：
 *
 * 1. 入口落位：仿 SidebarRoot 结构（logoRow + newSession 按钮 + 浏览区）时，
 *    入口恰落在 New Session 与浏览区之间；root 无按钮时不插；重复触发不重复插入。
 * 2. 自愈重挂：入口被摘走（模拟 React 重渲染）后由 Observer 自动归位。
 * 3. 开合 attr：open 翻转驱动中心列 `data-sandore-open`；开自家时广播驱逐事件。
 * 4. 捕获点击自动关：命中侧栏行即关、非匹配行不关、入口子树豁免（0.4.1 竞态）。
 * 5. 驱逐事件：别家 `dsh-panel-activate` 关自家、自家 detail 不自关。
 * 6. bridge：install 覆盖幂等、clear 清理断链、locale 变化转发、workspaces hook。
 * @module @meiyukichan/dsh-sandore/src/client/workflow-seat.spec
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'

// 席位测试只覆盖挂载/开合/关闭逻辑，不渲染视图内部（其组件链引入宿主
// primitives 包，其 lib 内 .module.css 在 vitest 外部化加载下不可用；渲染
// 正确性属浏览器 GUI QA 范畴）。
vi.mock('./WorkflowOverlay.tsx', () => ({ WorkflowOverlay: (): null => null }))

import {
  clearSeatBridge,
  getSeatFace,
  installSeatBridge,
  seatT,
  subscribeSeat,
  useSeatWorkspaces,
  type SeatLocaleLike,
  type WorkspaceSourceLike,
} from './seat-bridge.ts'
import { mountSidebarSeat, SEAT_ENTRY_SELECTOR } from './sidebar-seat.ts'
import { mountWorkflowSeatView, SeatViewBoundary, SEAT_VIEW_SELECTOR } from './view-seat.tsx'
import { getWorkflowState, setWorkflowState } from './workflow-store.ts'
import type { WorkflowOverlayFace } from './workflow-face.ts'
import type { WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'

/** 等一个宏任务（其前全部微任务——含 MutationObserver 回调——已排空）。 */
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

/** 跨测试共享的 disposer 池（afterEach 逆序清理）。 */
const disposers: Array<() => void> = []

// ── stub 工厂 ────────────────────────────────────────────────────────────────

/** locale 服务 stub：bind 稳定引用 + 调用时读当前语言（模拟 LocaleRuntime 语义）。 */
function createLocaleStub(): SeatLocaleLike & { set(locale: 'zh' | 'en'): void; emit(): void } {
  const listeners = new Set<() => void>()
  const dicts = {
    zh: new Map([['button.trigger', '工作流'], ['button.aria', '工作流']]),
    en: new Map([['button.trigger', 'Workflow'], ['button.aria', 'Workflow']]),
  }
  let active: 'zh' | 'en' = 'zh'
  let bound: ((key: string, params?: Record<string, unknown>) => string) | undefined
  return {
    bind: () => {
      bound ??= (key) => dicts[active].get(key) ?? key
      return bound
    },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    set(next) { active = next },
    emit() { for (const fn of [...listeners]) fn() },
  }
}

/** workspaces 源 stub：引用稳定快照 + 手动 emit（模拟 workspaces.list）。 */
function createWorkspaceSource(initial: WorkspaceView[]): WorkspaceSourceLike & {
  set(items: WorkspaceView[]): void
  emit(): void
} {
  const listeners = new Set<() => void>()
  let snapshot = { items: initial }
  return {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    set(items) { snapshot = { items } },
    emit() { for (const fn of [...listeners]) fn() },
  }
}

/** 构造一条 WorkspaceView 测试数据。 */
function makeWorkspace(id: string): WorkspaceView {
  return {
    workspaceId: id,
    path: `C:/demo/${id}`,
    title: id,
    sessionIds: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  } as WorkspaceView
}

// ── DOM 搭建 ─────────────────────────────────────────────────────────────────

/** 仿 DSH SidebarRoot 宽态结构：sidebarCol > root(logoRow + newSession + 浏览区 + foot)。 */
function buildSidebar(): { root: HTMLElement; newSession: HTMLButtonElement; region: HTMLElement } {
  const column = document.createElement('div')
  column.className = 'pI_x6G_sidebarCol'
  const root = document.createElement('div')
  root.className = 'pI_x6G_root'
  const logoRow = document.createElement('div')
  logoRow.className = 'pI_x6G_logoRow'
  const brand = document.createElement('button')
  brand.className = 'pI_x6G_brand'
  logoRow.appendChild(brand)
  const newSession = document.createElement('button')
  newSession.className = 'pI_x6G_newSession'
  newSession.textContent = '新建会话'
  const region = document.createElement('div')
  region.className = 'pI_x6G_regionArea'
  region.textContent = '工作区'
  const foot = document.createElement('div')
  foot.className = 'pI_x6G_footArea'
  root.append(logoRow, newSession, region, foot)
  column.appendChild(root)
  document.body.appendChild(column)
  return { root, newSession, region }
}

/** 仿中心列（第一世代 data-pane 标记）+ 一块会话内容兄弟。 */
function buildConversation(): { column: HTMLElement; content: HTMLElement } {
  const column = document.createElement('div')
  column.setAttribute('data-pane', 'conversation')
  const content = document.createElement('div')
  content.className = 'conversation-content'
  column.appendChild(content)
  document.body.appendChild(column)
  return { column, content }
}

/** 在独立宿主节点上渲染一个 hook 探针组件，读回 hook 返回值。 */
function mountProbe(hook: () => unknown): { value(): unknown; dispose(): void } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  let latest: unknown
  function Probe(): null {
    latest = hook()
    return null
  }
  const root = createRoot(host)
  root.render(createElement(Probe, null))
  return {
    value: () => latest,
    dispose: () => {
      root.unmount()
      host.remove()
    },
  }
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

let localeStub: ReturnType<typeof createLocaleStub>
let face: WorkflowOverlayFace

beforeEach(() => {
  // workflow-store 是模块级单例：每个用例先复位开态。
  setWorkflowState({ open: false })
  localeStub = createLocaleStub()
  face = { marker: 'face' } as unknown as WorkflowOverlayFace
})

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  clearSeatBridge()
  document.body.innerHTML = ''
})

describe('seat-bridge', () => {
  it('installSeatBridge 覆盖安装幂等；clearSeatBridge 清理单例与翻译回退', () => {
    const faceA = { marker: 'a' } as unknown as WorkflowOverlayFace
    const faceB = { marker: 'b' } as unknown as WorkflowOverlayFace
    installSeatBridge(faceA, createLocaleStub(), undefined)
    expect(getSeatFace()).toBe(faceA)
    // 重装覆盖旧引用：不抛错、单例唯一（HMR / 插件重载场景）。
    installSeatBridge(faceB, createLocaleStub(), undefined)
    expect(getSeatFace()).toBe(faceB)
    clearSeatBridge()
    expect(getSeatFace()).toBeUndefined()
    // 清理后 seatT 走恒等回退（键原样返回，绝不抛错）。
    expect(seatT()('button.trigger')).toBe('button.trigger')
  })

  it('locale 变化转发给订阅者；clear 后转发断链（仅 clear 自身通知一次）', () => {
    const locale = createLocaleStub()
    installSeatBridge(face, locale, undefined)
    const events: number[] = []
    const unsubscribe = subscribeSeat(() => { events.push(1) })
    locale.emit()
    const countBefore = events.length
    expect(countBefore).toBeGreaterThan(0)
    clearSeatBridge()
    // clear 自身 bump revision 通知一次；此后 locale 变化不再转发。
    expect(events.length).toBe(countBefore + 1)
    locale.emit()
    expect(events.length).toBe(countBefore + 1)
    unsubscribe()
  })

  it('seatT 读取绑定字典文本，随 locale 快照刷新', () => {
    installSeatBridge(face, localeStub, undefined)
    expect(seatT()('button.trigger')).toBe('工作流')
    localeStub.set('en')
    localeStub.emit()
    expect(seatT()('button.trigger')).toBe('Workflow')
  })

  it('useSeatWorkspaces 返回源 items 并跟随源更新', async () => {
    const source = createWorkspaceSource([makeWorkspace('ws-1')])
    installSeatBridge(face, createLocaleStub(), source)
    const probe = mountProbe(() => useSeatWorkspaces())
    disposers.push(probe.dispose)
    await tick()
    expect((probe.value() as readonly WorkspaceView[]).map((w) => w.workspaceId)).toEqual(['ws-1'])
    source.set([makeWorkspace('ws-2')])
    source.emit()
    await tick()
    expect((probe.value() as readonly WorkspaceView[]).map((w) => w.workspaceId)).toEqual(['ws-2'])
  })

  it('useSeatWorkspaces 空源回落空数组', async () => {
    installSeatBridge(face, createLocaleStub(), undefined)
    const probe = mountProbe(() => useSeatWorkspaces())
    disposers.push(probe.dispose)
    await tick()
    expect(probe.value()).toEqual([])
  })
})

describe('sidebar-seat', () => {
  it('入口落在 New Session 行与浏览区之间；重复触发不重复插入', async () => {
    const { root, newSession, region } = buildSidebar()
    disposers.push(mountSidebarSeat())
    await tick()
    const entries = document.querySelectorAll<HTMLElement>(SEAT_ENTRY_SELECTOR)
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    // 顺序：logoRow < newSession < 入口 < 浏览区（footArea 在最后，不受影响）。
    const order = Array.from(root.children)
    expect(order.indexOf(entry)).toBeGreaterThan(order.indexOf(newSession))
    expect(order.indexOf(entry)).toBeLessThan(order.indexOf(region))
    // 入口未被 append 到 root 末尾（会把入口甩到设置区下面）。
    expect(order.indexOf(entry)).toBeLessThan(order.length - 1)
    // bridge 未装时文案走恒等回退（不抛错），aria 已就位。
    expect(entry.getAttribute('aria-label')).toBe('button.aria')
    // 后续 mutation（React 重渲染的无关节点）不产生第二个入口、不移动既有入口。
    document.body.appendChild(document.createElement('div'))
    await tick()
    expect(document.querySelectorAll(SEAT_ENTRY_SELECTOR)).toHaveLength(1)
    expect(Array.from(root.children).indexOf(document.querySelector<HTMLElement>(SEAT_ENTRY_SELECTOR)!))
      .toBe(order.indexOf(entry))
  })

  it('root 无 New Session 按钮时不插入（降级，绝不抛错）', async () => {
    const column = document.createElement('div')
    column.className = 'pI_x6G_sidebarCol'
    const root = document.createElement('div')
    root.className = 'pI_x6G_root'
    const region = document.createElement('div')
    region.className = 'pI_x6G_regionArea'
    root.appendChild(region)
    column.appendChild(root)
    document.body.appendChild(column)
    disposers.push(mountSidebarSeat())
    await tick()
    expect(document.querySelector(SEAT_ENTRY_SELECTOR)).toBeNull()
  })

  it('自愈重挂：入口被摘走后自动回到 New Session 与浏览区之间', async () => {
    const { root, newSession, region } = buildSidebar()
    disposers.push(mountSidebarSeat())
    await tick()
    const entry = document.querySelector<HTMLElement>(SEAT_ENTRY_SELECTOR)!
    // 模拟 React 重渲染把入口摘走。
    entry.remove()
    await tick()
    expect(root.contains(entry)).toBe(true)
    const order = Array.from(root.children)
    expect(order.indexOf(entry)).toBeGreaterThan(order.indexOf(newSession))
    expect(order.indexOf(entry)).toBeLessThan(order.indexOf(region))
  })

  it('入口文案经 locale 读取，locale 快照刷新后即时更新', async () => {
    installSeatBridge(face, localeStub, undefined)
    buildSidebar()
    disposers.push(mountSidebarSeat())
    await tick()
    const entry = document.querySelector<HTMLElement>(SEAT_ENTRY_SELECTOR)!
    expect(entry.getAttribute('aria-label')).toBe('工作流')
    expect(entry.querySelector('.dsh-sandore-seat-label')!.textContent).toBe('工作流')
    localeStub.set('en')
    localeStub.emit()
    expect(entry.getAttribute('aria-label')).toBe('Workflow')
    expect(entry.querySelector('.dsh-sandore-seat-label')!.textContent).toBe('Workflow')
  })

  it('点击入口切换开合（toggle 语义保留）', async () => {
    installSeatBridge(face, localeStub, undefined)
    buildSidebar()
    disposers.push(mountSidebarSeat())
    await tick()
    const entry = document.querySelector<HTMLButtonElement>(SEAT_ENTRY_SELECTOR)!
    expect(entry.dataset.active).toBeUndefined()
    entry.click()
    expect(getWorkflowState().open).toBe(true)
    expect(entry.dataset.active).toBe('true')
    expect(entry.getAttribute('aria-expanded')).toBe('true')
    entry.click()
    expect(getWorkflowState().open).toBe(false)
    expect(entry.dataset.active).toBeUndefined()
  })
})

describe('view-seat', () => {
  it('视图容器挂为中心列尾子节点；开合翻转列级 data-sandore-open；开自家广播驱逐事件', async () => {
    const { column } = buildConversation()
    disposers.push(mountWorkflowSeatView())
    await tick()
    const container = column.querySelector<HTMLElement>(SEAT_VIEW_SELECTOR)
    expect(container).not.toBeNull()
    expect(column.lastElementChild).toBe(container)
    expect(column.hasAttribute('data-sandore-open')).toBe(false)
    const received: string[] = []
    const spy = (event: Event): void => { received.push((event as CustomEvent<string>).detail) }
    document.addEventListener('dsh-panel-activate', spy)
    try {
      setWorkflowState({ open: true })
      expect(column.hasAttribute('data-sandore-open')).toBe(true)
      expect(received).toEqual(['dsh-sandore'])
      // 幂等去噪：open 保持期间的重复 store 通知不重复广播（仅翻转沿广播）。
      setWorkflowState({ open: true })
      expect(received).toEqual(['dsh-sandore'])
      setWorkflowState({ open: false })
      expect(column.hasAttribute('data-sandore-open')).toBe(false)
    } finally {
      document.removeEventListener('dsh-panel-activate', spy)
    }
  })

  it('捕获点击侧栏会话行自动关闭；非匹配行不关闭', async () => {
    buildConversation()
    disposers.push(mountWorkflowSeatView())
    const row = document.createElement('div')
    row.className = 'x-sessionRow-y'
    document.body.appendChild(row)
    setWorkflowState({ open: true })
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(getWorkflowState().open).toBe(false)
    // 不匹配行选择器的点击（设置区等）不关闭。
    setWorkflowState({ open: true })
    row.className = 'x-settingsArea-y'
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(getWorkflowState().open).toBe(true)
  })

  it('入口子树豁免：入口嵌在 newSession 类容器内时点击不被捕获监听误关（0.4.1 竞态）', async () => {
    installSeatBridge(face, localeStub, undefined)
    buildSidebar()
    buildConversation()
    disposers.push(mountSidebarSeat())
    disposers.push(mountWorkflowSeatView())
    await tick()
    const entry = document.querySelector<HTMLElement>(SEAT_ENTRY_SELECTOR)!
    // 构造 0.4.1 场景：入口被包进 class 含 newSession 的容器（部分 shell 的插入点形态）。
    const wrapper = document.createElement('div')
    wrapper.className = 'x-newSession-wrap'
    entry.parentElement!.insertBefore(wrapper, entry)
    wrapper.appendChild(entry)
    setWorkflowState({ open: true })
    // 同步 dispatch（Observer 回调尚未执行）：若捕获监听未豁免入口子树，会先
    // close（open=false）再被入口 toggle 翻回 true；豁免正确时仅 toggle 生效
    // （open=false）。断言 false 即证明豁免。
    entry.querySelector<HTMLElement>('.dsh-sandore-seat-label')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(getWorkflowState().open).toBe(false)
  })

  it('驱逐事件：别家激活关闭自家；自家 detail 不自关', async () => {
    buildConversation()
    disposers.push(mountWorkflowSeatView())
    setWorkflowState({ open: true })
    document.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: 'dsh-taskboard' }))
    expect(getWorkflowState().open).toBe(false)
    // 自家广播（applyOpen 开自家时派发 detail='dsh-sandore'）不得自驱逐。
    setWorkflowState({ open: true })
    document.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: 'dsh-sandore' }))
    expect(getWorkflowState().open).toBe(true)
  })

  it('SeatViewBoundary：子树渲染崩溃时回调 onCrash 且自身渲染 null（不白屏、可恢复）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const crashes: number[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    function Boom(): null {
      throw new Error('boom')
    }
    root.render(
      createElement(SeatViewBoundary, { onCrash: () => { crashes.push(1) } }, createElement(Boom)),
    )
    await tick()
    expect(crashes).toHaveLength(1)
    // 边界捕获后渲染 null：宿主节点被清空（会话列由 onCrash 回调负责恢复显示）。
    expect(host.childNodes).toHaveLength(0)
    root.unmount()
    host.remove()
    errorSpy.mockRestore()
  })

  it('disposer 清理：容器移除、列开态 attr 移除', async () => {
    const { column } = buildConversation()
    buildSidebar()
    installSeatBridge(face, localeStub, undefined)
    const disposeSeat = mountSidebarSeat()
    const disposeView = mountWorkflowSeatView()
    await tick()
    setWorkflowState({ open: true })
    expect(column.querySelector(SEAT_VIEW_SELECTOR)).not.toBeNull()
    expect(column.hasAttribute('data-sandore-open')).toBe(true)
    // 逆序清理（对齐 index.ts 的 effect 清理顺序）。
    disposeView()
    disposeSeat()
    clearSeatBridge()
    expect(column.querySelector(SEAT_VIEW_SELECTOR)).toBeNull()
    expect(column.hasAttribute('data-sandore-open')).toBe(false)
    expect(document.querySelector(SEAT_ENTRY_SELECTOR)).toBeNull()
  })
})
