/**
 * step-mention-source.ts（批 B1）：`@step` 提及源 —— 把工作流实例的 Step 执行段
 * 变成 composer 里可提及的引用芯片（chip）。
 *
 * 与 DSH 的关系（只读参考 deepseek-harness；不 import 其类型）：
 * - 服务面：`ctx.get('inputTriggers')`（ui-input-trigger 的 root registry，默认已装载）
 *   → `registerSource(source)`；重复的 (trigger,name) 注册会 throw（本模块把重复注册
 *   记 warn 并保留上一份，不让插件崩）。
 * - source 契约（结构面，见 deepseek-harness ui-input-trigger/src/types.ts）：
 *   `candidates(session, {query, signal, …})` / `onPick(pick)` /
 *   `lexicon(session)` / `subscribeLexicon(session, listener)` /
 *   `codec: { clipboardText(ref), serialize(ref, signal) }`。
 * - 参考实现：`ui-reference/src/client/index.ts`（最完整的 @ source 模板）、
 *   `extensions/ui-cordis/src/client/index.ts`（最小形态）。
 *
 * 语义 = **引用注入**（不是投递）：候选来自 RunView 既有 `getInstanceState` 快照里的
 * `executedSteps`（经 step-chat-registry 登记，零新 RPC）；选中后插入一枚 chip，提交
 * 时 codec 把 chip 展开成给模型的上下文块（见 stepMentionBlockOf）。
 *
 * 作用域守卫（必备）：source 注册在 client 根、对**所有**会话可见，故 `candidates` /
 * `lexicon` 先经 `stepChatInstanceOf(session.sessionId)` 判定该会话是否为某个 sandore
 * 实例的 step 子会话；不是就返回 `[]` / undefined（空组不渲染 → 主会话与其它插件的
 * 子代理 `@` 菜单不被污染）。
 *
 * codec 容错（必备）：ui-input-trigger 的提交路径上 `serialize` 抛错会**阻断整次发送**
 * （facade.sinkSerialized 的拒绝路径）。本模块的 serialize 内部全量 try/catch，任何
 * 异常都降级为纯文本引用（`@<label>`），绝不向上抛。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-mention-source
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import type { SandoreKey } from './locales.ts'
import {
  stepChatEntriesOf,
  stepChatEntryOf,
  stepMentionBlockOf,
  stepMentionCandidatesOf,
  stepMentionRefOf,
  stepMentionRefParse,
  subscribeStepChatRegistry,
  type StepMentionEntry,
} from './step-chat-registry.ts'

/** 注册进 ui-input-trigger 的 source 名（trigger '@' + name 唯一）。 */
export const STEP_MENTION_SOURCE = 'step'

/** 候选分组标题键（菜单分组标题；与 ui-reference 的 `section.*` 同族）。 */
export const STEP_MENTION_SECTION_KEY = 'step.mention.section'

/** 序列化失败兜底文案键（仅在无法回查条目时使用；`{name}` = 引用展示名）。 */
export const STEP_MENTION_FAILED_KEY = 'step.mention.serializeFailed'

/** Step 状态 → 候选描述里的状态文案键（未知名回退为原状态字面量）。 */
const STEP_MENTION_STATUS_KEYS: Record<string, SandoreKey> = {
  blocked: 'run.step.status.blocked',
  ready: 'run.step.status.ready',
  interacting: 'run.step.status.interacting',
  running: 'run.step.status.running',
  completed: 'run.step.status.completed',
  failed: 'run.step.status.failed',
  paused: 'run.step.status.paused',
}

// ── 结构面（cast 形状；不静态 import ui-input-trigger，见文件头） ─────────────

/** 会话投影（source 回调第一参；ui-input-trigger 的 ClientSessionContext）。 */
export interface StepMentionSessionLike {
  readonly sessionId: string
}

/** 候选请求（只读 `query`；`signal` 用于提前放弃）。 */
export interface StepMentionCandidateRequestLike {
  readonly query: string
  readonly signal?: AbortSignal | undefined
}

/** 一条候选（ui-input-trigger 的 InputTriggerCandidate 形状）。 */
export interface StepMentionCandidateLike {
  readonly name: string
  readonly description?: string
  readonly icon?: 'file' | 'folder' | 'session'
  readonly value?: string
  readonly section?: string
}

