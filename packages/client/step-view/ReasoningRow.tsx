/**
 * ReasoningRow（B2a step-view 版）：assistant reasoning 披露行（Think 摘要行，
 * 展开=缩进灰字），独立于工具卡片呈现。
 *
 * 抄自 DSH 0.1.2-rc.1 `ui-chat/src/client/chat/ReasoningRow.tsx`（只读参考
 * deepseek-harness）：
 * - 视觉/交互 1:1（DisclosureRow + data-variant/data-state/data-expanded；
 *   running 态呼吸灯 sweep 动画；折叠行 contain:size layout 锁 24px 高度）；
 * - 逐字保留「折叠摘要」行为：settled 显示首行、running 显示最新一行；rc.1 的
 *   摘要尾随对齐（data-follow-end）保留，DSH 旧版的 JS 滚动条自动滚动不再需要
 *   （rc.1 已删除），本文件同样不引入；
 * - 差异仅 locale 面收窄为 sandore 命名空间（t: TranslateNS<'sandore'>）。
 *
 * 需求 2 起，「思考」行的**行壳**抽到 step-view/DisclosureSummaryRow.tsx（图标 +
 * 标题 + 折叠摘要 + 展开体），与「用户消息」行共用同一份实现与同一 CSS module
 * ——本文件只提供思考行特有的两件事：Think 图标与「首行/末行」摘要策略。
 *
 * 新 CSS 全部引用 --dsh-content-font-size* / --dsw-alias-* / --dsw-specific-*
 * 令牌（深浅色/字号随 body 全局变量），不写死颜色字号；见文件头注释约定。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/ReasoningRow
 */
import { IconThinkOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { DisclosureSummaryRow } from './DisclosureSummaryRow.tsx'

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

/**
 * Render one assistant reasoning block as the Think disclosure row.
 * @param props.text - complete or streaming reasoning text.
 * @param props.running - whether this block is the streaming tail.
 * @param props.t - sandore locale seat for the running status.
 * @returns the reasoning disclosure.
 */
export function ReasoningRow({ text, running, t }: {
  text: string
  running: boolean
  t: TranslateNS<'sandore'>
}) {
  const summary = running ? latestLine(text) : firstLine(text)

  return (
    <DisclosureSummaryRow
      variant="think"
      icon={<IconThinkOutline14 size={14} />}
      title={t('message.think')}
      summary={summary}
      running={running}
      followEnd={running}
      body={text}
      t={t}
    />
  )
}
