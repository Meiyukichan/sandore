/**
 * `step-chat-paging.ts` 的单元测试（批 A / A1）：
 * - 分页读取面：会话快照 hasMore/loadingOlder 的结构探测（缺失/非布尔 → 保守 false，
 *   并复用空常量引用）；
 * - 分页能力面：loadOlder/loadThrough 的结构探测 + cast（方法缺失 → 静默 no-op，
 *   返回值恒为 promise，调用方无需判空）；
 * - prepend 保位纯函数：ΔscrollHeight 补偿（增长/无增长/回缩/NaN）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-chat-paging.spec
 */
import { describe, expect, it, vi } from 'vitest'

import {
  STEP_CHAT_NO_PAGING,
  stepChatPagingOf,
  stepChatPagingOfSession,
  stepChatPrependDeltaOf,
  stepChatPrependScrollTopOf,
} from './step-chat-paging.ts'

describe('stepChatPagingOf（快照分页字段探测）', () => {
  it('reads hasMore / loadingOlder off the snapshot', () => {
    expect(stepChatPagingOf({ hasMore: true, loadingOlder: false }))
      .toEqual({ hasMore: true, loadingOlder: false })
    expect(stepChatPagingOf({ hasMore: true, loadingOlder: true }))
      .toEqual({ hasMore: true, loadingOlder: true })
  })

  it('falls back to the shared empty constant for absent or malformed fields', () => {
    // 两字段皆假 → 复用常量引用（面板每帧读一次，不产生垃圾）。
    expect(stepChatPagingOf({ hasMore: false, loadingOlder: false })).toBe(STEP_CHAT_NO_PAGING)
    expect(stepChatPagingOf({})).toBe(STEP_CHAT_NO_PAGING)
    expect(stepChatPagingOf(undefined)).toBe(STEP_CHAT_NO_PAGING)
    expect(stepChatPagingOf(null)).toBe(STEP_CHAT_NO_PAGING)
    expect(stepChatPagingOf('nope')).toBe(STEP_CHAT_NO_PAGING)
    // 非布尔一律按「无分页」处理（照抄 DSH 消费侧的布尔真值语义，不做类型强制）。
    expect(stepChatPagingOf({ hasMore: 1, loadingOlder: 'yes' })).toBe(STEP_CHAT_NO_PAGING)
  })
})

describe('stepChatPagingOfSession（loadOlder / loadThrough 能力面）', () => {
  it('forwards loadOlder and loadThrough to the session', async () => {
    const loadOlder = vi.fn(async () => {})
    const loadThrough = vi.fn(async (_seq: number) => {})
    const paging = stepChatPagingOfSession({ loadOlder, loadThrough })
    await paging.loadOlder()
    await paging.loadThrough(42)
    expect(loadOlder).toHaveBeenCalledTimes(1)
    expect(loadThrough).toHaveBeenCalledWith(42)
  })

  it('degrades to a settled no-op when the runtime lacks the methods', async () => {
    // rc.6 公开面（本仓库锁定的 dsh-client-runtime@0.1.1-rc.2）的 ISession 没有
    // loadThrough；会话对象也可能整体缺失（binding 已失效的竞态帧）。
    const bare = stepChatPagingOfSession({})
    await expect(bare.loadOlder()).resolves.toBeUndefined()
    await expect(bare.loadThrough(0)).resolves.toBeUndefined()
    const absent = stepChatPagingOfSession(undefined)
    await expect(absent.loadOlder()).resolves.toBeUndefined()
    await expect(absent.loadThrough(7)).resolves.toBeUndefined()
  })
})

describe('stepChatPrependScrollTopOf（prepend 保位）', () => {
  it('adds the prepended height so the reader keeps the same row', () => {
    // 头部插入 400px 新内容：scrollHeight 从 1000 → 1400，读者原 scrollTop 300
    // 必须后移到 700，原来那一行才停在视口同一位置。
    expect(stepChatPrependScrollTopOf(
      { scrollHeight: 1000, scrollTop: 300 },
      { scrollHeight: 1400, scrollTop: 300 },
    )).toBe(700)
    expect(stepChatPrependDeltaOf(
      { scrollHeight: 1000, scrollTop: 300 },
      { scrollHeight: 1400, scrollTop: 300 },
    )).toBe(400)
  })

  it('never moves the reader when the page did not grow (failure / empty page)', () => {
    expect(stepChatPrependScrollTopOf(
      { scrollHeight: 1000, scrollTop: 300 },
      { scrollHeight: 1000, scrollTop: 300 },
    )).toBe(300)
    // 内容变矮（流式重排/图片塌陷）也不倒退——补偿恒非负。
    expect(stepChatPrependScrollTopOf(
      { scrollHeight: 1000, scrollTop: 300 },
      { scrollHeight: 900, scrollTop: 300 },
    )).toBe(300)
    expect(stepChatPrependDeltaOf(
      { scrollHeight: 1000, scrollTop: 0 },
      { scrollHeight: 900, scrollTop: 0 },
    )).toBe(0)
  })

  it('treats non-finite metrics as no growth', () => {
    expect(stepChatPrependDeltaOf(
      { scrollHeight: Number.NaN, scrollTop: 10 },
      { scrollHeight: 100, scrollTop: 10 },
    )).toBe(0)
    expect(stepChatPrependScrollTopOf(
      { scrollHeight: 100, scrollTop: 10 },
      { scrollHeight: Number.NaN, scrollTop: 10 },
    )).toBe(10)
  })
})
