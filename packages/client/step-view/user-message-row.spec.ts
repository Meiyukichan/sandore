/**
 * user-message-row.spec（**需求 2**；@vitest-environment jsdom）：user 消息的折叠行
 * ≠ 右对齐气泡，而是**与「思考」行一模一样**的左对齐折叠行。
 *
 * 本条需求有两半，本 spec 用三种证据覆盖（视觉排版本身由真机 e2e 的 boundingBox
 * 断言负责，见 e2e/m1-embedded-render.e2e.ts 与 e2e/r1-real-smoke.e2e.ts）：
 * 1. **渲染与交互**：标题「用户消息」+ 首行摘要单行省略；点击展开完整消息、再点收起；
 *    展开体承载原气泡的全部内容（图片/文本/未知块/引用会话摘要/时钟+复制动作）。
 * 2. **同一套 class / 同一容器结构**（jsdom 可证的那一半）：把「思考」行与「用户消息」
 *    行渲染在同一棵树里，逐节点比较**真实 CSS module class 字符串**（vitest 的
 *    CSS module 默认导出是真 class 名，例如 `_root_58xxxx`）——根容器、标题行、
 *    leading 图标盒、标题、分隔点、摘要、摘要文本必须逐字相同，即「同一份样式表」。
 * 3. **没有右对齐残留**：`user-message.module.css` 与折叠行壳源码里**不得**出现
 *    `align-self: flex-end` / `margin-left: auto` / `justify-content: flex-end` /
 *    `right:` 之类把内容推向右侧的写法（左对齐与思考行齐平是硬要求）。
 *
 * 策略与 step-view-render.spec 一致：jsdom + react-dom/client + primitives 桩
 * （primitives 的发布产物自带 *.module.css，vitest 默认外置 node_modules 不处理 CSS）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/user-message-row.spec
 */
// @vitest-environment jsdom
// React 18 需要显式声明 act 环境（否则每个 act 调用打 warning）。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

// primitives 桩：DisclosureRow 按真实结构透传 class（见 step-view-render.spec 的同款说明）。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement: el, Fragment: F } = await import('react')
  const icon = (label: string) => () => el('svg', { 'data-icon': label, 'aria-hidden': true })
  return {
    DisclosureRow: (props: {
      icon?: ReactNode
      title?: ReactNode
      open?: boolean
      expandable?: boolean
      expandOnRowClick?: boolean
      collapsedContent?: ReactNode
      children?: ReactNode
      rowClassName?: string
      leadingClassName?: string
      titleClassName?: string
      chevronClassName?: string
      onToggle?: () => void
    }) => el('div', { 'data-open': props.open === true || undefined },
      el('div', {
        'data-disclosure-row': true,
        role: props.expandable === true && props.expandOnRowClick === true ? 'button' : undefined,
        'aria-expanded': props.expandable === true && props.expandOnRowClick === true
          ? props.open === true
          : undefined,
        className: props.rowClassName,
        // 真实 primitive：整行可点（expandOnRowClick）时 onClick = onToggle。
        onClick: props.expandable === true && props.expandOnRowClick === true ? props.onToggle : undefined,
      },
      el('span', { className: props.leadingClassName, 'data-leading': true }, props.icon),
      el('span', { className: props.titleClassName, 'data-title': true }, props.title),
      props.collapsedContent),
      props.open === true ? props.children : null),
    MarkdownText: (props: { text?: string }) => el('p', { 'data-markdown': true }, props.text),
    JsonBlock: (props: { label?: ReactNode; payload?: unknown }) => el('div', null, props.label, JSON.stringify(props.payload)),
    projectUserText: (text?: string) => el('span', null, text),
    ReferenceIcon: () => el('span'),
    Tooltip: (props: { children?: ReactNode }) => el(F, null, props.children),
    writeClipboard: async () => true,
    StateDot: () => el('span'),
    CodeBlock: (props: { code?: string }) => el('pre', null, props.code),
    TerminalBlock: () => el('div'),
    DiffBlock: () => el('div'),
    ReadBlock: () => el('div'),
    SearchBlock: () => el('div'),
    WebBlock: () => el('div'),
    diffTotals: () => ({ added: 0, removed: 0 }),
    IconThinkOutline14: icon('think'),
    IconUserOutline16: icon('user'),
    IconBrowseOutline16: icon('browse'),
    IconContextInjectionOutline16: icon('context'),
    IconCopyOutline16: icon('copy'),
    IconCheckOutline16: icon('check'),
    IconBranchOutline16: icon('branch'),
    IconApiOutline14: icon('api'),
    IconChevronDownOutline14: icon('chevron-down'),
    IconChevronRightOutline14: icon('chevron-right'),
    IconCodeOutline16: icon('code'),
    IconEditOutline16: icon('edit'),
    IconSearchOutline16: icon('search'),
    IconSparkle16: icon('sparkle'),
    IconClockOutline16: icon('clock'),
    IconDatabaseOutline16: icon('database'),
  }
})

