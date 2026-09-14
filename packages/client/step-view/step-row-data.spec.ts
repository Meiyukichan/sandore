/**
 * step-row-data.spec：B2a 行渲染数据层的纯函数回归测试（对齐 DSH 0.1.2-rc.1
 * 语义——assistant block 可见性/回复判定/行壳判定照 conversation-nodes/assistant.ts
 * 与 contract/assistant-content.ts；context 文本 run/限长照 chat/ContextBody.tsx）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/step-row-data.spec
 */
import { describe, expect, it } from 'vitest'

import {
  STEP_CONTEXT_TEXT_LIMIT,
  STEP_TOOL_DEPTH_LIMIT,
  STEP_TURN_PROCESS_INDEPENDENT_KINDS,
  stepAssistantBlockOf,
  stepAssistantMarkdownHasShell,
  stepChatAssistantStepPayloadOf,
  stepChatCommandPayloadOf,
  stepChatCompactionPayloadOf,
  stepChatContextPayloadOf,
  stepChatManualCompactionPayloadOf,
  stepChatModelRetryPayloadOf,
  stepChatProcessSeatOf,
  stepChatReasoningHiddenOf,
  stepChatRowViewKindOf,
  stepChatSystemPromptPayloadOf,
  stepChatTailHasLaterChatNode,
  stepChatTailIsLatestTurn,
  stepChatTailRunMsOf,
  stepChatToolCallPayloadOf,
  stepChatTurnErrorPayloadOf,
  stepChatTurnMaxTokensPayloadOf,
  stepChatTurnProcessPresentationOf,
  stepChatTurnTailPayloadOf,
  stepChatTurnsWithContentOf,
  stepChatUnknownPayloadOf,
  stepChatUserPayloadOf,
  stepContentParts,
  stepContextContentRuns,
  stepHasAssistantReplyContent,
  stepHasVisibleAssistantContent,
  stepBlockIsVisible,
  stepBoundedContextText,
  stepContextUnknownBlocks,
  stepKnownContextFormOf,
  stepToolBlockOf,
  stepTurnProcessSpecOf,
  stepChatTurnProcessIndependentKind,
  type StepChatProcessSeatState,
  type StepChatTurnProcessPresentation,
} from './step-row-data.ts'

describe('stepChatRowViewKindOf（kind → 视图族路由）', () => {
  it('maps the thirteen B2a/B2b kinds to their view families', () => {
    expect(stepChatRowViewKindOf('user')).toBe('user')
    expect(stepChatRowViewKindOf('steering')).toBe('steering')
    expect(stepChatRowViewKindOf('assistant-step')).toBe('assistant-step')
    expect(stepChatRowViewKindOf('context')).toBe('context')
    expect(stepChatRowViewKindOf('system-prompt')).toBe('system-prompt')
    expect(stepChatRowViewKindOf('compaction')).toBe('compaction')
    expect(stepChatRowViewKindOf('manual-compaction')).toBe('manual-compaction')
    expect(stepChatRowViewKindOf('model-retry')).toBe('model-retry')
    expect(stepChatRowViewKindOf('turn-error')).toBe('turn-error')
    expect(stepChatRowViewKindOf('turn-max-tokens')).toBe('turn-max-tokens')
    expect(stepChatRowViewKindOf('unknown')).toBe('unknown')
    expect(stepChatRowViewKindOf('command')).toBe('command')
    expect(stepChatRowViewKindOf('tool-call')).toBe('tool-call')
  })

  it('maps the two B3 kinds (turn-tail / turn-process) to real view families', () => {
    expect(stepChatRowViewKindOf('turn-tail')).toBe('turn-tail')
    expect(stepChatRowViewKindOf('turn-process')).toBe('turn-process')
  })

  it('does not throw on empty / foreign kinds', () => {
    expect(stepChatRowViewKindOf('')).toBeUndefined()
    expect(stepChatRowViewKindOf('some-future-kind')).toBeUndefined()
  })
})

describe('stepChatUserPayloadOf / stepContentParts（user/steering 行 data 防御读取）', () => {
  const userData = {
    kind: 'user',
    seq: 12,
    time: 1_700_000_000_000,
    content: [
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' },
      { type: 'image', attachment: { id: 'a1' } },
      { type: 'tool_use', id: 'x' },
    ],
    source: { kind: 'user' },
  }

  it('reads content, time and unknown blocks from a real-shaped user node', () => {
    const payload = stepChatUserPayloadOf(userData)
    expect(payload.kind).toBe('user')
    expect(payload.time).toBe(1_700_000_000_000)
    expect(payload.content).toHaveLength(4)
    expect(payload.referenceLabels).toBeUndefined()
    const parts = stepContentParts(payload.content)
    expect(parts.text).toBe('hello world')
    expect(parts.images).toEqual([{ attachment: { id: 'a1' } }])
    expect(parts.rest).toEqual([{ type: 'tool_use', id: 'x' }])
  })

  it('keeps referenceLabels when the adjacent recall node tagged the message', () => {
    const payload = stepChatUserPayloadOf({ ...userData, kind: 'steering', referenceLabels: ['a', 'b'] })
    expect(payload.kind).toBe('steering')
    expect(payload.referenceLabels).toEqual(['a', 'b'])
  })

  it('degrades missing / malformed fields to the rc.1 empty state without throwing', () => {
    for (const data of [undefined, null, 'x', 1, [], {}, { kind: 'user' }, { content: 'nope' }]) {
      const payload = stepChatUserPayloadOf(data)
      expect(Array.isArray(payload.content), String(data)).toBe(true)
      expect(payload.content.length).toBe(0)
      expect(payload.time).toBeUndefined()
      expect(payload.referenceLabels).toBeUndefined()
    }
  })
})

