/**
 * composer-keydown.ts（批 B1）：step 内嵌 composer 的键盘拦截（DOM capture 阶段）。
 *
 * 为什么不用 lexical 命令层：DSH 的 `registerComposerKeymap` 走
 * `editor.registerCommand(KEY_ENTER_COMMAND, …)`，而 Lexical 的命令表按**命令对象
 * 身份**索引（`KEY_ENTER_COMMAND` 是模块级常量）——sandore 的模块表里没有 lexical，
 * 宿主的第二份 lexical 副本产出的命令对象与我们 import 的对象不是同一个身份，注册
 * 会静默失效（详见批 B1 探索结论）。
 *
 * 取而代之：在编辑器根元素的**父节点**挂 capture 阶段 keydown 监听。
 * - capture 先于编辑器根自身的一切监听（Lexical 的 plain-text 绑定挂在根上），
 *   命中的键我们 `preventDefault()` + `stopImmediatePropagation()` 后自己处理，
 *   因此 Enter 不会被 lexical 的换行抢走；
 * - 未命中的键（Shift+Enter、普通字符、未打开菜单时的方向键、IME 组合期）直接放行，
 *   Lexical/浏览器保持原生行为；
 * - 菜单键（↑/↓/Tab/Enter/Esc）在菜单打开时走 `arbitrate` 仲裁，只有菜单真的消费了
 *   （`consumed` / `pick-highlighted`）才拦截——与 DSH keymap 的 `arrow()` 判定一致。
 *
 * IME 守卫：`event.isComposing` + 遗留 `keyCode 229` + compositionend 后 10ms 的
 * 宽限窗（Safari 会在 compositionend 之后才派发收尾 keydown）——与 DSH keymap 同法。
 * 测试可用 `StepComposerKeydownBinding.now` 注入时钟，避免真实等待。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/composer-keydown
 */

/** 拦截动作需要的最小 composer 面（ComposerBar 侧已解析好的内核）。 */
export interface StepComposerKeydownBinding {
  /**
   * 当前编辑器根元素（`editor.getRootElement()` 的现读）。
   * 根元素会被换绑/解绑，故每次按键都现读，而不是绑定时缓存。
   */
  getRootElement(): HTMLElement | null
  /** 菜单仲裁（ui-input-trigger 的 per-session controller 仲裁；无菜单管线 → 'pass'）。 */
  arbitrate(key: 'up' | 'down' | 'enter' | 'escape' | 'tab', composing: boolean): 'consumed' | 'pick-highlighted' | 'pass'
  /** 空格点的触发词仲裁；true = 本次空格已被输入内核消费。 */
  space(): boolean
  /** Enter 是否允许提交（锁定/机器忙碌时拒绝）。 */
  canSubmit(): boolean
  /** 真正提交（dsl 内核的 `input.submit('queue')`）。 */
  submit(): void
  /** 时钟注入（单测用；缺省 Date.now）。 */
  now?(): number
}

/** 一次按键的处置结论（单测断言面）。 */
export interface StepComposerKeydownOutcome {
  /** true = 本次按键已被本模块处理（调用方应 preventDefault + 停止传播）。 */
  readonly handled: boolean
  /** 处理的语义分支（日志/断言用）。 */
  readonly reason:
    | 'submit'
    | 'submit-refused'
    | 'shift-enter'
    | 'composing'
    | 'menu-key'
    | 'menu-pass'
    | 'space-claim'
    | 'repeat'
    | 'ignored'
    | 'not-root'
}

/** 放行（不拦截）的结论。 */
const PASS = (reason: StepComposerKeydownOutcome['reason']): StepComposerKeydownOutcome =>
  ({ handled: false, reason })

/** IME 组合期判定（含 Safari 的收尾 keydown 宽限窗与遗留 keyCode 229）。 */
export function stepComposerComposing(
  event: { readonly isComposing?: boolean | undefined; readonly keyCode?: number | undefined },
  composing: boolean,
  composingUntil: number,
  now: number,
): boolean {
  return event.isComposing === true || event.keyCode === 229 || composing || now < composingUntil
}

/** 键名归一（`key` 为主；缺 `key` 的合成事件回退 keyCode）。 */
function keyNameOf(event: {
  readonly key?: string | undefined
  readonly keyCode?: number | undefined
}): string {
  if (typeof event.key === 'string' && event.key !== '') return event.key
  switch (event.keyCode) {
    case 13: return 'Enter'
    case 27: return 'Escape'
    case 32: return ' '
    case 38: return 'ArrowUp'
    case 40: return 'ArrowDown'
    case 9: return 'Tab'
    default: return ''
  }
}

/** 菜单键 → arbitrate 键名（放行其余键）。 */
function menuKeyOf(name: string): 'up' | 'down' | 'enter' | 'escape' | 'tab' | undefined {
  switch (name) {
    case 'ArrowUp': return 'up'
    case 'ArrowDown': return 'down'
    case 'Enter': return 'enter'
    case 'Escape': return 'escape'
    case 'Tab': return 'tab'
    default: return undefined
  }
}

/**
 * 键盘事件的纯判定：给定事件 + 当前 IME 状态，返回是否拦截与语义分支。
 *
 * 判定顺序（与 DSH keymap 逐条对齐）：
 * 1. IME 组合期（含宽限窗）→ 全部放行（Enter 是选词上屏，方向键在候选窗里移动）；
 * 2. Shift+Enter → 放行（原生换行，无条件——先于 IME 判定之外的一切拦截）；
 * 3. 菜单键 → `arbitrate`；`pass` 时 Enter 继续走提交分支、方向键/Tab/Esc 放行；
 * 4. Enter → `canSubmit` 通过则 `submit()`（`event.repeat` 为真只拦不发，避免长按连发）；
 * 5. Space → `space()` 返回 true（触发词已被消费）才拦截；
 * 6. 其余键放行。
 * @param event - 归一后的按键事件面（key/keyCode/repeat/shiftKey/isComposing）。
 * @param binding - composer 动作面。
 * @param state - IME 组合状态（composing / composingUntil）。
 * @returns 处置结论。
 */
