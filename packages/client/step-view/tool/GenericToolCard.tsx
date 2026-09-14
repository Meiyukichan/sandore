/**
 * GenericToolCard（B2b step-view 版）：抄自 DSH 0.1.2-rc.1
 * `ui-tool/src/client/tool/toolviews/GenericToolCard.tsx`（只读参考 deepseek-harness）。
 * 默认工具行——把工具分类为视觉 variant 并渲染摘要行。rc.1 中它是
 * `tool.call.toolview` keyed slot 的 render-site fallback（未注册 tool 名落在此处）；
 * sandore 面板不注册任何 atomic toolview → 所有工具行都走本卡（与 rc.1 对未注册
 * 工具的行为一致）。
 *
 * 适配：block 面为本地断言；locale 面收窄为 sandore；`inspect`/`home` 两个
 * affordance 在面板无 trajectory/详情抽屉与 host description 时省略（等价于 rc.1
 * 未注入时）；openFile/cwd 可选。卡片材质派生（terminal/read/diff/search/web）+
 * state/summary 覆盖逐字保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/tool/GenericToolCard
 */
// GenericToolCard: the default tool row — classifies the tool into a visual
// variant and renders the summary row. Supplied by the Tool call tree as the
// keyed atomic-view slot's render-site fallback (an unregistered tool name
// lands here); registrants may also compose it as a base, feeding the same
// owner payload through.

import type { ReactNode } from 'react'
import {
  IconApiOutline14, IconBrowseOutline16, IconCodeOutline16, IconEditOutline16, IconSearchOutline16, IconSparkle16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { StepToolCallBlock } from '../step-row-data.ts'
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

/** Card props：owner payload 加渲染位的 locale seat（plain prop）。 */
export interface GenericToolCardProps {
  /** Wire tool 名（dispatch 供给；窗口截断的 result 也存活）。 */
  toolName: string
  /** RunningToolCall 或 ToolResultNode（本地断言面）。 */
  block: StepToolCallBlock
  /** 会话工作区根；工作区根路径摘要相对其显示。 */
  cwd?: string | undefined
  /** Host account home；遗留 POSIX home 路径显示为 `~`。 */
  home?: string | undefined
  /** 用宿主默认应用打开路径（已 cwd 解析）。 */
  openFile?: ((path: string) => void) | undefined
  t: TranslateNS<'sandore'>
}

export function GenericToolCard({ toolName, block, cwd, home, openFile, t }: GenericToolCardProps) {
  const model = toolRowModel(toolName, block, cwd, home)
  const terminal = terminalCardModel(block, cwd)
  const read = readCardModel(block, cwd, home)
  const diff = diffCardModel(block)
  const search = searchCardModel(block)
  const web = webCardModel(block)
  // 失败退出状态是 terminal 卡自己的错误信号（call 本身以 isError:false 结算），
  // 以行的红色状态点呈现。
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
      title={t(model.titleKey)}
      summary={model.summary}
      // 单文件工具不暴露 args body——路径链接是唯一 args 交互。卡不是 args body：
      // read/write/edit 行单文件且携带卡，卡在路径链接下展开。
      bodyRaw={singleFile ? null : model.bodyRaw}
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
    />
  )
}
