/**
 * UnifiedTimeline：执行详情对话流（按 execution-detail-prototype.html 原型）。
 *
 * multica Issue 评论流 × DSH 多 agent 对话流：用户输入 = 右侧气泡；每个
 * executedStep = 一条 agent 消息（左对齐，头像 + 可点击标题 → openSession 打开
 * DSH 现成子代理会话页 + 相对时间 + 状态图标）。正文按状态呈现：
 * **需求 3（本次变更）**：真实子代理段（prompt/agent/skill/mcp）在
 * running/interacting、**completed**、failed、paused 都内嵌同一个会话面板
 * （StepChatPanel，单点挂载位），**完成后不再用收尾总结替换会话区**——收尾总结
 * （引擎 `finalizeMeta.assessResult.compressedOutput`）仍照旧作为传给后续 step 的
 * 输出内容留在数据/引擎层，只是不再以「Agent 输出」摘要显示在卡片下方；
 * 过程按官方 turn-process 折叠语义折成「已完成」标签 + 可展开。
 * 无真实会话（shell 等合成会话）保持既有行为：completed 显示命令输出 outputText，
 * running 显示消息框/占位，failed/paused 显示最近 N 条消息兜底（且**永不**挂面板
 * ——f2 的能力边界断言）。
 *
 * 批 B2（面板内重试）：failed 的真实子代理段的重试行就在面板底部动作位；挂载点
 * 一律带 `key={item.childId ?? item.stepId}`——fork/revert 重试会换
 * sessionMeta.childId，key 换值即重挂面板，绝不停在已 dispose 的旧会话上
 * （RunView 既有的轮询随后把新段数据送达）。
 *
 * 窗口化渲染（对齐 DSH ChatView「尾部一窗 + 加载更早」分页）：默认只渲染时间线
 * 尾部 TIMELINE_WINDOW 条，顶部「加载更早」按钮逐次扩窗，扩窗 prepend 后按
 * scrollHeight 锚点补偿 scrollTop（不跳动）；行组件 memo 化 + buildTimeline 引用
 * 稳定缓存，轮询期未变化的行跳过重渲染。
 *
 * ## 主代理卡片（呈现层统一 · 本批；需求 3，**真机验收后修正形态**）
 *
 * 用户从运行页底部输入框（= 主代理输入框）发出消息、**或主代理自己产出助手输出**后，
 * 把**主代理的会话视图**作为**一张独立卡片**渲染在步骤列表里——「看起来就是另一个 agent step」。
 * 真机修正（三轮，最新为「默认折叠 + 固定最下面」）：**它不是嵌在某张 step 卡片里的一段内容**，
 * 而是 `[data-sandore-timeline]` 下的**兄弟节点**（与 step 卡片同级、有自己完整的卡壳/卡头）：
 * - **位置**：**始终在步骤列表最后一张**（真机反馈：「主代理只有一个，一直放到最下面的 step」）；
 * - **折叠**：默认折叠（只显示卡头），主代理每来一条新的助手消息就自动展开；点卡头可手动切换；
 * - **出现条件**：`mainChat.shown`（RunView 的 `useMainAgentCard`：主代理会话里**有助手消息**）；
 *   为假时**不产出任何 DOM**——连空壳/占位/标题都没有；
 * - 内容复用 StepChatPanel 的 `variant="main"`（同源数据面/行组件，见 StepChatPanel.tsx），
 *   **不是**另造渲染器；卡片带 `data-tl-main-agent`（与 step 卡片的 `data-tl-step` 并列但不同），
 *   内层面板带 `data-main-agent-chat` 而**不**带 `data-step-chat`（f2 的能力边界断言只数 step 面板）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/UnifiedTimeline
 */
