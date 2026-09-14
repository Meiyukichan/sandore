/**
 * step-chat-registry.spec：@step 登记表（模块级 Map）与纯函数回归。
 *
 * 锁四件事：
 * 1. **登记/更新/清理的生命周期配对**（含「同实例重挂不误删后写」「旧 disposer 不误删
 *    新登记」——面板 HMR/多次挂载的真实竞态）；
 * 2. **多实例隔离 + 作用域索引**（同一子会话只归属第一个登记它的实例；注销后索引重算；
 *    `clearStepChatRegistry` 清空）；
 * 3. **候选取自 state 片段**（`buildStepMentionEntries`：合成会话/无 childId/无 stepId
 *    跳过；输出文本拼接；artifacts 拷贝）；
 * 4. **唯一 label / 查询过滤 / ref 编解码 / 上下文块形状**（含截断上限）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-chat-registry.spec
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildStepMentionEntries,
  clearStepChatRegistry,
  installStepChatInstance,
  STEP_MENTION_OUTPUT_LIMIT,
  stepChatEntriesOf,
  stepChatEntryOf,
  stepChatInstanceOf,
  stepChatReuseSegments,
  stepMentionBlockOf,
  stepMentionCandidatesOf,
  stepMentionLabelOf,
  stepMentionOutputTextOf,
  stepMentionRefOf,
  stepMentionRefParse,
  stepMentionStepEqual,
  subscribeStepChatRegistry,
  type StepMentionStepLike,
} from './step-chat-registry.ts'

afterEach(() => { clearStepChatRegistry() })

/** state 片段桩（executedSteps 的形状子集）。 */
function stepOf(overrides: Partial<StepMentionStepLike> & { id?: string } = {}): StepMentionStepLike {
  return {
    id: overrides.id ?? 'seg-1',
    stepId: overrides.stepId ?? 'step-a',
    name: overrides.name ?? '构建',
    status: overrides.status ?? 'completed',
    attemptIndex: overrides.attemptIndex,
    output: overrides.output,
    artifacts: overrides.artifacts,
    sessionMeta: overrides.sessionMeta ?? { childId: 'child-1', synthetic: false },
  }
}

describe('登记表生命周期（install / update / dispose）', () => {
  it('registers, indexes the child session, and clears on dispose', () => {
    const entries = buildStepMentionEntries([stepOf()], 'inst-1')
    const dispose = installStepChatInstance('inst-1', entries)
    expect(stepChatInstanceOf('child-1')).toBe('inst-1')
    expect(stepChatEntriesOf('child-1')).toHaveLength(1)
    expect(stepChatEntryOf('inst-1', 'step-a')?.label).toBe('构建')
    dispose()
    expect(stepChatInstanceOf('child-1')).toBeUndefined()
    expect(stepChatEntriesOf('child-1')).toEqual([])
    expect(stepChatEntryOf('inst-1', 'step-a')).toBeUndefined()
  })

  it('updates in place when the same instance registers again (steps change)', () => {
    const disposeA = installStepChatInstance('inst-1', buildStepMentionEntries([stepOf()], 'inst-1'))
    const disposeB = installStepChatInstance('inst-1', buildStepMentionEntries([
      stepOf(),
      stepOf({ id: 'seg-2', stepId: 'step-b', name: '测试', sessionMeta: { childId: 'child-2', synthetic: false } }),
    ], 'inst-1'))
    expect(stepChatEntriesOf('child-1')).toHaveLength(2) // 后写覆盖
    expect(stepChatInstanceOf('child-2')).toBe('inst-1')
    // 旧 disposer 不得删掉新登记（同实例面板重挂的真实竞态）。
    disposeA()
    expect(stepChatEntriesOf('child-1')).toHaveLength(2)
    disposeB()
    expect(stepChatInstanceOf('child-1')).toBeUndefined()
  })

  it('keeps instances isolated and reindexes on dispose', () => {
    const disposeA = installStepChatInstance('inst-1', buildStepMentionEntries([stepOf()], 'inst-1'))
    const disposeB = installStepChatInstance('inst-2', buildStepMentionEntries([
      stepOf({ stepId: 'step-z', name: '部署', sessionMeta: { childId: 'child-9', synthetic: false } }),
    ], 'inst-2'))
    expect(stepChatInstanceOf('child-1')).toBe('inst-1')
    expect(stepChatInstanceOf('child-9')).toBe('inst-2')
    expect(stepChatEntriesOf('child-1').map(entry => entry.stepId)).toEqual(['step-a'])
    expect(stepChatEntriesOf('child-9').map(entry => entry.stepId)).toEqual(['step-z'])
    disposeA()
    expect(stepChatInstanceOf('child-1')).toBeUndefined()
    expect(stepChatInstanceOf('child-9')).toBe('inst-2') // 另一个实例不受影响
    disposeB()
    expect(stepChatInstanceOf('child-9')).toBeUndefined()
  })

  it('notifies subscribers on register/dispose and stops after unsubscribe', () => {
    const seen: number[] = []
    const off = subscribeStepChatRegistry(() => { seen.push(1) })
    const dispose = installStepChatInstance('inst-1', buildStepMentionEntries([stepOf()], 'inst-1'))
    dispose()
    expect(seen).toHaveLength(2)
    off()
    installStepChatInstance('inst-1', buildStepMentionEntries([stepOf()], 'inst-1'))
    expect(seen).toHaveLength(2)
  })

  it('contains a throwing subscriber so registration still stands', () => {
    // console.error 是实现的兜底；订阅者抛出不得打断登记/注销本身。
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const off = subscribeStepChatRegistry(() => { throw new Error('boom') })
    const dispose = installStepChatInstance('inst-1', buildStepMentionEntries([stepOf()], 'inst-1'))
    expect(stepChatInstanceOf('child-1')).toBe('inst-1')
    dispose()
    expect(stepChatInstanceOf('child-1')).toBeUndefined()
    expect(errors).toHaveBeenCalled()
    off()
    errors.mockRestore()
  })
})

