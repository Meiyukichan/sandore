/**
 * UnifiedTimeline：执行详情对话流（按 execution-detail-prototype.html 原型）。
 *
 * multica Issue 评论流 × DSH 多 agent 对话流：用户输入 = 右侧气泡；每个
 * executedStep = 一条 agent 消息（左对齐，头像 + 可点击标题 → openSession 打开
 * DSH 现成子代理会话页 + 相对时间 + 状态图标）。正文按状态呈现：
 * completed → md 渲染块（MessageText，原型 .md 样式）；running/interacting →
 * 内嵌可滚动消息框（sessionMessages 行）；failed/paused → 最近 5 条消息列表
 * （末条按失败/暂停色）。旧实例无时间戳时头部省略时间。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/UnifiedTimeline
 */
import { IconSparkle16, MessageText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import type { SandoreKey } from './locales.ts'
import {
  relativeTimeOf, type ChatLine, type RelativeTime, type StepStatus, type TimelineItem, type TimelineStepItem,
} from './run-view-model.ts'
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

/** 最近 N 条消息列表（失败/暂停态）。 */
function LastMessages({ item, t }: {
  readonly item: TimelineStepItem
  readonly t: TranslateNS<'sandore'>
}) {
  const lines = item.messages ?? []
  const failed = item.status === 'failed'
  const listClass = failed ? css.agentLastListFailed : css.agentLastListPaused
  const fallback = failed
    ? (item.error !== undefined ? [{ who: `${item.name} · agent`, text: item.error, kind: 'assistant' as const }] : [])
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

/** 单条 agent 消息（一个 executedStep）。 */
function AgentMsg({ item, t, nowIso, openSession }: {
  readonly item: TimelineStepItem
  readonly t: TranslateNS<'sandore'>
  readonly nowIso: string
  readonly openSession: (id: string) => void
}) {
  const running = item.status === 'running' || item.status === 'interacting'
  const rel = relativeTimeOf(item.time, nowIso)
  // 仅真实子代理步骤（agent/skill/mcp，非合成会话）的标题可点击跳 DSH 子代理页；
  // shell/prompt 的 childId 是合成占位（无真实会话），点击无效，渲染为纯文本。
  const navigable = item.childId !== undefined && item.synthetic !== true
  return (
    <div className={css.agentMsg} data-tl-step>
      <div className={css.agentHead}>
        <span className={`${css.avatar} ${css.avatarAgent}`} aria-hidden><IconSparkle16 /></span>
        {navigable ? (
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
        <span className={`${css.st} ${statusClass(item.status)}`}>
          <StatusIcon status={item.status} />
          <span className={css.stLbl}>{t(STEP_STATUS_KEYS[item.status])}</span>
        </span>
      </div>

      {item.status === 'completed' && item.outputText !== undefined && (
        <div className={css.md}><MessageText text={item.outputText} /></div>
      )}

      {running && (
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

      {item.status === 'failed' && <LastMessages item={item} t={t} />}
      {item.status === 'paused' && <LastMessages item={item} t={t} />}
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
