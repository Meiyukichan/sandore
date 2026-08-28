/**
 * 宿主主代理的 setup 工厂（§3.0：宿主主代理 = 纯 DSH 默认主代理）。
 *
 * `createHostAgentSetup` 生成「同参同闭包」的 `AgentSetup` 回调，供宿主主代理的
 * `ctx.agents.create` 与 `ctx.agents.resume` 共用：回调内唯一动作是挂默认 agent
 * preset（系统提示词/skills/工具全进来），与工作区普通会话走同一组装路径。
 *
 * 实现对齐 apiproxy `composeAgent`（`packages/host/apiproxy/src/api-proxy.ts:1196`）：
 * `agentPresets` 服务从引擎 ctx `get` 后**闭包捕获**传入工厂（不在 setup 内直接访问
 * `agentCtx.agentPresets` 属性——agent scope Context 未声明该注入，属性访问会抛
 * `cannot get property "agentPresets" without inject`）；setup 内 `presets.mount(agentCtx)`
 * （无 id = 默认 preset）把 agent scope key 挂到默认 preset 的 standing mount。
 *
 * 不叠加任何 sandore 工具、不注入角色提示词（2026-08 探索定夺）：
 * - 引擎驱动执行、UI 走 RPC，8 个 `sandore_*` 编排工具没有"必需"消费场景（暂停/
 *   恢复/重试/状态都有按钮）；工具 schema 反而占模型上下文、暗示"你是编排器"。
 * - 角色提示词与 DSH 默认系统提示词并存会造成角色冲突（"通用助手" vs "编排器"）。
 * - 唯一必须保留的是 **`hostAgent` 引用**（不是注册！）：引擎用它的身份做
 *   `subagents.interrupt`/`followup` 的 authority/parent——DSH 机制要求，与工具注册无关。
 *
 * setup 只组合、不驱动（DSH「setup composes, never drives」），因此主代理创建后不会
 * 自动发送首轮 prompt，编排仍由引擎 `runInstance` 主循环驱动。
 * @module dsh-sandore/workflow/src/host-agent
 */
import type { AgentSetup } from '../microflow/subagents';

/** `ctx.agentPresets` 服务的最小面（由引擎 get 后传入工厂；签名对齐 DSH AgentPresets）。 */
export interface AgentPresetsSeam {
  /** 挂载 preset 组合到 agent scope（无 id = 默认 preset）。 */
  mount(agentCtx: unknown, id?: string): Promise<unknown>;
  /** 解析 preset（无 id = 默认），返回含 `id` 的 preset 对象。 */
  resolve(id?: string): Promise<{ readonly id: string }>;
}

/**
 * 创建宿主主代理 setup 回调的入参。
 */
export interface CreateHostAgentSetupOptions {
  /** 工作流实例 ID。 */
  readonly instanceId: string;
  /** `ctx.agentPresets` 服务（由引擎在 create 前 resolve 并传入；无 preset 部署时为 undefined）。 */
  readonly presets?: AgentPresetsSeam;
}

/**
 * 创建宿主主代理的 setup 回调（create 与 resume 共用，保证注册行为一致）。
 *
 * 返回的 `AgentSetup` 在 agent/session 发布前执行：挂载 DSH 默认 agent preset。
 * `presets` 服务缺失时（无 preset 部署）跳过 mount，与 apiproxy `composeAgent` 的
 * `presets === undefined` 分支一致。
 * @param options - 实例 ID 与（可选的）agentPresets 服务。
 * @returns 宿主主代理的 setup 回调。
 */
export function createHostAgentSetup(options: CreateHostAgentSetupOptions): AgentSetup {
  const { presets } = options;
  return async (agentCtx) => {
    if (presets === undefined) {
      return;
    }
    await presets.mount(agentCtx);
  };
}
