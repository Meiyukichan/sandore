/**
 * composer-keydown.spec（jsdom）：step 内嵌 composer 的键盘拦截回归。
 *
 * 锁的是「DOM capture 阶段拦哪些键、放哪些键、拦的时候对事件做了什么」：
 * - Enter 提交（`preventDefault` + `stopImmediatePropagation` 都被调用）；
 * - Shift+Enter 放行（原生换行；不 preventDefault）；
 * - IME：`isComposing` / 遗留 keyCode 229 / compositionend 后 10ms 宽限窗内全部放行；
 * - 菜单键（↑/↓/Tab/Esc）：菜单消费才拦（`consumed`），`pass` 时不拦；
 *   菜单打开时的 Enter：`pick-highlighted`/`consumed` 都拦，`pass` 才落到提交；
 * - 长按 Enter（`repeat`）只拦不发；
 * - 根元素之外的按键（其它输入框/按钮）绝不拦；
 * - 键盘拦截走**父节点 capture**：断言根元素上的冒泡监听看不到被拦的键。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/composer-keydown.spec
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  bindStepComposerKeydown,
  stepComposerComposing,
  stepComposerKeydownOutcome,
  type StepComposerKeydownBinding,
  type StepComposerKeydownHandle,
} from './composer-keydown.ts'

/** 动作面桩（记录调用；仲裁结论/可提交性等可按用例注入）。 */
function bindingStub(overrides: Partial<StepComposerKeydownBinding> = {}) {
  const calls: string[] = []
  const fallback: StepComposerKeydownBinding = {
    getRootElement: () => root,
    arbitrate: (key) => { calls.push(`arbitrate:${key}`); return 'pass' },
    space: () => { calls.push('space'); return false },
    canSubmit: () => { calls.push('canSubmit'); return true },
    submit: () => { calls.push('submit') },
  }
  // 注入的覆写也要记账（否则「调用形状」断言看不到它被调用过）。
  const binding: StepComposerKeydownBinding = {
    ...fallback,
    getRootElement: overrides.getRootElement ?? fallback.getRootElement,
    arbitrate: (key, composing) => {
      calls.push(`arbitrate:${key}`)
      return (overrides.arbitrate ?? (() => 'pass' as const))(key, composing)
    },
    space: () => {
      calls.push('space')
      return (overrides.space ?? (() => false))()
    },
    canSubmit: () => {
      calls.push('canSubmit')
      return (overrides.canSubmit ?? (() => true))()
    },
    submit: () => {
      calls.push('submit')
      ;(overrides.submit ?? (() => undefined))()
    },
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  }
  let root: HTMLElement | null = null
  return {
    binding,
    calls,
    setRoot: (el: HTMLElement | null) => { root = el },
    getRoot: () => root,
  }
}

/** 按键事件桩（可注入 isComposing/keyCode/repeat/shiftKey）。 */
function keyEvent(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
}

describe('stepComposerComposing（IME 判定）', () => {
  it('trusts isComposing, the legacy keyCode 229, and the post-composition grace window', () => {
    expect(stepComposerComposing({ isComposing: true }, false, 0, 100)).toBe(true)
    expect(stepComposerComposing({ keyCode: 229 }, false, 0, 100)).toBe(true)
    expect(stepComposerComposing({}, true, 0, 100)).toBe(true) // compositionstart 之后
    expect(stepComposerComposing({}, false, 150, 100)).toBe(true) // Safari 收尾 keydown
    expect(stepComposerComposing({}, false, 150, 200)).toBe(false) // 宽限窗已过
    expect(stepComposerComposing({}, false, 0, 100)).toBe(false)
  })
})

