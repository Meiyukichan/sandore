/**
 * MessageItem：抄自 DSH `packages/client/ui-conversation/src/client/chat/MessageItem.tsx`。
 * 简单聊天节点——用户/consumed-steering 右对齐气泡（时钟 + 复制 + 可选 branch 的
 * IconActions；branch 只在 assistant 回答下）、pending steering（仅复制）、上下文注入、
 * 压缩标记、model-retry 披露、turn-error、turn-max-tokens、未知 surface JSON 行。
 *
 * 适配：props 从内部 `ChatNode`/`ChatViewSlotProps` 收窄为公开节点数据 + sandore 命名
 * 空间 locale；`renderMessageImages` 为 sandore 面板自己的 ImageGallery 渲染器（替代
 * DSH 的 conversation.message.images slot）；`referenceLabels` 由 DSH 的
 * ReferenceLabelProjector（UI 计算）提供，runtime 公开节点不带该字段，面板按
 * `UserMessageNodeView` 的缺省路径传空。其余逻辑逐字保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/chat/MessageItem
 */
// MessageItem: simple chat nodes — user and consumed-steering bubbles
// (right-aligned, with clock + copy IconActions; branch lives only under
// assistant answers), pending steering (copy only), context injection,
// compaction marker, retry disclosure, and unknown-surface JSON rows.

import { memo, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  CompactionSummaryNode, ContextMessageNode, ConversationNode, ModelRetryNode, TurnErrorNode,
  TurnMaxTokensNode, UnknownSurfaceNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import { JsonBlock, MessageText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SandoreRenderMessageImages } from './attachment/MessageImage.tsx'
import { ReferenceIcon } from './reference/ReferenceIcon.tsx'
import { CompactionItem } from './CompactionItem.tsx'
import { ContextInjectionRow } from './ContextInjectionRow.tsx'
import { MessageIconActions } from './MessageIconActions.tsx'
import css from './MessageItem.module.css'

type UserImage = Extract<UserMessageNode['content'][number], { type: 'image' }>

function contentParts(content: readonly unknown[]): {
  text: string
  images: { attachment: UserImage['attachment'] }[]
  rest: unknown[]
} {
  const texts: string[] = []
  const images: { attachment: UserImage['attachment'] }[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string; attachment?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b.type === 'image' && b.attachment !== undefined) {
      images.push({ attachment: (b as UserImage).attachment })
    }
    else rest.push(block)
  }
  return { text: texts.join(''), images, rest }
}

function retrySeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1_000))
}

interface RetryCountdown {
  deadline: number
  seconds: number
}

function ModelRetryItem({ node, active, t }: {
  node: ModelRetryNode
  active: boolean
  t: TranslateNS<'sandore'>
}) {
  // Anchor the host-scheduled delay to this browser's first render of the
  // retry node. Host event time and Date.now() may belong to different clocks.
  const deadline = useMemo(() => Date.now() + node.delayMs, [node.delayMs, node.seq])
  const scheduledSeconds = retrySeconds(node.delayMs)
  const maximum = node.mode === 'normal' ? node.maxRetries : '∞'
  const [countdown, setCountdown] = useState<RetryCountdown>(() => ({
    deadline,
    seconds: retrySeconds(deadline - Date.now()),
  }))
  const remainingSeconds = countdown.deadline === deadline
    ? countdown.seconds
    : retrySeconds(deadline - Date.now())

  useEffect(() => {
    if (!active) return
    const updateCountdown = (): number => {
      const next = retrySeconds(deadline - Date.now())
      setCountdown(current => (
        current.deadline === deadline && current.seconds === next
          ? current
          : { deadline, seconds: next }
      ))
      return next
    }
    if (updateCountdown() === 1) return
    const timer = window.setInterval(() => {
      if (updateCountdown() === 1) window.clearInterval(timer)
    }, 250)
    return () => { window.clearInterval(timer) }
  }, [active, deadline])

  const label = active
    ? t('message.retry.active')
    : node.retryState === 'cancelled'
      ? t('message.retry.cancelled')
      : node.retryState === 'started'
        ? t('message.retry.started')
        : t('message.retry.scheduled')
  const seconds = active ? remainingSeconds : scheduledSeconds

  return (
    <details className={css.retryRow} data-active={active || undefined}>
      <summary className={css.retrySummary}>
        <span className={css.retryText} role="status">
          {t('message.retry.status', { label, retry: node.retry, maximum, seconds })}
        </span>
      </summary>
      <div className={css.retryDetails}>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.delay')}</span>
          {Math.round(node.delayMs)}ms
        </div>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.failure')}</span>
          {node.failure.message}
        </div>
      </div>
    </details>
  )
}

