/**
 * UserMessageRow：sandore 面板的用户消息行式渲染（非 DSH 抄入——DSH 的用户消息是右侧气泡，
 * 面板按「左侧行式」需求实现，视觉对齐 ToolRow / ContextInjectionRow 的 DisclosureRow
 * chrome：16px leading 槽（用户图标，hover/展开变 chevron）+ "User Message" 标签 + 分隔点 +
 * 单行省略摘要 + 尾部时钟；整行点击（Enter/Space）展开完整用户消息文本框）。
 *
 * 数据面：`UserMessageNode` / `SteeringMessageNode`（公开 `ConversationNode`，二者同走
 * 用户行渲染）——`content: ContentBlock[]` 提取纯文本（text 块以换行拼接）作单行摘要
 * （CSS 单行省略，换行被折叠）；展开体显示完整文本（pre-wrap 保留换行）+ 图片画廊
 * （align start，与左对齐行式一致）+ 其余块经 JsonBlock 披露（与右气泡的 extra block 同款）。
 * 展开态为组件本地 view state。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/chat/UserMessageRow
 */
import { memo, useState } from 'react'
import type { ConversationNode } from '@deepseek-ai/dsh-client-runtime/client'
import { DisclosureRow, IconUserOutline16, JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SandoreRenderMessageImages } from './attachment/MessageImage.tsx'
import { formatMessageClock } from './message-chrome.ts'
import css from './UserMessageRow.module.css'

type UserNode = Extract<ConversationNode, { kind: 'user' | 'steering' }>
type UserImage = Extract<UserNode['content'][number], { type: 'image' }>

/** 内容块拆分：text 纯文本拼接 / image 附件（供画廊）/ 其余块（JsonBlock 披露）。 */
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
  // 多 text 块以换行拼接：单行摘要由 CSS `white-space: nowrap` 折叠换行，展开体 pre-wrap 保留分段。
  return { text: texts.join('\n'), images, rest }
}

/**
 * 用户消息行：DisclosureRow 行式（左对齐）——用户图标 + "User Message" 标签 + 分隔点 +
 * 单行省略的用户消息文本 + 尾部时钟；点击整行展开完整用户消息文本框。
 * @param props - 用户/steering 节点、图片画廊渲染器与 locale。
 * @returns 折叠为单行的用户消息披露行。
 */
export const UserMessageRow = memo(function UserMessageRow({ node, renderMessageImages, t }: {
  node: UserNode
  renderMessageImages: SandoreRenderMessageImages
  t: TranslateNS<'sandore'>
}) {
  const [expanded, setExpanded] = useState(false)
  const { text, images, rest } = contentParts(node.content)
  const truncated = (total: number): string => t('json.truncated', { total })
  // 空消息（无文本/图片/其他块）只有标题，不可展开。
  const expandable = text !== '' || images.length > 0 || rest.length > 0
  return (
    <DisclosureRow
      className={css.root}
      chevronClassName={css.chevron}
      icon={<IconUserOutline16 size={16} />}
      title={t('message.userMessage')}
      open={expanded}
      expandable={expandable}
      expandOnRowClick
      onToggle={() => { setExpanded(value => !value) }}
      collapsedContent={text !== '' && (
        /* ToolRow / ContextInjectionRow 的摘要形态：分隔点 + 单行省略文本；时钟 flex:none
           排在摘要之后，窄行先截摘要再截时钟（summarySuffix 同款语义）。 */
        <>
          <span className={css.sep} aria-hidden />
          <span className={css.summary} data-user-summary>{text}</span>
          <span className={css.clock} data-user-clock>{formatMessageClock(node.time, t)}</span>
        </>
      )}
    >
      {/* 展开体（DisclosureRow children）：完整用户消息内容——图片画廊 + 完整文本 + 其余块。 */}
      <div className={css.body} data-user-message-body>
        {images.length > 0 && renderMessageImages({ images, align: 'start' })}
        {text !== '' && <div className={css.bodyText} data-user-body-text>{text}</div>}
        {rest.map((block, i) => (
          <JsonBlock key={i} label={t('message.extraBlock')} payload={block} truncatedLabel={truncated} />
        ))}
      </div>
    </DisclosureRow>
  )
})
