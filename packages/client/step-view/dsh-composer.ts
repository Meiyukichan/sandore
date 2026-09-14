/**
 * dsh-composer.ts（批 B1）：DSH 输入内核的**结构探测面** + 纯函数。
 *
 * 结论（批 B1 探索，源码只读复核 deepseek-harness）：
 * - DSH 的 InputBar 组件**不能**嵌入（独立 React 根 / slot 授权 / 组件未导出 /
 *   `+`「指令」按钮硬编码无开关）——因此本模块不复用组件；
 * - 但输入**内核**（`conversation.input.for(actx)` → `SessionInputShell`，含
 *   Lexical 编辑器、提交机、触发词管线）可以无头复用：它的公开面是
 *   `state`（ObservableSnapshot<InputState>）+ `setDraft` / `submit(mode)` /
 *   `notify` / `editor`，以及 InputBar 私有面里的 `arbitrate` / `space` /
 *   `dismissPopup` / `caretSpan` / `steerQueue` / `paste` / `commitSend`。
 *
 * 取法（与 composer-bar.ts 的 conversation 探测同构）：
 * ```ts
 * const ctx = binding.ctx                      // = sessions.scope(childId) 的 Agent-scope ctx
 * const conversation = ctx.conversation         // readScopeService(ctx,'conversation') ← get 优先，勿直读属性
 * const input = conversation.input.for(ctx)     // 该子代理会话住留的 SessionInputShell
 * ```
 * 每次都要**现读**（scope 寻址依赖读取时的 ctx），故这里返回一个包了一层的 kernel
 * 对象：`submit` / `setDraft` 内部再取一次，而不是把 shell 存下来跨渲染复用。
 *
 * 结构探测（全部失败路径 → `undefined`，调用方降级为既有 textarea 实现）：
 * 无 ctx / 无 conversation / 无 `input.for` / `for()` 抛错 / 返回面缺 `state` 或缺
 * `submit` —— 任一不满足即视为「内核不可用」。**不静态 import 类型**（sandore 不声明
 * ui-conversation 运行时依赖；且服务器/测试环境无该模块）。
 *
 * 文本面绑定只需两步（见 ComposerBar.tsx）：`editor.setRootElement(el)` +
 * `editor.setEditable(bool)`。**不 import lexical**：sandore 的模块表里没有它，第二份
 * 副本的命令对象身份不匹配（命令层注册会静默失效），故键盘走 DOM capture（见
 * composer-keydown.ts）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/dsh-composer
 */
import { readScopeService } from './scope-service.ts'

/** 编辑器的最小结构面（LexicalEditor 的子集；只用本模块与 portal/keydown 需要的成员）。 */
export interface StepComposerEditorLike {
  /** 绑定/解绑 contenteditable 宿主元素（null = 解绑）。 */
  setRootElement(element: HTMLElement | null): void
  /** 当前宿主元素（未绑定 → null）。 */
  getRootElement(): HTMLElement | null
  /** 只读态开关（提交中/锁定时置 false）。 */
  setEditable(editable: boolean): void
  /** 当前 decorator 的 React 面（NodeKey → ReactElement）。 */
  getDecorators<T>(): Record<string, T>
  /** 订阅 decorator 变化（返回解绑函数）。 */
  registerDecoratorListener<T>(listener: (decorators: Record<string, T>) => void): () => void
  /** NodeKey → 宿主元素（portal 用）。 */
  getElementByKey(key: string): HTMLElement | null
  /** 聚焦（可带 preventScroll；回调式签名只传首参）。 */
  focus(callbackFn?: () => void, options?: { preventScroll?: boolean }): void
}

/** 输入状态的最小结构面（ui-conversation 的 InputState 子集）。 */
export interface StepComposerInputStateLike {
  /** 剪贴板投影草稿（chip 展开为 `@name` 形式）。 */
  readonly draft: string
  /** 编辑器修订号（span CAS 用；仅观察不做判定的场景可忽略）。 */
  readonly draftRev?: number
  /** 提交机相位。 */
  readonly phase: string
  /** claim 快照（claimed/submitting 期存在）。 */
  readonly claim?: { readonly token: string } | undefined
  /** 队列投影（只读）。 */
  readonly queue?: readonly unknown[] | undefined
}