/** pick 回调入参（只读 session/candidate）。 */
export interface StepMentionPickLike {
  readonly candidate: StepMentionCandidateLike
  readonly session: StepMentionSessionLike
}

/** `onPick` 的返回（insert 形态即本模块唯一产出）。 */
export interface StepMentionInsertOutcome {
  readonly insert: {
    readonly source: string
    readonly ref: string
    readonly label: string
    readonly clipboardText: string
  }
}

/** source 契约（结构面；`registerSource` 只按形状消费）。 */
export interface StepMentionSourceLike {
  readonly trigger: '@' | '/'
  readonly name: string
  readonly order?: number
  readonly showGroupTitle?: boolean
  candidates(
    session: StepMentionSessionLike,
    request: StepMentionCandidateRequestLike,
  ): Promise<readonly StepMentionCandidateLike[]>
  onPick(pick: StepMentionPickLike): StepMentionInsertOutcome | undefined
  lexicon?(session: StepMentionSessionLike): readonly string[] | undefined
  subscribeLexicon?(session: StepMentionSessionLike, listener: () => void): () => void
  readonly codec?: {
    clipboardText(ref: string): string
    serialize(ref: string, signal: AbortSignal): Promise<string>
  }
}

/** 注册面（`ctx.get('inputTriggers')` 的最小结构；缺失时插件降级为无 @step）。 */
export interface StepMentionRegistryLike {
  registerSource(source: StepMentionSourceLike): () => void
}

// ── 纯函数（可单测；不触碰 ctx） ────────────────────────────────────────────

/**
 * 候选描述文案：`<状态> · <产物数>`（运行中/已完成/失败都能一眼看出它值不值得引用）。
 * @param t - sandore 字典。
 * @param entry - 登记条目。
 * @returns 一行描述。
 */
export function stepMentionDescriptionOf(t: TranslateNS<'sandore'>, entry: StepMentionEntry): string {
  const statusKey = STEP_MENTION_STATUS_KEYS[entry.status]
  const status = statusKey === undefined ? entry.status : t(statusKey)
  const count = entry.artifacts.length
  const artifacts = count === 0
    ? t('step.mention.noArtifacts')
    : t('step.mention.artifacts', { count })
  return `${status} · ${artifacts}`
}

/**
 * 一条候选（`candidates` 的逐条映射；纯函数，便于单测形状）。
 * @param t - sandore 字典。
 * @param entry - 登记条目。
 * @returns 候选（`value` 编入 instanceId+stepId，供 onPick 组 ref）。
 */
export function stepMentionCandidateOf(
  t: TranslateNS<'sandore'>,
  entry: StepMentionEntry,
): StepMentionCandidateLike {
  return {
    name: entry.label,
    description: stepMentionDescriptionOf(t, entry),
    // 复用 ui-input-trigger 既有的三个图标族；step 引用的是「一个子代理会话的片段」，
    // 故取 session 字形（不新造图标，菜单视觉与 @session 同族）。
    icon: 'session',
    section: t(STEP_MENTION_SECTION_KEY),
    value: stepMentionRefOf(entry.instanceId, entry.stepId),
  }
}

/**
 * 该会话可见的候选条目（**作用域守卫**：非 sandore step 会话 → 空数组）。
 * @param sessionId - 会话 id。
 * @param query - `@` 之后的实时查询。
 * @returns 过滤后的条目。
 */
export function stepMentionEntriesFor(sessionId: string, query: string): readonly StepMentionEntry[] {
  return stepMentionCandidatesOf(stepChatEntriesOf(sessionId), query)
}

/**
 * 芯片 ref → 模型上下文块（codec.serialize 的纯函数主体；**绝不抛**）。
 *
 * 失败降级阶梯：ref 不可解析 → 原样返回 ref；条目回查不到（step 卡卸载/实例被删）
 * → 本地化的「暂不可用」说明（让模型知道这里本该有上下文，而不是收到一个孤零零的
 * `@名字`）；展开过程抛错 → 同一说明。降级只损失上下文块，**绝不阻断整次发送**
 * （ui-input-trigger 的失败策略是「serialize 抛错 ⇒ 整次提交失败」，那对一个可选
 * 引用太重）。
 * @param ref - 芯片 ref。
 * @param t - sandore 字典（兜底文案）。
 * @returns 给模型看的文本（恒为非空字符串）。
 */
