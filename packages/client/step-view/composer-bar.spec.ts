/**
 * composer-bar.spec：B4b 简化输入框的纯逻辑回归（可发送判定 / 展示条件 /
 * 发送状态机边界 / 两通道发送装配 + 结果归一）。渲染行为见
 * composer-bar-render.spec（jsdom）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/composer-bar.spec
 */
import { describe, expect, it, vi } from 'vitest'

import {
  stepChatComposerCanSend,
  stepChatComposerErrorText,
  stepChatComposerFailureOf,
  stepChatComposerResultOf,
  stepChatComposerSendOf,
  stepChatComposerShown,
  stepChatComposerTextParts,
  type StepChatComposerBindingLike,
} from './composer-bar.ts'

describe('stepChatComposerShown（展示条件）', () => {
  it('renders only while open and running', () => {
    expect(stepChatComposerShown('open', true)).toBe(true)
    expect(stepChatComposerShown('open', false)).toBe(false) // paused/completed：不显示
    expect(stepChatComposerShown('cold', true)).toBe(false)
    expect(stepChatComposerShown('loading', true)).toBe(false)
    expect(stepChatComposerShown('error', true)).toBe(false)
    expect(stepChatComposerShown(undefined, true)).toBe(false)
  })

  it('keeps the composer for queued and for retry-pending failed segments（批 B2；需求 1 起仅本组件内语义）', () => {
    // 队列非空（批 B1）与「待重试的 failed 子代理段」（批 B2）都不让输入框消失：
    // 前者的草稿/队列要继续可见。第四参（failed 段）在需求 1 后**没有生产调用方**
    // （面板已不挂载输入框，重试行住在面板底部动作位且载荷是固定默认串），
    // 此用例锁的是「恢复挂载点时不改变组件既有行为」这一半。
    expect(stepChatComposerShown('open', false, true)).toBe(true)
    expect(stepChatComposerShown('open', false, false, true)).toBe(true)
    // 两个放宽条件都受 openState 闸门约束（loading/error 仍由面板占位承担）。
    expect(stepChatComposerShown('loading', false, false, true)).toBe(false)
    expect(stepChatComposerShown('cold', false, true, true)).toBe(false)
    // 缺省参数保持旧行为（旧调用方/测试不传即不变）。
    expect(stepChatComposerShown('open', false)).toBe(false)
  })
})

describe('stepChatComposerCanSend / TextParts（发送判定与载荷）', () => {
  it('allows non-empty drafts outside the sending phase', () => {
    expect(stepChatComposerCanSend('你好', 'idle')).toBe(true)
    expect(stepChatComposerCanSend('   ', 'idle')).toBe(false) // 全空白不可发送
    expect(stepChatComposerCanSend('', 'idle')).toBe(false)
    expect(stepChatComposerCanSend('你好', 'sending')).toBe(false) // 发送中禁用
  })

  it('shapes the rc.1 prompt content as one text block', () => {
    expect(stepChatComposerTextParts('继续执行')).toEqual([{ type: 'text', text: '继续执行' }])
  })
})

describe('stepChatComposerResultOf（RemoteResult 结构读）', () => {
  it('accepts an ok result', () => {
    expect(stepChatComposerResultOf({ ok: true, value: { accepted: true } })).toEqual({ ok: true })
  })

  it('reads code/message off a business failure', () => {
    expect(stepChatComposerResultOf({
      ok: false,
      error: { code: 'subagent/parent-unavailable', message: 'parent session is not live' },
    })).toEqual({
      ok: false,
      code: 'subagent/parent-unavailable',
      message: 'parent session is not live',
    })
  })

  it('degrades gracefully on malformed payloads', () => {
    expect(stepChatComposerResultOf(undefined)).toEqual({ ok: false })
    expect(stepChatComposerResultOf(null)).toEqual({ ok: false })
    expect(stepChatComposerResultOf('nope')).toEqual({ ok: false })
    expect(stepChatComposerResultOf({ ok: false })).toEqual({ ok: false }) // 无 error 字段
    expect(stepChatComposerResultOf({ ok: false, error: { code: '', message: '' } })).toEqual({ ok: false })
    expect(stepChatComposerResultOf({ ok: false, error: { message: '只有 message' } })).toEqual({
      ok: false,
      message: '只有 message',
    })
    expect(stepChatComposerResultOf({ ok: false, error: { code: 'E-9' } })).toEqual({ ok: false, code: 'E-9' })
  })
})

