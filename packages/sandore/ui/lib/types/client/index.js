/** sandore Client UI 入口：挂载 sandore Remote 命名空间、注册 sidebar 工作流入口与 shell.overlay 全局工作流 UI。 */
import { sandoreRemote, unwrap } from "./remote.js";
import { en, NS, zh } from "./locales.js";
import { WorkflowButton } from "./WorkflowButton.js";
import { WorkflowOverlay } from "./WorkflowOverlay.js";
import { createSandoreSave } from "./sandore-save.js";
import { toggleWorkflowOverlay } from "./workflow-store.js";
import { DagStepNodeView } from "./DagStepNodeView.js";
import { sandoreStepDefinition } from "./sandore-step-definition.js";
import { SandoreModelDirectory, parsePermissionReport } from "./model-faces.js";
/** Client 插件依赖的 cordis 服务键。 */
export const inject = ['conversationEvents', 'slots', 'locale', 'remote', 'sessions', 'workspaces', 'connection'];
/** 挂载 sandore 远程命名空间、注册 locale 字典与工作流入口/overlay。 */
export async function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sandore: dictionaries');
    // 将 workflow 包生成的 Remote 贡献挂到 `ctx.remote`，使 `remote.sandore` 命名空间
    // 服务就绪；disposer 经 ctx.effect 绑定插件 fiber，卸载时自动逆序清理。
    const disposeRemote = await ctx.remote.$mount(sandoreRemote);
    ctx.effect(() => disposeRemote, 'ui-sandore: remote');
    // 注册 sandore-step 讨论节点 Definition（kind `sandore-step`、target `chat`），
    // 把 sandore/step-* 事件折叠为宿主会话的 Chat 节点（不依赖 `remote.sandore`）。
    ctx.conversationEvents.register(sandoreStepDefinition);
    // sidebar.footer.action 入口按钮：不依赖 remote，直接注册（点击切换 overlay 开关）。
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'sandore-btn',
        locale: NS,
        inject: () => ({ onToggleWorkflow: toggleWorkflowOverlay }),
    }, WorkflowButton));
    // `remote.sandore` 命名空间服务由 `$mount` 动态安装（不在本插件静态 inject 中，
    // self-mount + self-inject 会死锁）。用 `ctx.inject` 动态依赖注入：等命名空间服务
    // 就绪后（$mount 已完成）再注册依赖它的 slot，回调内的 `ctx.remote.sandore` 可正常访问。
    // 同时注入 `remote.commands`（权限命令执行/查询走 `remote.commands.execute`）。
    await ctx.inject(['remote.sandore', 'remote.commands'], (remoteCtx) => {
        const sandore = remoteCtx.remote.sandore;
        // shell.overlay 全局工作流 UI（root scope，不挂会话；覆盖 conversation/details 列）。
        remoteCtx.slots.inject('shell.overlay', () => remoteCtx.slots.register({
            name: 'shell.overlay',
            id: 'sandore-overlay',
            order: 0,
            locale: NS,
            inject: () => ({
                listInstances: async () => unwrap(await sandore.listInstances()),
                listDefinitions: async () => unwrap(await sandore.listDefinitions()),
                startInstance: async (input) => unwrap(await sandore.startInstance(input)),
                listModelDirectory: async () => {
                    const providers = unwrap(await sandore.listProviders());
                    const entries = [];
                    for (const provider of providers) {
                        const models = unwrap(await sandore.listModels(provider.id));
                        entries.push({ provider: provider.id, providerName: provider.name, models: models.map((m) => ({ id: m.id, name: m.name })) });
                    }
                    return entries;
                },
                pickDirectory: async () => {
                    const workspaces = remoteCtx.workspaces;
                    const path = await workspaces.pickDirectory();
                    return path === null ? undefined : path;
                },
                deleteDefinition: async (id) => unwrap(await sandore.deleteDefinition(id)),
                deleteInstance: async (instanceId) => unwrap(await sandore.deleteInstance(instanceId)),
                getYaml: async (id) => unwrap(await sandore.getYaml(id)),
                save: createSandoreSave(sandore),
                remote: sandore,
                openSession: (id) => { remoteCtx.sessions.open(id); },
                // 模型目录：自实现轻量目录，直接走 connection.api.sessions.models/selectModel
                // （与 DSH ModelDirectory 同一 RPC、同一行为；不依赖会话 scope）。
                modelDirectory: (sessionId) => {
                    const withConnection = remoteCtx;
                    return new SandoreModelDirectory(withConnection.connection.api.sessions, sessionId);
                },
                // 权限投影：经 sessions.sessionOf(scope) 解析业务 Session，读其
                // projections.permissions（host 计算，可订阅）。
                permissions: (sessionId) => {
                    const sessions = remoteCtx.sessions;
                    const scope = sessions.scope(sessionId);
                    if (scope === undefined) {
                        return { getSnapshot: () => undefined, subscribe: () => () => undefined };
                    }
                    const session = sessions.sessionOf(scope);
                    if (session === undefined) {
                        return { getSnapshot: () => undefined, subscribe: () => () => undefined };
                    }
                    return session.projections.faceOf('permissions');
                },
                // 命令执行：走 DSH remote.commands（/permission 等与主 session 同一路径）。
                runCommand: async (sessionId, line) => {
                    const commands = remoteCtx.remote.commands;
                    const result = await commands.execute(sessionId, line);
                    return result.ok;
                },
                // 权限投影缺失回退：`/permission`（无参）查询当前预设与可用列表。
                queryPermission: async (sessionId) => {
                    const commands = remoteCtx.remote.commands;
                    const result = await commands.execute(sessionId, '/permission');
                    if (!result.ok)
                        return undefined;
                    const text = result.value?.text;
                    if (text === undefined)
                        return undefined;
                    return parsePermissionReport(text);
                },
            }),
        }, WorkflowOverlay));
        // conversation.chat.node sandore-step 节点渲染器（宿主会话 chat 页展示 step 节点）。
        remoteCtx.slots.inject('conversation.chat.node', () => remoteCtx.slots.register({
            name: 'conversation.chat.node',
            key: 'sandore-step',
            locale: NS,
            inject: () => ({
                openSession: (id) => { remoteCtx.sessions.open(id); },
                retryStep: async (input) => { unwrap(await sandore.retryStep(input)); },
            }),
        }, DagStepNodeView));
    });
}
//# sourceMappingURL=index.js.map