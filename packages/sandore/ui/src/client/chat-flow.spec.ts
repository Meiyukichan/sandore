/**
 * chat-flow 纯逻辑单测（node 环境，无 React / 无 DSH 运行时依赖）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/chat-flow.spec
 */
import { describe, expect, it } from 'vitest'
import type {
  CommandNode, ConversationNode, PartialAssistant, RunningToolCall,
} from '@deepseek-ai/dsh-client-runtime/client'
import { buildStepChatFlow, STEP_CHAT_MAX_NODES, type StepChatFlowRow } from './chat-flow.ts'

// ── mock 工厂：构造结构合法的 ConversationNode / snapshot 输入 ─────────────

function userNode(seq: number, text: string): ConversationNode {
  return { kind: 'user', seq, time: seq * 1000, content: [{ type: 'text', text }], source: {} }
}

function steeringNode(seq: number, text: string): ConversationNode {
  return { kind: 'steering', seq, time: seq * 1000, messageId: `m-${seq}` as never, content: [{ type: 'text', text }], source: {} } as unknown as ConversationNode
}

function assistantNode(
  seq: number,
  turn: number,
  step: number,
  text: string,
  toolCalls: ReadonlyArray<{ callId: string; name: string; argsRaw: string }> = [],
): ConversationNode {
  return {
    kind: 'assistant',
    seq,
    time: seq * 1000,
    turn,
    step,
    blocks: [
      ...(text === '' ? [] : [{ kind: 'text' as const, text }]),
      ...toolCalls.map((call) => ({ kind: 'tool-call' as const, ...call })),
    ],
  }
}

function toolResultNode(
  seq: number,
  callId: string,
  text: string,
  opts: { isError?: boolean; call?: { name: string; argsRaw: string } | null } = {},
): ConversationNode {
  return {
    kind: 'tool-result',
    seq,
    time: seq * 1000,
    callId,
    call: opts.call ?? null,
    callTime: null,
    content: [{ type: 'text', text }],
    isError: opts.isError ?? false,
    callView: null,
    resultView: null,
    subCalls: [],
  }
}

function commandNode(
  seq: number,
  opts: {
    name?: string | null
    args?: string | null
    outcome?: CommandNode['outcome']
  } = {},
): ConversationNode {
  return {
    kind: 'command',
    seq,
    time: seq * 1000,
    commandId: `cmd-${seq}` as never,
    name: opts.name ?? 'ls',
    args: opts.args ?? '',
    outcome: opts.outcome ?? null,
  } as unknown as ConversationNode
}

/** 边缘节点工厂：compaction / unknown / context / model-retry / turn-error / turn-max-tokens。 */
function edgeNode(
  kind: 'compaction' | 'unknown' | 'context' | 'model-retry' | 'turn-error' | 'turn-max-tokens',
  seq: number,
): ConversationNode {
  const base = { kind, seq, time: seq * 1000 } as object
  switch (kind) {
    case 'compaction':
      return { ...base, summary: null, summaryEventSeq: null, shadowedItemCount: null, shadowedTokenCount: null } as unknown as ConversationNode
    case 'unknown':
      return { ...base, type: 'surface/whatever', data: {} } as unknown as ConversationNode
    case 'context':
      return {
        ...base, content: [], source: {},
        provenance: { kind: 'system', producer: 'x' },
        form: null,
      } as unknown as ConversationNode
    case 'model-retry':
      return {
        ...base, turn: 1, step: 0, retry: 1, maxRetries: 2, mode: 'normal', delayMs: 1_000,
        retryState: 'scheduled', failure: { message: 'boom' },
      } as unknown as ConversationNode
    case 'turn-error':
      return { ...base, turn: 1, step: 0, message: 'failed' } as unknown as ConversationNode
    case 'turn-max-tokens':
      return { ...base, turn: 1, step: 0 } as unknown as ConversationNode
  }
}

function snapshot(
  nodes: readonly ConversationNode[],
  opts: {
    partial?: PartialAssistant | null
    runningCalls?: readonly RunningToolCall[]
    turnTimings?: ReadonlyMap<number, { readonly startTime: number; readonly endTime?: number }>
  } = {},
): { nodes: readonly ConversationNode[]; partial: PartialAssistant | null; runningCalls: readonly RunningToolCall[]; turnTimings?: ReadonlyMap<number, { readonly startTime: number; readonly endTime?: number }> } {
  return { nodes, partial: opts.partial ?? null, runningCalls: opts.runningCalls ?? [], ...(opts.turnTimings === undefined ? {} : { turnTimings: opts.turnTimings }) }
}