describe('assistant blocks（rc.1 blockIsVisible / hasVisibleContent / 回复语义）', () => {
  const text = (t: string) => stepAssistantBlockOf({ kind: 'text', text: t })!
  const reasoning = (t: string) => stepAssistantBlockOf({ kind: 'reasoning', text: t })!
  const toolCall = stepAssistantBlockOf({ kind: 'tool-call', callId: 'c1', name: 'read', argsRaw: '{}' })!
  const image = stepAssistantBlockOf({ kind: 'image', attachment: { id: 'i' } })!

  it('normalizes blocks including unknown kinds (→ other, rc.1 default arm)', () => {
    expect(stepAssistantBlockOf({ kind: 'text', text: 'hi' })).toEqual({ kind: 'text', text: 'hi' })
    expect(stepAssistantBlockOf('nope')).toBeUndefined()
    expect(stepAssistantBlockOf(null)).toBeUndefined()
    expect(stepAssistantBlockOf({ kind: 'text' })).toBeUndefined() // text 缺 text 字段 → 空态
    expect(stepAssistantBlockOf({ kind: 'future-kind', x: 1 })).toEqual({ kind: 'other', block: { kind: 'future-kind', x: 1 } })
    expect(toolCall).toEqual({ kind: 'tool-call', callId: 'c1', name: 'read', argsRaw: '{}' })
  })

  it('blockIsVisible: tool-call heads never count; whitespace-only text does not', () => {
    expect(stepBlockIsVisible(toolCall)).toBe(false)
    expect(stepBlockIsVisible(undefined)).toBe(false)
    expect(stepBlockIsVisible(text('  '))).toBe(false)
    expect(stepBlockIsVisible(text('answer'))).toBe(true)
    expect(stepBlockIsVisible(reasoning('think'))).toBe(true)
    expect(stepBlockIsVisible(image)).toBe(true)
  })

  it('hasVisibleContent: only visible blocks count', () => {
    expect(stepHasVisibleAssistantContent([toolCall, text('   ')])).toBe(false)
    expect(stepHasVisibleAssistantContent([toolCall, text('x')])).toBe(true)
  })

  it('hasAssistantReplyContent: reasoning and tool-call are process, not reply', () => {
    expect(stepHasAssistantReplyContent([reasoning('a'), toolCall])).toBe(false)
    expect(stepHasAssistantReplyContent([text('')])).toBe(false)
    expect(stepHasAssistantReplyContent([text('reply')])).toBe(true)
    expect(stepHasAssistantReplyContent([image])).toBe(true)
  })

  it('markdown shell predicate matches rc.1 AssistantMarkdown.hasVisible', () => {
    expect(stepAssistantMarkdownHasShell([], false, false)).toBe(false)
    expect(stepAssistantMarkdownHasShell([toolCall], false, false)).toBe(false)
    expect(stepAssistantMarkdownHasShell([toolCall], true, false)).toBe(true) // 流式中
    expect(stepAssistantMarkdownHasShell([toolCall], false, true)).toBe(true) // 打断标记
    expect(stepAssistantMarkdownHasShell([toolCall, text('')], false, false)).toBe(true)
  })
})

describe('stepChatAssistantStepPayloadOf（assistant-step 行 data 防御读取）', () => {
  it('reads status/blocks/time from an AssistantChatData-shaped payload', () => {
    const data = {
      status: 'running', turn: 3, step: 2, time: 123,
      blocks: [
        { kind: 'reasoning', text: 'hmm' },
        { kind: 'text', text: 'ok' },
        { kind: 'tool-call', callId: 'c', name: 'bash', argsRaw: '[]' },
      ],
    }
    const payload = stepChatAssistantStepPayloadOf(data)
    expect(payload.status).toBe('running')
    expect(payload.turn).toBe(3)
    expect(payload.step).toBe(2)
    expect(payload.time).toBe(123)
    expect(payload.blocks).toHaveLength(3)
    expect(payload.blocks[0]).toEqual({ kind: 'reasoning', text: 'hmm' })
  })

  it('maps interrupted status and stays settled on unknown status', () => {
    expect(stepChatAssistantStepPayloadOf({ status: 'interrupted', blocks: [] }).status).toBe('interrupted')
    expect(stepChatAssistantStepPayloadOf({ status: 'settled', blocks: [] }).status).toBe('settled')
    expect(stepChatAssistantStepPayloadOf({ status: 'mystery', blocks: [] }).status).toBe('settled')
  })

  it('degrades missing blocks/fields to the empty state without throwing', () => {
    for (const data of [undefined, null, 'x', [], { status: 'settled' }, { blocks: 'nope' }]) {
      const payload = stepChatAssistantStepPayloadOf(data)
      expect(payload.status).toBe('settled')
      expect(payload.blocks.length).toBe(0)
    }
  })
})

