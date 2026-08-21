/**
 * step-session-chat 纯逻辑单测（node 环境，无 React / 无 harness 依赖）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-session-chat.spec
 */
import { describe, expect, it, vi } from 'vitest'

import {
  createChatScrollMemory, createChatStoreLike, forkSessionAt, openSubagentSession,
  resolveWorkspacePath,
} from './step-session-chat.ts'

describe('openSubagentSession', () => {
  it('调用 open 并吞掉拒绝（开窗尽力而为）', async () => {
    const open = vi.fn(() => Promise.reject(new Error('boom')))
    openSubagentSession({ sessionId: 's1' as never, open })
    expect(open).toHaveBeenCalledOnce()
    // 拒绝被 catch 吞掉：不向上抛、不 unhandled rejection。
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })

  it('open 成功时照常 resolve（不抛错）', async () => {
    const open = vi.fn(() => Promise.resolve())
    openSubagentSession({ sessionId: 's1' as never, open })
    expect(open).toHaveBeenCalledOnce()
  })

  it('会话面缺少 open（接口收窄缺失）时静默跳过', () => {
    const open = vi.fn()
    openSubagentSession({ sessionId: 's1' as never, open: undefined })
    expect(open).not.toHaveBeenCalled()
  })
})

describe('createChatStoreLike', () => {
  it('初始快照对齐 ChatStoreState 契约', () => {
    const store = createChatStoreLike()
    expect(store.getSnapshot()).toEqual({ selection: null, draft: '', view: null, inspect: null })
  })

  it('actions 更新快照并通知订阅者（快照整体替换，selection 不串场）', () => {
    const store = createChatStoreLike()
    const subscriber = vi.fn()
    const unsubscribe = store.subscribe(subscriber)

    store.actions.select({ turnSeq: 3, callId: 'call-1' })
    expect(store.getSnapshot().selection).toEqual({ turnSeq: 3, callId: 'call-1' })
    expect(subscriber).toHaveBeenCalledTimes(1)

    store.actions.setDraft('hi')
    store.actions.setView('trajectory')
    store.actions.setInspect({ callId: 'call-2' })
    expect(store.getSnapshot()).toEqual({
      selection: { turnSeq: 3, callId: 'call-1' },
      draft: 'hi',
      view: 'trajectory',
      inspect: { callId: 'call-2' },
    })
    expect(subscriber).toHaveBeenCalledTimes(4)

    unsubscribe()
    store.actions.select(null)
    expect(subscriber).toHaveBeenCalledTimes(4)
  })
})

describe('createChatScrollMemory', () => {
  it('save/read 往返；null 清除（钉底）', () => {
    const memory = createChatScrollMemory()
    expect(memory.read()).toBeNull()
    const position = { anchorKey: 'k1', anchorTop: 10, scrollTop: 100 }
    memory.save(position)
    expect(memory.read()).toBe(position)
    memory.save(null)
    expect(memory.read()).toBeNull()
  })
})

describe('resolveWorkspacePath', () => {
  it('绝对路径 / 盘符 / UNC 原样返回', () => {
    expect(resolveWorkspacePath('/tmp/ws', '/abs/path')).toBe('/abs/path')
    expect(resolveWorkspacePath('/tmp/ws', 'C:\\abs\\path')).toBe('C:\\abs\\path')
    expect(resolveWorkspacePath('/tmp/ws', '\\\\share\\dir')).toBe('\\\\share\\dir')
  })

  it('相对路径拼接到工作区根（cwd 去尾部斜杠）', () => {
    expect(resolveWorkspacePath('/tmp/ws', 'a/b.txt')).toBe('/tmp/ws/a/b.txt')
    expect(resolveWorkspacePath('/tmp/ws/', 'a/b.txt')).toBe('/tmp/ws/a/b.txt')
  })

  it('无工作区根时原样返回相对路径', () => {
    expect(resolveWorkspacePath(undefined, 'a/b.txt')).toBe('a/b.txt')
    expect(resolveWorkspacePath('', 'a/b.txt')).toBe('a/b.txt')
  })
})

describe('forkSessionAt', () => {
  it('fork 成功后打开子会话（increaseTitle 固定为 true）', async () => {
    const fork = vi.fn((opts: { sessionId: string; atSeq?: number; increaseTitle?: boolean }) =>
      Promise.resolve('child-1'))
    const open = vi.fn()
    forkSessionAt({ fork, open } as never, 's1' as never, 42)
    expect(fork).toHaveBeenCalledWith({ sessionId: 's1', atSeq: 42, increaseTitle: true })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(open).toHaveBeenCalledWith('child-1')
  })

  it('fork 失败静默（不向上抛、不打开子会话）', async () => {
    const fork = vi.fn(() => Promise.reject(new Error('fork failed')))
    const open = vi.fn()
    forkSessionAt({ fork, open } as never, 's1' as never, 1)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(open).not.toHaveBeenCalled()
  })
})
