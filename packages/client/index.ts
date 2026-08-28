/** sandore Client UI 入口：挂载 sandore Remote 命名空间、注册 sidebar 工作流入口与 shell.overlay 全局工作流 UI。 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { sandoreRemote, unwrap } from './remote.ts'
import { en, NS, zh } from './locales.ts'
import type { WorkflowButtonFace } from './WorkflowButton.tsx'
import { WorkflowButton } from './WorkflowButton.tsx'
import type { WorkflowOverlayFace } from './workflow-face.ts'
import { WorkflowOverlay } from './WorkflowOverlay.tsx'
import type { RunViewRemote } from './RunView.tsx'
import { createSandoreSave, type SandoreSaveRemote } from './sandore-save.ts'
import { closeWorkflowOverlay, toggleWorkflowOverlay } from './workflow-store.ts'
import { SandoreModelDirectory, parsePermissionReport, type ModelDirectoryFace, type ObservableFace, type PermissionSelectValue, type SessionModelsApi } from './model-faces.ts'
import { installStepChatSessions, installStepChatWorkspaces } from './StepChatPanel.tsx'

/** Client 插件依赖的 cordis 服务键。 */
export const inject = ['slots', 'locale', 'remote', 'sessions', 'workspaces', 'connection']

/** 挂载 sandore 远程命名空间、注册 locale 字典与工作流入口/overlay。 */
export async function apply(ctx: ClientContext): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sandore: dictionaries')

  // 将 workflow 包生成的 Remote 贡献挂到 `ctx.remote`，使 `remote.sandore` 命名空间
  // 服务就绪；disposer 经 ctx.effect 绑定插件 fiber，卸载时自动逆序清理。
  const disposeRemote = await ctx.remote.$mount(sandoreRemote)
  ctx.effect(() => disposeRemote, 'ui-sandore: remote')

  // 安装 StepChatPanel 的模块级 sessions 持有（运行中 step 内嵌子代理消息面板
  // 需要 `sessions.binding(childId)` 订阅会话快照；时间线组件树不携带 ctx，故经
  // 模块级单例注入，卸载时由 ctx.effect 清除）。
  ctx.effect(() => installStepChatSessions(ctx.sessions), 'ui-sandore: step-chat-sessions')
  // 面板文件路径打开（tool 行 fileLink）：workspaces.openPath 经模块级单例注入。
  ctx.effect(() => installStepChatWorkspaces(ctx.workspaces), 'ui-sandore: step-chat-workspaces')

  // sidebar.footer.action 入口按钮：不依赖 remote，直接注册（点击切换 overlay 开关）。
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'sandore-btn',
    locale: NS,
    inject: (): WorkflowButtonFace => ({ onToggleWorkflow: toggleWorkflowOverlay }),
  }, WorkflowButton))

  // `remote.sandore` 命名空间服务由 `$mount` 动态安装（不在本插件静态 inject 中，
  // self-mount + self-inject 会死锁）。用 `ctx.inject` 动态依赖注入：等命名空间服务
  // 就绪后（$mount 已完成）再注册依赖它的 slot，回调内的 `ctx.remote.sandore` 可正常访问。
  // 同时注入 `remote.commands`（权限命令执行/查询走 `remote.commands.execute`）。
  await ctx.inject(['remote.sandore', 'remote.commands'], (remoteCtx) => {
    const sandore = remoteCtx.remote.sandore

    // shell.overlay 全局工作流 UI（root scope，不挂会话；覆盖 conversation/details 列）。
    remoteCtx.slots.inject('shell.overlay', () => remoteCtx.slots.register({
      name: 'shell.overlay',
      id: 'sandore-overlay',
      order: 0,
      locale: NS,
      inject: (): WorkflowOverlayFace => ({
        listInstances: async () => unwrap(await sandore.listInstances()),
        listDefinitions: async () => unwrap(await sandore.listDefinitions()),
        startInstance: async (input) => unwrap(await sandore.startInstance(input)),
        listModelDirectory: async () => {
          const providers = unwrap(await sandore.listProviders())
          const entries = []
          for (const provider of providers) {
            const models = unwrap(await sandore.listModels(provider.id))
            entries.push({ provider: provider.id, providerName: provider.name, models: models.map((m) => ({ id: m.id, name: m.name })) })
          }
          return entries
        },
        pickDirectory: async () => {
          const workspaces = (remoteCtx as unknown as { workspaces: { pickDirectory(): Promise<string | null> } }).workspaces
          const path = await workspaces.pickDirectory()
          return path === null ? undefined : path
        },
        deleteDefinition: async (id: string) => unwrap(await sandore.deleteDefinition(id)),
        deleteInstance: async (instanceId: string) => unwrap(await sandore.deleteInstance(instanceId)),
        getYaml: async (id: string) => unwrap(await sandore.getYaml(id)),
        save: createSandoreSave(sandore as unknown as SandoreSaveRemote),
        remote: sandore as unknown as RunViewRemote,
        openSession: (id: string) => {
          closeWorkflowOverlay()
          // Round 20：completed 后 fork 会话已 dispose（live 移除），sessions.open 会抛
          // unknown session——容错兜底，不打断 overlay 关闭。
          try {
            remoteCtx.sessions.open(id as SessionId)
          } catch (error) {
            console.error('ui-sandore: openSession failed (session may be disposed)', error)
          }
        },
        // 模型目录：自实现轻量目录，直接走 connection.api.sessions.models/selectModel
        // （与 DSH ModelDirectory 同一 RPC、同一行为；不依赖会话 scope）。
        modelDirectory: (sessionId: string): ModelDirectoryFace => {
          const withConnection = remoteCtx as unknown as {
            connection: { api: { sessions: SessionModelsApi } }
          }
          return new SandoreModelDirectory(withConnection.connection.api.sessions, sessionId as SessionId)
        },
        // 权限投影：经 sessions.sessionOf(scope) 解析业务 Session，读其
        // projections.permissions（host 计算，可订阅）。
        permissions: (sessionId: string): ObservableFace<PermissionSelectValue | undefined> => {
          const sessions = remoteCtx.sessions as unknown as {
            scope(id: SessionId): unknown
            sessionOf(ctx: unknown): { projections: { faceOf(key: string): ObservableFace<unknown> } } | undefined
          }
          const scope = sessions.scope(sessionId as SessionId)
          if (scope === undefined) {
            return { getSnapshot: () => undefined, subscribe: () => () => undefined }
          }
          const session = sessions.sessionOf(scope)
          if (session === undefined) {
            return { getSnapshot: () => undefined, subscribe: () => () => undefined }
          }
          return session.projections.faceOf('permissions') as unknown as ObservableFace<PermissionSelectValue | undefined>
        },
        // 命令执行：走 DSH remote.commands（/permission 等与主 session 同一路径）。
        // DSH commands.execute(agent, line, images, signal) 需 3 参：client 侧传
        // SessionId（Gateway 自动解析为 Agent），纯命令无图片传空数组 []。
        runCommand: async (sessionId: string, line: string): Promise<boolean> => {
          const commands = (remoteCtx.remote as unknown as {
            commands: { execute(id: SessionId, line: string, images: readonly never[], signal?: AbortSignal): Promise<{ ok: boolean }> }
          }).commands
          const result = await commands.execute(sessionId as SessionId, line, [])
          return result.ok
        },
        // 权限投影缺失回退：`/permission`（无参）查询当前预设与可用列表。
        queryPermission: async (sessionId: string): Promise<PermissionSelectValue | undefined> => {
          const commands = (remoteCtx.remote as unknown as {
            commands: { execute(id: SessionId, line: string, images: readonly never[], signal?: AbortSignal): Promise<{ ok: boolean; value?: unknown }> }
          }).commands
          const result = await commands.execute(sessionId as SessionId, '/permission', [])
          if (!result.ok) return undefined
          const text = (result.value as { text?: string } | undefined)?.text
          if (text === undefined) return undefined
          return parsePermissionReport(text)
        },
      }),
    }, WorkflowOverlay))
  })
}