/** 可观察面（ObservableSnapshot 子集）。 */
export interface StepComposerObservableLike<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** 内核的提交模式（ui-conversation 的 InputSubmitMode：'queue' | 'steer'）。 */
export type StepComposerSubmitMode = 'queue' | 'steer'

/** 菜单仲裁结论（ui-input-trigger 的 ArbitrateOutcome）。 */
export type StepComposerArbitrateOutcome = 'consumed' | 'pick-highlighted' | 'pass'

/** 菜单仲裁键（ui-input-trigger 的 ArbitrateKey）。 */
export type StepComposerArbitrateKey = 'up' | 'down' | 'enter' | 'escape' | 'tab'

/**
 * 探测成功后的内核面（ComposerBar 只依赖这里的方法；每一项都在探测时验过）。
 *
 * 语义注意：`submit` / `setDraft` 内部**每次现读** scope ctx 上的 conversation，
 * 而不是缓存 shell——cordis 的 scope 寻址依赖读取时机（同 composer-bar.ts）。
 */
export interface StepComposerKernel {
  /** 输入状态可观察面（草稿/相位/claim/队列）。 */
  readonly state: StepComposerObservableLike<StepComposerInputStateLike>
  /** 界面通知面（命令结果/失败提示；只读订阅）。 */
  readonly notices?: StepComposerObservableLike<{ readonly level: string; readonly text: string; readonly seq: number } | null> | undefined
  /** 住留的编辑器（文本 + chip 真相；绑定 contenteditable 用）。 */
  readonly editor: StepComposerEditorLike
  /** 输入壳（提交/草稿/仲裁等动作的宿主；结构面）。 */
  readonly shell: StepComposerShellLike
  /** 现读当前输入状态。 */
  draft(): string
  /** 现读提交机相位。 */
  phase(): string
  /** 现读队列/待办条数（`state.queue`；0 = 无排队语义）。 */
  queueLength(): number
  /** 替换整份草稿（程序化写入）。 */
  setDraft(text: string): void
  /** 提交（默认 'queue'；见 composer-bar.ts 的排队语义说明）。 */
  submit(mode?: StepComposerSubmitMode): void
  /** 菜单仲裁（无菜单管线 → 'pass'）。 */
  arbitrate(key: StepComposerArbitrateKey, composing: boolean): StepComposerArbitrateOutcome
  /** 空格点触发词仲裁（true = 已被消费，调用方 preventDefault）。 */
  space(): boolean
  /** 关掉 popupSelect 壳（外层浮层的关闭时机）。 */
  dismissPopup(): void
  /** 把仍挂着的队列消息 steer 进运行中的轮（空草稿加速 Enter 手势）。 */
  steerQueue(): void
  /** 现读失焦坐标 span（菜单启动器用；不可用 → null）。 */
  caretSpan(): { readonly start: number; readonly end: number } | null
}

/** 输入壳的动作面（SessionInputShell 的结构子集；探测时逐项验形）。 */
export interface StepComposerShellLike {
  readonly state: StepComposerObservableLike<StepComposerInputStateLike>
  readonly editor: StepComposerEditorLike
  readonly notices?: StepComposerObservableLike<unknown> | undefined
  setDraft(text: string): void
  submit(mode?: StepComposerSubmitMode): void
  arbitrate?(key: StepComposerArbitrateKey, composing: boolean): StepComposerArbitrateOutcome
  space?(): boolean
  dismissPopup?(): void
  steerQueue?(): void
  caretSpan?(): { readonly start: number; readonly end: number }
}

/** binding 的结构探测面（= SessionBinding；`ctx` 即 `sessions.scope(childId)`）。 */
export interface StepComposerBindingLike {
  readonly ctx?: {
    readonly conversation?: unknown
    readonly get?: (name: string) => unknown
  } | undefined
}

