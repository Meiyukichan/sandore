/**
 * AssistantMarkdown（B2a step-view 版）：assistant-step 行的正文渲染——按序渲染
 * assistant 块：markdown 文本正文、reasoning → Think 摘要行（展开=缩进灰字）、
 * image 块经附件渲染器（连续 image 块共用一个 gallery）、other 块 JSON 回退；
 * tool-call 头**不**在此渲染（rc.1 ChatView 把它们分组为工具行；assistant-step
 * 行只画非工具正文壳）。
 *
 * 抄自 DSH 0.1.2-rc.1 `ui-chat/src/client/chat/AssistantMarkdown.tsx` +
 * `AssistantMarkdown.module.css`（只读参考 deepseek-harness）：
 * - 视觉/空态语义 1:1：`hasVisible = streaming || interrupted || 存在非 tool-call
 *   块` 决定是否画壳（纯函数 stepAssistantMarkdownHasShell 见 step-row-data.ts）；
 *   流式尾块 reasoning 打 running 标记；interrupted 显示「已停止」标记
 *   （message.stopped）。
 * - 与 rc.1 的差异（全部显式折衷，B2a 范围）：
 *   1) ~~Turn-process 内联折叠~~ B3 已接入：reasoning 块包 ProcessReasoning
 *      （data-turn-process-inline + searchable hidden），reasoningHidden /
 *      revealProcess 由行壳按轮次级折叠态注入（rc.1 AssistantNodeView 语义）；
 *   2) `mentions`（markdown 文件提及解析）不接（宿主无 chatFileMentions 服务，
 *      等同 rc.1 无该服务时的惰性渲染）；
 *   3) locale 面收窄为 sandore 命名空间；markdown chrome 文案复用
 *      step-view/tool/primitive-labels.ts 构建器。
 * - CSS：新写 assistant-markdown.module.css，全部引用令牌；rc.1 的
 *   `.body :global(.md-table-wide)` 宽表格越界规则未抄——面板滚动容器不是
 *   inline-size query container（无 container-type），100cqw 语义在此不成立，
 *   宽表格留在列内滚动（MarkdownText 自带 .tableScroll 上限），B4 如需越界
 *   表格可给 .stepChatScroll 补 container-type 后按 rc.1 规则单点加回。
 *
 * 注：图片 attachment 的 occupant（宿主 MessageImageSource）在 B2a 尚未定案，
 * 现按面板既有 ImageGallery/ImageLoader 兼容通道直传（见 StepChatPanel 的
 * renderMessageImages）；若宿主 image 槽位确认后不兼容，改此文件单点适配。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/AssistantMarkdown
 */
