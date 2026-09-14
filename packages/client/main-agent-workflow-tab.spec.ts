// @vitest-environment jsdom
/**
 * main-agent-workflow-tab.spec（jsdom）：主代理会话内「工作流」tab 的**宿主参数**契约。
 *
 * 用户口径（需求修正后）：
 * - tab 内容 = **侧栏那套工作流页面本体**（同一个 `WorkflowOverlay`，不复制、不裁剪成
 *   只读骨架），交互入口（搜索/模式切换/运行工作流/新增定义）全在；
 * - 两个宿主只差三个参数：`alwaysVisible`、`hostFilter = 本会话 id`、
 *   `showDiscussionInput = false`；
 * - 面板根挂 `data-conversation-composer-overlay` 空标记（照 DSH 轨迹 tab：
 *   让 DSH 切到「视图自持滚动」版式并撤掉会话列的宽度拖拽条 —— 即用户看到的
 *   「对话消息左右两边拉伸」那个入口）。
 *
 * 本文件覆盖「参数装配」这一层（把 `WorkflowOverlay` 换成探针组件，断言拿到的 props）；
 * 过滤语义在 `main-agent-workflow-model.spec.ts` + `instance-list-host-filter.spec.ts`，
 * RunView 侧的宿主认领在 `run-view-host-filter.spec.ts`，侧栏那一半在
 * `editor-pane-host-params.spec.ts`。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/main-agent-workflow-tab.spec
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/** WorkflowOverlay 探针：记录最近一次收到的 props（不渲染真实页面）。 */
const overlayCalls: Array<Record<string, unknown>> = []
vi.mock('./WorkflowOverlay.tsx', () => ({
  WorkflowOverlay: (props: Record<string, unknown>) => {
    overlayCalls.push(props)
    return createElement('div', { 'data-probe-workflow-overlay': '' })
  },
}))

import {
  registerMainAgentWorkflowTab, SandoreWorkflowTab, WORKFLOW_TAB_PANEL_SELECTOR, WORKFLOW_VIEW_ID,
} from './main-agent-workflow-tab.tsx'

/** 等一个宏任务（其前全部微任务已排空）。 */
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  overlayCalls.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  root.unmount()
  host.remove()
})

describe('SandoreWorkflowTab（参数装配）', () => {
  it('渲染**侧栏那套页面本体**（WorkflowOverlay）：alwaysVisible + hostFilter=本会话 + 无输入面', async () => {
    root.render(createElement(SandoreWorkflowTab, { sessionId: 'sess-1' }))
    await tick()

    const panel = host.querySelector(WORKFLOW_TAB_PANEL_SELECTOR)
    expect(panel, '面板根锚点应存在').not.toBeNull()
    expect(panel?.getAttribute('data-sandore-tab-session')).toBe('sess-1')

    expect(overlayCalls.length, '应渲染同一个 WorkflowOverlay（侧栏页面本体）').toBeGreaterThan(0)
    const props = overlayCalls.at(-1)!
    // 三个参数差异（其余全同）。
    expect(props['alwaysVisible']).toBe(true)
    expect(props['hostFilter']).toBe('sess-1')
    expect(props['showDiscussionInput']).toBe(false)
    // tab 常驻不受 store 开合影响：不传 open 之类的开关。
    expect('open' in props).toBe(false)
  })

  it('面板根挂铺满语义标记（照 DSH 轨迹 tab；撤掉 Chat 的会话列宽度拖拽条）', async () => {
    root.render(createElement(SandoreWorkflowTab, { sessionId: 'sess-1' }))
    await tick()
    const panel = host.querySelector(WORKFLOW_TAB_PANEL_SELECTOR)
    expect(panel?.hasAttribute('data-conversation-composer-overlay')).toBe(true)
    // 面板本身不产出任何输入锚点（输入面由 RunView 的 showDiscussionInput=false 关掉，
    // 探针下自然也没有；真实渲染路径由 run-view-host-filter.spec.ts + m22 覆盖）。
    expect(panel?.querySelectorAll('[data-main-agent-input], [data-sandore-disc-input], [data-composer-input]').length)
      .toBe(0)
  })
})

describe('registerMainAgentWorkflowTab（DSH conversation.view 注册契约）', () => {
  it('往 conversation.view 注册 net-new 条目：id 稳定、order 在 chat/trajectory 之后、label 走 locale', () => {
    const registered: Array<{ options: Record<string, unknown>; component: unknown }> = []
    let injectSlot: string | undefined
    const ctx = {
      locale: { bind: () => (key: string) => (key === 'tab.workflow' ? '工作流' : key) },
      slots: {
        inject: (name: string, run: () => () => void) => {
          injectSlot = name
          run()
        },
        register: (options: Record<string, unknown>, component: unknown) => {
          registered.push({ options, component })
          return () => {}
        },
      },
    }
    registerMainAgentWorkflowTab(ctx as never)

    expect(injectSlot, '必须挂到 DSH 的会话视图槽（会话 header 的原生 tab 条）').toBe('conversation.view')
    expect(registered).toHaveLength(1)
    const entry = registered[0]!
    expect(entry.options['name']).toBe('conversation.view')
    expect(entry.options['id']).toBe(WORKFLOW_VIEW_ID)
    // 不覆盖 ui-chat('chat')/ui-trajectory('trajectory') 的任何条目 id。
    expect(['chat', 'trajectory']).not.toContain(entry.options['id'])
    // 排在 chat(0)/trajectory(10) 之后。
    expect(entry.options['order']).toBeGreaterThan(10)
    // label 是 thunk（注册期文本随当前语言解析）。
    const label = entry.options['label']
    expect(typeof label).toBe('function')
    expect((label as () => string)()).toBe('工作流')
    expect(entry.component).toBe(SandoreWorkflowTab)
  })
})
