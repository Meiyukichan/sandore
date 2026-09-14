/**
 * ToolRow（B2b step-view 版）：抄自 DSH 0.1.2-rc.1
 * `ui-tool/src/client/tool/components/ToolRow.tsx`（只读参考 deepseek-harness）。
 * 工具摘要行（figma 122:9479）——16px leading 槽（状态点/工具图标，hover/展开变
 * chevron）+ 标题 + 分隔点 + FILL 截断摘要，经共享 DisclosureRow chrome，整行作为
 * 展开开关。运行 sweep、错误红字、IN/OUT 槽标签卡、terminal/diff/read/search/web
 * 卡材质逐字保留。
 *
 * 显式裁剪（报告列明）：
 * - `askQuestion`（AskQuestion 转写卡）——只由 keyed atomic toolview 供给，面板
 *   无 occupant、fallback 恒不产生 → prop/分支/import 一并去掉；
 * - `inspect`（轨迹跳转 pill + IconInspectOutline12）——面板无 trajectory 详情
 *   抽屉，动作槽降级（rc.1 中 inspect=undefined 时同样无 affordance）；
 * - clsx 替换为本地 `cx`（sandore 不声明 clsx 依赖）。
 * locale 面收窄为 sandore 命名空间（row.input/row.output 键已抄进 sandore 字典）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/tool/ToolRow
 */
import { useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import {
  CodeBlock, DiffBlock, DisclosureRow, ReadBlock, SearchBlock, StateDot, TerminalBlock, WebBlock,
  diffTotals,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CHAT_DIFF_MAX_LINES, type DiffCardModel } from './diff-card-model.ts'
import { CHAT_READ_MAX_LINES, type ReadCardModel } from './read-card-model.ts'
import { CHAT_SEARCH_MAX_LINES, type SearchCardModel } from './search-card-model.ts'
import { localizeTerminalCardModel, terminalBlockLabels, type TerminalCardModel } from './terminal-card-model.ts'
import { diffBlockLabels, readBlockLabels, searchBlockLabels, webBlockLabels } from './primitive-labels.ts'
import type { ToolRowState, ToolRowVariant } from './tool-call-model.ts'
import { formatToolBody } from './tool-call-model.ts'
import type { WebCardModelProps } from './web-card-model.ts'
import css from './tool-row.module.css'

/** clsx 本地等价（sandore 不声明 clsx 依赖）：拼接条件类名。 */
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ')
}

export interface ToolRowProps {
  /** The render site's locale seat（terminal/code body copy）。 */
  t: TranslateNS<'sandore'>
  variant: ToolRowVariant
  /** Wire tool 名：tool 自有样式叠加在通用 variant 上。 */
  toolName?: string | undefined
  /** Leading 槽字形。 */
  icon: ReactNode
  title: string
  summary: string
  /**
   * 摘要尾部片段——绘制在省略摘要文本之外，窄行先截摘要、此片段最后存活。
   * null/absent = 摘要是整个折叠内容。error 行丢弃（其折叠摘要是失败行）。
   */
  summarySuffix?: string | null | undefined
  /** 原始参数 JSON——仅在行展开时格式化。null = 无输入节。 */
  bodyRaw?: string | null | undefined
  /** 展开 Output 节的扁平结果文本；null/absent = 无输出节。 */
  output?: string | null | undefined
  /** error 行折叠摘要 = 失败首行；null/absent = 保留 `summary`。 */
  errorSummary?: string | null | undefined
  /**
   * Terminal 卡材质（terminalCardModel 派生）；在场时替换文本节。一张 call 至多
   * 携带一种卡 kind，下列卡 props 互斥。
   */
  terminal?: TerminalCardModel | null | undefined
  /** Diff 卡材质；在场时替换文本 body（同 `terminal`）。 */
  diff?: DiffCardModel | null | undefined
  /** Read 卡材质；在场时以带行号、语法高亮的窗口替换文本 body。 */
  read?: ReadCardModel | null | undefined
  /** Search 卡材质；在场时以分组匹配或路径列表替换文本 body。 */
  search?: SearchCardModel | null | undefined
  /** Web 卡材质；在场时以检索引文列表或抓取源卡替换文本 body。 */
  web?: WebCardModelProps | null | undefined
  state: ToolRowState
  /**
   * 来自 tool args 的文件系统路径；与 onOpenFile 同设时折叠摘要渲染为悬停下划线
   * 链接（打开宿主默认应用）。
   */
  filePath?: string | undefined
  /** 用宿主 OS 默认应用打开该路径（已 cwd 解析）。 */
  onOpenFile?: ((path: string) => void) | undefined
}

