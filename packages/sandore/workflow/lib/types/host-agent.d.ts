/**
 * 宿主主代理的 setup 工厂。
 *
 * `createHostAgentSetup` 生成「同参同闭包」的 `AgentSetup` 回调，供宿主主代理的
 * `ctx.agents.create` 与 `ctx.agents.resume` 共用：回调内经 `agentCtx.tools.register`
 * 逐个注册 {@link createSandoreTools} 返回的 8 个 `sandore_*` 工具（每个工具闭包捕获
 * 该实例的 `instanceId`），并经 `agentCtx.systemPrompt.section` 注入编排器角色说明。
 * setup 只组合、不驱动（DSH「setup composes, never drives」），因此主代理创建后不会
 * 自动发送首轮 prompt，编排仍由引擎 `runInstance` 主循环驱动。
 * @module @deepseek-ai/dsh-sandore-workflow/src/host-agent
 */
import type { AgentSetup } from '@deepseek-ai/dsh-sandore-microflow/src/subagents';
import type { SandoreEngineSurface } from './engine-surface.ts';
/** 创建宿主主代理 setup 回调的入参。 */
export interface CreateHostAgentSetupOptions {
    /** 工作流实例 ID（每个工具 execute 闭包捕获）。 */
    readonly instanceId: string;
    /** 工作流引擎实例（工具逻辑全部转调其方法）。 */
    readonly engine: SandoreEngineSurface;
}
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
export declare function createHostAgentSetup(options: CreateHostAgentSetupOptions): AgentSetup;
//# sourceMappingURL=host-agent.d.ts.map