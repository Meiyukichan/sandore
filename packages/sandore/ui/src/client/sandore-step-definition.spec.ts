/**
 * sandore-step-definition.ts 的折叠状态机纯函数单元测试：
 * `match` 命中 6 个 step-* 事件并派生节点 id、`start` 建 running 态、
 * `update` 折叠 completed/failed/paused/resumed/retried、`buildViewNode`
 * 投影 keyed payload（含循环迭代标签）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/sandore-step-definition.spec
 */
import type { ConversationEventInput, ConversationMatch } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it } from 'vitest'

import {
  loopLabelOf, nodeIdOf, sandoreStepDefinition, type SandoreStepChatData,
} from './sandore-step-definition.ts'

/** 构造最小 log-only 事件信封；sandore/step-* 非 surface 事件，无 surfaceOp。 */
function at(seq: number, type: string, data: unknown): ConversationEventInput {
  return { event: { seq, time: seq * 100, type, data } as ConversationEventInput['event'], view: undefined }
}

/** 构造 start/update Match（location 取 unresolved，逻辑不依赖）。 */
function matched(input: ConversationEventInput, role: ConversationMatch['role']): ConversationMatch {
  return { ...input, role, location: { kind: 'unresolved' } }
}

/** start 函数的第三个入参（strictly-backward 查询，本定义不使用）。 */
const reader: Parameters<typeof sandoreStepDefinition.start>[2] = { previous: () => undefined }

/** 构造 start 用的 Context（key/id 仅占位，start/update 逻辑不读取）。 */
function startContext(match: ConversationMatch): Parameters<typeof sandoreStepDefinition.start>[0] {
  return {
    key: '12:sandore-stepstep-1',
    kind: 'sandore-step',
    id: 'step-1',
    matches: [match],
    start: match,
    state: undefined,
    current: new Map(),
  }
}

/** 以 running 态（step-start）为起点，逐步折叠后续事件并返回最终状态。 */
function fold(events: readonly ConversationEventInput[]): Parameters<typeof sandoreStepDefinition.update>[0] {
  const start = events[0]!
  const startMatch = matched(start, 'start')
  const state = sandoreStepDefinition.start(startContext(startMatch), startMatch, reader)
  let context: Parameters<typeof sandoreStepDefinition.update>[0] = {
    ...startContext(startMatch),
    state,
  }
  for (const input of events.slice(1)) {
    context = { ...context, state: sandoreStepDefinition.update(context, matched(input, 'update')) }
  }
  return context
}

describe('nodeIdOf / loopLabelOf', () => {
  it('uses the bare stepId when no loop iteration is present', () => {
    expect(nodeIdOf('step-a', undefined)).toBe('step-a')
    expect(nodeIdOf('step-a', [])).toBe('step-a')
  })

  it('derives the node id from the flat loop-iteration path', () => {
    expect(nodeIdOf('step-a', [1, 2])).toBe('step-a#1.2')
    expect(loopLabelOf([1, 2])).toBe('#1.2')
  })

  it('distinguishes two loop iterations of the same step', () => {
    expect(nodeIdOf('step-a', [1])).not.toBe(nodeIdOf('step-a', [2]))
  })
})

