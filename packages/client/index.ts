/** sandore Client UI 入口：挂载 sandore Remote 命名空间、注册 locale 字典，装配工作流 face 并自挂载侧栏入口 + 中心列内嵌视图（非 slot 渲染机，对齐 taskboard 交互）。 */

import type { ClientContext, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { sandoreRemote, unwrap } from './remote.ts'
import type { DeleteEntryResult } from '@meiyukichan/dsh-sandore/types'
import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import { en, NS, zh } from './locales.ts'
import type { WorkflowOverlayFace } from './workflow-face.ts'
import type { RunViewRemote } from './RunView.tsx'
import { createSandoreSave, type SandoreSaveRemote } from './sandore-save.ts'
import { closeWorkflowOverlay } from './workflow-store.ts'
import { bridgeModelDirectory, parsePermissionReport, type ModelDirectoryFace, type ObservableFace, type PermissionSelectValue } from './model-faces.ts'
import { installOrchestrationToolFaces } from './orchestration-tool-store.ts'
import { registerOrchestrationToolViews } from './orchestration-tool-view.tsx'
// 主代理会话内的「工作流」tab：注册进 DSH `conversation.view`（会话 header 的原生 tab 条，
// 与 Chat / Trajectory 同一形态），面板体复用同一份 RunView（只改两个参数）。
import { registerMainAgentWorkflowTab } from './main-agent-workflow-tab.tsx'
import { openStepChatSessionInHost, type StepChatHostSessionsLike } from './step-chat-source.ts'
import { installStepChatSessions, installStepChatWorkspaces } from './StepChatPanel.tsx'
// 需求 2（呈现层统一）：`@step` 结构化引用**全部退役**——下面两处装配（mention source 注册
// 进 DSH 的 `inputTriggers`、触发词菜单控制器安装）已**删除**：
// - `step-mention-source.ts`（`createStepMentionSource` / `registerStepMentionSource`）
// - `step-view/composer-trigger-menu.ts`（`installStepComposerTriggers`）
// 两个模块连同 `step-view/ComposerTriggerMenu.tsx` 逐字保留，作为**未挂载的恢复入口**
// （文件头已注明），但本插件不再注册/安装它们，`@` 菜单因此不再出现（运行页输入壳也不传
// sessionId ⇒ ComposerBar 内不解析控制器 ⇒ 菜单不挂载）。用户改用自然语言让主代理调用
// 引擎侧的 `sandore_workflow_send_message` 工具。
import { clearSeatBridge, installSeatBridge, type SeatLocaleLike, type WorkspaceSourceLike } from './seat-bridge.ts'
// 【权宜之计，勿当常规实现】DSH 原生会话页「空 turn 的 turn-tail 空白行」抑制。
// 详见该文件头：DSH 侧 `tail === null` 是死代码、正确修法在上游，而本仓库禁止改 DSH 源码。
import { installDshNativeTurnTailSuppression } from './dsh-native-turn-tail.ts'
import { mountSidebarSeat } from './sidebar-seat.ts'
import { mountWorkflowSeatView } from './view-seat.tsx'

/** Client 插件依赖的 cordis 服务键（硬依赖）。uiWorkspace/modelDirectories 由可选
 *  插件（ui-workspace/ui-model-selection）提供，改经 ctx.get 动态解析 + 占位降级——
 *  不进硬 inject，避免非 web-app profile 缺插件时整个插件永久 waiting。 */
export const inject = ['slots', 'locale', 'remote', 'sessions', 'workspaces']

/** 挂载 sandore 远程命名空间、注册 locale 字典，装配 face 并自挂载工作流席位。 */
export async function apply(ctx: ClientContext): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sandore: dictionaries')

  // 【权宜之计】DSH 原生会话页里「空 turn 的 turn-tail 行」不占位（用户真机「一堆空白行」）。
  // 为什么不放在引擎侧：空 turn 由 DSH 的 `notifySettlement`（无条件投递）与「turn/start 先于
  // pre-step」共同产生，引擎无法阻止；而空行照旧渲染是 DSH `TurnTailNodeView` 的死代码所致。
  // 本仓库不许改 DSH 源码 → 只注入一条样式规则顶上。**上游修好后请连同
  // `dsh-native-turn-tail.ts` 与本行一起删除**（退出条件见该文件头）。
  ctx.effect(() => installDshNativeTurnTailSuppression(), 'ui-sandore: workaround empty turn-tail')

  // 将 workflow 包生成的 Remote 贡献挂到 `ctx.remote`，使 `remote.sandore` 命名空间
  // 服务就绪；disposer 经 ctx.effect 绑定插件 fiber，卸载时自动逆序清理。
  const disposeRemote = await ctx.remote.$mount(sandoreRemote)
  ctx.effect(() => disposeRemote, 'ui-sandore: remote')

  // 安装 StepChatPanel 的模块级 sessions 持有（运行中 step 内嵌子代理消息面板
  // 需要 `sessions.binding(childId)` 订阅会话快照；时间线组件树不携带 ctx，故经
  // 模块级单例注入，卸载时由 ctx.effect 清除）。
  ctx.effect(() => installStepChatSessions(ctx.sessions), 'ui-sandore: step-chat-sessions')
  // 文件路径打开（tool 行 fileLink）：rc.1 宿主 IWorkspaces **没有** openPath
  // （openPath 属后续 DSH 版本的服务面）——结构探测：缺失时不注入，面板 fileLink
  // 静默降级（getStepChatWorkspaces 已有 undefined 分支），不 TypeError。
  const hostOpenPath = (ctx.workspaces as unknown as { openPath?: (path: string) => Promise<void> }).openPath
  ctx.effect(() => installStepChatWorkspaces(
    hostOpenPath === undefined ? undefined : { openPath: path => hostOpenPath(path) },
  ), 'ui-sandore: step-chat-workspaces')

  // 需求 2（呈现层统一）：`@step` 提及源与触发词菜单的装配**已删除**（见文件头 import
  // 处的注释）——这里不再 `ctx.inject(['inputTriggers'], …)`、也不再
  // `installStepComposerTriggers(…)`：本插件对 DSH 输入触发词管线的注册面归零，
  // `@step` 候选菜单（运行页 / step 面板两处）随之不可达。两个模块仍逐字保留为**未挂载的
  // 恢复入口**（文件头已注明）。

  // `remote.sandore` 命名空间服务由 `$mount` 动态安装（不在本插件静态 inject 中，
  // self-mount + self-inject 会死锁）。用 `ctx.inject` 动态依赖注入：等命名空间服务
  // 就绪后（$mount 已完成）再装配依赖它的 face，回调内的 `ctx.remote.sandore` 可正常
  // 访问。同时注入 `remote.commands`（权限命令执行/查询走 `remote.commands.execute`）。
  await ctx.inject(['remote.sandore', 'remote.commands'], (remoteCtx) => {
    // 模型目录：DSH 的 `ctx.modelDirectories`（ui-model-selection 的 ModelDirectoryResolver）
    // 是 **caller-tracked** 服务——它内部要访问 `remote.session` / `sessions`，cordis 会按
    // 「**调用方 ctx** 是否声明了这些注入」来放行。本插件若直接 `ctx.get('modelDirectories')`
    // 再调 `directoryFor()`，运行期会抛 `cannot get property "remote.session" without inject`
    // （真机实证：模型席位因此被降级占位、触发器隐藏）。故这里用一个**声明了这些注入的
    // 子 ctx** 作为调用方，把它的 `modelDirectories` 交给 face（调用时仍以该 ctx 寻址）。
    let modelCtx: { modelDirectories?: { directoryFor(sessionId: string): unknown } } | undefined
    ctx.inject(['modelDirectories', 'remote.session', 'sessions'] as never, (injected: unknown) => {
      modelCtx = injected as typeof modelCtx
      return () => { modelCtx = undefined }
    })
    const sandore = remoteCtx.remote.sandore
    // workspaces 服务（DSH 标准服务）：list（工作区快照可观察，自挂载树的
    // useWorkspaces 等价源）。目录浏览/选择能力在 rc.1 宿主位于 `ctx.uiWorkspace`
    // （UiWorkspaceService：pickDirectory/listDirectory/createDirectory）——
    // `ctx.workspaces`（IWorkspaces）只承载工作区快照，**没有**目录 API。
    const workspaces = (remoteCtx as unknown as {
      workspaces: { list?: WorkspaceSourceLike }
    }).workspaces
    const reader = remoteCtx as { get(name: string): unknown }
    // uiWorkspace（目录三件套）/modelDirectories 属可选插件（ui-workspace /
    // ui-model-selection）服务：动态解析，缺失时 face 走占位/可读错误，不让插件
    // 在 cordis waiting 卡死（占位降级逻辑与硬 inject 不再自相矛盾）。
    const uiWorkspace = reader.get('uiWorkspace') as {
      pickDirectory(): Promise<string | null>
      listDirectory(path?: string, signal?: AbortSignal): Promise<import('@deepseek-ai/dsh-client-runtime/client').DirectoryListing>
      createDirectory(path: string, name: string): Promise<string>
    } | undefined

    // 工作流业务 face：与旧 shell.overlay slot 条目的 inject 工厂同内容（RPC 已解包），
    // 零逻辑改动，仅从 slot 注入改为安装进 seat-bridge。
    const face: WorkflowOverlayFace = {
      listInstances: async () => unwrap(await sandore.listInstances()),
      listDefinitions: async () => unwrap(await sandore.listDefinitions()),
      startInstance: async (input) => unwrap(await sandore.startInstance(input)),
      // 三级分离：Step / Microflow 库（RPC 已解包；删除转发 deleted 布尔）。
      listSteps: async () => unwrap(await sandore.listSteps()),
      getStep: async (id: string) => unwrap(await sandore.getStep({ id })),
      upsertStep: async (yaml: string) => unwrap(await sandore.upsertStep({ yaml })),
      deleteStep: async (id: string) => unwrap<DeleteEntryResult>(await sandore.deleteStep({ id })).deleted,
      listMicroflows: async () => unwrap(await sandore.listMicroflows()),
      getMicroflow: async (id: string) => unwrap(await sandore.getMicroflow({ id })),
      upsertMicroflow: async (yaml: string) => unwrap(await sandore.upsertMicroflow({ yaml })),
      deleteMicroflow: async (id: string) => unwrap<DeleteEntryResult>(await sandore.deleteMicroflow({ id })).deleted,
      listModelDirectory: async () => {
        // unwrap 泛型在此无上下文类型锚定（成员是宽松的 remote 命名空间面），
        // 显式标注 LlmProviderInfo/LlmModelInfo 让 providers/models 保持精确类型。
        const providers: LlmProviderInfo[] = unwrap(await sandore.listProviders())
        const entries = []
        for (const provider of providers) {
          const models: LlmModelInfo[] = unwrap(await sandore.listModels(provider.id))
          entries.push({ provider: provider.id, providerName: provider.name, models: models.map((m) => ({ id: m.id, name: m.name })) })
        }
        return entries
      },
      pickDirectory: async () => {
        if (uiWorkspace === undefined) throw new Error('目录选择不可用：宿主未装配 ui-workspace 插件')
        const path = await uiWorkspace.pickDirectory()
        return path === null ? undefined : path
      },
      listDirectory: (path, signal) => {
        if (uiWorkspace === undefined) return Promise.reject(new Error('目录浏览不可用：宿主未装配 ui-workspace 插件'))
        return uiWorkspace.listDirectory(path, signal)
      },
      createDirectory: (path, name) => {
        if (uiWorkspace === undefined) return Promise.reject(new Error('目录浏览不可用：宿主未装配 ui-workspace 插件'))
        return uiWorkspace.createDirectory(path, name)
      },
      deleteDefinition: async (id: string) => unwrap(await sandore.deleteDefinition(id)),
      importDefinition: async (yaml: string) => unwrap(await sandore.importDefinitionFromYaml({ yaml })),
      deleteInstance: async (instanceId: string) => unwrap(await sandore.deleteInstance(instanceId)),
      getYaml: async (id: string) => unwrap(await sandore.getYaml(id)),
      save: createSandoreSave(sandore as unknown as SandoreSaveRemote),
      // RunView 的统一 RPC 面（两个宿主共用同一份）。
      //
      // 为什么是**显式转发对象**而不是 `sandore` 本身 / `Object.assign(sandore, …)`：
      // cordis 注入给我们的 `remote.sandore` 是它的 **reactive proxy**，`set` 陷阱会拒绝
      // 新增属性（真机实证：`'set' on proxy: trap returned falsish for property
      // 'listInstances'` ⇒ 整个 client 插件加载失败、侧栏入口都不出现）。而
      // `RunViewRemote` 现在多要一个 `listInstances`（主代理会话 tab 的 `hostFilter`
      // 模式按宿主会话认领实例）。故这里**不改动** proxy，改成一张只列 RunView 真正
      // 需要的 RPC 的普通对象（属性读取与既有各处一样，走 `sandore.<method>(…)`，
      // 不丢 receiver）。
      remote: {
        listInstances: () => sandore.listInstances(),
        getInstanceState: instanceId => sandore.getInstanceState(instanceId),
        // `stageId` 是**可选**参数：typert 描述符只声明 1 个入参，显式传 `undefined`
        // 也算 2 个实参 → 真机 `sandore/getArtifacts expected 1 argument(s), got 2`。
        // 故按「有/无」两分支调用，绝不把 undefined 当实参递出去。
        getArtifacts: (instanceId, stageId) => (stageId === undefined
          ? sandore.getArtifacts(instanceId)
          : sandore.getArtifacts(instanceId, stageId)),
        abortInstance: instanceId => sandore.abortInstance(instanceId),
        pauseAll: input => sandore.pauseAll(input),
        resumeAll: input => sandore.resumeAll(input),
        pauseStep: input => sandore.pauseStep(input),
        resumeStep: input => sandore.resumeStep(input),
        retryStep: input => sandore.retryStep(input),
        listRevertBoundaries: input => sandore.listRevertBoundaries(input),
        sendStepMessage: input => sandore.sendStepMessage(input),
        replyQuestion: input => sandore.replyQuestion(input),
        rejectQuestion: input => sandore.rejectQuestion(input),
        replyPermission: input => sandore.replyPermission(input),
        updateInstancePermissionMode: input => sandore.updateInstancePermissionMode(input),
      } satisfies RunViewRemote,
      // step 标题 / 面板「打开原生会话」统一入口：**打开与历史加载用同一个 durable 地址**
      // （真机缺陷修复：普通 open 会把 subagent 地址清掉，导致「历史加载失败：
      //  subagent Sessions require their durable parent address」——详见
      //  step-chat-source.ts 的 `openStepChatSessionInHost` 注释）。
      openSession: (id: string, parentSessionId?: string) => {
        closeWorkflowOverlay()
        openStepChatSessionInHost(
          remoteCtx.sessions as unknown as StepChatHostSessionsLike,
          {
            childSessionId: id,
            ...(parentSessionId === undefined ? {} : { parentSessionId }),
          },
        )
      },
      // 模型目录：动态解析宿主 `ctx.modelDirectories`（ui-model-selection，与 DSH 主会话
      // 同一目录/同一 selectModel RPC）；resolver 用函数形式每次现取（服务/会话晚出现
      // 时 bridge 自愈）；宿主未装配该插件时返回占位目录（渲染不崩、选择器隐藏）。
      // 调用方必须是**声明了 modelDirectories/remote.session/sessions 注入的子 ctx**
      // （见上方 `modelCtx` 注释：否则 cordis 以「without inject」拒绝）。
      modelDirectory: (sessionId: string): ModelDirectoryFace =>
        bridgeModelDirectory(
          () => ({ modelDirectories: modelCtx?.modelDirectories }),
          sessionId as string,
        ),
      // 权限投影：经 sessions.sessionOf(scope) 解析业务 Session，读其
      // projections.permissions（host 计算，可订阅）。client B：scope 可晚于组件
      // 挂载出现——getSnapshot 每次现查解析，会话出现后下一次读取即返回真实投影
      // （选择器自愈出现）；订阅转发 host face（就绪后收到投影更新事件）。
      permissions: (sessionId: string): ObservableFace<PermissionSelectValue | undefined> => {
        const sessions = remoteCtx.sessions as unknown as {
          scope(id: SessionId): unknown
          sessionOf(ctx: unknown): { projections: { faceOf(key: string): ObservableFace<unknown> } } | undefined
        }
        const resolve = (): ObservableFace<PermissionSelectValue | undefined> | undefined => {
          const scope = sessions.scope(sessionId as SessionId)
          if (scope === undefined) return undefined
          const session = sessions.sessionOf(scope)
          if (session === undefined) return undefined
          return session.projections.faceOf('permissions') as unknown as ObservableFace<PermissionSelectValue | undefined>
        }
        return {
          getSnapshot: () => resolve()?.getSnapshot(),
          subscribe: (fn) => {
            const live = resolve()
            return live === undefined ? () => {} : live.subscribe(fn)
          },
        }
      },
      // 命令执行：走 DSH remote.commands（/permission 等与主 session 同一路径）。
      // DSH commands.execute(agent, line, images, signal) 需 3 参：client 侧传
      // SessionId（Gateway 自动解析为 Agent），纯命令无图片传空数组 []。
      // rc.1 语义：unmatched 命令 = ok:true + value:undefined（session.command 以
      // value!==undefined 判 matched）——成功须同时校验 value 存在，避免「假成功」。
      runCommand: async (sessionId: string, line: string): Promise<boolean> => {
        const commands = (remoteCtx.remote as unknown as {
          commands: { execute(id: SessionId, line: string, images: readonly never[], signal?: AbortSignal): Promise<{ ok: boolean; value?: unknown }> }
        }).commands
        const result = await commands.execute(sessionId as SessionId, line, [])
        return result.ok && result.value !== undefined
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
    }

    // 工具行内嵌「工作流导航」（用户需求：run / control 三个工具的调用行里，除默认文本
    // 结果外还要有 UI，直接用工作流导航那套）——面板组件树不携带 ctx，故与
    // installStepChatSessions 同法安装模块级 faces：这里给运行页同一份 remote
    // （getInstanceState），实时性由 orchestration-tool-store 自己接 sandore/* SSE。
    ctx.effect(
      () => installOrchestrationToolFaces({
        remote: sandore as unknown as { getInstanceState(instanceId: string): Promise<unknown> },
      }),
      'ui-sandore: orchestration tool faces',
    )
    // **DSH 原生工具行**（主代理会话页）里的同一张卡：注册进 ui-tool 的 keyed slot
    // `tool.call.toolview`（key = wire 工具名）。命中即**替换**该行的通用卡片，故注册视图
    // 自带默认结果渲染（见 orchestration-tool-view.tsx 文件头）。
    registerOrchestrationToolViews(ctx)
    // **主代理会话内的「工作流」tab**：注册进 DSH `conversation.view`（会话 header 的 tab 条，
    // 与 Chat/Trajectory 同一形态与视觉）。面板体 = 同一份 RunView，只传
    // `hostFilter`（按宿主会话 id 过滤实例）+ `showDiscussionInput={false}`（tab 里没有输入面）。
    registerMainAgentWorkflowTab(ctx)
    // 席位装配（对齐 taskboard：官方 slot 系统在导航区/中心列无插口，见
    // docs/design/taskboard-parity-plan.md §2.2）——face/locale/workspaces 注入
    // 模块级单例桥，再挂侧栏入口与中心列内嵌视图；效果逆序清理。
    const disposers: Array<() => void> = []
    installSeatBridge(face, remoteCtx.locale as unknown as SeatLocaleLike, workspaces.list)
    disposers.push(mountSidebarSeat())
    disposers.push(mountWorkflowSeatView())
    ctx.effect(() => () => {
      for (const dispose of disposers.splice(0).reverse()) dispose()
      clearSeatBridge()
    }, 'ui-sandore: seat mounts')
  })
}