describe('context / system-prompt payloads', () => {
  it('reads a context payload with provenance and known form', () => {
    const payload = stepChatContextPayloadOf({
      kind: 'context', seq: 5, time: 9,
      content: [{ type: 'text', text: 'ctx' }],
      source: { kind: 'plugin', plugin: 'skills' },
      provenance: { role: 'inject', label: 'skills' },
      form: 'catalog',
    })
    expect(payload.content).toEqual([{ type: 'text', text: 'ctx' }])
    expect(payload.provenance).toEqual({ role: 'inject', label: 'skills' })
    expect(payload.form).toBe('catalog')
  })

  it('recall role and null label pass through', () => {
    const payload = stepChatContextPayloadOf({ provenance: { role: 'recall', label: null }, form: 'recall' })
    expect(payload.provenance).toEqual({ role: 'recall', label: null })
    expect(payload.form).toBe('recall')
  })

  it('only admits the closed KnownContextForm set; others degrade to null (opaque)', () => {
    expect(stepKnownContextFormOf('instructions')).toBe('instructions')
    expect(stepKnownContextFormOf('snapshot')).toBe('snapshot')
    expect(stepKnownContextFormOf('notice')).toBe('notice')
    expect(stepKnownContextFormOf('relay')).toBe('relay')
    expect(stepKnownContextFormOf('future-form')).toBeNull()
    expect(stepKnownContextFormOf(undefined)).toBeNull()
    const payload = stepChatContextPayloadOf({ form: 'future-form' })
    expect(payload.form).toBeNull()
    expect(payload.provenance).toEqual({ role: 'inject', label: null }) // 缺失 provenance 空态
    expect(payload.content).toEqual([])
  })

  it('reads system-prompt text; missing text degrades to the empty state', () => {
    expect(stepChatSystemPromptPayloadOf({ text: 'You are…' }).text).toBe('You are…')
    expect(stepChatSystemPromptPayloadOf(undefined).text).toBe('')
    expect(stepChatSystemPromptPayloadOf({ text: 42 }).text).toBe('')
    expect(stepChatSystemPromptPayloadOf({}).text).toBe('')
  })
})

describe('context 文本 run / 未知块 / 限长（rc.1 ContextBody 语义）', () => {
  it('joins adjacent text blocks without a separator and keeps unknown blocks in place', () => {
    const runs = stepContextContentRuns([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'future', x: 1 },
      { type: 'text', text: 'c' },
    ])
    expect(runs).toEqual([
      { text: 'ab' },
      { block: { type: 'future', x: 1 } },
      { text: 'c' },
    ])
    expect(stepContextUnknownBlocks([{ type: 'text', text: 'x' }, { type: 'future' }]))
      .toEqual([{ type: 'future' }])
  })

  it('bounds model-facing text at 20k chars and appends the truncation line', () => {
    const truncate = (total: number) => `…truncated ${total}`
    const long = 'x'.repeat(STEP_CONTEXT_TEXT_LIMIT + 10)
    const result = stepBoundedContextText(long, truncate)
    expect(result.length).toBe(STEP_CONTEXT_TEXT_LIMIT + 1 + '…truncated 20010'.length)
    expect(result.endsWith(`\n…truncated ${long.length}`)).toBe(true)
    expect(stepBoundedContextText('short', truncate)).toBe('short')
    expect(stepBoundedContextText('x'.repeat(STEP_CONTEXT_TEXT_LIMIT), truncate)).toBe('x'.repeat(STEP_CONTEXT_TEXT_LIMIT))
  })
})

describe('command / manual-compaction / compaction payloads（B2b）', () => {
  it('reads a running command node (outcome null) and a settled success outcome', () => {
    const running = stepChatCommandPayloadOf({
      kind: 'command', seq: 7, time: 9, commandId: 'c-1', name: 'approve', args: '--once',
      outcome: null,
    })
    expect(running.name).toBe('approve')
    expect(running.args).toBe('--once')
    expect(running.outcome).toBeNull()
    const settled = stepChatCommandPayloadOf({
      kind: 'command', seq: 8, time: 10, commandId: 'c-1', name: null, args: null,
      outcome: { kind: 'success', text: 'ok', sourceEventSeq: 5 },
    })
    expect(settled.name).toBeNull() // run 落在窗口外
    expect(settled.outcome).toEqual({ kind: 'success', text: 'ok', sourceEventSeq: 5 })
  })

  it('degrades malformed command data to the empty state without throwing', () => {
    for (const data of [undefined, null, 'x', {}, { outcome: { kind: 'mystery' } }, { outcome: 'x' }]) {
      const payload = stepChatCommandPayloadOf(data)
      expect(payload.name).toBeNull()
      expect(payload.args).toBeNull()
      expect(payload.outcome).toBeNull()
    }
  })

  it('reads a compaction marker with counts, an expandable-only summary and unavailable marker', () => {
    const full = stepChatCompactionPayloadOf({
      kind: 'compaction', seq: 3, time: 4, summary: '**摘要**',
      summaryEventSeq: 2, shadowedItemCount: 41, shadowedTokenCount: 12_000,
    })
    expect(full.summary).toBe('**摘要**')
    expect(full.summaryEventSeq).toBe(2)
    expect(full.shadowedItemCount).toBe(41)
    expect(full.shadowedTokenCount).toBe(12_000)
    // 窗口切走 compaction/summary：summary null → 不可展开；计数亦缺。
    const bare = stepChatCompactionPayloadOf({ kind: 'compaction', seq: 3, summary: null, summaryEventSeq: null, shadowedItemCount: null, shadowedTokenCount: null })
    expect(bare.summary).toBeNull()
    expect(bare.shadowedItemCount).toBeNull()
    const empty = stepChatCompactionPayloadOf(undefined)
    expect(empty.summary).toBeNull()
    expect(empty.summaryEventSeq).toBeNull()
  })

  it('reads a manual-compaction pair; missing compaction falls back to command-only', () => {
    const withCheckpoint = stepChatManualCompactionPayloadOf({
      command: { kind: 'command', name: 'compact', outcome: { kind: 'success', text: 'done' } },
      compaction: { kind: 'compaction', summary: 's', shadowedItemCount: 1, shadowedTokenCount: 2, summaryEventSeq: 1 },
    })
    expect(withCheckpoint.command.name).toBe('compact')
    expect(withCheckpoint.compaction?.summary).toBe('s')
    const noCheckpoint = stepChatManualCompactionPayloadOf({
      command: { kind: 'command', name: 'compact', outcome: null },
      compaction: null,
    })
    expect(noCheckpoint.compaction).toBeNull()
    expect(noCheckpoint.command.outcome).toBeNull()
    const malformed = stepChatManualCompactionPayloadOf({ command: 'nope' })
    expect(malformed.compaction).toBeNull()
    expect(malformed.command.name).toBeNull()
  })
})

