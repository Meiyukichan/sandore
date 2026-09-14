/**
 * step-row-data：StepChatViewRow 逐 kind 渲染（B2a/B2b）的**本地 payload 断言层**。
 *
 * 只做两件事：
 * 1. 各 kind 的 data **结构断言类型**——形状照抄 DSH 0.1.2-rc.1（deepseek-harness，只读）：
 *    - ui-chat `conversation-nodes/message.ts` 产出 user/steering/context 状态，
 *      其 buildViewNode 把状态整体作为 data 发布；
 *    - ui-chat `conversation-nodes/assistant.ts` 产出 `assistant-step` 的
 *      AssistantChatData（contract/chat-nodes.ts）；
 *    - ui-chat `conversation-nodes/request-prompt.ts` 产出 `system-prompt`
 *      `{ text }`；
 *    - ui-chat `conversation-nodes/command.ts` / `compaction.ts` 产出 command /
 *      manual-compaction / compaction（CommandNode / ManualCompactionChatData /
 *      CompactionSummaryNode）；
 *    - ui-chat `conversation-nodes/retry.ts` / `turn-error.ts` /
 *      `turn-max-tokens.ts` / `fallback.ts` 产出 model-retry / turn-error /
 *      turn-max-tokens / unknown（RetryChatData / TurnErrorNode /
 *      TurnMaxTokensNode / UnknownSurfaceNode）；
 *    - ui-chat `conversation-nodes/tool.ts` 产出 `tool-call` 的 { root:
 *      ToolCallBlock }（递归 RunningToolCall/ToolResultNode 树；打断投影会把
 *      running 根合成为 isError 的 synthetic tool-result）；
 *    - AssistantBlock 形状照 ui-conversation `contract/records.ts` + ui-chat
 *      `contract/snapshot.ts`（kind/text/reasoning/image/tool-call/other）。
 * 2. 运行防御读取：引擎 data 是 live 引用，按 unknown 叶子读取；字段缺失/形状
 *    不符一律按 rc.1 空态处理（空文本/空列表/null/跳过），**不抛**。
 *
 * 纯函数与读取器全部收在这里，供 step-view 渲染组件与单元测试共用（仓库纪律：
 * 纯逻辑可单测）。tool 行摘要/卡材质的进一步纯派生在 step-view/tool/ 子目录
 * （抄 ui-tool 0.1.2-rc.1 models，消费本文件的本地 Tool block 断言面）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/step-row-data
 */

// ── 通用叶子守卫（不抛） ──────────────────────────────────────────────────────

/** 记录守卫（对象且非数组）。 */
export function stepIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isTextBlock(value: unknown): value is { type: 'text'; text: string } {
  return stepIsRecord(value) && value.type === 'text' && typeof value.text === 'string'
}

// ── 消息（user / steering）data ───────────────────────────────────────────────
//
// rc.1（ui-chat conversation-nodes/message.ts + ui-conversation contract/records.ts）：
// - user（ReferencedUserMessageNode）：{ kind:'user', seq, time, content, source }；
//   仅当紧随的会话引用上下文给本条贴上标签时才带 referenceLabels。
// - steering（ReferencedSteeringMessageNode）：上面 + messageId（进入活跃轮次的
//   准入消息，与本条在历史中的 inbox 出现共享同一 identity）。
// content 为 readonly ContentBlock[]（text/image/…，merge-extensible），本地一律
// 按 unknown 探测。

/** user/steering 行的本地 payload 断言。 */
export interface StepChatUserMessagePayload {
  /** 引擎节点 kind（user / steering）；未知时为 undefined（行渲染同 user 空态）。 */
  readonly kind?: 'user' | 'steering' | undefined
  /** 准入消息稳定 id（仅 steering 有）。 */
  readonly messageId?: unknown
  readonly seq?: number
  /** Unix epoch ms（消息行时钟）。 */
  readonly time?: number
  /** 消息内容块（unknown 叶子；text/image/… 探测读取）。 */
  readonly content: readonly unknown[]
  readonly source?: unknown
  /** 紧随的召回上下文引用标签（气泡下方「引用会话 · …」摘要行）。 */
  readonly referenceLabels?: readonly string[]
}

/**
 * 读取 user/steering 行的 data（不抛）。
 * @param data - ChatNode.data（unknown）。
 * @returns 本地 payload；非记录/不可读字段按空态补齐。
 */
export function stepChatUserPayloadOf(data: unknown): StepChatUserMessagePayload {
  const record = stepIsRecord(data) ? data : null
  const kind = record === null ? undefined
    : record.kind === 'user' || record.kind === 'steering' ? record.kind : undefined
  const content = record === null || !Array.isArray(record.content) ? [] : record.content
  const referenceLabels = record !== null && Array.isArray(record.referenceLabels)
    ? record.referenceLabels.filter((label): label is string => typeof label === 'string')
    : undefined
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(record !== null && record.messageId !== undefined ? { messageId: record.messageId } : {}),
    ...(record !== null && finiteNumber(record.seq) ? { seq: record.seq } : {}),
    ...(record !== null && finiteNumber(record.time) ? { time: record.time } : {}),
    content,
    ...(record !== null && record.source !== undefined ? { source: record.source } : {}),
    ...(referenceLabels === undefined ? {} : { referenceLabels }),
  }
}

/**
 * 内容块分区（rc.1 MessageItem.contentParts 语义）：文本块按出现顺序拼接成一段
 * 纯文本、image 块收集 attachment、其余未知块原样保留（渲染成 JsonBlock）。
 * @param content - 消息内容块（unknown 探测）。
 * @returns 文本 / 图片附件 / 其余未知块 三分区。
 */
export function stepContentParts(content: readonly unknown[]): {
  text: string
  images: readonly { readonly attachment: unknown }[]
  rest: readonly unknown[]
} {
  const texts: string[] = []
  const images: { attachment: unknown }[] = []
  const rest: unknown[] = []
  for (const block of content) {
    if (isTextBlock(block)) {
      texts.push(block.text)
    } else if (stepIsRecord(block) && block.type === 'image' && block.attachment !== undefined) {
      images.push({ attachment: block.attachment })
    } else {
      rest.push(block)
    }
  }
  return { text: texts.join(''), images, rest }
}

// ── context data ─────────────────────────────────────────────────────────────
//
// rc.1（conversation-nodes/message.ts source.kind !== 'user' 分支 +
// event-projection.contextForm/contextProvenance + ui-conversation
// contract/context-provenance.ts）：
//   { kind:'context', seq, time, content, source,
//     provenance: { role: 'inject'|'recall', label: string|null },
//     form: 'instructions'|'catalog'|'snapshot'|'notice'|'relay'|'recall'|null }
// 未知/缺失 form 由 body 层回退 opaque（rc.1 ContextBody 的文档化默认）。

/** 本地 KnownContextForm（照 ui-conversation context-provenance.ts）。 */
export type StepKnownContextForm =
  | 'instructions'
  | 'catalog'
  | 'snapshot'
  | 'notice'
  | 'relay'
  | 'recall'

/** 本地 ContextProvenanceView（照 ui-conversation context-provenance.ts）。 */
export interface StepContextProvenance {
  readonly role: 'inject' | 'recall'
  readonly label: string | null
}

/** context 行的本地 payload 断言。 */
export interface StepChatContextPayload {
  readonly kind?: 'context' | undefined
  readonly seq?: number
  /** Unix epoch ms。 */
  readonly time?: number
  /** 模型可见内容块（unknown 叶子）。 */
  readonly content: readonly unknown[]
  readonly source?: unknown
  /** 行头角色与 producer 名（无法判定 → 默认 inject/label null）。 */
  readonly provenance: StepContextProvenance
  /** producer 声明的信息 form（缺失/未知 → null → opaque body）。 */
  readonly form: StepKnownContextForm | null
}

