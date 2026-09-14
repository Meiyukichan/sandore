/**
 * step-mention-source.spec：`@step` 提及源回归。
 *
 * 锁住的契约（按对宿主 ui-input-trigger 的实际影响排序）：
 * 1. **作用域守卫**：不属于任何 sandore 实例的会话 → 空候选 / 无 lexicon（空组不渲染，
 *    主会话与其它插件的子代理 `@` 菜单不被污染），且 pick 拒绝伪造的 value；
 * 2. 候选生成（label/描述/分组标题/icon/value）与**唯一 label**（重名/重试段补 `#n`）；
 * 3. `onPick` 返回 `{insert:{source,ref,label,clipboardText}}` 形状；
 * 4. **codec 绝不抛**：正常序列化成 `<step …>` 上下文块；条目消失/ref 不可解析时降级为
 *    纯文本（ui-input-trigger 的失败策略是「serialize 抛错 ⇒ 整次发送被阻断」，对可选
 *    引用太重）；
 * 5. lexicon 同步性（`undefined`/`[]` 语义）与注册容错（缺服务/重复注册不崩）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-mention-source.spec
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { zh } from './locales.ts'
import { clearStepChatRegistry, installStepChatInstance, buildStepMentionEntries } from './step-chat-registry.ts'
import {
  createStepMentionSource,
  registerStepMentionSource,
  STEP_MENTION_SOURCE,
  stepMentionCandidateOf,
  stepMentionClipboardTextOf,
  stepMentionDescriptionOf,
  stepMentionEntriesFor,
  stepMentionSerializeRef,
  type StepMentionSourceLike,
} from './step-mention-source.ts'

afterEach(() => { clearStepChatRegistry() })

/** sandore zh 字典桩翻译（与其它 client spec 同款）。 */
function makeT() {
  const lookup = zh as unknown as Record<string, string>
  return (key: string, params?: Record<string, unknown>): string => {
    let text = lookup[key] ?? key
    if (params !== undefined) {
      for (const [name, value] of Object.entries(params)) {
        text = text.replaceAll(`{${name}}`, String(value))
      }
    }
    return text
  }
}
const t = makeT() as never

/** 登记两个 step 的实例（重名段用于唯一 label 断言）。 */
function registerInstance(instanceId = 'inst-1'): void {
  const entries = buildStepMentionEntries([
    {
      id: 'seg-1',
      stepId: 'step-a',
      name: '构建',
      status: 'completed',
      output: [{ type: 'text', text: '构建完成' }],
      artifacts: ['/tmp/out.txt'],
      sessionMeta: { childId: 'child-1', synthetic: false },
    },
    {
      id: 'seg-2',
      stepId: 'step-b',
      name: '构建',
      status: 'failed',
      attemptIndex: 1,
      sessionMeta: { childId: 'child-2', synthetic: false },
    },
  ], instanceId)
  installStepChatInstance(instanceId, entries)
}

describe('作用域守卫（source 注册在 client 根，必须自证会话归属）', () => {
  it('answers no candidates for a session outside every sandore instance', async () => {
    registerInstance()
    const source = createStepMentionSource(t)
    expect(await source.candidates({ sessionId: 'main-session' }, { query: '' })).toEqual([])
    expect(await source.candidates({ sessionId: 'other-plugin-child' }, { query: '构建' })).toEqual([])
    expect(source.lexicon?.({ sessionId: 'main-session' })).toEqual([])
    expect(stepMentionEntriesFor('main-session', '')).toEqual([])
  })

  it('serves candidates for the step child sessions of a registered instance', async () => {
    registerInstance()
    const source = createStepMentionSource(t)
    const items = await source.candidates({ sessionId: 'child-1' }, { query: '' })
    expect(items.map(item => item.name)).toEqual(['构建', '构建#2'])
    expect(source.lexicon?.({ sessionId: 'child-2' })).toEqual(['构建', '构建#2'])
  })

  it('refuses a forged value that belongs to another session', () => {
    registerInstance()
    const source = createStepMentionSource(t)
    const forged = stepMentionCandidateOf(t, {
      stepId: 'step-a',
      instanceId: 'inst-1',
      sessionId: 'child-1',
      name: '构建',
      label: '构建',
      status: 'completed',
      attemptIndex: 0,
      artifacts: [],
    })
    expect(source.onPick?.({ candidate: forged, session: { sessionId: 'child-2' } })).toBeUndefined()
    expect(source.onPick?.({ candidate: forged, session: { sessionId: 'child-1' } })).toBeDefined()
    expect(source.onPick?.({
      candidate: { name: 'x', value: 'not-json' },
      session: { sessionId: 'child-1' },
    })).toBeUndefined()
  })
})