import type { SandoreRenderMessageImages } from '../chat/attachment/MessageImage.tsx'
import { zh } from '../locales.ts'
import { ReasoningRow } from './ReasoningRow.tsx'
import { StepChatUserMessageView } from './UserMessageView.tsx'

/** sandore zh 字典桩翻译（与其它 client spec 同款）。 */
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

/** 空图片渲染器（本 spec 不吃附件）。 */
const noImages: SandoreRenderMessageImages = () => null

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

/** 一条含多行文本 + 引用标签的 user 行数据（首行摘要 ≠ 全文）。 */
const USER_DATA = {
  kind: 'user',
  seq: 7,
  time: 1_700_000_000_000,
  content: [{ type: 'text', text: '第一行摘要\n第二行细节\n第三行细节' }],
  source: { kind: 'user' },
  referenceLabels: ['会话A'],
} as const

/** 收集一行里参与「同一套 class」比较的各节点 class（顺序稳定）。 */
function classFingerprint(row: Element): Record<string, string | null> {
  // 行内直接子节点顺序（与 DisclosureRow 契约一致）：
  // [leading 图标盒, title 标题, separator 分隔点, summary 摘要]。
  const kids = [...row.children]
  return {
    root: row.closest('[data-variant]')?.className ?? null,
    row: row.className,
    leading: kids[0]?.className ?? null,
    title: kids[1]?.className ?? null,
    separator: kids[2]?.className ?? null,
    summary: kids[3]?.className ?? null,
    summaryText: kids[3]?.firstElementChild?.className ?? null,
  }
}

