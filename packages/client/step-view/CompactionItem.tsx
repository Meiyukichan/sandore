/**
 * CompactionItem（B2b step-view 版）：抄自 DSH 0.1.2-rc.1
 * `ui-chat/src/client/chat/CompactionItem.tsx` + MessageItem.module.css 对应规则
 * （只读参考 deepseek-harness）——自动 compaction 标记行：一行 dim 24px 按钮
 * （context icon 静息、hover/focus 时让位给 chevron disclosure），title + 分隔点 +
 * FILL 截断摘要；仅当窗口包含 checkpoint 引用的 compaction/summary 事件（summary
 * 非 null）才可展开，展开体是 MarkdownText 摘要。
 *
 * 适配：data 面经 stepChatCompactionPayloadOf 防御读取（live 未知叶子）；locale 面
 * 收窄为 sandore 命名空间；markdown labels 复用同层 tool/primitive-labels 构建器。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/CompactionItem
 */
// A compaction marker does not replace shadowed transcript rows. It is
// expandable only when the current window includes its cited summary.

import { memo, useState } from 'react'
import {
  IconApiOutline14,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { StepChatCompactionPayload } from './step-row-data.ts'
import { stepChatCompactionPayloadOf } from './step-row-data.ts'
import { markdownLabels } from './tool/primitive-labels.ts'
import css from './notice-row.module.css'

interface StepCompactionItemProps {
  /** 标记节点（本地断言面）。 */
  node: StepChatCompactionPayload
  /** 手动压缩并入标记时的命令标题。 */
  title?: string
  /** 结构化压缩计数不可用时使用的命令结算文本。 */
  fallbackSummary?: string | null
  /** 该行的 locale seat。 */
  t: TranslateNS<'sandore'>
}

/**
 * 渲染模型历史压缩标记。
 * @param props - 标记节点与 locale seat。
 * @returns 标记行；有摘要披露时含展开体。
 */
export const StepCompactionItem = memo(function StepCompactionItem({
  node,
  title,
  fallbackSummary,
  t,
}: StepCompactionItemProps) {
  const [expanded, setExpanded] = useState(false)
  const expandable = node.summary !== null
  const open = expandable && expanded
  const summary = node.shadowedItemCount !== null && node.shadowedTokenCount !== null
    ? t('message.compaction.completed', {
      items: node.shadowedItemCount,
      tokens: node.shadowedTokenCount,
    })
    : fallbackSummary
      ?? (expandable ? t('message.compaction.expand') : t('message.compaction.unavailable'))
  return (
    <div className={css.compactionRow}>
      <button
        type="button"
        className={css.compactionButton}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => { setExpanded(value => !value) }}
      >
        <span className={css.compactionLeading} aria-hidden>
          <span className={css.compactionContextIcon} data-compaction-icon="context">
            <IconApiOutline14 />
          </span>
          <span
            className={css.compactionDisclosureIcon}
            data-compaction-disclosure={open ? 'expanded' : 'collapsed'}
          >
            {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
        </span>
        <span className={css.compactionTitle}>{title ?? t('message.compaction')}</span>
        <span className={css.compactionSep} aria-hidden />
        <span className={css.compactionSummary}>{summary}</span>
      </button>
      {open && node.summary !== null
        && <div className={css.compactionBody}><MarkdownText text={node.summary} labels={markdownLabels(t)} /></div>}
    </div>
  )
})

/** compaction 行的 keyed 渲染器（B2b StepChatViewRow 分发目标）。 */
export const StepChatCompactionView = memo(function StepChatCompactionView({ data, t }: {
  /** ChatNode.data（live；读取层防御归一，缺失 → 空态标记行，不抛）。 */
  data: unknown
  /** 该行的 locale seat。 */
  t: TranslateNS<'sandore'>
}) {
  const payload = stepChatCompactionPayloadOf(data)
  return <StepCompactionItem node={payload} t={t} />
})
