/**
 * TurnProcessNodeView（B3 step-view 版）：turn 级进程披露头（折叠条）。
 * 抄自 DSH 0.1.2-rc.1 `ui-chat/src/client/chat/TurnProcessNodeView.tsx` +
 * `TurnProcessNodeView.module.css`（只读参考 deepseek-harness）。
 *
 * rc.1 差异（B3 显式折衷）：
 * - rc.1 从 ChatNodeSeat 的 turnProcess owner 读 foldable/open/setOpen（store
 *   持久化 actions.setTurnProcessOpen）；面板改为 props 注入 `open` / `onToggle`
 *   （行壳持有轮次级本地展开态，见 StepChatViewRow/StepChatBody 注释）——
 *   foldable 判定（含 !foldable → 不渲染）由行壳做完，本组件只负责视觉按钮；
 * - locale 面收窄为 sandore 命名空间；
 * - 展开区内容（rc.1：进程窗口内的成员行就地出现 + 内联推理随 open 揭示）由
 *   行壳的 hidden/折叠判定承担，本文件不再渲染额外展开面板（调用统计/明细占位
 *   亦不引入——rc.1 无此浮层，B3 裁剪说明见文件头模块注释）。
 *
 * 视觉 1:1：33px 高下划线按钮（关合时 margin-bottom 8px）、计数 label（工具/
 * 消息/subagent 各 one/other 文案 + 分隔）、chevron 90° 关合旋转；字号走
 * --dsh-content-font-* 令牌（默认与 rc.1 的 14px/24px 一致），颜色走
 * --dsw-alias-*；深浅色/字号随全局令牌，见 step-chat-panel.module.css 文件头。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/TurnProcessNodeView
 */
import { memo } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { stepTurnProcessSpecOf } from './step-row-data.ts'
import css from './turn-process-node.module.css'

/** turn-process 披露头 keyed 渲染器（B3 StepChatViewRow 分发目标）。 */
export const StepChatTurnProcessView = memo(function StepChatTurnProcessView({
  data, open, onToggle, t,
}: {
  /** ChatNode.data（TurnProcessChatData；读取层防御归一，缺 spec → 不渲染）。 */
  data: unknown
  /** 本行所属 turn 的进程展开态（行壳轮次级本地状态）。 */
  open: boolean
  /** 切换展开态（行壳回写轮次级状态；面板内只读展开/折叠，不跨会话持久）。 */
  onToggle: (open: boolean) => void
  /** 该行的 locale seat。 */
  t: TranslateNS<'sandore'>
}) {
  // 控制节点 data 与 TurnProcessSpec 同型（rc.1 buildViewNode 发布 spec 数据）。
  const spec = stepTurnProcessSpecOf(data)
  if (spec === undefined) return null
  const labels: string[] = []
  if (spec.toolCallCount > 0) {
    labels.push(t(
      spec.toolCallCount === 1
        ? 'message.turnProcess.toolCalls.one'
        : 'message.turnProcess.toolCalls.other',
      { count: spec.toolCallCount },
    ))
  }
  if (spec.messageCount > 0) {
    labels.push(t(
      spec.messageCount === 1
        ? 'message.turnProcess.messages.one'
        : 'message.turnProcess.messages.other',
      { count: spec.messageCount },
    ))
  }
  if (spec.subagentCount > 0) {
    labels.push(t(
      spec.subagentCount === 1
        ? 'message.turnProcess.subagents.one'
        : 'message.turnProcess.subagents.other',
      { count: spec.subagentCount },
    ))
  }
  const label = labels.length === 0
    ? t('message.turnProcess.thoughtForAWhile')
    : labels.join(t('message.turnProcess.separator'))
  return (
    <button
      type="button"
      className={css.root}
      data-open={open || undefined}
      data-turn-process={spec.turn}
      data-turn-process-messages={spec.messageCount}
      data-turn-process-tool-calls={spec.toolCallCount}
      data-turn-process-subagents={spec.subagentCount}
      aria-expanded={open}
      onClick={(event) => {
        event.currentTarget.focus()
        onToggle(!open)
      }}
    >
      <span className={css.label}>{label}</span>
      <IconChevronDownOutline14 className={css.chevron} />
    </button>
  )
})
