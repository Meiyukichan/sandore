/**
 * 创建宿主主代理的 setup 回调（create 与 resume 共用，保证注册行为一致）。
 *
 * 返回的 `AgentSetup` 在 agent/session 发布前执行：挂载 DSH 默认 agent preset。
 * `presets` 服务缺失时（无 preset 部署）跳过 mount，与 apiproxy `composeAgent` 的
 * `presets === undefined` 分支一致。
 * @param options - 实例 ID 与（可选的）agentPresets 服务。
 * @returns 宿主主代理的 setup 回调。
 */
export function createHostAgentSetup(options) {
    const { presets } = options;
    return async (agentCtx) => {
        if (presets === undefined) {
            return;
        }
        await presets.mount(agentCtx);
    };
}
//# sourceMappingURL=host-agent.js.map