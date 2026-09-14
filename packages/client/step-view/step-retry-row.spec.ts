/**
 * step-retry-row.spec（批 B2；**需求 1 改写**；@vitest-environment jsdom）：
 * 重试行的组件级行为回归。
 *
 * 需求 1 的语义变化（本 spec 的主要改动）：面板内嵌输入框被移除，重试 message
 * 不再是「当前草稿」，而是**固定默认串**（`run.step.chat.retry.defaultMessage`）。
 * 因此：
 * - 组件本体 `StepRetryRow` 的用例改为**直接挂载**它（不再经过 ComposerBar 的草稿
 *   通道）；
 * - 原来的「有草稿 → 原样草稿」「成功清空草稿」两条草稿语义用例删除（行为已不存在，
 *   不得留下描述已删行为的断言）；
 * - 新增反向断言：**即使输入面里有草稿，提交的也是默认串**（需求 1 的核心），
 *   覆盖 ComposerBar 的两条路径（内核 + 降级）仍把重试行渲染在输入卡上方的连接
 *   关系（ComposerBar 保留为面板输入框的恢复入口，见其文件头「需求 1」段）。
 *
 * 覆盖：
 * 1. **可见性与结构**：模式三选 + 重试按钮；非 revert 不显示回退点下拉、不拉候选。
 * 2. **提交载荷**：固定默认 message；revert 模式所选回退点作为 `revertBoundary`
 *    传递（非 revert 模式不携带该键）。
 * 3. **回退点下拉**：revert 才拉 `listBoundaries(stepId)`；有候选渲染 `Turn N` 选项；
 *    空候选 → 禁用下拉 + 轻量提示；拉取失败 → 降级文案（宿主错误原文）。
 * 4. **错误行**：`retry` 拒绝 → `data-step-chat-retry-error` 展示引擎原文（F1
 *    「子代理会话已销毁」）+ 该族的引导提示；飞行中按钮禁用并显示「重试中…」。
 * 5. **与 ComposerBar 的关系**：传了 `retry` 端口时行渲染在输入卡**上方**；面板
 *    侧（StepChatPanel）现在自己持有该行（`data-step-chat-retry-seat`），两条路径
 *    的锚点与载荷一致。
 *
 * 沿用 composer-bar-render.spec 的模式（jsdom + react-dom/client + act；无真实排版
 * 断言，视觉由真实宿主 + CSS 承担）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/step-retry-row.spec
 */
// @vitest-environment jsdom
// React 18 需要显式声明 act 环境（否则每个 act 调用打 warning）。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import { zh } from '../locales.ts'
import { ComposerBar } from './ComposerBar.tsx'
import { StepRetryRow } from './StepRetryRow.tsx'
import type { StepChatComposerSend } from './composer-bar.ts'
import type { StepComposerInputStateLike } from './dsh-composer.ts'
import type {
  StepChatRetryPort,
  StepRetryBoundaryOptionLike,
  StepRetryRequest,
} from './step-retry.ts'

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
})

function render(element: ReactNode): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => { root.render(element) })
  return host
}

