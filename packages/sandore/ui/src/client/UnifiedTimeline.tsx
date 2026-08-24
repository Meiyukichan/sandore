/**
 * UnifiedTimeline：执行详情对话流（按 execution-detail-prototype.html 原型）。
 *
 * multica Issue 评论流 × DSH 多 agent 对话流：用户输入 = 右侧气泡；每个
 * executedStep = 一条 agent 消息（左对齐，头像 + 可点击标题 → openSession 打开
 * DSH 现成子代理会话页 + 相对时间 + 状态图标）。正文按状态呈现：
 * completed → md 渲染块（MarkdownText，原型 .md 样式）；running/interacting 与
 * failed/paused（真实子代理会话）→ 内嵌 DSH 对话流（StepChatPanel，最新 10 条，
 * 无边框平铺，风格与运行中完全一致）；failed/paused 无真实会话（shell 等合成
 * 会话）→ 最近 5 条消息列表兜底（末条按失败/暂停色）。旧实例无时间戳时头部省略时间。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/UnifiedTimeline
 */
import { IconSparkle16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useState } from 'react'

import type { SandoreKey } from './locales.ts'
import {
  relativeTimeOf, type ChatLine, type RelativeTime, type StepStatus, type TimelineItem, type TimelineStepItem,
} from './run-view-model.ts'
import { StepChatPanel } from './StepChatPanel.tsx'
import css from './timeline.module.css'

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
 * Phase B/C/D 可点击（进入对应子代理会话）；Phase A 不可点击（临时会话，用完即删）。
 * Round 20：completed 后 fork 会话已 dispose（live 移除），点击会报 unknown session——
 * completed 态将 Phase B/C/D 的 target 置 undefined，徽标降级为纯文本（不可点击）。
 */