describe('sandoreStepDefinition.match', () => {
  it('treats step-start as the unique start with a bare id', () => {
    expect(sandoreStepDefinition.match(at(1, 'sandore/step-start', {
      stepId: 'step-a', childId: 'child-1', name: 'Research',
    }).event)).toEqual({ id: 'step-a', role: 'start' })
  })

  it('derives a loop-iteration id for a looped step-start', () => {
    expect(sandoreStepDefinition.match(at(1, 'sandore/step-start', {
      stepId: 'step-a', childId: 'child-1', name: 'Research', loopIteration: [1, 2],
    }).event)).toEqual({ id: 'step-a#1.2', role: 'start' })
  })

  it.each([
    ['sandore/step-completed', { stepId: 'step-a', childId: 'child-1', output: [], name: 'Research' }],
    ['sandore/step-failed', { stepId: 'step-a', childId: 'child-1', error: 'boom', name: 'Research' }],
    ['sandore/step-paused', { stepId: 'step-a', childId: 'child-1', name: 'Research' }],
    ['sandore/step-resumed', { stepId: 'step-a', childId: 'child-1', name: 'Research' }],
    ['sandore/step-retried', { stepId: 'step-a', mode: 'continue', name: 'Research' }],
  ] as const)('treats %s as an update', (type, data) => {
    expect(sandoreStepDefinition.match(at(1, type, data).event)).toEqual({ id: 'step-a', role: 'update' })
  })

  it('ignores unrelated events', () => {
    expect(sandoreStepDefinition.match(at(1, 'sandore/start', { taskId: 't', workflowId: 'w', jobId: 'j' }).event)).toBeNull()
    expect(sandoreStepDefinition.match(at(1, 'user/message', { id: 'm' }).event)).toBeNull()
  })

  it('assigns distinct ids across loop iterations', () => {
    const first = sandoreStepDefinition.match(at(1, 'sandore/step-start', {
      stepId: 'step-a', childId: 'child-1', name: 'Loop', loopIteration: [1],
    }).event)
    const second = sandoreStepDefinition.match(at(2, 'sandore/step-start', {
      stepId: 'step-a', childId: 'child-2', name: 'Loop', loopIteration: [2],
    }).event)
    expect(first?.id).toBe('step-a#1')
    expect(second?.id).toBe('step-a#2')
  })
})

describe('sandoreStepDefinition.start', () => {
  it('builds a running state from step-start', () => {
    const startMatch = matched(at(1, 'sandore/step-start', {
      stepId: 'step-a', childId: 'child-1', name: 'Research',
    }), 'start')
    expect(sandoreStepDefinition.start(startContext(startMatch), startMatch, reader)).toEqual({
      stepId: 'step-a', childId: 'child-1', name: 'Research', status: 'running', synthetic: true,
    })
  })

  it('rejects a non step-start start match', () => {
    const startMatch = matched(at(1, 'sandore/step-completed', {
      stepId: 'step-a', childId: 'child-1', output: [], name: 'Research',
    }), 'start')
    expect(() => sandoreStepDefinition.start(startContext(startMatch), startMatch, reader))
      .toThrow('sandore-step start requires sandore/step-start')
  })
})

