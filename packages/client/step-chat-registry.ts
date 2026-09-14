/**
 * step-chat-registry.ts（批 B1）：step 内嵌会话的「实例 → Step 执行段」模块级登记表。
 *
 * 为什么需要：`@step` 提及源（step-mention-source.ts）注册在 client 根、对**所有**
 * 会话可见，但候选数据在运行视图里（RunView 既有 `getInstanceState` 轮询结果）。
 * 时间线组件树与 cordis ctx 无交集，且本批**不新增 RPC/typert 产物**——于是沿用
 * StepChatPanel 的 install/dispose 模块级单例风格，把 RunView 已经拿到的 state 经
 * props 下传到面板，由面板在挂载时登记、卸载时清理。
 *
 * 数据流向（零新 RPC）：
 *   RunView（既有 state.executedSteps）
 *     → UnifiedTimeline（steps props）
 *       → StepChatPanel → StepChatBody（登记本实例）
 *         → @step source 候选 / codec 序列化（本模块读取）
 *
 * 作用域守卫（必备）：登记表以 step 子会话 id 为索引反查，`stepChatInstanceOf(childId)`
 * 对**不属于任何 sandore 实例**的会话返回 undefined —— 主会话与其它插件的子代理会话
 * 因此拿不到候选（空组不渲染），主会话的 `@` 菜单不被污染。
 *
 * 纯函数（候选过滤/排序/唯一 label）与登记表分离：前者可在 node 环境直接单测。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-chat-registry
 */

/** 序列化进上下文的输出文本上限（字符；超出截断加省略号——避免一次提及吃掉整个上下文窗）。 */
export const STEP_MENTION_OUTPUT_LIMIT = 4000

/** 一个实例登记的一整个 Step 快照（RunView 的 getInstanceState 结果片段）。 */
export interface StepChatRegistryInstance {
  /** 工作流实例 id（宿主会话 id）。 */
  readonly instanceId: string
  /** 本实例的 Step 执行段（`lastActiveSegmentsOf` 去重后的段；见 RunView 接线）。 */
  readonly steps: readonly StepMentionEntry[]
}

/**
 * 单个 Step 执行段的提及条目（@step 候选 + 序列化所需的展示/上下文数据）。
 *
 * 全部字段在登记时从既有 state 快照读取（step.sessionMeta.childId / step.output /
 * step.artifacts），面板侧不再回查引擎。
 */
export interface StepMentionEntry {
  /** Step 定义 id（同 stepId 多执行段共享）。 */
  readonly stepId: string
  /** 所属工作流实例 id（芯片 ref 与序列化回查都要它——codec 只拿到 ref 字符串）。 */
  readonly instanceId: string
  /** 执行段所属的 step 子会话 id（真实子代理会话；缺失＝合成会话，不可提及）。 */
  readonly sessionId: string
  /** Step 名称（原样；label 由 buildStepMentionEntries 去重）。 */
  readonly name: string
  /** 候选展示名（重名或 attemptIndex>0 时补 `#n`；见 stepMentionLabelOf）。 */
  readonly label: string
  /** 执行段状态（引擎 7 态；仅用于文案，不做语义分支）。 */
  readonly status: string
  /** 执行段序号（0-based；缺省 0）。 */
  readonly attemptIndex: number
  /** 该段输出文本（ContentBlock 的 text 块拼接；无文本块 → undefined）。 */
  readonly outputText?: string | undefined
  /** 该段产物文件路径（step.artifacts；运行中即可有值）。 */
  readonly artifacts: readonly string[]
}

/** 纯逻辑所需的最小 Step 执行段面（结构读取；不依赖 workflow 的 zod 类型）。 */
export interface StepMentionStepLike {
  readonly id?: string | undefined
  readonly stepId?: string | undefined
  readonly name?: string | undefined
  readonly status?: string | undefined
  readonly attemptIndex?: number | undefined
  readonly output?: readonly { readonly type?: string | undefined; readonly text?: unknown }[] | undefined
  readonly artifacts?: readonly string[] | undefined
  readonly sessionMeta?: {
    readonly childId?: string | undefined
    /** 合成会话（shell 等不建真实子代理）→ 无 childId，不可提及。 */
    readonly synthetic?: boolean | undefined
  } | undefined
}

// ── 登记表（模块级单例；install/dispose 配对）──────────────────────────────