export function stepComposerKeydownOutcome(
  event: {
    readonly key?: string | undefined
    readonly keyCode?: number | undefined
    readonly repeat?: boolean | undefined
    readonly shiftKey?: boolean | undefined
    readonly isComposing?: boolean | undefined
  },
  binding: StepComposerKeydownBinding,
  state: { readonly composing: boolean; readonly composingUntil: number },
): StepComposerKeydownOutcome {
  const now = binding.now?.() ?? Date.now()
  const composing = stepComposerComposing(event, state.composing, state.composingUntil, now)
  const name = keyNameOf(event)
  if (name === '') return PASS('ignored')
  if (composing) return PASS('composing')
  // 原生换行无条件放行（DSH keymap 同：Shift+Enter 先于 IME 守卫之外的判断）。
  if (name === 'Enter' && event.shiftKey === true) return PASS('shift-enter')

  const menuKey = menuKeyOf(name)
  if (menuKey !== undefined) {
    const verdict = binding.arbitrate(menuKey, false)
    if (verdict !== 'pass') return { handled: true, reason: 'menu-key' }
    if (menuKey !== 'enter') return PASS('menu-pass')
  }

  if (name === 'Enter') {
    // 长按 Enter 不得连发（DSH keymap：event.repeat 为真时只拦不发）。
    if (event.repeat === true) return { handled: true, reason: 'repeat' }
    if (!binding.canSubmit()) return { handled: true, reason: 'submit-refused' }
    binding.submit()
    return { handled: true, reason: 'submit' }
  }

  if (name === ' ') {
    return binding.space() ? { handled: true, reason: 'space-claim' } : PASS('ignored')
  }

  return PASS('ignored')
}

/** 绑定返回的句柄（dispose 拆掉父节点 capture 监听与根节点组合监听）。 */
export interface StepComposerKeydownHandle {
  dispose(): void
  /** 当前 IME 组合态（单测断言用）。 */
  readonly state: { composing: boolean; composingUntil: number }
}

/**
 * 在编辑器根元素的父节点挂 capture keydown 拦截（含 composition 跟踪）。
 *
 * 父节点而非根元素本身：根元素由 `editor.setRootElement(el)` 接管，Lexical 会在其上
 * 挂自己的监听；capture 阶段挂在父节点即可稳定地先于根上的所有监听拿到事件，且根
 * 换绑（重挂 contenteditable）时不需要重新挂载。根元素缺失（未绑定内核）时退化为
 * 挂在 `host` 上——此时所有按键都会因 `getRootElement()` 不匹配而放行。
 * @param host - 承载 contenteditable 的壳元素（壳内唯一的编辑器根）。
 * @param binding - composer 动作面。
 * @returns 可 dispose 的句柄。
 */
export function bindStepComposerKeydown(
  host: HTMLElement,
  binding: StepComposerKeydownBinding,
): StepComposerKeydownHandle {
  const state = { composing: false, composingUntil: 0 }
  const listenerHost: HTMLElement = host.parentElement ?? host

  const onCompositionStart = (): void => { state.composing = true }
  const onCompositionEnd = (): void => {
    state.composing = false
    // Safari 在 compositionend 之后才派发收尾 keydown（DSH 同款 10ms 宽限窗）。
    state.composingUntil = (binding.now?.() ?? Date.now()) + 10
  }
  // 组合监听挂在编辑器根上（根会换绑 → 每次按键前按需重挂）。
  let compositionRoot: HTMLElement | null = null
  const syncCompositionRoot = (): void => {
    const root = binding.getRootElement()
    if (root === compositionRoot) return
    compositionRoot?.removeEventListener('compositionstart', onCompositionStart)
    compositionRoot?.removeEventListener('compositionend', onCompositionEnd)
    compositionRoot = root
    compositionRoot?.addEventListener('compositionstart', onCompositionStart)
    compositionRoot?.addEventListener('compositionend', onCompositionEnd)
  }
  syncCompositionRoot()

  const onKeyDown = (event: KeyboardEvent): void => {
    syncCompositionRoot()
    const root = binding.getRootElement()
    // 只拦「本壳内编辑器根」上的按键（嵌套子组件/其它 composer 的事件不越权）。
    const target = event.target
    if (root === null || !(target instanceof Node) || !root.contains(target)) return
    const outcome = stepComposerKeydownOutcome(event, binding, state)
    if (!outcome.handled) return
    event.preventDefault()
    // 阻止根元素自身与其它冒泡监听（Lexical 的 plain-text/paste 默认、宿主的全局
    // 快捷键）再处理同一个按键——`stopPropagation` 不足以拦住同元素上的其它监听，
    // 故用 `stopImmediatePropagation`。
    event.stopImmediatePropagation()
    event.stopPropagation()
  }

  listenerHost.addEventListener('keydown', onKeyDown, { capture: true })
  return {
    state,
    dispose() {
      listenerHost.removeEventListener('keydown', onKeyDown, { capture: true })
      compositionRoot?.removeEventListener('compositionstart', onCompositionStart)
      compositionRoot?.removeEventListener('compositionend', onCompositionEnd)
      compositionRoot = null
    },
  }
}
