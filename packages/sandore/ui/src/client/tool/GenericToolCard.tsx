/**
 * GenericToolCard：抄自 DSH `packages/client/ui-tool/src/client/tool/toolviews/GenericToolCard.tsx`。
 * 默认工具行——把工具分类为视觉 variant 并渲染摘要行（DSH tool.call.toolview slot 的
 * render-site fallback；未注册工具名落在此处）。内嵌面板不注册任何工具视图，故所有
 * 工具都走通用卡片（与 DSH 对未注册工具的行为一致）。
 * 适配：`openFile`/`inspect` 为可选 props（面板无 trajectory 视图时传 undefined，等价于
 * DSH 未注入时无该 affordance）；`cwd`/`home` 可选（home 由 host description 提供，
 * 面板不读取时省略，等价于 DSH 无 host description）。locale 面收窄为 sandore 命名空间。
 * 卡片材质派生（terminal/read/diff/search/web）+ state/summary 覆盖逐字保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/tool/GenericToolCard
 */
// GenericToolCard: the default tool row — classifies the tool into a visual
// variant and renders the summary row. Supplied by the Tool call tree as the
// keyed atomic-view slot's render-site fallback (an
// unregistered tool name lands here); registrants may also compose it as a
// base, feeding the same owner payload through.

import type { ReactNode } from 'react'
import {
  IconApiOutline14, IconBrowseOutline16, IconCodeOutline16, IconEditOutline16, IconSearchOutline16, IconSparkle16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { readCardModel } from './read-card-model.ts'
import { diffCardModel } from './diff-card-model.ts'
import { searchCardModel } from './search-card-model.ts'
import { terminalCardModel, terminalFailed } from './terminal-card-model.ts'
import { webCardModel } from './web-card-model.ts'
import { toolRowModel, type ToolRowVariant } from './tool-call-model.ts'
import { ToolRow } from './ToolRow.tsx'

/** Variant leading icons (figma table); all glyphs render at 14 inside the 16px leading box. */
const VARIANT_ICONS: Record<ToolRowVariant, ReactNode> = {
  search: <IconSearchOutline16 size={14} />,
  read: <IconBrowseOutline16 size={14} />,
  bash: <IconApiOutline14 size={14} />,
  write: <IconEditOutline16 size={14} />,
  edit: <IconEditOutline16 size={14} />,
  code: <IconCodeOutline16 size={14} />,
  others: <IconSparkle16 size={14} />,
}

/** Card props: the tool lifecycle block plus the render site's locale seat. */
export interface GenericToolCardProps {
  toolName: string
  block: ToolCallBlock
  /** Session workspace root; workspace-rooted path summaries display relative to it. */
  cwd?: string | undefined
  /** Host account home; a leftover POSIX home path displays as `~`. */
  home?: string | undefined
  /** Open a filesystem path through the Host (already cwd-resolved). */
  openFile?: ((path: string) => void) | undefined
  /** Jump to this call in the trajectory view. */
  inspect?: (() => void) | undefined
  t: TranslateNS<'sandore'>
}

export function GenericToolCard({ toolName, block, cwd, home, openFile, inspect, t }: GenericToolCardProps) {
  const model = toolRowModel(toolName, block, cwd, home)
  const terminal = terminalCardModel(block, cwd)
  const read = readCardModel(block, cwd, home)
  const diff = diffCardModel(block)
  const search = searchCardModel(block)
  const web = webCardModel(block)
  // A failing exit status is the terminal card's own error signal (the call
  // itself settles isError:false), surfaced as the row's red state dot.
  const state = model.state === 'ok' && terminal !== null && terminalFailed(terminal)
    ? 'error'
    : model.state
  const singleFile = model.filePath !== undefined
  return (
    <ToolRow
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={VARIANT_ICONS[model.variant]}
      title={model.title}
      // A terminal presenter's description is the contract's above-card text, so
      // it outranks the args-derived summary here exactly as it does in BashRow;
      // a search result view's replacement title outranks it the same way.
      summary={terminal?.description ?? search?.title ?? model.summary}
      // Single-file tools never expose an args body — the path link is the only
      // args interaction. A card is not an args body: a read/write/edit row is
      // single-file AND carries a card, so the card expands under the path link.
      body={singleFile ? null : model.body}
      output={model.output}
      errorSummary={model.errorSummary}
      terminal={terminal}
      diff={diff}
      read={read}
      search={search}
      web={web}
      state={state}
      filePath={model.filePath}
      onOpenFile={singleFile ? openFile : undefined}
      inspect={inspect}
    />
  )
}
