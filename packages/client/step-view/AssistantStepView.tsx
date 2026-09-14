/**
 * AssistantStepView（B2a step-view 版）：assistant-step 行的 keyed 渲染器——
 * 读取本地 payload 并把 status 译为 AssistantMarkdown 的 streaming/interrupted
 * 标记。抄自 DSH 0.1.2-rc.1 `ui-chat/src/client/chat/AssistantNodeView.tsx`
 * （只读参考 deepseek-harness），逐字保留的只有「状态 → 视觉标记」这一段：
 *   running → streaming；interrupted → interrupted（正文尾「已停止」标记）。
 *
 * rc.1 中该文件同时负责的扩展链在 sandore 面板侧按批折衷：
 * - turn-tail owner 推导（useTurnData('turn-tail') + closing seq 比对）→ B3：
 *   turn-tail 独立成行（见 step-view/TurnTailNodeView.tsx），assistant 行不再
 *   派生 owner；assistant-actions 槽（rc.1 renderSlot）不接（无会话级槽）；
 * - mentions（chatFileMentions 服务）→ 不接（宿主无该服务，等价 rc.1 无服务态）；
 * - reasoningHidden/revealProcess（Turn-process 内联折叠）→ B3 已接入：行壳
 *   计算后经本组件转发给 AssistantMarkdown（rc.1 AssistantNodeView 同款语义）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/AssistantStepView
 */
import { memo } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SandoreRenderMessageImages } from '../chat/attachment/MessageImage.tsx'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'
import { stepChatAssistantStepPayloadOf } from './step-row-data.ts'

/** assistant-step 行的 keyed 渲染器（B2a/B3 StepChatViewRow 分发目标）。 */
export const StepChatAssistantStepView = memo(function StepChatAssistantStepView({ data, renderMessageImages, reasoningHidden, revealProcess, t }: {
  /** ChatNode.data（live；读取层防御归一，缺 blocks → 空态壳不渲染）。 */
  data: unknown
  /** 附件渲染器（面板既有 ImageGallery 通道）。 */
  renderMessageImages: SandoreRenderMessageImages
  /** 行壳按进程折叠态注入：答复行内联推理是否隐藏（B3；缺省不隐藏）。 */
  reasoningHidden?: boolean | undefined
  /** 行壳注入：打开轮次级进程披露（B3；推理 find/揭示回调）。 */
  revealProcess?: (() => void) | undefined
  /** 该行的 locale seat。 */
  t: TranslateNS<'sandore'>
}) {
  const payload = stepChatAssistantStepPayloadOf(data)
  return (
    <AssistantMarkdown
      blocks={payload.blocks}
      streaming={payload.status === 'running'}
      interrupted={payload.status === 'interrupted'}
      renderMessageImages={renderMessageImages}
      reasoningHidden={reasoningHidden}
      revealProcess={revealProcess}
      t={t}
    />
  )
})