/** 断言辅助：把 readonly 展示行数组收窄为可索引读的行类型。 */
function asRows(result: readonly StepChatFlowRow[]): readonly StepChatFlowRow[] {
  return result
}

// ── 用户/助手消息映射 ──────────────────────────────────────────────────────

describe('buildStepChatFlow：用户/助手消息映射', () => {
  it('user → 用户行（携带 node）；assistant → agent 行（blocks/非流式）', () => {
    const rows = asRows(buildStepChatFlow(snapshot([
      userNode(1, '你好'),
      assistantNode(2, 1, 0, '收到'),
    ])))
    expect(rows).toEqual([
      { kind: 'user', key: 'user-1', node: expect.objectContaining({ kind: 'user', content: [{ type: 'text', text: '你好' }], time: 1000 }) },
      { kind: 'agent', key: 'assistant-2', blocks: [{ kind: 'text', text: '收到' }], streaming: false, interrupted: false },
    ])
  })

  it('steering 节点按用户行渲染（右气泡语义）', () => {
    const rows = asRows(buildStepChatFlow(snapshot([steeringNode(1, '插话')])))
    expect(rows[0]).toMatchObject({ kind: 'user', key: 'steering-1' })
    expect(rows[0]?.kind === 'user' ? rows[0].node : null).toMatchObject({ kind: 'steering', time: 1000 })
  })
})

// ── 工具行映射与配对 ───────────────────────────────────────────────────────

describe('buildStepChatFlow：工具行映射与配对', () => {
  it('assistant 的 tool-call 块展开为工具行（RunningToolCall 数据面）', () => {
    const rows = asRows(buildStepChatFlow(snapshot([
      assistantNode(2, 1, 0, '', [{ callId: 'c1', name: 'bash', argsRaw: '{"cmd":"ls"}' }]),
    ])))
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ kind: 'tool', key: 'tool-c1', toolName: 'bash' })
    expect(rows[1]?.kind === 'tool' ? rows[1].block : null).toMatchObject({ callId: 'c1', name: 'bash', argsRaw: '{"cmd":"ls"}' })
  })

  it('tool-result 与同 callId 工具行配对：同一行替换为 settled（block 变 ToolResultNode）', () => {
    const rows = asRows(buildStepChatFlow(snapshot([
      assistantNode(2, 1, 0, '', [{ callId: 'c1', name: 'bash', argsRaw: '{}' }]),
      toolResultNode(3, 'c1', 'a.ts\nb.ts'),
    ])))
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ kind: 'tool', key: 'tool-c1' })
    const block = rows[1]?.kind === 'tool' ? rows[1].block : null
    expect(block).toMatchObject({ kind: 'tool-result', callId: 'c1', isError: false })
  })

  it('窗口截断导致 call 头不可见时 tool-result 单列（name 回退 call 回填 / callId）', () => {
    const rows = asRows(buildStepChatFlow(snapshot([
      toolResultNode(3, 'c1', 'ok', { call: { name: 'read', argsRaw: '{"path":"a"}' } }),
    ])))
    expect(rows[0]).toMatchObject({ kind: 'tool', key: 'tool-result-3', toolName: 'read' })
  })

  it('命令节点 → 命令行', () => {
    const rows = asRows(buildStepChatFlow(snapshot([
      commandNode(4, { name: 'permission', args: 'read', outcome: null }),
    ])))
    expect(rows[0]).toMatchObject({ kind: 'command', key: 'command-4' })
    expect(rows[0]?.kind === 'command' ? rows[0].node : null).toMatchObject({ name: 'permission', outcome: null })
  })
})

// ── 边缘节点映射（DSH conversation.chat.node 各 keyed 渲染器对应行） ───────

