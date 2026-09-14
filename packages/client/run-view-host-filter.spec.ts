// @vitest-environment jsdom
/**
 * run-view-host-filter.spec（jsdom）：同一份 `RunView` 在两个宿主下的**参数差异行为**。
 *
 * 这是用户需求里「两个 WebUI 宿主共用一份实现，只靠参数区分」的真渲染验证：
 * 1. `hostFilter` 模式（主代理会话内的 tab）：只认领 `instanceId === hostFilter` 的实例；
 *    别的会话的实例**不出现在 DOM 里**（连 RPC 都不打）；本会话没有实例时给空态；
 * 2. `showDiscussionInput: false` 时**不渲染任何输入面**（三个输入锚点计数为 0）；
 *    缺省（侧栏工作流页）照旧渲染输入面 —— 一个组件两种参数，行为可分辨。
 *
 * 为什么不需要桩宿主 UI 原子包：宿主包 lib 里的 `.module.css` 由 `vitest.config.ts`
 * 的别名统一桩掉（见 `packages/tests/css-module-stub.ts`），组件本身照常真实渲染。
 * 用例里 RunView 走的是「加载中 / 空态 / 空消息列」这些最轻分支。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/run-view-host-filter.spec
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

// SSE 通道在 jsdom 里没有 EventSource：订阅本身就是空操作，直接桩掉。
vi.mock('./sandore-sse.ts', () => ({ subscribeSandoreSse: () => () => {} }))

import { RunView, type RunViewRemote } from './RunView.tsx'
import { setWorkflowState } from './workflow-store.ts'
import type {
  ModelDirectoryFace, ModelDirectoryState, ObservableFace, PermissionSelectValue,
} from './model-faces.ts'

/** 等一个宏任务（其前全部微任务已排空）。 */
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

/** 桩翻译函数：键原样返回（断言只看 DOM 锚点，不看文案）。 */
const t = ((key: string) => key) as unknown as TranslateNS<'sandore'>

/** `ok:true` 的 RemoteResult 包装。 */
function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value } as RemoteResult<T>
}

/** 最小实例状态（空执行段 / 空 stage 表 / 空消息：最轻的真实渲染路径）。 */
function emptyState(instanceId: string): Record<string, unknown> {
  return {
    instanceId,
    workflowId: 'wfl-1',
    workflowName: 'wf',
    originalInput: `需求 ${instanceId}`,
    status: 'running',
    executedSteps: [],
    stageInfos: [],
    stageContracts: {},
    userMessages: [],
    pendingInteractions: [],
  }
}

/** 未就绪模型目录（引用稳定快照 + routable:false ⇒ 选择器隐藏，渲染不崩）。 */
const UNAVAILABLE_DIRECTORY_STATE: ModelDirectoryState = {
  current: null, routable: false, groups: [], failures: [], status: 'error', error: 'unavailable',
}
function unavailableDirectory(): ModelDirectoryFace {
  return {
    store: {
      getSnapshot: () => UNAVAILABLE_DIRECTORY_STATE,
      subscribe: () => () => {},
    },
    load: async () => { throw new Error('unavailable') },
    select: async () => { throw new Error('unavailable') },
    dispose: () => {},
  }
}

/** 一次渲染的探针：记录 RPC 调用 + 提供 DOM 查询。 */
interface Harness {
  readonly host: HTMLDivElement
  dispose(): void
  /** `getInstanceState` 收到的 instanceId 序列。 */
  readonly stateCalls: string[]
}

/** 渲染 RunView（RPC 全桩）。 */
function mountView(options: {
  instanceId: string
  hostFilter?: string
  showDiscussionInput?: boolean
  /** `listInstances` 返回的实例清单（`hostFilter` 模式用）。 */
  instances?: readonly { instanceId: string }[]
}): Harness {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const stateCalls: string[] = []
  const remote = {
    listInstances: async () => ok(options.instances ?? []),
    getInstanceState: async (instanceId: string) => {
      stateCalls.push(instanceId)
      return ok(emptyState(instanceId))
    },
    getArtifacts: async () => ok([]),
    abortInstance: async () => ok(undefined),
    updateInstancePermissionMode: async () => ok(undefined),
    retryStep: async () => ok(undefined),
    listRevertBoundaries: async () => ok([]),
    replyQuestion: async () => ok(undefined),
    rejectQuestion: async () => ok(undefined),
    replyPermission: async () => ok(undefined),
    pauseAll: async () => ok(undefined),
    resumeAll: async () => ok(undefined),
    pauseStep: async () => ok(undefined),
    resumeStep: async () => ok(undefined),
    sendStepMessage: async () => ok(undefined),
  } as unknown as RunViewRemote
  const root: Root = createRoot(host)
  root.render(createElement(RunView, {
    t,
    instanceId: options.instanceId,
    ...(options.hostFilter === undefined ? {} : { hostFilter: options.hostFilter }),
    ...(options.showDiscussionInput === undefined ? {} : { showDiscussionInput: options.showDiscussionInput }),
    openSession: () => {},
    remote,
    modelDirectory: (() => unavailableDirectory()) as unknown as
      (sessionId: string) => ModelDirectoryFace,
    permissions: (() => ({ getSnapshot: () => undefined, subscribe: () => () => {} })) as unknown as
      (sessionId: string) => ObservableFace<PermissionSelectValue | undefined>,
    runCommand: async () => true,
    queryPermission: async () => undefined,
  }))
  return {
    host,
    stateCalls,
    dispose: () => {
      root.unmount()
      host.remove()
    },
  }
}

