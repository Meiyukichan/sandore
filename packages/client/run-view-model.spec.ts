/**
 * run-view-model.ts 的纯逻辑单元测试：7 态 StepStatus/DagRunStatus → StateDotState
 * 穷尽映射、运行中/终态判定（轮询控制）、pending 交互分类、retry message 校验。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/run-view-model.spec
 */
import { describe, expect, it } from 'vitest'

import type { PendingPermissionEntry, PendingQuestionEntry } from '@meiyukichan/dsh-sandore/schema'

import {
  buildRunTree, buildTimeline, isBlank, isRunningStatus, isSubagentStep, isTerminalStatus,
  partitionInteractions, RETRY_MODES, runDotState, stepDotState, stepIdOf, relativeTimeOf, chatLinesOf,
  UNASSIGNED_STAGE_ID,
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

describe('buildTimeline 收尾字段（4.10：finalizePhase/finalizeErrorDetail）', () => {
  it('propagates finalizeMeta.currentPhase / errorDetail into the timeline step item', () => {
    const executed = step({
      status: 'failed',
      finalizeMeta: {
        currentPhase: 'gating',
        assessSessionId: 'assess-1',
        gateSessionId: 'gate-1',
        assessResult: { passThroughVars: {}, forkSessionId: 'assess-1', assessmentRaw: '' },
        gateResult: {
          gatesPassed: false,
          primaryPassed: false,
          errorDetail: 'missing output files: out/report.md',
          gateSessionId: 'gate-1',
          assessmentRaw: '',
        },
        errorDetail: 'missing output files: out/report.md',
      },
    })
    const state = {
      taskId: 'inst-1',
      workflowId: 'wfl-1',
      status: 'failed',
      originalInput: 'do it',
      currentStageId: 'stg-1',
      executedSteps: [executed],
      stageInfos: [],
      pendingQueue: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as Parameters<typeof buildTimeline>[0]

    const items = buildTimeline(state)
    expect(items).toHaveLength(1)
    const stepItem = items[0]
    expect(stepItem.kind).toBe('step')
    if (stepItem.kind !== 'step') return
    // 收尾阶段徽标数据源（UnifiedTimeline 状态按钮渲染用）。
    expect(stepItem.finalizePhase).toBe('gating')
    // failed 态错误详情（门禁失败原因）。
    expect(stepItem.finalizeErrorDetail).toBe('missing output files: out/report.md')
    // 偏离 6：可点击徽标与会话结果字段（Phase B/C fork 会话 id + assess/gate 结果）。
    expect(stepItem.finalizeAssessSessionId).toBe('assess-1')
    expect(stepItem.finalizeGateSessionId).toBe('gate-1')
    expect(stepItem.finalizeAssessResult).toEqual({ assessmentRaw: '' })
    expect(stepItem.finalizeGateResult).toEqual({ gatesPassed: false })
    // Bug 1: previousPhase 映射
    expect(stepItem.finalizePreviousPhase).toBeUndefined()
  })

  it('propagates finalizeMeta.currentPhase=completed（已收尾徽标数据源）', () => {
    const executed = step({
      status: 'completed',
      finalizeMeta: {
        currentPhase: 'completed',
        previousPhase: 'routing',
        assessSessionId: 'assess-1',
        gateSessionId: 'gate-1',
        assessResult: { passThroughVars: {}, forkSessionId: 'assess-1', assessmentRaw: 'ok' },
        gateResult: { gatesPassed: true, primaryPassed: true, gateSessionId: 'gate-1', assessmentRaw: '' },
      },
    })
    const state = {
      taskId: 'inst-1',
      workflowId: 'wfl-1',
      status: 'completed',
      originalInput: 'do it',
      currentStageId: 'stg-1',
      executedSteps: [executed],
      stageInfos: [],
      pendingQueue: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as Parameters<typeof buildTimeline>[0]

    const items = buildTimeline(state)
    const stepItem = items[0]
    expect(stepItem.kind).toBe('step')
    if (stepItem.kind !== 'step') return
    // completed 终态 currentPhase='completed' → UnifiedTimeline 渲染「已收尾」徽标。
    expect(stepItem.finalizePhase).toBe('completed')
    // Bug 1: previousPhase 映射
    expect(stepItem.finalizePreviousPhase).toBe('routing')
    expect(stepItem.finalizeAssessSessionId).toBe('assess-1')
    expect(stepItem.finalizeGateSessionId).toBe('gate-1')
  })

  it('propagates compressedOutput from assessResult into finalizeAssessResult', () => {
    const executed = step({
      status: 'completed',
      finalizeMeta: {
        currentPhase: 'completed',
        assessSessionId: 'assess-1',
        assessResult: { passThroughVars: {}, forkSessionId: 'assess-1', assessmentRaw: 'raw output', compressedOutput: '三段式压缩摘要' },
      },
    })
    const state = {
      taskId: 'inst-1',
      workflowId: 'wfl-1',
      status: 'completed',
      originalInput: 'do it',
      currentStageId: 'stg-1',
      executedSteps: [executed],
      stageInfos: [],
      pendingQueue: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as Parameters<typeof buildTimeline>[0]

    const items = buildTimeline(state)
    const stepItem = items[0]
    expect(stepItem.kind).toBe('step')
    if (stepItem.kind !== 'step') return
    // Bug 2: compressedOutput 被映射到 finalizeAssessResult。
    expect(stepItem.finalizeAssessResult).toEqual({ assessmentRaw: 'raw output', compressedOutput: '三段式压缩摘要' })
  })

  it('maps sessionMeta.command → commandType and assessResult.errorDetail → finalizeAssessErrorDetail', () => {
    // Round 20：UI 依据 commandType（shell 直接显示命令输出）与 finalizeAssessErrorDetail
    // （Phase B 降级检测）渲染 completed 分支。
    const executed = step({
      status: 'completed',
      sessionMeta: { childId: 'child-1', synthetic: true, command: 'shell' },
      finalizeMeta: {
        currentPhase: 'completed',
        assessResult: {
          passThroughVars: {},
          forkSessionId: 'assess-1',
          assessmentRaw: '',
          errorDetail: 'fork subagent finalize degraded to temp session: no event source',
        },
      },
    })
    const state = {
      taskId: 'inst-1',
      workflowId: 'wfl-1',
      status: 'completed',
      originalInput: 'do it',
      currentStageId: 'stg-1',
      executedSteps: [executed],
      stageInfos: [],
      pendingQueue: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as Parameters<typeof buildTimeline>[0]

    const items = buildTimeline(state)
    const stepItem = items[0]
    expect(stepItem.kind).toBe('step')
    if (stepItem.kind !== 'step') return
    expect(stepItem.commandType).toBe('shell')
    expect(stepItem.finalizeAssessErrorDetail).toBe('fork subagent finalize degraded to temp session: no event source')
    // 无降级时字段为 undefined（completed 分支走 compressedOutput 判定）。
    expect(stepItem.finalizeAssessResult).toEqual({ assessmentRaw: '' })
  })

  it('omits the finalize fields when finalizeMeta is absent', () => {
    const state = {
      taskId: 'inst-1',
      workflowId: 'wfl-1',
      status: 'completed',
      originalInput: 'do it',
      currentStageId: 'stg-1',
      executedSteps: [step({ status: 'completed' })],
      stageInfos: [],
      pendingQueue: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as Parameters<typeof buildTimeline>[0]

    const items = buildTimeline(state)
    const stepItem = items[0]
    expect(stepItem.kind).toBe('step')
    if (stepItem.kind !== 'step') return
    expect(stepItem.finalizePhase).toBeUndefined()
    expect(stepItem.finalizePreviousPhase).toBeUndefined()
    expect(stepItem.finalizeErrorDetail).toBeUndefined()
    expect(stepItem.finalizeAssessSessionId).toBeUndefined()
    expect(stepItem.finalizeGateSessionId).toBeUndefined()
    expect(stepItem.finalizeAssessResult).toBeUndefined()
    expect(stepItem.finalizeGateResult).toBeUndefined()
  })
})

describe('buildRunTree（Round 26：完全按 executedSteps 渲染导航树）', () => {
  it('shows every executed step segment grouped by stageId, skips empty stages, keeps creation order', () => {
    const s1 = step({ id: 'exec-1', stageId: 'stg-1', stepId: 'step-a', name: 'sce1', status: 'completed' })
    const s2 = step({ id: 'exec-2', stageId: 'stg-1', stepId: 'step-b', name: 'sce2', status: 'paused' })
    // 同 stepId 第二次 visit（第三段）：不聚合，两段都展示。
    const s3 = step({ id: 'exec-3', stageId: 'stg-1', stepId: 'step-b', name: 'sce2', status: 'completed' })
    const s4 = step({ id: 'exec-4', stageId: 'stg-3', stepId: 'step-c', name: 'fail1', status: 'failed' })
    // 无 stageId 的异常段：归入「未分组」兜底（仍展示）。
    const s5 = {
      ...step({ id: 'exec-5', stepId: 'step-d', name: 'orphan', status: 'completed' }),
      stageId: undefined,
    } as unknown as ExecutedStep
    const state = {
      taskId: 'inst-1',
      workflowId: 'wfl-1',
      workflowName: 'wf',
      status: 'running',
      originalInput: 'do it',
      currentStageId: 'stg-1',
      executedSteps: [s1, s2, s3, s4, s5],
      stageInfos: [
        { id: 'stg-1', name: 'demo1', status: 'completed' },
        { id: 'stg-2', name: 'demo2-empty', status: 'completed' },
        { id: 'stg-3', name: 'demo3', status: 'running' },
      ],
      stageContracts: {},
      pendingQueue: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as Parameters<typeof buildRunTree>[0]

    const tree = buildRunTree(state)
    expect(tree).toHaveLength(1)
    const root = tree[0]
    expect(root.type).toBe('workflow')
    if (root.type !== 'workflow') return

    // 只展示有 step 的 stage（demo2 空 stage 不展示）；顺序 = 第一个 step 出现顺序。
    expect(root.children?.map(stage => stage.id)).toEqual(['stg-1', 'stg-3', UNASSIGNED_STAGE_ID])

    // stg-1（demo1）：所有 step 段都展示（含 paused 段与同 stepId 第二段），数组顺序保持。
    const stg1 = root.children?.[0]
    expect(stg1?.name).toBe('demo1')
    expect(stg1?.children?.map(s => s.id)).toEqual(['exec-1', 'exec-2', 'exec-3'])
    expect(stg1?.children?.map(s => s.status)).toEqual(['completed', 'paused', 'completed'])
    expect(stg1?.children?.[1]?.stepId).toBe('step-b')

    // stg-3（demo3）：failed 段展示。
    const stg3 = root.children?.[1]
    expect(stg3?.name).toBe('demo3')
    expect(stg3?.children?.map(s => s.id)).toEqual(['exec-4'])
    expect(stg3?.children?.[0]?.status).toBe('failed')

    // 未分组兜底：无 stageId 的 step 仍展示。
    const unassigned = root.children?.[2]
    expect(unassigned?.name).toBe(UNASSIGNED_STAGE_ID)
    expect(unassigned?.children?.map(s => s.id)).toEqual(['exec-5'])
  })

  it('mounts result leaves per segment and artifact leaves only on the last segment', () => {
    const s1 = step({
      id: 'exec-1', stageId: 'stg-1', stepId: 'step-a', name: 'sce1', status: 'completed',
      output: [{ type: 'text', text: 'first output' }],
    })
    const s1b = step({
      id: 'exec-1b', stageId: 'stg-1', stepId: 'step-a', name: 'sce1', status: 'completed',
      output: [{ type: 'text', text: 'second output' }],
    })
    const state = {
      taskId: 'inst-1',
      workflowId: 'wfl-1',
      workflowName: 'wf',
      status: 'completed',
      originalInput: 'do it',
      currentStageId: 'stg-1',
      executedSteps: [s1, s1b],
      stageInfos: [{ id: 'stg-1', name: 'demo1', status: 'completed' }],
      stageContracts: {
        'stg-1': {
          stageId: 'stg-1', stageName: 'demo1', status: 'completed',
          artifacts: [{ stepId: 'step-a', outputToId: 'opt-1', files: ['out/proposal.md'] }],
        },
      },
      pendingQueue: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as Parameters<typeof buildRunTree>[0]

    const tree = buildRunTree(state)
    const root = tree[0]
    if (root.type !== 'workflow') return
    const stg1 = root.children?.[0]
    const seg1 = stg1?.children?.[0]
    const seg2 = stg1?.children?.[1]
    expect(stg1?.children?.map(s => s.id)).toEqual(['exec-1', 'exec-1b'])
    // 返回结果按执行段挂载：每段只挂自己这段的 output 文本。
    expect(seg1?.children?.filter(leaf => leaf.type === 'result').map(leaf => leaf.text)).toEqual(['first output'])
    expect(seg2?.children?.filter(leaf => leaf.type === 'result').map(leaf => leaf.text)).toEqual(['second output'])
    // 产物按 step 级归并，只挂到该 stepId 的最后一段（exec-1b），避免重复。
    expect(seg1?.children?.filter(leaf => leaf.type === 'artifact')).toEqual([])
    expect(seg2?.children?.filter(leaf => leaf.type === 'artifact').map(leaf => leaf.name)).toEqual(['proposal.md'])
  })

  it('prefers segment-snapshot artifacts and falls back to stage contracts', () => {
    // 段快照优先：每段挂自己这段的 artifacts（运行中即可见，不再等 stage 契约）。
    const s1 = step({
      id: 'exec-1', stageId: 'stg-1', stepId: 'step-a', name: 'sce1', status: 'completed',
      artifacts: ['D:/work/a.md'],
    })
    const s1b = step({
      id: 'exec-1b', stageId: 'stg-1', stepId: 'step-a', name: 'sce1', status: 'completed',
      artifacts: ['D:/work/b.md'],
    })
    const stateWithSegments = {
      taskId: 'inst-1',
      workflowId: 'wfl-1',
      workflowName: 'wf',
      status: 'running',
      originalInput: 'do it',
      currentStageId: 'stg-1',
      executedSteps: [s1, s1b],
      stageInfos: [{ id: 'stg-1', name: 'demo1', status: 'running' }],
      stageContracts: {
        'stg-1': {
          stageId: 'stg-1', stageName: 'demo1', status: 'completed',
          artifacts: [{ stepId: 'step-a', outputToId: 'opt-1', files: ['D:/work/stage.md'] }],
        },
      },
      pendingQueue: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as Parameters<typeof buildRunTree>[0]

    const tree1 = buildRunTree(stateWithSegments)
    const root1 = tree1[0]
    if (root1.type !== 'workflow') return
    const stg1a = root1.children?.[0]
    const seg1 = stg1a?.children?.[0]
    const seg2 = stg1a?.children?.[1]
    // 段快照存在 → 各挂各的，stage 契约产物不参与（避免重复）。
    // name = basename（文件名）；text = 完整路径（预览用）。
    expect(seg1?.children?.filter(leaf => leaf.type === 'artifact').map(leaf => leaf.name)).toEqual(['a.md'])
    expect(seg1?.children?.filter(leaf => leaf.type === 'artifact').map(leaf => leaf.text)).toEqual(['D:/work/a.md'])
    expect(seg2?.children?.filter(leaf => leaf.type === 'artifact').map(leaf => leaf.name)).toEqual(['b.md'])

    // 回退：无段快照（旧数据/历史实例）→ stageContracts 挂该 stepId 的最后一段。
    const s2 = step({ id: 'exec-2', stageId: 'stg-1', stepId: 'step-b', name: 'sce2', status: 'completed' })
    const stateLegacy = {
      taskId: 'inst-1',
      workflowId: 'wfl-1',
      workflowName: 'wf',
      status: 'completed',
      originalInput: 'do it',
      currentStageId: 'stg-1',
      executedSteps: [s2],
      stageInfos: [{ id: 'stg-1', name: 'demo1', status: 'completed' }],
      stageContracts: {
        'stg-1': {
          stageId: 'stg-1', stageName: 'demo1', status: 'completed',
          artifacts: [{ stepId: 'step-b', outputToId: 'opt-2', files: ['D:/work/counts.json'] }],
        },
      },
      pendingQueue: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as Parameters<typeof buildRunTree>[0]

    const tree2 = buildRunTree(stateLegacy)
    const root2 = tree2[0]
    if (root2.type !== 'workflow') return
    const stg1b = root2.children?.[0]
    expect(stg1b?.children?.[0]?.children?.filter(leaf => leaf.type === 'artifact').map(leaf => leaf.name))
      .toEqual(['counts.json'])
  })
})

describe('buildTimeline 引用稳定缓存（轮询期 memo 保活）', () => {
  /** 构造最小实例状态（executedSteps/userMessages 可覆盖；stepId 固定避免跨用例缓存串扰）。 */
  function refState(overrides: {
    executedSteps?: Array<Partial<ExecutedStep> & Pick<ExecutedStep, 'id' | 'name' | 'status'>>
    userMessages?: Array<{ kind: string; content: string; createdAt: string; target?: string }>
    status?: string
  } = {}): Parameters<typeof buildTimeline>[0] {
    const base = {
      taskId: 'inst-ref',
      workflowId: 'wfl-ref',
      status: 'running',
      originalInput: 'do it',
      currentStageId: 'stg-ref',
      executedSteps: [],
      stageInfos: [],
      pendingQueue: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }
    return {
      ...base,
      executedSteps: overrides.executedSteps?.map(s => step({ stageId: 'stg-ref', ...s })) ?? [],
    } as Parameters<typeof buildTimeline>[0]
  }

  it('相同输入二次派生返回同引用 item（模拟轮询：新 state 对象、同字段）', () => {
    const state = refState({
      executedSteps: [{ id: 'exec-ref-1', name: 'ref-step', status: 'running' }],
      userMessages: [{ kind: 'input', content: 'hello', createdAt: '2026-01-01T00:00:01.000Z', target: '' }],
    })
    const first = buildTimeline(state)

    // 模拟下一轮轮询：引擎返回重新反序列化的全新 state（字段相同、引用全新）。
    const reparsed = JSON.parse(JSON.stringify(state)) as Parameters<typeof buildTimeline>[0]
    const second = buildTimeline(reparsed)

    expect(second).toHaveLength(first.length)
    for (let i = 0; i < first.length; i++) {
      expect(second[i]).toBe(first[i])
    }
  })

  it('字段变化（status 流转）→ 返回新对象（缓存替换，不吞更新）', () => {
    const running = refState({
      executedSteps: [{ id: 'exec-ref-2', name: 'ref-step', status: 'running' }],
    })
    const before = buildTimeline(running)
    expect(before[0]?.kind).toBe('step')

    const completed = refState({
      executedSteps: [{ id: 'exec-ref-2', name: 'ref-step', status: 'completed' }],
    })
    const after = buildTimeline(completed)
    const stepItem = after[0]
    expect(stepItem).not.toBe(before[0])
    if (stepItem?.kind !== 'step') return
    expect(stepItem.status).toBe('completed')

    // 同一轮内再次派生（status 未再变）→ 复用上一轮替换后的新引用。
    const again = buildTimeline(refState({
      executedSteps: [{ id: 'exec-ref-2', name: 'ref-step', status: 'completed' }],
    }))
    expect(again[0]).toBe(after[0])
  })

  it('新 attempt 段（attemptIndex 变化）→ 独立 key，各自引用稳定', () => {
    const attempt0 = buildTimeline(refState({
      executedSteps: [{ id: 'exec-ref-3', name: 'ref-step', status: 'failed', attemptIndex: 0 }],
    }))
    // 重试产生第 2 个执行段（attemptIndex=1）。
    const attempt1 = buildTimeline(refState({
      executedSteps: [
        { id: 'exec-ref-3', name: 'ref-step', status: 'failed', attemptIndex: 0 },
        { id: 'exec-ref-3', name: 'ref-step', status: 'running', attemptIndex: 1 },
      ],
    }))
    expect(attempt1).toHaveLength(2)
    // attemptIndex=0 的段展示等价 → 复用旧引用；attemptIndex=1 是新段 → 新对象。
    expect(attempt1[0]).toBe(attempt0[0])
    expect(attempt1[1]).not.toBe(attempt0[0])
    expect(attempt1[1]?.kind).toBe('step')
    if (attempt1[1]?.kind !== 'step') return
    expect(attempt1[1].attemptIndex).toBe(1)
  })
})
