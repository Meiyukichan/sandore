/** Client→Host JSON RPC 桥（`host.call` 的字面量原型捷径）。 */

/** 跨边界可调用的 Host 半 RPC 桥。 */
export interface HostCall {
  /** 调用一个 Host 半处理器，返回可跨边界的 JSON（`unknown`）。 */
  call(method: string, args?: unknown): Promise<unknown>
}

/** `sandore.ping` 的桩返回数据（与 Host `SandoreRemote.ping()` 对齐）。 */
export interface PingResponse {
  /** 恒为 true，表示往返成功。 */
  pong: boolean
  /** 服务命名空间标识。 */
  service: string
  /** Host 侧生成的时间戳（ISO 8601 字符串）。 */
  time: string
}

/** 把未知值收窄为普通对象（`Record<string, unknown>`）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 类型守卫：把 `host.call` 返回的未知 JSON 收窄为 `PingResponse`。 */
export function isPingResponse(value: unknown): value is PingResponse {
  if (!isRecord(value)) return false
  return typeof value.pong === 'boolean'
    && typeof value.service === 'string'
    && typeof value.time === 'string'
}