/** Leading 槽的状态替换：error/stopped 行让工具图标让位给状态点（及其颜色）。 */
function leadingFor(state: ToolRowState, icon: ReactNode): ReactNode {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    default: return icon
  }
}

/** 辅助技术用的视觉隐藏运行态标签：StateDot 与 sweep 都 aria-hidden/纯色，因此
 *  盲人需要这段文本来知道行在运行、失败或打断。ok 态 null（图标与摘要已描述）。 */
function stateStatus(state: ToolRowState, t: TranslateNS<'sandore'>): string | null {
  switch (state) {
    case 'running': return t('row.running')
    case 'error': return t('row.failed')
    case 'stopped': return t('row.stopped')
    default: return null
  }
}

/**
 * 渲染工具行：共享 DisclosureRow chrome、单行摘要、可展开体（IN/OUT 卡、代码块或
 * 卡材质）。
 * @param props - ToolRow props（见 {@link ToolRowProps}）。
 * @returns 工具行元素。
 */
export function ToolRow({
  t,
  variant,
  toolName,
  icon,
  title,
  summary,
  summarySuffix,
  bodyRaw,
  output,
  errorSummary,
  terminal,
  diff,
  read,
  search,
  web,
  state,
  filePath,
  onOpenFile,
}: ToolRowProps) {
  const [expanded, setExpanded] = useState(false)
  const terminalLabels = useMemo(() => terminalBlockLabels(t), [t])
  const diffLabels = useMemo(() => diffBlockLabels(t), [t])
  const readLabels = useMemo(() => readBlockLabels(t), [t])
  const searchLabels = useMemo(() => searchBlockLabels(t), [t])
  const webLabels = useMemo(() => webBlockLabels(t), [t])
  const terminalBody = terminal === undefined || terminal === null
    ? null
    : localizeTerminalCardModel(terminal, t)
  const diffBody = diff ?? null
  const readBody = read ?? null
  const searchBody = search ?? null
  const webBody = web ?? null
  const outputText = output ?? null
  const card = terminalBody ?? diffBody ?? readBody ?? searchBody ?? webBody
  const expandable = bodyRaw != null || outputText !== null || card !== null
  const open = expanded && expandable
  const bodyText = useMemo(
    () => open && card === null && bodyRaw != null ? formatToolBody(variant, bodyRaw) : null,
    [bodyRaw, card, open, variant],
  )
  const status = stateStatus(state, t)
  // 失败必须替换而非补充正常摘要。
  const failureLine = state === 'error' ? errorSummary ?? null : null
  const summaryText = failureLine ?? terminalBody?.description ?? summary
  // diff 行折叠行携带卡的 +/- 总计（展开页脚打印的同一数字），不展开也能读变更
  // 大小；显式 summarySuffix（今天无 diff 行用它）优先。
  const diffStat = useMemo(() => {
    if (diffBody === null) return null
    const { added, removed } = diffTotals(diffBody.card.diffs)
    return `+${added} -${removed}`
  }, [diffBody])
  const suffix = failureLine === null ? summarySuffix ?? diffStat : null
  const fileLink = filePath !== undefined && onOpenFile !== undefined && failureLine === null
  const toggleExpand = () => {
    setExpanded(v => !v)
  }
  const openFile = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (filePath !== undefined) onOpenFile?.(filePath)
  }
  // Enter/Space 落在聚焦的路径链接上时不冒泡到行的 keydown handler（那会
  // preventDefault 并切换展开而非激活链接）——openFile 的 stopPropagation 的键盘
  // 对应物。原生 button 仍从按键触发自己的 onClick。
  const fileLinkKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
  }
  // code variant 的程序经 CodeBlock（shiki）渲染，因此只有它的输出进 IN/OUT 卡；
  // 其它 variant 的输入也进。
  const cardBody = variant === 'code' ? null : bodyText
  return (
    <div className={css.root} data-variant={variant} data-tool={toolName} data-state={state}>
      {status !== null && <span className={css.visuallyHidden}>{status}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={leadingFor(state, icon)}
        title={title}
        open={open}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={toggleExpand}
        collapsedContent={summaryText !== '' && (
          /* 空摘要连分隔点一起去掉（只有标题的行不显示尾部点）。 */
          <>
            <span className={css.sep} aria-hidden />
            {fileLink ? (
              <button
                type="button"
                className={css.fileLink}
                onClick={openFile}
                onKeyDown={fileLinkKeyDown}
              >
                {summaryText}
              </button>
            ) : (
              <span
                className={cx(css.summary, failureLine !== null && css.errorSummary)}
              >
                {summaryText}
              </span>
            )}
            {suffix !== null && (
              <span className={cx(css.summarySuffix, suffix === diffStat && css.diffStat)}>{suffix}</span>
            )}
          </>
        )}
      >
        {/* 包装器（行头 sibling，因此内部点击永不切换展开）携带展开体。 */}
        <div className={css.bodyWrap}>
          {terminalBody !== null
            ? (
              <TerminalBlock
                {...terminalBody.card}
                maxLines={Infinity}
                labels={terminalLabels}
                className={css.terminalBody}
              />
            )
            : diffBody !== null
              ? <DiffBlock {...diffBody.card} labels={diffLabels} maxLines={CHAT_DIFF_MAX_LINES} className={css.diffBody} />
              : readBody !== null
                ? <ReadBlock {...readBody} labels={readLabels} maxLines={CHAT_READ_MAX_LINES} className={css.readBody} />
                : searchBody !== null
                  ? (
                    <>
                      <SearchBlock
                        {...searchBody.card}
                        labels={searchLabels}
                        maxLines={CHAT_SEARCH_MAX_LINES}
                        className={css.searchBody}
                      />
                      {/* 截断 search 的恢复定位器只活在结果文本里；放在卡下方让被
                          裁的行存活。 */}
                      {searchBody.recovery !== undefined && (
                        <div className={css.searchRecovery}>{searchBody.recovery}</div>
                      )}
                    </>
                  )
                  : webBody !== null
                    ? <WebBlock {...webBody} labels={webLabels} className={css.webBody} />
                    : (
                      <>
                        {variant === 'code' && bodyText !== null && (
                          <div className={css.bodyScroll}>
                            <CodeBlock code={bodyText} lang="typescript" copyLabel={t('copy')} copiedLabel={t('copied')} className={css.codeBody} />
                          </div>
                        )}
                        {(cardBody !== null || outputText !== null) && (
                          <div className={css.ioCard}>
                            {cardBody !== null && (
                              <div className={css.ioSection}>
                                <span className={css.ioLabel}>{t('row.input')}</span>
                                <span className={css.ioText}>{cardBody}</span>
                              </div>
                            )}
                            {cardBody !== null && outputText !== null && (
                              <span className={css.ioDivider} aria-hidden />
                            )}
                            {outputText !== null && (
                              <div className={css.ioSection}>
                                <span className={css.ioLabel}>{t('row.output')}</span>
                                <span className={css.ioText} data-error={state === 'error' || undefined}>
                                  {outputText}
                                </span>
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}
        </div>
      </DisclosureRow>
    </div>
  )
}
