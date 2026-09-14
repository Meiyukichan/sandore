// @vitest-environment jsdom
/**
 * instance-list-host-filter.spec（jsdom）：主代理会话内的「工作流」tab 渲染**侧栏那套页面本体**
 * 时，实例列表的**数据层**宿主过滤。
 *
 * 硬约束（用户规格）：**不得列出别的会话的实例**。过滤必须在 `listInstances()` 结果进入
 * state 之前完成 —— 别的会话的实例根本不进组件树（不是渲染时隐藏）。
 * 本文件用真 `InstanceList`（宿主 UI 包经 `vitest.config.ts` 的 inline 正常解析）验证：
 * 1. 传 `hostFilter` ⇒ DOM 里只有本会话那一条；
 * 2. 本会话没有实例 ⇒ 该页面自己的空态（列表为空）；
 * 3. 不传 `hostFilter`（侧栏席位）⇒ 原样全列，行为不变。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/instance-list-host-filter.spec
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { InstanceSummary } from '@meiyukichan/dsh-sandore/remote'

// SSE 通道在 jsdom 里没有 EventSource：订阅本身是空操作，桩掉。
vi.mock('./sandore-sse.ts', () => ({ subscribeSandoreSse: () => () => {} }))

import { InstanceList, type InstanceListProps } from './InstanceList.tsx'

/** 等一个宏任务（其前全部微任务已排空）。 */
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

/** 桩翻译函数：键原样返回（断言只看 DOM 行的文本，不看文案）。 */
const t = ((key: string, params?: Record<string, unknown>) =>
  (params === undefined ? key : `${key}${JSON.stringify(params)}`)) as unknown as TranslateNS<'sandore'>

/** 造一条实例摘要。 */
function summary(instanceId: string): InstanceSummary {
  return {
    instanceId,
    workflowId: 'wfl-1',
    originalInput: `需求-${instanceId}`,
    status: 'running',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  }
}

/** 渲染 InstanceList（RPC 桩）。 */
function mountList(options: {
  instances: readonly InstanceSummary[]
  hostFilter?: string
}): { host: HTMLDivElement; dispose(): void } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  const props: InstanceListProps = {
    t,
    workspaces: [] as readonly WorkspaceView[],
    query: '',
    listInstances: async () => [...options.instances],
    deleteInstance: async () => true,
    onOpen: () => {},
    ...(options.hostFilter === undefined ? {} : { hostFilter: options.hostFilter }),
  }
  root.render(createElement(InstanceList, props))
  return {
    host,
    dispose: () => {
      root.unmount()
      host.remove()
    },
  }
}

let mounted: Array<{ dispose(): void }>

beforeEach(() => { mounted = [] })
afterEach(() => {
  for (const item of mounted.splice(0).reverse()) item.dispose()
  document.body.innerHTML = ''
})

describe('InstanceList · 宿主会话过滤（hostFilter）', () => {
  it('只列本会话的实例：别的会话的实例不进 DOM', async () => {
    const view = mountList({
      instances: [summary('mine'), summary('other-1'), summary('other-2')],
      hostFilter: 'mine',
    })
    mounted.push(view)
    await vi.waitFor(() => {
      expect(view.host.textContent ?? '').toContain('需求-mine')
    })
    const text = view.host.textContent ?? ''
    expect(text, '别的会话的实例不得出现在列表里').not.toContain('需求-other-1')
    expect(text, '别的会话的实例不得出现在列表里').not.toContain('需求-other-2')
    // 只要一条实例行。
    expect(view.host.querySelectorAll('li')).toHaveLength(1)
  })

  it('本会话没有实例时给该页面自己的空态（列表为空）', async () => {
    const view = mountList({
      instances: [summary('other-1'), summary('other-2')],
      hostFilter: 'mine',
    })
    mounted.push(view)
    await vi.waitFor(() => {
      expect(view.host.textContent ?? '').toContain('panel.empty.instances')
    })
    expect(view.host.querySelectorAll('li')).toHaveLength(0)
    expect(view.host.textContent ?? '').not.toContain('需求-other-1')
  })

  it('不传 hostFilter（侧栏席位）：原样全列，行为不变', async () => {
    const view = mountList({ instances: [summary('mine'), summary('other-1')] })
    mounted.push(view)
    await vi.waitFor(() => {
      expect(view.host.querySelectorAll('li')).toHaveLength(2)
    })
    const text = view.host.textContent ?? ''
    expect(text).toContain('需求-mine')
    expect(text).toContain('需求-other-1')
  })
})