function PhaseBadge({ item, t, openSession }: {
  readonly item: TimelineStepItem
  readonly t: TranslateNS<'sandore'>
  readonly openSession: (id: string) => void
}) {
  // Round 20：completed 后 fork 会话已 dispose，badge 降级为纯文本（不可点击）。
  const isCompleted = item.status === 'completed'
  const badges: Array<{ key: string; labelKey: SandoreKey; phase: string; target: string | undefined; isActive: boolean; isFailed: boolean }> = []

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

  // Phase B 状态
  if (item.assessStatus !== undefined) {
    const done = item.assessStatus === 'done'
    badges.push({
      key: 'phase-b',
      labelKey: done ? 'run.step.finalize.phase.done' : 'run.step.finalize.phase.finalizing',
      phase: 'finalizing',
      // completed 后 fork 会话已 dispose → 不可点击
      target: isCompleted ? undefined : item.finalizeAssessSessionId,
      isActive: !done,
      isFailed: false,
    })
  }

  // Phase C 状态
  if (item.gateStatus !== undefined) {
    const done = item.gateStatus === 'done'
    const failed = item.gateStatus === 'failed'
    badges.push({
      key: 'phase-c',
      labelKey: failed ? 'run.step.finalize.phase.gate-failed'
            : done  ? 'run.step.finalize.phase.gated'
                    : 'run.step.finalize.phase.gating',
      phase: 'gating',
      // completed 后 fork 会话已 dispose → 不可点击
      target: isCompleted ? undefined : item.finalizeGateSessionId,
      isActive: !done && !failed,
      isFailed: failed,
    })
  }

  // Phase D 状态
  if (item.routingStatus !== undefined) {
    const done = item.routingStatus === 'done'
    badges.push({
      key: 'phase-d',
      labelKey: done ? 'run.step.finalize.phase.routed' : 'run.step.finalize.phase.routing',
      phase: 'routing',
      // completed 后 fork 会话已 dispose → 不可点击
      target: isCompleted ? undefined : item.finalizeRoutingSessionId,
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
            onClick={(e) => { e.stopPropagation(); openSession(badge.target!) }}
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

/** 单条 agent 消息（一个 executedStep）。 */
function AgentMsg({ item, t, nowIso, openSession }: {
  readonly item: TimelineStepItem
  readonly t: TranslateNS<'sandore'>
  readonly nowIso: string
  readonly openSession: (id: string) => void
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
  return (
    <div className={css.agentMsg} data-tl-step>
      <div className={css.agentHead}>
        <span className={`${css.avatar} ${css.avatarAgent}`} aria-hidden><IconSparkle16 /></span>
        {realSession ? (
          <button
            type="button"
            className={css.authorLink}
            title={t('step.open', { name: item.name })}
            onClick={() => { openSession(item.childId as string) }}
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
        {/* 状态按钮：状态 + 收尾阶段徽标；点击折叠/展开消息区。 */}
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
          <PhaseBadge item={item} t={t} openSession={openSession} />
        </button>
      </div>

      {!collapsed && (
        <>
          {item.status === 'completed' && (
            // Round 20：shell 步骤无收尾压缩（跳过 Phase A/B，compressedOutput 为空串会
            // 渲染空白）——按 commandType 判定直接显示命令输出 outputText；
            // 非 shell 优先 compressedOutput，降级（assessResult.errorDetail 非 undefined）
            // 时回退原始 output。
            item.commandType === 'shell' && item.outputText !== undefined
              ? <div className={css.md}><MarkdownText text={item.outputText} /></div>
              // 非 shell：优先 compressedOutput，降级（有 errorDetail）时回退 output
              : item.commandType !== 'shell' && (
                item.finalizeAssessErrorDetail === undefined
                  && item.finalizeAssessResult?.compressedOutput !== undefined
                  ? <div className={css.md}><MarkdownText text={item.finalizeAssessResult.compressedOutput} /></div>
                  : item.outputText !== undefined
                    ? <div className={css.md}><MarkdownText text={item.outputText} /></div>
                    : null
              )
          )}

          {running && (
            // 真实子代理步骤（有 childId 且非合成会话）：内嵌子代理会话对话区
            // （抄自 DSH ChatView 渲染栈，最新 10 条，step 运行中实时流式）；
            // 合成会话/无会话退化为原有的消息框或「运行中…」占位。
            realSession
              ? <StepChatPanel sessionId={item.childId} t={t} />
              : (
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
              )
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
                    <div className={css.md}><MarkdownText text={item.finalizeAssessResult.compressedOutput} /></div>
                  )}
                </>
              )}
              {/* paused 态：最新 10 条消息（真实会话 → DSH 对话流；合成会话 → 最近 N 条兜底）。 */}
              {item.status === 'paused' && (
                <>
                  {realSession
                    ? <StepChatPanel sessionId={item.childId} t={t} />
                    : <LastMessages item={item} t={t} />}
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

/** 用户消息：右侧气泡 + kind 徽标 + meta。 */
function UserMsg({ item, t, nowIso }: {
  readonly item: Extract<TimelineItem, { readonly kind: 'user' }>
  readonly t: TranslateNS<'sandore'>
  readonly nowIso: string
}) {
  const rel = relativeTimeOf(item.time, nowIso)
  // 消息种类徽标（input/resume/retry/answer/message）；旧实例无 messageKind 时省略。
  const kindKey = item.messageKind === undefined
    ? undefined
    : item.messageKind === 'input' ? 'run.user.kind.input'
    : item.messageKind === 'resume' ? 'run.user.kind.resume'
    : item.messageKind === 'retry' ? 'run.user.kind.retry'
    : item.messageKind === 'answer' ? 'run.user.kind.answer'
    : item.messageKind === 'message' ? 'run.user.kind.message'
    : undefined
  return (
    <div className={css.userMsg} data-tl-user>
      <div className={css.bubble}>{item.content}</div>
      <div className={css.userMeta}>
        {kindKey !== undefined && <span className={css.loopLabel}>{t(kindKey)}</span>}
        {rel !== undefined && <span className={css.time}>{formatTime(t, rel)} · {t('run.time.you')}</span>}
      </div>
    </div>
  )
}

/** 渲染执行详情对话流。 */
export function UnifiedTimeline({ t, items, openSession }: {
  /** 类型化翻译函数。 */
  t: TranslateNS<'sandore'>
  /** 时间线条目（buildTimeline 派生）。 */
  items: readonly TimelineItem[]
  /** 跳子代理会话（agent 标题点击）。 */
  openSession: (id: string) => void
}) {
  // 每次渲染取「现在」，运行中轮询会带动重渲染，保持相对时间新鲜。
  const nowIso = new Date().toISOString()
  return (
    <div className={css.flow} data-sandore-timeline>
      {items.length === 0 && <p className={css.empty}>{t('run.trajectory.empty')}</p>}
      {items.map((item, index) => (
        item.kind === 'user'
          ? <UserMsg key={`user-${index}`} item={item} t={t} nowIso={nowIso} />
          : <AgentMsg key={`${item.stepId}-${index}`} item={item} t={t} nowIso={nowIso} openSession={openSession} />
      ))}
    </div>
  )
}