/** 实例 id → 登记内容。同一实例多次登记（多个 step 卡挂着）后写覆盖。 */
const instances = new Map<string, StepChatRegistryInstance>()
/** step 子会话 id → 拥有它的实例 id（作用域守卫的索引；登记/注销时整体重算）。 */
const owners = new Map<string, string>()
/** 登记表变更订阅者（@step source 的 lexicon 失效通知）。 */
const listeners = new Set<() => void>()

/** 重算「子会话 → 实例」索引（登记/注销各一次；规模＝实例×段数，无需增量维护）。 */
function reindex(): void {
  owners.clear()
  for (const instance of instances.values()) {
    for (const step of instance.steps) {
      if (!owners.has(step.sessionId)) owners.set(step.sessionId, instance.instanceId)
    }
  }
}

/** 通知订阅者（登记内容或实例集合变化）。 */
function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      // 订阅者异常不得打断登记/注销本身（与 ui-input-trigger 的 source 回调容错同族）。
      console.error('ui-sandore: step registry listener failed', error)
    }
  }
}

/**
 * 登记/刷新一个实例的 Step 快照（面板挂载时调用；同实例重复调用＝更新）。
 * @param instanceId - 工作流实例 id。
 * @param steps - 该实例的 Step 执行段（`buildStepMentionEntries` 产物）。
 * @returns disposer：注销本实例（面板卸载时调用；已被后续登记覆盖时不误删）。
 */
export function installStepChatInstance(
  instanceId: string,
  steps: readonly StepMentionEntry[],
): () => void {
  const record: StepChatRegistryInstance = { instanceId, steps: [...steps] }
  instances.set(instanceId, record)
  reindex()
  notify()
  return () => {
    // 期间已被新登记覆盖（同实例面板重挂）时不得删掉新数据。
    if (instances.get(instanceId) !== record) return
    instances.delete(instanceId)
    reindex()
    notify()
  }
}

/**
 * 反查一个 step 子会话所属的实例 id（**作用域守卫**：非 sandore 会话 → undefined）。
 * @param childSessionId - 会话 id（`session.sessionId` 或 `item.childId`）。
 * @returns 拥有该 step 会话的实例 id，或 undefined（主会话/其它插件子代理）。
 */
export function stepChatInstanceOf(childSessionId: string): string | undefined {
  return owners.get(childSessionId)
}

/**
 * 读取一个 step 子会话所在实例的 Step 条目（@step source 的候选源）。
 * @param childSessionId - 会话 id。
 * @returns 该实例的条目（按登记顺序）；不属于任何实例 → 空数组。
 */
export function stepChatEntriesOf(childSessionId: string): readonly StepMentionEntry[] {
  const instanceId = owners.get(childSessionId)
  if (instanceId === undefined) return []
  return instances.get(instanceId)?.steps ?? []
}

/**
 * 按实例 id 读取一个 Step 条目（codec 序列化用：ref 里带 instanceId，无需会话上下文）。
 * @param instanceId - 实例 id。
 * @param stepId - Step 定义 id。
 * @returns 条目，或 undefined（实例已注销/step 已消失）。
 */
export function stepChatEntryOf(instanceId: string, stepId: string): StepMentionEntry | undefined {
  const steps = instances.get(instanceId)?.steps
  if (steps === undefined) return undefined
  return steps.find(step => step.stepId === stepId)
}

/**
 * 订阅登记表变更（@step source 的 `subscribeLexicon` 通道：候选/lexicon 变化时让
 * ui-input-trigger 的 per-session controller 重拉）。
 * @param listener - 变更回调。
 * @returns 取消订阅。
 */
