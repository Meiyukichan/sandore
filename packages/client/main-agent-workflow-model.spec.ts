/**
 * main-agent-workflow-model.spec：主代理会话内「工作流」tab 的**过滤纯函数**。
 *
 * 钉死的语义（用户要求「只显示绑定到该主代理会话的实例，且看不到其它实例」）：
 * 1. 过滤键 = `instanceId`（引擎恒等式 `hostSessionId ≡ instanceId`，`InstanceSummary`
 *    上没有 `hostSessionId` 字段）；
 * 2. 别的会话的实例**一律不认领**（多实例清单里只挑出一条）；
 * 3. 空宿主 id 恒判否（不把「空串」当成某个真实会话）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/main-agent-workflow-model.spec
 */
import { describe, expect, it } from 'vitest'
import type { InstanceSummary } from '@meiyukichan/dsh-sandore/remote'

import { hostBoundInstance, instanceBoundToHost } from './main-agent-workflow-model.ts'

/** 造一条实例摘要（只需 instanceId 参与过滤）。 */
function summary(instanceId: string, workflowId = 'wfl-1'): InstanceSummary {
  return {
    instanceId,
    workflowId,
    originalInput: `需求 ${instanceId}`,
    status: 'running',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  }
}

describe('instanceBoundToHost', () => {
  it('只认领 instanceId === 宿主会话 id 的行（引擎恒等式）', () => {
    expect(instanceBoundToHost(summary('sess-1'), 'sess-1')).toBe(true)
    expect(instanceBoundToHost(summary('sess-2'), 'sess-1')).toBe(false)
  })

  it('空宿主 id 恒判否（不把空串认成某个会话）', () => {
    expect(instanceBoundToHost(summary(''), '')).toBe(false)
    expect(instanceBoundToHost(summary('sess-1'), '')).toBe(false)
  })
})

describe('hostBoundInstance', () => {
  it('多实例清单里只挑出属于本主代理会话的那一条', () => {
    const instances = [summary('other-1'), summary('mine'), summary('other-2')]
    expect(hostBoundInstance(instances, 'mine')?.instanceId).toBe('mine')
  })

  it('本会话没有实例时返回 undefined（调用方据此渲染空态）', () => {
    expect(hostBoundInstance([summary('other-1'), summary('other-2')], 'mine')).toBeUndefined()
    expect(hostBoundInstance([], 'mine')).toBeUndefined()
    // 空宿主 id：即使清单里有 instanceId 为空串的行也不认领。
    expect(hostBoundInstance([summary('')], '')).toBeUndefined()
  })

  it('绝不返回别的会话的实例（过滤后集合只可能含本会话那一条）', () => {
    const instances = [summary('a'), summary('b'), summary('c')]
    for (const host of ['a', 'b', 'c']) {
      const picked = hostBoundInstance(instances, host)
      expect(picked?.instanceId).toBe(host)
    }
    // 逐个宿主过滤后，命中集合的规模恒为 1（不会把别人的实例带进来）。
    const matched = instances.filter(instance => instanceBoundToHost(instance, 'b'))
    expect(matched.map(instance => instance.instanceId)).toEqual(['b'])
  })
})