/** conversation 服务的最小面（`input.for(actx)`）。 */
interface StepComposerConversationLike {
  readonly input?: { for?: (actx: unknown) => unknown } | undefined
}

/** 判断是否是可观察面（getSnapshot + subscribe 皆为函数）。 */
function observableOf<T>(value: unknown): StepComposerObservableLike<T> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { readonly getSnapshot?: unknown; readonly subscribe?: unknown }
  if (typeof record.getSnapshot !== 'function' || typeof record.subscribe !== 'function') return undefined
  return value as StepComposerObservableLike<T>
}

/** 判断是否是编辑器面（setRootElement 必在；其余按存在性收窄）。 */
function editorOf(value: unknown): StepComposerEditorLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as {
    readonly setRootElement?: unknown
    readonly getRootElement?: unknown
    readonly setEditable?: unknown
    readonly getDecorators?: unknown
    readonly registerDecoratorListener?: unknown
    readonly getElementByKey?: unknown
    readonly focus?: unknown
  }
  if (typeof record.setRootElement !== 'function') return undefined
  return {
    setRootElement: record.setRootElement.bind(value) as StepComposerEditorLike['setRootElement'],
    getRootElement: typeof record.getRootElement === 'function'
      ? record.getRootElement.bind(value) as StepComposerEditorLike['getRootElement']
      : () => null,
    setEditable: typeof record.setEditable === 'function'
      ? record.setEditable.bind(value) as StepComposerEditorLike['setEditable']
      : () => undefined,
    getDecorators: typeof record.getDecorators === 'function'
      ? record.getDecorators.bind(value) as StepComposerEditorLike['getDecorators']
      : () => ({}),
    registerDecoratorListener: typeof record.registerDecoratorListener === 'function'
      ? record.registerDecoratorListener.bind(value) as StepComposerEditorLike['registerDecoratorListener']
      : () => () => undefined,
    getElementByKey: typeof record.getElementByKey === 'function'
      ? record.getElementByKey.bind(value) as StepComposerEditorLike['getElementByKey']
      : () => null,
    focus: typeof record.focus === 'function'
      ? record.focus.bind(value) as StepComposerEditorLike['focus']
      : () => undefined,
  }
}

/**
 * 现读 scope ctx 上的 conversation（`readScopeService`：`ctx.get` 优先、属性读回退；
 * 见文件头与 scope-service.ts）。**渲染期调用**（`resolveStepComposerKernel` 在 useMemo 里
 * 走 `shellOf`），故任何读取异常都必须归一为 undefined——直读属性会被 cordis 抛
 * `cannot get property "conversation" without inject`（真实 e2e 崩溃根因）。
 */
function conversationOf(binding: StepComposerBindingLike): StepComposerConversationLike | undefined {
  const conversation = readScopeService((binding as unknown as { ctx?: unknown }).ctx, 'conversation')
  if (typeof conversation !== 'object' || conversation === null) return undefined
  return conversation as StepComposerConversationLike
}

