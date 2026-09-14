/**
 * main-agent-input.spec（呈现层统一 · 决策变更后；@vitest-environment jsdom）：
 * 运行页 **独立输入框** 的组件级回归。
 *
 * 决策变更（用户真机验收后）：「运行页 discussion 的输入框不再复用/接管 DSH 会话输入壳，
 * 重新实现一个一模一样的输入框」。故本 spec 锁五件事：
 * 1. **结构/视觉与 DSH InputBar 同款**：锚点齐全（根/卡/文本面/发送钮/占位层），且**样式源**
 *    逐值抄自 DSH（`--dsw-*` / `--dsh-*` 令牌 + 22px 圆角 + 34px 主钮 + 16px 左内距 +
 *    草稿滚动上限），断言直接读 CSS 源文件（回归改坏视觉会失败）；
 * 2. **独立于 DSH 输入内核**：文本面是原生 `textarea`（不是 contenteditable），DOM 里没有
 *    `[data-composer-input]` / `[data-composer-kernel]` / `[data-composer-took-root]`
 *    ——即「不挂内核、不接管编辑器根」在结构上成立；
 * 3. **Enter 发送 / Shift+Enter 换行 / 发送后清空 / 失败错误行**；
 * 4. **发送期间禁用**（输入面与发送钮）+ 再次输入清除错误行；
 * 5. **通道缺失**（宿主会话未就绪）时禁用而不是「永远发不出去」，且给出状态行。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/main-agent-input.spec
 */
// @vitest-environment jsdom
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import { zh } from './locales.ts'
import { MainAgentInput } from './main-agent-input.tsx'

/** sandore zh 字典桩翻译。 */
function makeT() {
  const lookup = zh as unknown as Record<string, string>
  return (key: string, params?: Record<string, unknown>): string => {
    let text = lookup[key] ?? key
    if (params !== undefined) {
      for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
    }
    return text
  }
}
const t = makeT() as never

const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
})

/** 渲染输入框（可覆盖 props）。 */
function renderInput(extra: {
  /** 发送通道；`unavailable: true` 表示通道缺失（宿主会话未就绪）。 */
  readonly send?: ((text: string) => Promise<{ ok: boolean }>) | undefined
  readonly unavailable?: boolean
  readonly trailing?: ReactNode
  readonly accessory?: ReactNode
  readonly model?: ReactNode
} = {}): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => {
    root.render(h(MainAgentInput, {
      t,
      send: (extra.unavailable === true ? undefined : (extra.send ?? (async () => ({ ok: true })))) as never,
      placeholder: '给主代理发消息…',
      ...(extra.accessory === undefined ? {} : { accessory: extra.accessory }),
      ...(extra.trailing === undefined ? {} : { trailing: extra.trailing }),
      ...(extra.model === undefined ? {} : { model: extra.model }),
    }))
  })
  return host
}