/** 判定已知 form（rc.1 event-projection.KNOWN_FORMS 的本地副本）。 */
export function stepKnownContextFormOf(value: unknown): StepKnownContextForm | null {
  return value === 'instructions' || value === 'catalog' || value === 'snapshot'
    || value === 'notice' || value === 'relay' || value === 'recall'
    ? value
    : null
}

/**
 * 读取 context 行的 data（不抛）。
 * @param data - ChatNode.data（unknown）。
 * @returns 本地 payload；非记录/缺失字段按空态（rc.1 opaque 面）补齐。
 */
export function stepChatContextPayloadOf(data: unknown): StepChatContextPayload {
  const record = stepIsRecord(data) ? data : null
  const content = record === null || !Array.isArray(record.content) ? [] : record.content
  const rawProvenance = stepIsRecord(record?.provenance) ? record.provenance : null
  const role = rawProvenance?.role === 'recall' ? 'recall' as const : 'inject' as const
  const label = typeof rawProvenance?.label === 'string' ? rawProvenance.label : null
  return {
    ...(record !== null && finiteNumber(record.seq) ? { seq: record.seq } : {}),
    ...(record !== null && finiteNumber(record.time) ? { time: record.time } : {}),
    content,
    ...(record !== null && record.source !== undefined ? { source: record.source } : {}),
    provenance: { role, label },
    form: record === null ? null : stepKnownContextFormOf(record.form),
  }
}

// ── system-prompt data ───────────────────────────────────────────────────────
//
// rc.1（conversation-nodes/request-prompt.ts）：buildViewNode 产出
//   { text: state.prompt.system }（完整模型可见 system prompt；空串不产节点）。

/** system-prompt 行的本地 payload 断言。 */
export interface StepChatSystemPromptPayload {
  /** 完整模型可见提示词文本。 */
  readonly text: string
}

/**
 * 读取 system-prompt 行的 data（不抛）。
 * @param data - ChatNode.data（unknown）。
 * @returns 本地 payload；缺失/非字符串按空态（空文本 → 行渲染空摘要行）补齐。
 */
export function stepChatSystemPromptPayloadOf(data: unknown): StepChatSystemPromptPayload {
  const record = stepIsRecord(data) ? data : null
  return { text: typeof record?.text === 'string' ? record.text : '' }
}

// ── assistant-step data 与 blocks ────────────────────────────────────────────
//
// rc.1（contract/chat-nodes.ts AssistantChatData + contract/snapshot.ts
// AssistantBlock；conversation-nodes/assistant.ts 的 blockIsVisible 等空态语义）：
//   { status:'running'|'settled'|'interrupted', turn, step, time,
//     blocks: AssistantBlock[], usage?, finalNode? }

/** 本地 AssistantBlock 最小面（引擎 live 引用 → 副本化叶子，仅保留渲染所需）。 */
export type StepAssistantBlock =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'image'; readonly attachment: unknown }
  | { readonly kind: 'tool-call'; readonly callId?: string; readonly name?: string; readonly argsRaw?: string }
  | { readonly kind: 'other'; readonly block: unknown }

/** assistant-step 行的本地 payload 断言（对齐 AssistantChatData）。 */
export interface StepChatAssistantStepPayload {
  readonly status: 'running' | 'settled' | 'interrupted'
  readonly turn?: number
  readonly step?: number
  readonly blocks: readonly StepAssistantBlock[]
  readonly time?: number
  /** 回合/provider 用量（B2 仅透出，不渲染）。 */
  readonly usage?: unknown
  /** 终结 assistant 消息节点（B3 轮次轴等用；此处不消费）。 */
  readonly finalNode?: unknown
}

/**
 * 读取一个块为本地块（不抛）。
 * 未知 kind 一律归入 `other`（rc.1 对未知块渲染 JsonBlock 的默认臂语义）。
 * @param block - AssistantBlock 或 undefined/异物。
 * @returns 本地块；非记录/不可读 → undefined（rc.1 blockIsVisible 的空态）。
 */
export function stepAssistantBlockOf(block: unknown): StepAssistantBlock | undefined {
  if (!stepIsRecord(block)) return undefined
  switch (block.kind) {
    case 'text':
    case 'reasoning':
      return typeof block.text === 'string'
        ? { kind: block.kind, text: block.text }
        : undefined
    case 'image':
      return { kind: 'image', attachment: block.attachment }
    case 'tool-call':
      return {
        kind: 'tool-call',
        ...(typeof block.callId === 'string' ? { callId: block.callId } : {}),
        ...(typeof block.name === 'string' ? { name: block.name } : {}),
        ...(typeof block.argsRaw === 'string' ? { argsRaw: block.argsRaw } : {}),
      }
    default:
      return { kind: 'other', block }
  }
}

/** 读取 assistant-step 的 data（不抛）：缺 blocks/形状不符 → 空块列表 + settled 空态。 */
export function stepChatAssistantStepPayloadOf(data: unknown): StepChatAssistantStepPayload {
  const record = stepIsRecord(data) ? data : null
  const rawBlocks = record === null || !Array.isArray(record.blocks) ? [] : record.blocks
  const blocks: StepAssistantBlock[] = []
  for (const block of rawBlocks) {
    const local = stepAssistantBlockOf(block)
    if (local !== undefined) blocks.push(local)
  }
  const status = record?.status === 'running' || record?.status === 'interrupted'
    ? record.status
    : record?.status === 'settled' ? 'settled' : 'settled'
  return {
    status,
    blocks,
    ...(record !== null && finiteNumber(record.turn) ? { turn: record.turn } : {}),
    ...(record !== null && finiteNumber(record.step) ? { step: record.step } : {}),
    ...(record !== null && finiteNumber(record.time) ? { time: record.time } : {}),
    ...(record !== null && record.usage !== undefined ? { usage: record.usage } : {}),
    ...(record !== null && record.finalNode !== undefined ? { finalNode: record.finalNode } : {}),
  }
}

/**
 * 块可见性（rc.1 conversation-nodes/assistant.ts blockIsVisible 语义）：
 * - 未定义 / tool-call 头 → false（工具头由工具行分组呈现，不占正文）；
 * - text / reasoning → 文本去空白后非空；
 * - image / other → true。
 * @param block - 本地块（undefined 表示空位）。
 * @returns 该块是否算「模型可见正文内容」。
 */
export function stepBlockIsVisible(block: StepAssistantBlock | undefined): boolean {
  if (block === undefined || block.kind === 'tool-call') return false
  if (block.kind === 'text' || block.kind === 'reasoning') return block.text.trim() !== ''
  return true
}

/** 是否含任意可见正文块（rc.1 hasVisibleContent 语义；行是否值得画壳）。 */
export function stepHasVisibleAssistantContent(blocks: readonly StepAssistantBlock[]): boolean {
  return blocks.some(stepBlockIsVisible)
}

/**
 * 是否含用户可见回复（rc.1 ui-chat contract/assistant-content.ts
 * hasAssistantReplyContent 语义）：reasoning/tool-call 不算回复。
 * @param blocks - 本地块。
 * @returns 正文是否含可作「回复」的内容（供跳读/锚点类逻辑）。
 */
export function stepHasAssistantReplyContent(blocks: readonly StepAssistantBlock[]): boolean {
  return blocks.some((block) => {
    if (block.kind === 'reasoning' || block.kind === 'tool-call') return false
    if (block.kind === 'text') return block.text.trim() !== ''
    return true
  })
}

/**
 * 行壳判定（rc.1 AssistantMarkdown 的 hasVisible 语义）：流式中 / 打断标记 /
 * 存在非 tool-call 块（含空文本位）都要画壳。
 */
export function stepAssistantMarkdownHasShell(
  blocks: readonly StepAssistantBlock[],
  streaming: boolean,
  interrupted: boolean,
): boolean {
  return streaming || interrupted || blocks.some(block => block.kind !== 'tool-call')
}

// ── context body 纯逻辑（rc.1 chat/ContextBody.tsx） ──────────────────────────

