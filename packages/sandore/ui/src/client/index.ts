/** sandore Client UI 入口：注册 sidebar.footer.action 工作流按钮。 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { HostCall } from './host.ts'
import { en, NS, zh } from './locales.ts'
import type { WorkflowButtonFace } from './WorkflowButton.tsx'
import { WorkflowButton } from './WorkflowButton.tsx'

/** Client 插件依赖的 cordis 服务键。 */
export const inject = ['slots', 'locale']

/** 挂载工作流入口按钮与面板。 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sandore: dictionaries')

  // Task 1 原型捷径：本地 JSON 桩往返（`host.call('sandore.ping')` 的字面量形态），
  // 对齐 Host `SandoreRemote.ping()` 的桩数据；生产链路接入 `ctx.remote` 的生成贡献后替换。
  const host: HostCall = {
    call: async (method, _args) => {
      if (method === 'sandore.ping') {
        return { pong: true, service: 'sandore', time: new Date().toISOString() }
      }
      throw new Error(`host.call: unknown method "${method}"`)
    },
  }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'sandore-btn',
    locale: NS,
    inject: (): WorkflowButtonFace => ({ host }),
  }, WorkflowButton))
}
