/**
 * composer-trigger-menu.ts（批 B3）：step 面板 composer 的**触发词菜单接入面**。
 *
 * 背景（批 B1 遗留缺口，本批补齐）：DSH 的 `@`/`/` 候选菜单由 ui-input-trigger 自己
 * 注册进 **slot** `conversation.input.overlay`（`ui-input-trigger/src/client/index.ts`
 * 的 `slots.register`），只有宿主的 `InputBar` 骨架会渲染那个 slot。sandore 的 step 面板
 * 用的是**自绘壳 + DSH 输入内核**（见 ComposerBar.tsx 文件头），面板里没有那个 anchor，
 * 于是菜单状态（`InputTriggerController.menu`）即使正常开合，DOM 也永不出现——`@step`
 * 因此只能盲打。本模块把菜单**状态面**从控制器取出来，交给自绘组件
 * （ComposerTriggerMenu.tsx）渲染成与 DSH 逐值同款的浮层。
 *
 * 与 DSH 的关系（只读参考 deepseek-harness；**不 import** ui-input-trigger / ui-conversation）：
 * - 取控制器：`ctx.sessions.scope(childSessionId)` 拿会话作用域 ctx →
 *   `ctx.inputTriggers.sessionOf(actx)` → `InputTriggerController`（DSH 侧同一对取法，
 *   见 `ui-input-trigger/src/client/index.ts` 的 slot inject 与
 *   `ui-conversation/src/client/input/hub.ts` 的 `controller(actx)`）。
 * - 本模块只用控制器的公开面（`controller.ts` 的 `menu` / `headers` / `pick` /
 *   `hover` / `pickCrumb` / `dismiss`）；键盘（↑↓/Enter/Esc/Tab）与空格仲裁**不在这里**
 *   ——DSH 输入壳已经把 `arbitrate` / `space` 转发给控制器（facade.ts 的 405/423 行），
 *   sandore 的键盘拦截本就经 `kernel.arbitrate/space`（composer-keydown.ts），故键路
 *   早已直通，本批只补「渲染」。
 *
 * 作用域：控制器按会话取，面板只为自己那个子代理会话渲染菜单（不会串到别的会话）。
 * 缺失即降级（返回 undefined）：无 sessions / scope 晚出现 / 宿主未装 ui-input-trigger /
 * sessionOf 抛错 / 控制器形状不符 —— 一律静默 undefined，面板照常可输入可发送。
 *
 * 纯逻辑（行模型 `stepComposerMenuRowsOf`）与单例解析分离：前者可在 node 环境直接单测。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/composer-trigger-menu
 */

// ── 结构面（cast 形状；不静态 import DSH 的 ui-input-trigger） ────────────────

/** 一条候选（ui-input-trigger 的 InputTriggerCandidate 子集；只用渲染需要的字段）。 */
export interface StepComposerMenuItemLike {
  readonly name: string
  readonly description?: string | undefined
  readonly icon?: 'file' | 'folder' | 'session' | undefined
  readonly value?: string | undefined
  /** 分组内小节标题（`@step` 的「步骤」即此字段；同组内变化才渲染一行）。 */
  readonly section?: string | undefined
  /** 可下钻行（目录）；Tab / 行尾箭头走 drill 动作。 */
  readonly drill?: boolean | undefined
}

/** 一个候选分组（= 一个已注册 source）。 */
export interface StepComposerMenuGroupLike {
  readonly source: string
  readonly showGroupTitle?: boolean | undefined
  readonly status: 'pending' | 'ready'
  readonly items: readonly StepComposerMenuItemLike[]
}

/** 菜单快照（ui-input-trigger 的 MenuState 子集）。 */
export interface StepComposerMenuStateLike {
  readonly open: boolean
  readonly groups: readonly StepComposerMenuGroupLike[]
  readonly highlight: { readonly source: string; readonly index: number } | null
}

/** 面包屑（source 的 header 发布物；@file 下钻导航用）。 */
export interface StepComposerMenuCrumbLike {
  readonly label: string
  readonly value: string
  readonly current?: boolean | undefined
}