/** 文本行上限（模型面文本在披露处而非 producer 处限长；rc.1 MAX_CHARS）。 */
export const STEP_CONTEXT_TEXT_LIMIT = 20_000

/** 列表类 body 先物化、其余汇总的行数（rc.1 MAX_ENTRIES）。 */
export const STEP_CONTEXT_ENTRY_LIMIT = 200

/** 一段模型面内容：相邻 text 一段，或一个未知块独占一段。 */
export type StepContentRun = { readonly text: string } | { readonly block: unknown }

/**
 * 按模型收到顺序切内容为 run（rc.1 contentRuns 语义）：相邻 text 块无分隔拼接
 * （provider 展平时不插行），未知块断 run 并保留自己的回退呈现。
 * @param content - 内容块（unknown 探测）。
 * @returns 有序 run 列表。
 */
export function stepContextContentRuns(content: readonly unknown[]): StepContentRun[] {
  const runs: StepContentRun[] = []
  for (const block of content) {
    if (!isTextBlock(block)) {
      runs.push({ block })
      continue
    }
    const last = runs[runs.length - 1]
    if (last !== undefined && 'text' in last) {
      runs[runs.length - 1] = { text: last.text + block.text }
    } else {
      runs.push({ text: block.text })
    }
  }
  return runs
}

/** 只有未知块（供替代正文的 body 显示；rc.1 unknownBlocks 语义）。 */
export function stepContextUnknownBlocks(content: readonly unknown[]): unknown[] {
  return stepContextContentRuns(content).flatMap(run => ('block' in run ? [run.block] : []))
}

/**
 * 模型面文本截断（rc.1 boundedText 语义：超 20_000 字符时保留前段并在末尾追加
 * 截断行）。截断行文案经参数注入（组件传 locale 值，测试传桩）。
 * @param text - 完整文本。
 * @param truncate - 截断行生成器（收到原总长）。
 * @returns 展示文本。
 */
export function stepBoundedContextText(text: string, truncate: (total: number) => string): string {
  return text.length > STEP_CONTEXT_TEXT_LIMIT
    ? `${text.slice(0, STEP_CONTEXT_TEXT_LIMIT)}\n${truncate(text.length)}`
    : text
}

// ── command / manual-compaction / compaction data ─────────────────────────────
//
// rc.1（conversation-nodes/command.ts + conversation-nodes/compaction.ts +
// ui-conversation contract/records.ts）：
// - command（CommandNode）：{ kind:'command', seq, time, commandId, name: string|null,
//   args: string|null, outcome: { kind:'success'|'error', text?, sourceEventSeq? }|null }
//   ——outcome null = 命令仍在执行；窗口切走 run 事件时 name/args 可为 null；
// - compaction（CompactionSummaryNode）：{ kind:'compaction', seq, time, summary:
//   string|null, summaryEventSeq: number|null, shadowedItemCount: number|null,
//   shadowedTokenCount: number|null }（summary null = 不可展开）；
// - manual-compaction：{ command: CommandNode, compaction: CompactionSummaryNode|null }
//   ——/compact 手动压缩与其落地 checkpoint 的合并行。

/** command 结算 outcome 的本地断言。 */
export interface StepCommandOutcome {
  readonly kind: 'success' | 'error'
  readonly text?: string
  /** 更早的权威域事件 seq（client 展示可用；本地仅透出）。 */
  readonly sourceEventSeq?: number
}

/** command 行的本地 payload 断言（对齐 CommandNode）。 */
export interface StepChatCommandPayload {
  readonly kind?: 'command' | undefined
  readonly seq?: number
  readonly time?: number
  readonly commandId?: unknown
  /** 命令名；run 落在窗口外 → null（行渲染回退 command.title）。 */
  readonly name: string | null
  /** name 之后的原始参数（含分隔空白）；省略/窗口外 → null。 */
  readonly args: string | null
  /** 结算 outcome；null = 仍执行中（running 态）。 */
  readonly outcome: StepCommandOutcome | null
}

/** compaction 标记的本地 payload 断言（对齐 CompactionSummaryNode）。 */
export interface StepChatCompactionPayload {
  readonly kind?: 'compaction' | undefined
  readonly seq?: number
  readonly time?: number
  /** checkpoint 引用的压缩摘要文本；null = 摘要事件在窗口外（不可展开）。 */
  readonly summary: string | null
  readonly summaryEventSeq: number | null
  readonly shadowedItemCount: number | null
  readonly shadowedTokenCount: number | null
}

/** manual-compaction 行的本地 payload 断言（对齐 ManualCompactionChatData）。 */
export interface StepChatManualCompactionPayload {
  readonly command: StepChatCommandPayload
  readonly compaction: StepChatCompactionPayload | null
}

/** 读取 command 的 data（不抛）；缺失/形状不符按 rc.1 空态补齐。 */
export function stepChatCommandPayloadOf(data: unknown): StepChatCommandPayload {
  const record = stepIsRecord(data) ? data : null
  const name = typeof record?.name === 'string' ? record.name : null
  const args = typeof record?.args === 'string' ? record.args : null
  const rawOutcome = stepIsRecord(record?.outcome) ? record.outcome : null
  let outcome: StepCommandOutcome | null = null
  if (rawOutcome !== null
    && (rawOutcome.kind === 'success' || rawOutcome.kind === 'error')) {
    outcome = {
      kind: rawOutcome.kind,
      ...typeof rawOutcome.text === 'string' ? { text: rawOutcome.text } : {},
      ...(typeof rawOutcome.sourceEventSeq === 'number'
        ? { sourceEventSeq: rawOutcome.sourceEventSeq }
        : {}),
    }
  }
  return {
    ...(record !== null && finiteNumber(record.seq) ? { seq: record.seq } : {}),
    ...(record !== null && finiteNumber(record.time) ? { time: record.time } : {}),
    ...(record !== null && record.commandId !== undefined ? { commandId: record.commandId } : {}),
    name,
    args,
    outcome,
  }
}

/** 读取 compaction 标记的 data（不抛）；缺失/形状不符按 rc.1 空态（null 面）补齐。 */
export function stepChatCompactionPayloadOf(data: unknown): StepChatCompactionPayload {
  const record = stepIsRecord(data) ? data : null
  const nullableInt = (value: unknown): number | null =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
  return {
    ...(record !== null && finiteNumber(record.seq) ? { seq: record.seq } : {}),
    ...(record !== null && finiteNumber(record.time) ? { time: record.time } : {}),
    summary: typeof record?.summary === 'string' && record.summary !== '' ? record.summary : null,
    summaryEventSeq: nullableInt(record?.summaryEventSeq),
    shadowedItemCount: nullableInt(record?.shadowedItemCount),
    shadowedTokenCount: nullableInt(record?.shadowedTokenCount),
  }
}

/** 读取 manual-compaction 的 data（不抛）；compaction 缺/异物 → null（command 面照常）。 */
export function stepChatManualCompactionPayloadOf(data: unknown): StepChatManualCompactionPayload {
  const record = stepIsRecord(data) ? data : null
  const command = stepChatCommandPayloadOf(record?.command)
  const rawCompaction = stepIsRecord(record?.compaction) ? record.compaction : null
  return {
    command,
    compaction: rawCompaction === null ? null : stepChatCompactionPayloadOf(rawCompaction),
  }
}

// ── model-retry data ─────────────────────────────────────────────────────────
//
// rc.1（conversation-nodes/retry.ts + llm-retry/types.ts LlmRetryEventData）：
//   { attempts: ModelRetryNode[], current: ModelRetryNode }
// 每条 attempt = { kind:'model-retry', seq, time, retryState:'scheduled'|'started'|
// 'cancelled', retryId, turn, step, provider, mode:'normal'|'always',
// policyKey, retry, delayMs, failure:{ message, code? } }（mode:'always' 无
// maxRetries）。行渲染只用 current；attempts 供计数/扩展。