/** 在一个容器里数输入锚点（三个都不应出现）。 */
function inputAnchorCount(host: HTMLElement): number {
  return host.querySelectorAll(
    '[data-main-agent-input], [data-sandore-disc-input], [data-composer-input]',
  ).length
}

let harnesses: Harness[]

beforeEach(() => {
  harnesses = []
  setWorkflowState({ preview: null })
})

afterEach(() => {
  for (const harness of harnesses.splice(0).reverse()) harness.dispose()
  document.body.innerHTML = ''
})

describe('RunView · 宿主身份过滤（hostFilter）', () => {
  it('只认领 instanceId === hostFilter 的实例，并据此拉状态', async () => {
    const harness = mountView({
      instanceId: 'ignored',
      hostFilter: 'mine',
      showDiscussionInput: false,
      instances: [{ instanceId: 'other-1' }, { instanceId: 'mine' }, { instanceId: 'other-2' }],
    })
    harnesses.push(harness)
    // 认领是异步的（listInstances → 认领 → 拉状态 → 重渲染），用 waitFor 收口。
    await vi.waitFor(() => { expect(harness.stateCalls).toEqual(['mine']) })
    expect(harness.host.querySelector('[data-sandore-run-view]'), '应渲染执行视图').not.toBeNull()
    expect(harness.host.querySelector('[data-sandore-run-empty="host"]')).toBeNull()
  })

  it('本会话没有实例时：执行详情位给说明、不打任何实例 RPC、不显示别的会话的实例', async () => {
    const harness = mountView({
      instanceId: 'ignored',
      hostFilter: 'mine',
      showDiscussionInput: false,
      instances: [{ instanceId: 'other-1' }, { instanceId: 'other-2' }],
    })
    harnesses.push(harness)
    await vi.waitFor(() => {
      expect(harness.host.querySelector('[data-sandore-run-empty="host"]'), '应出现「无绑定实例」那一支')
        .not.toBeNull()
    })
    // 页面本体（列表/模式切换/搜索/按钮及其空态）由外层 `WorkflowOverlay` 负责，
    // 本视图只是它右栏的执行详情位 —— 所以这里既没有导航树、也没有执行内容。
    expect(harness.host.querySelector('[data-sandore-tree-nav]')).toBeNull()
    // 硬约束：不发任何实例/产物 RPC，也不显示别的会话的实例。
    expect(harness.stateCalls, '无实例时不应发实例 RPC').toEqual([])
    expect(harness.host.innerHTML).not.toContain('other-1')
    expect(harness.host.innerHTML).not.toContain('other-2')
  })
})

describe('RunView · 输入面开关（两个宿主的唯一参数差异）', () => {
  it('showDiscussionInput=false（主代理会话 tab）：三个输入锚点计数为 0', async () => {
    const harness = mountView({
      instanceId: 'mine',
      hostFilter: 'mine',
      showDiscussionInput: false,
      instances: [{ instanceId: 'mine' }],
    })
    harnesses.push(harness)
    // 认领 + 拉状态都是异步的（listInstances → 认领 → getInstanceState → 重渲染）：
    // 用 **`vi.waitFor`**（轮询）而不是「两个宏任务」，否则全量并行跑（CPU 竞争、
    // 其他 spec 同时渲染）时这两跳可能还没走完就断言 → 单跑绿、全量红的假失败。
    await vi.waitFor(() => {
      expect(harness.host.querySelector('[data-sandore-run-view]'), '应渲染执行视图').not.toBeNull()
    })
    expect(inputAnchorCount(harness.host), 'tab 里不得出现任何输入面').toBe(0)
  })

  it('缺省（侧栏工作流页）照旧渲染讨论输入面', async () => {
    const harness = mountView({ instanceId: 'mine' })
    harnesses.push(harness)
    // 同上：讨论输入面在 `loadState.kind === 'ready'` 之后才渲染，必须等它落定。
    await vi.waitFor(() => {
      expect(harness.host.querySelector('[data-sandore-disc-input]'), '侧栏宿主行为不变').not.toBeNull()
    })
    expect(inputAnchorCount(harness.host)).toBeGreaterThan(0)
  })
})