/** Persistent, turn-positioned feedback for a terminal failure. */
function TurnErrorItem({ node, t }: {
  node: TurnErrorNode
  t: TranslateNS<'sandore'>
}) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="error" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.turnErrorTitle}>{t('message.turnError')}</span>
        <span className={css.turnErrorMessage}>{node.message}</span>
      </div>
      {node.code !== undefined && <code className={css.turnErrorCode}>{node.code}</code>}
    </div>
  )
}

/** Persistent, turn-positioned notice for a turn ended at the output-token cap. */
function TurnMaxTokensItem({ t }: {
  t: TranslateNS<'sandore'>
}) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="warning" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.maxTokensTitle}>{t('message.maxTokens')}</span>
        <span className={css.turnErrorMessage}>{t('message.maxTokens.hint')}</span>
      </div>
    </div>
  )
}

/**
 * Display projection of reference forms in a user bubble (free geometry — no
 * textarea alignment constraint here); everything else stays plain text. The
 * logged model text remains the single truth; this is presentation only.
 * Plain-text `/name` / `@name` word-boundary tokens decorate (the sent text
 * IS the reference — the bubble uses the same plainest token
 * scan as the composer, minus the lexicon: sent tokens were validated at
 * compose time, so shape alone decorates).
 */
function projectUserText(text: string, sessionLabels: readonly string[]): ReactNode {
  const ranges: { start: number; end: number; label: string; kind: 'session' | 'plain' }[] = []
  for (const rawLabel of [...new Set(sessionLabels)].sort((a, b) => b.length - a.length)) {
    const label = `@${rawLabel}`
    let start = text.indexOf(label)
    while (start >= 0) {
      ranges.push({ start, end: start + label.length, label, kind: 'session' })
      start = text.indexOf(label, start + label.length)
    }
  }
  const re = /(^|\s)(\/[\w-]+|@"[^"\n]+"|@[^\s]+)/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const tokenStart = m.index + (m[1]?.length ?? 0)
    const rawLabel = m[2] ?? ''
    const label = rawLabel.startsWith('@"')
      ? rawLabel
      : rawLabel.replace(/[.,;:!?，。；：！？]+$/gu, '')
    if (label.length <= 1) continue
    ranges.push({ start: tokenStart, end: tokenStart + label.length, label, kind: 'plain' })
  }
  ranges.sort((a, b) => a.start - b.start
    || (a.kind === b.kind ? b.end - a.end : a.kind === 'session' ? -1 : 1))
  const parts: ReactNode[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start < cursor) continue
    const { start: tokenStart, end, label, kind } = range
    if (tokenStart > cursor) parts.push(<MessageText key={cursor} text={text.slice(cursor, tokenStart)} />)
    const referenceKind = kind === 'session'
      ? 'session'
      : label.startsWith('@')
        ? label.endsWith('/') ? 'folder' : 'file'
        : undefined
    const displayLabel = referenceKind === undefined
      ? label
      : referenceKind === 'session'
        ? label.slice(1)
        : label.slice(1).replace(/^"|"$/gu, '').split(/[\\/]/u).filter(Boolean).at(-1) ?? label.slice(1)
    parts.push(
      <span
        key={tokenStart}
        className={css.refChip}
        data-ref-chip={referenceKind ?? 'skill'}
        title={label}
      >
        {referenceKind !== undefined && (
          <ReferenceIcon kind={referenceKind} size={16} className={css.refIcon} />
        )}
        {displayLabel}
      </span>,
    )
    cursor = end
  }
  if (parts.length === 0) return <MessageText text={text} />
  if (cursor < text.length) parts.push(<MessageText key={cursor} text={text.slice(cursor)} />)
  return <>{parts}</>
}

