import { createSandoreTools } from '@deepseek-ai/dsh-sandore-tool/src/index';
/** 编排器角色说明的 system prompt section 名。 */
const HOST_SECTION_NAME = 'sandore-host';
/** 编排器角色说明的 system prompt section 顺序（工具指引用 100–199）。 */
const HOST_SECTION_ORDER = 116;
/** 编排器角色说明文本（含 completed 后自然降级语义）。 */
const HOST_SECTION_TEXT = '你是 sandore 工作流编排器主代理：通过 sandore_* 工具编排工作流实例的执行、暂停/恢复、重试与状态查询。' +
    '实例进入 completed 终态后，resume/retry/pause 类工具对已完成实例返回无害 no-op，getState 始终可用。';
/**
 * 创建宿主主代理的 setup 回调（create 与 resume 共用，保证注册行为一致）。
 *
 * 返回的 `AgentSetup` 在 agent/session 发布前执行：注册 8 个 `sandore_*` 工具
 * （闭包捕获 `instanceId`）并注入编排器角色 system prompt section。同一组
 * `options` 生成的 setup 行为一致，供 `agents.create` 与冷恢复的 `agents.resume`
 * 复用。
 * @param options - 实例 ID 与引擎实例。
 * @returns 宿主主代理的 setup 回调。
 */
export function createHostAgentSetup(options) {
    const { instanceId, engine } = options;
    return (agentCtx) => {
        for (const tool of createSandoreTools({ instanceId, engine })) {
            agentCtx.tools.register(tool);
        }
        agentCtx.systemPrompt.section({
            name: HOST_SECTION_NAME,
            order: HOST_SECTION_ORDER,
            text: HOST_SECTION_TEXT,
        });
    };
}
//# sourceMappingURL=host-agent.js.map