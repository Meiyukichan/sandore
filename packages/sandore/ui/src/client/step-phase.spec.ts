/**
 * step-phase.ts（sandore/step-phase 客户端订阅通道）的单元测试：
 * `match` 命中 sandore/step-phase 并派生唯一 start 上下文 id、
 * `start` 触发模块级通知（订阅者即 RunView 的即时刷新触发器）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-phase.spec
 */
import type { ConversationEventInput, ConversationMatch } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'

import { stepPhaseDefinition, subscribeStepPhase } from './step-phase.ts'

/** 构造最小 log-only 事件信封；sandore/step-phase 非 surface 事件，无 surfaceOp。 */
function at(seq: number, type: string, data: unknown): ConversationEventInput {
  return { event: { seq, time: seq * 100, type, data } as ConversationEventInput['event'], view: undefined }
}

/** 构造 start Match（location 取 unresolved，逻辑不依赖）。 */
function matched(input: ConversationEventInput, role: ConversationMatch['role']): ConversationMatch {
  return { ...input, role, location: { kind: 'unresolved' } }
}

/** start 函数的第三个入参（strictly-backward 查询，本定义不使用）。 */
const reader: Parameters<typeof stepPhaseDefinition.start>[2] = { previous: () => undefined }

/** 构造 start 用的 Context（key/id 仅占位，start 逻辑不读取）。 */
function startContext(match: ConversationMatch): Parameters<typeof stepPhaseDefinition.start>[0] {
  return {
    key: '30:sandore-step-phasex@1',
    kind: 'sandore-step-phase',
    id: 'x@1',
    matches: [match],
    start: match,
    state: undefined,
    current: new Map(),
  }
}

describe('stepPhaseDefinition.match', () => {
  it('treats sandore/step-phase as a unique start with a seq-unique id', () => {
    expect(stepPhaseDefinition.match(at(1, 'sandore/step-phase', {
      stepId: 'step-a', childId: 'child-1', phase: 'finalizing', name: 'Research',
    }).event)).toEqual({ id: 'step-a#finalizing@1', role: 'start' })
  })

  it('ignores unrelated events', () => {
    expect(stepPhaseDefinition.match(at(1, 'sandore/step-start', {
      stepId: 'step-a', childId: 'child-1', name: 'Research',
    }).event)).toBeNull()
    expect(stepPhaseDefinition.match(at(1, 'user/message', { id: 'm' }).event)).toBeNull()
  })

  it('assigns distinct ids across phases and replays (same stepId re-finalize)', () => {
    const first = stepPhaseDefinition.match(at(1, 'sandore/step-phase', {
      stepId: 'step-a', childId: 'child-1', phase: 'finalizing', name: 'Research',
    }).event)
    const second = stepPhaseDefinition.match(at(2, 'sandore/step-phase', {
      stepId: 'step-a', childId: 'child-1', phase: 'completed', name: 'Research',
    }).event)
    expect(first?.id).toBe('step-a#finalizing@1')
    expect(second?.id).toBe('step-a#completed@2')
  })

  it('matches the Phase D routing phase event (currentPhase=routing)', () => {
    expect(stepPhaseDefinition.match(at(6, 'sandore/step-phase', {
      stepId: 'step-a', childId: 'child-1', phase: 'routing', name: 'Research',
    }).event)).toEqual({ id: 'step-a#routing@6', role: 'start' })
  })
})

describe('stepPhaseDefinition.start', () => {
  it('notifies subscribers (RunView immediate refresh trigger)', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeStepPhase(listener)
    const startMatch = matched(at(3, 'sandore/step-phase', {
      stepId: 'step-a', childId: 'child-1', phase: 'gating', name: 'Research',
    }), 'start')
    stepPhaseDefinition.start(startContext(startMatch), startMatch, reader)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeStepPhase(listener)
    unsubscribe()
    const startMatch = matched(at(4, 'sandore/step-phase', {
      stepId: 'step-a', childId: 'child-1', phase: 'completed', name: 'Research',
    }), 'start')
    stepPhaseDefinition.start(startContext(startMatch), startMatch, reader)
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps notifying other listeners when one throws', () => {
    const failing = vi.fn(() => { throw new Error('boom') })
    const healthy = vi.fn()
    const unsubscribeFailing = subscribeStepPhase(failing)
    const unsubscribeHealthy = subscribeStepPhase(healthy)
    try {
      const startMatch = matched(at(5, 'sandore/step-phase', {
        stepId: 'step-a', childId: 'child-1', phase: 'ask-detect', name: 'Research',
      }), 'start')
      stepPhaseDefinition.start(startContext(startMatch), startMatch, reader)
      expect(healthy).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribeFailing()
      unsubscribeHealthy()
    }
  })
})
