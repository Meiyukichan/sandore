/**
 * sandore Host RPC（Typert 协议）。
 *
 * `super(ctx, 'sandore')` 定 wire namespace，`@Remote('ping')` 定 method，
 * 构成端点 `sandore.ping`。Client 侧以 `host.call('sandore.ping')` 调用。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/** `sandore.ping` 的桩返回数据（非真实引擎状态）。 */
export interface PingResponse {
  /** 恒为 true，表示往返成功。 */
  pong: boolean
  /** 服务命名空间标识。 */
  service: string
  /** Host 侧生成的时间戳（ISO 8601 字符串）。 */
  time: string
}

/** sandore 的 Host RPC 服务。 */
export class SandoreRemote extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'sandore')
  }

  /** 健康检查往返，验证 Host/Client RPC 链路。 */
  @Remote('ping')
  ping(): PingResponse {
    return { pong: true, service: 'sandore', time: new Date().toISOString() }
  }
}

export default SandoreRemote
