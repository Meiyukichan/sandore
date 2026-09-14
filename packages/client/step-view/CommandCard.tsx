/**
 * CommandCard（B2b step-view 版）：command / manual-compaction 两 kind 的行渲染，
 * 抄自 DSH 0.1.2-rc.1 `ui-chat/src/client/chat/` 的 CommandNodeView.tsx +
 * GenericCommandCard.tsx + CompactionCommandCard.tsx（只读参考 deepseek-harness）。
 *
 * rc.1 的 CommandNodeView 经 keyed 子槽 `conversation.chat.commandview`（entryKey =
 * command.name）把行分发给命令自有视图（ui-commands 注册 /approval 等），无 occupant
 * 时 fallback 到 GenericCommandCard。sandore 没有槽/occupant 概念 → 按 rc.1 无
 * occupant 的 fallback 行为 1:1 处理：每行都渲染 GenericCommandCard（结论见 B2b
 * 报告）。command 语义上只有 /compact 才可能拥有专属视图，而它已被归并到
 * manual-compaction kind（CompactionCommandCard 分支），fallback 路径不丢语义。
 *
 * 视觉：命令行 root（running sweep）+ DisclosureRow 行（16 leading / 标题 / 分隔点 /
 * 摘要，错误行红字，多行结算文本展开 body）。适配：data 经 stepChatCommandPayloadOf
 * / stepChatManualCompactionPayloadOf 防御读取；locale 面为 sandore。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/CommandCard
 */
import { memo, useState, type ReactNode } from 'react'
import { DisclosureRow, IconApiOutline14, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { StepChatCommandPayload, StepChatCompactionPayload } from './step-row-data.ts'
import {
  stepChatCommandPayloadOf, stepChatManualCompactionPayloadOf,
} from './step-row-data.ts'
import { StepCompactionItem } from './CompactionItem.tsx'
import a11yCss from './accessibility.module.css'
import css from './command-card.module.css'

type CommandRowState = 'running' | 'ok' | 'error'

/** 节点态 → 行态语义（未结算运行中；outcome kind 决定之后）。 */
function stateOf(outcome: StepChatCommandPayload['outcome']): CommandRowState {
  if (outcome === null) return 'running'
  return outcome.kind === 'error' ? 'error' : 'ok'
}

function leadingFor(state: CommandRowState): ReactNode {
  return state === 'error' ? <StateDot state="error" /> : <IconApiOutline14 size={14} />
}

interface StepGenericCommandCardProps {
  node: StepChatCommandPayload
  t: TranslateNS<'sandore'>
  /** 命令专用 running 文案；缺席用通用命令标签。 */
  runningSummary?: string | undefined
}

/** 默认命令行（rc.1 GenericCommandCard 逐字视觉）。 */
export function StepGenericCommandCard({ node, t, runningSummary }: StepGenericCommandCardProps) {
  const [expanded, setExpanded] = useState(false)
  const text = node.outcome?.text
  const summary = node.outcome === null
    ? runningSummary ?? t('command.running')
    : text ?? (node.outcome.kind === 'error' ? t('command.failed') : t('command.done'))
  // 摘要在成功时已携带结算文本，故标题是裸命令名；窗口切走 run 页时无名字。
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

/** 行外壳：与 rc.1 CommandNodeView 同几何（ChatView.module.css .callRow）。 */
function CommandRowShell({ children }: { children: ReactNode }): ReactNode {
  return <div className={css.callRow}>{children}</div>
}

/** /compact 命令的「命令卡或压缩标记」分流（rc.1 CompactionCommandCard 逻辑）。 */
export function StepCompactionCommandCard({ node, compaction, t }: {
  /** 命令节点（本地断言面）。 */
  node: StepChatCommandPayload
  /** 结构化 checkpoint（如有）。 */
  compaction: StepChatCompactionPayload | null
  t: TranslateNS<'sandore'>
}) {
  if (compaction !== null) {
    return (
      <StepCompactionItem
        node={compaction}
        title={t('message.compaction.commandTitle')}
        fallbackSummary={node.outcome?.text ?? null}
        t={t}
      />
    )
  }
  if (node.outcome !== null) return <StepGenericCommandCard node={node} t={t} />
  return <StepGenericCommandCard node={node} t={t} runningSummary={t('message.compaction.running')} />
}

/** command 行的 keyed 渲染器（B2b StepChatViewRow 分发目标）。 */
export const StepChatCommandView = memo(function StepChatCommandView({ data, t }: {
  data: unknown
  t: TranslateNS<'sandore'>
}) {
  const payload = stepChatCommandPayloadOf(data)
  return (
    <CommandRowShell>
      <StepGenericCommandCard node={payload} t={t} />
    </CommandRowShell>
  )
})

/** manual-compaction 行的 keyed 渲染器（B2b StepChatViewRow 分发目标）。 */
export const StepChatManualCompactionView = memo(function StepChatManualCompactionView({ data, t }: {
  data: unknown
  t: TranslateNS<'sandore'>
}) {
  const payload = stepChatManualCompactionPayloadOf(data)
  return (
    <CommandRowShell>
      <StepCompactionCommandCard node={payload.command} compaction={payload.compaction} t={t} />
    </CommandRowShell>
  )
})
