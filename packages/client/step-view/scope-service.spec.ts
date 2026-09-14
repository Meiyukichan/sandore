/**
 * `readScopeService` 的行为锁 + 两个调用方的集成回归。
 *
 * 背景：真实 e2e 发现 `binding.ctx` 是 sandore 自己的 cordis scoped ctx，对**未 inject**
 * 的服务做属性读会抛 `cannot get property "conversation" without inject`；该异常发生在
 * render 期（`resolveStepComposerKernel` / `stepChatComposerSendOf` 的装配探测），被席位
 * error boundary 接住后整个 RunView 被替换成 DSH 原生对话列。jsdom 单测当年用普通对象
 * 当 ctx，所以读不出事——本文件用 **cordis 同构 Proxy**（属性读抛、`get` 正常）把该形态
 * 钉在测试里，避免回归。
 *
 * 覆盖：
 * - `readScopeService`：`get` 优先 / `get` 缺失回退属性读 / `get` 抛或返回空值回退 /
 *   属性读抛 → undefined / ctx 非对象 → undefined（**任何情况都不抛**）；
 * - 集成：同一 cordis 同构 ctx 下 `stepChatComposerSendOf` 仍能探测到 conversation 并
 *   发送（不再于装配期崩），`resolveStepComposerKernel` 在 `input.for` 抛错时安全降级。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/scope-service.spec
 */
import { describe, expect, it, vi } from 'vitest'

import { stepChatComposerSendOf } from './composer-bar.ts'
import { resolveStepComposerKernel } from './dsh-composer.ts'
import { readScopeService } from './scope-service.ts'

/**
 * cordis 同构 scoped ctx 桩：`get(name)` 正常返回值，而**属性读**已注册的服务名抛
 * 「without inject」（照 cordis 对未声明依赖的实际行为）。
 */
function cordisLikeCtx(services: Record<string, unknown>): unknown {
  return new Proxy(services, {
    get(target, key, receiver) {
      if (key === 'get') return (name: string) => Reflect.get(target, name, receiver)
      if (typeof key === 'string' && key in target) {
        throw new Error(`cannot get property "${key}" without inject`)
      }
      return Reflect.get(target, key, receiver)
    },
  })
}

describe('readScopeService（cordis 服务安全读取）', () => {
  it('reads through ctx.get without tripping the uninjected property read', () => {
    const conversation = { send: vi.fn() }
    // 属性读会抛（cordis 形态）——get 通道必须拿到服务且整体不抛。
    expect(() => readScopeService(cordisLikeCtx({ conversation }), 'conversation')).not.toThrow()
    expect(readScopeService(cordisLikeCtx({ conversation }), 'conversation')).toBe(conversation)
  })

  it('falls back to the plain property read when ctx has no get (jsdom stubs)', () => {
    const conversation = { send: vi.fn() }
    expect(readScopeService({ conversation }, 'conversation')).toBe(conversation)
  })

  it('falls back to the property read when get throws', () => {
    const conversation = { send: vi.fn() }
    const ctx = {
      get: () => { throw new Error('get unavailable') },
      conversation,
    }
    expect(readScopeService(ctx, 'conversation')).toBe(conversation)
  })

  it('treats a nullish get result as absent and keeps looking', () => {
    const conversation = { send: vi.fn() }
    expect(readScopeService({ get: () => undefined, conversation }, 'conversation')).toBe(conversation)
    expect(readScopeService({ get: () => null, conversation }, 'conversation')).toBe(conversation)
  })

  it('returns undefined when the property read throws and no get is available', () => {
    const throwing = new Proxy({}, {
      get() { throw new Error('cannot get property "conversation" without inject') },
    })
    expect(() => readScopeService(throwing, 'conversation')).not.toThrow()
    expect(readScopeService(throwing, 'conversation')).toBeUndefined()
  })

  it('returns undefined for non-object ctx values', () => {
    for (const ctx of [undefined, null, 'ctx', 42, true]) {
      expect(readScopeService(ctx, 'conversation')).toBeUndefined()
    }
  })

  it('does not swallow a missing service into a throw either way', () => {
    expect(readScopeService(cordisLikeCtx({}), 'conversation')).toBeUndefined()
    expect(readScopeService({}, 'conversation')).toBeUndefined()
  })
})

describe('装配探测在 cordis 同构 ctx 下的回归（真实 e2e 崩溃形态）', () => {
  it('stepChatComposerSendOf still detects conversation and sends', async () => {
    const send = vi.fn(async () => {})
    const binding = { session: {}, ctx: cordisLikeCtx({ conversation: { send } }) }
    // 装配期探测曾在此抛（render 期崩溃）——现在必须返回可用发送能力。
    const sender = stepChatComposerSendOf(binding as never)
    expect(sender).toBeDefined()
    await expect(sender?.('hello')).resolves.toEqual({ ok: true })
    expect(send).toHaveBeenCalledWith('hello')
  })

  it('degrades to undefined instead of crashing when neither channel exists', () => {
    const binding = { session: {}, ctx: cordisLikeCtx({}) }
    expect(stepChatComposerSendOf(binding as never)).toBeUndefined()
    expect(resolveStepComposerKernel(binding as never)).toBeUndefined()
  })

  it('resolveStepComposerKernel survives a throwing input.for', () => {
    const conversation = { input: { for: () => { throw new Error('requires a session scope') } } }
    const binding = { session: {}, ctx: cordisLikeCtx({ conversation }) }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => resolveStepComposerKernel(binding as never)).not.toThrow()
    expect(resolveStepComposerKernel(binding as never)).toBeUndefined()
    errorSpy.mockRestore()
  })
})
