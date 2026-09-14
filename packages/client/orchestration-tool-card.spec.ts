/**
 * orchestration-tool-card.spec（@vitest-environment jsdom）：工具行内嵌导航 UI 的渲染契约。
 *
 * 锁四件事：
 * 1. **注册条件**：只有 `sandore_workflow_run` / `sandore_workflow_control` 的工具行渲染导航；
 *    别的工具（含 sandore 自己的 status/send_message）一行 DOM 都不加；
 * 2. **数据装配**：instanceId → store 拉取（fake remote）→ 树渲染出阶段/步骤节点；
 * 3. **折叠交互**：读头整条可点，折叠后卡体从 DOM 消失、再点回来；
 * 4. **实时刷新**：store 收到新快照（SSE/轮询路径的等价触发）后，卡体内容随之更新。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/orchestration-tool-card.spec
 */
// @vitest-environment jsdom
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

// primitives 全部替换为最小行为桩（primitives 产物自带 *.module.css）。
// 注意：vitest 的 mock 校验要求**具名导出真实存在**（Proxy 兜底会被拒），故这里显式列出
// 工具行一族（GenericToolCard 的 variant 图标 + 各卡片块 + TreeNav）真正导入的名字。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement: el, Fragment: F } = await import('react')
  const icon = (label: string) => () => el('svg', { 'data-icon': label, 'aria-hidden': true })
  /** 各卡片块：只渲染文本，够断言结构/文案。 */
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

// SSE 采集器会真的建 EventSource（jsdom 无此实现）——工具行 store 的实时性在本 spec 里
// 由「fake remote 的下一轮解析」驱动，故把 SSE 订阅换成空实现。
vi.mock('./sandore-sse.ts', () => ({
  subscribeSandoreSse: () => () => {},
}))

import { zh } from './locales.ts'
import { OrchestrationToolCard } from './orchestration-tool-card.tsx'
import {
  clearOrchestrationToolStore,
  installOrchestrationToolFaces,
  orchestrationInstanceSnapshot,
  refreshOrchestrationInstance,
} from './orchestration-tool-store.ts'
import { orchestrationToolTargetOf } from './orchestration-tool-model.ts'
import { ToolCallView } from './step-view/tool/ToolCallView.tsx'

/** sandore zh 字典桩翻译（与其它 client spec 同款）。 */
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

/** 一个可推进的实例状态（两次快照：running → completed）。 */
const runningState = {
  taskId: 'inst-tool',
  workflowId: 'wfl-tool',
  workflowName: 'e2e-tool-nav',
  status: 'running',
  originalInput: 'do it',
  currentStageId: 'stg-1',
  stageInfos: [{ id: 'stg-1', name: 'main', status: 'running' }],
  stageContracts: {},
  executedSteps: [
    { id: 'exec-1', stepId: 'step-1', stageId: 'stg-1', name: 'first', status: 'completed', visitCount: 1 },
    { id: 'exec-2', stepId: 'step-2', stageId: 'stg-1', name: 'second', status: 'running', visitCount: 1 },
  ],
  pendingQueue: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
}
const completedState = {
  ...runningState,
  status: 'completed',
  executedSteps: runningState.executedSteps.map(step => ({ ...step, status: 'completed' })),
}

/** 结算的 run 工具块（结果里带 instanceId）。 */
const runBlock = {
  kind: 'tool-result' as const,
  callId: 'call-run',
  call: { name: 'sandore_workflow_run', argsRaw: '{"workflowId":"wfl-tool"}' },
  callTime: null,
  content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { instanceId: 'inst-tool', status: 'running' } }) }],
  isError: false,
  subCalls: [],
}

/** 结算的 pause 工具块（动作在参数里）。 */
const pauseBlock = {
  kind: 'tool-result' as const,
  callId: 'call-pause',
  call: { name: 'sandore_workflow_control', argsRaw: '{"action":"pause","instanceId":"inst-tool"}' },
  callTime: null,
  content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { instanceId: 'inst-tool', action: 'pause' } }) }],
  isError: false,
  subCalls: [],
}

const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
})

beforeEach(() => {
  clearOrchestrationToolStore()
})