/** 一次重试 attempt 的本地断言（行渲染所需的叶子面）。 */
export interface StepModelRetryAttempt {
  /** 生命周期：scheduled（倒计时中）/ started / cancelled（所在边界先关）。 */
  readonly retryState: 'scheduled' | 'started' | 'cancelled'
  /** 重试策略：normal 有上限；always 无限（∞）。 */
  readonly mode: 'normal' | 'always'
  /** 本次是第几次重试（1 起）。 */
  readonly retry: number
  /** normal 模式的最大重试次数。 */
  readonly maxRetries?: number
  /** 计划延迟（毫秒；host 调度）。 */
  readonly delayMs: number
  /** 触发重试的失败。 */
  readonly failure: { readonly message: string; readonly code?: string }
  readonly seq?: number
  readonly time?: number
}

/** model-retry 行的本地 payload 断言（对齐 RetryChatData）。 */
export interface StepChatModelRetryPayload {
  readonly attempts: readonly StepModelRetryAttempt[]
  readonly current: StepModelRetryAttempt
}

/** 读取 model-retry 的 data（不抛）；attempts 空/异物 → rc.1 空态（buildViewNode 不产空链）。 */
export function stepChatModelRetryPayloadOf(data: unknown): StepChatModelRetryPayload {
  const record = stepIsRecord(data) ? data : null
  const rawAttempts = record === null || !Array.isArray(record.attempts) ? [] : record.attempts
  const attempts: StepModelRetryAttempt[] = []
  for (const raw of rawAttempts) {
    const attempt = stepModelRetryAttemptOf(raw)
    if (attempt !== undefined) attempts.push(attempt)
  }
  const current = record === null ? undefined : stepModelRetryAttemptOf(record.current)
  if (current !== undefined) {
    return { attempts, current }
  }
  // attempts 尾部即 current（buildViewNode 语义）；不可读 → 无渲染面空态。
  const last = attempts[attempts.length - 1]
  return last === undefined
    ? { attempts: [], current: { retryState: 'cancelled', mode: 'normal', retry: 0, delayMs: 0, failure: { message: '' } } }
    : { attempts, current: last }
}

/** 读取一条 attempt（不抛）；非记录/缺关键叶子 → undefined。 */
export function stepModelRetryAttemptOf(raw: unknown): StepModelRetryAttempt | undefined {
  if (!stepIsRecord(raw)) return undefined
  const retryState = raw.retryState
  if (retryState !== 'scheduled' && retryState !== 'started' && retryState !== 'cancelled') {
    return undefined
  }
  const mode = raw.mode === 'always' ? 'always' as const
    : raw.mode === 'normal' ? 'normal' as const : undefined
  if (mode === undefined) return undefined
  const retry = raw.retry
  if (!finiteNumber(retry) || !Number.isInteger(retry) || retry < 1) return undefined
  const delayMs = raw.delayMs
  if (!finiteNumber(delayMs) || delayMs < 0) return undefined
  const failure = stepIsRecord(raw.failure) ? raw.failure : null
  const message = typeof failure?.message === 'string' ? failure.message : ''
  return {
    retryState,
    mode,
    retry,
    ...(mode === 'normal' && finiteNumber(raw.maxRetries) && raw.maxRetries >= 0
      ? { maxRetries: raw.maxRetries }
      : {}),
    delayMs,
    failure: {
      message,
      ...typeof failure?.code === 'string' ? { code: failure.code } : {},
    },
    ...(finiteNumber(raw.seq) ? { seq: raw.seq } : {}),
    ...(finiteNumber(raw.time) ? { time: raw.time } : {}),
  }
}

// ── turn-error / turn-max-tokens / unknown data ───────────────────────────────
//
// rc.1（conversation-nodes/turn-error.ts / turn-max-tokens.ts / fallback.ts +
// records.ts）：TurnErrorNode { seq, time, turn, step, message, code? }；
// TurnMaxTokensNode { seq, time, turn, step }；UnknownSurfaceNode { seq, time,
// type, data }。

/** turn-error 行的本地 payload 断言（对齐 TurnErrorNode）。 */
export interface StepChatTurnErrorPayload {
  readonly seq?: number
  readonly time?: number
  readonly turn?: number
  readonly step?: number
  /** 已净化的 provider 消息；已知 code 拥有本地文案时可为空。 */
  readonly message: string
  readonly code?: string
}

/** turn-max-tokens 行的本地 payload 断言（对齐 TurnMaxTokensNode）。 */
export interface StepChatTurnMaxTokensPayload {
  readonly seq?: number
  readonly time?: number
  readonly turn?: number
  readonly step?: number
}

/** unknown 行的本地 payload 断言（对齐 UnknownSurfaceNode）。 */
export interface StepChatUnknownPayload {
  readonly seq?: number
  readonly time?: number
  readonly type: string
  readonly data: unknown
}

/** 读取 turn-error 的 data（不抛）。 */
export function stepChatTurnErrorPayloadOf(data: unknown): StepChatTurnErrorPayload {
  const record = stepIsRecord(data) ? data : null
  return {
    ...(record !== null && finiteNumber(record.seq) ? { seq: record.seq } : {}),
    ...(record !== null && finiteNumber(record.time) ? { time: record.time } : {}),
    ...(record !== null && finiteNumber(record.turn) ? { turn: record.turn } : {}),
    ...(record !== null && finiteNumber(record.step) ? { step: record.step } : {}),
    message: typeof record?.message === 'string' ? record.message : '',
    ...typeof record?.code === 'string' ? { code: record.code } : {},
  }
}

/** 读取 turn-max-tokens 的 data（不抛）。 */
export function stepChatTurnMaxTokensPayloadOf(data: unknown): StepChatTurnMaxTokensPayload {
  const record = stepIsRecord(data) ? data : null
  return {
    ...(record !== null && finiteNumber(record.seq) ? { seq: record.seq } : {}),
    ...(record !== null && finiteNumber(record.time) ? { time: record.time } : {}),
    ...(record !== null && finiteNumber(record.turn) ? { turn: record.turn } : {}),
    ...(record !== null && finiteNumber(record.step) ? { step: record.step } : {}),
  }
}

/** 读取 unknown 的 data（不抛）；type 缺失 → 空串。 */
export function stepChatUnknownPayloadOf(data: unknown): StepChatUnknownPayload {
  const record = stepIsRecord(data) ? data : null
  return {
    ...(record !== null && finiteNumber(record.seq) ? { seq: record.seq } : {}),
    ...(record !== null && finiteNumber(record.time) ? { time: record.time } : {}),
    type: typeof record?.type === 'string' ? record.type : '',
    data: record?.data,
  }
}

// ── tool-call data（root ToolCallBlock 递归树） ───────────────────────────────
//
// rc.1（conversation-nodes/tool.ts + records.ts）：ChatNode.data =
//   { root: ToolCallBlock }；ToolCallBlock = RunningToolCall | ToolResultNode：
// - RunningToolCall { callId, parentCallId?, name, argsRaw, turn, step, time,
//   subCalls }（运行中：无 kind 字段——settle 前是“进行中的卡片素材”）；
// - ToolResultNode { kind:'tool-result', seq, time, callId, parentCallId?, call:
//   {name,argsRaw}|null（窗口切走 run 时为 null）, callTime: number|null,
//   content, isError, error?{name,code}, meta?, subCalls }；
// 打断投影（projectBlock）把 running 根合成为 isError:true +
// error:{name:'Interrupted', code:'interrupted'} 的 tool-result。
// 本地面：content/meta/error/data 一律按 unknown 叶子透出（卡片模型各自窄化）。

/** 一条内容块的本地最小面（文本块探测用）。 */
export interface StepToolContentBlock {
  readonly type?: string
  readonly text?: string
}

