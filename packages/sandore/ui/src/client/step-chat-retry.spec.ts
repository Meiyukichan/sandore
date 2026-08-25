/**
 * step-chat-retry 纯逻辑单测（node 环境，无 React / 无 DSH 运行时依赖）。
 *
 * Round 25：StepChatPanel 弹性化（open 失败退避重试 + binding 重解析 + openError 展示）
 * 的可测纯函数。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-chat-retry.spec
 */
import { describe, expect, it } from 'vitest'
import {
  formatOpenError, STEP_CHAT_MAX_REBINDS, STEP_CHAT_REBIND_DELAYS_MS, STEP_CHAT_RETRY_DELAYS_MS,
  stepChatRebindDelayMs, stepChatRetryDelayMs,
} from './step-chat-retry.ts'

describe('stepChatRetryDelayMs（open 失败退避序列）', () => {
  it('按 1s → 3s → 10s 有界递增', () => {
    expect(STEP_CHAT_RETRY_DELAYS_MS).toEqual([1000, 3000, 10000])
    expect(stepChatRetryDelayMs(0)).toBe(1000)
    expect(stepChatRetryDelayMs(1)).toBe(3000)
    expect(stepChatRetryDelayMs(2)).toBe(10000)
  })

  it('达上限返回 undefined（停止重试，停在 error 占位）', () => {
    expect(stepChatRetryDelayMs(3)).toBeUndefined()
    expect(stepChatRetryDelayMs(100)).toBeUndefined()
  })

  it('非法入参返回 undefined', () => {
    expect(stepChatRetryDelayMs(-1)).toBeUndefined()
    expect(stepChatRetryDelayMs(1.5)).toBeUndefined()
    expect(stepChatRetryDelayMs(Number.NaN)).toBeUndefined()
  })
})

describe('stepChatRebindDelayMs（binding 缺失时的列表重拉序列）', () => {
  it('按 1s → 2s → 5s → 10s → 30s 有界递增，最大次数与序列等长', () => {
    expect(STEP_CHAT_REBIND_DELAYS_MS).toEqual([1000, 2000, 5000, 10000, 30000])
    expect(STEP_CHAT_MAX_REBINDS).toBe(5)
    expect(stepChatRebindDelayMs(0)).toBe(1000)
    expect(stepChatRebindDelayMs(1)).toBe(2000)
    expect(stepChatRebindDelayMs(2)).toBe(5000)
    expect(stepChatRebindDelayMs(3)).toBe(10000)
    expect(stepChatRebindDelayMs(4)).toBe(30000)
  })

  it('达上限返回 undefined（停止重拉，避免对已删除 child 空转）', () => {
    expect(stepChatRebindDelayMs(5)).toBeUndefined()
  })

  it('非法入参返回 undefined', () => {
    expect(stepChatRebindDelayMs(-1)).toBeUndefined()
    expect(stepChatRebindDelayMs(2.5)).toBeUndefined()
  })
})

describe('formatOpenError（error 占位详情展示）', () => {
  it('null/undefined 不展示', () => {
    expect(formatOpenError(null)).toBeUndefined()
    expect(formatOpenError(undefined)).toBeUndefined()
  })

  it('有 message 时展示 `code: message`', () => {
    expect(formatOpenError({ code: 'session-not-found', message: 'session "x" not found' }))
      .toBe('session-not-found: session "x" not found')
  })

  it('无 message（空串/缺失）时仅展示 code', () => {
    expect(formatOpenError({ code: 'internal' })).toBe('internal')
    expect(formatOpenError({ code: 'internal', message: '' })).toBe('internal')
  })
})