describe('候选生成（形状 / 描述 / 唯一 label / 查询过滤）', () => {
  it('shapes the ui-input-trigger candidate contract', async () => {
    registerInstance()
    const source = createStepMentionSource(t)
    const [first, second] = await source.candidates({ sessionId: 'child-1' }, { query: '' })
    expect(first).toEqual({
      name: '构建',
      description: '已完成 · 1 个产物',
      icon: 'session',
      section: '步骤',
      value: JSON.stringify({ instanceId: 'inst-1', stepId: 'step-a' }),
    })
    // 唯一 label：同名第二段补 #2（attemptIndex=1 → n=2）。
    expect(second?.name).toBe('构建#2')
    expect(second?.description).toBe('失败 · 无产物')
  })

  it('filters by the live query and honours an aborted signal', async () => {
    registerInstance()
    const source = createStepMentionSource(t)
    expect((await source.candidates({ sessionId: 'child-1' }, { query: '构建#2' })).map(i => i.name))
      .toEqual(['构建#2'])
    const aborted = new AbortController()
    aborted.abort()
    expect(await source.candidates({ sessionId: 'child-1' }, { query: '', signal: aborted.signal }))
      .toEqual([])
  })

  it('describes unknown statuses literally instead of inventing copy', () => {
    expect(stepMentionDescriptionOf(t, {
      stepId: 's',
      instanceId: 'i',
      sessionId: 'c',
      name: 'x',
      label: 'x',
      status: 'mystery',
      attemptIndex: 0,
      artifacts: ['a', 'b'],
    })).toBe('mystery · 2 个产物')
  })
})

describe('onPick（引用注入形状）', () => {
  it('returns the insert shape with a self-contained ref', async () => {
    registerInstance()
    const source = createStepMentionSource(t)
    const [candidate] = await source.candidates({ sessionId: 'child-1' }, { query: '' })
    const outcome = source.onPick?.({ candidate: candidate!, session: { sessionId: 'child-1' } })
    expect(outcome).toEqual({
      insert: {
        source: STEP_MENTION_SOURCE,
        ref: JSON.stringify({ instanceId: 'inst-1', stepId: 'step-a' }),
        label: '构建',
        clipboardText: '@构建',
      },
    })
  })
})