/** Right-aligned bubble shared by user and steering rows. */
function UserStyleBubble({
  content, renderMessageImages, actions, pending = false, referenceLabels = [], t,
}: {
  content: readonly unknown[]
  renderMessageImages: SandoreRenderMessageImages
  /** Optional IconActions (or similar) below the bubble; receives the joined text. */
  actions?: (text: string) => ReactNode
  /** Whether this is the Host-authoritative pre-admission steering projection. */
  pending?: boolean
  /** Exact session mention labels associated by the adjacent recall node. */
  referenceLabels?: readonly string[]
  t: TranslateNS<'sandore'>
}): ReactNode {
  const { text, images, rest } = contentParts(content)
  const truncated = (total: number): string => t('json.truncated', { total })
  const showBubble = text !== '' || rest.length > 0
  return (
    <div className={css.userRow} data-pending-steering={pending || undefined} data-time-hover-root>
      <div className={css.userStack}>
        {renderMessageImages({ images, align: 'end' })}
        {showBubble && <div className={css.bubble}>
          {projectUserText(text, referenceLabels)}
          {rest.map((block, i) => <JsonBlock key={i} label={t('message.extraBlock')} payload={block} truncatedLabel={truncated} />)}
        </div>}
        {referenceLabels.length > 0 && (
          <div className={css.referenceSummary}>
            {t('message.referenceSummary', { labels: referenceLabels.join(t('message.referenceSeparator')) })}
          </div>
        )}
      </div>
      {actions?.(text)}
    </div>
  )
}

/**
 * Render one Host-authoritative pending steering item with the same visual
 * language as its eventual durable transcript node.
 * @param props - Pending message content and translator.
 * @returns the pending steering bubble.
 */
export function PendingSteeringBubble({ content, renderMessageImages, t }: {
  content: readonly unknown[]
  renderMessageImages: SandoreRenderMessageImages
  t: TranslateNS<'sandore'>
}): ReactNode {
  return (
    <UserStyleBubble
      content={content}
      renderMessageImages={renderMessageImages}
      pending
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          clock="start"
          className={css.actions}
          t={t}
        />
      )}
    />
  )
}

/** User and admitted-steering 节点 → 右对齐气泡（公开 `UserMessageNode`/`SteeringMessageNode` 数据）。 */
export const UserMessageNodeView = memo(function UserMessageNodeView({ node, renderMessageImages, t }: {
  node: Extract<ConversationNode, { kind: 'user' | 'steering' }>
  renderMessageImages: SandoreRenderMessageImages
  t: TranslateNS<'sandore'>
}) {
  const data = node
  return (
    <UserStyleBubble
      content={data.content}
      renderMessageImages={renderMessageImages}
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          time={data.time}
          clock="start"
          className={css.actions}
          t={t}
        />
      )}
    />
  )
})

/** Injected-context 节点 → 上下文注入行（公开 `ContextMessageNode` 数据）。 */
export const ContextMessageNodeView = memo(function ContextMessageNodeView({ node, t }: {
  node: ContextMessageNode
  t: TranslateNS<'sandore'>
}) {
  const data = node
  return (
    <ContextInjectionRow
      content={data.content}
      source={data.source}
      provenance={data.provenance}
      form={data.form}
      t={t}
    />
  )
})

/** Automatic compaction 节点 → 压缩标记行（公开 `CompactionSummaryNode` 数据）。 */
export const CompactionNodeView = memo(function CompactionNodeView({ node, t }: {
  node: CompactionSummaryNode
  t: TranslateNS<'sandore'>
}) {
  return <CompactionItem node={node} t={t} />
})

/** model-retry 节点 → 重试披露（公开 `ModelRetryNode` 数据）。 */
export const RetryNodeView = memo(function RetryNodeView({ node, t }: {
  node: ModelRetryNode
  t: TranslateNS<'sandore'>
}) {
  const data = node
  return <ModelRetryItem node={data} active={data.retryState === 'scheduled'} t={t} />
})

/** Terminal turn-error 节点 → 持久失败提示（公开 `TurnErrorNode` 数据）。 */
export const TurnErrorNodeView = memo(function TurnErrorNodeView({ node, t }: {
  node: TurnErrorNode
  t: TranslateNS<'sandore'>
}) {
  return <TurnErrorItem node={node} t={t} />
})

/** Max-tokens turn-end notice 节点 → 输出上限提示。 */
export const TurnMaxTokensNodeView = memo(function TurnMaxTokensNodeView({ t }: {
  t: TranslateNS<'sandore'>
}) {
  return <TurnMaxTokensItem t={t} />
})

/** Explicit unknown-surface 节点 → JSON 行（公开 `UnknownSurfaceNode` 数据）。 */
export const UnknownNodeView = memo(function UnknownNodeView({ node, t }: {
  node: UnknownSurfaceNode
  t: TranslateNS<'sandore'>
}) {
  const data = node
  return (
    <div className={css.contextRow}>
      <JsonBlock
        label={t('message.unknownSurface', { type: data.type })}
        payload={data.data}
        truncatedLabel={total => t('json.truncated', { total })}
      />
    </div>
  )
})
