/**
 * sandore 远程客户端薄封装。
 *
 * 从 `@deepseek-ai/dsh-sandore-workflow/remote` 默认导入生成的
 * `TypertRemoteContribution`（供 `ctx.remote.$mount` 挂载），并暴露
 * `RemoteResult` 解包薄封装：`ok:true` 取 `value`，`ok:false` 抛
 * `SandoreRemoteError`（`RemoteFailure` 的 `Error` 子类包装，保留 code），
 * 供组件层统一解包、不静默吞错。
 * @module @deepseek-ai/dsh-client-ui-sandore/client/remote
 */
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import sandoreRemote from '@deepseek-ai/dsh-sandore-workflow/remote'

export { sandoreRemote }
export type { PingResponse } from '@deepseek-ai/dsh-sandore-workflow/remote'

/**
 * 一次 sandore RPC 调用失败（`RemoteFailure` 的 `Error` 子类包装）。
 *
 * 保留 `code` 与 `details`，使失败分支可被统一捕获并按 code 路由，
 * 而非静默吞掉或抛出裸对象。
 */
export class SandoreRemoteError extends Error {
  /** Host 侧报错的稳定机器码。 */
  readonly code: string
  /** Host 侧附加的错误详情（JSON 对象）。 */
  readonly details: object

  constructor(failure: RemoteFailure) {
    super(`${failure.code}: ${failure.message}`)
    this.name = 'SandoreRemoteError'
    this.code = failure.code
    this.details = failure.details
  }
}

/**
 * 解包 `RemoteResult`：`ok:true` 取 `value`，`ok:false` 抛 `SandoreRemoteError`。
 *
 * 载波层故障已折叠进 `error` 分支，消费者无需 try/catch 恢复；仅装配性
 * 故障（arity 不匹配、方法未挂载、缺 Context binder）仍 reject。
 */
export function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw new SandoreRemoteError(result.error)
}
