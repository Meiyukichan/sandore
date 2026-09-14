/**
 * DisclosureSummaryRow（需求 2）：step-view 的**折叠摘要行**公共壳——「思考」行
 * （ReasoningRow）与「用户消息」行（UserMessageView）共用同一份渲染与样式。
 *
 * 为什么抽出来（而不是各写一份）：产品要求「用户消息 · xxx」与思考行**渲染一模一样**
 * ——同一个 DisclosureRow primitive、同一套 class（行/leading 图标盒/标题/chevron/
 * 分隔点/摘要省略/展开缩进全部取 `reasoning-row.module.css`）、同一个折叠交互
 * （`expandOnRowClick` + `aria-expanded` + `data-expanded` 驱动 24px 折叠守卫）。
 * 两处各抄一份 CSS 必然漂移，故样式表**共享同一 CSS module 文件**：class 字符串在
 * 两条行上逐字相同（jsdom 单测即以「两条行的 class 集合相等」为证据）。
 *
 * 视觉来源（只读参考 deepseek-harness）：DSH 0.1.2-rc.1
 * `ui-chat/src/client/chat/ReasoningRow.tsx` + `ReasoningRow.module.css`；
 * 本组件只是把该形状参数化成「图标 + 标题 + 折叠摘要 + 展开体」。
 *
 * 折叠语义（与思考行一致）：
 * - 折叠：`[data-disclosure-row]` 单行（24px + 字号 delta），左侧 16px 图标盒
 *   （hover 换成 chevron）+ 标题 + 2px 分隔点 + 单行省略摘要
 *   （`.summaryText` 的 `text-overflow: ellipsis` + `white-space: nowrap`）；
 * - 展开：`data-expanded` 解除 `contain: size layout` 高度锁，展开体
 *   （`.thinkBody`）缩进出现在标题行下方——**左侧列与折叠行齐平**（无右对齐、
 *   无 margin/反向 padding），用户消息行因此与思考行左边界逐像素一致。
 *
 * 左对齐是硬要求（用户追加条款）：本组件与样式表**不含任何**把内容推向右侧的写法
 * （`align-self` / `align-items` / `justify-content` 的 flex-end 取值、`margin-left`
 * 的 auto、`text-align` 的 right、右推 padding 等一概没有）；两条行都从列内容盒左缘
 * 起排，逐像素齐平。jsdom 单测以「两条行各节点 class 逐字相同 + 源码不含右对齐写法」
 * 为证据，真机 e2e 以 boundingBox 的左边界相等为证据。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/DisclosureSummaryRow
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import a11yCss from './accessibility.module.css'
import css from './reasoning-row.module.css'

/** 折叠行变体（`data-variant` 锚点；视觉同源，仅图标与标题文案不同）。 */
export type DisclosureSummaryVariant = 'think' | 'user'

/** DisclosureSummaryRow 的 props（受控数据 + 视觉槽位）。 */
export interface DisclosureSummaryRowProps {
  /** 行变体（data-variant；think = 思考行，user = 用户消息行）。 */
  readonly variant: DisclosureSummaryVariant
  /** leading 图标（与其 16px 图标盒；折叠/展开的 chevron 由 primitive 自理）。 */
  readonly icon: ReactNode
  /** 标题文案（已本地化；思考行「思考」/ 用户行「用户消息」）。 */
  readonly title: string
  /** 折叠态单行摘要（超出一行省略；调用方给首行/末行文本）。 */
  readonly summary: string
  /** 运行中（呼吸灯 sweep + 隐藏的「运行中」无障碍标记；用户行恒 false）。 */
  readonly running?: boolean | undefined
  /** 摘要尾随对齐（思考行流式态用；用户行恒 false = 首部省略）。 */
  readonly followEnd?: boolean | undefined
  /** 展开体（完整内容；缩进样式与思考行同一 `.thinkBody`）。 */
  readonly body: ReactNode
  readonly t: TranslateNS<'sandore'>
}

/**
 * 渲染一条可折叠摘要行（折叠 = 图标 + 标题 + 分隔点 + 省略摘要；展开 = 展开体）。
 * @param props - 见 {@link DisclosureSummaryRowProps}。
 * @returns 折叠行的元素树。
 */
export function DisclosureSummaryRow({
  variant, icon, title, summary, running = false, followEnd = false, body, t,
}: DisclosureSummaryRowProps) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div
      className={css.root}
      data-variant={variant}
      data-state={running ? 'running' : 'ok'}
      data-expanded={expanded || undefined}
    >
      {running && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={icon}
        title={title}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={(
          <>
            <span className={css.separator} aria-hidden />
            <span className={css.summary} data-follow-end={followEnd || undefined}>
              <span className={css.summaryText}>{summary}</span>
            </span>
          </>
        )}
      >
        <div className={css.thinkBody}>{body}</div>
      </DisclosureRow>
    </div>
  )
}
