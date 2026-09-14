/**
 * orchestration-tool-view.spec（@vitest-environment jsdom）：**DSH 原生工具行**的注册契约。
 *
 * 锁三件事：
 * 1. **注册面**：只往 `tool.call.toolview` 注册我们两个 wire 工具名（run / control），
 *    并带 `locale: 'sandore'`（DSH 据此给视图补 `t`）；
 * 2. **渲染面**：用 DSH `ToolCallOwnerProps` 形状的 props 渲染出的视图里，**默认结果行仍在**
 *    （命中 key 会替换通用卡片，所以视图必须自带）+ 导航卡出现；
 * 3. **不越界**：工具名/形状不匹配时只渲染默认结果，不渲染导航。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/orchestration-tool-view.spec
 */
// @vitest-environment jsdom
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement: el, Fragment: F } = await import('react')
  const icon = (label: string) => () => el('svg', { 'data-icon': label, 'aria-hidden': true })
  const block = (label: string) => (props: { text?: string; children?: ReactNode }) =>
    el('div', { 'data-block': label }, props.text ?? props.children)
  return {
    StateDot: (props: { state?: string }) => el('span', { 'data-state-dot': props.state ?? '' }),
    MarkdownText: (props: { text?: string }) => el('p', null, props.text),
    ReferenceIcon: () => el('span'),
    Tooltip: (props: { children?: ReactNode }) => el(F, null, props.children),
    DisclosureRow: (props: { children?: ReactNode }) => el('div', null, props.children),
    CodeBlock: block('code'),
    DiffBlock: block('diff'),
    ReadBlock: block('read'),
    SearchBlock: block('search'),
    TerminalBlock: block('terminal'),
    WebBlock: block('web'),
    IconApiOutline14: icon('api'),
    IconBrowseOutline16: icon('browse'),
    IconCodeOutline16: icon('code'),
    IconEditOutline16: icon('edit'),
    IconSearchOutline16: icon('search'),
    IconSparkle16: icon('sparkle'),
    IconChevronDownOutline14: icon('chevron-down'),
    IconChevronRightOutline14: icon('chevron-right'),
  }
})

vi.mock('./sandore-sse.ts', () => ({
  subscribeSandoreSse: () => () => {},
}))

import { zh } from './locales.ts'
import { clearOrchestrationToolStore, installOrchestrationToolFaces } from './orchestration-tool-store.ts'
import { registerOrchestrationToolViews } from './orchestration-tool-view.tsx'

/** 记录注册内容的最小 slots 桩（`inject` 立即执行回调；生成器按 cordis 语义逐个消费）。 */
function fakeSlots(): {
  readonly registered: { readonly options: Record<string, unknown>; readonly component: unknown }[]
  readonly disposers: unknown[]
  readonly ctx: { readonly slots: { inject: (name: string, cb: () => unknown) => void; register: (options: Record<string, unknown>, component: unknown) => unknown } }
} {
  const registered: { options: Record<string, unknown>; component: unknown }[] = []
  const disposers: unknown[] = []
  const slots = {
    inject: (_name: string, cb: () => unknown): void => {
      const produced = cb()
      // DSH 的既有写法是 `inject(name, function* () { yield register(...) })`：cordis 会把
      // 生成器**逐个 yield 消费**并收集 disposer——桩必须同样消费，否则注册体根本不执行。
      if (produced !== null && typeof produced === 'object'
        && typeof (produced as Iterable<unknown>)[Symbol.iterator] === 'function') {
        for (const disposer of produced as Iterable<unknown>) disposers.push(disposer)
      }
    },
    register: (options: Record<string, unknown>, component: unknown): unknown => {
      registered.push({ options, component })
      return () => {}
    },
  }
  return { registered, disposers, ctx: { slots } }
}

/** sandore zh 字典桩翻译。 */
const t = ((key: string, params?: Record<string, unknown>): string => {
  let text = (zh as unknown as Record<string, string>)[key] ?? key
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}) as never

/** 与 DSH `ToolResultNode` 同形的 block（`call.argsRaw` + `content` 文本块）。 */
const dshRunBlock = {
  kind: 'tool-result' as const,
  seq: 1,
  callId: 'call-run-dsh',
  call: { name: 'sandore_workflow_run', argsRaw: '{"workflowId":"wfl-tool"}' },
  callTime: 0,
  content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { instanceId: 'inst-dsh', status: 'running' } }) }],
  isError: false,
  subCalls: [],
}

