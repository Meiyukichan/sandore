/**
 * orchestration-tool-model.spec：工具行内嵌「工作流导航」的纯逻辑回归测试。
 *
 * 三件事：① 只认我们那三个工具（别的工具一律不渲染）；② instanceId / 动作的解析优先级
 * （结果 → 参数 → 面板会话兜底）；③ 由实例状态派生导航模型（复用 buildRunTree）与
 * 引用稳定签名。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/orchestration-tool-model.spec
 */
import { describe, expect, it } from 'vitest'

import {
  ORCHESTRATION_CONTROL_TOOL,
  ORCHESTRATION_RUN_TOOL,
  ORCHESTRATION_TOOL_NAMES,
  orchestrationNavOf,
  orchestrationNavSignature,
  orchestrationToolNameOf,
  orchestrationToolTargetOf,
} from './orchestration-tool-model.ts'

/** 结算结果块（ToolResultNode 本地形状：content 是 loose 块数组）。 */
function resultBlock(name: string, result: unknown, args: Record<string, unknown> = {}) {
  return {
    kind: 'tool-result' as const,
    callId: 'call-1',
    call: { name, argsRaw: JSON.stringify(args) },
    callTime: null,
    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
    isError: false,
    subCalls: [],
  }
}

/** 运行中的调用头（无 kind）。 */
function runningBlock(name: string, args: Record<string, unknown> = {}) {
  return { callId: 'call-2', name, argsRaw: JSON.stringify(args), subCalls: [] }
}

describe('orchestrationToolTargetOf（哪些工具行渲染导航 UI）', () => {
  it('只认 sandore_workflow_run / sandore_workflow_control 两个工具名', () => {
    expect(ORCHESTRATION_TOOL_NAMES).toEqual([ORCHESTRATION_RUN_TOOL, ORCHESTRATION_CONTROL_TOOL])
    expect(orchestrationToolNameOf(resultBlock(ORCHESTRATION_RUN_TOOL, { instanceId: 'inst-1' })))
      .toBe(ORCHESTRATION_RUN_TOOL)
    expect(orchestrationToolNameOf(runningBlock(ORCHESTRATION_CONTROL_TOOL))).toBe(ORCHESTRATION_CONTROL_TOOL)
  })

  it('别的工具（含 sandore 自己的其它工具）不渲染导航', () => {
    for (const name of ['sandore_workflow_status', 'sandore_workflow_send_message', 'bash', 'read', 'todo_write']) {
      expect(
        orchestrationToolTargetOf(resultBlock(name, { instanceId: 'inst-1' }), 'inst-1'),
        `${name} 不应渲染导航`,
      ).toBeUndefined()
    }
    expect(orchestrationToolTargetOf(undefined, 'inst-1')).toBeUndefined()
  })

  it('run：instanceId 只能来自**结果**（实例是这次调用新建的）', () => {
    const target = orchestrationToolTargetOf(
      resultBlock(ORCHESTRATION_RUN_TOOL, { ok: true, action: 'run', data: { instanceId: 'inst-run', status: 'running' } }),
      'fallback',
    )
    expect(target).toEqual({
      toolName: ORCHESTRATION_RUN_TOOL,
      instanceId: 'inst-run',
      instanceIdSource: 'result',
    })
  })

  it('结果文本里夹着 JSON 也能读到 instanceId（宽松解析）', () => {
    const target = orchestrationToolTargetOf(
      resultBlock(ORCHESTRATION_RUN_TOOL, '已启动：{"data":{"instanceId":"inst-embedded"}}（fire-and-forget）'),
      '',
    )
    expect(target?.instanceId).toBe('inst-embedded')
    expect(target?.instanceIdSource).toBe('result')
  })

  it('control：动作与显式 instanceId 从调用参数读', () => {
    const target = orchestrationToolTargetOf(
      runningBlock(ORCHESTRATION_CONTROL_TOOL, { action: 'pause', instanceId: 'inst-args' }),
      'session-id',
    )
    expect(target).toEqual({
      toolName: ORCHESTRATION_CONTROL_TOOL,
      instanceId: 'inst-args',
      action: 'pause',
      instanceIdSource: 'args',
    })
  })

  it('control：省略 instanceId → 面板会话兜底（恒等式 调用会话 ≡ 实例 id）', () => {
    const target = orchestrationToolTargetOf(
      runningBlock(ORCHESTRATION_CONTROL_TOOL, { action: 'continue' }),
      'host-session-id',
    )
    expect(target).toEqual({
      toolName: ORCHESTRATION_CONTROL_TOOL,
      instanceId: 'host-session-id',
      action: 'continue',
      instanceIdSource: 'session',
    })
  })

  it('control：没有兜底会话且参数没给 → 不渲染（不猜实例）', () => {
    expect(orchestrationToolTargetOf(runningBlock(ORCHESTRATION_CONTROL_TOOL, { action: 'pause' }), ''))
      .toBeUndefined()
  })

  it('坏 argsRaw（非 JSON）不抛：动作与 instanceId 都缺 → 走会话兜底', () => {
    const target = orchestrationToolTargetOf(
      { callId: 'call-3', name: ORCHESTRATION_CONTROL_TOOL, argsRaw: 'not-json{', subCalls: [] },
      'host-session',
    )
    expect(target?.instanceId).toBe('host-session')
    expect(target?.action).toBeUndefined()
  })
})

describe('orchestrationNavOf（状态 → 导航模型）', () => {
  const state = {
    taskId: 'inst-nav',
    workflowId: 'wfl-nav',
    workflowName: 'e2e-nav',
    status: 'running',
    originalInput: 'do it',
    currentStageId: 'stg-1',
    stageInfos: [{ id: 'stg-1', name: 'main', status: 'running' }],
    stageContracts: {},
    executedSteps: [
      { id: 'exec-1', stepId: 'step-1', stageId: 'stg-1', name: 'first', status: 'completed', visitCount: 1 },
      { id: 'exec-2', stepId: 'step-2', stageId: 'stg-1', name: 'second', status: 'running', visitCount: 1 },
    ],
    pendingQueue: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  }

  it('复用 buildRunTree 派生树，并统计 step 总数/完成数', () => {
    const nav = orchestrationNavOf(state)
    expect(nav.status).toBe('running')
    expect(nav.workflowName).toBe('e2e-nav')
    expect(nav.stepTotal).toBe(2)
    expect(nav.stepDone).toBe(1)
    const stage = nav.tree[0]?.children?.find(node => node.type === 'stage')
    expect(stage?.name).toBe('main')
    expect(stage?.children?.map(child => child.name)).toEqual(['first', 'second'])
  })

  it('未知/空状态不抛：空树 + 空状态', () => {
    const nav = orchestrationNavOf(undefined)
    expect(nav.tree).toEqual([])
    expect(nav.stepTotal).toBe(0)
    expect(nav.status).toBe('')
  })

  it('签名在无变化时相同、状态或节点变化时不同（快照引用稳定化的判据）', () => {
    const a = orchestrationNavSignature(orchestrationNavOf(state))
    const b = orchestrationNavSignature(orchestrationNavOf(JSON.parse(JSON.stringify(state))))
    expect(b).toBe(a)
    const progressed = orchestrationNavSignature(orchestrationNavOf({
      ...state,
      executedSteps: [
        { ...state.executedSteps[0]!, status: 'completed' },
        { ...state.executedSteps[1]!, status: 'completed' },
      ],
    }))
    expect(progressed).not.toBe(a)
  })
})