describe('buildStepChatFlow：边缘节点映射', () => {
  it('context/compaction/unknown/model-retry/turn-error/turn-max-tokens → 对应展示行', () => {
    const rows = asRows(buildStepChatFlow(snapshot([
      userNode(1, '你好'),
      edgeNode('context', 2),
      edgeNode('compaction', 3),
      edgeNode('unknown', 4),
      edgeNode('model-retry', 5),
      edgeNode('turn-error', 6),
      edgeNode('turn-max-tokens', 7),
      assistantNode(8, 1, 0, '收到'),
    ])))
    expect(rows.map((row) => row.kind)).toEqual([
      'user', 'context', 'compaction', 'unknown', 'retry', 'turn-error', 'turn-max-tokens', 'agent',
    ])
    expect(rows[1]).toMatchObject({ kind: 'context', key: 'context-2' })
    expect(rows[2]).toMatchObject({ kind: 'compaction', key: 'compaction-3' })
    expect(rows[3]).toMatchObject({ kind: 'unknown', key: 'unknown-4' })
    expect(rows[4]).toMatchObject({ kind: 'retry', key: 'retry-5' })
    expect(rows[5]).toMatchObject({ kind: 'turn-error', key: 'turn-error-6' })
    expect(rows[6]).toMatchObject({ kind: 'turn-max-tokens', key: 'turn-max-tokens-7' })
    // 行携带公开节点数据（渲染器直接消费）
    expect(rows[1]?.kind === 'context' ? rows[1].node : null).toMatchObject({ kind: 'context', seq: 2 })
    expect(rows[2]?.kind === 'compaction' ? rows[2].node : null).toMatchObject({ kind: 'compaction', seq: 3 })
    expect(rows[3]?.kind === 'unknown' ? rows[3].node : null).toMatchObject({ kind: 'unknown', type: 'surface/whatever' })
    expect(rows[4]?.kind === 'retry' ? rows[4].node : null).toMatchObject({ kind: 'model-retry', retryState: 'scheduled' })
    expect(rows[5]?.kind === 'turn-error' ? rows[5].node : null).toMatchObject({ kind: 'turn-error', message: 'failed' })
  })
})

// ── partial 流式 ───────────────────────────────────────────────────────────

describe('buildStepChatFlow：partial 流式', () => {
  it('partial 追加为流式 agent 行 + 运行中工具行', () => {
    const rows = asRows(buildStepChatFlow(snapshot([userNode(1, '开始')], {
      partial: {
        turn: 1,
        step: 0,
        blocks: [
          { kind: 'text', text: '正在写代码' },
          { kind: 'tool-call', callId: 'c1', name: 'write', argsRaw: '{"path":"a.ts"}' },
        ],
      },
    })))
    expect(rows).toEqual([
      { kind: 'user', key: 'user-1', node: expect.objectContaining({ kind: 'user', time: 1000 }) },
      {
        kind: 'agent', key: 'partial-agent-1-0',
        blocks: [
          { kind: 'text', text: '正在写代码' },
          { kind: 'tool-call', callId: 'c1', name: 'write', argsRaw: '{"path":"a.ts"}' },
        ],
        streaming: true, interrupted: false,
      },
      { kind: 'tool', key: 'partial-tool-c1', toolName: 'write', block: expect.objectContaining({ callId: 'c1', name: 'write' }) },
    ])
  })

  it('partial 与已结算节点共存（历史节点 + 流式尾巴）', () => {
    const rows = asRows(buildStepChatFlow(snapshot([
      userNode(1, 'q'),
      assistantNode(2, 1, 0, '已完结'),
    ], {
      partial: { turn: 2, step: 0, blocks: [{ kind: 'text', text: '新一轮' }] },
    })))
    const agentRows = rows.filter((row) => row.kind === 'agent')
    expect(agentRows).toHaveLength(2)
    expect(agentRows[1]).toMatchObject({ key: 'partial-agent-2-0', streaming: true })
  })
})

// ── turn-tail 派生（DSH 'turn-tail' ChatNode 语义） ────────────────────────