/** 运行中的调用头（RunningToolCall 本地断言；无 kind——以 kind 在场区分结算）。 */
export interface StepToolCallHead {
  readonly callId: string
  readonly parentCallId?: string
  readonly name: string
  readonly argsRaw: string
  readonly turn?: number
  readonly step?: number
  readonly time?: number
  readonly subCalls: readonly StepToolCallBlock[]
}

/** 结算结果（ToolResultNode 本地断言）。 */
export interface StepToolResultNode {
  readonly kind: 'tool-result'
  readonly seq?: number
  readonly time?: number
  readonly callId: string
  readonly parentCallId?: string
  /** run 在窗口内回填的调用头；null = 窗口截断（行头回退 callId）。 */
  readonly call: { readonly name: string; readonly argsRaw: string } | null
  /** 配对 run 的时间（行时长用）；null = call 不在窗口。 */
  readonly callTime: number | null
  readonly content: readonly unknown[]
  readonly isError: boolean
  readonly error?: { readonly name: string; readonly code: string }
  readonly meta?: unknown
  readonly subCalls: readonly StepToolCallBlock[]
}

/** 本地 ToolCallBlock 联合（判别：kind 在场 = 结算；缺席 = 运行中）。 */
export type StepToolCallBlock = StepToolCallHead | StepToolResultNode

/** tool-call 行的本地 payload 断言（对齐 ToolChatData）。 */
export interface StepChatToolCallPayload {
  readonly root: StepToolCallBlock | undefined
}

/** 递归深度上限（rc.1 MAX_DEPTH=256 的本地防御；损坏/成环数据不爆栈）。 */
export const STEP_TOOL_DEPTH_LIMIT = 64

/** 读取一个 Tool block（不抛）；非记录/缺 callId → undefined（行跳过）。 */
export function stepToolBlockOf(raw: unknown, depth = 0): StepToolCallBlock | undefined {
  if (depth > STEP_TOOL_DEPTH_LIMIT || !stepIsRecord(raw)) return undefined
  const callId = raw.callId
  if (typeof callId !== 'string' || callId === '') return undefined
  const subCalls: StepToolCallBlock[] = []
  const rawSubCalls = Array.isArray(raw.subCalls) ? raw.subCalls : []
  for (const child of rawSubCalls) {
    const block = stepToolBlockOf(child, depth + 1)
    if (block !== undefined) subCalls.push(block)
  }
  const parentCallId = typeof raw.parentCallId === 'string' ? raw.parentCallId : undefined
  if (raw.kind === 'tool-result') {
    const rawCall = stepIsRecord(raw.call) ? raw.call : null
    return {
      kind: 'tool-result',
      ...(finiteNumber(raw.seq) ? { seq: raw.seq } : {}),
      ...(finiteNumber(raw.time) ? { time: raw.time } : {}),
      callId,
      ...(parentCallId === undefined ? {} : { parentCallId }),
      call: rawCall === null
          || typeof rawCall.name !== 'string'
          || typeof rawCall.argsRaw !== 'string'
        ? null
        : { name: rawCall.name, argsRaw: rawCall.argsRaw },
      callTime: typeof raw.callTime === 'number' ? raw.callTime : null,
      content: Array.isArray(raw.content) ? raw.content : [],
      isError: raw.isError === true,
      ...stepIsRecord(raw.error) && typeof raw.error.name === 'string'
        && typeof raw.error.code === 'string'
        ? { error: { name: raw.error.name, code: raw.error.code } }
        : {},
      ...raw.meta !== undefined ? { meta: raw.meta } : {},
      subCalls,
    }
  }
  return {
    callId,
    ...(parentCallId === undefined ? {} : { parentCallId }),
    name: typeof raw.name === 'string' ? raw.name : '',
    argsRaw: typeof raw.argsRaw === 'string' ? raw.argsRaw : '',
    ...(finiteNumber(raw.turn) ? { turn: raw.turn } : {}),
    ...(finiteNumber(raw.step) ? { step: raw.step } : {}),
    ...(finiteNumber(raw.time) ? { time: raw.time } : {}),
    subCalls,
  }
}

/** 读取 tool-call 的 data（不抛）；root 缺/异物 → undefined（行渲染空态）。 */
export function stepChatToolCallPayloadOf(data: unknown): StepChatToolCallPayload {
  const record = stepIsRecord(data) ? data : null
  const root = record === null ? undefined : stepToolBlockOf(record.root)
  return { root }
}

// ── turn-tail data（B3；rc.1 TurnTailChatData + FinalAssistantChatData 展示面）─
//
// rc.1（conversation-nodes/turn-tail.ts + contract/chat-nodes.ts）：
//   { turn, seq, time, closing: FinalAssistantChatData|null, branchUnavailable,
//     ttftMs?, tokensPerSecond?, tokenUsage?: TurnTokenUsage }
// closing = 本轮最后「带正文的已结算 assistant」（{ status, turn, step, blocks,
// time, usage?, finalNode? }）。finalNode 是 durable AssistantMessageNode（面板只
// 读 seq/messageId 叶子：分支锚点与 assistant-actions 归属）。

/** closing assistant 的 finalNode 叶子面（copy/branch/owner 用）。 */
export interface StepChatTurnTailFinalNode {
  /** 终结 assistant 消息的会话 seq（turn-tail 分支锚点）。 */
  readonly seq?: number | undefined
  /** 终结 assistant 消息的准入 messageId（assistant-actions 槽归属；面板不接槽）。 */
  readonly messageId?: unknown
  readonly time?: number | undefined
}

/** turn-tail closing assistant 的本地断言（对齐 FinalAssistantChatData 叶子面）。 */
export interface StepChatTurnTailClosing {
  readonly status?: 'running' | 'settled' | 'interrupted' | undefined
  readonly turn?: number | undefined
  readonly step?: number | undefined
  /** 模型可见正文块（unknown 叶子探测；文本拼接 = 复制文本）。 */
  readonly blocks: readonly StepAssistantBlock[]
  readonly time?: number | undefined
  readonly finalNode?: StepChatTurnTailFinalNode | undefined
}

/** 本轮 provider 用量断言（对齐 TurnTokenUsage 的计数叶子；B3 只读 total 面）。 */
export interface StepTurnTokenUsage {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cacheReadTokens?: number | undefined
  readonly cacheWriteTokens?: number | undefined
  readonly reasoningTokens?: number | undefined
  readonly routes?: readonly { readonly provider: string; readonly model: string }[] | undefined
}

/** turn-tail 行的本地 payload 断言（对齐 TurnTailChatData）。 */
export interface StepChatTurnTailPayload {
  readonly turn?: number | undefined
  readonly seq?: number | undefined
  /** turn/end 时间（Unix epoch ms；时钟/runMs 用）。 */
  readonly time?: number | undefined
  /** 本轮最后带正文的已结算 assistant；null = 无正文结算（rc.1 无动作行）。 */
  readonly closing: StepChatTurnTailClosing | null
  /** closing 非轮尾时分支不可用（引擎按 transcript 证据判定）。 */
  readonly branchUnavailable: boolean
  readonly ttftMs?: number | undefined
  readonly tokensPerSecond?: number | undefined
  readonly tokenUsage?: StepTurnTokenUsage | undefined
}

/** 读取一条 closing assistant（不抛）；非记录 → null（rc.1 无 closing 空态）。 */
function stepChatTurnTailClosingOf(raw: unknown): StepChatTurnTailClosing | null {
  if (!stepIsRecord(raw)) return null
  const rawBlocks = Array.isArray(raw.blocks) ? raw.blocks : []
  const blocks: StepAssistantBlock[] = []
  for (const block of rawBlocks) {
    const local = stepAssistantBlockOf(block)
    if (local !== undefined) blocks.push(local)
  }
  const rawFinal = stepIsRecord(raw.finalNode) ? raw.finalNode : undefined
  const status = raw.status === 'running' || raw.status === 'interrupted'
    ? raw.status
    : raw.status === 'settled' ? 'settled' : undefined
  return {
    ...(status === undefined ? {} : { status }),
    ...(finiteNumber(raw.turn) ? { turn: raw.turn } : {}),
    ...(finiteNumber(raw.step) ? { step: raw.step } : {}),
    blocks,
    ...(finiteNumber(raw.time) ? { time: raw.time } : {}),
    ...(rawFinal === undefined
      ? {}
      : {
        finalNode: {
          ...(finiteNumber(rawFinal.seq) ? { seq: rawFinal.seq } : {}),
          ...(rawFinal.messageId !== undefined ? { messageId: rawFinal.messageId } : {}),
          ...(finiteNumber(rawFinal.time) ? { time: rawFinal.time } : {}),
        },
      }),
  }
}

