/**
 * TurnTailNodeView：抄自 DSH `packages/client/ui-conversation/src/client/chat/TurnTailNodeView.tsx`。
 * 已完结 turn 的本地动作与特性尾部：时间 + 运行时长/TTFT/吞吐 + 复制 + 分支（fork）。
 * 裁剪：`conversation.chat.turnTail` chain 与 `conversation.chat.assistant-actions` list
 * 两个 slot（sandore 面板不注册任何会话级 slot，等价于 DSH 无条目注入时的空链）；
 * `hasLaterChatNode` 判断由 chat-flow 派生为 `branchUnavailable` 传入。locale 面收窄为
 * sandore 命名空间。其余逐字保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/chat/TurnTailNodeView
 */
import { memo } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { MessageIconActions } from './MessageIconActions.tsx'
import css from './TurnTailNodeView.module.css'

/** turn-tail 展示数据（chat-flow 派生；字段对齐 DSH TurnTailChatData 的展示面）。 */
export interface StepChatTailData {
  /** 已完结 turn 号。 */
  turn: number
  /** 结算 assistant 节点 seq（分支锚点）。 */
  seq: number
  /** 结算时间（Unix epoch ms；时钟用）。 */
  time: number
  /** 结算 assistant 的拼接文本（复制按钮取文本）。 */
  text: string
  /** Turn 壁钟时长 ms；turn/start|end 均在窗口内时可用。 */
  runMs?: number | undefined
  /** Turn 首步 TTFT ms；未记录时省略。 */
  ttftMs?: number | undefined
  /** Turn 解码吞吐；未记录时省略。 */
  tokensPerSecond?: number | undefined
  /** 分支不可用（结算 assistant 非 turn 尾部等；chat-flow 派生）。 */
  branchUnavailable: boolean
}

/** Turn-local actions and feature tail over the closing Assistant, independent of Assistant placement. */
export const TurnTailNodeView = memo(function TurnTailNodeView({
  data, onBranch, t,
}: {
  /** 由 chat-flow 派生的 turn-tail 展示数据。 */
  data: StepChatTailData
  /** 分支回调：以结算 seq 为锚 fork 会话（`sessions.fork`，与 DSH forkAt 同语义）。 */
  onBranch: (seq: number) => void
  /** sandore locale seat。 */
  t: TranslateNS<'sandore'>
}) {
  const runMs = data.runMs
  return (
    <div className={css.root} data-turn-tail={data.turn} data-time-hover-root>
      <MessageIconActions
        text={data.text}
        time={data.time}
        runMs={runMs}
        ttftMs={data.ttftMs}
        tokensPerSecond={data.tokensPerSecond}
        clock="end"
        onBranch={() => { onBranch(data.seq) }}
        branchUnavailable={data.branchUnavailable}
        className={css.actions}
        t={t}
      />
    </div>
  )
})
