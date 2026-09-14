/**
 * ContextInjectionRow（B2a step-view 版）：记录型上下文注入行（Tool calls 披露
 * chrome；展开体随 producer 声明的 form 渲染，form 缺失/未知回退 opaque body）。
 *
 * 抄自 DSH 0.1.2-rc.1 `ui-chat/src/client/chat/ContextInjectionRow.tsx` +
 * `ContextInjectionRow.module.css`（只读参考 deepseek-harness），逐字保留：
 * - 行头：recall role → ReferenceIcon(kind="session") + 「跨会话召回」，其余 →
 *   IconContextInjectionOutline16 + 「上下文注入」；producer label 与 notice
 *   摘要以 2px 圆点分隔挂行头；
 * - body 挂 data-context-injection-body / data-context-form（B4 定位/调试锚）；
 * - 展开体由本地 ContextBody 的 contextBody 选择（渲染的 form 未必是声明的：
 *   字段不可读的声明 form 回退 opaque，行头如实标注）。
 *
 * 差异仅：locale 面收窄为 sandore 命名空间；data 叶子经 step-row-data.ts 的
 * stepChatContextPayloadOf 防御读取（content/source 按 unknown）。新 CSS 全部
 * 令牌化（含 --dsh-content-font-delta 的缩进链与 code-block 滚动视口）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/ContextInjectionRow
 */
import { memo, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  DisclosureRow, IconContextInjectionOutline16, ReferenceIcon,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { contextBody } from './ContextBody.tsx'
import {
  stepChatContextPayloadOf,
  type StepChatContextPayload,
} from './step-row-data.ts'
import css from './context-injection-row.module.css'

/** Props for the logged non-user message presentation. */
export interface StepContextInjectionRowProps {
  content: readonly unknown[]
  source: unknown
  /** Role and producer name projected from the durable source. */
  provenance: StepChatContextPayload['provenance']
  /** Producer-declared information form; null renders the opaque body. */
  form: StepChatContextPayload['form']
  /** The owning view's locale seat, passed down as a plain prop. */
  t: TranslateNS<'sandore'>
}

/**
 * Render logged context with the Tool calls disclosure chrome from Figma.
 *
 * The header names the role the context plays and, beside it, the producer the
 * durable source identifies, so a reader can tell an injected skill catalog
 * from a workspace instruction file or a recalled session without expanding.
 * The expanded body follows the producer-declared form; an absent or unknown
 * form renders the opaque body.
 * @param props - Durable content, its projected producer role/name and form, and the locale seat.
 * @returns A collapsed context row with a bounded, form-specific body.
 */
export function ContextInjectionRow({ content, source, provenance, form, t }: StepContextInjectionRowProps) {
  const [open, setOpen] = useState(false)
  // Resolved rather than declared: a form whose fields are unreadable renders
  // the opaque body, and the marker must say what the row actually shows.
  const { rendered, summary, body } = contextBody(form, { content, source, t })

  return (
    <DisclosureRow
      className={css.root}
      icon={provenance.role === 'recall'
        ? <span data-context-recall-icon><ReferenceIcon kind="session" /></span>
        : <IconContextInjectionOutline16 size={14} />}
      chevronClassName={css.chevron}
      title={t(provenance.role === 'recall' ? 'message.contextRecall' : 'message.contextInjection')}
      collapsedContent={provenance.label === null ? undefined : (
        /* ToolRow's separator shape: an aria-hidden dot, so the accessible name
           stays the two readable parts and the two disclosure rows expose one
           name shape. A source that names no producer drops the dot with it. */
        <>
          <span className={css.sep} aria-hidden />
          <span className={css.source} data-context-source>{provenance.label}</span>
          {summary !== null && (
            <>
              <span className={css.sep} aria-hidden />
              <span className={css.summary} data-context-summary>{summary}</span>
            </>
          )}
        </>
      )}
      keepContentWhenOpen
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => { setOpen(value => !value) }}
    >
      <div className={css.body} data-context-injection-body data-context-form={rendered ?? undefined}>
        {body}
      </div>
    </DisclosureRow>
  )
}

/** context 行的 keyed 渲染器（B2a StepChatViewRow 分发目标）。 */
export const StepChatContextView = memo(function StepChatContextView({ data, t }: {
  /** ChatNode.data（live；读取层防御归一，缺失 → opaque 空态行）。 */
  data: unknown
  /** 该行的 locale seat。 */
  t: TranslateNS<'sandore'>
}) {
  const payload = stepChatContextPayloadOf(data)
  return (
    <ContextInjectionRow
      content={payload.content}
      source={payload.source}
      provenance={payload.provenance}
      form={payload.form}
      t={t}
    />
  )
})