/** 读取 tokenUsage（不抛）；缺关键计数叶子 → undefined。 */
function stepTurnTokenUsageOf(raw: unknown): StepTurnTokenUsage | undefined {
  if (!stepIsRecord(raw)) return undefined
  const count = (value: unknown): number | undefined =>
    finiteNumber(value) && value >= 0 ? value : undefined
  const total = count(raw.totalTokens)
  const uncached = count(raw.uncachedInputTokens)
  const output = count(raw.outputTokens)
  if (total === undefined || uncached === undefined || output === undefined) return undefined
  let routes: StepTurnTokenUsage['routes']
  if (Array.isArray(raw.routes)) {
    const parsed: { provider: string; model: string }[] = []
    for (const route of raw.routes) {
      if (stepIsRecord(route) && typeof route.provider === 'string'
        && typeof route.model === 'string') {
        parsed.push({ provider: route.provider, model: route.model })
      }
    }
    routes = parsed.length === 0 ? undefined : parsed
  }
  return {
    uncachedInputTokens: uncached,
    outputTokens: output,
    totalTokens: total,
    ...(count(raw.cacheReadTokens) !== undefined ? { cacheReadTokens: count(raw.cacheReadTokens)! } : {}),
    ...(count(raw.cacheWriteTokens) !== undefined ? { cacheWriteTokens: count(raw.cacheWriteTokens)! } : {}),
    ...(count(raw.reasoningTokens) !== undefined ? { reasoningTokens: count(raw.reasoningTokens)! } : {}),
    ...(routes === undefined ? {} : { routes }),
  }
}

/**
 * 读取 turn-tail 的 data（不抛）；缺 closing/形状不符 → closing null（rc.1
 * 无槽注入时该行不渲染动作）。branchUnavailable 缺失时按 false（引擎正常恒带；
 * 面板另有 hasLaterChatNode 收窄，见 stepChatTailHasLaterNode）。
 */
export function stepChatTurnTailPayloadOf(data: unknown): StepChatTurnTailPayload {
  const record = stepIsRecord(data) ? data : null
  const tokenUsage = record === null || record.tokenUsage === undefined
    ? undefined
    : stepTurnTokenUsageOf(record.tokenUsage)
  return {
    ...(record !== null && finiteNumber(record.turn) ? { turn: record.turn } : {}),
    ...(record !== null && finiteNumber(record.seq) ? { seq: record.seq } : {}),
    ...(record !== null && finiteNumber(record.time) ? { time: record.time } : {}),
    closing: record === null ? null : stepChatTurnTailClosingOf(record.closing),
    branchUnavailable: record?.branchUnavailable === true,
    ...(record !== null && finiteNumber(record.ttftMs) ? { ttftMs: record.ttftMs } : {}),
    ...(record !== null && finiteNumber(record.tokensPerSecond)
      ? { tokensPerSecond: record.tokensPerSecond }
      : {}),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
  }
}

/**
 * assistantText（rc.1 chat/turn-assistant.ts）：拼接全部 text 块（reasoning/
 * image/tool 不算复制正文）。
 * @param blocks - 本地 assistant 块。
 * @returns 拼接文本（复制按钮载荷）。
 */
export function stepAssistantTextOf(blocks: readonly StepAssistantBlock[]): string {
  let text = ''
  for (const block of blocks) {
    if (block.kind === 'text') text += block.text
  }
  return text
}

/**
 * tail 是否属于当前最新 turn（rc.1 TurnTailNodeView isLatestTurn：
 * timeline.turnOrder.at(-1) === data.turn；决定 data-actions-reveal 常显/悬停）。
 * @param turnOrder - 原始 timeline.turnOrder（unknown 探测）。
 * @param turn - 行所在 turn 号。
 * @returns 该 turn 是否为当前最新 turn。
 */
export function stepChatTailIsLatestTurn(
  turnOrder: readonly unknown[] | undefined,
  turn: number | undefined,
): boolean {
  if (turn === undefined || turnOrder === undefined || turnOrder.length === 0) return false
  const last = turnOrder[turnOrder.length - 1]
  return typeof last === 'number' && last === turn
}

/**
 * turn-tail 行的 runMs（rc.1 用 turn location 的 start/end match 时间差；本地
 * 从 timeline turns map 读 turn/start 时间、以 tail 自身 time（turn/end）为终点）。
 * turn/start 落在窗口外（timeline 无该 turn/start）→ undefined（隐藏时长药丸）。
 * @param timeline - 原始 ChatSnapshot.timeline（unknown 探测）。
 * @param turn - 行所在 turn 号。
 * @param tailTime - tail 的 time（turn/end 时间）。
 * @returns 壁钟时长 ms；边界缺一 → undefined。
 */
export function stepChatTailRunMsOf(
  timeline: unknown,
  turn: number | undefined,
  tailTime: number | undefined,
): number | undefined {
  if (turn === undefined || tailTime === undefined) return undefined
  if (!stepIsRecord(timeline)) return undefined
  const rawTurns = timeline.turns
  // 引擎 timeline.turns 是 ReadonlyMap<number, TurnLocation>；结构探测 get。
  if (!stepIsRecord(rawTurns)) return undefined
  const getTurn = (rawTurns as unknown as { get?(key: number): unknown }).get
  if (typeof getTurn !== 'function') return undefined
  let entry: unknown
  try {
    entry = getTurn.call(rawTurns as never, turn)
  } catch {
    return undefined
  }
  const start = stepIsRecord(entry) && stepIsRecord(entry.start) ? entry.start : null
  const startTime = start !== null && finiteNumber(start.time) ? start.time : undefined
  if (startTime === undefined) return undefined
  return Math.max(0, tailTime - startTime)
}

/**
 * turn-tail 之后是否仍有本 turn 的行节点（rc.1 ChatNodeSeat 侧由
 * locations.getTurn(turn).at(-1) !== node.key 判定 → branchUnavailable 收窄；
 * 本地用可见行序扫描近似：同一 turn 且排在 tail 之后的可见行即「更晚节点」）。
 * @param rows - 当前可见行序（feed.nodesSnapshot() 顺序）。
 * @param key - turn-tail 节点 key。
 * @param turn - 行所在 turn 号。
 * @returns 该行是否为所在 turn 的最后一个可见节点。
 */
export function stepChatTailHasLaterChatNode(
  rows: readonly { readonly key: string; readonly location?: { readonly turn?: number } | undefined }[],
  key: string,
  turn: number | undefined,
): boolean {
  if (turn === undefined) return false
  const index = rows.findIndex(row => row.key === key)
  if (index < 0) return false
  return rows.some((row, i) => i > index && row.location?.turn === turn)
}

// ── 空 turn 判据（turn-tail 行抑制；用户真机「主代理会话里一堆空白行」） ────────
//
// 现场：主代理会话里出现一串**空 turn**。成因在引擎/DSH 侧且**无法在那边消除**——抑制
// step 结算通知走的是 `agent/pre-step` 返回 `{kind:'reject'}`，而 DSH 在 await pre-step
// **之前**就已 `append('turn/start')`（core/agent-loop/src/agent.ts:264 先写、:275 才
// await pre-step），被丢弃的消息于是留下 `turn/start` + `turn/end{blocked}` 的空壳 turn
// （`notifySettlement` 无条件投递、没有 quiet 开关）。20 个 turn 里 18 个是空壳时，UI 上
// 就是「一堆空白行 / 巨大空白」。
//
// 因此由**渲染侧**兜住：该 turn 没有任何内容行时，不渲染它的 turn-tail。