/** 挂载一个组件并返回宿主（同一 root 可重渲染）。 */
function mount(element: ReactNode): { host: HTMLElement; render: (next: ReactNode) => void } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  const render = (next: ReactNode): void => { act(() => { root.render(next) }) }
  render(element)
  return { host, render }
}

/** 等到 store 的那次 RPC 落地（fake remote 立刻 resolve，一帧即可）。 */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

describe('OrchestrationToolCard：注册条件（只认我们的工具）', () => {
  it('renders nothing for other tools (no nav DOM at all)', async () => {
    installOrchestrationToolFaces({ remote: { getInstanceState: () => Promise.resolve({ ok: true, value: runningState }) } })
    const { host } = mount(h(ToolCallView, {
      root: { ...runBlock, call: { name: 'bash', argsRaw: '{}' } },
      instanceId: 'inst-tool',
      t,
    }))
    await settle()
    expect(host.querySelector('[data-sandore-tool-nav]')).toBeNull()
    expect(host.querySelector('[data-orchestration-toggle]')).toBeNull()
    // 默认文本结果（GenericToolCard）仍在。
    expect(host.querySelector('[data-chat-call-id="call-run"]')).not.toBeNull()
  })

  it('renders the nav card for sandore_workflow_run and keeps the default tool row', async () => {
    installOrchestrationToolFaces({ remote: { getInstanceState: () => Promise.resolve({ ok: true, value: runningState }) } })
    const { host } = mount(h(ToolCallView, { root: runBlock, instanceId: 'inst-tool', t }))
    await settle()
    const card = host.querySelector('[data-sandore-tool-nav]')
    expect(card).not.toBeNull()
    expect(card?.getAttribute('data-orchestration-tool')).toBe('run')
    expect(card?.getAttribute('data-orchestration-instance')).toBe('inst-tool')
    expect(card?.getAttribute('data-orchestration-instance-source')).toBe('result')
    expect(card?.getAttribute('data-orchestration-status')).toBe('running')
    // 默认工具行仍在（用户要求「除了现在默认的返回外，还要有 UI」）。
    expect(host.querySelector('[data-chat-call-id="call-run"]')).not.toBeNull()
    // 树来自 buildRunTree：阶段 + 两个 step 名称可见。
    expect(host.textContent).toContain('first')
    expect(host.textContent).toContain('second')
    expect(card?.querySelector('[data-sandore-tree-nav]')).not.toBeNull()
    expect(card?.querySelector('[data-tree-nav-compact]')).not.toBeNull()
  })

  it('卡头已显示工作流名 → 树里不再渲染同名根行（用户真机：展开后第一个根节点重复）', async () => {
    installOrchestrationToolFaces({ remote: { getInstanceState: () => Promise.resolve({ ok: true, value: runningState }) } })
    const { host } = mount(h(ToolCallView, { root: runBlock, instanceId: 'inst-tool', t }))
    await settle()
    const card = host.querySelector('[data-sandore-tool-nav]')
    expect(card).not.toBeNull()
    // 读头照旧显示工作流名 + 状态 + 进度（这些是卡片的读数，不能去掉）。
    expect(card?.querySelector('[data-orchestration-title]')?.textContent).toBe('e2e-tool-nav')
    expect(card?.querySelector('[data-orchestration-progress]')).not.toBeNull()
    const tree = card?.querySelector('[data-sandore-tree-nav]')
    expect(tree).not.toBeNull()
    // 根行换成它原本给 Stage 行用的容器（保留缩进/留白），不再有同名 workflow 行。
    expect(tree?.querySelector('[data-tree-workflow-children]')).not.toBeNull()
    expect(tree?.textContent).toContain('main')
    // 工作流名在这张卡里**只出现一次**（= 读头那一处；树里那份重复已消失）。
    const occurrences = (card?.textContent ?? '').split('e2e-tool-nav').length - 1
    expect(occurrences).toBe(1)
  })

  it('renders the pause action chip for sandore_workflow_control', async () => {
    installOrchestrationToolFaces({ remote: { getInstanceState: () => Promise.resolve({ ok: true, value: runningState }) } })
    const { host } = mount(h(ToolCallView, { root: pauseBlock, instanceId: 'inst-tool', t }))
    await settle()
    const card = host.querySelector('[data-sandore-tool-nav]')
    expect(card?.getAttribute('data-orchestration-tool')).toBe('control')
    expect(card?.getAttribute('data-orchestration-action')).toBe('pause')
    expect(card?.querySelector('[data-orchestration-action-chip]')?.textContent).toBe('暂停')
  })

  it('control without an explicit instanceId falls back to the panel session id', async () => {
    installOrchestrationToolFaces({ remote: { getInstanceState: () => Promise.resolve({ ok: true, value: runningState }) } })
    // 运行中的 control 调用（还没结果 → 结果里读不到 instanceId，且参数没传）。
    const block = {
      callId: 'call-pause-running',
      name: 'sandore_workflow_control',
      argsRaw: '{"action":"pause"}',
      subCalls: [],
    }
    const { host } = mount(h(ToolCallView, { root: block, instanceId: 'inst-from-session', t }))
    await settle()
    const card = host.querySelector('[data-sandore-tool-nav]')
    expect(card?.getAttribute('data-orchestration-instance')).toBe('inst-from-session')
    expect(card?.getAttribute('data-orchestration-instance-source')).toBe('session')
  })
})