/** 可观察快照面（DSH 的 SnapshotStore 子集）。 */
export interface StepComposerStoreLike<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** 每会话控制器的**只读**使用面（见文件头：本模块不碰键盘仲裁）。 */
export interface StepComposerTriggerControllerLike {
  /** 菜单状态（React 侧 useSyncExternalStore 订阅）。 */
  readonly menu: StepComposerStoreLike<StepComposerMenuStateLike>
  /** 面包屑面（source 无 header 时不出现）。 */
  readonly headers?: StepComposerStoreLike<ReadonlyMap<string, readonly StepComposerMenuCrumbLike[]>> | undefined
  /** 指针选中（settling pick；action 缺省 = 'pick'）。 */
  pick(source: string, index: number, action?: string): void
  /** 指针悬停（与键盘共用一个 highlight）。 */
  hover(source: string, index: number): void
  /** 面包屑下钻（可缺省）。 */
  pickCrumb?(source: string, index: number): void
  /** 外部点击关闭。 */
  dismiss(): void
}

/** 安装依赖（`packages/client/index.ts` 装配；服务一律**惰性现读**）。 */
export interface StepComposerTriggerDeps {
  /** DSH 会话服务（`sessions.scope(sessionId)` → 会话作用域 ctx）。 */
  readonly sessions: { scope(id: string): unknown } | undefined
  /**
   * `ctx.inputTriggers` 的**惰性**读取（每次解析现读，不缓存服务实例）：
   * 本插件可能早于 ui-input-trigger 装载；apply 期一次性取值会永久拿到 undefined，
   * 那样菜单永远不出现（`@step` source 注册处是同族的已知坑）。
   */
  readonly inputTriggers: () => { sessionOf(actx: unknown): unknown } | undefined
  /**
   * 分组标题翻译（其它插件 source 名的文案在 DSH 的 `slash.menu` 命名空间里；
   * 装配处注入该命名空间的翻译函数）。缺省 / 未注册键 → 原名（= DSH 的未知键行为）。
   */
  readonly menuTitle?: ((source: string) => string) | undefined
}

// ── 纯逻辑：行模型（与 MenuView.tsx 的渲染规则逐条对齐） ──────────────────────

/** 菜单候选区行（组件按 kind 渲染；顺序即 DOM 顺序）。面包屑是另一条 nav 通道（见
 * {@link stepComposerMenuCrumbNavsOf}），与 DSH 一样排在 listbox **之外**。 */
export type StepComposerMenuRow =
  /** 分组标题（source 名，经外部翻译；仅在组内无 section 时出现）。 */
  | { readonly kind: 'group-title'; readonly source: string; readonly label: string }
  /** 加载骨架（pending 且尚无候选）。 */
  | { readonly kind: 'skeleton'; readonly source: string }
  /** 候选行。 */
  | {
    readonly kind: 'option'
    readonly source: string
    readonly index: number
    readonly id: string
    readonly item: StepComposerMenuItemLike
    readonly active: boolean
    /** 本行上方要渲染的小节标题（`undefined` = 不渲染）；见 {@link stepComposerMenuRowsOf}。 */
    readonly sectionTitle: string | undefined
  }

/**
 * 候选行的 DOM id（aria-activedescendant 目标）。
 *
 * 与 DSH `MenuView.tsx` 的 `optionId()` **逐字一致**（`dsh-slash-option-<source>-<index>`）：
 * 菜单视觉与可访问性同款，且宿主 InputBar 的菜单只在**别的**会话页里存在（step 面板在
 * 运行视图内，不与之同页），不会撞 id。
 * @param source - source（分组）名。
 * @param index - 组内序号。
 * @returns DOM id。
 */
export function stepComposerMenuOptionId(source: string, index: number): string {
  return `dsh-slash-option-${source}-${index}`
}

/**
 * 菜单快照 → 候选区行模型（纯函数）。
 *
 * 规则逐条抄 DSH `MenuView.tsx`（**不改语义**）：
 * 1. `status === 'ready'` 且 0 条候选的分组**整组不渲染**（空组不占位）；
 * 2. 分组标题：`showGroupTitle === false` 或该组**任一行带 section** 时不渲染
 *    （section 行接管标注，避免「步骤」标题重复两次）；
 * 3. 小节标题：候选带 `section` 且与上一行 section 不同才渲染；
 * 4. `pending` 且无候选 → 骨架行两枚；
 * 5. highlight 命中（source + index）→ `active`。
 * @param state - 菜单快照。
 * @param titleOf - 分组标题翻译（缺省用 source 原名；DSH 的未知键也回原名）。
 * @returns 行列表（渲染顺序）。
 */