/**
 * 判定「内容行」时**不计入**的行 kind。
 *
 * - `turn-tail`：尾部动作行自身（判断依据不能是自己）；
 * - `turn-process`：进程披露头/成员折叠壳（空壳 turn 也可能带一条，本身不是内容）；
 * - `system-prompt`：会话级系统提示词行（会话头，不属于任何 turn 的内容）。
 *
 * 其余 kind（user / steering / assistant-step / tool-call / context / compaction /
 * command / model-retry / turn-error / turn-max-tokens / unknown…）都算内容行。
 */
const TAIL_CONTENT_EXCLUDED_KINDS: ReadonlySet<string> = new Set([
  'turn-tail',
  'turn-process',
  'system-prompt',
])

/** 「行」在判据里需要的最小面（`feed.nodesSnapshot()` 的元素结构面）。 */
interface StepChatTurnScopedRow {
  readonly kind: string
  readonly location?: { readonly turn?: number | undefined } | undefined
}

/**
 * 收集**有内容行**的 turn 号集合（`feed.nodesSnapshot()` 扫一遍）。
 *
 * 供 turn-tail 行判定「本 turn 是否为空壳」：不在集合里的 turn 一律不渲染尾部动作行。
 * 空 turn（只有 turn/start+turn/end 的 blocked 空壳）在行序里可能只留下一条 turn-tail
 * 或一条 turn-process，于是「有点击图标 + 时钟、没有任何正文」的行会被当成空白行。
 *
 * 缓存：同一份快照数组（引擎发布时身份稳定）只扫一次——每个 turn-tail 行都会问一次，
 * 不缓存就是 O(行数 × 节点数)。
 *
 * @param nodes - 当前行序（`StepChatViewFeed.nodesSnapshot()`）。
 * @returns 有内容行的 turn 号集合（无 location 的行不参与）。
 */
export function stepChatTurnsWithContentOf(
  nodes: readonly StepChatTurnScopedRow[],
): ReadonlySet<number> {
  const cached = turnsWithContentCache.get(nodes)
  if (cached !== undefined) return cached
  const turns = new Set<number>()
  for (const node of nodes) {
    const turn = node.location?.turn
    if (turn === undefined) continue
    if (TAIL_CONTENT_EXCLUDED_KINDS.has(node.kind)) continue
    turns.add(turn)
  }
  turnsWithContentCache.set(nodes, turns)
  return turns
}

/** 快照身份 → 「有内容 turn」集合（见 {@link stepChatTurnsWithContentOf}）。 */
const turnsWithContentCache = new WeakMap<object, ReadonlySet<number>>()

// ── turn-process data（B3；rc.1 TurnProcessChatData / TurnProcessSpec / 展示） ──
//
// rc.1（conversation-nodes/turn-process.ts + contract/chat-nodes.ts +
// contract/turn-process.ts + turn-process-presentation.ts）：
// - turn-process 控制节点的 data = TurnProcessChatData（= spec 同型叶子）：
//   { turn, controlAnchorSeq, processStartSeq, answerAnchorSeq: number|null,
//     answerStep: number|null, inlineReasoning, messageCount, toolCallCount,
//     subagentCount }；
// - ChatSnapshot.nodes.processSource(key) 产出 ChatTurnProcessPresentation：
//   { turn, spec: TurnProcessSpec, turnClosed, hasExternalProcess,
//     compactAnswer }（spec 与 control data 同型；presentation 只对带控制节点的
//     turn 存在——进程未开始的 turn 无 presentation → 不折叠）。

/** 本地 TurnProcessSpec / TurnProcessChatData 断言（两者同型）。 */
export interface StepTurnProcessSpec {
  readonly turn: number
  /** 稳定控制锚（含尚不合格的证据）；行隐藏窗口的起点依据。 */
  readonly controlAnchorSeq: number
  /** 本 turn 进程窗口起点 seq。 */
  readonly processStartSeq: number
  /** 最终答复 assistant 节点锚；null = 尚无答复（进程未闭合）。 */
  readonly answerAnchorSeq: number | null
  /** 最终答复的 step 号；null = 尚无答复。 */
  readonly answerStep: number | null
  /** 答复行内是否含推理块（折叠时按 data-turn-process-inline 隐藏）。 */
  readonly inlineReasoning: boolean
  readonly messageCount: number
  readonly toolCallCount: number
  readonly subagentCount: number
}

/** 本地 ChatTurnProcessPresentation 断言。 */
export interface StepChatTurnProcessPresentation {
  readonly turn: number
  readonly spec: StepTurnProcessSpec
  /** 该 turn 已闭合（location.turn.status === 'closed'）。 */
  readonly turnClosed: boolean
  /** 进程窗口内是否存在非答复成员行（决定披露头文案/可折叠性）。 */
  readonly hasExternalProcess: boolean
  /** 窗口内是否有更晚的人类行把答复挤出紧凑位（隐藏行折叠时仍渲染）。 */
  readonly compactAnswer: boolean
}

/** 读取 TurnProcessSpec 叶子（不抛）；关键锚/turn 不可读 → undefined。 */
export function stepTurnProcessSpecOf(raw: unknown): StepTurnProcessSpec | undefined {
  if (!stepIsRecord(raw)) return undefined
  const turn = raw.turn
  const controlAnchorSeq = raw.controlAnchorSeq
  const processStartSeq = raw.processStartSeq
  if (!finiteNumber(turn) || !finiteNumber(controlAnchorSeq) || !finiteNumber(processStartSeq)) {
    return undefined
  }
  const nullableAnchor = (value: unknown): number | null | undefined =>
    value === null ? null : finiteNumber(value) ? value : undefined
  const answerAnchorSeq = nullableAnchor(raw.answerAnchorSeq)
  const answerStep = nullableAnchor(raw.answerStep)
  if (answerAnchorSeq === undefined || answerStep === undefined) return undefined
  const count = (value: unknown): number =>
    finiteNumber(value) && value >= 0 ? Math.floor(value) : 0
  return {
    turn,
    controlAnchorSeq,
    processStartSeq,
    answerAnchorSeq,
    answerStep,
    inlineReasoning: raw.inlineReasoning === true,
    messageCount: count(raw.messageCount),
    toolCallCount: count(raw.toolCallCount),
    subagentCount: count(raw.subagentCount),
  }
}

/**
 * 读取 turn-process 展示（不抛）；spec 缺/形状不符 → undefined（无控制节点 =
 * 该 turn 无进程投影，行按不折叠渲染）。
 */
export function stepChatTurnProcessPresentationOf(
  raw: unknown,
): StepChatTurnProcessPresentation | undefined {
  if (!stepIsRecord(raw)) return undefined
  const spec = stepTurnProcessSpecOf(raw.spec)
  const turn = raw.turn
  if (spec === undefined || !finiteNumber(turn) || turn !== spec.turn) return undefined
  return {
    turn,
    spec,
    turnClosed: raw.turnClosed === true,
    hasExternalProcess: raw.hasExternalProcess === true,
    compactAnswer: raw.compactAnswer === true,
  }
}

/**
 * 不参与 turn 进程披露的 kind 集（rc.1 TURN_PROCESS_INDEPENDENT_KINDS 本地副本）：
 * 这些行永不因进程折叠隐藏/归属（含 turn-process 控制节点自身——其折叠状态由
 * 行壳单独计算）。
 */
export const STEP_TURN_PROCESS_INDEPENDENT_KINDS: ReadonlySet<string> = new Set([
  'system-prompt',
  'user',
  'steering',
  'turn-process',
  'turn-error',
  'turn-max-tokens',
  'turn-tail',
])

