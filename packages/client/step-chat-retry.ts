/**
 * StepChatPanel 弹性化的可测纯函数：open 失败退避重试序列、binding 重解析序列、
 * openError 展示格式化。
 *
 * Round 25：StepChatPanel 对子代理会话只 open 一次，`openState='error'` 后永久粘滞
 * （挂载瞬间的瞬时失败——短 turn 子代理 settle/dispose 过渡窗口——无法自愈，面板
 * 长期显示「子代理会话加载失败」且实时事件被丢弃）。这里定义有界退避序列供面板重试；
 * 达上限后停在 error 占位并展示 openError（便于现场锁定确切错误码）。
 *
 * 另一个缺陷：子代理 settle/dispose 后 host 广播 `session-removed` → client 列表移除
 * 该 child → `binding` 转 undefined → 面板停在「正在加载子代理会话…」。这里定义有界
 * 列表重拉序列（host 列表包含持久化冷会话，`sessions.refresh()` 后 child 可重新绑定）。
 *
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-chat-retry
 */

/** open 失败重试的退避延迟（毫秒）：1s → 3s → 10s 封顶；超出返回 undefined（停止重试）。 */
export const STEP_CHAT_RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 10000]

/**
 * 第 `attempt` 次 open 重试前的延迟（0-based；`attempt=0` 表示首次失败后第一次重试）。
 * @param attempt - 已失败/已重试次数。
 * @returns 延迟毫秒；达上限返回 undefined（不再重试）。
 */
export function stepChatRetryDelayMs(attempt: number): number | undefined {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= STEP_CHAT_RETRY_DELAYS_MS.length) {
    return undefined
  }
  return STEP_CHAT_RETRY_DELAYS_MS[attempt]!
}

/** binding 缺失（settle 后 session-removed）时的列表重拉延迟序列（毫秒），有界。 */
export const STEP_CHAT_REBIND_DELAYS_MS: readonly number[] = [1000, 2000, 5000, 10000, 30000]

/** binding 重解析最大次数（超出停在 loading 占位，避免对已删除 child 空转）。 */
export const STEP_CHAT_MAX_REBINDS: number = STEP_CHAT_REBIND_DELAYS_MS.length

/**
 * 第 `attempt` 次 binding 重拉前的延迟（0-based）。
 * @param attempt - 已重拉次数。
 * @returns 延迟毫秒；达上限返回 undefined（停止重拉）。
 */
export function stepChatRebindDelayMs(attempt: number): number | undefined {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= STEP_CHAT_REBIND_DELAYS_MS.length) {
    return undefined
  }
  return STEP_CHAT_REBIND_DELAYS_MS[attempt]!
}

/** `snapshot.openError` 的最小结构面（DSH RpcError：code/message/details）。 */
export interface StepChatOpenErrorLike {
  readonly code: string
  readonly message?: string | undefined
}

/**
 * openError → 展示文案（`code: message`；无 message 时仅 code）。
 * @param error - `snapshot.openError`（RpcError | null）。
 * @returns 展示文案；null/undefined 返回 undefined（不展示）。
 */
export function formatOpenError(error: StepChatOpenErrorLike | null | undefined): string | undefined {
  if (error === null || error === undefined) return undefined
  if (error.message === undefined || error.message === '') return error.code
  return `${error.code}: ${error.message}`
}
