/**
 * dsh-composer.spec：DSH 输入内核**结构探测矩阵** + 草稿/可提交纯函数。
 *
 * 探测面是本批最脆的一环（不静态 import ui-conversation，全靠结构读），故把每条失败
 * 路径都锁死：无 binding / 无 ctx / 无 conversation / 无 input / 无 input.for /
 * `for()` 抛错 / 返回非对象 / 缺 state / 缺 submit / 缺 editor.setRootElement —— 任一
 * 不满足都必须返回 `undefined`（调用方据此降级为 textarea，见 ComposerBar.tsx）。
 * 成功路径锁：方法 bind 到壳实例（`this` 不丢）、动作类调用现读壳（scope 寻址依赖
 * 读取时机）、队列条数读取、仲裁/空格/关浮层的可选面缺省行为。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/dsh-composer.spec
 */
import { describe, expect, it, vi } from 'vitest'

import {
  resolveStepComposerKernel,
  stepComposerCanSubmit,
  stepComposerDraftOf,
  stepComposerHostClaimsRoot,
  stepComposerPhaseBusy,
  stepComposerSubmitMode,
  type StepComposerInputStateLike,
} from './dsh-composer.ts'

/** 可观察状态桩（getSnapshot + subscribe）。 */
function stateStore(initial: StepComposerInputStateLike) {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next: StepComposerInputStateLike) => {
      current = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** 编辑器桩（记录 setRootElement/setEditable 调用）。 */
function editorStub() {
  const calls: string[] = []
  let root: HTMLElement | null = null
  return {
    calls,
    getRoot: () => root,
    editor: {
      setRootElement: (el: HTMLElement | null) => { calls.push(`root:${el === null ? 'null' : 'el'}`); root = el },
      getRootElement: () => root,
      setEditable: (editable: boolean) => { calls.push(`editable:${String(editable)}`) },
      getDecorators: () => ({}),
      registerDecoratorListener: () => () => undefined,
      getElementByKey: () => null,
      focus: () => undefined,
    },
  }
}

/** 输入壳桩（SessionInputShell 的结构子集；方法依赖 this，用于验证 bind）。 */
function shellStub(overrides: Record<string, unknown> = {}) {
  const state = stateStore({ draft: '', phase: 'plain' })
  const editor = editorStub()
  const calls: Array<{ method: string; args: unknown[] }> = []
  const shell = {
    state,
    editor: editor.editor,
    setDraft(text: string) { calls.push({ method: 'setDraft', args: [text] }) },
    submit(mode?: string) { calls.push({ method: 'submit', args: [mode ?? null] }) },
    arbitrate(key: string, composing: boolean) {
      calls.push({ method: 'arbitrate', args: [key, composing] })
      return 'consumed'
    },
    space() { calls.push({ method: 'space', args: [] }); return true },
    dismissPopup() { calls.push({ method: 'dismissPopup', args: [] }) },
    steerQueue() { calls.push({ method: 'steerQueue', args: [] }) },
    caretSpan() { calls.push({ method: 'caretSpan', args: [] }); return { start: 1, end: 2 } },
    ...overrides,
  }
  return { shell, state, editor, calls }
}

/** 壳桩暴露的编辑器调用记录（见 shellStub；测试断言用）。 */
type ShellStub = ReturnType<typeof shellStub>

/** 组装 binding（`ctx.conversation.input.for(actx)` 链）。 */
function bindingWith(forImpl: (actx: unknown) => unknown): unknown {
  return { session: {}, ctx: { conversation: { input: { for: forImpl } } } }
}

describe('resolveStepComposerKernel（结构探测矩阵）', () => {
  it('returns undefined without a binding or without ctx/conversation/input', () => {
    expect(resolveStepComposerKernel(undefined)).toBeUndefined()
    expect(resolveStepComposerKernel({})).toBeUndefined()
    expect(resolveStepComposerKernel({ ctx: {} })).toBeUndefined()
    expect(resolveStepComposerKernel({ ctx: { conversation: null } })).toBeUndefined()
    expect(resolveStepComposerKernel({ ctx: { conversation: {} } })).toBeUndefined()
    // conversation.input 存在但没有 for（旧宿主/面未装配）→ 降级。
    expect(resolveStepComposerKernel({ ctx: { conversation: { input: {} } } })).toBeUndefined()
    // for 不是函数。
    expect(resolveStepComposerKernel(bindingWith(undefined as never))).toBeUndefined()
  })

  it('returns undefined when input.for throws (non-session scope) or answers a non-object', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(resolveStepComposerKernel(bindingWith(() => { throw new Error('requires a session scope') })))
      .toBeUndefined()
    expect(error).toHaveBeenCalled()
    expect(resolveStepComposerKernel(bindingWith(() => null))).toBeUndefined()
    expect(resolveStepComposerKernel(bindingWith(() => 'not-a-shell'))).toBeUndefined()
    error.mockRestore()
  })

  it('requires state (observable), submit and editor.setRootElement', () => {
    const stub: ShellStub = shellStub()
    const { shell, state } = stub
    // 缺 state。
    expect(resolveStepComposerKernel(bindingWith(() => ({ ...shell, state: undefined })))).toBeUndefined()
    // state 不是可观察面。
    expect(resolveStepComposerKernel(bindingWith(() => ({ ...shell, state: {} })))).toBeUndefined()
    // 缺 submit。
    expect(resolveStepComposerKernel(bindingWith(() => ({ ...shell, submit: undefined })))).toBeUndefined()
    // 缺 editor / editor 无 setRootElement。
    expect(resolveStepComposerKernel(bindingWith(() => ({ ...shell, editor: undefined })))).toBeUndefined()
    expect(resolveStepComposerKernel(bindingWith(() => ({ ...shell, editor: { getRootElement: () => null } }))))
      .toBeUndefined()
    // 全齐 → 探测成功，且暴露的就是壳的状态面与编辑器能力（编辑器是绑定过 this 的
    // 结构包装：方法调用落到同一实例，见下方断言——不是同一对象引用）。
    const kernel = resolveStepComposerKernel(bindingWith(() => shell))
    expect(kernel).toBeDefined()
    expect(kernel?.state).toBe(state)
    const el = {} as HTMLElement
    kernel?.editor.setRootElement(el)
    kernel?.editor.setEditable(false)
    expect(stub.editor.calls).toEqual(['root:el', 'editable:false'])
    expect(kernel?.editor.getRootElement()).toBe(el)
  })

  it('binds shell methods (this survives) and reads the shell freshly on each action', () => {
    const first = shellStub()
    let shells = [first.shell]
    const kernel = resolveStepComposerKernel(bindingWith(() => shells[shells.length - 1]))
    expect(kernel).toBeDefined()
    kernel!.setDraft('你好')
    kernel!.submit()
    expect(first.calls).toEqual([
      { method: 'setDraft', args: ['你好'] },
      { method: 'submit', args: ['queue'] }, // 缺省模式 = queue
    ])
    // 换壳（会话重开）：动作类调用**现读** -> 落到新壳，而不是缓存的旧壳。
    const second = shellStub()
    shells = [second.shell]
    kernel!.setDraft('再试')
    kernel!.submit('steer')
    expect(second.calls).toEqual([
      { method: 'setDraft', args: ['再试'] },
      { method: 'submit', args: ['steer'] },
    ])
    expect(first.calls).toHaveLength(2) // 旧壳不再收到动作
  })

  it('degrades optional faces (arbitrate/space/dismissPopup/steerQueue/caretSpan) safely', () => {
    const bare = shellStub({
      arbitrate: undefined,
      space: undefined,
      dismissPopup: undefined,
      steerQueue: undefined,
      caretSpan: undefined,
    })
    const kernel = resolveStepComposerKernel(bindingWith(() => bare.shell))
    expect(kernel).toBeDefined()
    expect(kernel!.arbitrate('down', false)).toBe('pass') // 无管线 → pass（键盘放行）
    expect(kernel!.space()).toBe(false)
    expect(kernel!.caretSpan()).toBeNull()
    expect(() => { kernel!.dismissPopup(); kernel!.steerQueue() }).not.toThrow()
  })

  it('forwards arbitrate/space/caretSpan and reads draft/phase/queue live', () => {
    const { shell, state, calls } = shellStub()
    const kernel = resolveStepComposerKernel(bindingWith(() => shell))!
    expect(kernel.arbitrate('up', false)).toBe('consumed')
    expect(kernel.space()).toBe(true)
    expect(kernel.caretSpan()).toEqual({ start: 1, end: 2 })
    expect(calls.map(entry => entry.method)).toEqual(['arbitrate', 'space', 'caretSpan'])
    expect(kernel.draft()).toBe('')
    expect(kernel.phase()).toBe('plain')
    expect(kernel.queueLength()).toBe(0)
    state.set({ draft: '排队中', phase: 'submitting', queue: [{}, {}] })
    expect(kernel.draft()).toBe('排队中')
    expect(kernel.phase()).toBe('submitting')
    expect(kernel.queueLength()).toBe(2)
  })

  it('no-ops actions when the shell disappears after resolution (host HMR/unload)', () => {
    const { shell, calls } = shellStub()
    let live: unknown = shell
    const kernel = resolveStepComposerKernel(bindingWith(() => live))!
    live = undefined
    expect(() => { kernel.setDraft('x'); kernel.submit() }).not.toThrow()
    expect(calls).toHaveLength(0)
  })
})