describe('buildStepMentionEntries（从 state 片段构造条目）', () => {
  it('skips synthetic sessions, missing childId and empty stepId', () => {
    const entries = buildStepMentionEntries([
      stepOf(),
      stepOf({ id: 'seg-shell', stepId: 'step-shell', sessionMeta: { synthetic: true } }),
      stepOf({ id: 'seg-nosession', stepId: 'step-n', sessionMeta: { synthetic: false } }),
      stepOf({ id: '', stepId: '', sessionMeta: { childId: 'child-x', synthetic: false } }),
    ], 'inst-1')
    expect(entries.map(entry => entry.stepId)).toEqual(['step-a'])
  })

  it('reads output text blocks, artifacts, status and attempt index', () => {
    const entries = buildStepMentionEntries([
      stepOf({
        output: [
          { type: 'text', text: '第一段' },
          { type: 'image', text: 'ignored' },
          { type: 'text', text: '第二段' },
        ],
        artifacts: ['/tmp/a.txt', '/tmp/b.txt'],
        status: 'failed',
        attemptIndex: 2,
      }),
    ], 'inst-1')
    expect(entries[0]).toMatchObject({
      stepId: 'step-a',
      instanceId: 'inst-1',
      sessionId: 'child-1',
      name: '构建',
      status: 'failed',
      attemptIndex: 2,
      outputText: '第一段\n第二段',
      artifacts: ['/tmp/a.txt', '/tmp/b.txt'],
    })
    // attemptIndex>0 → 补 #n（第 3 次执行段）。
    expect(entries[0]?.label).toBe('构建#3')
  })

  it('returns an empty list for missing/undefined segments', () => {
    expect(buildStepMentionEntries(undefined, 'inst-1')).toEqual([])
    expect(buildStepMentionEntries([], 'inst-1')).toEqual([])
  })

  it('reads output text defensively', () => {
    expect(stepMentionOutputTextOf(undefined)).toBeUndefined()
    expect(stepMentionOutputTextOf([])).toBeUndefined()
    expect(stepMentionOutputTextOf([{ type: 'image' }])).toBeUndefined()
    expect(stepMentionOutputTextOf([{ text: 42 }])).toBeUndefined()
    expect(stepMentionOutputTextOf([{ text: '' }])).toBeUndefined()
    expect(stepMentionOutputTextOf([{ text: 'x' }])).toBe('x')
  })
})

