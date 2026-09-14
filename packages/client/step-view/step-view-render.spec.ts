/**
 * step-view-render.spec：B2a 最小行渲染冒烟（@vitest-environment jsdom +
 * react-dom/client）——锁定 user/assistant 行能真实挂载且包含关键文案（行组件
 * 不抛、空态/流式标记的 DOM 面正确）。仅渲染断言，不测视觉。
 *
 * 说明（成本/收益权衡）：jsdom 无法做真实排版断言；CSS module 在 vitest 默认
 * css:false 下被置空，因此这里只验证组件树与文案，不改 CSS 行为。若未来需要
 * 快照/布局级测试，应走 playwright（仓库已有 devDep）而不是 jsdom。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/step-view-render.spec
 */
// @vitest-environment jsdom
// React 18 需要显式声明 act 环境（否则每个 act 调用打 warning）。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

// primitives 的发布产物 lib 自带 *.module.css import，vitest 默认外置 node_modules
// 不处理 CSS → 直接加载会报 Unknown file extension ".css"。行渲染冒烟只验组件树与
// 文案，故在测试内把 primitives 全部替换为最小行为桩（视觉由真实宿主 + CSS 承担，
// 本测试不做视觉断言；若日后需要真实排版级验证走 playwright，而非此桩）。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement: el, Fragment } = await import('react')
  const icon = (label: string) => (props: { size?: number }) => el('svg', { 'data-icon': label, 'aria-hidden': true, ...(props?.size === undefined ? {} : { width: props.size, height: props.size }) })
  return {
    // 结构对齐真实 DisclosureRow（root[data-open] > row[data-disclosure-row] > leading +
    // title + collapsedContent，展开体在 row 之后）；class 归属透传（真实 primitive 的
    // `clsx(css.root, rowClassName)` 同职责）——「用户消息行与思考行同一套 class」的
    // jsdom 断言据此比较真实 class 字符串。
    DisclosureRow: (props: {
      icon?: ReactNode
      title?: ReactNode
      open?: boolean
      expandable?: boolean
      expandOnRowClick?: boolean
      keepContentWhenOpen?: boolean
      collapsedContent?: ReactNode
      children?: ReactNode
      rowClassName?: string
      titleClassName?: string
      leadingClassName?: string
      onToggle?: () => void
    }) => el('div', { 'data-open': props.open === true || undefined },
      el('div', {
        'data-disclosure-row': true,
        role: props.expandable === true ? 'button' : undefined,
        'aria-expanded': props.expandable === true ? props.open === true : undefined,
        className: props.rowClassName,
        onClick: props.expandOnRowClick === true ? props.onToggle : undefined,
      },
      el('span', { className: props.leadingClassName, 'data-leading': true }, props.icon),
      el('span', { className: props.titleClassName }, props.title),
      (props.keepContentWhenOpen === true || !props.open) ? props.collapsedContent : null),
      props.open === true ? props.children : null),
    MarkdownText: (props: { text?: string }) => el('p', { 'data-markdown': true }, props.text),
    JsonBlock: (props: { label?: ReactNode; payload?: unknown }) => el('div', null, props.label, JSON.stringify(props.payload)),
    projectUserText: (text?: string) => el('span', null, text),
    ReferenceIcon: (props: { kind?: string }) => el('span', { 'data-reference-icon': props.kind }),
    Tooltip: (props: { children?: ReactNode }) => el(Fragment, null, props.children),
    writeClipboard: async () => true,
    StateDot: (props: { state?: string; className?: string }) => el('span', { 'data-state-dot': props.state }),
    CodeBlock: (props: { code?: string }) => el('pre', { 'data-block': 'code' }, props.code),
    TerminalBlock: (props: Record<string, unknown>) => el('div', { 'data-block': 'terminal' }, String(props.output ?? '')),
    DiffBlock: () => el('div', { 'data-block': 'diff' }),
    ReadBlock: () => el('div', { 'data-block': 'read' }),
    SearchBlock: () => el('div', { 'data-block': 'search' }),
    WebBlock: () => el('div', { 'data-block': 'web' }),
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
import { StepChatUserMessageView } from './UserMessageView.tsx'
import { StepChatAssistantStepView } from './AssistantStepView.tsx'
import { StepChatSystemPromptView } from './SystemPromptRow.tsx'
import { StepChatContextView } from './ContextInjectionRow.tsx'
import { StepChatCompactionView } from './CompactionItem.tsx'
import { StepChatCommandView, StepChatManualCompactionView } from './CommandCard.tsx'
import {
  StepChatModelRetryView, StepChatTurnErrorView, StepChatTurnMaxTokensView,
  StepChatUnknownView,
} from './NoticeRow.tsx'
import { StepChatToolCallView } from './tool/ToolCallView.tsx'
import { StepChatTurnTailView } from './TurnTailNodeView.tsx'
import { StepChatTurnProcessView } from './TurnProcessNodeView.tsx'

/** sandore zh 字典桩翻译：普通键取字典值，带参键做 {param} 插值。 */
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
  // createRoot 的并发调度需要在 act 内 flush（否则断言可能跑在 commit 前）。
  act(() => { root.render(element) })
  return host
}