export function subscribeStepChatRegistry(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * 清空登记表（单测隔离用；插件卸载由各面板的 disposer 配对清理，生产路径不需要）。
 */
export function clearStepChatRegistry(): void {
  instances.clear()
  owners.clear()
  notify()
}

// ── 纯函数：从既有 state 片段构造条目 ──────────────────────────────────────

/** 结构读 `text`（ContentBlock 是 loose object：`{type}` + 任意附加字段）。 */
function textOf(block: { readonly text?: unknown }): string | undefined {
  const text = block.text
  return typeof text === 'string' && text !== '' ? text : undefined
}

/**
 * 展示等价的 Step 段判定（浅比较 @step 需要的全部字段）。
 *
 * 用途：RunView 每轮轮询都会重建 `lastActiveSegmentsOf(...)` 的数组与段对象，而这
 * 份片段要沿 UnifiedTimeline 逐行下传（作为 `AgentMsg` 的 props 与登记内容）。若不
 * 归一，行级 `React.memo` 会因为 props 引用每轮都变而失效（时间线 memo 治理被击穿）。
 * @param a - 上一份段。
 * @param b - 本份段。
 * @returns 展示等价（含 output 文本与 artifacts 列表内容）。
 */
export function stepMentionStepEqual(a: StepMentionStepLike, b: StepMentionStepLike): boolean {
  if (a === b) return true
  if (stepIdOfStep(a) !== stepIdOfStep(b)) return false
  if (a.name !== b.name || a.status !== b.status) return false
  if ((a.attemptIndex ?? 0) !== (b.attemptIndex ?? 0)) return false
  if (a.sessionMeta?.childId !== b.sessionMeta?.childId) return false
  if ((a.sessionMeta?.synthetic === true) !== (b.sessionMeta?.synthetic === true)) return false
  if (stepMentionOutputTextOf(a.output) !== stepMentionOutputTextOf(b.output)) return false
  const left = a.artifacts ?? []
  const right = b.artifacts ?? []
  if (left.length !== right.length) return false
  return left.every((path, index) => path === right[index])
}

/**
 * 引用稳定化：本份段与上一份展示等价 → 复用旧引用（跨轮询保持 props 身份稳定）。
 * @param previous - 上一轮归一结果。
 * @param next - 本轮原始片段（来自 state）。
 * @returns 可安全下传的片段（等价时即 `previous` 的引用）。
 */
export function stepChatReuseSegments<T extends StepMentionStepLike>(
  previous: readonly T[],
  next: readonly T[],
): readonly T[] {
  if (previous === next) return previous
  if (previous.length !== next.length) return next
  for (let index = 0; index < next.length; index += 1) {
    const before = previous[index]
    const after = next[index]
    if (before === undefined || after === undefined) return next
    if (!stepMentionStepEqual(before, after)) return next
  }
  return previous
}

/**
 * 单个执行段的输出文本（text 块按序拼接；非 text 块与空块跳过）。
 * @param output - `step.output`（ContentBlock 数组）。
 * @returns 拼接文本，或 undefined（无文本内容）。
 */
export function stepMentionOutputTextOf(
  output: readonly { readonly type?: string | undefined; readonly text?: unknown }[] | undefined,
): string | undefined {
  if (output === undefined || output.length === 0) return undefined
  const parts: string[] = []
  for (const block of output) {
    if (block.type !== undefined && block.type !== 'text') continue
    const text = textOf(block)
    if (text !== undefined) parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** Step 段 id（定义 id 优先，回退实例内段 id；与 run-view-model.stepIdOf 同义）。 */
function stepIdOfStep(step: StepMentionStepLike): string {
  return step.stepId ?? step.id ?? ''
}

/**
 * 候选/芯片展示名：`name` 同名冲突或 `attemptIndex>0` 时补 `#<n>`（n = attemptIndex+1）。
 *
 * 纯函数、逐条输入（不做全局去重）：调用方按登记顺序对「已用 label」判重后传入
 * `taken`。首个出现的段保留裸名（与 DiscussionInput 的 @Step 目标按钮一致），
 * 重名/重试段补后缀以便菜单里可区分。
 * @param name - Step 名称。
 * @param attemptIndex - 执行段序号（0-based）。
 * @param taken - 已占用的 label（同名时强制补后缀）。
 * @returns 唯一展示名。
 */
export function stepMentionLabelOf(
  name: string,
  attemptIndex: number,
  taken: ReadonlySet<string>,
): string {
  const base = name === '' ? 'step' : name
  if (attemptIndex <= 0 && !taken.has(base)) return base
  let suffix = attemptIndex > 0 ? attemptIndex + 1 : 1
  let candidate = `${base}#${String(suffix)}`
  while (taken.has(candidate)) {
    suffix += 1
    candidate = `${base}#${String(suffix)}`
  }
  return candidate
}

/**
 * 从 RunView 的既有 state 片段构造 @step 条目表（**零新 RPC**：只读 executedSteps）。
 *
 * 合成会话（`sessionMeta.synthetic === true` 或无真实 `childId`）不产出条目——它们
 * 没有可打开的 DSH 会话，提及后无法序列化上下文。
 * @param steps - `state.executedSteps`（或 `lastActiveSegmentsOf` 的结果）。
 * @returns 条目表（登记顺序 = 输入顺序）。
 */
export function buildStepMentionEntries(
  steps: readonly StepMentionStepLike[] | undefined,
  instanceId = '',
): StepMentionEntry[] {
  if (steps === undefined) return []
  const taken = new Set<string>()
  const entries: StepMentionEntry[] = []
  for (const step of steps) {
    const sessionId = step.sessionMeta?.childId
    if (step.sessionMeta?.synthetic === true) continue
    if (sessionId === undefined || sessionId === '') continue
    const stepId = stepIdOfStep(step)
    if (stepId === '') continue
    const name = step.name ?? stepId
    const attemptIndex = step.attemptIndex ?? 0
    const label = stepMentionLabelOf(name, attemptIndex, taken)
    taken.add(label)
    const outputText = stepMentionOutputTextOf(step.output)
    entries.push({
      stepId,
      instanceId,
      sessionId,
      name,
      label,
      status: step.status ?? 'unknown',
      attemptIndex,
      ...(outputText === undefined ? {} : { outputText }),
      artifacts: [...(step.artifacts ?? [])],
    })
  }
  return entries
}

/**
 * 按 query 过滤 + 排序 + 生成唯一 label 的候选表（@step source 的 `candidates` 主体）。
 *
 * 排序 = 登记顺序（＝ RunView 时间线顺序，即执行先后）；过滤 = label 或 name 的
 * 大小写不敏感包含（`@` 后的即时查询）。空 query 返回全部。
 * @param entries - 实例的条目表。
 * @param query - `@` 之后的实时查询文本。
 * @returns 过滤后的条目（保持顺序）。
 */
export function stepMentionCandidatesOf(
  entries: readonly StepMentionEntry[],
  query: string,
): readonly StepMentionEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return entries
  return entries.filter(entry =>
    entry.label.toLowerCase().includes(needle) || entry.name.toLowerCase().includes(needle))
}

/**
 * 芯片 ref 的编解码（`onPick` 写入、codec 读回）。
 *
 * ref 必须自洽：`codec.serialize(ref, signal)` 只拿到 ref（没有会话/实例上下文），
 * 故把 instanceId 一并编进 ref（JSON），序列化时据此回查登记表。
 */
export interface StepMentionRef {
  readonly instanceId: string
  readonly stepId: string
}

/** 编码芯片 ref（`onPick` 的 insert.ref）。 */
export function stepMentionRefOf(instanceId: string, stepId: string): string {
  const ref: StepMentionRef = { instanceId, stepId }
  return JSON.stringify(ref)
}

/**
 * 解析芯片 ref（结构读；形状不符 → undefined，调用方降级为纯文本引用）。
 * @param ref - 芯片 ref 字符串。
 * @returns 解析结果，或 undefined。
 */
export function stepMentionRefParse(ref: string): StepMentionRef | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(ref)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as { readonly instanceId?: unknown; readonly stepId?: unknown }
  if (typeof record.instanceId !== 'string' || record.instanceId === '') return undefined
  if (typeof record.stepId !== 'string' || record.stepId === '') return undefined
  return { instanceId: record.instanceId, stepId: record.stepId }
}

/**
 * 芯片 ref → 模型上下文块（DSH 参考 `ui-reference` 的 `<skill>name</skill>` 族：把
 * 引用展开成模型可读的结构化文本）。
 *
 * 形状（B1 约定；B2 的 retry/revert 复用同一展开）：
 * ```
 * <step name="构建" step-id="step-b" status="completed" attempt="1">
 * output:
 * <该段输出文本，截断到 STEP_MENTION_OUTPUT_LIMIT 字符>
 * artifacts:
 * - <path>
 * </step>
 * ```
 * @param entry - 登记条目（含 outputText/artifacts）。
 * @returns 上下文块文本。
 */
export function stepMentionBlockOf(entry: StepMentionEntry): string {
  const head = `<step name="${entry.label}" step-id="${entry.stepId}" status="${entry.status}" attempt="${String(entry.attemptIndex + 1)}">`
  const lines: string[] = [head]
  const output = entry.outputText === undefined
    ? ''
    : entry.outputText.length > STEP_MENTION_OUTPUT_LIMIT
      ? `${entry.outputText.slice(0, STEP_MENTION_OUTPUT_LIMIT)}…`
      : entry.outputText
  if (output !== '') {
    lines.push('output:', output)
  }
  if (entry.artifacts.length > 0) {
    lines.push('artifacts:', ...entry.artifacts.map(path => `- ${path}`))
  }
  lines.push('</step>')
  return lines.join('\n')
}
