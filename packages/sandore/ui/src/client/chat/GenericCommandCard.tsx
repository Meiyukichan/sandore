/**
 * GenericCommandCard：抄自 DSH `packages/client/ui-conversation/src/client/chat/GenericCommandCard.tsx`。
 * 默认命令行——渲染命令名与其结算文本（DSH commandview slot 的 fallback 渲染器）。
 * props 从内部 `CommandRowOwnerProps` 收窄为公开 `CommandNode`；locale 面收窄为
 * sandore 命名空间；运行/失败状态经 DisclosureRow + StateDot 呈现，逐字保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/chat/GenericCommandCard
 */
import { useState, type ReactNode } from 'react'
import type { CommandNode } from '@deepseek-ai/dsh-client-runtime/client'
import { DisclosureRow, IconApiOutline14, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import a11yCss from './accessibility.module.css'
import css from './GenericCommandCard.module.css'

type CommandRowState = 'running' | 'ok' | 'error'

/** Node state → row state semantic (running while unsettled; outcome kind after). */
function stateOf(outcome: CommandNode['outcome']): CommandRowState {
  if (outcome === null) return 'running'
  return outcome.kind === 'error' ? 'error' : 'ok'
}

function leadingFor(state: CommandRowState): ReactNode {
  return state === 'error' ? <StateDot state="error" /> : <IconApiOutline14 size={14} />
}

/** Card props: the command node plus the render site's locale seat. */
export interface GenericCommandCardProps {
  node: CommandNode
  t: TranslateNS<'sandore'>
  /** Command-specific running copy; absent uses the generic command label. */
  runningSummary?: string | undefined
}

export function GenericCommandCard({ node, t, runningSummary }: GenericCommandCardProps) {
  const [expanded, setExpanded] = useState(false)
  const text = node.outcome?.text
  const summary = node.outcome === null
    ? runningSummary ?? t('command.running')
    : text ?? (node.outcome.kind === 'error' ? t('command.failed') : t('command.done'))
  // Title is the bare command name: the row already reads `name · outcome`,
  // and the dispatched line's own `/` and arguments only restate what the
  // settlement text says (`permission · preset workspace-write`). A
  // cross-window node whose run page fell out of the window has no name.
  const title = node.name ?? t('command.title')
  const state = stateOf(node.outcome)
  const body = text !== undefined && text.includes('\n') ? text : null
  const open = expanded && body !== null
  return (
    <div className={css.root} data-variant="others" data-state={state}>
      {state === 'running' && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      {state === 'error' && <span className={a11yCss.visuallyHidden}>{t('row.failed')}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={leadingFor(state)}
        title={title}
        open={open}
        expandable={body !== null}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={(
          <>
            <span className={css.separator} aria-hidden />
            <span className={css.summary} data-error={state === 'error' || undefined}>{summary}</span>
          </>
        )}
      >
        <pre className={css.body} data-error={state === 'error' || undefined}>{body}</pre>
      </DisclosureRow>
    </div>
  )
}
