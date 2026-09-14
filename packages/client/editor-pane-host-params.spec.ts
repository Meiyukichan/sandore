// @vitest-environment jsdom
/**
 * editor-pane-host-params.spec（jsdom）：**两个 WebUI 宿主共用一份 RunView** 的
 * 侧边那一半——侧栏工作流页（`WorkflowOverlay` → `EditorPane`）不得因为新增 tab 而改变行为。
 *
 * 用户规格：「两个 WebUI 宿主共用一份实现，只靠参数区分：一个按主代理 id 过滤且不显示
 * 讨论输入框，另一个**保持现状**」。主代理 tab 那半在 `main-agent-workflow-tab.spec.ts`
 * + `run-view-host-filter.spec.ts` 覆盖；本文件钉死侧栏那半：`EditorPane` 渲染 RunView 时
 * **不传** `hostFilter`、**不传** `showDiscussionInput`（= 缺省 true ⇒ 照旧带输入框）。
 *
 * 桩：`DagEditor`（会拉真 RPC 与画布）与 `RunView`（探针记录 props）；`EditorPane` 本身真实。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/editor-pane-host-params.spec
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/** RunView 探针：记录最近一次收到的 props。 */
const runViewCalls: Array<Record<string, unknown>> = []
vi.mock('./RunView.tsx', () => ({
  RunView: (props: Record<string, unknown>) => {
    runViewCalls.push(props)
    return createElement('div', { 'data-probe-run-view': '' })
  },
}))
/** DagEditor 桩（编排态才用；这里只跑执行态，桩掉以避开画布/RPC 依赖）。 */
vi.mock('./DagEditor.tsx', () => ({ DagEditor: () => null }))

import { EditorPane } from './EditorPane.tsx'
import type { WorkflowOverlayFace } from './workflow-face.ts'
import { getWorkflowState, setWorkflowState } from './workflow-store.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** 等一个宏任务。 */
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

/** 桩翻译函数。 */
const t = ((key: string) => key) as unknown as TranslateNS<'sandore'>

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  runViewCalls.length = 0
  // 执行态 + 选中一个实例（EditorPane 的 RunView 分支）。
  setWorkflowState({ mode: 'run', selectedInstanceId: 'inst-sidebar', preview: null })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  root.unmount()
  host.remove()
  setWorkflowState({ mode: 'dag', selectedInstanceId: undefined })
})

describe('EditorPane（侧栏工作流页那一半）', () => {
  it('渲染同一份 RunView：只传 instanceId，不传 hostFilter / showDiscussionInput（侧栏行为保持现状）', async () => {
    root.render(createElement(EditorPane, {
      t,
      face: {} as unknown as WorkflowOverlayFace,
      onSaved: () => {},
    }))
    await tick()
    expect(getWorkflowState().selectedInstanceId).toBe('inst-sidebar')
    expect(runViewCalls.length, '侧栏工作流页应渲染 RunView').toBeGreaterThan(0)
    const props = runViewCalls.at(-1)!
    expect(props['instanceId']).toBe('inst-sidebar')
    // 关键差异：侧栏宿主**不参与**宿主会话过滤、**保持**带输入框（缺省 true）。
    expect('hostFilter' in props).toBe(false)
    expect('showDiscussionInput' in props).toBe(false)
  })
})