/** 解析该会话住留的输入壳（每次现读；探测失败 → undefined）。 */
function shellOf(binding: StepComposerBindingLike): StepComposerShellLike | undefined {
  const ctx = (binding as unknown as { ctx?: unknown }).ctx
  const conversation = conversationOf(binding)
  const input = conversation?.input
  const forSession = input?.for
  if (typeof forSession !== 'function' || input === undefined) return undefined
  if (typeof ctx !== 'object' || ctx === null) return undefined
  let shell: unknown
  try {
    // for(actx) 对非会话 scope 会 throw（conversation.input.for requires a session scope）。
    shell = forSession.call(input, ctx)
  } catch (error) {
    console.error('ui-sandore: step composer kernel unavailable (input.for failed)', error)
    return undefined
  }
  if (typeof shell !== 'object' || shell === null) return undefined
  const record = shell as {
    readonly state?: unknown
    readonly submit?: unknown
    readonly setDraft?: unknown
    readonly editor?: unknown
    readonly notices?: unknown
    readonly arbitrate?: unknown
    readonly space?: unknown
    readonly dismissPopup?: unknown
    readonly steerQueue?: unknown
    readonly caretSpan?: unknown
  }
  // 硬门槛：可观察状态面 + submit + editor（三项缺一即视为内核不可用）。
  if (observableOf<StepComposerInputStateLike>(record.state) === undefined) return undefined
  if (typeof record.submit !== 'function') return undefined
  const editor = editorOf(record.editor)
  if (editor === undefined) return undefined
  // 方法一律 bind 到壳实例：外部壳类（SessionInputShell）的方法依赖 this。
  const borrow = <T>(value: unknown): T | undefined =>
    typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(shell) as T : undefined
  const notices = observableOf<unknown>(record.notices)
  // 可选项只在存在时展开（exactOptionalPropertyTypes：不能显式写 undefined）。
  const arbitrate = borrow<NonNullable<StepComposerShellLike['arbitrate']>>(record.arbitrate)
  const space = borrow<NonNullable<StepComposerShellLike['space']>>(record.space)
  const dismissPopup = borrow<NonNullable<StepComposerShellLike['dismissPopup']>>(record.dismissPopup)
  const steerQueue = borrow<NonNullable<StepComposerShellLike['steerQueue']>>(record.steerQueue)
  const caretSpan = borrow<NonNullable<StepComposerShellLike['caretSpan']>>(record.caretSpan)
  return {
    state: observableOf<StepComposerInputStateLike>(record.state)!,
    editor,
    ...(notices === undefined ? {} : { notices: notices as StepComposerShellLike['notices'] }),
    setDraft: borrow<StepComposerShellLike['setDraft']>(record.setDraft) ?? (() => undefined),
    submit: borrow<StepComposerShellLike['submit']>(record.submit)!,
    ...(arbitrate === undefined ? {} : { arbitrate }),
    ...(space === undefined ? {} : { space }),
    ...(dismissPopup === undefined ? {} : { dismissPopup }),
    ...(steerQueue === undefined ? {} : { steerQueue }),
    ...(caretSpan === undefined ? {} : { caretSpan }),
  }
}

/**
 * 解析 step 内嵌 composer 的 DSH 输入内核。
 *
 * 结构性探测（任一不满足 → `undefined`；调用方降级为既有 textarea 实现，见
 * ComposerBar.tsx 的双路说明）：
 * 1. binding 存在且 `binding.ctx` 是对象；
 * 2. `binding.ctx` 上的 conversation 服务（经 `readScopeService` 读取；直读属性会被
 *    cordis 以「未 inject」抛错）是对象；
 * 3. `conversation.input.for` 是函数，且 `for(ctx)` 不抛且返回对象；
 * 4. 返回面具备 `state`（可观察）+ `submit`（函数）+ `editor.setRootElement`。
 * @param binding - 面板持有的会话绑定（`stepChatComposerSendOf` 的同一入参）。
 * @returns 内核面，或 undefined（降级）。
 */
export function resolveStepComposerKernel(
  binding: StepComposerBindingLike | undefined,
): StepComposerKernel | undefined {
  if (binding === undefined) return undefined
  const shell = shellOf(binding)
  if (shell === undefined) return undefined
  /**
   * 动作类调用现读壳（与 composer-bar.ts 的「不缓存服务实例」同因：cordis 的 scope
   * 寻址依赖读取时的 ctx；宿主 HMR/卸载后 conversation 消失 → 当次调用静默 no-op）。
   * 订阅面（state/editor/notices）必须保持身份稳定（React 订阅依赖），故只用首次解析
   * 到的实例——壳在会话存活期内身份稳定，重解析会换新壳的场景等价于会话重开。
   */
  const withShell = (run: (live: StepComposerShellLike) => void): void => {
    const live = shellOf(binding)
    if (live === undefined) return
    run(live)
  }
  return {
    state: shell.state,
    ...(shell.notices === undefined
      ? {}
      : { notices: shell.notices as StepComposerKernel['notices'] }),
    editor: shell.editor,
    shell,
    draft: () => shell.state.getSnapshot().draft,
    phase: () => shell.state.getSnapshot().phase,
    queueLength: () => shell.state.getSnapshot().queue?.length ?? 0,
    setDraft: text => { withShell(live => { live.setDraft(text) }) },
    submit: (mode = 'queue') => { withShell(live => { live.submit(mode) }) },
    arbitrate: (key, composing) => shell.arbitrate?.(key, composing) ?? 'pass',
    space: () => shell.space?.() ?? false,
    dismissPopup: () => { shell.dismissPopup?.() },
    steerQueue: () => { shell.steerQueue?.() },
    caretSpan: () => shell.caretSpan?.() ?? null,
  }
}