describe('stepComposerKeydownOutcome（纯判定）', () => {
  const state = { composing: false, composingUntil: 0 }

  it('submits on plain Enter and never on Shift+Enter', () => {
    const stub = bindingStub()
    expect(stepComposerKeydownOutcome({ key: 'Enter' }, stub.binding, state))
      .toEqual({ handled: true, reason: 'submit' })
    expect(stub.calls).toEqual(['arbitrate:enter', 'canSubmit', 'submit'])
    expect(stepComposerKeydownOutcome({ key: 'Enter', shiftKey: true }, stub.binding, state))
      .toEqual({ handled: false, reason: 'shift-enter' })
    // Shift+Enter 不仲裁、不提交（原生换行）。
    expect(stub.calls).toHaveLength(3)
  })

  it('passes every key during IME composition (Enter is a candidate pick)', () => {
    const stub = bindingStub()
    expect(stepComposerKeydownOutcome({ key: 'Enter', isComposing: true }, stub.binding, state))
      .toEqual({ handled: false, reason: 'composing' })
    expect(stepComposerKeydownOutcome({ key: 'ArrowDown', keyCode: 229 }, stub.binding, state))
      .toEqual({ handled: false, reason: 'composing' })
    expect(stepComposerKeydownOutcome({ key: ' ' }, stub.binding, { composing: true, composingUntil: 0 }))
      .toEqual({ handled: false, reason: 'composing' })
    expect(stub.calls).toEqual([])
  })

  it('honours the post-composition grace window from the injected clock', () => {
    const stub = bindingStub({ now: () => 105 })
    expect(stepComposerKeydownOutcome({ key: 'Enter' }, stub.binding, { composing: false, composingUntil: 110 }))
      .toEqual({ handled: false, reason: 'composing' })
    expect(stub.calls).toEqual([])
  })

  it('lets the trigger menu consume arrow/escape/tab keys and passes when it has no claim', () => {
    const consumed = bindingStub({ arbitrate: () => 'consumed' })
    for (const key of ['ArrowUp', 'ArrowDown', 'Escape', 'Tab']) {
      expect(stepComposerKeydownOutcome({ key }, consumed.binding, state))
        .toEqual({ handled: true, reason: 'menu-key' })
    }
    const passing = bindingStub()
    expect(stepComposerKeydownOutcome({ key: 'ArrowDown' }, passing.binding, state))
      .toEqual({ handled: false, reason: 'menu-pass' })
    expect(passing.calls).toEqual(['arbitrate:down']) // 无菜单 → 方向键放行给浏览器
  })

  it('falls through a non-consuming Enter arbitration into the submit gesture', () => {
    const stub = bindingStub()
    expect(stepComposerKeydownOutcome({ key: 'Enter' }, stub.binding, state).reason).toBe('submit')
    expect(stub.calls).toEqual(['arbitrate:enter', 'canSubmit', 'submit'])
    // 菜单消费了 Enter（高亮项被选中）→ 不提交。
    const picked = bindingStub({ arbitrate: () => 'pick-highlighted' })
    expect(stepComposerKeydownOutcome({ key: 'Enter' }, picked.binding, state))
      .toEqual({ handled: true, reason: 'menu-key' })
    expect(picked.calls).toEqual(['arbitrate:enter'])
  })

  it('consumes but refuses to send while the machine cannot submit or Enter is held', () => {
    const refused = bindingStub({ canSubmit: () => false })
    expect(stepComposerKeydownOutcome({ key: 'Enter' }, refused.binding, state))
      .toEqual({ handled: true, reason: 'submit-refused' })
    expect(refused.calls).toEqual(['arbitrate:enter', 'canSubmit'])
    const repeated = bindingStub()
    expect(stepComposerKeydownOutcome({ key: 'Enter', repeat: true }, repeated.binding, state))
      .toEqual({ handled: true, reason: 'repeat' })
    expect(repeated.calls).toEqual(['arbitrate:enter']) // 不提交、不 canSubmit
  })

  it('consumes Space only when the trigger pipeline claimed the token', () => {
    const claimed = bindingStub({ space: () => true })
    expect(stepComposerKeydownOutcome({ key: ' ' }, claimed.binding, state))
      .toEqual({ handled: true, reason: 'space-claim' })
    const plain = bindingStub()
    expect(stepComposerKeydownOutcome({ key: ' ' }, plain.binding, state))
      .toEqual({ handled: false, reason: 'ignored' })
    expect(plain.calls).toEqual(['space'])
  })

  it('ignores every other key (typing stays native)', () => {
    const stub = bindingStub()
    for (const key of ['a', 'Backspace', 'Home', 'F5', '']) {
      expect(stepComposerKeydownOutcome({ key }, stub.binding, state).handled).toBe(false)
    }
    expect(stub.calls).toEqual([])
  })
})