/** 实例状态（供 store 拉取）。 */
const state = {
  taskId: 'inst-dsh',
  workflowId: 'wfl-tool',
  workflowName: 'e2e-dsh-session',
  status: 'running',
  originalInput: 'do it',
  currentStageId: 'stg-1',
  stageInfos: [{ id: 'stg-1', name: 'main', status: 'running' }],
  stageContracts: {},
  executedSteps: [
    { id: 'exec-1', stepId: 'step-1', stageId: 'stg-1', name: 'first', status: 'running', visitCount: 1 },
  ],
  pendingQueue: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
}

const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
})

beforeEach(() => {
  clearOrchestrationToolStore()
  installOrchestrationToolFaces({ remote: { getInstanceState: () => Promise.resolve({ ok: true, value: state }) } })
})

/** 挂载被注册的视图组件。 */
function mountView(component: unknown, props: Record<string, unknown>): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  const View = component as (p: Record<string, unknown>) => ReactNode
  act(() => { root.render(h(View, props)) })
  return host
}

describe('DSH 工具行视图注册（tool.call.toolview）', () => {
  it('registers exactly our two wire tool names with the sandore locale', () => {
    const { registered, ctx } = fakeSlots()
    registerOrchestrationToolViews(ctx as never)
    expect(registered.map(entry => entry.options['name'])).toEqual(['tool.call.toolview', 'tool.call.toolview'])
    expect(registered.map(entry => entry.options['key'])).toEqual(['sandore_workflow_run', 'sandore_workflow_control'])
    for (const entry of registered) expect(entry.options['locale']).toBe('sandore')
    expect(registered.every(entry => typeof entry.component === 'function')).toBe(true)
  })

  it('renders the default tool row AND the nav card for a DSH-shaped run call', async () => {
    const { registered, ctx } = fakeSlots()
    registerOrchestrationToolViews(ctx as never)
    const host = mountView(registered[0]!.component, {
      callId: 'call-run-dsh',
      toolName: 'sandore_workflow_run',
      block: dshRunBlock,
      t,
    })
    // 默认结果行（ToolRow，data-tool = wire 名）：命中 key 会替换 DSH 的通用卡片 →
    // 视图必须自带，否则「默认返回」在 DSH 会话页里会消失。
    expect(host.querySelector('[data-tool="sandore_workflow_run"]')).not.toBeNull()
    await act(async () => { await Promise.resolve() })
    const card = host.querySelector('[data-sandore-tool-nav]')
    expect(card).not.toBeNull()
    expect(card?.getAttribute('data-orchestration-tool')).toBe('run')
    expect(card?.getAttribute('data-orchestration-instance')).toBe('inst-dsh')
    expect(card?.getAttribute('data-orchestration-status')).toBe('running')
    expect(card?.querySelector('[data-sandore-tree-nav]')).not.toBeNull()
    expect(host.textContent).toContain('first')
  })

  it('renders only the default row when the block has no instanceId (never guesses)', () => {
    const { registered, ctx } = fakeSlots()
    registerOrchestrationToolViews(ctx as never)
    const host = mountView(registered[0]!.component, {
      callId: 'call-run-dsh',
      toolName: 'sandore_workflow_run',
      // 结果里没有 instanceId，且 DSH 侧也拿不到面板会话兜底 → 不渲染导航。
      block: { ...dshRunBlock, content: [{ type: 'text', text: '{"ok":true}' }] },
      t,
    })
    expect(host.querySelector('[data-tool="sandore_workflow_run"]')).not.toBeNull()
    expect(host.querySelector('[data-sandore-tool-nav]')).toBeNull()
  })

  it('renders the control card with its action chip for a DSH-shaped pause call', async () => {
    const { registered, ctx } = fakeSlots()
    registerOrchestrationToolViews(ctx as never)
    const host = mountView(registered[1]!.component, {
      callId: 'call-pause-dsh',
      toolName: 'sandore_workflow_control',
      block: {
        ...dshRunBlock,
        callId: 'call-pause-dsh',
        call: { name: 'sandore_workflow_control', argsRaw: '{"action":"pause"}' },
        content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { instanceId: 'inst-dsh', action: 'pause' } }) }],
      },
      t,
    })
    expect(host.querySelector('[data-tool="sandore_workflow_control"]')).not.toBeNull()
    await act(async () => { await Promise.resolve() })
    const card = host.querySelector('[data-sandore-tool-nav]')
    expect(card?.getAttribute('data-orchestration-tool')).toBe('control')
    expect(card?.getAttribute('data-orchestration-action')).toBe('pause')
    expect(card?.querySelector('[data-orchestration-action-chip]')?.textContent).toBe('暂停')
  })
})