/** 受控 textarea 输入：native setter + input 事件（React onChange 通道）。 */
function typeInto(area: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    setter?.call(area, value)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 等异步发送链落盘（React 状态更新在此 flush）。 */
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

describe('MainAgentInput 结构与视觉（与 DSH InputBar 同款）', () => {
  it('renders the DSH InputBar anchor structure with the seat placeholder', () => {
    const host = renderInput()
    expect(host.querySelector('[data-sandore-main-input]')).not.toBeNull()
    expect(host.querySelector('[data-main-agent-input-card]')).not.toBeNull()
    const area = host.querySelector('[data-main-agent-input]')
    expect(area?.tagName).toBe('TEXTAREA')
    expect(area?.getAttribute('aria-label')).toBe('给主代理发消息…') // DSH：placeholder 兼作可访问名
    // 占位层（DSH 用独立 .placeholder 层；原生 placeholder 属性留空以免出现两套样式）。
    expect(area?.getAttribute('placeholder')).toBe('')
    expect(host.querySelector('[data-main-agent-input-card]')?.textContent).toContain('给主代理发消息…')
    const send = host.querySelector('[data-main-agent-send]')
    expect(send?.getAttribute('aria-label')).toBe('发送消息') // 与 step 面板/DSH 同一文案键
    // 空草稿：发送钮禁用（DSH 主按钮同款「空文本 = 禁用」）。
    expect((send as HTMLButtonElement).disabled).toBe(true)
    // 真机反馈修正：不再有「主代理 / 消息发给主代理…」标签行，也不再有排队提示文案
    // （DSH 输入框没有这些；语义改由主代理卡片的卡头承担）。
    expect(host.querySelector('[data-sandore-main-input-label]')).toBeNull()
    expect(host.querySelector('[data-main-agent-queue-hint]')).toBeNull()
    // 左下角 `+` 附件按钮**不复刻**（用户明确要求）。
    expect(host.querySelector('[data-composer-menu-anchor], button[aria-haspopup="listbox"]')).toBeNull()
  })

  it('sizes the card from the step message column (same axis, only a bit wider)', () => {
    // jsdom 不加载 CSS module，故直接读样式源里的 `.card` 规则（真实生效的那条）。
    const css = readFileSync(resolve(process.cwd(), 'packages/client/main-agent-input.module.css'), 'utf8')
    const cardBlock = /\n\.card \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(cardBlock, '卡宽度应以消息列内容宽为基准').toContain('width: min(calc(var(--sandore-msg-content-width, 100%) + 24px), 100%)')
    expect(cardBlock, '与消息列同轴心（左右自动外边距居中）').toContain('margin-inline: auto')
    // 状态行与卡同宽（错误行不会比卡宽）。
    const noticeBlock = /\n\.notice \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(noticeBlock).toContain('var(--sandore-msg-content-width')
  })

  it('renders the permission seat on the left and the model seat before the send button', () => {
    const host = renderInput({
      accessory: h('span', { 'data-test': 'access' }, '权限'),
      model: h('span', { 'data-test': 'model' }, '模型'),
    })
    // 顺序：权限（左席位）→ 模型 → 发送（DSH `.trailing` 顺序；**没有**任何动作按钮）。
    const card = host.querySelector('[data-main-agent-input-card]') as HTMLElement
    const order = [...card.querySelectorAll('[data-test], [data-main-agent-send]')]
      .map(node => (node.hasAttribute('data-main-agent-send') ? 'send' : node.getAttribute('data-test')))
    expect(order).toEqual(['access', 'model', 'send'])
    // 动作行里的按钮只有发送钮（席位由调用方以节点形式传入，本组件不自己造按钮）。
    expect([...card.querySelectorAll('button')].map(node => node.hasAttribute('data-main-agent-send'))).toEqual([true])
  })

  it('keeps the DSH InputBar visual values in the stylesheet (tokens + geometry)', () => {
    // 直接读样式源：视觉是需求的一半（「一模一样」），回归改坏要能被断言抓住。
    // 路径按 vitest 的工作目录（= 仓库根）解析；不用 import.meta.url（jsdom 下它是 http 形式的）。
    const css = readFileSync(resolve(process.cwd(), 'packages/client/main-agent-input.module.css'), 'utf8')
    for (const needle of [
      '--dsw-specific-input-major', // 输入面底色（跟随深浅色）
      '--dsw-elevation-soft', // 软阴影
      '--dsw-alias-border-l2', // 发丝描边
      '--dsh-content-font-size', // 跟随设置里的全局字号
      '--dsh-composer-text-max-height', // 草稿滚动上限（14 行 = 336px，DSH composerSeat 同值）
      'border-radius: 22px', // 卡片圆角（DSH .card 同值）
      'width: 34px', // 主按钮直径（DSH .primary 同值）
      'padding: 4px 8px 0 16px', // 文本面内距（DSH .input 同值）
      '--dsw-alias-button-info-fill', // 发送钮底色（DSH .primary 同令牌）
      '--dsw-alias-label-caption', // 占位/提示文字（DSH .placeholder/.notice 同令牌）
      // 宽度基准（真机反馈修正）：消息列内容宽 + 24px，不再用 DSH 对话列的 clamp 公式。
      '--sandore-msg-content-width',
      '+ 24px',
      'margin-inline: auto',
      // DSH InputBar 的其余逐值项。
      'padding: 0 var(--dsh-composer-side-clearance) 8px', // .root 底部 8px + 侧留白
      'padding: 2px 8px 6px', // .row 内距
      'container-type: inline-size', // .row 的匿名尺寸容器（权限 chip 的 @container 折叠依赖它）
      'transform: translateY(-2px)', // .primary 抵消 .row 的 2px 下移
      'background: var(--dsw-alias-button-info-hover)', // .primary hover
      'opacity: 0.4', // .primary:disabled（空文本 = 0.4）
    ]) {
      expect(css, `样式源应保留 DSH 同款值：${needle}`).toContain(needle)
    }
    // `+` 附件按钮**不复刻**：样式源里不应出现 DSH `.add` 的圆钮规格。
    expect(css).not.toContain('--dsw-specific-selector')
    // 也不再照抄 DSH 对话列的宽度轴（那条规则用在运行视图里偏宽，已被真机否决）：
    // 断言的是**生效的声明**（变量定义/卡片宽度），而不是注释里提到的原文。
    expect(css).not.toContain('--dsh-composer-card-max-width')
    expect(css).not.toContain('--dsh-chat-content-width:')
    expect(/\n\.card \{[\s\S]*?clamp\(680px/.test(css), '.card 规则不应再出现 clamp 宽度公式').toBe(false)
  })

  it('does not declare the DSH conversation-column axis itself (it consumes the message-column basis)', () => {
    const css = readFileSync(resolve(process.cwd(), 'packages/client/main-agent-input.module.css'), 'utf8')
    const rootBlock = /\n\.root \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    // 真机反馈否决了 DSH 对话列的宽度轴：本组件只保留 DSH 的**视觉**变量（字号/草稿上限/侧留白），
    // 宽度基准由 `.feedCol` 上的 `--sandore-msg-content-width` 提供（run-view-metrics.ts）。
    expect(rootBlock).not.toContain('--dsh-chat-content-width')
    expect(rootBlock).not.toContain('--dsh-conversation-column-width')
    expect(rootBlock).toContain('--dsh-composer-text-max-height')
    expect(css).toContain('var(--sandore-msg-content-width, 100%) + 24px')
  })

  it('is independent from the DSH input kernel (no contenteditable / no composer anchors)', () => {
    const host = renderInput()
    // 关键：不挂 DSH 输入内核 ⇒ 没有内核路径的任何锚点，也没有根接管留痕。
    for (const selector of [
      '[data-composer-input]',
      '[data-composer-kernel]',
      '[data-composer-took-root]',
      '[data-step-chat-composer]',
      '[data-composer-send]',
    ]) {
      expect(host.querySelector(selector), `${selector} 不应出现在独立输入框里`).toBeNull()
    }
    // 也没有 contenteditable（DSH 内核的文本面形态）。
    expect(host.querySelector('[contenteditable="true"]')).toBeNull()
    // 动作行右侧**只有**发送钮（真机反馈第三轮已把暂停/停止/中止按钮全部移出）。
    const row = host.querySelector('[data-main-agent-send]')?.parentElement
    const buttons = [...(row?.querySelectorAll('button') ?? [])]
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.hasAttribute('data-main-agent-send')).toBe(true)
  })
})

describe('MainAgentInput 发送语义', () => {
  it('sends on Enter, clears the draft and keeps going', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    const host = renderInput({ send })
    const area = host.querySelector('[data-main-agent-input]') as HTMLTextAreaElement
    const button = host.querySelector('[data-main-agent-send]') as HTMLButtonElement
    typeInto(area, '你好，主代理')
    expect(button.disabled).toBe(false)
    await act(async () => {
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })
    expect(send).toHaveBeenCalledWith('你好，主代理')
    expect(area.value).toBe('') // 发送后清空
    expect(button.disabled).toBe(true)
  })

  it('never sends on Shift+Enter (newline) and keeps the draft', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    const host = renderInput({ send })
    const area = host.querySelector('[data-main-agent-input]') as HTMLTextAreaElement
    typeInto(area, '第一行')
    await act(async () => {
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
      await Promise.resolve()
    })
    expect(send).not.toHaveBeenCalled()
    expect(area.value).toBe('第一行') // 换行由浏览器原生处理，草稿保留
  })

  it('sends through the button as well, and ignores empty drafts', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    const host = renderInput({ send })
    const area = host.querySelector('[data-main-agent-input]') as HTMLTextAreaElement
    const button = host.querySelector('[data-main-agent-send]') as HTMLButtonElement
    act(() => { button.click() })
    expect(send).not.toHaveBeenCalled()
    typeInto(area, '   ')
    expect(button.disabled).toBe(true) // 全空白不可发
    act(() => { button.click() })
    expect(send).not.toHaveBeenCalled()
    typeInto(area, '走按钮发送')
    act(() => { button.click() })
    await flush()
    expect(send).toHaveBeenCalledWith('走按钮发送')
  })

  it('shows an error line on failure and keeps the draft for a retry', async () => {
    const send = vi.fn(async () => ({ ok: false, message: 'prompt rejected', code: 'session/agent-busy' }))
    const host = renderInput({ send })
    const area = host.querySelector('[data-main-agent-input]') as HTMLTextAreaElement
    typeInto(area, '会失败的内容')
    await act(async () => {
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })
    const status = host.querySelector('[data-main-agent-status]')
    expect(status?.getAttribute('role')).toBe('alert')
    expect(status?.textContent).toBe('prompt rejected (session/agent-busy)')
    expect(area.value).toBe('会失败的内容') // 失败保留草稿
    // 再次输入清除错误行（DSH toast 同族行为）。
    typeInto(area, '会失败的内容2')
    expect(host.querySelector('[data-main-agent-status]')).toBeNull()
  })

  it('disables the surface while the send is in flight', async () => {
    let resolveSend: ((value: { ok: boolean }) => void) | undefined
    const send = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => { resolveSend = resolve }))
    const host = renderInput({ send })
    const area = host.querySelector('[data-main-agent-input]') as HTMLTextAreaElement
    const button = host.querySelector('[data-main-agent-send]') as HTMLButtonElement
    typeInto(area, '慢速消息')
    await act(async () => {
      button.click()
      await Promise.resolve()
    })
    expect(button.disabled).toBe(true)
    expect(area.disabled).toBe(true)
    expect(host.querySelector('[data-main-agent-status]')?.textContent).toBe('发送中…')
    await act(async () => {
      resolveSend?.({ ok: true })
      await Promise.resolve()
    })
    expect(area.disabled).toBe(false)
    expect(host.querySelector('[data-main-agent-status]')).toBeNull()
  })

  it('stays disabled with a status line when the send channel is unavailable', async () => {
    const host = renderInput({ unavailable: true })
    const area = host.querySelector('[data-main-agent-input]') as HTMLTextAreaElement
    const button = host.querySelector('[data-main-agent-send]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    // 仍可输入（草稿可写），但发送会给出明确的「会话尚未就绪」状态行，而不是静默失败。
    typeInto(area, '通道不可用')
    expect(button.disabled).toBe(true)
    await act(async () => {
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })
    expect(host.querySelector('[data-main-agent-status]')?.textContent).toBe('主代理会话尚未就绪，稍后重试')
  })
})