describe('buildStepChatFlow：turn-tail 派生', () => {
  it('已完结 turn（turnTimings 有 endTime）→ 关闭行后插入 tail 行（文本/时长/指标）', () => {
    const nodes: ConversationNode[] = [
      userNode(1, 'q'),
      assistantNode(2, 1, 0, '答', undefined),
    ]
    const rows = asRows(buildStepChatFlow(snapshot(nodes, {
      turnTimings: new Map([[1, { startTime: 10_000, endTime: 15_000 }]]),
    })))
    expect(rows).toHaveLength(3)
    expect(rows[1]).toMatchObject({ kind: 'agent', key: 'assistant-2' })
    expect(rows[2]).toMatchObject({ kind: 'tail', key: 'tail-1' })
    const tail = rows[2]?.kind === 'tail' ? rows[2].data : null
    expect(tail).toMatchObject({ turn: 1, seq: 2, time: 2000, text: '答', runMs: 5_000, branchUnavailable: false })
  })

  it('无 endTime（turn 未完结 / end 在窗口外）→ 不产出 tail', () => {
    const nodes: ConversationNode[] = [
      userNode(1, 'q'),
      assistantNode(2, 1, 0, '答'),
    ]
    const rows = asRows(buildStepChatFlow(snapshot(nodes, {
      turnTimings: new Map([[1, { startTime: 10_000 }]]),
    })))
    expect(rows.filter((row) => row.kind === 'tail')).toHaveLength(0)
  })

  it('不提供 turnTimings（旧输入面）→ 不产出 tail', () => {
    const rows = asRows(buildStepChatFlow(snapshot([
      userNode(1, 'q'),
      assistantNode(2, 1, 0, '答'),
    ])))
    expect(rows.filter((row) => row.kind === 'tail')).toHaveLength(0)
  })

  it('关闭行后有工具结算（turn 尾部非文本）→ branchUnavailable=true', () => {
    const nodes: ConversationNode[] = [
      userNode(1, 'q'),
      assistantNode(2, 1, 0, '正在处理', [{ callId: 'c1', name: 'bash', argsRaw: '{}' }]),
      toolResultNode(3, 'c1', 'ok'),
    ]
    const rows = asRows(buildStepChatFlow(snapshot(nodes, {
      turnTimings: new Map([[1, { startTime: 10_000, endTime: 20_000 }]]),
    })))
    const tail = rows.find((row) => row.kind === 'tail')
    expect(tail).toBeDefined()
    expect(tail?.kind === 'tail' ? tail.data.branchUnavailable : null).toBe(true)
  })

  it('多个已完结 turn → 每个 turn 的关闭行后各插一条 tail，顺序稳定', () => {
    const nodes: ConversationNode[] = [
      userNode(1, 'q1'),
      assistantNode(2, 1, 0, '答1'),
      userNode(3, 'q2'),
      assistantNode(4, 2, 0, '答2'),
    ]
    const rows = asRows(buildStepChatFlow(snapshot(nodes, {
      turnTimings: new Map([
        [1, { startTime: 10_000, endTime: 11_000 }],
        [2, { startTime: 20_000, endTime: 22_000 }],
      ]),
    })))
    expect(rows.map((row) => row.kind)).toEqual(['user', 'agent', 'tail', 'user', 'agent', 'tail'])
    expect(rows[2]).toMatchObject({ key: 'tail-1' })
    expect(rows[5]).toMatchObject({ key: 'tail-2' })
  })
})

// ── 截断 ───────────────────────────────────────────────────────────────────

describe('buildStepChatFlow：最新 10 条节点截断', () => {
  it(`超过 ${STEP_CHAT_MAX_NODES} 条节点时只保留最新 ${STEP_CHAT_MAX_NODES} 条`, () => {
    const nodes: ConversationNode[] = []
    for (let i = 1; i <= 8; i++) {
      nodes.push(userNode(i * 2 - 1, `q${i}`))
      nodes.push(assistantNode(i * 2, i, 0, `a${i}`))
    }
    const rows = asRows(buildStepChatFlow(snapshot(nodes)))
    // 16 节点截尾 10 → 首行 user q4（seq 7）。
    expect(rows).toHaveLength(STEP_CHAT_MAX_NODES)
    expect(rows[0]).toMatchObject({ kind: 'user', key: 'user-7' })
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'agent', key: 'assistant-16' })
  })

  it('截断发生在节点层（assistant 展开的工具行不挤出窗口外的节点）', () => {
    const nodes: ConversationNode[] = []
    for (let i = 1; i <= 6; i++) {
      nodes.push(userNode(i * 2 - 1, `q${i}`))
      nodes.push(assistantNode(i * 2, i, 0, `a${i}`, [{ callId: `c${i}`, name: 'bash', argsRaw: '{}' }]))
    }
    const rows = asRows(buildStepChatFlow(snapshot(nodes)))
    // 12 节点（q1..q6 + a1..a6）截尾 10 → q2..a6（seq 3..12）；每个 assistant
    // 展开 1 工具行 → 5 user + 5×2 = 15 行。
    expect(rows[0]).toMatchObject({ kind: 'user', key: 'user-3' })
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'tool', key: 'tool-c6' })
  })
})