/** 该 kind 是否独立于 turn 进程披露（独立行不折叠）。 */
export function stepChatTurnProcessIndependentKind(kind: string): boolean {
  return STEP_TURN_PROCESS_INDEPENDENT_KINDS.has(kind)
}

/** 进程行壳判定输入（node 叶子 + 展示 + 行本地 open 态）。 */
export interface StepChatProcessSeatInput {
  /** 引擎节点 kind（注册表字符串）。 */
  readonly kind: string
  /** 引擎节点 anchorSeq（可小数）。 */
  readonly anchorSeq: number
  /** assistant-step 行的 data.step（其余 kind 不传）。 */
  readonly assistantStep?: number | undefined
  /** 该行所属 turn 的进程展示；无控制节点 → undefined（不折叠）。 */
  readonly presentation?: StepChatTurnProcessPresentation | undefined
  /** 行本地展开态（面板内 useState/轮次级共享；rc.1 的 store 持久化被裁剪）。 */
  readonly open: boolean
  /**
   * 是否按 rc.1 compact transcript 语义折叠。面板恒 true（B3 折衷：无
   * transcript 模式开关）；单测可显式传 false 验证非 compact 不折叠。
   */
  readonly compactTranscript?: boolean
  /**
   * 历史窗口不完整（= 会话快照 hasMore）。**必传**（批 A：由调用方显式传入，
   * 取消旧 `?? false` 默认——官方 rc.1 ChatView 的 ChatNodeSeat 直接吃
   * `historyIncomplete={hasMore}`，语义是「窗口不全时**禁用**进程折叠」，防
   * 误隐窗口外仍在的成员行；面板一律传真实 hasMore，未知时按 true 更保守）。
   */
  readonly historyIncomplete: boolean
}

/** 进程行壳判定结果（ChatNodeSeat 各布尔量的纯函数移植）。 */
export interface StepChatProcessSeatState {
  /** processWindowReady：该行处于可折叠进程上下文（含 compact + turn 闭合）。 */
  readonly windowReady: boolean
  /** 进程成员行（进程窗口 [processStartSeq, answerAnchorSeq) 内的非独立行）。 */
  readonly member: boolean
  /** 最终答复 assistant 行（kind assistant-step 且 step === answerStep）。 */
  readonly answer: boolean
  /** 披露归属行（turn-process 控制节点或最终答复行）。 */
  readonly ownsDisclosure: boolean
  /** 该行是否参与披露折叠（成员行 / 归属行带外部进程或内联推理）。 */
  readonly foldable: boolean
  /** turn-process 控制节点无披露可折叠（行进过程中）→ 行隐藏。 */
  readonly controllerInactive: boolean
  /** 折叠的紧凑答复位（答复行 data-turn-process-answer 数据属性用）。 */
  readonly compactAnswer: boolean
  /** 该行当前应隐藏（controllerInactive 或 折叠的成员行）。 */
  readonly hidden: boolean
}

/**
 * ChatNodeSeat 过程折叠判定纯函数移植（rc.1 chat/ChatNodeSeat.tsx 逐布尔量）：
 * - actions.setTurnProcessOpen（store 持久化）→ 面板行本地 `open` 输入替代；
 * - processSpec/storedTurnProcessEntry 跨会话持久 → 移除（spec 取自 presentation，
 *   open 由输入给）。
 * 其余（member/answer/ownsDisclosure/foldable/compactAnswer/hidden 的合取/边界）
 * 逐字保留 rc.1 语义。
 * @param input - 行节点叶子 + 展示 + 本地 open。
 * @returns 行壳隐藏/折叠判定。
 */
export function stepChatProcessSeatOf(input: StepChatProcessSeatInput): StepChatProcessSeatState {
  const { kind, anchorSeq, assistantStep, presentation, open, historyIncomplete } = input
  const compactTranscript = input.compactTranscript ?? true
  const spec = presentation?.spec
  // ChatNodeSeat.processWindowReady（紧凑 + 已闭合 + 有答复边界 + 投影同轮）。
  const windowReady = spec !== undefined
    && presentation !== undefined
    && compactTranscript
    && spec.answerAnchorSeq !== null
    && presentation.turn === spec.turn
    && presentation.turnClosed
    && !historyIncomplete
  // ChatNodeSeat.processMember：独立 kind 永不隐藏；边界 [processStartSeq, answerAnchorSeq)。
  const member = windowReady
    && !STEP_TURN_PROCESS_INDEPENDENT_KINDS.has(kind)
    && anchorSeq >= spec!.processStartSeq
    && anchorSeq < spec!.answerAnchorSeq!
  // ChatNodeSeat.processAnswer：仅 assistant-step 且 step 等于答复 step。
  const answer = windowReady
    && kind === 'assistant-step'
    && assistantStep === spec!.answerStep
  const ownsDisclosure = kind === 'turn-process' || answer
  // ChatNodeSeat.foldable：成员行，或归属行持有外部进程/内联推理才可折叠。
  const foldable = windowReady && (member || (ownsDisclosure
    && (presentation!.hasExternalProcess || spec!.inlineReasoning)))
  const controllerInactive = kind === 'turn-process' && !foldable
  const compactAnswer = answer && foldable && presentation!.compactAnswer && !open
  const hidden = controllerInactive || (foldable && member && !open)
  return {
    windowReady,
    member,
    answer,
    ownsDisclosure,
    foldable,
    controllerInactive,
    compactAnswer,
    hidden,
  }
}

/**
 * 答复行内联推理折叠判定（rc.1 AssistantNodeView.reasoningHidden）：
 * 进程折叠中、该 assistant 行即最终答复、spec.inlineReasoning 且未展开 → 推理
 * 块整体隐藏（data-turn-process-inline；浏览器 find 经 reveal 展开）。
 * @param presentation - 行所属 turn 的进程展示（无 → false）。
 * @param assistantStep - assistant 行 data.step。
 * @param open - 该轮进程展开态。
 * @param answerSeat - 行壳 answer 判定（kind/step 已命中时）。
 * @returns 推理块是否隐藏。
 */
export function stepChatReasoningHiddenOf(
  presentation: StepChatTurnProcessPresentation | undefined,
  assistantStep: number | undefined,
  open: boolean,
  answerSeat: boolean,
): boolean {
  if (presentation === undefined || assistantStep === undefined || open || !answerSeat) {
    return false
  }
  const spec = presentation.spec
  return spec.answerStep === assistantStep && spec.inlineReasoning
}

// ── 行路由（B2b/B3 kind → 视图族；spec 可测纯函数） ──────────────────────────

/**
 * 已实现视图的 kind 族（switch 分发目标；B3 接手 turn-tail/turn-process 后
 * 全部注册 kind 均有真实视图；未知 kind 仍走 B1 占位摘要行）。
 */
export type StepChatRowViewKind = 'user' | 'steering' | 'assistant-step' | 'context'
  | 'system-prompt' | 'command' | 'manual-compaction' | 'compaction' | 'model-retry'
  | 'turn-error' | 'turn-max-tokens' | 'unknown' | 'tool-call' | 'turn-tail'
  | 'turn-process'

/**
 * 把引擎 kind 映射到已实现视图族；未实现 kind → undefined（StepChatViewRow
 * 走 stepChatNodePreview 占位行）。
 * @param kind - ChatNode.kind（注册表 kind 字符串）。
 * @returns 视图族；未知/未实现 → undefined。
 */
export function stepChatRowViewKindOf(kind: string): StepChatRowViewKind | undefined {
  switch (kind) {
    case 'user':
    case 'steering':
    case 'assistant-step':
    case 'context':
    case 'system-prompt':
    case 'command':
    case 'manual-compaction':
    case 'compaction':
    case 'model-retry':
    case 'turn-error':
    case 'turn-max-tokens':
    case 'unknown':
    case 'tool-call':
    case 'turn-tail':
    case 'turn-process':
      return kind
    default:
      return undefined
  }
}