export function stepComposerMenuRowsOf(
  state: StepComposerMenuStateLike,
  titleOf: (source: string) => string = source => source,
): readonly StepComposerMenuRow[] {
  const rows: StepComposerMenuRow[] = []
  for (const group of state.groups) {
    if (group.status === 'ready' && group.items.length === 0) continue
    const titled = group.showGroupTitle !== false && !group.items.some(item => item.section !== undefined)
    if (titled) rows.push({ kind: 'group-title', source: group.source, label: titleOf(group.source) })
    if (group.status === 'pending' && group.items.length === 0) {
      rows.push({ kind: 'skeleton', source: group.source })
      continue
    }
    group.items.forEach((item, index) => {
      const previous = group.items[index - 1]
      const sectionTitle = item.section !== undefined && item.section !== previous?.section
        ? item.section
        : undefined
      rows.push({
        kind: 'option',
        source: group.source,
        index,
        id: stepComposerMenuOptionId(group.source, index),
        item,
        active: state.highlight !== null
          && state.highlight.source === group.source
          && state.highlight.index === index,
        sectionTitle,
      })
    })
  }
  return rows
}

/** 一条面包屑导航（一个 source 一条 nav；节点顺序即下钻路径）。 */
export interface StepComposerMenuCrumbNav {
  readonly source: string
  readonly crumbs: readonly StepComposerMenuCrumbLike[]
}

/**
 * 菜单快照 → 面包屑导航（纯函数；与 DSH 的 `crumbs.get(group.source)` 通道一致）。
 * @param state - 菜单快照。
 * @param headers - 面包屑面（缺省 = 无）。
 * @returns 有 header 的 source 及其节点（按分组顺序）。
 */
export function stepComposerMenuCrumbNavsOf(
  state: StepComposerMenuStateLike,
  headers?: ReadonlyMap<string, readonly StepComposerMenuCrumbLike[]> | undefined,
): readonly StepComposerMenuCrumbNav[] {
  if (headers === undefined || headers.size === 0) return []
  const navs: StepComposerMenuCrumbNav[] = []
  for (const group of state.groups) {
    const trail = headers.get(group.source)
    if (trail === undefined || trail.length === 0) continue
    navs.push({ source: group.source, crumbs: trail })
  }
  return navs
}

/** 菜单是否有任何**可见内容**（无行也无面包屑 → 组件整块不渲染）。 */
export function stepComposerMenuVisible(
  state: StepComposerMenuStateLike,
  headers?: ReadonlyMap<string, readonly StepComposerMenuCrumbLike[]> | undefined,
): boolean {
  if (!state.open) return false
  if (stepComposerMenuCrumbNavsOf(state, headers).length > 0) return true
  return stepComposerMenuRowsOf(state).length > 0
}

// ── 单例：控制器解析（install / resolve / clear；不缓存控制器实例） ───────────

/** 已安装的依赖（apply 期注入，卸载清除；缺省 = 未安装 → 恒降级）。 */
let installed: { readonly deps: StepComposerTriggerDeps; readonly token: object } | undefined

/** 结构探测：把任意值收窄为可观察快照面（getSnapshot + subscribe 皆为函数）。 */
function storeOf<T>(value: unknown): StepComposerStoreLike<T> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { readonly getSnapshot?: unknown; readonly subscribe?: unknown }
  if (typeof record.getSnapshot !== 'function' || typeof record.subscribe !== 'function') return undefined
  const store = value as StepComposerStoreLike<T>
  return {
    getSnapshot: () => store.getSnapshot(),
    subscribe: listener => store.subscribe(listener),
  }
}