describe('bindStepComposerKeydown（DOM capture 绑定）', () => {
  const handles: StepComposerKeydownHandle[] = []
  afterEach(() => {
    for (const handle of handles.splice(0)) handle.dispose()
  })

  /** 搭一个「壳 > 编辑器根」的 DOM，返回各观察点。 */
  function mount() {
    document.body.innerHTML = ''
    const host = document.createElement('div')
    const root = document.createElement('div')
    host.appendChild(root)
    document.body.appendChild(host)
    const rootSeen: string[] = []
    root.addEventListener('keydown', (event) => { rootSeen.push(event.key) })
    const stub = bindingStub()
    stub.setRoot(root)
    const handle = bindStepComposerKeydown(host, stub.binding)
    handles.push(handle)
    return { host, root, stub, rootSeen, handle }
  }

  it('intercepts Enter on the editor root at the capture phase and stops propagation', () => {
    const { root, stub, rootSeen } = mount()
    // 根元素自己的 capture 监听也看不到被拦的键（父节点 capture 先于子节点 capture）。
    const rootCapture: string[] = []
    root.addEventListener('keydown', (event) => { rootCapture.push(event.key) }, { capture: true })
    const event = keyEvent('Enter')
    root.dispatchEvent(event)
    expect(stub.calls).toEqual(['arbitrate:enter', 'canSubmit', 'submit'])
    expect(event.defaultPrevented).toBe(true) // 默认行为被拦（不会插入换行）
    expect(rootCapture).toEqual([]) // 传播被 stopImmediatePropagation 切断
    expect(rootSeen).toEqual([]) // 根上的冒泡监听同样看不到
  })

  it('leaves Shift+Enter and IME Enter untouched', () => {
    const { root, stub, rootSeen } = mount()
    const shift = keyEvent('Enter', { shiftKey: true })
    const ime = keyEvent('Enter', { isComposing: true })
    root.dispatchEvent(shift)
    root.dispatchEvent(ime)
    // 放行＝本模块完全不介入：不仲裁、不提交、不 preventDefault、不切传播。
    expect(stub.calls).toEqual([])
    expect(shift.defaultPrevented).toBe(false)
    expect(ime.defaultPrevented).toBe(false)
    expect(rootSeen).toEqual(['Enter', 'Enter']) // 两个键都照常到达根
  })

  it('never intercepts keys typed outside the editor root', () => {
    const { host, stub } = mount()
    const outside = document.createElement('input')
    host.appendChild(outside)
    outside.dispatchEvent(keyEvent('Enter'))
    expect(stub.calls).toEqual([])
  })

  it('holds the IME guard through compositionend and releases it after the window', () => {
    const { root, stub, handle } = mount()
    root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    root.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    const closing = keyEvent('Enter')
    root.dispatchEvent(closing)
    // compositionend 之后 10ms 内的收尾 keydown 仍按组合期放行（Safari 行为）：
    // 不仲裁、不提交、不 preventDefault。
    expect(handle.state.composing).toBe(false)
    expect(stub.calls).toEqual([])
    expect(closing.defaultPrevented).toBe(false)
    // 让宽限窗过期后再敲：恢复提交。
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 50)
    const later = keyEvent('Enter')
    root.dispatchEvent(later)
    vi.restoreAllMocks()
    expect(stub.calls).toEqual(['arbitrate:enter', 'canSubmit', 'submit'])
    expect(later.defaultPrevented).toBe(true)
  })

  it('disposes cleanly (no interception after dispose)', () => {
    const { root, stub, handle } = mount()
    handle.dispose()
    root.dispatchEvent(keyEvent('Enter'))
    expect(stub.calls).toEqual([])
  })
})
