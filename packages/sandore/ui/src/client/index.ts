/** sandore Client UI 入口：挂载 sandore Remote 命名空间、注册 sidebar 工作流入口与「工作流」视图 tab。 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { sandoreRemote, unwrap } from './remote.ts'
import { en, NS, zh } from './locales.ts'
import type { WorkflowButtonFace } from './WorkflowButton.tsx'
import { WorkflowButton } from './WorkflowButton.tsx'
import type { WorkflowViewFace } from './WorkflowView.tsx'
import { WorkflowView } from './WorkflowView.tsx'
import type { RunViewRemote } from './RunView.tsx'
import { createSandoreSave, type SandoreSaveRemote } from './sandore-save.ts'
import { DagStepNodeView, type SandoreStepInjected } from './DagStepNodeView.tsx'
import { sandoreStepDefinition } from './sandore-step-definition.ts'

/** Client 插件依赖的 cordis 服务键。 */
export const inject = ['conversationEvents', 'slots', 'locale', 'remote', 'sessions', 'workspaces']

/**
 * 等待会话 header 渲染出目标 tab 后点击。DSH 未向插件暴露外部 setView API
 * （chat store 的 `actions.setView` 只在 ui-conversation 内部可达），对 tab
 * 按钮的 DOM 点击是等价于用户点击的用户级交互，走真实 store 更新路径。
 * @param label - tab 的本地化标签文本。
 */
async function activateViewTab(label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    const target = tabs.find(tab => tab.textContent?.trim() === label)
    if (target !== undefined) {
      target.click()
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** 挂载 sandore 远程命名空间、注册 locale 字典与工作流入口/视图。 */
export async function apply(ctx: ClientContext): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sandore: dictionaries')
  const t = ctx.locale.bind(NS)

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
    const sandore = remoteCtx.remote.sandore

    // 点击「工作流」：确保有会话打开，然后把主区切换到「工作流」视图 tab。
    // 工作流视图内容全局（列表 + 编辑区），挂在任一打开会话的 conversation.view 上。
    const onOpenWorkflow = async (): Promise<void> => {
      if (remoteCtx.sessions.list.getSnapshot().current === undefined) {
        const ws = remoteCtx.workspaces.list.getSnapshot()
        const target = ws.recentWorkspaceId ?? ws.items[0]?.workspaceId
        if (target !== undefined) {
          const id = await remoteCtx.workspaces.connectWorkspace(target)
          remoteCtx.sessions.open(id)
        } else {
          remoteCtx.workspaces.startSession()
        }
      }
      await activateViewTab(t('view.workflow'))
    }

    remoteCtx.slots.inject('sidebar.footer.action', () => remoteCtx.slots.register({
      name: 'sidebar.footer.action',
      id: 'sandore-btn',
      locale: NS,
      inject: (): WorkflowButtonFace => ({ onOpenWorkflow }),
    }, WorkflowButton))

    // conversation.view「工作流」tab：双栏工作区（左侧列表 + 右侧编辑区），
    // 与 ui-trajectory 的 trajectory tab 同槽并列。
    remoteCtx.slots.inject('conversation.view', () => remoteCtx.slots.register({
      name: 'conversation.view',
      id: 'workflow',
      order: 20,
      locale: NS,
      label: () => t('view.workflow'),
      inject: (): WorkflowViewFace => ({
        listInstances: async () => unwrap(await sandore.listInstances()),
        listDefinitions: async () => unwrap(await sandore.listDefinitions()),
        deleteDefinition: async (id: string) => unwrap(await sandore.deleteDefinition(id)),
        getYaml: async (id: string) => unwrap(await sandore.getYaml(id)),
        save: createSandoreSave(sandore as unknown as SandoreSaveRemote),
        remote: sandore as unknown as RunViewRemote,
        openSession: (id: string) => { remoteCtx.sessions.open(id as SessionId) },
      }),
    }, WorkflowView))

    remoteCtx.slots.inject('conversation.chat.node', () => remoteCtx.slots.register({
      name: 'conversation.chat.node',
      key: 'sandore-step',
      locale: NS,
      inject: (): SandoreStepInjected => ({
        openSession: (id: SessionId) => { remoteCtx.sessions.open(id) },
        retryStep: async (input) => { unwrap(await sandore.retryStep(input)) },
      }),
    }, DagStepNodeView))
  })
}