describe('codec（序列化绝不抛）', () => {
  it('expands a chip into the model context block', async () => {
    registerInstance()
    const source = createStepMentionSource(t)
    const ref = JSON.stringify({ instanceId: 'inst-1', stepId: 'step-a' })
    const text = await source.codec!.serialize(ref, new AbortController().signal)
    expect(text).toBe([
      '<step name="构建" step-id="step-a" status="completed" attempt="1">',
      'output:',
      '构建完成',
      'artifacts:',
      '- /tmp/out.txt',
      '</step>',
    ].join('\n'))
    expect(source.codec!.clipboardText(ref)).toBe('@构建')
  })

  it('downgrades to a localized note when the entry is gone instead of blocking the send', async () => {
    const ref = JSON.stringify({ instanceId: 'inst-1', stepId: 'step-a' })
    // 实例已注销（step 卡卸载）：回查不到 → 说明性纯文本，仍可发送。
    await expect(createStepMentionSource(t).codec!.serialize(ref, new AbortController().signal))
      .resolves.toBe('步骤「step-a」的上下文暂不可用，已按名称引用')
    expect(stepMentionClipboardTextOf(ref)).toBe('@step-a')
  })

  it('never throws on malformed refs', () => {
    expect(stepMentionSerializeRef('not-json', t)).toBe('not-json')
    expect(stepMentionSerializeRef('', t)).toBe(' ')
    expect(stepMentionSerializeRef('null', t)).toBe('null')
    expect(stepMentionClipboardTextOf('not-json')).toBe('not-json')
    // ref 解析本身抛错（环境异常/被破坏的全局）→ 仍返回字符串，不向上抛。
    const broken = vi.spyOn(JSON, 'parse').mockImplementation(() => { throw new Error('boom') })
    const ref = JSON.stringify({ instanceId: 'inst-1', stepId: 'step-a' })
    expect(stepMentionSerializeRef(ref, t)).toBe(ref)
    expect(stepMentionClipboardTextOf(ref)).toBe(ref)
    broken.mockRestore()
  })

  it('rebuilds failed-send drafts through the clipboard projection (chip survives)', async () => {
    registerInstance()
    const source = createStepMentionSource(t)
    const ref = stepMentionCandidateOf(t, {
      stepId: 'step-b',
      instanceId: 'inst-1',
      sessionId: 'child-2',
      name: '构建',
      label: '构建#2',
      status: 'failed',
      attemptIndex: 1,
      artifacts: [],
    }).value!
    expect(source.codec!.clipboardText(ref)).toBe('@构建#2')
    await expect(source.codec!.serialize(ref, new AbortController().signal))
      .resolves.toContain('<step name="构建#2" step-id="step-b" status="failed" attempt="2">')
  })
})

describe('lexicon / subscribeLexicon（纯文本染色兜底）', () => {
  it('answers synchronously and never fetches', () => {
    const source: StepMentionSourceLike = createStepMentionSource(t)
    expect(source.lexicon?.({ sessionId: 'child-1' })).toEqual([]) // 未登记 → 空
    registerInstance()
    // 裸名与唯一 label 都给（重试段同名，只给裸名会命中多段）。
    expect(source.lexicon?.({ sessionId: 'child-1' })).toEqual(['构建', '构建#2'])
  })

  it('forwards registry changes to the controller listener and unsubscribes', () => {
    const source = createStepMentionSource(t)
    let ticks = 0
    const off = source.subscribeLexicon!({ sessionId: 'child-1' }, () => { ticks += 1 })
    registerInstance()
    expect(ticks).toBe(1)
    off()
    clearStepChatRegistry()
    expect(ticks).toBe(1)
  })
})

describe('registerStepMentionSource（装配容错）', () => {
  it('no-ops without the inputTriggers service', () => {
    const dispose = registerStepMentionSource(undefined, t)
    expect(() => { dispose() }).not.toThrow()
  })

  it('registers the @step source and returns the registry disposer', () => {
    const registered: StepMentionSourceLike[] = []
    const unregister = vi.fn()
    const dispose = registerStepMentionSource({
      registerSource: (source) => { registered.push(source); return unregister },
    }, t)
    expect(registered).toHaveLength(1)
    expect(registered[0]?.trigger).toBe('@')
    expect(registered[0]?.name).toBe(STEP_MENTION_SOURCE)
    dispose()
    expect(unregister).toHaveBeenCalled()
  })

  it('warns instead of throwing on duplicate registration', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dispose = registerStepMentionSource({
      registerSource: () => { throw new Error('slash source "@step" is already registered') },
    }, t)
    expect(warn).toHaveBeenCalled()
    expect(() => { dispose() }).not.toThrow()
    warn.mockRestore()
  })
})