describe('model-retry / turn-error / turn-max-tokens / unknown payloads（B2b）', () => {
  it('reads a retry chain and exposes its last attempt as current', () => {
    const payload = stepChatModelRetryPayloadOf({
      attempts: [
        { kind: 'model-retry', retryState: 'started', mode: 'normal', retry: 1, maxRetries: 2, delayMs: 1000, failure: { message: 'rate' }, seq: 1 },
        { kind: 'model-retry', retryState: 'scheduled', mode: 'always', retry: 2, delayMs: 3000, failure: { message: 'busy', code: 'AUTH' }, seq: 2 },
      ],
      current: { kind: 'model-retry', retryState: 'scheduled', mode: 'always', retry: 2, delayMs: 3000, failure: { message: 'busy', code: 'AUTH' }, seq: 2 },
    })
    expect(payload.attempts).toHaveLength(2)
    expect(payload.current.retryState).toBe('scheduled')
    expect(payload.current.mode).toBe('always')
    expect(payload.current.maxRetries).toBeUndefined() // always 无上限
    expect(payload.current.failure).toEqual({ message: 'busy', code: 'AUTH' })
  })

  it('fallback-current uses the last attempt; garbage data yields a harmless empty state', () => {
    const noCurrent = stepChatModelRetryPayloadOf({
      attempts: [{ retryState: 'cancelled', mode: 'normal', retry: 1, maxRetries: 1, delayMs: 0, failure: { message: 'x' } }],
    })
    expect(noCurrent.current.retryState).toBe('cancelled')
    const empty = stepChatModelRetryPayloadOf(undefined)
    expect(empty.attempts).toEqual([])
    expect(empty.current.retryState).toBe('cancelled')
    const bad = stepChatModelRetryPayloadOf({ attempts: 'x', current: { mode: 'mystery' } })
    expect(bad.attempts).toEqual([])
  })

  it('reads turn-error and turn-max-tokens position leaves; message degrades to empty', () => {
    const error = stepChatTurnErrorPayloadOf({
      kind: 'turn-error', seq: 4, time: 5, turn: 2, step: 1,
      message: 'connection reset', code: 'E-42',
    })
    expect(error.turn).toBe(2)
    expect(error.message).toBe('connection reset')
    expect(error.code).toBe('E-42')
    expect(stepChatTurnErrorPayloadOf(undefined).message).toBe('')
    expect(stepChatTurnErrorPayloadOf({ message: 7 }).code).toBeUndefined()
    const maxTokens = stepChatTurnMaxTokensPayloadOf({ kind: 'turn-max-tokens', seq: 6, time: 7, turn: 3, step: 2 })
    expect(maxTokens.turn).toBe(3)
    expect(stepChatTurnMaxTokensPayloadOf(null).turn).toBeUndefined()
  })

  it('reads unknown nodes: type string and opaque data pass through', () => {
    const payload = stepChatUnknownPayloadOf({ kind: 'unknown', seq: 9, time: 10, type: 'future/event', data: { x: 1 } })
    expect(payload.type).toBe('future/event')
    expect(payload.data).toEqual({ x: 1 })
    expect(stepChatUnknownPayloadOf('nope').type).toBe('')
    expect(stepChatUnknownPayloadOf({ type: 5 }).data).toBeUndefined()
  })
})

describe('tool-call payloads（B2b；root ToolCallBlock 递归断言）', () => {
  const runningRoot = {
    callId: 'root-1', name: 'bash', argsRaw: '{"command":"ls"}',
    turn: 1, step: 1, time: 1, subCalls: [
      { callId: 'child-1', parentCallId: 'root-1', name: 'read', argsRaw: '{"path":"a.ts"}', turn: 1, step: 1, time: 2, subCalls: [] },
    ],
  }

  it('reads a running root with nested subcalls and keeps call heads verbatim', () => {
    const payload = stepChatToolCallPayloadOf({ root: runningRoot })
    const root = payload.root
    expect(root).not.toBeUndefined()
    if (root === undefined || 'kind' in root) throw new Error('expected running head')
    expect(root.callId).toBe('root-1')
    expect(root.subCalls).toHaveLength(1)
    const child = root.subCalls[0]
    expect('kind' in child).toBe(false)
    expect(child.callId).toBe('child-1')
    expect(child.name).toBe('read')
  })

  it('reads a settled result: call backfill, content, error and meta pass through', () => {
    const payload = stepChatToolCallPayloadOf({
      root: {
        kind: 'tool-result', seq: 5, time: 6, callId: 'root-1',
        call: { name: 'bash', argsRaw: '{"command":"ls"}' }, callTime: 1,
        content: [{ type: 'text', text: 'a.txt\n' }, { type: 'other', x: 1 }],
        isError: false, meta: { anything: true }, subCalls: [],
      },
    })
    const root = payload.root
    if (root === undefined || !('kind' in root)) throw new Error('expected settled result')
    expect(root.isError).toBe(false)
    expect(root.content).toHaveLength(2)
    expect(root.meta).toEqual({ anything: true })
    expect(root.callTime).toBe(1)
  })

  it('degrades missing roots and malformed blocks without throwing', () => {
    expect(stepChatToolCallPayloadOf(undefined).root).toBeUndefined()
    expect(stepChatToolCallPayloadOf({ root: null }).root).toBeUndefined()
    expect(stepToolBlockOf('nope')).toBeUndefined()
    expect(stepToolBlockOf({ callId: 42, name: 'x' })).toBeUndefined()
    // 畸形子块被丢弃而非抛错
    const payload = stepChatToolCallPayloadOf({ root: { callId: 'r', name: 'x', argsRaw: '', subCalls: [null, 'x', { callId: 'ok', name: 'y', argsRaw: '', subCalls: [] }] } })
    const root = payload.root
    if (root === undefined || 'kind' in root) throw new Error('expected running head')
    expect(root.subCalls).toHaveLength(1)
  })

  it('caps recursion depth so cyclic garbage cannot blow the stack', () => {
    const deep: { callId: string; subCalls: unknown[] } = { callId: '0', subCalls: [] }
    let cursor = deep
    for (let i = 1; i <= STEP_TOOL_DEPTH_LIMIT + 10; i++) {
      const next = { callId: String(i), subCalls: [] }
      cursor.subCalls.push(next)
      cursor = next
    }
    const block = stepToolBlockOf(deep)
    expect(block).not.toBeUndefined()
    let node = block
    let depth = 0
    while (node !== undefined && !('kind' in node) && node.subCalls.length > 0) {
      node = node.subCalls[0]
      depth += 1
    }
    expect(depth).toBeLessThanOrEqual(STEP_TOOL_DEPTH_LIMIT + 1)
  })
})