import { Fragment, memo, useMemo } from 'react'
import type { ReactNode } from 'react'
import { JsonBlock, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { markdownLabels } from './tool/primitive-labels.ts'
import type { SandoreRenderMessageImages } from '../chat/attachment/MessageImage.tsx'
import type { SandoreImageAttachmentRef } from '../chat/attachment/image-attachment.ts'
import { ReasoningRow } from './ReasoningRow.tsx'
import { useSearchableHidden } from './searchable-hidden.ts'
import {
  stepAssistantMarkdownHasShell,
  type StepAssistantBlock,
} from './step-row-data.ts'
import css from './assistant-markdown.module.css'

export interface StepAssistantMarkdownProps {
  blocks: readonly StepAssistantBlock[]
  streaming: boolean
  /** Frozen partial of an aborted turn: rendered with a stopped marker. */
  interrupted?: boolean | undefined
  /** Render consecutive image blocks through the attachment renderer. */
  renderMessageImages: SandoreRenderMessageImages
  /** Hide reasoning that belongs to the Turn-level process disclosure (B3). */
  reasoningHidden?: boolean | undefined
  /** Reveal the owning Turn-level process disclosure (B3). */
  revealProcess?: (() => void) | undefined
  /** The owning view's locale seat, passed down as a plain prop. */
  t: TranslateNS<'sandore'>
}

/**
 * Reasoning block as the Think variant summary row (figma 39:28304)。
 * @param props - assistant blocks + streaming + 附件渲染器 + locale。
 * @returns 渲染后的助手消息体（tool-call 块由外层分组渲染，此处跳过）。
 */
export const AssistantMarkdown = memo(function AssistantMarkdown({
  blocks, streaming, interrupted, renderMessageImages,
  reasoningHidden = false, revealProcess, t,
}: StepAssistantMarkdownProps) {
  // Stable per locale revision (t identity changes on switch): a fresh object
  // per render would rebuild MarkdownText's component table every chunk.
  const labels = useMemo(() => markdownLabels(t), [t])
  const last = blocks.length - 1
  // Tool-call heads render as tool rows in the chat view's grouping pass, so
  // a node that is only those heads (or empty) would paint an empty root
  // between tool groups — skip the shell unless something visible remains.
  const hasVisible = stepAssistantMarkdownHasShell(
    blocks,
    streaming,
    interrupted === true,
  )
  if (!hasVisible) return null
  const rendered: ReactNode[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    // 读取层已过滤空位；noUncheckedIndexedAccess 下运行时防御同 rc.1 旧版空位跳过。
    if (block === undefined) continue
    switch (block.kind) {
      case 'text':
        rendered.push(
          <MarkdownText
            key={i}
            text={block.text}
            streaming={streaming}
            labels={labels}
          />,
        )
        break
      case 'reasoning':
        rendered.push(
          <ProcessReasoning
            key={i}
            hidden={reasoningHidden}
            reveal={revealProcess}
          >
            <ReasoningRow
              text={block.text}
              running={streaming && i === last}
              t={t}
            />
          </ProcessReasoning>,
        )
        break
      case 'image': {
        // Consecutive image blocks share one gallery so several images tile
        // into rows instead of each opening a one-image group of its own.
        // Keyed by the group's FIRST block index: a streaming append that
        // extends the group then only grows `images` instead of remounting
        // the gallery under a shifted key.
        const start = i
        const group = [block]
        while (i + 1 < blocks.length) {
          const next = blocks[i + 1]
          if (next === undefined || next.kind !== 'image') break
          group.push(next)
          i += 1
        }
        rendered.push(
          <Fragment key={start}>
            {renderMessageImages({
              images: group.map(({ attachment }) => ({
                // B2a：image 槽 occupant 未定案——按面板既有 ImageGallery 的附件面
                // 兼容 cast；宿主 image 槽确认后在此单点适配（见文件头注释）。
                attachment: attachment as SandoreImageAttachmentRef,
              })),
              align: 'start',
            })}
          </Fragment>,
        )
        break
      }
      // Grouped into tool rows by ChatView; hasVisible above skips an empty shell.
      case 'tool-call':
        break
      case 'other':
        rendered.push(
          <JsonBlock
            key={i}
            label={t('message.unknownBlock')}
            payload={block.block}
            truncatedLabel={total => t('json.truncated', { total })}
          />,
        )
        break
    }
  }
  return (
    <div className={css.root} data-streaming={streaming || undefined}>
      <div className={css.body}>
        {rendered}
        {interrupted && <span className={css.stopped}>{t('message.stopped')}</span>}
      </div>
    </div>
  )
})

/**
 * ProcessReasoning（rc.1 同款）：把归属 turn 进程披露的推理块包进 searchable
 * hidden 子树——折叠时推理行整体隐藏（data-turn-process-inline），浏览器 find
 * 命中 / 展开回调经 beforematch 揭示（reveal = 打开轮次级进程披露）。
 */
function ProcessReasoning({ hidden, reveal, children }: {
  hidden: boolean
  reveal?: (() => void) | undefined
  children: ReactNode
}) {
  const ref = useSearchableHidden(hidden, reveal ?? NOOP)
  return <div ref={ref} data-turn-process-inline={hidden || undefined}>{children}</div>
}

const NOOP = (): void => {}
