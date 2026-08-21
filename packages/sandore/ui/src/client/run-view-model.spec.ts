/**
 * run-view-model.ts 的纯逻辑单元测试：7 态 StepStatus/DagRunStatus → StateDotState
 * 穷尽映射、运行中/终态判定（轮询控制）、pending 交互分类、retry message 校验。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/run-view-model.spec
 */
import { describe, expect, it } from 'vitest'

import type { PendingPermissionEntry, PendingQuestionEntry } from '@deepseek-ai/dsh-sandore-workflow/schema'

import {
  isBlank, isRunningStatus, isSubagentStep, isTerminalStatus, partitionInteractions, RETRY_MODES, runDotState,
  stepDotState, stepIdOf, relativeTimeOf, chatLinesOf,
} from './run-view-model.ts'
import type { ExecutedStep } from './run-view-model.ts'

/** 构造一个最小待答问题条目。 */
function questionEntry(id: string): PendingQuestionEntry {
  return {
    id,
    stageId: 'stg-1',
    stepId: 'step-1',
    sessionId: 'session-1',
    requestId: `req-${id}`,
    kind: 'question',
    status: 'pending',
    payload: { questions: [{ id: 'q1', question: 'what?' }] },
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

/** 构造一个最小待批权限条目。 */
function permissionEntry(id: string): PendingPermissionEntry {
  return {
    id,
    stageId: 'stg-1',
    stepId: 'step-1',
    sessionId: 'session-1',
    requestId: `req-${id}`,
    kind: 'permission',
    status: 'pending',
    payload: { permission: 'write' },
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

/** 构造最小 Step 快照（可覆盖 command/sessionMeta 等判定字段）。 */
function step(overrides: Partial<ExecutedStep> = {}): ExecutedStep {
  return {
    type: 'default',
    id: 'exec-1',
    stageId: 'stg-1',
    name: 'step',
    status: 'running',
    visitCount: 0,
    ...overrides,
  }
}

/** 构造子代理 sessionMeta（childId + synthetic + command）。 */
function sessionMeta(command: 'shell' | 'prompt' | 'agent' | 'skill' | 'mcp'): NonNullable<ExecutedStep['sessionMeta']> {
  return { childId: 'child-1', synthetic: false, command }
}

describe('stepDotState', () => {
  it('maps completed to done', () => {
    expect(stepDotState('completed')).toBe('done')
  })

  it('maps failed to error', () => {
    expect(stepDotState('failed')).toBe('error')
  })

  it('maps running to ongoing', () => {
    expect(stepDotState('running')).toBe('ongoing')
  })

  it('maps the remaining attention states to warning', () => {
    expect(stepDotState('interacting')).toBe('warning')
    expect(stepDotState('paused')).toBe('warning')
    expect(stepDotState('blocked')).toBe('warning')
    expect(stepDotState('ready')).toBe('warning')
  })
})

describe('runDotState', () => {
  it('maps completed to done', () => {
    expect(runDotState('completed')).toBe('done')
  })

  it('maps failed to error', () => {
    expect(runDotState('failed')).toBe('error')
  })

  it('maps running to ongoing', () => {
    expect(runDotState('running')).toBe('ongoing')
  })

  it('maps the remaining states to warning', () => {
    expect(runDotState('pending')).toBe('warning')
    expect(runDotState('interacting')).toBe('warning')
    expect(runDotState('aborted')).toBe('warning')
    expect(runDotState('paused')).toBe('warning')
  })
})

describe('isRunningStatus', () => {
  it('is true for running and interacting', () => {
    expect(isRunningStatus('running')).toBe(true)
    expect(isRunningStatus('interacting')).toBe(true)
  })

  it('is false for non-running states', () => {
    expect(isRunningStatus('pending')).toBe(false)
    expect(isRunningStatus('completed')).toBe(false)
    expect(isRunningStatus('failed')).toBe(false)
    expect(isRunningStatus('aborted')).toBe(false)
    expect(isRunningStatus('paused')).toBe(false)
  })
})

describe('isTerminalStatus', () => {
  it('is true for completed, failed and aborted', () => {
    expect(isTerminalStatus('completed')).toBe(true)
    expect(isTerminalStatus('failed')).toBe(true)
    expect(isTerminalStatus('aborted')).toBe(true)
  })

  it('is false for non-terminal states', () => {
    expect(isTerminalStatus('pending')).toBe(false)
    expect(isTerminalStatus('running')).toBe(false)
    expect(isTerminalStatus('interacting')).toBe(false)
    expect(isTerminalStatus('paused')).toBe(false)
  })
})

describe('partitionInteractions', () => {
  it('splits question and permission entries', () => {
    const result = partitionInteractions([questionEntry('a'), permissionEntry('b'), questionEntry('c')])

    expect(result.questions.map(entry => entry.id)).toEqual(['a', 'c'])
    expect(result.permissions.map(entry => entry.id)).toEqual(['b'])
  })

  it('returns empty partitions for an empty list', () => {
    const result = partitionInteractions([])

    expect(result.questions).toEqual([])
    expect(result.permissions).toEqual([])
  })
})

describe('stepIdOf', () => {
  it('prefers the definition stepId over the execution id', () => {
    expect(stepIdOf({ id: 'exec-1', stepId: 'def-1' })).toBe('def-1')
  })

  it('falls back to the execution id when stepId is absent', () => {
    expect(stepIdOf({ id: 'exec-1' })).toBe('exec-1')
  })
})

describe('isSubagentStep', () => {
  it('is true for agent, skill, mcp and prompt command types', () => {
    expect(isSubagentStep(step({ command: { type: 'agent', value: { promptText: 'x' } } }))).toBe(true)
    expect(isSubagentStep(step({ command: { type: 'skill', value: { promptText: 'x' } } }))).toBe(true)
    expect(isSubagentStep(step({ command: { type: 'mcp', value: { promptText: 'x' } } }))).toBe(true)
    expect(isSubagentStep(step({ command: { type: 'prompt', value: { promptText: 'x' } } }))).toBe(true)
  })

  it('is false for shell command type', () => {
    expect(isSubagentStep(step({ command: { type: 'shell', value: { command: 'ls' } } }))).toBe(false)
  })

  it('is false when there is no command and no sessionMeta', () => {
    expect(isSubagentStep(step())).toBe(false)
  })

  it('is true when sessionMeta.command is agent, skill, mcp or prompt', () => {
    expect(isSubagentStep(step({ sessionMeta: sessionMeta('agent') }))).toBe(true)
    expect(isSubagentStep(step({ sessionMeta: sessionMeta('skill') }))).toBe(true)
    expect(isSubagentStep(step({ sessionMeta: sessionMeta('mcp') }))).toBe(true)
    expect(isSubagentStep(step({ sessionMeta: sessionMeta('prompt') }))).toBe(true)
  })

  it('is false when sessionMeta.command is shell', () => {
    expect(isSubagentStep(step({ sessionMeta: sessionMeta('shell') }))).toBe(false)
  })

  it('prefers sessionMeta.command over command.type when both are present', () => {
    expect(isSubagentStep(step({ command: { type: 'shell', value: { command: 'ls' } }, sessionMeta: sessionMeta('agent') }))).toBe(true)
    expect(isSubagentStep(step({ command: { type: 'agent', value: { promptText: 'x' } }, sessionMeta: sessionMeta('shell') }))).toBe(false)
  })
})

describe('isBlank', () => {
  it('is true for empty and whitespace-only strings', () => {
    expect(isBlank('')).toBe(true)
    expect(isBlank('   ')).toBe(true)
  })

  it('is false for non-blank strings', () => {
    expect(isBlank('retry')).toBe(false)
  })
})

describe('RETRY_MODES', () => {
  it('lists the three retry modes in order', () => {
    expect(RETRY_MODES).toEqual(['continue', 'revert', 'fork'])
  })
})

describe('relativeTimeOf', () => {
  const NOW = '2026-01-01T12:00:00.000Z'

  it('returns justNow for a sub-minute delta', () => {
    expect(relativeTimeOf('2026-01-01T11:59:40.000Z', NOW)).toEqual({ kind: 'justNow' })
  })

  it('returns minutes for a sub-hour delta', () => {
    expect(relativeTimeOf('2026-01-01T11:55:00.000Z', NOW)).toEqual({ kind: 'minutes', count: 5 })
  })

  it('returns hours for a sub-day delta', () => {
    expect(relativeTimeOf('2026-01-01T10:00:00.000Z', NOW)).toEqual({ kind: 'hours', count: 2 })
  })

  it('returns days for a sub-week delta', () => {
    expect(relativeTimeOf('2025-12-30T12:00:00.000Z', NOW)).toEqual({ kind: 'days', count: 2 })
  })

  it('falls back to a short date beyond a week', () => {
    const date = new Date('2025-12-20T03:05:00.000Z')
    const pad = (value: number): string => String(value).padStart(2, '0')
    expect(relativeTimeOf('2025-12-20T03:05:00.000Z', NOW)).toEqual({
      kind: 'date',
      text: `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
    })
  })

  it('returns undefined for a missing timestamp', () => {
    expect(relativeTimeOf(undefined, NOW)).toBeUndefined()
  })
})

describe('chatLinesOf', () => {
  /** 构造带 sessionMessages 的 Step 快照。 */
  function stepWithMessages(messages: NonNullable<ExecutedStep['sessionMessages']>): ExecutedStep {
    return {
      type: 'default',
      id: 'exec-1',
      stageId: 'stg-1',
      name: 'lint',
      status: 'completed',
      visitCount: 1,
      sessionMessages: messages,
    }
  }

  it('maps text messages to assistant lines with step name', () => {
    const lines = chatLinesOf(stepWithMessages([{ type: 'text', text: '开始检查' }]))
    expect(lines).toEqual([{ who: 'lint · agent', text: '开始检查', kind: 'assistant' }])
  })

  it('maps tool messages to mono lines with output summary', () => {
    const lines = chatLinesOf(stepWithMessages([{ type: 'tool', tool: 'write_file', output: 'ok' }]))
    expect(lines?.[0]?.who).toBe('lint · tool')
    expect(lines?.[0]?.text).toContain('┌ write_file')
    expect(lines?.[0]?.text).toContain('└ ok')
  })

  it('skips empty text messages', () => {
    const lines = chatLinesOf(stepWithMessages([{ type: 'text', text: '' }, { type: 'tool', tool: 'ls' }]))
    expect(lines?.length).toBe(1)
    expect(lines?.[0]?.kind).toBe('tool')
  })

  it('returns undefined without sessionMessages', () => {
    expect(chatLinesOf(step())).toBeUndefined()
  })
})
