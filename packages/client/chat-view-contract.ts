/**
 * chat-view-contract：StepChatPanel 渲染对齐 DSH 0.1.2-rc.1 ChatView 的**本地契约层**
 * （B1 批：数据/容器底座）。
 *
 * 背景（只读参考 D:\project-code\llm\deepseek-harness，勿改动 DSH 源码）：
 * - rc.1 的 `uiConversation.binding(binding).target('chat')` 产出 **ChatSnapshot**
 *   （ui-chat `contract/snapshot.ts`）：`order`（渲染顺序，发布即换引用）＋
 *   `nodes`（ChatNodeStore：`get/source/processSource/values`，**同一 builder 实例跨
 *   发布保持身份稳定**，内容更新经 per-key source 增量通知）＋ `locations` +
 *   `navigation` + `timeline` + `legacy`（与旧顶层字段同构的兼容切片）。
 * - ChatView 的订阅粒度（`chat/ChatView.tsx` + `chat/ChatNodeSeat.tsx` + 装配
 *   `conversation/assembly.ts`）：target 外层 subscribe 在每次装配 flush 时通知
 *   （覆盖全部节点/顺序变化，流式按 rAF 合并）；消息行另经
 *   `ChatNodeStore.source(key)` **per-key** 订阅，只在自己的节点身份变化时重渲
 *   （`ChatNodeList`/`ChatNodeSeat` 均 memo，行内容更新不整列重渲）。
 * - `ChatConversationViewNode`（ui-chat `contract/chat-nodes.ts`）：稳定 key +
 *   kind（注册表 kind，经各 conversation-nodes 模块 augment 并入）+ data +
 *   anchorSeq（可小数）+ location（会话层级）+ visibility。
 *
 * 本文件：**去掉所有 slot/模块扩充声明**，只抄所需纯类型/常量/守卫/纯函数——
 * 全部为结构断言 + 本地类型，不 import ui-chat/ui-conversation 的运行时与类型；
 * 运行时拿到的引擎对象一律按 `unknown` 叶子读取（与
 * step-chat-source.ts 的「结构探测 + cast」约定一致）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/chat-view-contract
 */

// ── 可订阅源 / ChatNodeStore 的本地结构面 ──────────────────────────────────────

/** 可订阅源（uSES 两侧）：`ChatNodeSource`/`ChatNodeProcessSource` 的结构同构。 */
export interface StepChatObservableSourceLike<Value = unknown> {
  /** @returns 该 key 当前值（节点缺席/未就绪 → undefined）。 */
  readonly getSnapshot: () => Value | undefined
  /** @param listener - 该 key 值变化通知。@returns 退订函数。 */
  readonly subscribe: (listener: () => void) => () => void
}

/** ChatSnapshot.nodes（ChatNodeStore）的本地结构面（只消费叶子）。 */
export interface StepChatNodeStoreLike {
  /** @param key - 稳定节点 key。@returns 当前引擎节点（live 引用，仅叶子读取）。 */
  get(key: string): unknown
  /** @param key - 稳定节点 key。@returns 该 key 的身份稳定可订阅源。 */
  source(key: string): StepChatObservableSourceLike<unknown>
  /** @param key - 稳定节点 key。@returns Turn-process 展示源（B2+ 用）。 */
  processSource?(key: string): StepChatObservableSourceLike<unknown>
}

/** ChatSnapshot 的本地结构面（只消费 order/nodes/timeline/navigation 叶子）。 */
export interface StepChatSnapshotLike {
  /** 可见节点的渲染顺序（每次发布替换数组引用）。 */
  readonly order: readonly string[]
  /** 稳定 live per-key 读取器（同一 builder 实例跨发布身份稳定）。 */
  readonly nodes: StepChatNodeStoreLike
  /** Turn 导航 rail（B4 轮次轴用；目标总携带，结构上仍判可选）。 */
  readonly navigation?: { items(): readonly unknown[] }
  /** turn 边界时间线（runningTurnStart 锚点等）。 */
  readonly timeline?: unknown
}

// ── 视图节点（本地最小结构面） ─────────────────────────────────────────────────

/** location 的本地叶子视图（不携带引擎事件引用）。 */
export interface StepChatViewLocation {
  readonly kind: string
  /** 所属 turn 号（`location.kind` 为 turn/step 时）。 */
  readonly turn?: number
  /** 所属 step 号（`location.kind` 为 step 时）。 */
  readonly step?: number
}

/**
 * 一条 view-node（ChatConversationViewNode 的本地结构面；B1 起逐 kind 视觉由 B2
 * 交付，此处行渲染只需 kind/key/data/anchorSeq/location/turn 叶子）。
 */
export interface StepChatViewNode {
  /** 稳定 Conversation Context key（React key / 锚点 / 轮次轴索引）。 */
  readonly key: string
  /** 注册表渲染 kind（如 assistant-step / tool-call / turn-tail…）。 */
  readonly kind: string
  /** 该 kind 的引擎负载（live 引用；逐 kind 视觉在 B2 才消费其最小面）。 */
  readonly data: unknown
  /** 排序锚点 seq（打断等场景可为小数）。 */
  readonly anchorSeq: number
  /** location 叶子（turn/step 号；无法判定时 undefined）。 */
  readonly location: StepChatViewLocation | undefined
}

