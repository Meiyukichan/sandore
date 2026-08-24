/**
 * `sandore/step-phase` 事件的客户端订阅通道。
 *
 * 引擎在收尾阶段流转（`commitFinalize` 写入 `currentPhase`：ask-detect/finalizing/
 * gating/routing/completed）时双发该事件（Cordis emit + 宿主 Session append）。客户端经
 * `conversationEvents.register(stepPhaseDefinition)` 订阅 Session append 通道：
 * 状态-only 讨论节点定义（无 target/buildViewNode，不渲染 Chat 节点）命中后触发
 * 模块级通知 → RunView 订阅 `subscribeStepPhase` 立即 `refreshAndSchedule()`
 * （不经 5s 轮询，实现「阶段变化立即可见」）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-phase
 */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
// 引入 seam.ts 的 SessionEventMap 声明合并（`sandore/step-phase` 载荷词表），使
// `match` 内对 `event.type`/`event.data` 的判别收窄获得类型。
import type {} from '@deepseek-ai/dsh-sandore-workflow/src/seam'

/** `sandore/step-phase` Session append 载荷（对齐 seam.ts SessionEventMap，taskId 隐含于会话）。 */
export interface StepPhaseData {
  readonly stepId: string
  readonly childId: string
  readonly phase: 'ask-detect' | 'finalizing' | 'gating' | 'routing' | 'completed'
  readonly name: string
  readonly loopIteration?: readonly number[]
}

/** 模块级订阅者集合（RunView 经 subscribeStepPhase 订阅，收到即触发实例状态刷新）。 */
const listeners = new Set<() => void>()

/** 订阅 `sandore/step-phase` 事件通知（返回退订函数）。 */
export function subscribeStepPhase(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 通知所有订阅者（防御：单个订阅者抛错不打断通知链，避免破坏会话事件处理）。 */
function notifyStepPhase(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.error('ui-sandore: step-phase listener failed', error)
    }
  }
}

/**
 * 状态-only 讨论节点定义（kind `sandore-step-phase`，无 view target）：
 * `match` 命中 `sandore/step-phase` → `start` 触发模块级通知（不折叠任何 Chat 节点）。
 *
 * 每次阶段事件派生独立 start 上下文（id 含 event.seq 保证全局唯一），规避同
 * stepId 同 phase 重发/重试（retry 后同 Step 再次走收尾）时的
 * 「received more than one start Match」冲突。
 */
export const stepPhaseDefinition: ConversationNodeDefinition<Record<string, never>> = {
  kind: 'sandore-step-phase',
  match: (event) => {
    if (event.type !== 'sandore/step-phase') return null
    return { id: `${event.data.stepId}#${event.data.phase}@${event.seq}`, role: 'start' }
  },
  start: (_context, match) => {
    if (match.event.type !== 'sandore/step-phase') {
      throw new Error('sandore-step-phase start requires sandore/step-phase')
    }
    notifyStepPhase()
    return {}
  },
  // role 恒为 'start'，update 不会被派发；占位以满足契约（返回当前状态）。
  update: context => context.state,
}