describe('唯一 label / 候选过滤', () => {
  it('keeps the bare name for the first segment and suffixes repeats', () => {
    const taken = new Set<string>()
    expect(stepMentionLabelOf('构建', 0, taken)).toBe('构建')
    taken.add('构建')
    expect(stepMentionLabelOf('构建', 0, taken)).toBe('构建#1')
    expect(stepMentionLabelOf('构建', 2, taken)).toBe('构建#3')
    // 空白名兜底（不产出空 label）。
    expect(stepMentionLabelOf('', 0, new Set())).toBe('step')
  })

  it('filters by label or name, case-insensitively, keeping order', () => {
    const entries = buildStepMentionEntries([
      stepOf({ stepId: 'step-a', name: 'Build' }),
      stepOf({ id: 'seg-2', stepId: 'step-b', name: '构建', sessionMeta: { childId: 'child-2', synthetic: false } }),
    ], 'inst-1')
    expect(stepMentionCandidatesOf(entries, '')).toHaveLength(2) // 空查询 = 全部
    expect(stepMentionCandidatesOf(entries, '  ')).toHaveLength(2)
    expect(stepMentionCandidatesOf(entries, 'buil').map(entry => entry.stepId)).toEqual(['step-a'])
    expect(stepMentionCandidatesOf(entries, '构建').map(entry => entry.stepId)).toEqual(['step-b'])
    expect(stepMentionCandidatesOf(entries, 'zzz')).toEqual([])
  })
})

describe('ref 编解码与上下文块', () => {
  it('round-trips the ref and rejects malformed payloads', () => {
    const ref = stepMentionRefOf('inst-1', 'step-a')
    expect(stepMentionRefParse(ref)).toEqual({ instanceId: 'inst-1', stepId: 'step-a' })
    expect(stepMentionRefParse('not-json')).toBeUndefined()
    expect(stepMentionRefParse('null')).toBeUndefined()
    expect(stepMentionRefParse('{}')).toBeUndefined()
    expect(stepMentionRefParse(JSON.stringify({ instanceId: '', stepId: 'x' }))).toBeUndefined()
    expect(stepMentionRefParse(JSON.stringify({ instanceId: 'x', stepId: '' }))).toBeUndefined()
  })

  it('renders the model context block with output and artifacts', () => {
    const [entry] = buildStepMentionEntries([
      stepOf({ output: [{ type: 'text', text: 'done' }], artifacts: ['/tmp/out.txt'] }),
    ], 'inst-1')
    expect(stepMentionBlockOf(entry!)).toBe([
      '<step name="构建" step-id="step-a" status="completed" attempt="1">',
      'output:',
      'done',
      'artifacts:',
      '- /tmp/out.txt',
      '</step>',
    ].join('\n'))
  })

  it('omits empty sections and truncates a huge output', () => {
    const [bare] = buildStepMentionEntries([stepOf()], 'inst-1')
    expect(stepMentionBlockOf(bare!)).toBe(
      '<step name="构建" step-id="step-a" status="completed" attempt="1">\n</step>',
    )
    const [huge] = buildStepMentionEntries([
      stepOf({ output: [{ type: 'text', text: 'x'.repeat(STEP_MENTION_OUTPUT_LIMIT + 10) }] }),
    ], 'inst-1')
    const block = stepMentionBlockOf(huge!)
    expect(block).toContain('…')
    expect(block.length).toBeLessThan(STEP_MENTION_OUTPUT_LIMIT + 200)
  })
})

describe('引用稳定化（poller 每轮重建片段时保住 memo）', () => {
  it('compares display-relevant fields only', () => {
    expect(stepMentionStepEqual(stepOf(), stepOf())).toBe(true)
    expect(stepMentionStepEqual(stepOf(), stepOf({ name: '别的' }))).toBe(false)
    expect(stepMentionStepEqual(stepOf(), stepOf({ status: 'running' }))).toBe(false)
    expect(stepMentionStepEqual(stepOf(), stepOf({ attemptIndex: 1 }))).toBe(false)
    expect(stepMentionStepEqual(
      stepOf({ output: [{ type: 'text', text: 'a' }] }),
      stepOf({ output: [{ type: 'text', text: 'b' }] }),
    )).toBe(false)
    expect(stepMentionStepEqual(stepOf({ artifacts: ['a'] }), stepOf({ artifacts: ['a'] }))).toBe(true)
    expect(stepMentionStepEqual(stepOf({ artifacts: ['a'] }), stepOf({ artifacts: ['a', 'b'] }))).toBe(false)
    expect(stepMentionStepEqual(
      stepOf({ sessionMeta: { childId: 'child-1', synthetic: false } }),
      stepOf({ sessionMeta: { childId: 'child-2', synthetic: false } }),
    )).toBe(false)
  })

  it('reuses the previous array reference when every segment is equivalent', () => {
    const first = [stepOf()]
    const second = [stepOf()] // 新对象、同内容
    expect(stepChatReuseSegments(first, second)).toBe(first)
    expect(stepChatReuseSegments(first, [stepOf({ name: '变了' })])).not.toBe(first)
    expect(stepChatReuseSegments(first, [])).toEqual([])
  })
})