/** view-node 快照读（feed.read() 的 uSES 值；order 身份只在发布后变化）。 */
export interface StepChatViewRead {
  /** 当前快照满足 ChatSnapshot 结构（target 未就绪/形状不符 → false）。 */
  readonly ok: boolean
  /** 当前渲染顺序；未就绪时为空数组（引用稳定）。 */
  readonly order: readonly string[]
}

/**
 * view-node 数据源（StepChatBody 订阅面）：
 * - `subscribe`/`read`：整列级（target 发布即通知，覆盖所有 order/节点更新）；
 * - `node`/`nodesSnapshot`：按 key 读本地 view-node；
 * - `nodeSource`/`processSource`（经 nodeSourceOf）：ChatNodeStore 的 per-key
 *   订阅面（B2 行级渲染照抄 ChatNodeSeat 订阅粒度用）；
 * - `timeline`/`navigationItems`：B4 轮次轴数据面。
 */
export interface StepChatViewFeed {
  /** @param listener - 每次 target 发布（装配 flush）通知。@returns 退订函数。 */
  subscribe(listener: () => void): () => void
  /** uSES 快照读：快照未变时返回同一引用（身份稳定）。 */
  read(): StepChatViewRead
  /** @param key - 稳定节点 key。@returns 当前本地 view-node（身份随底层节点稳定）。 */
  node(key: string): StepChatViewNode | undefined
  /**
   * @param key - 稳定节点 key。
   * @returns 该 key 的身份稳定可订阅源（行级渲染用）；快照未就绪时 undefined。
   */
  nodeSource(key: string): StepChatObservableSourceLike<StepChatViewNode> | undefined
  /** @returns 按当前 order 的快照对象序列（渲染骨架用）。 */
  nodesSnapshot(): readonly StepChatViewNode[]
  /** @param key - 稳定节点 key。@returns 其 Turn-process 展示（B2+；未就绪 → undefined）。 */
  processOf(key: string): unknown
  /** @returns 当前 ChatSnapshot.timeline（原始引用；未就绪 → undefined）。 */
  timeline(): unknown
  /** @returns 当前 navigation.items()（B4 轮次轴；未就绪 → 空数组）。 */
  navigationItems(): readonly unknown[]
}

// ── 常量与守卫 ─────────────────────────────────────────────────────────────────

/** 空 order 常量（快照未就绪时 read().order 的稳定引用；对齐 EMPTY_CHAT_SNAPSHOT）。 */
export const STEP_CHAT_EMPTY_ORDER: readonly string[] = []

/**
 * 结构守卫：值是否满足 ChatSnapshot 的最小面（order 数组 + nodes.get/source）。
 * 引擎的快照是 live 对象（order 发布即换引用、nodes 稳定），守卫只判形状。
 */
export function isStepChatSnapshotLike(value: unknown): value is StepChatSnapshotLike {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (!Array.isArray(candidate.order)) return false
  const nodes = candidate.nodes
  if (typeof nodes !== 'object' || nodes === null) return false
  const store = nodes as Record<string, unknown>
  return typeof store.get === 'function' && typeof store.source === 'function'
}

/** 对象记录守卫（供各叶子读取共用；不抛错）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 有限数字守卫（anchorSeq 可小数；坐标必须是安全有限值）。 */
function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 引擎 location → 本地叶子视图（只读 kind/turn/step 号，不拷贝引擎对象）。
 * @param rawLocation - ChatNode.location（未知形状，结构探测）。
 * @returns 本地叶子视图；无法判定时 undefined。
 */
export function stepChatLocationViewOf(rawLocation: unknown): StepChatViewLocation | undefined {
  if (!isRecord(rawLocation)) return undefined
  const kind = rawLocation.kind
  if (typeof kind !== 'string' || kind === '') return undefined
  // readonly 结构面：只经条件展开构造，不做事后赋值。
  const turn = (kind === 'turn' || kind === 'step') && isRecord(rawLocation.turn)
    && finiteNumber(rawLocation.turn.turn)
    ? rawLocation.turn.turn
    : undefined
  const step = kind === 'step' && isRecord(rawLocation.step)
    && finiteNumber(rawLocation.step.step)
    ? rawLocation.step.step
    : undefined
  return {
    kind,
    ...(turn === undefined ? {} : { turn }),
    ...(step === undefined ? {} : { step }),
  } as StepChatViewLocation
}

/**
 * 引擎 ChatNode（ChatConversationViewNode）→ 本地 view-node。
 * 只读叶子并保持 live 引用（data/location 原样透出，不做拷贝）。
 * @param raw - 引擎节点（未知形状；结构探测）。
 * @returns 本地结构面；形状不符（缺 key/kind/anchorSeq）→ undefined。
 */
