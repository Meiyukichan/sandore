/**
 * chat-flow：轻量子代理面板的纯逻辑层（无 React / 无 DSH 运行时依赖，vitest node
 * 环境可跑）。对应 DSH ChatView 的「组装层→渲染行」语义：
 *
 * - 从 `snapshot.nodes`（公开 `ConversationNode[]`，已排序）取**最新 10 条节点**；
 * - assistant 节点的 tool-call 块展开为独立工具行（与 DSH 把 tool-call 组装为独立
 *   'tool-call' 行的行为一致），tool-result 节点与同 callId 的未结算工具行**配对**
 *   （替换该行——即 DSH 的「同一行从 running 更新为 settled」），窗口截断导致 call
 *   头不可见时单列（与 DSH 的 soft-fall 一致）；
 * - `partial`（流式 assistant 增量）追加为流式 agent 行 + 运行中工具行；
 * - context/compaction/model-retry/turn-error/turn-max-tokens/unknown 等边缘节点映射为
 *   展示行（对应 DSH `conversation.chat.node` 各 keyed 渲染器）；
 * - 已完结 turn（`turnTimings`/`turnEnds` 提供时）在其结算 assistant 行后派生
 *   **turn-tail 行**（对应 DSH 的 'turn-tail' ChatNode：复制 + 运行时长/TTFT/吞吐 +
 *   branch；branchUnavailable 近似为「结算行不是面板最后一行」）。
 *
 * 组件层（StepChatPanel）把 `StepChatFlowRow` 逐一映射为抄自 DSH 的渲染组件。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/chat-flow
 */