// ── B3：turn-tail / turn-process 数据断言与折叠判定（对齐 rc.1） ─────────────

/** 装配 rc.1 形状的 spec（answer 边界 40、答复 step 2）。 */
function specOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    turn: 3,
    controlAnchorSeq: 10,
    processStartSeq: 10,
    answerAnchorSeq: 40,
    answerStep: 2,
    inlineReasoning: false,
    messageCount: 0,
    toolCallCount: 2,
    subagentCount: 0,
    ...overrides,
  }
}

/** 装配 rc.1 形状的展示（第一参补 spec、第二参补展示顶层字段）。 */
function presentationOf(
  specPatch: Record<string, unknown> = {},
  presentationPatch: Record<string, unknown> = {},
): StepChatTurnProcessPresentation {
  const parsed = stepChatTurnProcessPresentationOf({
    turn: 3,
    spec: specOf(specPatch),
    turnClosed: true,
    hasExternalProcess: true,
    compactAnswer: true,
    ...presentationPatch,
  })
  if (parsed === undefined) throw new Error('fixture presentation must parse')
  return parsed
}

describe('空 turn 判据（stepChatTurnsWithContentOf；turn-tail 行抑制）', () => {
  /** 一行节点（只需 kind + location.turn 两个叶子面）。 */
  const row = (kind: string, turn: number | undefined) => ({
    kind,
    location: turn === undefined ? undefined : { kind: 'turn', turn },
  })

  it('空壳 turn（只有 turn-tail / turn-process）不算有内容', () => {
    const nodes = [
      row('system-prompt', 1),
      row('turn-process', 2),
      row('turn-tail', 2),
      row('turn-tail', 3),
    ]
    expect([...stepChatTurnsWithContentOf(nodes)]).toEqual([])
  })

  it('内容行 kind（user/assistant/tool/context…）让该 turn 算有内容', () => {
    const nodes = [
      row('turn-tail', 1),
      row('user', 1),
      row('tool-call', 2),
      row('assistant-step', 3),
      row('context', 4),
      row('unknown', 5),
      row('compaction', 6),
      row('turn-error', 7),
    ]
    expect([...stepChatTurnsWithContentOf(nodes)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('系统提示词行只算会话头，不算任何 turn 的内容', () => {
    // 真实会话里 system-prompt 行挂着 turn 号，但它是会话级头行：只有它时该 turn 仍是空壳。
    expect([...stepChatTurnsWithContentOf([row('system-prompt', 9), row('turn-tail', 9)])]).toEqual([])
  })

  it('没有 location.turn 的行被忽略（不误判任何 turn 为有内容）', () => {
    expect([...stepChatTurnsWithContentOf([row('assistant-step', undefined)])]).toEqual([])
  })

  it('排除 turn-process 后，混合 turn 的判据逐个 turn 独立成立', () => {
    const nodes = [
      row('system-prompt', 1),
      row('turn-process', 1),
      row('tool-call', 1), // turn 1 有内容
      row('turn-tail', 1),
      row('turn-process', 2), // turn 2 空壳（被 park 的结算通知）
      row('turn-tail', 2),
      row('turn-tail', 3), // turn 3 空壳
    ]
    const turns = stepChatTurnsWithContentOf(nodes)
    expect(turns.has(1)).toBe(true)
    expect(turns.has(2)).toBe(false)
    expect(turns.has(3)).toBe(false)
  })

  it('同一份快照只扫一次（跨行复用缓存，不随行数膨胀）', () => {
    const nodes = [row('assistant-step', 1), row('turn-tail', 1)]
    const first = stepChatTurnsWithContentOf(nodes)
    const second = stepChatTurnsWithContentOf(nodes)
    expect(second).toBe(first)
    // 新快照（引擎发布新数组）→ 重新计算（内容可能已变）。
    const next = stepChatTurnsWithContentOf([...nodes, row('user', 2)])
    expect(next).not.toBe(first)
    expect(next.has(2)).toBe(true)
  })
})

describe('B3 turn-tail payload（rc.1 TurnTailChatData）', () => {
  const tailData = {
    turn: 3,
    seq: 88,
    time: 1000,
    branchUnavailable: false,
    closing: {
      status: 'settled', turn: 3, step: 2, time: 990,
      blocks: [
        { kind: 'text', text: '完成正文' },
        { kind: 'reasoning', text: '思考过程' },
        { kind: 'tool-call', callId: 'c1', name: 'bash', argsRaw: '[]' },
      ],
      finalNode: { seq: 80, messageId: 'm-1', time: 990 },
    },
    ttftMs: 120,
    tokensPerSecond: 24.5,
    tokenUsage: {
      totalTokens: 1500, uncachedInputTokens: 800, outputTokens: 700,
      cacheReadTokens: 100,
      routes: [{ provider: 'deepseek', model: 'chat' }],
    },
  }

  it('reads turn/seq/time/closing leaves and the branch flag', () => {
    const payload = stepChatTurnTailPayloadOf(tailData)
    expect(payload.turn).toBe(3)
    expect(payload.seq).toBe(88)
    expect(payload.time).toBe(1000)
    expect(payload.branchUnavailable).toBe(false)
    expect(payload.ttftMs).toBe(120)
    expect(payload.tokensPerSecond).toBe(24.5)
    expect(payload.closing).not.toBeNull()
    expect(payload.closing?.finalNode?.seq).toBe(80)
    expect(payload.closing?.finalNode?.messageId).toBe('m-1')
    expect(payload.closing?.time).toBe(990)
    expect(payload.tokenUsage?.totalTokens).toBe(1500)
    expect(payload.tokenUsage?.routes).toEqual([{ provider: 'deepseek', model: 'chat' }])
  })

  it('keeps text blocks for the copy payload and drops non-text leaves', () => {
    const payload = stepChatTurnTailPayloadOf(tailData)
    const blocks = payload.closing?.blocks ?? []
    const text = blocks.filter(block => block.kind === 'text').map(block => block.text).join('')
    expect(text).toBe('完成正文')
    expect(blocks.length).toBe(3) // text/reasoning/tool-call 均本地化
  })

  it('treats missing closing as null (no actions) and resists garbage', () => {
    expect(stepChatTurnTailPayloadOf(undefined).closing).toBeNull()
    expect(stepChatTurnTailPayloadOf(null).closing).toBeNull()
    expect(stepChatTurnTailPayloadOf({ closing: 'nope' }).closing).toBeNull()
    expect(stepChatTurnTailPayloadOf({ closing: null }).closing).toBeNull()
    expect(stepChatTurnTailPayloadOf({ closing: { blocks: 'x' } }).closing?.blocks).toEqual([])
    const degraded = stepChatTurnTailPayloadOf({ turn: 3, closing: { status: 'settled', blocks: [] } })
    expect(degraded.closing?.finalNode).toBeUndefined()
    expect(degraded.tokenUsage).toBeUndefined()
  })

  it('reads a partial tokenUsage and rejects missing mandatory counts', () => {
    const ok = stepChatTurnTailPayloadOf({ closing: null, tokenUsage: { totalTokens: 517, uncachedInputTokens: 17, outputTokens: 500 } })
    expect(ok.tokenUsage?.totalTokens).toBe(517)
    const partial = stepChatTurnTailPayloadOf({ closing: null, tokenUsage: { totalTokens: 5 } })
    expect(partial.tokenUsage).toBeUndefined()
  })
})

describe('B3 turn-tail timeline helpers（isLatestTurn / runMs / later node）', () => {
  it('latest-turn flag reads the raw timeline turnOrder tail', () => {
    expect(stepChatTailIsLatestTurn([1, 2, 3], 3)).toBe(true)
    expect(stepChatTailIsLatestTurn([1, 2, 3], 2)).toBe(false)
    expect(stepChatTailIsLatestTurn([], 3)).toBe(false)
    expect(stepChatTailIsLatestTurn(undefined, 3)).toBe(false)
    expect(stepChatTailIsLatestTurn([1, 'x'], undefined)).toBe(false)
  })

  it('runMs folds turn/start（timeline map）到 tail time；缺 start → undefined', () => {
    const timeline = {
      turnOrder: [3],
      turns: new Map([[3, { status: 'closed', start: { time: 500 }, end: { time: 1000 } }]]),
    }
    expect(stepChatTailRunMsOf(timeline, 3, 1000)).toBe(500)
    // start 在窗口外（map 缺 turn/start）→ undefined
    expect(stepChatTailRunMsOf({ turnOrder: [], turns: new Map() }, 3, 1000)).toBeUndefined()
    const midWindow = { turnOrder: [3], turns: new Map([[3, { status: 'open' }]]) }
    expect(stepChatTailRunMsOf(midWindow, 3, 1000)).toBeUndefined()
    // 形状不符
    expect(stepChatTailRunMsOf(null, 3, 1000)).toBeUndefined()
    expect(stepChatTailRunMsOf({ turns: { 3: 'x' } }, 3, 1000)).toBeUndefined()
    expect(stepChatTailRunMsOf(timeline, undefined, 1000)).toBeUndefined()
  })

  it('later-node scan: only same-turn visible rows after the tail count', () => {
    const rows = [
      { key: 'u', location: { turn: 3 } },
      { key: 't1', location: { turn: 3 } },
      { key: 'tail', location: { turn: 3 } },
      { key: 'u2', location: { turn: 4 } },
    ]
    expect(stepChatTailHasLaterChatNode(rows, 'tail', 3)).toBe(false)
    expect(stepChatTailHasLaterChatNode([...rows, { key: 't2', location: { turn: 3 } }], 'tail', 3)).toBe(true)
    expect(stepChatTailHasLaterChatNode(rows, 'u', 3)).toBe(true)
    expect(stepChatTailHasLaterChatNode(rows, 'missing', 3)).toBe(false)
    expect(stepChatTailHasLaterChatNode(rows, 'tail', undefined)).toBe(false)
    // 无 location 行（异常数据）不参与
    expect(stepChatTailHasLaterChatNode([{ key: 'x' }], 'x', 3)).toBe(false)
  })
})

describe('B3 turn-process spec/presentation 断言（rc.1 TurnProcessChatData）', () => {
  it('parses an answered spec with counts and null-answer degradations', () => {
    const parsed = stepTurnProcessSpecOf(specOf({ messageCount: 3, toolCallCount: 1, subagentCount: 2 }))
    expect(parsed).toEqual({
      turn: 3, controlAnchorSeq: 10, processStartSeq: 10,
      answerAnchorSeq: 40, answerStep: 2,
      inlineReasoning: false, messageCount: 3, toolCallCount: 1, subagentCount: 2,
    })
    const open = stepTurnProcessSpecOf(specOf({ answerAnchorSeq: null, answerStep: null }))
    expect(open?.answerAnchorSeq).toBeNull()
    expect(open?.answerStep).toBeNull()
  })

  it('parses a presentation and resists malformed projections', () => {
    const parsed = stepChatTurnProcessPresentationOf({
      turn: 3, spec: specOf(), turnClosed: true, hasExternalProcess: true, compactAnswer: true,
    })
    expect(parsed?.turn).toBe(3)
    expect(parsed?.turnClosed).toBe(true)
    expect(parsed?.compactAnswer).toBe(true)
    expect(stepChatTurnProcessPresentationOf(undefined)).toBeUndefined()
    expect(stepChatTurnProcessPresentationOf({ spec: 'x' })).toBeUndefined()
    // spec 与展示 turn 不一致 → 无投影（rc.1 判定 presentation.turn === spec.turn）
    expect(stepChatTurnProcessPresentationOf({ spec: specOf(), turn: 4 })).toBeUndefined()
    expect(stepChatTurnProcessPresentationOf({ spec: specOf({ turn: 9 }), turn: 3 })).toBeUndefined()
  })

  it('lists the independent kinds of the Turn-process disclosure', () => {
    for (const kind of ['system-prompt', 'user', 'steering', 'turn-process', 'turn-error', 'turn-max-tokens', 'turn-tail']) {
      expect(stepChatTurnProcessIndependentKind(kind), kind).toBe(true)
    }
    for (const kind of ['assistant-step', 'tool-call', 'context', 'command', 'compaction', 'model-retry', 'unknown']) {
      expect(stepChatTurnProcessIndependentKind(kind), kind).toBe(false)
    }
    expect(STEP_TURN_PROCESS_INDEPENDENT_KINDS.size).toBe(7)
  })
})

describe('B3 stepChatProcessSeatOf（ChatNodeSeat 折叠判定移植矩阵）', () => {
  const seat = (input: {
    kind: string
    anchorSeq: number
    assistantStep?: number | undefined
    presentation?: StepChatTurnProcessPresentation | undefined
    open?: boolean
    compactTranscript?: boolean
    historyIncomplete?: boolean
  }): StepChatProcessSeatState => stepChatProcessSeatOf({
    kind: input.kind,
    anchorSeq: input.anchorSeq,
    ...(input.assistantStep === undefined ? {} : { assistantStep: input.assistantStep }),
    ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
    open: input.open ?? false,
    ...(input.compactTranscript === undefined ? {} : { compactTranscript: input.compactTranscript }),
    // 批 A：historyIncomplete 是必传字段（官方 ChatNodeSeat 吃真实 hasMore）；
    // 本矩阵默认窗口完整（false），专用用例显式传 true 验证守卫。
    historyIncomplete: input.historyIncomplete ?? false,
  })

  it('folds a process member row when closed and compact; open reveals it', () => {
    const presentation = presentationOf()
    const closed = seat({ kind: 'tool-call', anchorSeq: 15, presentation, open: false })
    expect(closed.member).toBe(true)
    expect(closed.foldable).toBe(true)
    expect(closed.hidden).toBe(true)
    const opened = seat({ kind: 'tool-call', anchorSeq: 15, presentation, open: true })
    expect(opened.member).toBe(true)
    expect(opened.hidden).toBe(false)
    expect(opened.compactAnswer).toBe(false)
  })

  it('gates membership by window [processStartSeq, answerAnchorSeq)', () => {
    const presentation = presentationOf()
    expect(seat({ kind: 'tool-call', anchorSeq: 9, presentation }).member).toBe(false)
    expect(seat({ kind: 'tool-call', anchorSeq: 10, presentation }).member).toBe(true)
    expect(seat({ kind: 'tool-call', anchorSeq: 40, presentation }).member).toBe(false)
  })

  it('never folds independent kinds even inside the window', () => {
    const presentation = presentationOf()
    for (const kind of ['user', 'steering', 'system-prompt', 'turn-tail', 'turn-error']) {
      const state = seat({ kind, anchorSeq: 15, presentation })
      expect(state.member, kind).toBe(false)
      expect(state.foldable, kind).toBe(false)
      expect(state.hidden, kind).toBe(false)
    }
  })

  it('marks the answer row（assistant-step + step match）with the compact seat', () => {
    const presentation = presentationOf()
    const answer = seat({ kind: 'assistant-step', anchorSeq: 40, assistantStep: 2, presentation })
    expect(answer.answer).toBe(true)
    expect(answer.ownsDisclosure).toBe(true)
    expect(answer.foldable).toBe(true)
    expect(answer.compactAnswer).toBe(true)
    expect(answer.hidden).toBe(false)
    // 打开后紧凑位解除
    const open = seat({ kind: 'assistant-step', anchorSeq: 40, assistantStep: 2, presentation, open: true })
    expect(open.compactAnswer).toBe(false)
    // step 不匹配 → 不是答复（进程内 assistant 成员行）
    const memberAssistant = seat({ kind: 'assistant-step', anchorSeq: 20, assistantStep: 1, presentation })
    expect(memberAssistant.answer).toBe(false)
    expect(memberAssistant.member).toBe(true)
    expect(memberAssistant.hidden).toBe(true)
  })

  it('hides an inactive turn-process controller（运行中/无披露）but shows foldable ones', () => {
    const external = presentationOf()
    expect(seat({ kind: 'turn-process', anchorSeq: 9.9, presentation: external }).foldable).toBe(true)
    expect(seat({ kind: 'turn-process', anchorSeq: 9.9, presentation: external }).hidden).toBe(false)
    // 无外部进程且无内联推理 → 无可披露 → controllerInactive
    const bare = presentationOf({}, { hasExternalProcess: false, compactAnswer: false })
    const inactive = seat({ kind: 'turn-process', anchorSeq: 9.9, presentation: bare })
    expect(inactive.foldable).toBe(false)
    expect(inactive.controllerInactive).toBe(true)
    expect(inactive.hidden).toBe(true)
  })

  it('does not fold while the turn is open, before an answer, or in normal transcript', () => {
    const running = presentationOf({}, { turnClosed: false })
    const openTurn = seat({ kind: 'tool-call', anchorSeq: 15, presentation: running })
    expect(openTurn.windowReady).toBe(false)
    expect(openTurn.hidden).toBe(false)
    const unanswered = stepChatTurnProcessPresentationOf({
      turn: 3, spec: specOf({ answerAnchorSeq: null, answerStep: null }),
      turnClosed: true, hasExternalProcess: true, compactAnswer: true,
    })
    if (unanswered === undefined) throw new Error('fixture must parse')
    const preAnswer = seat({ kind: 'tool-call', anchorSeq: 15, presentation: unanswered })
    expect(preAnswer.windowReady).toBe(false)
    expect(preAnswer.hidden).toBe(false)
    const normal = seat({
      kind: 'tool-call', anchorSeq: 15, presentation: presentationOf(), compactTranscript: false,
    })
    expect(normal.hidden).toBe(false)
  })

  // 批 A（A2）：折叠守卫对齐官方——rc.1 ChatView 在 `historyIncomplete === hasMore
  // === true` 时不折叠 turn-process（ChatNodeSeat.processWindowReady 要求
  // !historyIncomplete）。窗口不全（更早的历史还没 loadOlder 进来）时若照常折叠，
  // 窗口外仍存在的成员行会被误隐、答复边界也可能缺失；官方因此整轮禁止折叠。
  it('never folds when the history window is incomplete（hasMore 守卫）', () => {
    const presentation = presentationOf()
    // 成员行：完整窗口下折叠（hidden），窗口不全时一行都不折叠。
    const memberWhole = seat({ kind: 'tool-call', anchorSeq: 15, presentation })
    expect(memberWhole.windowReady).toBe(true)
    expect(memberWhole.member).toBe(true)
    expect(memberWhole.foldable).toBe(true)
    expect(memberWhole.hidden).toBe(true)
    const memberPartial = seat({
      kind: 'tool-call', anchorSeq: 15, presentation, historyIncomplete: true,
    })
    expect(memberPartial.windowReady).toBe(false)
    expect(memberPartial.member).toBe(false)
    expect(memberPartial.answer).toBe(false)
    expect(memberPartial.foldable).toBe(false)
    expect(memberPartial.compactAnswer).toBe(false)
    expect(memberPartial.controllerInactive).toBe(false)
    expect(memberPartial.hidden).toBe(false)
    // 答复行：窗口不全时紧凑答复位（compactAnswer）同样解除。
    const answerPartial = seat({
      kind: 'assistant-step', anchorSeq: 40, assistantStep: 2,
      presentation, historyIncomplete: true,
    })
    expect(answerPartial.answer).toBe(false)
    expect(answerPartial.compactAnswer).toBe(false)
    expect(answerPartial.hidden).toBe(false)
    // turn-process 控制节点：窗口不全时 windowReady 假 → foldable 假 → 官方把控制
    // 节点读作「无披露可折叠」（controllerInactive）并隐藏该行。这不是面板自创：
    // rc.1 ChatNodeSeat 的 controllerInactive = kind==='turn-process' && !foldable
    //（foldable 含 !historyIncomplete），二者逐字一致——隐藏态是
    // `hidden="until-found"`（保留 DOM 与锚点），loadOlder 补齐窗口后自动恢复可折叠。
    const controllerPartial = seat({
      kind: 'turn-process', anchorSeq: 9.9, presentation, historyIncomplete: true,
    })
    expect(controllerPartial.foldable).toBe(false)
    expect(controllerPartial.controllerInactive).toBe(true)
    expect(controllerPartial.hidden).toBe(true)
    // 对照：同一控制节点在窗口完整时是可折叠披露头（不隐藏）——守住上面这些
    // 断言的对照组，避免把「窗口不全」误读成「该行永不显示」。
    const controllerWhole = seat({ kind: 'turn-process', anchorSeq: 9.9, presentation })
    expect(controllerWhole.foldable).toBe(true)
    expect(controllerWhole.controllerInactive).toBe(false)
    expect(controllerWhole.hidden).toBe(false)
    // 独立 kind 在两种窗口态下都不折叠（回归：守卫不引入新的隐藏路径）。
    for (const kind of ['user', 'steering', 'system-prompt', 'turn-tail']) {
      const state = seat({ kind, anchorSeq: 15, presentation, historyIncomplete: true })
      expect(state.hidden, kind).toBe(false)
      expect(state.foldable, kind).toBe(false)
    }
  })

  it('reasoning-hidden matches rc.1（答复 + inlineReasoning + 折叠中）', () => {
    const inline = presentationOf({ inlineReasoning: true })
    expect(stepChatReasoningHiddenOf(inline, 2, false, true)).toBe(true)
    expect(stepChatReasoningHiddenOf(inline, 2, true, true)).toBe(false) // 展开后显示
    expect(stepChatReasoningHiddenOf(inline, 1, false, true)).toBe(false) // 非答复 step
    expect(stepChatReasoningHiddenOf(inline, 2, false, false)).toBe(false) // 行壳非答复
    expect(stepChatReasoningHiddenOf(undefined, 2, false, true)).toBe(false)
    const plain = presentationOf({ inlineReasoning: false })
    expect(stepChatReasoningHiddenOf(plain, 2, false, true)).toBe(false)
  })
})
