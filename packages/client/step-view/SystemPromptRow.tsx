/**
 * SystemPromptRow（B2a step-view 版）：完整 system prompt 的折叠披露行——折叠态
 * 是带浏览图标的 24px 行，展开体与上下文注入共用 opaque context chrome
 * （141px code-block 滚动视口 + 保留真实换行的模型面文本）。
 *
 * 抄自 DSH 0.1.2-rc.1 `ui-chat/src/client/chat/SystemPromptRow.tsx`（只读参考
 * deepseek-harness）。差异：locale 面收窄为 sandore；data 叶子经
 * stepChatSystemPromptPayloadOf 防御读取（缺失 → 空文本空态行）；body 用本地
 * ContextBody 的 OpaqueBody。
 *
 * rc.1 的 SystemPromptRow 直接复用 ContextInjectionRow.module.css（两披露共一
 * body）；本文件对应 system-prompt.module.css 只抄它实际用到的选择器
 * （.root/.chevron/.body + data-open），保持与 rc.1 同几何。全部令牌化。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/SystemPromptRow
 */
import { memo, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { DisclosureRow, IconBrowseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { OpaqueBody } from './ContextBody.tsx'
import { stepChatSystemPromptPayloadOf } from './step-row-data.ts'
import css from './system-prompt.module.css'

/** Props for one complete system prompt disclosure. */
export interface StepSystemPromptRowProps {
  /** Complete model-visible prompt text. */
  text: string
  /** The owning view's locale seat. */
  t: TranslateNS<'sandore'>
}

/**
 * Render one complete system prompt as a collapsed disclosure whose expanded
 * body is the same opaque context chrome: 141px code-block scrollport and
 * model-facing text with its real line breaks.
 * @param props - Complete prompt text and the locale seat.
 * @returns The system-prompt disclosure row.
 */
export function SystemPromptRow({ text, t }: StepSystemPromptRowProps) {
  const [open, setOpen] = useState(false)
  return (
    <DisclosureRow
      className={css.root}
      icon={<IconBrowseOutline16 size={14} />}
      chevronClassName={css.chevron}
      title={t('message.systemPrompt')}
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => { setOpen(value => !value) }}
    >
      <div className={css.body} data-system-prompt-body>
        <OpaqueBody content={[{ type: 'text', text }]} source={null} t={t} />
      </div>
    </DisclosureRow>
  )
}

/** system-prompt 行的 keyed 渲染器（B2a StepChatViewRow 分发目标）。 */
export const StepChatSystemPromptView = memo(function StepChatSystemPromptView({ data, t }: {
  /** ChatNode.data（live；读取层防御归一，缺失/非字符串 → 空文本空态行）。 */
  data: unknown
  /** 该行的 locale seat。 */
  t: TranslateNS<'sandore'>
}) {
  const { text } = stepChatSystemPromptPayloadOf(data)
  return <SystemPromptRow text={text} t={t} />
})
