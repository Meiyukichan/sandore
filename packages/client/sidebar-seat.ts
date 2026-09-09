/**
 * 侧栏导航区入口（New Session 行之下、工作区浏览区之上）：原生 DOM 行注入，
 * 避免扰动 DSH React 调和（宿主官方 slot 系统在导航区内没有 list 席位，见
 * docs/design/taskboard-parity-plan.md §2.2）。
 *
 * 结构对照 dsh-taskboard 的 sidebar-entry.ts 移植（已在本机 shell 验证）：三世代
 * 侧栏根选择器（dev 壳 data-pane / 官方 layout 的 sidebarCol / DSH Desktop 包装）、
 * New Session 锚点 + family 行落位（不 append 到 root 末尾）、body 级 MutationObserver
 * 等待 shell、root 级 Observer 自愈 React 重渲染、2s 兜底定时器。属性与类名换成本
 * 插件前缀（`data-sandore-seat-entry` / `dsh-sandore-seat-*`）。
 *
 * 文案不经硬编码：经 seat-bridge 的 `locale.bind(NS)` 读取 'button.trigger' /
 * 'button.aria'（zh/en 键已在 locales.ts），并订阅桥变化随 locale revision 更新
 * （与 slot 注入 `t` 同源同键域）。rail 态无需 JS——全局 CSS 按祖先折叠信号隐藏
 * label（workflow-seat.css）。
 * @module @meiyukichan/dsh-sandore/src/client/sidebar-seat
 */
import { getWorkflowState, subscribeWorkflowState, toggleWorkflowOverlay } from './workflow-store.ts'
import { seatT, subscribeSeat } from './seat-bridge.ts'
import { WORKFLOW_ICON } from './workflow-icon.ts'

/** 标识本插件入口行的稳定 data 属性选择器。 */
export const SEAT_ENTRY_SELECTOR = '[data-sandore-seat-entry]'

/**
 * 三世代侧栏根：dev 壳 data-pane、官方 layout 的 sidebarCol（CSS-Module 哈希类）、
 * DSH Desktop 包装（dshDesktopUpstreamSidebar > dshDesktopSidebarSurface）。
 * logoRow 持有者（其父元素）在三代上同构地是导航行的插入根。
 */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>(
    '[data-pane="sidebar"], [class*="sidebarCol"], .dshDesktopUpstreamSidebar, .dshDesktopSidebarSurface',
  )
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/**
 * New Session 按钮（宽态行，入口插在其后）；三级查找：newSession 类 →
 * root 直接子 BUTTON → aria-label / 文本兜底。直接子扫描排除自身入口
 * （0.4.1 教训：自指锚点会把入口钉死在错误几何上）。
 */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child instanceof HTMLButtonElement && !child.matches(SEAT_ENTRY_SELECTOR)) return child
  }
  const byAria = root.querySelector<HTMLButtonElement>(
    'button[aria-label="新建会话"], button[aria-label="New Session"], button[aria-label*="新会话"], button[aria-label*="new session" i]',
  )
  if (byAria !== null) return byAria
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => !button.matches(SEAT_ENTRY_SELECTOR) && /新会话|新建会话|new session/i.test(button.textContent ?? ''))
}

/**
 * 目标锚点：自己的行（若已在位）> 第一个 family 行（其他 family 插件的入口，
 * 保证同排共存的稳定相对序）> New Session 行的下一兄弟（浏览区）。
 * 永远不 append 到 root 末尾（会把入口甩到设置区下面）；只做自身归位，不动别家节点。
 */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  if (entry.parentElement === root && root.contains(entry)) return true
  const button = newSessionButton(root)
  if (button === undefined) return false
  const row = button.closest('[class*="logoRow"]')
  const base = (row !== null && row.parentElement === root) ? row : button
  const family = Array.from(root.children).filter((el): el is HTMLElement =>
    el instanceof HTMLElement && el.matches(
      '[data-sandore-seat-entry], [data-dsh-atb-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry]',
    ))
  const anchor = family.find((el) => el !== entry) ?? base.nextElementSibling
  if (anchor === null || anchor === entry) return false
  root.insertBefore(entry, anchor)
  return true
}

/** 按当前 locale 同步入口行的 aria-label 与可见文本（桥未装时回退键名，不抛错）。 */
function syncEntryText(entry: HTMLButtonElement): void {
  const t = seatT()
  entry.setAttribute('aria-label', t('button.aria'))
  const label = entry.querySelector<HTMLElement>('.dsh-sandore-seat-label')
  if (label !== null) label.textContent = t('button.trigger')
}

/**
 * 挂载侧栏入口；返回 disposer（移除入口、断开 Observer 与全部订阅）。
 * DOM 查找失败只降级（入口暂不出现），绝不抛错破坏 GUI；shell 就绪后由
 * Observer / 兜底定时器自动补挂。
 */
export function mountSidebarSeat(): () => void {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.dataset.sandoreSeatEntry = ''
  entry.className = 'dsh-sandore-seat-entry'
  entry.innerHTML =
    `<span aria-hidden="true">${WORKFLOW_ICON}</span><span class="dsh-sandore-seat-label"></span>`
  entry.addEventListener('click', () => { toggleWorkflowOverlay() })

  let root: HTMLElement | undefined
  let placed = false

  /** 开态高亮（沿用原 footer 按钮的 accent 语义）+ aria-expanded 同步。 */
  const syncActive = (): void => {
    if (getWorkflowState().open) entry.dataset.active = 'true'
    else delete entry.dataset.active
    entry.setAttribute('aria-expanded', getWorkflowState().open ? 'true' : 'false')
  }
  const unsubscribeStore = subscribeWorkflowState(syncActive)
  /** 桥变化（face/locale 安装、locale revision 递增）→ 重读翻译刷新文本。 */
  const unsubscribeSeatText = subscribeSeat(() => { syncEntryText(entry) })
  syncActive()
  syncEntryText(entry)

  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) { root = undefined; placed = false }
    if (placed) {
      if (document.body.contains(entry)) return
      root = undefined
      placed = false
    }
    placed = false
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry)
    if (placed) rootObserver.observe(root, { childList: true, subtree: true })
  }

  // body 级 watcher：等待 shell 首次渲染 / 整体重建的兜底。
  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })
  // root 级自愈：React 重渲染把入口摘走后，同一帧内重新插回原位。
  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected || !root.contains(entry)) tryPlace()
  })
  // 保险带：无后续 mutation 的迟挂 shell 也有周期重试（已落位时每 2s 一次
  // 廉价的 contains 检查）。
  const retry = setInterval(() => { tryPlace() }, 2_000)
  tryPlace()

  return () => {
    clearInterval(retry)
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribeStore()
    unsubscribeSeatText()
    entry.remove()
  }
}
