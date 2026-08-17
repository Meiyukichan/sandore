/** sandore Client UI 入口：挂载 sandore Remote 命名空间并注册 sidebar.footer.action 工作流按钮。 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { PingResponse } from '@deepseek-ai/dsh-sandore-workflow/remote'
import { sandoreRemote, unwrap } from './remote.ts'
import { en, NS, zh } from './locales.ts'
import { createSandoreSave } from './sandore-save.ts'
import { createOpenDiscussion } from './open-discussion.ts'
import type { WorkflowButtonFace } from './WorkflowButton.tsx'
import { WorkflowButton } from './WorkflowButton.tsx'
import { DagStepNodeView, type SandoreStepInjected } from './DagStepNodeView.tsx'
import { sandoreStepDefinition } from './sandore-step-definition.ts'

/** Client 插件依赖的 cordis 服务键。 */
export const inject = ['conversationEvents', 'slots', 'locale', 'remote', 'sessions', 'workspaces']

/** 挂载 sandore 远程命名空间、注册 locale 字典与工作流入口按钮。 */
export async function apply(ctx: ClientContext): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sandore: dictionaries')

  // 将 workflow 包生成的 Remote 贡献挂到 `ctx.remote`，使 `remote.sandore` 命名空间
  // 服务就绪；disposer 经 ctx.effect 绑定插件 fiber，卸载时自动逆序清理。
  const disposeRemote = await ctx.remote.$mount(sandoreRemote)
  ctx.effect(() => disposeRemote, 'ui-sandore: remote')

  // 注册 sandore-step 讨论节点 Definition（kind `sandore-step`、target `chat`），
  // 不依赖 `remote.sandore`。
  ctx.conversationEvents.register(sandoreStepDefinition)

  // `remote.sandore` 命名空间服务由 `$mount` 动态安装（不在本插件静态 inject 中，
  // self-mount + self-inject 会死锁）。用 `ctx.inject` 动态依赖注入：等命名空间服务
  // 就绪后（$mount 已完成）再注册依赖它的 slot，回调内的 `ctx.remote.sandore` 可正常访问。
  await ctx.inject(['remote.sandore'], (remoteCtx) => {
    const sandore: WorkflowButtonFace = {
      ping: async (): Promise<PingResponse> => unwrap(await remoteCtx.remote.sandore.ping()),
      listInstances: async () => unwrap(await remoteCtx.remote.sandore.listInstances()),
      listDefinitions: async () => unwrap(await remoteCtx.remote.sandore.listDefinitions()),
      deleteDefinition: async (id: string) => unwrap(await remoteCtx.remote.sandore.deleteDefinition(id)),
      save: createSandoreSave(remoteCtx.remote.sandore),
      openDiscussion: (instanceId: string) => createOpenDiscussion(remoteCtx.sessions, instanceId),
      remote: remoteCtx.remote.sandore,
    }

    remoteCtx.slots.inject('sidebar.footer.action', () => remoteCtx.slots.register({
      name: 'sidebar.footer.action',
      id: 'sandore-btn',
      locale: NS,
      inject: (): WorkflowButtonFace => sandore,
    }, WorkflowButton))

    remoteCtx.slots.inject('conversation.chat.node', () => remoteCtx.slots.register({
      name: 'conversation.chat.node',
      key: 'sandore-step',
      locale: NS,
      inject: (): SandoreStepInjected => ({
        openSession: (id: SessionId) => { remoteCtx.sessions.open(id) },
        retryStep: async (input) => { unwrap(await remoteCtx.remote.sandore.retryStep(input)) },
      }),
    }, DagStepNodeView))
  })
}