// ── 纯函数（可单测；不触碰内核） ────────────────────────────────────────────

/** 提交机相位 → 「可否按下发送」判定输入的忙碌态。 */
export function stepComposerPhaseBusy(phase: string | undefined): boolean {
  return phase === 'adjudicating' || phase === 'submitting'
}

/**
 * 草稿文本（结构读；非字符串/缺失 → 空串）。
 * @param state - 内核发布的状态（或 undefined）。
 * @returns 去敏后的草稿文本。
 */
export function stepComposerDraftOf(state: StepComposerInputStateLike | undefined): string {
  const draft = state?.draft
  return typeof draft === 'string' ? draft : ''
}

/**
 * 可提交判定（非空草稿 + 非忙碌相位）。
 * @param state - 内核发布的状态（或 undefined）。
 * @returns 是否可提交。
 */
export function stepComposerCanSubmit(state: StepComposerInputStateLike | undefined): boolean {
  if (state === undefined) return false
  if (stepComposerPhaseBusy(state.phase)) return false
  return stepComposerDraftOf(state).trim() !== ''
}

/**
 * 宿主原生对话页是否正占着该子代理会话的输入壳（批 B2 的根抢占前置守卫）。
 *
 * 一个会话只有一个输入壳（一个 Lexical editor），根元素同一时刻只能绑一个 DOM 节点。
 * 判定面用宿主会话列表的 `current`（`sessions.list.getSnapshot().current`）：
 * `current === 子会话 id` 就是「宿主原生会话页此刻正显示这个子代理」——它自己的
 * InputBar 会绑同一个根。B1 只在**绑定后发现根已被占用**时降级；但两者挂载顺序不
 * 确定（宿主 InputBar 可能晚于本卡一个 tick 才绑根），本卡会先把根抢走，随后宿主
 * 页的输入框变成不可编辑/内容错位——故这里补一道**绑定前**的守卫：命中即不绑内核
 * （ComposerBar 转为只读 + 发送禁用，草稿/队列仍可见），把根完整留给宿主页。
 *
 * 边界：`current` 缺失（非浏览器宿主/列表未就绪）或为空串 → 无抢占（照常绑定）；
 * 两个 id 皆非空且相等才判占用（不做大小写/前缀等模糊匹配——会话 id 是精确身份）。
 * @param hostSessionId - 宿主会话列表的 `current`（正在显示的会话 id）。
 * @param childSessionId - 本面板的子代理会话 id。
 * @returns 宿主页正占用该输入壳 → true（调用方不绑内核）。
 */
export function stepComposerHostClaimsRoot(
  hostSessionId: string | undefined,
  childSessionId: string | undefined,
): boolean {
  if (hostSessionId === undefined || hostSessionId === '') return false
  if (childSessionId === undefined || childSessionId === '') return false
  return hostSessionId === childSessionId
}

/**
 * 提交模式选择：step 内嵌面板恒为 `'queue'`（排队语义；见 composer-bar.ts 的宿主准入
 * 码表说明——宿主对运行中子代理的 prompt 是投递进 FIFO inbox，`steer` 在该路由上无
 * 区分，且面板只在运行中显示，排队是唯一正确语义）。
 * @returns 恒 'queue'。
 */
export function stepComposerSubmitMode(): StepComposerSubmitMode {
  return 'queue'
}
