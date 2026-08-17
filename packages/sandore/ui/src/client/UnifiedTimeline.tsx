/**
 * UnifiedTimeline：执行态中栏统一时间线（step 卡片 + user 气泡交错）。
 *
 * 数据由 `buildTimeline` 从实例状态派生（轮询驱动，无实时消息流）。Step 卡片按
 * 状态展示：completed → 输出文本（MessageText）+「查看详情」跳子会话；running →
 * 运行中占位；failed → 错误详情；paused → 暂停提示。滑动窗口：初始可见 N 条，
 * 滚动到顶部加载更多。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/UnifiedTimeline
 */
import { useMemo, useRef, useState, type UIEvent } from 'react'
import { MessageText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import type { SandoreKey } from './locales.ts'
import type { StepStatus, TimelineItem, TimelineStepItem } from './run-view-model.ts'
import css from './timeline.module.css'

/** 初始可见消息数 / 每次滚动加载的增量。 */
const VISIBLE_COUNT = 50
const VISIBLE_STEP = 50

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

/** Step 卡片头像字符与语义类。 */
function stepAvatar(status: StepStatus): { glyph: string; className: string } {
  switch (status) {
    case 'completed':
      return { glyph: '✓', className: css.avatarDone ?? '' }
    case 'running':
    case 'interacting':
      return { glyph: '●', className: css.avatarRun ?? '' }
    case 'failed':
      return { glyph: '✕', className: css.avatarFail ?? '' }
    case 'paused':
      return { glyph: '⏸', className: css.avatarPaused ?? '' }
    default:
      return { glyph: '○', className: css.avatarTodo ?? '' }
  }
}

/** 单个 Step 卡片。 */
function StepCard({ item, t, openSession }: {
  readonly item: TimelineStepItem
  readonly t: TranslateNS<'sandore'>
  readonly openSession: (id: string) => void
}) {
  const avatar = stepAvatar(item.status)
  const running = item.status === 'running' || item.status === 'interacting'
  return (
    <article className={css.stepCard} data-tl-step>
      <header className={css.stepHeader}>
        <span className={`${css.avatar} ${avatar.className}`} aria-hidden>{avatar.glyph}</span>
        <span className={css.stepName}>
          {item.name}
          {item.loopLabel !== undefined && <span className={css.loopLabel}>{item.loopLabel}</span>}
        </span>
        <span className={`${css.badge ?? ''} ${running ? (css.badgeRun ?? '') : item.status === 'completed' ? (css.badgeDone ?? '') : item.status === 'failed' ? (css.badgeFail ?? '') : item.status === 'paused' ? (css.badgePaused ?? '') : ''}`}>
          <span className={css.badgeDot ?? ''} aria-hidden />
          {t(STEP_STATUS_KEYS[item.status])}
        </span>
        {item.visitCount > 1 && (
          <span className={css.visitCount}>{t('run.visitCount', { count: item.visitCount })}</span>
        )}
      </header>
      <div className={css.stepBody}>
        {item.status === 'completed' && item.outputText !== undefined && (
          <div className={css.stepReturn}>
            <MessageText text={item.outputText} />
          </div>
        )}
        {item.status === 'failed' && item.error !== undefined && (
          <div className={css.stepError} role="alert">{item.error}</div>
        )}
        {item.status === 'paused' && (
          <div className={css.stepPaused}>{t('step.paused.hint')}</div>
        )}
        {running && (
          <div className={css.stepRunning}>{t('run.step.status.running')}…</div>
        )}
        {item.childId !== undefined && (
          <button
            type="button"
            className={css.expandBtn}
            onClick={() => { openSession(item.childId as string) }}
          >
            ▶ {t('run.discuss')}
          </button>
        )}
      </div>
    </article>
  )
}

/** 用户气泡。 */
function UserBubble({ content }: { readonly content: string }) {
  return (
    <div className={css.userBubble} data-tl-user>
      <div className={css.userContent}>{content}</div>
      <div className={css.userAvatar}>你</div>
    </div>
  )
}

/** 渲染统一时间线。 */
export function UnifiedTimeline({ t, items, openSession }: {
  /** 类型化翻译函数。 */
  t: TranslateNS<'sandore'>
  /** 时间线条目（buildTimeline 派生）。 */
  items: readonly TimelineItem[]
  /** 跳子会话/宿主会话。 */
  openSession: (id: string) => void
}) {
  const [visibleCount, setVisibleCount] = useState(VISIBLE_COUNT)
  const scrollRef = useRef<HTMLDivElement>(null)

  const visibleItems = useMemo(() => items.slice(-visibleCount), [items, visibleCount])

  // 滑动窗口：滚动到顶部时加载更早条目。
  const handleScroll = (event: UIEvent<HTMLDivElement>): void => {
    if (event.currentTarget.scrollTop === 0 && visibleCount < items.length) {
      setVisibleCount(count => Math.min(count + VISIBLE_STEP, items.length))
    }
  }

  return (
    <div className={css.scroll} ref={scrollRef} onScroll={handleScroll} data-sandore-timeline>
      <div className={css.timeline}>
        {visibleItems.length === 0 && (
          <p className={css.empty}>{t('run.trajectory.empty')}</p>
        )}
        {visibleItems.map((item, index) => (
          item.kind === 'user'
            ? <UserBubble key={`user-${index}`} content={item.content} />
            : <StepCard key={`${item.stepId}-${index}`} item={item} t={t} openSession={openSession} />
        ))}
      </div>
    </div>
  )
}
