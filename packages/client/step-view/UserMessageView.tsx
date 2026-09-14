/**
 * UserMessageView（B2a / 需求 2 step-view 版）：user / steering 行的**折叠摘要行**
 * 渲染——标题「用户消息 · <首行摘要>」（超出一行省略），点击展开完整消息。
 *
 * 需求 2（本次变更）：用户消息不再渲染右对齐气泡，而是**与「思考」行一模一样**的
 * 折叠行——同一个 DisclosureRow primitive、同一套 class（行/16px 图标盒/标题/
 * chevron/分隔点/摘要省略/展开缩进全部来自 `reasoning-row.module.css`）、同一条
 * 折叠交互与同一个 24px 折叠高度锁。实现上直接复用
 * `step-view/DisclosureSummaryRow.tsx`（思考行与本行共用的行壳），故两条行的布局
 * class 逐字相同、左边界逐像素齐平（**无右对齐**：本文件与样式表都不含
 * `align-self: flex-end` / `margin-left: auto` / `justify-content: flex-end`）。
 * 差异只有两处（产品要求「换个图标与标题文案」）：leading 图标 IconUserOutline16、
 * 标题 `run.step.chat.user.row`（用户消息）。
 *
 * 摘要策略（与思考行的「首行摘要」同源）：取消息首行文本；单行省略由
 * `.summaryText` 的 `text-overflow: ellipsis` + `white-space: nowrap` 承担。
 *
 * 展开体（点击标题行 / 聚焦后 Enter/Space）承载原气泡里的全部内容与动作：
 * - 图片附件（ImageGallery 兼容通道；align='start' = 左对齐，不再是右对齐气泡）；
 * - 文本经 primitives `projectUserText` 投影（内联 @会话 引用字形）；
 * - 未知内容块保留 JsonBlock 回退（message.extraBlock）；
 * - referenceLabels（紧随召回上下文贴的标签）→「引用会话 · …」摘要行；
 * - 动作行 MessageIconActions（clock=start，时间=消息 time + 复制）。
 *
 * 与 rc.1（`ui-chat/src/client/chat/MessageItem.tsx` 的 UserStyleBubble）的差异：
 * 气泡形态按需求 2 整条替换为折叠行；PendingSteeringBubble/PendingSubmissionBubble
 * （本地未确认提交的镜像气泡）本就不属于 view-node 渲染面，不引入；image attachment
 * 仍走面板既有 ImageGallery/ImageLoader 兼容通道（attachment 未知叶子 cast 到本地
 * SandoreImageAttachmentRef），宿主 image 槽位确认后在此文件单点适配。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/UserMessageView
 */
import { memo } from 'react'
import { IconUserOutline16, JsonBlock, projectUserText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SandoreRenderMessageImages } from '../chat/attachment/MessageImage.tsx'
import type { SandoreImageAttachmentRef } from '../chat/attachment/image-attachment.ts'
import { DisclosureSummaryRow } from './DisclosureSummaryRow.tsx'
import { MessageIconActions } from './MessageIconActions.tsx'
import { stepChatUserPayloadOf, stepContentParts } from './step-row-data.ts'
import css from './user-message.module.css'

/** 折叠摘要取消息首行（与思考行的 settled 摘要策略同源：`firstLine`）。 */
function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/** User and admitted-steering keyed row renderer（B2a StepChatViewRow 分发目标）。 */
export const StepChatUserMessageView = memo(function StepChatUserMessageView({ data, renderMessageImages, t }: {
  /** ChatNode.data（live；读取层防御归一，缺失 → 空态行，不抛）。 */
  data: unknown
  /** 附件渲染器（面板既有 ImageGallery 通道）。 */
  renderMessageImages: SandoreRenderMessageImages
  /** 该行的 locale seat。 */
  t: TranslateNS<'sandore'>
}) {
  const payload = stepChatUserPayloadOf(data)
  const { text, images: contentImages, rest } = stepContentParts(payload.content)
  const labels = payload.referenceLabels ?? []
  const truncated = (total: number): string => t('json.truncated', { total })
  return (
    <DisclosureSummaryRow
      variant="user"
      icon={<IconUserOutline16 size={14} />}
      title={t('run.step.chat.user.row')}
      summary={firstLine(text)}
      body={(
        <>
          {renderMessageImages({
            images: contentImages.map(image => ({
              // B2a：image 槽 occupant 未定案——按面板既有 ImageGallery 的附件面
              // 兼容 cast；宿主 image 槽确认后在此单点适配（见文件头注释）。
              attachment: image.attachment as SandoreImageAttachmentRef,
            })),
            align: 'start',
          })}
          {text !== '' && <div className={css.text}>{projectUserText(text, labels)}</div>}
          {rest.map((block, i) => <JsonBlock key={i} label={t('message.extraBlock')} payload={block} truncatedLabel={truncated} />)}
          {labels.length > 0 && (
            <div className={css.referenceSummary}>
              {t('message.referenceSummary', { labels: labels.join(t('message.referenceSeparator')) })}
            </div>
          )}
          <MessageIconActions text={text} time={payload.time} clock="start" t={t} />
        </>
      )}
      t={t}
    />
  )
})