describe('需求 2 · 用户消息折叠行（渲染与交互）', () => {
  it('renders the title + first-line summary, then the full message on expand', () => {
    const host = render(h(StepChatUserMessageView, { data: USER_DATA, renderMessageImages: noImages, t }))
    const root = host.querySelector('[data-variant="user"]')
    expect(root).not.toBeNull()
    // 标题 = 用户消息；摘要 = 首行（单行省略由 CSS `.summaryText` 承担）。
    expect(host.querySelector('[data-title]')?.textContent).toBe('用户消息')
    expect(host.textContent ?? '').toContain('第一行摘要')
    expect(host.textContent ?? '').not.toContain('第二行细节')
    // 折叠态：只有标题行（完整消息不在 DOM 文本里）。
    act(() => {
      host.querySelector('[data-disclosure-row]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const text = host.textContent ?? ''
    expect(text).toContain('第一行摘要')
    expect(text).toContain('第二行细节')
    expect(text).toContain('第三行细节')
    // 引用会话摘要 + 复制动作都在展开体里（原气泡的能力不丢）。
    expect(text).toContain('引用会话')
    expect(host.querySelector('[aria-label="复制"]')).not.toBeNull()
  })

  it('falls back to an empty summary for an image-only message without crashing', () => {
    const images: SandoreRenderMessageImages = owner => h('span', { 'data-images': owner.images.length })
    const host = render(h(StepChatUserMessageView, {
      data: { kind: 'user', seq: 1, time: 9, content: [{ type: 'image', attachment: { id: 'a' } }] },
      renderMessageImages: images,
      t,
    }))
    expect(host.querySelector('[data-title]')?.textContent).toBe('用户消息')
    act(() => {
      host.querySelector('[data-disclosure-row]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(host.querySelector('[data-images="1"]')).not.toBeNull()
  })

  it('does not throw on malformed payloads (empty-state row)', () => {
    const host = render(h('div', null,
      h(StepChatUserMessageView, { data: undefined, renderMessageImages: noImages, t }),
      h(StepChatUserMessageView, { data: { content: [null, 42] }, renderMessageImages: noImages, t }),
    ))
    expect(host.textContent ?? '').not.toContain('undefined')
    expect(host.querySelectorAll('[data-variant="user"]').length).toBe(2)
  })
})

describe('需求 2 · 「用户消息」与「思考」同一套 class（jsdom 比较真实 class 名）', () => {
  it('uses the very same layout classes as the think row', () => {
    // 同一棵树里渲染两条行：思考行（assistant reasoning）与用户消息行。
    const host = render(h('div', null,
      h(ReasoningRow, { text: '思考首行\n思考次行', running: false, t }),
      h(StepChatUserMessageView, { data: USER_DATA, renderMessageImages: noImages, t }),
    ))
    const think = host.querySelector('[data-variant="think"] [data-disclosure-row]')
    const user = host.querySelector('[data-variant="user"] [data-disclosure-row]')
    expect(think).not.toBeNull()
    expect(user).not.toBeNull()
    const thinkFp = classFingerprint(think as Element)
    const userFp = classFingerprint(user as Element)
    // 逐项相同（左边距/缩进/字体/图标盒/摘要省略全在同一份样式表里）。
    expect(userFp).toEqual(thinkFp)
    // 空值会让上面「相等」变得空洞——先证明指纹里的每一项都真有 class。
    for (const [name, value] of Object.entries(thinkFp)) {
      expect(value, `${name} 应有真实 class（同一套样式表）`).toBeTruthy()
    }
    // 同容器结构：root 形态一致（data-variant 各自不同，其余属性同构）。
    const thinkRoot = host.querySelector('[data-variant="think"]') as Element
    const userRoot = host.querySelector('[data-variant="user"]') as Element
    expect(userRoot.getAttribute('data-state')).toBe(thinkRoot.getAttribute('data-state'))
    expect(userRoot.children.length).toBe(thinkRoot.children.length)
    expect(userRoot.firstElementChild?.tagName).toBe(thinkRoot.firstElementChild?.tagName)
  })

  it('folds and unfolds through the same interaction contract as the think row', () => {
    const host = render(h('div', null,
      h(ReasoningRow, { text: '思考首行', running: false, t }),
      h(StepChatUserMessageView, { data: USER_DATA, renderMessageImages: noImages, t }),
    ))
    for (const variant of ['think', 'user'] as const) {
      const row = host.querySelector(`[data-variant="${variant}"] [data-disclosure-row]`) as HTMLElement
      const root = host.querySelector(`[data-variant="${variant}"]`) as HTMLElement
      expect(row.getAttribute('role'), `${variant} 行应可点开`).toBe('button')
      expect(row.getAttribute('aria-expanded')).toBe('false')
      expect(root.hasAttribute('data-expanded')).toBe(false)
      act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(row.getAttribute('aria-expanded')).toBe('true')
      expect(root.hasAttribute('data-expanded')).toBe(true)
      act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(row.getAttribute('aria-expanded')).toBe('false')
    }
  })
})

describe('需求 2 · 左对齐是硬要求（无右对齐残留）', () => {
  /**
   * 读源码文件（相对本 spec 的目录）并**剥掉注释**——守卫针对代码而不是散文：
   * 注释里正当地写着「不得出现某某写法」这类说明，若把注释算进去就会自相矛盾。
   */
  function readSource(name: string): string {
    const raw = readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')
    return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  }

  const RIGHT_ALIGN_PATTERNS: readonly RegExp[] = [
    /align-self:\s*flex-end/,
    /align-items:\s*flex-end/,
    /justify-content:\s*flex-end/,
    /margin-left:\s*auto/,
    /text-align:\s*right/,
    /float:\s*right/,
  ]

  it('keeps the user row stylesheet free of right-alignment rules', () => {
    const source = readSource('./user-message.module.css')
    for (const pattern of RIGHT_ALIGN_PATTERNS) {
      expect(pattern.test(source), `user-message.module.css 不应含 ${String(pattern)}（左对齐硬要求）`).toBe(false)
    }
    // 历史气泡形态的类不得复活（右对齐列 + 气泡底）。
    expect(source).not.toContain('.bubble')
    expect(source).not.toContain('.userRow')
    expect(source).not.toContain('.userStack')
  })

  it('keeps the shared fold-row shell free of right-alignment rules', () => {
    const shell = readSource('./DisclosureSummaryRow.tsx')
    for (const pattern of RIGHT_ALIGN_PATTERNS) {
      expect(pattern.test(shell), `DisclosureSummaryRow.tsx 不应含 ${String(pattern)}`).toBe(false)
    }
    // 两条行必须共用同一份样式表（class 逐字相同的来源）。
    expect(shell).toContain("from './reasoning-row.module.css'")
  })

  it('keeps the user message view free of right-alignment rules', () => {
    const view = readSource('./UserMessageView.tsx')
    for (const pattern of RIGHT_ALIGN_PATTERNS) {
      expect(pattern.test(view), `UserMessageView.tsx 不应含 ${String(pattern)}`).toBe(false)
    }
    // 图片也不再右对齐（原气泡的 align='end' 已改为 'start'）。
    expect(view).not.toContain("align: 'end'")
    expect(view).toContain("align: 'start'")
  })
})