describe('step-view row render smoke（jsdom）', () => {
  it('renders a user fold row: 用户消息 title + first-line summary, full text on expand', () => {
    const host = render(h(StepChatUserMessageView, {
      data: {
        kind: 'user',
        seq: 1,
        time: 1_700_000_000_000,
        content: [{ type: 'text', text: '你好，先分析一下\n第二行不应出现在折叠摘要里' }],
        source: { kind: 'user' },
        referenceLabels: ['会话A', '会话B'],
      },
      renderMessageImages: noImages,
      t,
    }))
    // 折叠行（需求 2）：标题「用户消息」+ 首行摘要，第二行不外泄到折叠态。
    const root = host.querySelector('[data-variant="user"]')
    expect(root).not.toBeNull()
    expect(host.textContent ?? '').toContain('用户消息')
    expect(host.textContent ?? '').toContain('你好，先分析一下')
    expect(host.textContent ?? '').not.toContain('第二行不应出现在折叠摘要里')
    expect(host.querySelector('[data-open]')).toBeNull() // 默认折叠
    // 展开 → 完整消息 + 引用会话摘要 + 时钟/复制动作都在展开体里。
    act(() => {
      host.querySelector('[data-disclosure-row]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    const text = host.textContent ?? ''
    expect(text).toContain('第二行不应出现在折叠摘要里')
    expect(text).toContain('引用会话')
    expect(text).toContain('会话A')
    expect(text).toContain('会话B')
    // 时钟存在（HH:mm 或日期模板——time 落在 2023 年，非今天 → 带日期）
    expect(text).toMatch(/\d{2}:\d{2}/)
  })

  it('renders the user fold row collapsed by default and folds back on a second click', () => {
    const host = render(h(StepChatUserMessageView, {
      data: { kind: 'user', seq: 1, time: 9, content: [{ type: 'text', text: '只此一行' }] },
      renderMessageImages: noImages,
      t,
    }))
    const collapsedRow = host.querySelector('[data-disclosure-row]')
    expect(collapsedRow).not.toBeNull()
    expect(host.querySelector('[data-open]')).toBeNull() // 折叠：没有展开体
    expect(host.textContent ?? '').not.toContain('引用会话')
    act(() => { collapsedRow?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const expandedRow = host.querySelector('[data-disclosure-row]')
    expect(expandedRow?.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('[data-open]')).not.toBeNull()
    act(() => { expandedRow?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(host.querySelector('[data-open]')).toBeNull()
  })

  it('renders a streaming assistant row: think summary + markdown text, no crash', () => {
    const host = render(h(StepChatAssistantStepView, {
      data: {
        status: 'running',
        turn: 1,
        step: 2,
        time: 9,
        // reasoning 必须是末块才有 running 尾块标记（rc.1：i === last）
        blocks: [
          { kind: 'text', text: '**加粗**与正文' },
          { kind: 'reasoning', text: '第一步推理\n第二行' },
          { kind: 'tool-call', callId: 'c1', name: 'bash', argsRaw: '[]' },
          { kind: 'reasoning', text: '流式推理尾部' },
        ],
      },
      renderMessageImages: noImages,
      t,
    }))
    const text = host.textContent ?? ''
    expect(text).toContain('思考') // think 行标题
    expect(text).toContain('运行中') // running 尾块 aria 标记
    // streaming reasoning 摘要跟随最新一行（rc.1 latestLine：末行摘要）
    expect(text).toContain('流式推理尾部')
    // 首个 reasoning（非末块）折叠摘要取首行（rc.1 firstLine）
    expect(text).toContain('第一步推理')
    expect(text).toContain('加粗') // markdown 文本已渲染
    expect(text).toContain('与正文')
  })

  it('renders an interrupted assistant row with the stopped marker', () => {
    const host = render(h(StepChatAssistantStepView, {
      data: {
        status: 'interrupted',
        turn: 2,
        step: 1,
        time: 9,
        blocks: [{ kind: 'text', text: '写到一半' }],
      },
      renderMessageImages: noImages,
      t,
    }))
    expect(host.textContent).toContain('写到一半')
    expect(host.textContent).toContain('已停止')
  })

  it('renders a system-prompt disclosure row (collapsed) with its title', () => {
    const host = render(h(StepChatSystemPromptView, {
      data: { text: '你是工作流编排助手。' },
      t,
    }))
    expect(host.textContent).toContain('系统提示词')
  })

  it('renders an injected context row with producer label', () => {
    const host = render(h(StepChatContextView, {
      data: {
        kind: 'context',
        seq: 3,
        time: 9,
        content: [{ type: 'text', text: 'rules' }],
        source: { kind: 'plugin', plugin: 'skills' },
        provenance: { role: 'inject', label: 'skills' },
        form: null,
      },
      t,
    }))
    const text = host.textContent ?? ''
    expect(text).toContain('上下文注入')
    expect(text).toContain('skills')
  })

  it('does not throw on malformed payloads (empty-state rows)', () => {
    const host = render(h('div', null,
      h(StepChatUserMessageView, { data: undefined, renderMessageImages: noImages, t }),
      h(StepChatAssistantStepView, { data: { blocks: [{ kind: 'tool-call' }] }, renderMessageImages: noImages, t }),
      h(StepChatSystemPromptView, { data: undefined, t }),
      h(StepChatContextView, { data: { form: 'future-form' }, t }),
    ))
    expect(host.textContent ?? '').not.toContain('undefined')
  })
})

describe('B2b notice-row render smoke（compaction / command / retry / turn rows）', () => {
  it('renders a compaction marker with counts; a summary-less marker is unavailable', () => {
    const host = render(h('div', null,
      h(StepChatCompactionView, {
        data: { kind: 'compaction', seq: 1, summary: '**摘要**', summaryEventSeq: 1, shadowedItemCount: 41, shadowedTokenCount: 12000 },
        t,
      }),
      h(StepChatCompactionView, { data: { kind: 'compaction', seq: 2, summary: null, summaryEventSeq: null, shadowedItemCount: null, shadowedTokenCount: null }, t }),
    ))
    const text = host.textContent ?? ''
    expect(text).toContain('上下文已压缩')
    expect(text).toContain('已压缩 41 条历史记录（约 12000 tokens）')
    expect(text).toContain('压缩摘要不可用')
  })

  it('renders a manual-compaction /compact marker with command title and running copy', () => {
    const checkpoint = render(h(StepChatManualCompactionView, {
      data: {
        command: { kind: 'command', seq: 1, name: 'compact', outcome: { kind: 'success', text: 'ok' } },
        compaction: { kind: 'compaction', seq: 2, summary: null, shadowedItemCount: null, shadowedTokenCount: null },
      },
      t,
    }))
    expect(checkpoint.textContent ?? '').toContain('compact')
    const running = render(h(StepChatManualCompactionView, {
      data: { command: { kind: 'command', seq: 3, name: 'compact', outcome: null }, compaction: null },
      t,
    }))
    expect(running.textContent ?? '').toContain('正在压缩…')
  })

  it('renders a running command card and a settled command with multiline outcome text', () => {
    const running = render(h(StepChatCommandView, {
      data: { kind: 'command', seq: 1, name: 'approve', args: '', outcome: null },
      t,
    }))
    const runningText = running.textContent ?? ''
    expect(runningText).toContain('approve')
    expect(runningText).toContain('执行中')
    const settled = render(h(StepChatCommandView, {
      data: {
        kind: 'command', seq: 2, name: null, args: null,
        outcome: { kind: 'error', text: '第一行失败原因\n第二行细节' },
      },
      t,
    }))
    const settledText = settled.textContent ?? ''
    expect(settledText).toContain('命令') // 无 run 侧名字 → 通用标题
    expect(settledText).toContain('第一行失败原因')
    expect(settledText).toContain('第二行细节')
  })

  it('renders a cancelled model-retry row with its failure details collapsed', () => {
    const host = render(h(StepChatModelRetryView, {
      data: {
        attempts: [],
        current: { retryState: 'cancelled', mode: 'normal', retry: 2, maxRetries: 3, delayMs: 5000, failure: { message: 'rate limited' } },
      },
      t,
    }))
    const text = host.textContent ?? ''
    expect(text).toContain('模型请求重试已取消')
    expect(text).toContain('（2/3）')
    expect(text).toContain('5s')
  })

  it('renders turn-error with message and code, and the max-tokens notice', () => {
    const error = render(h(StepChatTurnErrorView, {
      data: { kind: 'turn-error', seq: 1, turn: 2, step: 1, message: 'connection reset', code: 'E-42' },
      t,
    }))
    const errorText = error.textContent ?? ''
    expect(errorText).toContain('本轮运行失败')
    expect(errorText).toContain('connection reset')
    expect(errorText).toContain('E-42')
    const maxTokens = render(h(StepChatTurnMaxTokensView, {
      data: { kind: 'turn-max-tokens', seq: 2, turn: 2, step: 1 },
      t,
    }))
    const maxTokensText = maxTokens.textContent ?? ''
    expect(maxTokensText).toContain('已达到输出 token 上限')
    expect(maxTokensText).toContain('“继续”')
  })

  it('renders an unknown node as a JsonBlock row labelled with its surface type', () => {
    const host = render(h(StepChatUnknownView, {
      data: { kind: 'unknown', seq: 1, type: 'future/event', data: { hello: 1 } },
      t,
    }))
    const text = host.textContent ?? ''
    expect(text).toContain('未知 surface 事件：future/event')
    expect(text).toContain('{"hello":1}')
  })
})

describe('B2b tool-call row render smoke', () => {
  it('renders a running bash row with its title/summary and nested read subcall', () => {
    const host = render(h(StepChatToolCallView, {
      data: {
        root: {
          callId: 'root-1', name: 'bash', argsRaw: '{"description":"list files","command":"ls"}',
          turn: 1, step: 1, time: 1,
          subCalls: [
            { callId: 'child-1', parentCallId: 'root-1', name: 'read', argsRaw: '{"file_path":"a.ts"}', turn: 1, step: 1, time: 2, subCalls: [] },
          ],
        },
      },
      t,
    }))
    const text = host.textContent ?? ''
    expect(text).toContain('Bash') // variant 标题
    expect(text).toContain('list files') // bash 摘要来自 description
    expect(text).toContain('读取') // 子调用 read 行（递归渲染；zh 标题）
    expect(text).toContain('a.ts')
    expect(host.querySelectorAll('[data-subcalls]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-chat-call-id]')).toHaveLength(2)
  })

  it('renders a settled failed tool row whose collapsed summary is the failure first line', () => {
    const host = render(h(StepChatToolCallView, {
      data: {
        root: {
          kind: 'tool-result', seq: 9, time: 2, callId: 'root-1',
          call: { name: 'bash', argsRaw: '{"command":"ls"}' }, callTime: 1,
          content: [{ type: 'text', text: 'Error: boom\nsecond line' }],
          isError: true, error: { name: 'ToolError', code: 'boom' },
          subCalls: [],
        },
      },
      t,
    }))
    const text = host.textContent ?? ''
    expect(text).toContain('Bash')
    expect(text).toContain('Error: boom') // 折叠摘要 = 结果首行
    expect(text).toContain('失败') // 视觉隐藏运行态标签
  })

  it('renders a settled read row with terminal card material untouched by garbage meta', () => {
    // read 卡需要结算+合法 meta+信封文本；缺其一 → 通用行仍成立（不抛）。
    const host = render(h(StepChatToolCallView, {
      data: {
        root: {
          kind: 'tool-result', seq: 10, time: 3, callId: 'read-1',
          call: { name: 'read', argsRaw: '{"file_path":"C:/repo/a.ts"}' }, callTime: 1,
          content: [{ type: 'text', text: '<path>C:/repo/a.ts</path>\n<type>file</type>\n<content>\nline\n</content>' }],
          isError: false, meta: null, subCalls: [],
        },
      },
      t,
    }))
    const text = host.textContent ?? ''
    expect(text).toContain('读取')
    expect(text).toContain('a.ts') // 路径摘要（Windows 直通、相对工作区显示）
    expect(text).not.toContain('undefined')
  })

  it('does not throw on malformed tool payloads (empty row)', () => {
    const host = render(h('div', null,
      h(StepChatToolCallView, { data: undefined, t }),
      h(StepChatToolCallView, { data: { root: { callId: 5 } }, t }),
      h(StepChatToolCallView, { data: { root: { callId: 'r', name: 'bash', subCalls: [null] } }, t }),
    ))
    expect(host.textContent ?? '').not.toContain('undefined')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// B3：turn-tail / turn-process / assistant 内联推理的行渲染冒烟
// （与 B2 相同策略：只断言组件树与文案，视觉由真实宿主 + CSS 承担）。
// ══════════════════════════════════════════════════════════════════════════════

describe('B3 turn-tail row render smoke', () => {
  const tailData = {
    turn: 3,
    seq: 88,
    time: 1_700_000_000_000,
    branchUnavailable: false,
    closing: {
      status: 'settled', turn: 3, step: 2, time: 1_700_000_000_000,
      blocks: [
        { kind: 'text', text: '完成正文' },
        { kind: 'reasoning', text: '思考过程' },
      ],
      finalNode: { seq: 80, messageId: 'm-1' },
    },
    ttftMs: 120,
    tokensPerSecond: 24.5,
    tokenUsage: {
      totalTokens: 12_200, uncachedInputTokens: 200, outputTokens: 12_000,
    },
  }
  const runMs = 90_000 // 1.5 min

  it('renders the copy action, clock, usage pill and ran-for duration', () => {
    const host = render(h(StepChatTurnTailView, {
      data: tailData,
      reveal: 'always',
      runMs,
      hasLaterNode: false,
      onBranch: () => {},
      t,
    }))
    const text = host.textContent ?? ''
    // 复制按钮存在（copy 载荷 = closing 文本块拼接，不进可见文本；reasoning 不入载荷）
    expect(host.querySelector('[aria-label="复制"]')).not.toBeNull()
    expect(text).not.toContain('思考过程')
    // 用量药丸：12.2K → 紧凑 token（rc.1 formatTokens + turnUsage 模板）
    expect(text).toContain('用量 12.2K tok')
    // 时长药丸：90s = 1分30秒（rc.1 formatRunDuration）
    expect(text).toContain('用时 1分30秒')
    // 时钟（HH:mm 或日期模板）
    expect(text).toMatch(/\d{2}:\d{2}/)
    // rc.1 root 数据属性
    expect(host.querySelector('[data-turn-tail="3"]')).not.toBeNull()
    expect(host.querySelector('[data-actions-reveal="always"]')).not.toBeNull()
  })

  it('shows no stat pills when usage/runMs are absent and no branch when closing lacks finalNode', () => {
    const host = render(h(StepChatTurnTailView, {
      data: { ...tailData, tokenUsage: undefined },
      reveal: 'hover',
      runMs: undefined,
      hasLaterNode: true,
      onBranch: () => {},
      t,
    }))
    const text = host.textContent ?? ''
    expect(text).not.toContain('用量')
    expect(text).not.toContain('用时')
    // hasLaterNode → branch 显式不可用（aria-disabled）
    const branch = host.querySelector('[aria-label="在新对话中分支"]')
    expect(branch).not.toBeNull()
    expect(branch?.getAttribute('aria-disabled')).toBe('true')
    // 无 finalNode 的 closing → 行不渲染（rc.1 无槽注入时无动作行）
    const bare = render(h(StepChatTurnTailView, {
      data: { ...tailData, closing: { ...tailData.closing, finalNode: undefined } },
      reveal: 'always', runMs: undefined, hasLaterNode: false,
      onBranch: () => {},
      t,
    }))
    expect(bare.textContent ?? '').toBe('')
    expect(bare.querySelector('[data-turn-tail]')).toBeNull()
  })

  it('forks through onBranch at the closing finalNode seq', () => {
    const onBranch = vi.fn()
    const host = render(h(StepChatTurnTailView, {
      data: tailData,
      reveal: 'always',
      runMs: undefined,
      hasLaterNode: false,
      onBranch,
      t,
    }))
    const branch = host.querySelector('[aria-label="在新对话中分支"]')
    expect(branch).not.toBeNull()
    act(() => {
      branch?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onBranch).toHaveBeenCalledWith(80)
  })
})

describe('B3 turn-process disclosure render smoke', () => {
  const processData = {
    turn: 3,
    controlAnchorSeq: 10,
    processStartSeq: 10,
    answerAnchorSeq: 40,
    answerStep: 2,
    inlineReasoning: true,
    messageCount: 2,
    toolCallCount: 1,
    subagentCount: 1,
  }

  it('renders the folded disclosure header with rc.1 count labels and chevron', () => {
    const host = render(h('div', null,
      h(StepChatTurnProcessView, { data: processData, open: false, onToggle: () => {}, t }),
    ))
    const text = host.textContent ?? ''
    expect(text).toContain('1 次工具调用')
    expect(text).toContain('2 条消息')
    expect(text).toContain('1 个 subagent')
    const button = host.querySelector('button[data-turn-process="3"]')
    expect(button).not.toBeNull()
    expect(button?.getAttribute('aria-expanded')).toBe('false')
    expect(button?.hasAttribute('data-open')).toBe(false)
    expect(host.querySelector('[data-icon="chevron-down"]')).not.toBeNull()
  })

  it('falls back to the thought-for-a-while label and toggles open on click', () => {
    function ProcessHarness() {
      const [open, setOpen] = useState(false)
      return h(StepChatTurnProcessView, {
        data: { ...processData, messageCount: 0, toolCallCount: 0, subagentCount: 0 },
        open,
        onToggle: setOpen,
        t,
      })
    }
    const host = render(h(ProcessHarness))
    expect(host.textContent ?? '').toContain('已思考')
    const button = host.querySelector('button[data-turn-process="3"]')
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(button?.getAttribute('aria-expanded')).toBe('true')
    expect(button?.hasAttribute('data-open')).toBe(true)
  })
})

describe('B3 assistant inline reasoning fold（data-turn-process-inline）', () => {
  const assistantData = {
    status: 'settled', turn: 3, step: 2, time: 9,
    blocks: [
      { kind: 'text', text: '最终答复' },
      { kind: 'reasoning', text: '隐藏的推理' },
    ],
  }

  function ReasoningHarness() {
    const [open, setOpen] = useState(false)
    return h('div', null,
      h('button', {
        'data-testid': 'open-process',
        onClick: () => { setOpen(true) },
      }, '打开进程'),
      h(StepChatAssistantStepView, {
        data: assistantData,
        renderMessageImages: noImages,
        reasoningHidden: !open,
        revealProcess: () => { setOpen(true) },
        t,
      }),
    )
  }

  it('hides the reasoning block while the process fold is closed and reveals on open', () => {
    const host = render(h(ReasoningHarness))
    // 折叠中：reasoning 块包 data-turn-process-inline + searchable hidden
    const wrapper = host.querySelector('[data-turn-process-inline]')
    expect(wrapper).not.toBeNull()
    expect(wrapper?.getAttribute('hidden')).toBe('until-found')
    // 正文（text 块）仍在
    expect(host.textContent ?? '').toContain('最终答复')
    // 展开进程 → reasoning 回显
    act(() => {
      host.querySelector('[data-testid="open-process"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    expect(host.querySelector('[data-turn-process-inline]')).toBeNull()
    expect(wrapper?.getAttribute('hidden')).toBeNull()
  })
})