/** 结构探测：控制器面（menu 可观察 + pick/hover/dismiss 三动作齐全才认）。 */
function controllerOf(value: unknown): StepComposerTriggerControllerLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as {
    readonly menu?: unknown
    readonly headers?: unknown
    readonly pick?: unknown
    readonly hover?: unknown
    readonly pickCrumb?: unknown
    readonly dismiss?: unknown
  }
  const menu = storeOf<StepComposerMenuStateLike>(record.menu)
  if (menu === undefined) return undefined
  if (typeof record.pick !== 'function' || typeof record.hover !== 'function' || typeof record.dismiss !== 'function') {
    return undefined
  }
  const headers = storeOf<ReadonlyMap<string, readonly StepComposerMenuCrumbLike[]>>(record.headers)
  return {
    menu,
    ...(headers === undefined ? {} : { headers }),
    pick: (source, index, action) => {
      (record.pick as (s: string, i: number, a?: string) => void).call(value, source, index, action)
    },
    hover: (source, index) => {
      (record.hover as (s: string, i: number) => void).call(value, source, index)
    },
    ...(typeof record.pickCrumb === 'function'
      ? {
        pickCrumb: (source: string, index: number) => {
          (record.pickCrumb as (s: string, i: number) => void).call(value, source, index)
        },
      }
      : {}),
    dismiss: () => { (record.dismiss as () => void).call(value) },
  }
}

/**
 * 安装触发词菜单的解析依赖（`packages/client/index.ts` 装配；`ctx.effect` 绑定 fiber）。
 * @param deps - sessions + 惰性 inputTriggers 读取。
 * @returns disposer（清除本次安装；被后续安装覆盖时不误删）。
 */
export function installStepComposerTriggers(deps: StepComposerTriggerDeps): () => void {
  const token = {}
  installed = { deps, token }
  return () => {
    if (installed?.token !== token) return
    installed = undefined
  }
}

/** 清除安装（单测隔离用；生产路径由各插件卸载时的 disposer 配对清理）。 */
export function clearStepComposerTriggers(): void {
  installed = undefined
}

/**
 * 分组标题翻译（组件的 `titleOf` 端口）：读已安装依赖里的 `menuTitle`，缺省回原名。
 * @param source - source（分组）名。
 * @returns 本地化标题。
 */
export function stepComposerMenuTitleOf(source: string): string {
  const title = installed?.deps.menuTitle?.(source)
  return title === undefined || title === '' ? source : title
}

/**
 * 解析某个子代理会话的触发词控制器（**每次现读**，不缓存）。
 *
 * 失败阶梯（全部静默 undefined；绝不抛——渲染期调用，抛错会炸整个面板）：
 * 未安装 → 空会话 id → sessions 缺 `scope` → `scope()` 抛错/返回 undefined（作用域尚未
 * 物化）→ inputTriggers 现读为 undefined（宿主未装该插件）→ `sessionOf()` 抛错
 * （非会话 scope）→ 控制器形状不符。
 * @param sessionId - 子代理会话 id（面板的 `sessionId`）。
 * @returns 控制器只读面，或 undefined（降级：不渲染菜单，输入/发送不受影响）。
 */
export function stepComposerTriggerOf(sessionId: string | undefined): StepComposerTriggerControllerLike | undefined {
  if (installed === undefined) return undefined
  if (sessionId === undefined || sessionId === '') return undefined
  const sessions = installed.deps.sessions
  if (sessions === undefined || typeof sessions.scope !== 'function') return undefined
  let actx: unknown
  try {
    actx = sessions.scope(sessionId)
  } catch (error) {
    console.error('ui-sandore: step composer trigger scope lookup failed', error)
    return undefined
  }
  if (actx === undefined || actx === null) return undefined
  let registry: { sessionOf(actx: unknown): unknown } | undefined
  try {
    registry = installed.deps.inputTriggers()
  } catch (error) {
    console.error('ui-sandore: step composer trigger service lookup failed', error)
    return undefined
  }
  if (registry === undefined || typeof registry.sessionOf !== 'function') return undefined
  let controller: unknown
  try {
    controller = registry.sessionOf(actx)
  } catch (error) {
    // 常见：作用域尚未物化成会话（sessionOf 要求会话 scope）——降级，不打扰用户。
    console.error('ui-sandore: step composer trigger controller unavailable', error)
    return undefined
  }
  return controllerOf(controller)
}