import { IconChevronDownOutline14, IconSparkle16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'

import { markdownLabels } from './chat-utils/markdown-labels.ts'
import type { SandoreKey } from './locales.ts'
import { TIMELINE_MAX_STEPS, TIMELINE_STEPS_PAGE, visibleTimelineWindow } from './timeline-window.ts'
import {
  relativeTimeOf, type ChatLine, type RelativeTime, type StepStatus, type TimelineItem, type TimelineStepItem,
} from './run-view-model.ts'
import { StepChatPanel, stepChatSessionsOf } from './StepChatPanel.tsx'
import type { StepMentionStepLike } from './step-chat-registry.ts'
// 批 B2：面板内重试——RunView 的调用面（retryStep/listRevertBoundaries 薄封装）
// 逐行补上「本段定位片段」后作为 StepChatRetryPort 下传给 StepChatPanel。
import type { StepChatRetryPort, StepRetryActions } from './step-view/step-retry.ts'
import css from './timeline.module.css'

/** 相对时间「现在」的刷新间隔（ms）：分钟粒度文案（N 分钟前）60s 刷新足够。 */
const NOW_REFRESH_MS = 60000

/**
 * 主代理卡片的**自动折叠延时**（ms）——**用户规格**（原话）：
 * 「消息不再更新的话，**三秒后**折叠这个主代理 step。然后如果工作流运行完成/失败，
 *  则默认展开主代理 step 下面的消息」。提成常量便于日后调整（单测用假定时器驱动它）。
 */
const MAIN_AGENT_AUTO_COLLAPSE_MS = 3000

/** sessions 服务未安装时的空订阅（useSyncExternalStore subscribe 侧）。 */
const NOOP_SUBSCRIBE = (): (() => void) => () => undefined

/**
 * 主代理卡片的稳定 key：卡片会随「正在执行的 step」推进而在列表里移动，用稳定 key
 * 让 React **搬移**同一个节点（不卸载重挂 → 面板不重开会话/不丢历史）。
 */
const MAIN_AGENT_CARD_KEY = 'sandore-main-agent-card'

/** Step 执行状态 → 本地化标签键（7 态）。 */
const STEP_STATUS_KEYS: Record<StepStatus, SandoreKey> = {
  blocked: 'run.step.status.blocked',
  ready: 'run.step.status.ready',
  interacting: 'run.step.status.interacting',
  running: 'run.step.status.running',
  completed: 'run.step.status.completed',
  failed: 'run.step.status.failed',
  paused: 'run.step.status.paused',
}

/** 收尾阶段（finalizeMeta.currentPhase）→ 本地化标签键。
 * Phase A 显示「检测中」；completed 终态显示「已完成」（区别于「已收尾」= Phase B 完成态）。 */
function finalizePhaseKey(phase: string | undefined): SandoreKey | undefined {
  switch (phase) {
    case 'ask-detect':
      return 'run.step.finalize.phase.detecting'
    case 'finalizing':
      return 'run.step.finalize.phase.finalizing'
    case 'gating':
      return 'run.step.finalize.phase.gating'
    case 'routing':
      return 'run.step.finalize.phase.routing'
    case 'completed':
      return 'run.step.finalize.phase.completed'
    default:
      return undefined
  }
}

/** 状态 → 展示色类（原型 .st 的 4 色）。 */
function statusClass(status: StepStatus): string {
  switch (status) {
    case 'completed':
      return css.stSuccess ?? ''
    case 'failed':
      return css.stDestructive ?? ''
    case 'paused':
      return css.stWarning ?? ''
    case 'running':
    case 'interacting':
    default:
      return css.stInfo ?? ''
  }
}

/** 状态 SVG 图标（照原型 4 种：成功对勾 / 运行转圈 / 失败叉 / 暂停叹号）。 */
function StatusIcon({ status }: { readonly status: StepStatus }) {
  switch (status) {
    case 'completed':
      return (
        <svg viewBox="0 0 14 14" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.4" fill="currentColor" />
          <path d="M4.6 7.2l1.6 1.6 3.2-3.4" stroke="#fff" strokeWidth="1.3" fill="none" strokeLinecap="round" />
        </svg>
      )
    case 'failed':
      return (
        <svg viewBox="0 0 14 14" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M4.6 4.6l4.8 4.8M9.4 4.6l-4.8 4.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )
    case 'paused':
      return (
        <svg viewBox="0 0 14 14" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M7 4v3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="7" cy="10" r="0.7" fill="currentColor" />
        </svg>
      )
    case 'running':
    case 'interacting':
    default:
      return (
        <svg viewBox="0 0 14 14" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M7 1.5a5.5 5.5 0 1 1-5.5 5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )
  }
}

/** 相对时间 → 字典文案。 */
function formatTime(t: TranslateNS<'sandore'>, rel: RelativeTime | undefined): string {
  if (rel === undefined) return ''
  switch (rel.kind) {
    case 'justNow':
      return t('run.time.justNow')
    case 'minutes':
      return t('run.time.minutesAgo', { count: rel.count })
    case 'hours':
      return t('run.time.hoursAgo', { count: rel.count })
    case 'days':
      return t('run.time.daysAgo', { count: rel.count })
    case 'date':
      return rel.text
  }
}

/** 单行消息（agent 内嵌框 / 失败·暂停列表共用）。 */
function ChatLineRow({ line }: { readonly line: ChatLine }) {
  return (
    <div className={`${css.chatLine} ${line.kind === 'tool' ? css.chatLineTool : css.chatLineAssistant}`}>
      <span className={css.chatWho}>{line.who}</span>
      <span className={css.chatTxt}>{line.text}</span>
    </div>
  )
}

/** 兜底：失败/暂停且无真实子代理会话（shell 等合成会话）时的最近 N 条消息列表。 */
function LastMessages({ item, t }: {
  readonly item: TimelineStepItem
  readonly t: TranslateNS<'sandore'>
}) {
  const lines = item.messages ?? []
  const failed = item.status === 'failed'
  const listClass = failed ? css.agentLastListFailed : css.agentLastListPaused
  // failed 态错误行优先取收尾错误详情（门禁失败 finalizeMeta.errorDetail），其次段 error。
  const fallback = failed
    ? (item.finalizeErrorDetail ?? item.error) !== undefined
      ? [{ who: `${item.name} · agent`, text: item.finalizeErrorDetail ?? item.error ?? '', kind: 'assistant' as const }]
      : []
    : [{ who: `${item.name} · agent`, text: t('step.paused.hint'), kind: 'assistant' as const }]
  const shown = lines.length > 0 ? lines.slice(-5) : fallback
  return (
    <div className={`${css.agentLastList} ${listClass}`}>
      <div className={css.agentLastScroll}>
        {shown.map((line, index) => (
          <ChatLineRow key={index} line={line} />
        ))}
      </div>
    </div>
  )
}

/** 收尾阶段 SVG 图标（语义化：finalizing=归档盒子 archive/ gating=盾牌/ routing=分支/ completed=对勾/ ask-detect=问号）。 */
function PhaseIcon({ phase }: { readonly phase: string }) {
  switch (phase) {
    case 'finalizing':
      return (
        <svg viewBox="0 0 14 14" fill="none" aria-hidden>
          {/* 归档盒子：盒体 + 向下箭头（收尾归档语义） */}
          <path d="M2.5 3.5h9l.5 2.5H2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M3 6v4.5h8V6" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M7 4v3M5.5 5.5L7 7l1.5-1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'gating':
      return (
        <svg viewBox="0 0 14 14" fill="none" aria-hidden>
          <path d="M7 1.5L2.5 3.5v3c0 3.5 4.5 6 4.5 6s4.5-2.5 4.5-6v-3L7 1.5z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'routing':
      return (
        <svg viewBox="0 0 14 14" fill="none" aria-hidden>
          <path d="M2 3h4m0 0L4 1m2 2L4 5M2 11h4m0 0l-2-2m2 2l-2 2M8 7h4m0 0l-2-2m2 2l-2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'completed':
      return (
        <svg viewBox="0 0 14 14" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.4" fill="currentColor" />
          <path d="M4.6 7.2l1.6 1.6 3.2-3.4" stroke="#fff" strokeWidth="1.3" fill="none" strokeLinecap="round" />
        </svg>
      )
    case 'ask-detect':
      return (
        <svg viewBox="0 0 14 14" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M5.5 5.5a1.5 1.5 0 0 1 3 0c0 1-1.5 1-1.5 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <circle cx="7" cy="10" r="0.5" fill="currentColor" />
        </svg>
      )
    default:
      return null
  }
}

/**
 * 收尾阶段徽标序列（最多五个过程状态位置同时展示）：
 * Round 17：纯 status 判断（删除 isPhaseDone/phaseHistory 依赖）。
 * ① 运行状态（已完成）② Phase A【已检测/检测中】③ Phase B【已收尾/收尾中】
 * ④ Phase C【已门禁/门禁失败/门禁中】⑤ Phase D【已判断/判断中】
 *
 * **三个可点标签（收尾 / 门禁 / 判断）都要能进入对应子代理会话**（真机缺陷修复）：
 * - 徽标是**独立按钮**，渲染在状态按钮**之外**（此前嵌在状态 `<button>` 里：无 target 时
 *   点击冒泡到状态按钮 → 把 step 卡片折叠起来，用户看到「点了标签反而收起消息」；
 *   顺带修掉 `<button>` 套 `<button>` 的非法结构）；
 * - 每个徽标 `stopPropagation`，点它**不触发** step 折叠；点头部状态按钮仍正常折叠；
 * - **三条 lane 的 durable parent 恒为宿主主代理会话**（`instanceId`）——引擎建的这三个辅助
 *   子代理（收尾 fork `assessResult.forkSessionId` / 门禁 continuable `gateResult.gateSessionId`
 *   / 路由 fork `routingResult.routingSessionId`）**都由 `agents.create`/`startContinuable` 建在
 *   宿主主代理名下**：`meta.parentSession = hostAgent.id ≡ instanceId`
 *   （见 `packages/microflow/finalize-manager.ts` 的 `parentSession: hostAgent.id` +
 *   `origin:'subagent'`、`fork-session.ts` 的 meta 组装、门禁 `startContinuable({parent: hostAgent})`）。
 *   故它们**全都要**走 subagent 地址通道：host 侧 `validateAddress` 对
 *   `kind:'session'` 的普通地址访问 `header.origin === 'subagent'` 的会话**恒拒**
 *   （`packages/api/session-controller/src/history.ts` 的 `validateAddress`，文案
 *   `历史加载失败：subagent Sessions require their durable parent address（session/agent-busy）`）。
 *   早前按「fork 不是谁的子代理」把收尾/判断两条 lane 判成 `useDurableParent: false` 走普通 open
 *   ——**那正是用户点「收尾中/判断中」报历史加载失败的原因**（同一会话从主代理会话的「子代理
 *   列表」进得去，证明它本身可被地址化，错在我们的打开通道）。
 * - completed 后 Phase B/D 的 fork 会话可能已 dispose：仍保留按钮（用户要求可点），
 *   真机由 DSH 侧给出「会话已销毁」的明确反馈，而不是静默变成不可点的纯文本。
 * Phase A（ask-detect）是临时会话、用完即删，保持纯文本不可点。
 */
function PhaseBadge({ item, t, openSession, parentSessionId }: {
  readonly item: TimelineStepItem
  readonly t: TranslateNS<'sandore'>
  readonly openSession: (id: string, parentSessionId?: string) => void
  /**
   * durable parent（宿主主代理会话 id = instanceId）。
   * 缺省（未接线时）回退调用方传入的 step 关系父，保持旧行为。
   */
  readonly parentSessionId?: string | undefined
}) {
  const badges: Array<{
    key: string
    labelKey: SandoreKey
    phase: string
    target: string | undefined
    isActive: boolean
    isFailed: boolean
  }> = []

  // Phase A 状态（ask-detect：临时评估会话，用完即删，不可点击）
  if (item.askStatus !== undefined) {
    const done = item.askStatus === 'done'
    badges.push({
      key: 'phase-a',
      labelKey: done ? 'run.step.finalize.phase.detected' : 'run.step.finalize.phase.detecting',
      phase: 'ask-detect',
      target: undefined,  // Phase A 无持久化会话，不可点击
      isActive: !done,
      isFailed: false,
    })
  }

  // Phase B 状态（收尾 fork 子代理：parent = 宿主主代理会话）
  if (item.assessStatus !== undefined) {
    const done = item.assessStatus === 'done'
    badges.push({
      key: 'phase-b',
      labelKey: done ? 'run.step.finalize.phase.done' : 'run.step.finalize.phase.finalizing',
      phase: 'finalizing',
      target: item.finalizeAssessSessionId,
      isActive: !done,
      isFailed: false,
    })
  }

  // Phase C 状态（门禁可续接子代理：parent = 宿主主代理会话）
  if (item.gateStatus !== undefined) {
    const done = item.gateStatus === 'done'
    const failed = item.gateStatus === 'failed'
    badges.push({
      key: 'phase-c',
      labelKey: failed ? 'run.step.finalize.phase.gate-failed'
            : done  ? 'run.step.finalize.phase.gated'
                    : 'run.step.finalize.phase.gating',
      phase: 'gating',
      target: item.finalizeGateSessionId,
      isActive: !done && !failed,
      isFailed: failed,
    })
  }

  // Phase D 状态（路由 fork 子代理：parent = 宿主主代理会话）
  if (item.routingStatus !== undefined) {
    const done = item.routingStatus === 'done'
    badges.push({
      key: 'phase-d',
      labelKey: done ? 'run.step.finalize.phase.routed' : 'run.step.finalize.phase.routing',
      phase: 'routing',
      target: item.finalizeRoutingSessionId,
      isActive: !done,
      isFailed: false,
    })
  }

  // 注意：不渲染 phase-completed badge——运行状态 badge（step.status === 'completed'
  // → 「已完成」）已表达「全部完成」语义，避免重复。

  if (badges.length === 0) return null

  return (
    <>
      {badges.map(badge => (
        badge.target !== undefined && badge.target !== '' ? (
          <button
            key={badge.key}
            type="button"
            className={`${css.phaseBtn} ${badge.isFailed ? css.phaseFailed : badge.isActive ? css.phaseActive : css.phaseDone}`}
            title={t('step.open', { name: t(badge.labelKey) })}
            data-tl-step-phase={badge.phase}
            onClick={(e) => {
              e.stopPropagation()
              // 三条 lane 统一走 durable 父地址（宿主主代理会话）→ openSubagent 的 subagent
              // 地址通道；没有 parent 时才退回普通 open（未接线/降级场景）。
              if (parentSessionId !== undefined && parentSessionId !== '') {
                openSession(badge.target!, parentSessionId)
                return
              }
              openSession(badge.target!)
            }}
          >
            <PhaseIcon phase={badge.phase} />
            <span>{t(badge.labelKey)}</span>
          </button>
        ) : (
          <span key={badge.key} className={`${css.phaseLabel} ${badge.isFailed ? css.phaseFailed : badge.isActive ? css.phaseActive : css.phaseDone}`}>
            <PhaseIcon phase={badge.phase} />
            <span>{t(badge.labelKey)}</span>
          </span>
        )
      ))}
    </>
  )
}

/**
 * 主代理卡片（需求 3；**三轮真机修正后的形态**）。
 *
 * 用户原话：「主代理的消息只有在主代理有消息更新的时候才插入到 discuss，作为一个 step 插入，
 * **头像是 M 表示主代理，然后标题就是主代理，下面是它的消息**」＋
 * 「**当主代理没有新消息输出时，主代理 step 默认折叠，而且主代理只有一个，一直放到最下面的
 * step**」——故：
 * - **位置**：步骤列表**最后一张**（与 step 卡片同级、全局唯一，绝不嵌进任何 step 卡片；
 *   见 UnifiedTimeline 的渲染点）；
 * - **折叠**：默认**折叠**（只显示卡头），**主代理每来一条新的助手消息就展开**；
 *   用户点击卡头可随时折叠/展开（`aria-expanded` + 同 step 卡片的状态按钮同款交互）。
 *   折叠时只藏卡体（消息区），卡头（头像 M + 标题「主代理」+ 状态 chip）始终可见。
 * - 视觉与 step 卡片**同一套实现**：`.agentMsg/.agentHead/.avatar/.avatarAgent/.author/.st`
 *   全部复用（同尺寸/形状/圆角/底色/字号/间距——见 timeline.module.css，与 AgentMsg 逐 class 相同），
 *   差别只有两处**内容**：头像里是字母 `M`；标题是「主代理」。
 * 卡体 = **主代理的消息**：复用同一个 StepChatPanel 的 `variant='main'`（同源 binding →
 * step-chat-source → step-view/ 行组件），不是另造渲染器。
 *
 * DOM 锚点：`[data-tl-main-agent]`（区别于 step 卡片的 `[data-tl-step]`）；内层面板带
 * `[data-main-agent-chat]` 而**不是** `[data-step-chat]`（f2 的能力边界断言只数 step 面板）。
 */
const MainAgentChatBlock = memo(function MainAgentChatBlock({ sessionId, outputCount, terminal, t }: {
  /** 宿主（主代理）会话 id。 */
  readonly sessionId: string
  /** 主代理会话里的助手消息条数（新消息到达 ⇒ 展开；见下方折叠状态机）。 */
  readonly outputCount: number
  /** 工作流是否已进入终态（completed / failed / aborted）——终态**强制展开**且不再自动折叠。 */
  readonly terminal: boolean
  readonly t: TranslateNS<'sandore'>
}) {
  // 状态 chip 的数据：宿主会话快照的 running（订阅与面板同源；会话未就绪 → 视为空闲）。
  const sessions = stepChatSessionsOf()
  useSyncExternalStore(
    sessions === undefined ? NOOP_SUBSCRIBE : sessions.list.subscribe,
    () => (sessions === undefined ? undefined : sessions.list.getSnapshot()),
  )
  const session = sessions?.binding(sessionId as SessionId)?.session
  const running = useSyncExternalStore(
    session === undefined ? NOOP_SUBSCRIBE : (onStoreChange) => session.subscribe(onStoreChange),
    () => session?.getSnapshot().running === true,
  )
  const status: StepStatus = running ? 'running' : 'completed'
  // ── 折叠状态机（用户规格，逐条对应）──────────────────────────────────────────
  // 1. **有新消息** → 展开（把新汇报显示出来）；
  // 2. **消息不再更新**（最后一条之后 MAIN_AGENT_AUTO_COLLAPSE_MS 内没有新增）→ 自动折叠；
  // 3. **工作流进入终态** → 强制展开（覆盖自动折叠），且终态后不再自动折叠；
  // 4. **手动操作优先**：点卡头手动折叠/展开立即生效并取消挂起的自动折叠计时；
  //    手动折叠后**不会被同一条消息弹开**——只有又来**新**消息（条数增加）才再次展开。
  // 首帧（打开运行页时主代理已有历史消息）保持**折叠**：那不是「新消息」。
  const [expanded, setExpanded] = useState(false)
  const lastSeen = useRef<number | null>(null)
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearCollapseTimer = useCallback((): void => {
    if (collapseTimer.current === null) return
    clearTimeout(collapseTimer.current)
    collapseTimer.current = null
  }, [])
  useEffect(() => clearCollapseTimer, [clearCollapseTimer])
  // ③ 终态：强制展开 + 取消自动折叠（终态的内容是用户要看的最终汇报）。
  useEffect(() => {
    if (!terminal) return
    clearCollapseTimer()
    setExpanded(true)
  }, [terminal, clearCollapseTimer])
  // ①②④ 新消息 → 展开 + 重新计时（终态不再计时）。
  useEffect(() => {
    if (outputCount === 0) return
    if (lastSeen.current === null) {
      lastSeen.current = outputCount
      return
    }
    if (outputCount <= lastSeen.current) return
    lastSeen.current = outputCount
    setExpanded(true)
    clearCollapseTimer()
    if (!terminal) {
      collapseTimer.current = setTimeout(() => {
        collapseTimer.current = null
        setExpanded(false)
      }, MAIN_AGENT_AUTO_COLLAPSE_MS)
    }
  }, [outputCount, terminal, clearCollapseTimer])
  // ④ 手动开合：立即生效并取消挂起的自动折叠（手动决策优先）。
  const toggle = useCallback((): void => {
    clearCollapseTimer()
    setExpanded(value => !value)
  }, [clearCollapseTimer])
  return (
    <div className={css.agentMsg} data-tl-main-agent>
      {/* 卡头 = **整条可点**的折叠开关（真机缺陷修复：原先只有窄窄的状态 chip 绑了 onClick，
          点头像/标题/空白处都没反应，用户报「点击没法展开」）。
          语义用真正的 `<button>`（Enter/Space 原生可用），其内是头像 + 标题 + 状态 + 折叠箭头；
          状态 chip 因此从 `<button>` 降级为 `<span>`（按钮不能嵌套按钮），视觉不变。 */}
      <button
        type="button"
        className={css.agentHeadButton}
        aria-expanded={expanded}
        aria-label={t('run.mainAgent.toggle', { name: t('run.mainAgent.name') })}
        title={t('run.mainAgent.toggle', { name: t('run.mainAgent.name') })}
        data-tl-main-agent-toggle
        onClick={toggle}
      >
        {/* 头像：与 step 卡片同一个 `.avatar .avatarAgent` 壳（同尺寸/圆角/底色/字号），
            内容换成字母 `M`（= 主代理），见用户规格。 */}
        <span className={`${css.avatar} ${css.avatarAgent}`} data-tl-main-agent-avatar aria-hidden>M</span>
        <span className={css.author} data-tl-main-agent-title>{t('run.mainAgent.name')}</span>
        {/* 状态 chip：与 step 卡片的状态按钮同套视觉（只读，不再是按钮）。 */}
        <span
          className={`${css.st} ${statusClass(status)}`}
          data-tl-main-agent-status
          aria-live="polite"
          title={running ? t('run.mainAgent.status.running') : t('run.mainAgent.status.idle')}
        >
          <StatusIcon status={status} />
          <span className={css.stLbl}>
            {running ? t('run.mainAgent.status.running') : t('run.mainAgent.status.idle')}
          </span>
        </span>
        {/* 折叠箭头：与 step 卡片/下拉触发器同款（`rotate(180deg)` 表示已展开）。 */}
        <span
          className={`${css.headChevron} ${expanded ? css.headChevronOpen : ''}`}
          data-tl-main-agent-chevron
          aria-hidden
        >
          <IconChevronDownOutline14 />
        </span>
      </button>
      {/* 卡体：折叠时只藏消息区（卡头常驻）。 */}
      {expanded && (
        <StepChatPanel
          key={`main-agent-${sessionId}`}
          sessionId={sessionId}
          variant="main"
          t={t}
        />
      )}
    </div>
  )
})

/**
 * 单条 agent 消息（一个 executedStep）。
 *
 * memo 化：item 引用由 buildTimeline 的引用稳定缓存保证（未变化的行跨轮询轮次
 * 保持同引用），MarkdownText / StepChatPanel 等重组件在轮询期跳过重渲染。
 */
const AgentMsg = memo(function AgentMsg({ item, t, nowIso, openSession, instanceId, steps, retry }: {
  readonly item: TimelineStepItem
  readonly t: TranslateNS<'sandore'>
  readonly nowIso: string
  readonly openSession: (id: string, parentSessionId?: string) => void
  /** 批 B1：本实例 id（@step 提及登记；缺省不登记——旧调用方/测试不传即降级）。 */
  readonly instanceId?: string | undefined
  /** 批 B1：本实例的 Step 执行段（@step 候选数据源；RunView 既有 state 片段）。 */
  readonly steps?: readonly StepMentionStepLike[] | undefined
  /** 批 B2：重试调用面（缺省不传 → 面板不渲染重试行）。 */
  readonly retry?: StepRetryActions | undefined
}) {
  const running = item.status === 'running' || item.status === 'interacting'
  const terminalChat = item.status === 'failed' || item.status === 'paused'
  const rel = relativeTimeOf(item.time, nowIso)
  // 状态按钮：点击折叠/展开消息区（正文按状态渲染）。
  const [collapsed, setCollapsed] = useState(false)
  // 仅真实子代理步骤（prompt/agent/skill/mcp，非合成会话）才有真实会话：标题可点击跳
  // DSH 子代理页、正文内嵌该会话的 DSH 对话流；shell 的 childId 是合成占位（无真实
  // 会话），标题渲染为纯文本、正文走兜底。
  const realSession = item.childId !== undefined && item.synthetic !== true
  // 需求 3：**完成后不再用收尾总结替换 step 下方的会话区**。
  //
  // 产品要求：step/实例 completed 后 step 下方仍是**完整会话消息区**（过程按官方
  // turn-process 折叠语义折成「已完成」标签 + 可展开），收尾总结（引擎字段
  // `finalizeMeta.assessResult.compressedOutput`）只作为**传给后续 step 的输出内容**
  // 留在数据层，不再以「Agent 输出」摘要的形式显示在卡片下方。故：
  // - 有真实会话（realSession）→ 面板在所有「有内容可看」的状态挂载
  //   （running/interacting、completed、failed、paused），且 completed 分支不再渲染
  //   compressedOutput / outputText 的 md 摘要；
  // - 无真实会话（shell 等合成会话，面板挂不了）→ 保持既有行为：completed 显示
  //   命令输出 outputText（f2 的能力边界断言依赖它：shell 步 `[data-step-chat]`=0、
  //   但输出文本仍可见）。
  const panelShown = realSession && (running || item.status === 'completed' || terminalChat)
  // 收尾总结摘要只在「没有会话区可替代它」时保留（合成会话/无真实会话）。
  const summaryShown = !panelShown
  // 批 B2：重试端口 = RunView 的调用面 + **本段**定位片段（stepId/status/
  // commandType/synthetic）。引用按段字段 memo：memo 化行组件在轮询期重渲染时
  // 不换新对象，面板/StepRetryRow 的 props 保持稳定。
  const retryPort: StepChatRetryPort | undefined = useMemo(
    () => (retry === undefined ? undefined : {
      ...retry,
      target: {
        stepId: item.stepId,
        status: item.status,
        commandType: item.commandType,
        synthetic: item.synthetic,
        attemptIndex: item.attemptIndex,
      },
    }),
    [retry, item.stepId, item.status, item.commandType, item.synthetic, item.attemptIndex],
  )
  // 批 B2：面板挂载 key——fork/revert 重试会换 sessionMeta.childId（引擎 forkSession +
  // createAgent），key 换值即重挂面板：新会话重新 binding/开窗/拉历史，绝不会
  // 停在已 dispose 的旧会话上（无 key 时 React 复用同一实例，旧 binding 的
  // session-removed 竞态会让面板停在 loading）。
  // 需求 3 的单点挂载位（见下方 panelShown）不改变本 key 语义：同一 childId 下
  // running → completed 只是状态翻转，React 复用同一实例（不重挂、不重开窗）。
  const panelKey = item.childId ?? item.stepId
  return (
    <div
      className={css.agentMsg}
      data-tl-step
      // 每 step 一档的轮次条（`step-view/StepRail.tsx`）按这两个属性定位卡片：
      // stepId + attemptIndex（重试/回退会产生同 stepId 的多段，必须能区分到具体段）。
      data-step-id={item.stepId}
      data-step-attempt={String(item.attemptIndex ?? 0)}
    >
      <div className={css.agentHead}>
        <span className={`${css.avatar} ${css.avatarAgent}`} aria-hidden><IconSparkle16 /></span>
        {realSession ? (
          <button
            type="button"
            className={css.authorLink}
            title={t('step.open', { name: item.name })}
            // 带上 durable 直接父（`sessionMeta.hostSessionId`）：宿主打开子代理会话时
            // 必须装配 subagent 地址，否则「加载更早」会被宿主以 session/agent-busy 拒
            // （真机缺陷：历史加载失败 / subagent Sessions require their durable parent address）。
            onClick={() => { openSession(item.childId as string, item.parentSessionId) }}
          >
            {item.name}
          </button>
        ) : (
          <span className={css.author}>{item.name}</span>
        )}
        {item.loopLabel !== undefined && <span className={css.loopLabel}>{item.loopLabel}</span>}
        {item.attemptIndex !== undefined && item.attemptIndex > 0 && (
          <span className={css.loopLabel}>{t('run.step.attempt', { n: item.attemptIndex + 1 })}</span>
        )}
        {rel !== undefined && <span className={css.time}>{formatTime(t, rel)}</span>}
        {/* 状态按钮：状态文本；点击折叠/展开消息区（**收尾/门禁/判断徽标已移出本按钮**，
            见下方 PhaseBadge 调用点：徽标各自是按钮，点它不会折叠 step）。 */}
        <button
          type="button"
          className={`${css.st} ${css.stBtn} ${statusClass(item.status)}`}
          title={t(STEP_STATUS_KEYS[item.status])}
          aria-label={t(STEP_STATUS_KEYS[item.status])}
          aria-expanded={!collapsed}
          onClick={() => { setCollapsed(value => !value) }}
        >
          <StatusIcon status={item.status} />
          <span className={css.stLbl}>{t(STEP_STATUS_KEYS[item.status])}</span>
        </button>
        {/* 收尾阶段徽标：**折叠行之外**的独立按钮（点击进入对应子代理会话）。 */}
        <PhaseBadge
          item={item}
          t={t}
          openSession={openSession}
          {...(instanceId ?? item.parentSessionId) === undefined
            ? {}
            : { parentSessionId: (instanceId ?? item.parentSessionId) as string }}
        />
      </div>

      {!collapsed && (
        <>
          {item.status === 'completed' && summaryShown && (
            // Round 20：shell 步骤无收尾压缩（跳过 Phase A/B，compressedOutput 为空串会
            // 渲染空白）——按 commandType 判定直接显示命令输出 outputText；
            // 非 shell 优先 compressedOutput，降级（assessResult.errorDetail 非 undefined）
            // 时回退原始 output。
            // 需求 3：**只在没有会话面板可看时**才走这条摘要路径（有真实会话的
            // completed 段落回会话区，收尾总结退回数据层，不再显示在卡片下方）。
            item.commandType === 'shell' && item.outputText !== undefined
              ? <div className={css.md}><MarkdownText text={item.outputText} labels={markdownLabels(t)} /></div>
              // 非 shell：优先 compressedOutput，降级（有 errorDetail）时回退 output
              : item.commandType !== 'shell' && (
                item.finalizeAssessErrorDetail === undefined
                  && item.finalizeAssessResult?.compressedOutput !== undefined
                  ? <div className={css.md}><MarkdownText text={item.finalizeAssessResult.compressedOutput} labels={markdownLabels(t)} /></div>
                  : item.outputText !== undefined
                    ? <div className={css.md}><MarkdownText text={item.outputText} labels={markdownLabels(t)} /></div>
                    : null
              )
          )}

          {running && !realSession && (
            // 合成会话/无会话退化为原有的消息框或「运行中…」占位（真实子代理段的
            // 面板统一在下面的单点挂载位渲染，见 panelShown）。
            item.messages !== undefined && item.messages.length > 0
              ? (
                <div className={css.agentChat}>
                  <div className={css.agentChatScroll}>
                    {item.messages.map((line, index) => (
                      <ChatLineRow key={index} line={line} />
                    ))}
                  </div>
                </div>
              )
              : <div className={css.agentBodyRun}>{t('run.step.status.running')}…</div>
          )}

          {terminalChat && (
            <>
              {/* Round 14：failed 态——errorDetail 恢复 errorBlock 样式，compressedOutput 用 .md 平铺。 */}
              {item.status === 'failed' && (
                <>
                  {/* errorDetail：恢复原 errorBlock 样式（浅红背景+红色边框+红色文字） */}
                  {(item.finalizeErrorDetail ?? item.error) && (
                    <div className={css.errorBlock}>
                      <span className={css.errorText}>{item.finalizeErrorDetail ?? item.error}</span>
                    </div>
                  )}
                  {/* compressedOutput：平铺 .md（与运行中消息同风格） */}
                  {item.finalizeAssessResult?.compressedOutput !== undefined && (
                    <div className={css.md}><MarkdownText text={item.finalizeAssessResult.compressedOutput} labels={markdownLabels(t)} /></div>
                  )}
                </>
              )}
              {/* paused 态：合成会话（shell）时退化为最近 N 条兜底；真实会话走下方
                  单点挂载的会话面板。 */}
              {item.status === 'paused' && !realSession && <LastMessages item={item} t={t} />}
            </>
          )}

          {/* 会话区（单点挂载位）：真实子代理段的 running/interacting、failed、
              paused **与 completed**（需求 3）都在这里挂同一份面板——位置固定不变，
              故 running → completed 的状态翻转不会重挂面板（同一 React 实例、同一
              会话 binding 与已加载历史，过程折叠按官方语义就地生效）。
              合成会话（shell）永不挂面板（f2 的能力边界断言）。 */}
          {panelShown && (
            <StepChatPanel
              key={panelKey}
              sessionId={item.childId as string}
              parentSessionId={item.parentSessionId}
              instanceId={instanceId}
              steps={steps}
              retry={retryPort}
              t={t}
            />
          )}
        </>
      )}
    </div>
  )
})

/** 用户消息：右侧气泡 + kind 徽标 + meta（memo 化，理由同 AgentMsg）。 */
const UserMsg = memo(function UserMsg({ item, t, nowIso }: {
  readonly item: Extract<TimelineItem, { readonly kind: 'user' }>
  readonly t: TranslateNS<'sandore'>
  readonly nowIso: string
}) {
  const rel = relativeTimeOf(item.time, nowIso)
  // 消息种类徽标：`buildTimeline` 只放行 `kind:'input'`（真实用户输入），遗留的
  // resume/retry/answer/message 行根本到不了这里，所以映射链已收成一支——不再为不可达的
  // kind 保留分支与文案（`locales.ts` 里那 4 个键已随之删除）。`data-tl-user-kind` 供真机
  // 断言「活下来的那一行确实是 input」。
  return (
    <div className={css.userMsg} data-tl-user>
      <div className={css.bubble}>{item.content}</div>
      <div className={css.userMeta}>
        {item.messageKind === 'input' && (
          <span className={css.loopLabel} data-tl-user-kind="input">{t('run.user.kind.input')}</span>
        )}
        {rel !== undefined && <span className={css.time}>{formatTime(t, rel)} · {t('run.time.you')}</span>}
      </div>
    </div>
  )
})

/** 渲染执行详情对话流。 */
export function UnifiedTimeline({ t, items, openSession, scrollContainerRef, instanceId, steps, retry, hostSessionId, mainChat }: {
  /** 类型化翻译函数。 */
  t: TranslateNS<'sandore'>
  /** 时间线条目（buildTimeline 派生）。 */
  items: readonly TimelineItem[]
  /** 跳子代理会话（agent 标题点击）。 */
  openSession: (id: string, parentSessionId?: string) => void
  /** 滚动容器（RunView feedScroll）ref：「加载更早」扩窗 prepend 保位用；缺省不补偿。 */
  scrollContainerRef?: RefObject<HTMLDivElement>
  /** 批 B1：实例 id（逐行下传到内嵌 StepChatPanel，供 @step 登记；缺省不登记）。 */
  instanceId?: string | undefined
  /** 批 B1：实例的 Step 执行段（RunView 既有 state 片段；@step 候选数据源）。 */
  steps?: readonly StepMentionStepLike[] | undefined
  /** 批 B2：重试调用面（逐行补上本段定位片段后下传内嵌 StepChatPanel；缺省不渲染重试行）。 */
  retry?: StepRetryActions | undefined
  /** 主代理卡片：宿主（主代理）会话 id（缺省 = 不渲染该卡片）。 */
  hostSessionId?: string | undefined
  /**
   * 主代理卡片是否出现（`RunView` 经 `useMainAgentCard` 判定：用户已发送 **且** 主代理
   * 已产出新的助手输出）。为假时**不产出任何 DOM**（连空壳/标题都没有）。
   */
  mainChat?: { readonly shown: boolean; readonly outputCount?: number; readonly terminal?: boolean } | undefined
}) {
  // 「现在」时间戳：state 低频刷新（60s）而非每次渲染取值——nowIso 若每次渲染都变，
  // 字符串变化会击穿上方 memo 行组件的浅比较，重渲染治理失效；60s 刷新保持相对时间新鲜。
  const [nowIso, setNowIso] = useState(() => new Date().toISOString())
  useEffect(() => {
    const timer = setInterval(() => { setNowIso(new Date().toISOString()) }, NOW_REFRESH_MS)
    return () => { clearInterval(timer) }
  }, [])

  // 尾部窗口（step agent 粒度）：默认最多渲染最近 TIMELINE_MAX_STEPS 个 step agent
  // （含夹在中间的 user 消息——user 气泡轻量不限窗；step 内部消息本就只渲染最近几条），
  // 顶部「加载更早」逐次多放 TIMELINE_STEPS_PAGE 个 step；step 总数不足时全量渲染。
  const [visibleSteps, setVisibleSteps] = useState(TIMELINE_MAX_STEPS)
  // prepend 保位锚点：点击「加载更早」时记录滚动容器 scrollHeight，扩窗 commit 后补偿。
  const pendingAnchorRef = useRef<number | null>(null)
  const { start, hidden } = visibleTimelineWindow(
    items,
    item => item.kind !== 'user',
    visibleSteps,
  )
  const visible = items.slice(start)

  /** 「加载更早」：记录当前 scrollHeight 作为保位锚点，再向历史方向扩一页 step。 */
  const loadOlder = (): void => {
    const el = scrollContainerRef?.current ?? null
    if (el !== null) pendingAnchorRef.current = el.scrollHeight
    setVisibleSteps(count => count + TIMELINE_STEPS_PAGE)
  }

  // 扩窗 commit 后补偿 scrollTop：新增内容高度 = scrollHeight - 锚点，加到 scrollTop 上，
  // 用户视角停在原首条消息处（经典 prepend 保位，效果对齐 DSH ChatView 的 pagingAnchor）。
  useLayoutEffect(() => {
    const el = scrollContainerRef?.current ?? null
    if (pendingAnchorRef.current === null || el === null) return
    el.scrollTop += el.scrollHeight - pendingAnchorRef.current
    pendingAnchorRef.current = null
  }, [visibleSteps, scrollContainerRef])

  // ── 主代理卡片（需求 3）的插入点判定 ─────────────────────────────────────────
  // 位置（**真机反馈修正**）：主代理只有一个，**固定放在步骤列表最下面**——不再「紧跟正在
  // 执行的 step」（那条规则会让卡片随执行推进在列表里上下移动）。出现条件不变：主代理会话里
  // 有助手消息才渲染（`mainChat.shown`），没有任何消息时连空壳都不产出。
  const mainAgentCardShownHere = mainChat?.shown === true && hostSessionId !== undefined

  return (
    <div className={css.flow} data-sandore-timeline>
      {items.length === 0 && <p className={css.empty}>{t('run.trajectory.empty')}</p>}
      {hidden > 0 && (
        // 「加载更早」（DSH ChatView .older 观感：居中小胶囊 + 剩余条数）。
        <div className={css.older}>
          <button type="button" onClick={loadOlder}>{t('run.loadOlder')} · {hidden}</button>
        </div>
      )}
      {/* 逐条渲染（key 基于绝对索引：窗口扩展时既有条目的 key 稳定，不触发重建）。 */}
      {visible.map((item, offset) => {
        const index = start + offset
        return item.kind === 'user'
          ? <UserMsg key={`user-${index}`} item={item} t={t} nowIso={nowIso} />
          : (
            <AgentMsg
              key={`${item.stepId}-${index}`}
              item={item}
              t={t}
              nowIso={nowIso}
              openSession={openSession}
              instanceId={instanceId}
              steps={steps}
              retry={retry}
            />
          )
      })}
      {/* 主代理卡片：**始终最后**（稳定 key ⇒ 与 step 卡片同级、全局唯一，绝不嵌进任何 step 卡片）。 */}
      {mainAgentCardShownHere && (
        <MainAgentChatBlock
          key={MAIN_AGENT_CARD_KEY}
          sessionId={hostSessionId}
          outputCount={mainChat?.outputCount ?? 0}
          terminal={mainChat?.terminal === true}
          t={t}
        />
      )}
    </div>
  )
}