describe('sandoreStepDefinition.update', () => {
  it('folds step-completed into completed with inline text output', () => {
    const context = fold([
      at(1, 'sandore/step-start', { stepId: 'step-a', childId: 'child-1', name: 'Research' }),
      at(2, 'sandore/step-completed', {
        stepId: 'step-a', childId: 'child-1', name: 'Research',
        output: [{ type: 'text', text: 'done' }, { type: 'reasoning', text: 'hidden' }],
      }),
    ])
    expect(context.state.status).toBe('completed')
    expect(context.state.output).toEqual([{ type: 'text', text: 'done' }])
  })

  it('folds step-failed into failed with the error', () => {
    const context = fold([
      at(1, 'sandore/step-start', { stepId: 'step-a', childId: 'child-1', name: 'Research' }),
      at(2, 'sandore/step-failed', { stepId: 'step-a', childId: 'child-1', error: 'boom', name: 'Research' }),
    ])
    expect(context.state.status).toBe('failed')
    expect(context.state.error).toBe('boom')
  })

  it('folds step-paused into paused', () => {
    const context = fold([
      at(1, 'sandore/step-start', { stepId: 'step-a', childId: 'child-1', name: 'Research' }),
      at(2, 'sandore/step-paused', { stepId: 'step-a', childId: 'child-1', name: 'Research' }),
    ])
    expect(context.state.status).toBe('paused')
  })

  it('returns to running on step-resumed and step-retried', () => {
    const resumed = fold([
      at(1, 'sandore/step-start', { stepId: 'step-a', childId: 'child-1', name: 'Research' }),
      at(2, 'sandore/step-paused', { stepId: 'step-a', childId: 'child-1', name: 'Research' }),
      at(3, 'sandore/step-resumed', { stepId: 'step-a', childId: 'child-1', name: 'Research' }),
    ])
    expect(resumed.state.status).toBe('running')

    const retried = fold([
      at(1, 'sandore/step-start', { stepId: 'step-a', childId: 'child-1', name: 'Research' }),
      at(2, 'sandore/step-failed', { stepId: 'step-a', childId: 'child-1', error: 'boom', name: 'Research' }),
      at(3, 'sandore/step-retried', { stepId: 'step-a', mode: 'revert', name: 'Research' }),
    ])
    expect(retried.state.status).toBe('running')
  })

  it('overrides childId with the real session id and clears synthetic on step-completed', () => {
    const context = fold([
      at(1, 'sandore/step-start', { stepId: 'step-a', childId: 'step-a-abc12345', name: 'Research' }),
      at(2, 'sandore/step-completed', {
        stepId: 'step-a', childId: 'child-1', name: 'Research',
        output: [{ type: 'text', text: 'done' }],
      }),
    ])
    expect(context.state.status).toBe('completed')
    expect(context.state.childId).toBe('child-1')
    expect(context.state.synthetic).toBe(false)
  })

  it('keeps the synthetic placeholder when the payload childId is unchanged (shell)', () => {
    const context = fold([
      at(1, 'sandore/step-start', { stepId: 'step-a', childId: 'step-a-abc12345', name: 'Shell' }),
      at(2, 'sandore/step-completed', {
        stepId: 'step-a', childId: 'step-a-abc12345', name: 'Shell',
        output: [{ type: 'text', text: 'ok' }],
      }),
    ])
    expect(context.state.status).toBe('completed')
    expect(context.state.childId).toBe('step-a-abc12345')
    expect(context.state.synthetic).toBe(true)
  })

  it('overrides childId and clears synthetic on step-paused/step-resumed', () => {
    const context = fold([
      at(1, 'sandore/step-start', { stepId: 'step-a', childId: 'step-a-abc12345', name: 'Agent' }),
      at(2, 'sandore/step-paused', { stepId: 'step-a', childId: 'child-1', name: 'Agent' }),
      at(3, 'sandore/step-resumed', { stepId: 'step-a', childId: 'child-1', name: 'Agent' }),
    ])
    expect(context.state.status).toBe('running')
    expect(context.state.childId).toBe('child-1')
    expect(context.state.synthetic).toBe(false)
  })

  it('keeps childId and synthetic across step-retried (payload has no childId)', () => {
    const context = fold([
      at(1, 'sandore/step-start', { stepId: 'step-a', childId: 'child-1', name: 'Research' }),
      at(2, 'sandore/step-failed', { stepId: 'step-a', childId: 'child-1', error: 'boom', name: 'Research' }),
      at(3, 'sandore/step-retried', { stepId: 'step-a', mode: 'revert', name: 'Research' }),
    ])
    expect(context.state.status).toBe('running')
    expect(context.state.childId).toBe('child-1')
    expect(context.state.synthetic).toBe(true)
  })

  it('returns the same state for an unrelated update event', () => {
    const context = fold([
      at(1, 'sandore/step-start', { stepId: 'step-a', childId: 'child-1', name: 'Research' }),
    ])
    const next = sandoreStepDefinition.update(context, matched(at(2, 'sandore/stage-start', { taskId: 't', stageId: 's' }), 'update'))
    expect(next).toBe(context.state)
  })
})

describe('sandoreStepDefinition.buildViewNode', () => {
  it('projects a completed looped step with inline output and loop label', () => {
    const context = fold([
      at(1, 'sandore/step-start', { stepId: 'step-a', childId: 'child-1', name: 'Research', loopIteration: [1, 2] }),
      at(2, 'sandore/step-completed', {
        stepId: 'step-a', childId: 'child-1', name: 'Research', loopIteration: [1, 2],
        output: [{ type: 'text', text: 'result' }],
      }),
    ])
    const node = sandoreStepDefinition.buildViewNode?.(context)
    expect(node).not.toBeNull()
    expect(node?.kind).toBe('sandore-step')
    expect(node?.target).toBe('chat')
    const data = node?.data as SandoreStepChatData
    expect(data).toEqual({
      stepId: 'step-a', childId: 'child-1', name: 'Research', status: 'completed',
      loopLabel: '#1.2', synthetic: true, output: [{ type: 'text', text: 'result' }],
    })
  })

  it('returns null when there is no start match', () => {
    const context: Parameters<NonNullable<typeof sandoreStepDefinition.buildViewNode>>[0] = {
      key: '12:sandore-stepstep-1',
      kind: 'sandore-step',
      id: 'step-1',
      matches: [],
      start: undefined,
      state: undefined,
      current: new Map(),
    }
    expect(sandoreStepDefinition.buildViewNode?.(context)).toBeNull()
  })
})
