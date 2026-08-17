/** sandore Client UI 入口：挂载 sandore Remote 命名空间并注册 sidebar.footer.action 工作流按钮。 */
import { sandoreRemote, unwrap } from "./remote.js";
import { en, NS, zh } from "./locales.js";
import { createSandoreSave } from "./sandore-save.js";
import { createOpenDiscussion } from "./open-discussion.js";
import { WorkflowButton } from "./WorkflowButton.js";
import { DagStepNodeView } from "./DagStepNodeView.js";
import { sandoreStepDefinition } from "./sandore-step-definition.js";
/** Client 插件依赖的 cordis 服务键。 */
export const inject = ['conversationEvents', 'slots', 'locale', 'remote', 'sessions', 'workspaces'];
/** 挂载 sandore 远程命名空间、注册 locale 字典与工作流入口按钮。 */
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sandore: dictionaries');
    // 将 workflow 包生成的 Remote 贡献挂到 `ctx.remote`，使 `ctx.remote.sandore.*`
    // 命名空间就绪；disposer 经 ctx.effect 绑定插件 fiber，卸载时自动逆序清理。
    ctx.effect(() => ctx.remote.$mount(sandoreRemote), 'ui-sandore: remote');
    // 注册 sandore-step 讨论节点 Definition（kind `sandore-step`、target `chat`）。
    ctx.conversationEvents.register(sandoreStepDefinition);
    const sandore = {
        ping: async () => unwrap(await ctx.remote.sandore.ping()),
        listInstances: async () => unwrap(await ctx.remote.sandore.listInstances()),
        listDefinitions: async () => unwrap(await ctx.remote.sandore.listDefinitions()),
        deleteDefinition: async (id) => unwrap(await ctx.remote.sandore.deleteDefinition(id)),
        save: createSandoreSave(ctx.remote.sandore),
        openDiscussion: (instanceId) => createOpenDiscussion(ctx.sessions, instanceId),
        remote: ctx.remote.sandore,
    };
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'sandore-btn',
        locale: NS,
        inject: () => sandore,
    }, WorkflowButton));
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node',
        key: 'sandore-step',
        locale: NS,
        inject: () => ({
            openSession: (id) => { ctx.sessions.open(id); },
            retryStep: async (input) => { unwrap(await ctx.remote.sandore.retryStep(input)); },
        }),
    }, DagStepNodeView));
}
//# sourceMappingURL=index.js.map