describe('OrchestrationToolCard：折叠与实时刷新', () => {
  it('collapses and expands from the whole head row', async () => {
    installOrchestrationToolFaces({ remote: { getInstanceState: () => Promise.resolve({ ok: true, value: runningState }) } })
    const target = orchestrationToolTargetOf(runBlock, 'inst-tool')!
    const { host } = mount(h(OrchestrationToolCard, { target, t }))
    await settle()
    const toggle = (): Element | null => host.querySelector('[data-orchestration-toggle]')
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('[data-orchestration-body]')).not.toBeNull()
    act(() => { (toggle() as HTMLElement).click() })
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('[data-orchestration-body]')).toBeNull()
    // 折叠态读头仍在（进度读数保持在读头里）。
    expect(host.querySelector('[data-orchestration-progress]')?.textContent).toBe('1/2 步')
    act(() => { (toggle() as HTMLElement).click() })
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('[data-orchestration-body]')).not.toBeNull()
  })

  it('refreshes the tree when a newer snapshot arrives (SSE/poll path)', async () => {
    let state: unknown = runningState
    installOrchestrationToolFaces({ remote: { getInstanceState: () => Promise.resolve({ ok: true, value: state }) } })
    const target = orchestrationToolTargetOf(runBlock, 'inst-tool')!
    const { host, render } = mount(h(OrchestrationToolCard, { target, t }))
    await settle()
    const card = host.querySelector('[data-sandore-tool-nav]')
    expect(card?.getAttribute('data-orchestration-status')).toBe('running')
    expect(host.querySelector('[data-orchestration-progress]')?.textContent).toBe('1/2 步')

    // 实例推进 → 触发一次刷新（与 SSE 事件去抖后走的是同一个 refresh 函数）。
    state = completedState
    await act(async () => { await refreshOrchestrationInstance('inst-tool') })
    await settle()
    expect(orchestrationInstanceSnapshot('inst-tool')?.kind).toBe('ready')
    render(h(OrchestrationToolCard, { target, t }))
    await settle()
    expect(host.querySelector('[data-sandore-tool-nav]')?.getAttribute('data-orchestration-status')).toBe('completed')
    expect(host.querySelector('[data-orchestration-progress]')?.textContent).toBe('2/2 步')
  })

  it('shows the error state without throwing when the state RPC fails', async () => {
    installOrchestrationToolFaces({
      remote: { getInstanceState: () => Promise.resolve({ ok: false, error: { message: 'boom' } }) },
    })
    const target = orchestrationToolTargetOf(runBlock, 'inst-tool')!
    const { host } = mount(h(OrchestrationToolCard, { target, t }))
    await settle()
    expect(host.querySelector('[data-orchestration-error]')?.textContent).toContain('boom')
    expect(host.querySelector('[data-sandore-tree-nav]')).toBeNull()
  })
})
