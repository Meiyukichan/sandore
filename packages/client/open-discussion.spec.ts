/**
 * open-discussion.ts（打开讨论 adapter）的单元测试：
 * `createOpenDiscussion(sessions, instanceId)` 返回无入参回调，调用时经
 * `sessions.open(instanceId)` 跳宿主会话（宿主 Session id == instanceId）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/open-discussion.spec
 */
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'

import { createOpenDiscussion, type SessionsOpenFace } from './open-discussion.ts'

/** 将字符串收窄为 SessionId（brand 仅编译期，测试内无需真实 factory）。 */
function asSessionId(id: string): SessionId {
  return id as SessionId
}

describe('createOpenDiscussion', () => {
  it('invokes sessions.open with the instance id when the callback runs', () => {
    const open = vi.fn((_id: SessionId): void => {})
    const sessions: SessionsOpenFace = { open }

    const openDiscussion = createOpenDiscussion(sessions, 'inst-1')
    openDiscussion()

    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(asSessionId('inst-1'))
  })

  it('invokes sessions.open exactly once per callback invocation', () => {
    const open = vi.fn((_id: SessionId): void => {})
    const sessions: SessionsOpenFace = { open }

    const openDiscussion = createOpenDiscussion(sessions, 'inst-2')
    openDiscussion()
    openDiscussion()

    expect(open).toHaveBeenCalledTimes(2)
  })
})
