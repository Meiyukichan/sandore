/**
 * SandoreQuestionComposer：`conversation.composer` chain 的 sandore 条目（BUG 1 修复，方案 A）。
 *
 * DSH 把 sandore 引擎的 question/requested 帧路由到 instanceId 会话，主会话无
 * PendingWait，原生 composer 不渲染选择框。本条目订阅 {@link sandore-questions.ts}
 * 的聚合 store：当前会话存在 pending sandore 问题时，以 QuestionCard（复用
 * DiscussionInput 的接管面板样式）在 DSH 原生 InputBar 之上渲染问答卡；无 pending
 * 返回 `null`，完全不遮挡 DSH 原生 composer。
 *
 * 回答/拒绝走 `remote.replyQuestion` / `remote.rejectQuestion`（unwrap 解包），
 * 成功后本地乐观移除该问题（store 刷新即轮换到下一题/收卡）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/SandoreQuestionComposer
 */
import { useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

import { describeError } from './describe-error.ts'
import { QuestionCard } from './DiscussionInput.tsx'
import { getSandoreQuestions, removeSandoreQuestion, subscribeSandoreQuestions } from './sandore-questions.ts'
import { unwrap } from './remote.ts'
import type { RunViewRemote } from './RunView.tsx'
import type { AnswerItem } from './run-view-model.ts'
import css from './input.module.css'

/** 注入的业务面：`ctx.remote.sandore` 最小 RPC 访问面（回答/拒绝问答）。 */
export interface SandoreQuestionComposerFace {
  readonly remote: RunViewRemote
}

/** 完整 props：框架注入的 chain matched + locale t + 标准会话 kit + 业务面。 */
export type SandoreQuestionComposerProps =
  PropsRuntime<'conversation.composer'>
  & { matched: boolean }
  & PropsLocale<'sandore'>
  & SandoreQuestionComposerFace

/** 渲染当前第一个 pending sandore 问题为 QuestionCard（无 pending 返回 null）。 */
export function SandoreQuestionComposer({ t, remote }: SandoreQuestionComposerProps) {
  const pending = useSyncExternalStore(subscribeSandoreQuestions, getSandoreQuestions)
  const question = pending.length > 0 ? pending[0]! : undefined
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 问题轮换（回答后 store 刷新）时重置动作状态；inner QuestionCard 按 key 重挂载，
  // 其内部草稿随之重置。
  const questionKey = question === undefined ? null : `${question.instanceId}:${question.entry.requestId}`
  const lastKeyRef = useRef<string | null>(null)
  if (questionKey !== lastKeyRef.current) {
    lastKeyRef.current = questionKey
    if (question !== undefined) {
      setBusy(false)
      setError(null)
    }
  }

  // 无 pending：返回 null（不遮挡 DSH 原生 InputBar）。
  if (question === undefined) return null

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(describeError(cause))
      setBusy(false)
      return
    }
    // 成功：本地乐观移除该问题（store 立即刷新 → 卡片消失/轮换；轮询以新快照校正）。
    removeSandoreQuestion(question.instanceId, question.entry.requestId)
  }

  const onReply = (requestId: string, answers: AnswerItem[]): void => {
    void runAction(async () => {
      unwrap(await remote.replyQuestion({ instanceId: question.instanceId, requestId, answers: { answers } }))
    })
  }

  const onReject = (requestId: string): void => {
    void runAction(async () => {
      unwrap(await remote.rejectQuestion({ instanceId: question.instanceId, requestId }))
    })
  }

  return (
    <>
      {error !== null && <div className={css.composerError} role="status">{error}</div>}
      <QuestionCard
        key={questionKey ?? undefined}
        entry={question.entry}
        steps={[]}
        t={t}
        pending={busy}
        workflowLabel={pending.length > 1 ? `[${question.workflowName}]` : undefined}
        onReply={onReply}
        onReject={onReject}
      />
    </>
  )
}