import type {
  AssistantBlock, CommandNode, CompactionSummaryNode, ContextMessageNode, ConversationNode, ModelRetryNode,
  PartialAssistant, RunningToolCall, ToolCallBlock, TurnErrorNode, TurnMaxTokensNode,
  UnknownSurfaceNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import { assistantText } from './chat/turn-assistant.ts'
import { deriveTurnMetrics } from './chat/turn-metrics.ts'

/** 面板展示的最大节点数（轻量面板：仅最新 10 条节点）。 */
export const STEP_CHAT_MAX_NODES = 10

/**
 * `buildStepChatFlow` 的最小快照输入面（只读 nodes/partial/runningCalls；
 * `ConversationSnapshot` 结构上满足它，单测可直接构造小对象）。
 */
export interface StepChatFlowInput {
  readonly nodes: readonly ConversationNode[]
  readonly partial: PartialAssistant | null
  readonly runningCalls: readonly RunningToolCall[]
  /** 已完结 turn 的时间边界（`ConversationSnapshot.turnTimings`）；缺省不派生 turn-tail。 */
  readonly turnTimings?: ReadonlyMap<number, { readonly startTime: number; readonly endTime?: number }>
}

/** turn-tail 展示数据（对齐 DSH `TurnTailChatData` 的展示面；组件层消费）。 */
export interface StepChatTailData {
  /** 已完结 turn 号。 */
  turn: number
  /** 结算 assistant 节点 seq（分支锚点）。 */
  seq: number
  /** 结算时间（Unix epoch ms；时钟用）。 */
  time: number
  /** 结算 assistant 的拼接文本（复制按钮取文本）。 */
  text: string
  /** Turn 壁钟时长 ms；turn/start|end 均在窗口内时可用。 */
  runMs?: number | undefined
  /** Turn 首步 TTFT ms；未记录时省略。 */
  ttftMs?: number | undefined
  /** Turn 解码吞吐；未记录时省略。 */
  tokensPerSecond?: number | undefined
  /** 分支不可用（结算 assistant 非窗口尾部等）。 */
  branchUnavailable: boolean
}

/** 一条展示行（kind 判别；key 为 React key，跨快照稳定）。 */
export type StepChatFlowRow =
  | {
    readonly kind: 'user'
    readonly key: string
    readonly node: Extract<ConversationNode, { kind: 'user' | 'steering' }>
  }
  | {
    readonly kind: 'agent'
    readonly key: string
    readonly blocks: readonly AssistantBlock[]
    readonly streaming: boolean
    readonly interrupted: boolean
  }
  | { readonly kind: 'tool'; readonly key: string; readonly toolName: string; readonly block: ToolCallBlock }
  | { readonly kind: 'command'; readonly key: string; readonly node: CommandNode }
  | { readonly kind: 'context'; readonly key: string; readonly node: ContextMessageNode }
  | { readonly kind: 'compaction'; readonly key: string; readonly node: CompactionSummaryNode }
  | { readonly kind: 'retry'; readonly key: string; readonly node: ModelRetryNode }
  | { readonly kind: 'turn-error'; readonly key: string; readonly node: TurnErrorNode }
  | { readonly kind: 'turn-max-tokens'; readonly key: string }
  | { readonly kind: 'unknown'; readonly key: string; readonly node: UnknownSurfaceNode }
  | { readonly kind: 'tail'; readonly key: string; readonly data: StepChatTailData }

/** assistant 节点的 tool-call 块 → RunningToolCall（工具行 running 态数据面）。 */
function runningCallOf(
  block: Extract<AssistantBlock, { kind: 'tool-call' }>,
  turn: number,
  step: number,
  time: number,
): RunningToolCall {
  return {
    callId: block.callId,
    name: block.name,
    argsRaw: block.argsRaw,
    turn,
    step,
    time,
    callView: null,
    subCalls: [],
  }
}

/** 命令节点 → 展示行。 */
function commandRow(node: CommandNode): StepChatFlowRow {
  return { kind: 'command', key: `command-${node.seq}`, node }
}

/**
 * tool-result 节点 → 工具行：优先与同 callId 的最后一条未结算工具行配对（原地替换，
 * 即 DSH 的 running→settled 更新）；窗口截断导致 call 头不可见时单列（name 回退
 * `call?.name ?? callId`）。
 * @returns 配对成功返回 null（已原地替换）；否则返回新的单列行。
 */
function toolResultRow(
  node: Extract<ConversationNode, { kind: 'tool-result' }>,
  rows: StepChatFlowRow[],
  toolIndexByCallId: Map<string, number>,
): StepChatFlowRow | null {
  const index = toolIndexByCallId.get(node.callId)
  if (index !== undefined) {
    const row = rows[index]
    if (row !== undefined && row.kind === 'tool') {
      // 配对：同一 callId 行从 running 更新为 settled（ToolResultNode ⊂ ToolCallBlock）。
      rows[index] = { ...row, block: node }
      return null
    }
  }
  // 窗口截断：call 头不可见，退化为独立结果行（DSH soft-fall）。
  return {
    kind: 'tool',
    key: `tool-result-${node.seq}`,
    toolName: node.call?.name ?? node.callId,
    block: node,
  }
}

/** 关闭行文本判定（DSH `tailData.hasText`：finalNode 携带非空文本块）。 */
function hasText(node: Extract<ConversationNode, { kind: 'assistant' }>): boolean {
  return node.blocks.some(block => block.kind === 'text' && block.text.trim() !== '')
}

/** 已完结 turn 的关闭行 + tail 数据（在 agent 行之后插入）。 */
interface PendingTail {
  readonly rowIndex: number
  readonly data: StepChatTailData
}

/**
 * 快照 → 展示行（最新 10 条节点；assistant 展开为文本行 + 工具行；partial 追加在尾部；
 * 已完结 turn 派生 turn-tail 行）。
 */
export function buildStepChatFlow(snapshot: StepChatFlowInput): readonly StepChatFlowRow[] {
  const rows: StepChatFlowRow[] = []
  const toolIndexByCallId = new Map<string, number>()
  // turn → 最后一个带文本的 assistant 行索引 + 节点（tail 关闭行候选）。
  const closingByTurn = new Map<number, { rowIndex: number; node: Extract<ConversationNode, { kind: 'assistant' }> }>()

  const pushTool = (row: StepChatFlowRow): void => {
    rows.push(row)
    if (row.kind === 'tool') toolIndexByCallId.set(row.block.callId, rows.length - 1)
  }

  for (const node of snapshot.nodes.slice(-STEP_CHAT_MAX_NODES)) {
    switch (node.kind) {
      case 'user':
        rows.push({ kind: 'user', key: `user-${node.seq}`, node })
        break
      case 'steering':
        rows.push({ kind: 'user', key: `steering-${node.seq}`, node })
        break
      case 'assistant': {
        rows.push({
          kind: 'agent',
          key: `assistant-${node.seq}`,
          blocks: node.blocks,
          streaming: false,
          interrupted: node.interrupted === true,
        })
        if (hasText(node)) closingByTurn.set(node.turn, { rowIndex: rows.length - 1, node })
        for (const block of node.blocks) {
          if (block.kind !== 'tool-call') continue
          pushTool({
            kind: 'tool',
            key: `tool-${block.callId}`,
            toolName: block.name,
            block: runningCallOf(block, node.turn, node.step, node.time),
          })
        }
        break
      }
      case 'tool-result': {
        const row = toolResultRow(node, rows, toolIndexByCallId)
        if (row !== null) pushTool(row)
        break
      }
      case 'command':
        rows.push(commandRow(node))
        break
      case 'context':
        rows.push({ kind: 'context', key: `context-${node.seq}`, node })
        break
      case 'compaction':
        rows.push({ kind: 'compaction', key: `compaction-${node.seq}`, node })
        break
      case 'model-retry':
        rows.push({ kind: 'retry', key: `retry-${node.seq}`, node })
        break
      case 'turn-error':
        rows.push({ kind: 'turn-error', key: `turn-error-${node.seq}`, node })
        break
      case 'turn-max-tokens':
        rows.push({ kind: 'turn-max-tokens', key: `turn-max-tokens-${node.seq}` })
        break
      case 'unknown':
        rows.push({ kind: 'unknown', key: `unknown-${node.seq}`, node })
        break
    }
  }

  // 流式增量：assistant partial 追加为流式 agent 行 + 运行中工具行。
  if (snapshot.partial !== null) {
    const { turn, step, blocks } = snapshot.partial
    rows.push({
      kind: 'agent',
      key: `partial-agent-${turn}-${step}`,
      blocks,
      streaming: true,
      interrupted: false,
    })
    for (const block of blocks) {
      if (block.kind !== 'tool-call') continue
      pushTool({
        kind: 'tool',
        key: `partial-tool-${block.callId}`,
        toolName: block.name,
        block: runningCallOf(block, turn, step, Date.now()),
      })
    }
  }

  // turn-tail 派生：已完结 turn 的关闭行后插入 tail 行（DSH 'turn-tail' ChatNode 语义）。
  if (snapshot.turnTimings !== undefined && closingByTurn.size > 0) {
    const sliced = snapshot.nodes.slice(-STEP_CHAT_MAX_NODES)
    const metrics = deriveTurnMetrics(sliced)
    const tails: PendingTail[] = []
    for (const [turn, closing] of closingByTurn) {
      const timing = snapshot.turnTimings.get(turn)
      // 无 turn/end：turn 未完结（或 end 在窗口外），DSH 同样不产出 tail。
      if (timing === undefined || timing.endTime === undefined) continue
      const turnMetrics = metrics.get(turn)
      const data: StepChatTailData = {
        turn,
        seq: closing.node.seq,
        time: closing.node.time,
        text: assistantText(closing.node.blocks),
        runMs: Math.max(0, timing.endTime - timing.startTime),
        ...turnMetrics?.ttftMs === undefined ? {} : { ttftMs: turnMetrics.ttftMs },
        ...turnMetrics?.tokensPerSecond === undefined ? {} : { tokensPerSecond: turnMetrics.tokensPerSecond },
        // 近似（DSH 用 turn 内 tool/call|tool/result|error-end|retry 的 latest seq 比较）：
        // 窗口内该 turn 的关闭行之后还有任何行（工具结算等）→ 分支不可用。
        branchUnavailable: closing.rowIndex !== rows.length - 1,
      }
      tails.push({ rowIndex: closing.rowIndex, data })
    }
    // 按关闭行索引升序插入（前面已插入的 tail 使后续目标索引后移），保证多 turn 顺序稳定。
    tails.sort((a, b) => a.rowIndex - b.rowIndex)
    let inserted = 0
    for (const tail of tails) {
      rows.splice(tail.rowIndex + 1 + inserted, 0, { kind: 'tail', key: `tail-${tail.data.turn}`, data: tail.data })
      inserted += 1
    }
  }

  return rows
}
