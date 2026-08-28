/**
 * 错误消息归一化（无 React 依赖，可单测）。
 *
 * 渲染任意抛出的值为可读消息：`Error` 取 `.message`，其余回落 `String(value)`。
 * 仅供诊断展示，调用方永不按消息内容路由控制流。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/describe-error
 */

/** 渲染任意抛出的值为可读消息（诊断用，永不按消息路由）。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