describe('纯函数（草稿 / 可提交 / 相位 / 提交模式）', () => {
  it('reads the draft defensively', () => {
    expect(stepComposerDraftOf(undefined)).toBe('')
    expect(stepComposerDraftOf({ draft: '', phase: 'plain' })).toBe('')
    expect(stepComposerDraftOf({ draft: '你好 @构建', phase: 'plain' })).toBe('你好 @构建')
    // 结构读：draft 不是字符串 → 空串（不抛）。
    expect(stepComposerDraftOf({ draft: 42 as never, phase: 'plain' })).toBe('')
  })

  it('marks adjudicating/submitting as busy and nothing else', () => {
    expect(stepComposerPhaseBusy('adjudicating')).toBe(true)
    expect(stepComposerPhaseBusy('submitting')).toBe(true)
    expect(stepComposerPhaseBusy('plain')).toBe(false)
    expect(stepComposerPhaseBusy('claimed')).toBe(false)
    expect(stepComposerPhaseBusy(undefined)).toBe(false)
  })

  it('gates submit on a non-blank draft outside busy phases', () => {
    expect(stepComposerCanSubmit(undefined)).toBe(false)
    expect(stepComposerCanSubmit({ draft: '', phase: 'plain' })).toBe(false)
    expect(stepComposerCanSubmit({ draft: '   \n ', phase: 'plain' })).toBe(false)
    expect(stepComposerCanSubmit({ draft: '继续', phase: 'plain' })).toBe(true)
    expect(stepComposerCanSubmit({ draft: '继续', phase: 'submitting' })).toBe(false)
    expect(stepComposerCanSubmit({ draft: '继续', phase: 'adjudicating' })).toBe(false)
  })

  it('always submits in queue mode (the only correct semantics for step injection)', () => {
    expect(stepComposerSubmitMode()).toBe('queue')
  })
})

describe('stepComposerHostClaimsRoot（批 B2：宿主原生对话页的根抢占守卫）', () => {
  it('claims the root only when the host current session is this child session', () => {
    expect(stepComposerHostClaimsRoot('child-1', 'child-1')).toBe(true)
    // 宿主页显示的是别的会话（常态：运行视图的 current = 实例宿主主代理）→ 不占用。
    expect(stepComposerHostClaimsRoot('host-main', 'child-1')).toBe(false)
  })

  it('never claims when either side is missing or empty', () => {
    expect(stepComposerHostClaimsRoot(undefined, 'child-1')).toBe(false)
    expect(stepComposerHostClaimsRoot('child-1', undefined)).toBe(false)
    expect(stepComposerHostClaimsRoot('', '')).toBe(false)
    expect(stepComposerHostClaimsRoot('child-1', '')).toBe(false)
    expect(stepComposerHostClaimsRoot(undefined, undefined)).toBe(false)
  })
})
