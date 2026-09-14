/**
 * TurnTailNodeView（B3 step-view 版）：已完结 turn 的尾部动作行（rc.1
 * `ui-chat/src/client/chat/TurnTailNodeView.tsx` 视觉 1:1 抄录；只读参考
 * deepseek-harness）。
 *
 * 行内容（抄 rc.1，含其数据来源说明）：
 * - root：`data-turn-tail={turn}` + `data-actions-reveal`（最新 turn 常显，
 *   其余 hover 显现——与 rc.1 isLatestTurn 同语义）；
 * - MessageIconActions：复制文本 = closing 全部 text 块拼接（assistantText）、
 *   时钟（clock="end"，时间 = closing.time）、branch（fork 锚 = closing 的
 *   finalNode.seq；branchUnavailable = 引擎证据分支判定 || 同轮更晚节点收窄）。
 *
 * B3 显式裁剪（注释对齐 rc.1 引用点）：
 * - `conversation.chat.turnTail` chain 与 `conversation.chat.assistant-actions`
 *   list（rc.1 TurnTailNodeView 的两个渲染槽）：sandore 面板不注册会话级槽，
 *   等价 rc.1 空链 —— 不渲染（也不占位）。
 * - usageAction（rc.1 的 TurnUsagePanel / TurnTimePanel 可点开明细对话框，
 *   含 data-turn-usage-details/data-turn-time-details 的 dl 面板）：B3 不做
 *   点开对话框（面板只读展开/折叠、无明细浮层），只保留两枚药丸的**静态读数**
 *   （用量紧凑 token 数、ran-for 时长）——视觉与 rc.1 药丸 1:1，交互降为
 *   只读；若 B4 需明细浮层，按 rc.1 TurnUsagePanel/TurnTimePanel 恢复即可。
 *   ttftMs / tokensPerSecond 已入 payload（不渲染——rc.1 只在对话框明细行）。
 *
 * 时钟/日期格式复用旧路径同源实现（../chat/message-chrome.ts），CSS 全部令牌化
 * （--dsh-content-font-* 链 + --dsw-alias-*），见文件头约定。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/TurnTailNodeView
 */
import { memo } from 'react'
import { IconClockOutline16, IconDatabaseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { formatRunDuration } from '../chat-utils/message-chrome.ts'
import { MessageIconActions } from './MessageIconActions.tsx'
import {
  stepAssistantTextOf,
  stepChatTurnTailPayloadOf,
  type StepChatTurnTailPayload,
} from './step-row-data.ts'
import { formatTokens } from './token-format.ts'
import css from './turn-tail.module.css'

/** tail 动作行 data-actions-reveal 模式（最新 turn 常显；旧 turn 悬停显现）。 */
export type StepTurnTailReveal = 'always' | 'hover'

/** turn-tail 行 keyed 渲染器（B3 StepChatViewRow 分发目标）。 */
export const StepChatTurnTailView = memo(function StepChatTurnTailView({
  data, reveal, runMs, hasLaterNode, onBranch, t,
}: {
  /** ChatNode.data（live；读取层防御归一，closing 缺 → 行无内容）。 */
  data: unknown
  /** data-actions-reveal 模式（行壳按 timeline 判 isLatestTurn 后传入）。 */
  reveal: StepTurnTailReveal
  /** 壁钟时长 ms（行壳按 timeline turn/start 计算；窗口外 → undefined）。 */
  runMs: number | undefined
  /** 本 turn 在 tail 之后仍有可见节点（branchUnavailable 收窄）。 */
  hasLaterNode: boolean
  /** 以结算 assistant 的 finalNode.seq 为锚 fork（与 rc.1 forkAt 同语义）。 */
  onBranch: (seq: number) => void
  /** 该行的 locale seat。 */
  t: TranslateNS<'sandore'>
}) {
  const payload = stepChatTurnTailPayloadOf(data)
  const closing = payload.closing
  // rc.1：closing === null → tail chain/actions 均空（无正文结算不产动作行）。
  if (closing === null) return null
  const branchSeq = closing.finalNode?.seq
  if (branchSeq === undefined) return null
  const copyText = stepAssistantTextOf(closing.blocks)
  return (
    <div
      className={css.root}
      data-turn-tail={payload.turn === undefined ? undefined : payload.turn}
      data-actions-reveal={reveal}
    >
      <MessageIconActions
        text={copyText}
        time={closing.time}
        clock="end"
        onBranch={() => { onBranch(branchSeq) }}
        branchUnavailable={payload.branchUnavailable || hasLaterNode}
        className={css.actions}
        extraActions={null}
        usageAction={<TurnTailStatPills payload={payload} runMs={runMs} t={t} />}
        t={t}
      />
    </div>
  )
})

/**
 * 尾部静态读数药丸（rc.1 TurnUsagePanel/TurnTimePanel 的 label 面；B3 裁剪其
 * 点开明细对话框——见文件头注释）：用量药丸（tokenUsage 在场时）＋ 时长药丸
 * （runMs 在场时），视觉按 rc.1 pill 规则抄录但为只读 span（无 button/浮层）。
 */
function TurnTailStatPills({ payload, runMs, t }: {
  payload: StepChatTurnTailPayload
  runMs: number | undefined
  t: TranslateNS<'sandore'>
}) {
  const usage = payload.tokenUsage
  return (
    <>
      {usage !== undefined && (
        <span className={css.statRoot} data-turn-stat="usage">
          <span className={css.statPill}>
            <IconDatabaseOutline16 />
            <span className={css.statLabel}>
              {t('message.turnUsage.consumed', {
                total: t('message.turnUsage.count', { count: formatTokens(usage.totalTokens, t) }),
              })}
            </span>
          </span>
        </span>
      )}
      {runMs !== undefined && (
        <span className={css.statRoot} data-turn-stat="time">
          <span className={css.statPill}>
            <IconClockOutline16 />
            <span className={css.statLabel}>
              {t('message.ranFor', { duration: formatRunDuration(runMs, t) })}
            </span>
          </span>
        </span>
      )}
    </>
  )
}