export function stepChatViewNodeOf(raw: unknown): StepChatViewNode | undefined {
  if (!isRecord(raw)) return undefined
  const key = raw.key
  const kind = raw.kind
  if (typeof key !== 'string' || key === '' || typeof kind !== 'string' || kind === '') {
    return undefined
  }
  if (!finiteNumber(raw.anchorSeq)) return undefined
  return {
    key,
    kind,
    data: raw.data,
    anchorSeq: raw.anchorSeq,
    location: stepChatLocationViewOf(raw.location),
  }
}

/**
 * 引擎节点 → turn 号（data-chat-turn 推断面；ChatNodeSeat 的 `data-chat-turn` 同源）。
 * @param raw - 引擎 ChatNode。
 * @returns location 派生 turn 号；缺席/无法判定 → undefined。
 */
export function stepChatTurnOf(raw: unknown): number | undefined {
  if (!isRecord(raw)) return undefined
  return stepChatLocationViewOf(raw.location)?.turn
}

// ── 占位行预览（B1 通用调试/占位行的纯文本摘要；B2 交付逐 kind 视觉后移除） ────

/** 从 assistant/消息 content 等未知块数组收集纯文本（text/reasoning 块）。 */
function collectText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  let text = ''
  for (const block of blocks) {
    if (!isRecord(block)) continue
    const kind = typeof block.kind === 'string' ? block.kind : (block.type as unknown)
    if (kind !== 'text' && kind !== 'reasoning') continue
    const body = block.text
    if (typeof body === 'string') text += text === '' ? body : ` ${body}`
  }
  return text
}

/** 预览上限（单行省略；与导航 rail 的 preview 预算同思路）。 */
const STEP_CHAT_PREVIEW_LIMIT = 120

/**
 * 占位行摘要：按已知 kind 的最小结构面提取一行可读文本（B1 骨架行用；
 * 无法提取 → undefined，行只渲染 kind 徽标）。逐 kind 视觉由 B2 接手后本函数退役。
 */
export function stepChatNodePreview(view: StepChatViewNode): string | undefined {
  const { kind, data } = view
  const normalized = collectText(Array.isArray(data) ? data : undefined)
  switch (kind) {
    case 'assistant-step': {
      const blocks = isRecord(data) ? (Array.isArray(data.blocks) ? data.blocks : []) : []
      const text = collectText(blocks)
      const toolCount = blocks.filter(
        block => isRecord(block) && block.kind === 'tool-call',
      ).length
      const parts: string[] = []
      if (text !== '') parts.push(text)
      if (toolCount > 0) parts.push(`[tool-call ×${toolCount}]`)
      return parts.length === 0 ? undefined : clip(parts.join(' '))
    }
    case 'user':
    case 'steering':
    case 'context': {
      const content = isRecord(data) ? data.content : undefined
      const text = collectText(content)
      return text === '' ? undefined : clip(text)
    }
    case 'system-prompt': {
      const text = isRecord(data) && typeof data.text === 'string' ? data.text : ''
      return text === '' ? undefined : clip(text)
    }
    case 'tool-call': {
      const root = isRecord(data) ? data.root : undefined
      if (!isRecord(root)) return undefined
      const name = typeof root.name === 'string' ? root.name : undefined
      const callId = typeof root.callId === 'string' ? root.callId : undefined
      const settled = isRecord(root) && root.kind === 'tool-result'
      return `${settled ? '✓' : '…'} ${name ?? callId ?? '(tool)'}`
    }
    case 'command': {
      const name = isRecord(data) && typeof data.name === 'string' ? data.name : undefined
      const settled = isRecord(data) && isRecord(data.outcome)
      return name === undefined ? undefined : `${settled ? '✓' : '…'} /${name}`
    }
    case 'manual-compaction': {
      const command = isRecord(data) ? data.command : undefined
      const name = isRecord(command) && typeof command.name === 'string' ? command.name : undefined
      return name === undefined ? undefined : `/compact (${name})`
    }
    case 'compaction':
      return '(compaction)'
    case 'model-retry':
      return '(model retry)'
    case 'turn-error': {
      const message = isRecord(data) && typeof data.message === 'string' ? data.message : undefined
      return message === undefined || message === '' ? '(turn error)' : clip(message)
    }
    case 'turn-max-tokens':
      return '(max tokens)'
    case 'turn-tail':
      return isRecord(data) && typeof data.turn === 'number'
        ? `(turn ${data.turn} closed)`
        : '(turn tail)'
    case 'turn-process':
      return isRecord(data) && typeof data.turn === 'number'
        ? `(turn ${data.turn} process)`
        : '(turn process)'
    case 'unknown': {
      const type = isRecord(data) && typeof data.type === 'string' ? data.type : undefined
      return type === undefined ? '(unknown)' : `(unknown: ${type})`
    }
    default: {
      const text = normalized
      return text === '' ? undefined : clip(text)
    }
  }
}

/** 单行截断（统一在 preview 末尾补省略号）。 */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > STEP_CHAT_PREVIEW_LIMIT
    ? `${flat.slice(0, STEP_CHAT_PREVIEW_LIMIT - 1)}…`
    : flat
}