export function stepMentionSerializeRef(ref: string, t: TranslateNS<'sandore'>): string {
  try {
    const parsed = stepMentionRefParse(ref)
    if (parsed === undefined) return ref === '' ? ' ' : ref
    const entry = stepChatEntryOf(parsed.instanceId, parsed.stepId)
    if (entry === undefined) return t('step.mention.serializeFailed', { name: parsed.stepId })
    return stepMentionBlockOf(entry)
  } catch (error) {
    console.error('ui-sandore: @step reference serialization failed (downgraded to text)', error)
    return ref === '' ? ' ' : ref
  }
}

/** `clipboardText(ref)`：复制/持久化投影（纯文本 `@<label>`；回查不到时退回 ref）。 */
export function stepMentionClipboardTextOf(ref: string): string {
  try {
    const parsed = stepMentionRefParse(ref)
    if (parsed === undefined) return ref
    const entry = stepChatEntryOf(parsed.instanceId, parsed.stepId)
    return entry === undefined ? `@${parsed.stepId}` : `@${entry.label}`
  } catch {
    return ref
  }
}

/**
 * 构造 `@step` source（不注册；单测可直接驱动各回调）。
 * @param t - sandore 字典（菜单分组标题/候选描述/兜底文案）。
 * @returns source 结构体。
 */
export function createStepMentionSource(t: TranslateNS<'sandore'>): StepMentionSourceLike {
  return {
    trigger: '@',
    name: STEP_MENTION_SOURCE,
    // 排在 ui-reference（默认 order 0）之后：`@` 菜单里文件/会话在前，步骤在后。
    order: 10,
    showGroupTitle: true,
    async candidates(session, request) {
      // 作用域守卫：非 sandore step 会话 → 空候选（空组不渲染，见文件头）。
      const entries = stepMentionEntriesFor(session.sessionId, request.query)
      if (request.signal?.aborted === true) return []
      return entries.map(entry => stepMentionCandidateOf(t, entry))
    },
    onPick(pick) {
      const parsed = stepMentionRefParse(pick.candidate.value ?? '')
      if (parsed === undefined) return undefined
      const entry = stepChatEntryOf(parsed.instanceId, parsed.stepId)
      // 条目在本会话的登记表里（作用域守卫的第二个关口：跨会话 value 伪造不生效）。
      if (entry === undefined || entry.sessionId !== pick.session.sessionId) return undefined
      return {
        insert: {
          source: STEP_MENTION_SOURCE,
          ref: stepMentionRefOf(parsed.instanceId, parsed.stepId),
          label: entry.label,
          clipboardText: `@${entry.label}`,
        },
      }
    },
    lexicon(session) {
      // 纯文本染色兜底：同步返回可用名集合（不 fetch）。裸名 + 唯一 label 都给——
      // 重试段的裸名同名，只给裸名会让 `@构建` 命中多段。
      const entries = stepChatEntriesOf(session.sessionId)
      if (entries.length === 0) return []
      const names = new Set<string>()
      for (const entry of entries) {
        names.add(entry.name)
        names.add(entry.label)
      }
      return [...names]
    },
    subscribeLexicon(_session, listener) {
      // 登记表（RunView 轮询结果）变化 → 让 controller 重拉候选与 lexicon。
      return subscribeStepChatRegistry(listener)
    },
    codec: {
      clipboardText: ref => stepMentionClipboardTextOf(ref),
      serialize: ref => Promise.resolve(stepMentionSerializeRef(ref, t)),
    },
  }
}

/**
 * 注册 `@step` source（`ctx.effect` 风格：返回 disposer）。
 *
 * 容错：`inputTriggers` 缺失（宿主未装载 ui-input-trigger）→ no-op；重复注册
 * （HMR 双挂）→ warn 并保留既有注册，不抛。
 * @param registry - `ctx.get('inputTriggers')` 的结构读结果。
 * @param t - sandore 字典。
 * @returns disposer。
 */
export function registerStepMentionSource(
  registry: StepMentionRegistryLike | undefined,
  t: TranslateNS<'sandore'>,
): () => void {
  if (registry === undefined || typeof registry.registerSource !== 'function') return () => {}
  try {
    return registry.registerSource(createStepMentionSource(t))
  } catch (error) {
    console.warn('ui-sandore: @step mention source already registered', error)
    return () => {}
  }
}