describe('stepChatComposerFailureOf / ErrorText（失败归一与文案）', () => {
  it('reads Error.message and raw strings, ignoring empty garbage', () => {
    expect(stepChatComposerFailureOf(new Error('conversation.send failed: E-1: boom'))).toEqual({
      ok: false,
      message: 'conversation.send failed: E-1: boom',
    })
    expect(stepChatComposerFailureOf('raw boom')).toEqual({ ok: false, message: 'raw boom' })
    expect(stepChatComposerFailureOf(undefined)).toEqual({ ok: false })
  })

  it('composes the error-line text with the rc.1 message (code) shape', () => {
    expect(stepChatComposerErrorText({ ok: false, message: 'busy', code: 'session/agent-busy' }, 'fallback'))
      .toBe('busy (session/agent-busy)')
    expect(stepChatComposerErrorText({ ok: false, message: '只有 message' }, 'fallback')).toBe('只有 message')
    expect(stepChatComposerErrorText({ ok: false, code: 'E-9' }, 'fallback')).toBe('E-9')
    expect(stepChatComposerErrorText({ ok: false }, '发送失败，请重试')).toBe('发送失败，请重试')
    expect(stepChatComposerErrorText({ ok: true }, 'fallback')).toBe('')
  })
})

describe('stepChatComposerSendOf（发送通道装配：a=scope conversation，b=session.prompt 兜底）', () => {
  it('returns undefined without a binding or with no channel at all', () => {
    expect(stepChatComposerSendOf(undefined)).toBeUndefined()
    expect(stepChatComposerSendOf({})).toBeUndefined() // 双通道皆缺 → 面板不挂输入框
  })

  it('sends through the agent-scope conversation when present (a first)', async () => {
    const send = vi.fn(async () => undefined)
    const prompt = vi.fn(async () => ({ ok: true }))
    const sender = stepChatComposerSendOf({
      session: { prompt },
      ctx: { conversation: { send } },
    } as unknown as StepChatComposerBindingLike)
    expect(sender).toBeDefined()
    await expect(sender!('插一句')).resolves.toEqual({ ok: true })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('插一句')
    expect(prompt).not.toHaveBeenCalled() // (a) 在场不落 (b)
  })

  it('maps a conversation rejection to failure without retrying through prompt', async () => {
    const send = vi.fn(async () => {
      throw new Error('conversation.send failed: session/agent-busy: prompt rejected')
    })
    const prompt = vi.fn()
    const sender = stepChatComposerSendOf({
      session: { prompt },
      ctx: { conversation: { send } },
    } as unknown as StepChatComposerBindingLike)!
    await expect(sender('hi')).resolves.toEqual({
      ok: false,
      message: 'conversation.send failed: session/agent-busy: prompt rejected',
    })
    expect(prompt).not.toHaveBeenCalled() // 业务失败 ≠ 通道缺失，不重复投递
  })

  it('falls back to session.prompt (queue mode) without a conversation channel', async () => {
    const prompt = vi.fn(async () => ({ ok: true, value: { accepted: true } }))
    const sender = stepChatComposerSendOf({ session: { prompt } } as unknown as StepChatComposerBindingLike)
    expect(sender).toBeDefined()
    await expect(sender!('继续')).resolves.toEqual({ ok: true })
    // rc.1 prompt 形状：content=[{type:'text',text}]，queue 模式
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith([{ type: 'text', text: '继续' }], 'queue')
  })

  it('maps the prompt RemoteResult failure onto the normalized shape', async () => {
    const prompt = vi.fn(async () => ({
      ok: false,
      error: { code: 'subagent/unauthorized', message: 'subagent does not belong to this parent' },
    }))
    const sender = stepChatComposerSendOf({ session: { prompt } } as unknown as StepChatComposerBindingLike)!
    await expect(sender('hi')).resolves.toEqual({
      ok: false,
      code: 'subagent/unauthorized',
      message: 'subagent does not belong to this parent',
    })
  })

  it('re-reads the scope property on every call: conversation loss falls to prompt', async () => {
    const send = vi.fn(async () => undefined)
    const prompt = vi.fn(async () => ({ ok: true }))
    const conversation = { send }
    const binding = { session: { prompt }, ctx: { conversation } } as unknown as StepChatComposerBindingLike
    const sender = stepChatComposerSendOf(binding)!
    await sender('第一发')
    expect(send).toHaveBeenCalledTimes(1)
    // 会话卸载/HMR 后 conversation 从 scope ctx 消失（cordis 服务随插件生命周期）：
    delete (binding as unknown as { ctx: { conversation?: unknown } }).ctx.conversation
    await expect(sender('第二发')).resolves.toEqual({ ok: true })
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith([{ type: 'text', text: '第二发' }], 'queue')
  })
})