/** 受控 select 选择：native setter + change 事件（React onChange 通道）。 */
function pickOption(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  act(() => {
    setter?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** 等待承诺链落盘（React 状态更新在此 flush）。 */
async function flushAsync(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

/** 重试端口桩（记录请求与查询；可注入拒绝/挂起）。 */
function retryPortStub(options: {
  readonly boundaries?: readonly StepRetryBoundaryOptionLike[]
  readonly rejectBoundaries?: unknown
  readonly rejectRetry?: unknown
  /** 挂起 retry（返回的 release 由用例控制），用于断言飞行中态。 */
  readonly pendingRetry?: boolean
  readonly target?: Partial<StepChatRetryPort['target']>
} = {}) {
  let release: (() => void) | undefined
  const retry = vi.fn((_input: StepRetryRequest): Promise<void> => {
    if (options.rejectRetry !== undefined) return Promise.reject(options.rejectRetry)
    if (options.pendingRetry === true) {
      return new Promise<void>((resolve) => { release = resolve })
    }
    return Promise.resolve()
  })
  const listBoundaries = vi.fn((): Promise<readonly StepRetryBoundaryOptionLike[]> => (
    options.rejectBoundaries === undefined
      ? Promise.resolve(options.boundaries ?? [])
      : Promise.reject(options.rejectBoundaries)
  ))
  const port: StepChatRetryPort = {
    target: {
      stepId: 'step-a',
      status: 'failed',
      commandType: 'prompt',
      synthetic: false,
      ...options.target,
    },
    retry,
    listBoundaries,
  }
  return { port, retry, listBoundaries, release: () => { release?.() } }
}

/** 挂一个重试行本体（需求 1 起面板与 ComposerBar 用的都是这一个组件）。 */
function mountRetryRow(port: StepChatRetryPort): HTMLElement {
  return render(h(StepRetryRow, { port, t }))
}

/** 挂一个「failed 段」的输入框（ComposerBar 保留路径：retry 端口 + 无 binding）。 */
function mountFailedComposer(port: StepChatRetryPort, send?: StepChatComposerSend): HTMLElement {
  return render(h(ComposerBar, {
    openState: 'open',
    running: false, // failed 段：展示条件靠 retryPending 放宽
    send: send ?? (async () => ({ ok: true })),
    retry: port,
    t,
  }))
}

describe('重试行可见性与结构（jsdom）', () => {
  it('renders the mode row, the submit button, and no boundary select outside revert', () => {
    const stub = retryPortStub()
    const host = mountRetryRow(stub.port)
    const row = host.querySelector('[data-step-chat-retry-row]')
    expect(row).not.toBeNull()
    expect(row?.getAttribute('data-step-chat-retry-step')).toBe('step-a')
    // 模式三选 + 重试按钮（文案复用 DiscussionInput 既有键）。
    const modes = [...(row?.querySelectorAll('[data-step-chat-retry-mode]') ?? [])]
    expect(modes.map(node => node.getAttribute('data-step-chat-retry-mode')))
      .toEqual(['continue', 'revert', 'fork'])
    expect(modes.map(node => node.textContent)).toEqual(['继续', '回退', '分叉'])
    expect(modes[0]?.getAttribute('aria-pressed')).toBe('true') // 默认继续
    expect(row?.querySelector('[data-step-chat-retry-submit]')?.textContent).toBe('重试')
    // 非 revert 模式不显示回退点下拉，也不拉候选。
    expect(row?.querySelector('[data-step-chat-retry-boundary]')).toBeNull()
    expect(stub.listBoundaries).not.toHaveBeenCalled()
  })

  it('renders no retry row in ComposerBar without a port (input box keeps its old shape)', () => {
    const host = render(h(ComposerBar, {
      openState: 'open',
      running: true,
      send: async () => ({ ok: true }),
      t,
    }))
    expect(host.querySelector('[data-step-chat-retry-row]')).toBeNull()
    expect(host.querySelector('textarea')).not.toBeNull()
  })

  it('keeps the retry row above the input card when the composer is given the port', () => {
    const stub = retryPortStub()
    const host = mountFailedComposer(stub.port)
    const row = host.querySelector('[data-step-chat-retry-row]')
    const shell = host.querySelector('[data-step-chat-composer]')
    expect(row).not.toBeNull()
    // 行在输入卡上方：行节点是壳的第一个子元素（DOM 顺序）。
    expect(shell?.firstElementChild).toBe(row)
  })
})

describe('重试提交载荷（需求 1：固定默认 message）', () => {
  it('submits the localized default message and never carries a boundary outside revert', async () => {
    const stub = retryPortStub()
    const host = mountRetryRow(stub.port)
    await act(async () => {
      (host.querySelector('[data-step-chat-retry-submit]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(stub.retry).toHaveBeenCalledTimes(1)
    expect(stub.retry.mock.calls[0]?.[0]).toEqual({
      stepId: 'step-a',
      mode: 'continue',
      message: '请重试该步骤',
    })
    // 非 revert：键必须缺席（引擎按默认边界处理）。
    expect('revertBoundary' in (stub.retry.mock.calls[0]?.[0] ?? {})).toBe(false)
  })

  it('never takes the composer draft as the retry message (draft channel is gone)', async () => {
    // 需求 1 的反向断言：即使输入面里有草稿，重试 submit 的 message 仍是默认串
    // ——「草稿即重试载荷」这条旧语义已删除，不能被悄悄恢复。
    const stub = retryPortStub()
    const host = mountFailedComposer(stub.port)
    const area = host.querySelector('textarea') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    act(() => {
      setter?.call(area, '请保留产物重跑')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(area.value).toBe('请保留产物重跑')
    await act(async () => {
      (host.querySelector('[data-step-chat-retry-submit]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(stub.retry.mock.calls[0]?.[0]).toEqual({
      stepId: 'step-a',
      mode: 'continue',
      message: '请重试该步骤',
    })
  })

  it('never fires while a retry is already in flight, and shows the running copy', async () => {
    const stub = retryPortStub({ pendingRetry: true })
    const host = mountRetryRow(stub.port)
    const submit = host.querySelector('[data-step-chat-retry-submit]') as HTMLButtonElement
    await act(async () => {
      submit.click()
      submit.click() // 同帧连点：原子闸拦住第二次
      await flushAsync()
    })
    expect(stub.retry).toHaveBeenCalledTimes(1)
    expect(submit.disabled).toBe(true)
    expect(submit.textContent).toBe('重试中…')
    // 模式按钮在飞行中一并禁用（避免半途改模式）。
    expect((host.querySelector('[data-step-chat-retry-mode="revert"]') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      stub.release()
      await Promise.resolve()
    })
    expect(submit.disabled).toBe(false)
    expect(submit.textContent).toBe('重试')
  })
})

describe('revert 回退点下拉（jsdom）', () => {
  it('loads the boundaries on revert and passes the picked seq', async () => {
    const stub = retryPortStub({
      boundaries: [{ seq: 120, turn: 0, preview: '第一轮' }, { seq: 240, turn: 1, preview: '第二轮' }],
    })
    const host = mountRetryRow(stub.port)
    const row = host.querySelector('[data-step-chat-retry-row]') as HTMLElement
    // 切到回退模式：此时才拉候选（带本段 stepId）。
    await act(async () => {
      (row.querySelector('[data-step-chat-retry-mode="revert"]') as HTMLButtonElement).click()
      await flushAsync()
    })
    expect(stub.listBoundaries).toHaveBeenCalledWith('step-a')
    const select = row.querySelector('[data-step-chat-retry-boundary]') as HTMLSelectElement
    expect(select).not.toBeNull()
    expect([...select.options].map(option => option.value)).toEqual(['default', '120', '240'])
    expect([...select.options].map(option => option.textContent))
      .toEqual(['默认（最后一个闭合 turn）', 'Turn 1', 'Turn 2'])
    // 选第 2 个闭合 turn → 提交携带该 seq（message 仍是固定默认串）。
    pickOption(select, '240')
    await act(async () => {
      (row.querySelector('[data-step-chat-retry-submit]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(stub.retry.mock.calls[0]?.[0]).toEqual({
      stepId: 'step-a',
      mode: 'revert',
      message: '请重试该步骤',
      revertBoundary: 240,
    })
  })

  it('omits the boundary when the default option stays selected', async () => {
    const stub = retryPortStub({ boundaries: [{ seq: 120, turn: 0 }] })
    const host = mountRetryRow(stub.port)
    await act(async () => {
      (host.querySelector('[data-step-chat-retry-mode="revert"]') as HTMLButtonElement).click()
      await flushAsync()
    })
    await act(async () => {
      (host.querySelector('[data-step-chat-retry-submit]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    const request = stub.retry.mock.calls[0]?.[0] ?? {}
    expect(request.mode).toBe('revert')
    expect('revertBoundary' in request).toBe(false)
  })

  it('degrades to a disabled select plus a light hint when there is no closed turn', async () => {
    const stub = retryPortStub({ boundaries: [] })
    const host = mountRetryRow(stub.port)
    await act(async () => {
      (host.querySelector('[data-step-chat-retry-mode="revert"]') as HTMLButtonElement).click()
      await flushAsync()
    })
    const select = host.querySelector('[data-step-chat-retry-boundary]') as HTMLSelectElement
    expect(select.disabled).toBe(true)
    expect(select.options[0]?.textContent).toBe('无可用回退点')
    expect(host.querySelector('[data-step-chat-retry-revert-unavailable]')?.textContent)
      .toBe('该步骤没有可回退的闭合 turn，建议改用继续或分叉')
  })

  it('shows the host error text when the boundary query fails', async () => {
    const stub = retryPortStub({ rejectBoundaries: new Error('INVALID_OPERATION: session not found') })
    const host = mountRetryRow(stub.port)
    await act(async () => {
      (host.querySelector('[data-step-chat-retry-mode="revert"]') as HTMLButtonElement).click()
      await flushAsync()
    })
    expect(host.querySelector('[data-step-chat-retry-boundary-error]')?.textContent)
      .toBe('回退点加载失败：INVALID_OPERATION: session not found')
    // 候选区退化为禁用下拉（不渲染可选项）。
    expect((host.querySelector('[data-step-chat-retry-boundary]') as HTMLSelectElement).disabled).toBe(true)
  })
})

describe('重试错误行（jsdom）', () => {
  it('shows the engine message verbatim and the F1 disposed hint', async () => {
    const stub = retryPortStub({
      rejectRetry: new Error(
        "INVALID_OPERATION: step 'step-a' 的子代理会话已销毁（DSH 0.1.2-rc.1 对已结算子代理 dispose，"
        + '无法续跑），不能重试；请重新运行该 Step/实例',
      ),
    })
    const host = mountRetryRow(stub.port)
    await act(async () => {
      (host.querySelector('[data-step-chat-retry-submit]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    const error = host.querySelector('[data-step-chat-retry-error]')
    expect(error?.getAttribute('role')).toBe('alert')
    expect(error?.textContent).toContain('子代理会话已销毁') // 引擎原话原样可见
    expect(host.querySelector('[data-step-chat-retry-disposed]')?.textContent)
      .toBe('子代理会话已销毁：请重新运行该步骤或整个实例')
  })

  it('falls back to the localized line for a message-less rejection', async () => {
    const stub = retryPortStub({ rejectRetry: new Error('') })
    const host = mountRetryRow(stub.port)
    await act(async () => {
      (host.querySelector('[data-step-chat-retry-submit]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(host.querySelector('[data-step-chat-retry-error]')?.textContent).toBe('重试失败')
    expect(host.querySelector('[data-step-chat-retry-disposed]')).toBeNull()
  })
})

/** 内核桩（SessionInputShell 结构子集；记录 setDraft 与状态发布）。 */
function kernelStub() {
  const listeners = new Set<() => void>()
  let state: StepComposerInputStateLike = { draft: '', phase: 'plain' }
  const calls = { setDraft: [] as string[] }
  let root: HTMLElement | null = null
  const shell = {
    state: {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    editor: {
      setRootElement: (el: HTMLElement | null) => { root = el },
      getRootElement: () => root,
      setEditable: () => undefined,
      getDecorators: () => ({}),
      registerDecoratorListener: () => () => undefined,
      getElementByKey: () => null,
      focus: () => undefined,
    },
    setDraft: (text: string) => {
      calls.setDraft.push(text)
      state = { ...state, draft: text }
      for (const listener of [...listeners]) listener()
    },
    submit: () => undefined,
  }
  return {
    calls,
    binding: { session: {}, ctx: { conversation: { input: { for: () => shell } } } } as never,
    setDraftState: (draft: string) => {
      state = { ...state, draft }
      for (const listener of [...listeners]) listener()
    },
  }
}

describe('内核路径的重试（jsdom）', () => {
  it('keeps the row on the kernel path and submits the fixed default message', async () => {
    const stub = retryPortStub()
    const kernel = kernelStub()
    const host = render(h(ComposerBar, {
      openState: 'open',
      running: false,
      send: async () => ({ ok: true }),
      binding: kernel.binding,
      retry: stub.port,
      t,
    }))
    // 内核路径：重试行仍在（结构与降级路径一致），文本面是 contenteditable。
    expect(host.querySelector('[data-step-chat-retry-row]')).not.toBeNull()
    expect(host.querySelector('[data-composer-kernel]')?.getAttribute('data-composer-kernel')).toBe('dsh')
    // 需求 1：内核草稿不再进入重试载荷——提交的永远是默认串，草稿也不被清空
    // （重试不再有「成功清空草稿」的语义，setDraft 不会被重试路径调用）。
    act(() => { kernel.setDraftState('用内核草稿重试') })
    await act(async () => {
      (host.querySelector('[data-step-chat-retry-submit]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(stub.retry.mock.calls[0]?.[0]).toEqual({
      stepId: 'step-a',
      mode: 'continue',
      message: '请重试该步骤',
    })
    expect(kernel.calls.setDraft).toEqual([])
  })
})
