/**
 * RunView「打开讨论」按钮的接线 adapter（无 React 依赖，可单测）。
 *
 * `createOpenDiscussion` 把宿主 `ctx.sessions` 的打开面接成 RunView 的
 * `openDiscussion` 回调：调用时经 `sessions.open(instanceId)` 跳转到宿主
 * Session chat 视图（内含 `sandore-step` 讨论节点）。宿主 Session id ==
 * instanceId，故 `instanceId` 可安全收窄为 `SessionId`（brand 仅编译期标记，
 * 运行时就是同一字符串，无任何转换开销）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/open-discussion
 */
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/** `createOpenDiscussion` 所需的最小 sessions 打开面（`ctx.sessions` 结构满足）。 */
export interface SessionsOpenFace {
  open(id: SessionId): void
}

/** RunView 的「打开讨论」回调签名（无入参，点击后跳宿主会话）。 */
export type OpenDiscussion = () => void

/**
 * 构造「打开讨论」回调：调用时经 `sessions.open(instanceId)` 跳宿主会话。
 * @param sessions - `ctx.sessions` 的最小打开面。
 * @param instanceId - 目标工作流实例 id（宿主 Session id == instanceId）。
 * @returns 供 RunView `openDiscussion` prop 直接使用的回调。
 */
export function createOpenDiscussion(sessions: SessionsOpenFace, instanceId: string): OpenDiscussion {
  return () => {
    // 宿主 Session id == instanceId；brand 仅编译期标记，运行时就是同一字符串。
    sessions.open(instanceId as SessionId)
  }
}
