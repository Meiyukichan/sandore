/**
 * 宿主主代理的 setup 工厂（§3.0：宿主主代理 = 纯 DSH 默认主代理 + 模型选择装配）。
 *
 * `createHostAgentSetup` 生成「同参同闭包」的 `AgentSetup` 回调，供宿主主代理的
 * `ctx.agents.create` 与 `ctx.agents.resume` 共用，回调内两件事（顺序对齐 DSH
 * `api/session-controller/src/agent.ts:383-387` 的 `composeAgent`）：
 * ① 装 **agent-scoped 模型选择**（{@link installHostModelSelection}）；② 挂默认 agent
 * preset（系统提示词/skills/工具全进来），与工作区普通会话走同一组装路径。
 *
 * 实现对齐 apiproxy `composeAgent`（`packages/host/apiproxy/src/api-proxy.ts:1196`）：
 * `agentPresets` 服务从引擎 ctx `get` 后**闭包捕获**传入工厂（不在 setup 内直接访问
 * `agentCtx.agentPresets` 属性——agent scope Context 未声明该注入，属性访问会抛
 * `cannot get property "agentPresets" without inject`）；setup 内 `presets.mount(agentCtx)`
 * （无 id = 默认 preset）把 agent scope key 挂到默认 preset 的 standing mount。
 *
 * **为什么必须装模型选择（2026-09 入口归一后的硬前提）**：归一后宿主主代理必须自己
 * 跑 turn 去调 `sandore_workflow_run`。DSH 在 `agent-loop/src/agent.ts:444-485` 的
 * `buildRequest` 里，每个 step 的 provider/model 由 `agent/request` waterfall 解析，
 * **空即抛** `agent "<id>" has no provider/model`（错误被 loop 归一为 turn 级 error，
 * 不进 stderr——表面现象就是「什么都没发生」）。基线路由只有两个来源：
 * ① create/resume 的 `AgentOptions`（`agent.ts:460 this.options.provider/model`）；
 * ② `agent/request` waterfall 的改写（DSH 官方改写点即 `installModelSelection`）。
 * 两者缺一，宿主会话的 turn 就永远起不来（实例停在 pending、`executedSteps: []`）。
 *
 * 不叠加任何 sandore 工具、不注入角色提示词（2026-08 探索定夺）：
 * - 引擎驱动执行、UI 走 RPC，编排工具由全局注册提供（`host-tools.ts`），不需要在
 *   宿主会话的 preset 里再注册一份。
 * - 角色提示词与 DSH 默认系统提示词并存会造成角色冲突（"通用助手" vs "编排器"）。
 * - 唯一必须保留的是 **`hostAgent` 引用**（不是注册！）：引擎用它的身份做
 *   `subagents.interrupt`/`followup` 的 authority/parent——DSH 机制要求，与工具注册无关。
 *
 * setup 只组合、不驱动（DSH「setup composes, never drives」）——但注入协作上下文
 * （架构决策 4）由引擎在 `startInstance` 末尾显式 followup 完成，不在此处。
 * @module @meiyukichan/dsh-sandore/workflow/src/host-agent
 */
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
// `ReasoningEffortId` 是 dsh-llm 的 brand 构造器（`brand.ts:62-63`，恒等 brand），
// 与 DSH `api/session-controller/src/agent.ts:527` 对持久化选择重新 brand 的做法一致。
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';

import type { AgentSetup, AgentSetupContext } from '../microflow/subagents';

/** `ctx.agentPresets` 服务的最小面（由引擎 get 后传入工厂；签名对齐 DSH AgentPresets）。 */
export interface AgentPresetsSeam {
  /** 挂载 preset 组合到 agent scope（无 id = 默认 preset）。 */
  mount(agentCtx: unknown, id?: string): Promise<unknown>;
  /** 解析 preset（无 id = 默认），返回含 `id` 的 preset 对象。 */
  resolve(id?: string): Promise<{ readonly id: string }>;
}

/**
 * `ctx.agentDefaultModel` 服务的最小面（签名对齐 DSH `AgentDefaultModel.currentSelection`）。
 *
 * 部署级「新建会话默认模型」：既是宿主会话 `AgentOptions` 的来源（基线路由），也是
 * 会话还没有任何选择时的兜底（DSH `api/session-controller/src/agent.ts:291` 同款）。
 */
export interface AgentDefaultModelSeam {
  /** 当前默认模型选择（provider + model + 可选 reasoningEffort）。 */
  currentSelection(): ModelSelection;
}

/**
 * `ctx.sessionProjections` 服务的最小面（只用到 `stateOf`）。
 *
 * 读 `modelSelection` 投影（DSH `api/session-controller/src/model-selection-projection.ts`：
 * `pending` = 用户在本会话里选的「下一个请求用哪个模型」，由 `model/selection` 会话事件
 * 更新；`lastUsed` 由 `request/header` 事件更新）。
 */
export interface SessionProjectionsSeam {
  stateOf(session: unknown, key: string): { pending?: unknown; lastUsed?: unknown } | undefined;
}

/** 宿主会话模型选择的注入面（由引擎从自身 ctx 解析后传入，服务缺失时字段为 undefined）。 */
export interface HostModelSelectionDeps {
  /** 部署级默认模型（缺失 = 无默认，宿主会话拿不到基线路由）。 */
  readonly defaults?: AgentDefaultModelSeam | undefined;
  /** 会话投影注册表（缺失 = 读不到用户在本会话里选的模型，退化为默认模型）。 */
  readonly projections?: SessionProjectionsSeam | undefined;
}

/**
 * 读宿主会话应当使用的模型选择（引擎用于 `agents.create`/`agents.resume` 的 `AgentOptions`）。
 *
 * 与 DSH `api/session-controller/src/agent.ts:488-491 private agentOptions()` 同义：
 * 取 `agentDefaultModel.currentSelection()` 的 provider/model（可选带 reasoningEffort）。
 * 服务缺失（最小桩部署 / 单测）时返回 undefined——此时不传 `agentOptions`，宿主会话
 * 的 turn 会因「no provider/model」起不来（与修复前行为一致，但不抛错、不改变既有路径）。
 * @param deps - 默认模型服务访问面。
 * @returns `AgentOptions` 形状的模型路由，或服务缺失时为 undefined。
 */
export function resolveHostAgentOptions(deps: HostModelSelectionDeps): ModelSelection | undefined {
  const selection = deps.defaults?.currentSelection();
  if (selection === undefined) {
    return undefined;
  }
  // 空串等于没有路由（DSH 的 agent.ts:483 判的是 falsy）：与其塞 `{provider:'',model:''}`
  // 不如不传，语义完全相同且不会在日志里伪装成「配了模型」。
  if (selection.provider === '' || selection.model === '') {
    return undefined;
  }
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  };
}
/** 校验任意值是合法模型选择（投影里读到的是持久化 JSON，字段可能缺失/被旧数据污染）。 */
function asModelSelection(value: unknown): ModelSelection | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as { provider?: unknown; model?: unknown; reasoningEffort?: unknown };
  if (typeof candidate.provider !== 'string' || candidate.provider === ''
    || typeof candidate.model !== 'string' || candidate.model === '') {
    return undefined;
  }
  return {
    provider: candidate.provider,
    model: candidate.model,
    ...(typeof candidate.reasoningEffort !== 'string' || candidate.reasoningEffort === ''
      ? {}
      : { reasoningEffort: ReasoningEffortId(candidate.reasoningEffort) }),
  };
}

/** 读会话已记录的 `request/header` 路由（DSH `Session.requestHeader()`；接缝不建模故结构化取）。 */
function loggedRoute(agent: unknown): ModelSelection | undefined {
  const session = (agent as { session?: { requestHeader?: () => unknown } } | undefined)?.session;
  const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined;
  if (header === null || typeof header !== 'object') {
    return undefined;
  }
  const record = header as {
    config?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown };
    adapterDefaults?: { reasoningEffort?: unknown };
  };
  const config = record.config;
  if (config === undefined || typeof config.provider !== 'string' || typeof config.model !== 'string') {
    return undefined;
  }
  // 适配器默认出来的 effort 不是「用户选择」：按 DSH 同款规则丢弃（否则未改默认也会读成一次变更）。
  const effort = record.adapterDefaults?.reasoningEffort === true ? undefined : config.reasoningEffort;
  return {
    provider: config.provider,
    model: config.model,
    ...(typeof effort !== 'string' || effort === '' ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
  };
}

/**
 * 装 agent-scoped 模型选择（对齐 DSH `api/session-controller/src/agent.ts:276-319
 * selectionFor()` 的取值链，供本引擎直接创建的宿主会话使用）。
 *
 * 为什么需要：DSH 的会话模型切换走 `session-controller` 的 `selectForNextRequest`
 * → `selectionFor(agent)` → `installModelSelection(agent.ctx, ref)`；而宿主会话是引擎
 * 用 `ctx.agents.create` 直接建的，**没有经过 controller**，所以必须由本插件自己装上
 * 同款选择，DSH 客户端的模型切换（`model/selection` → `agent/request`）才会对宿主会话
 * 生效（纯 `AgentOptions` 只够让第一个 turn 起来，不能支持后续换模型）。
 *
 * 取值链（与 DSH 完全一致，故两个装法并存时也不会互相打架——都读同一份持久事实）：
 * ① 会话投影 `modelSelection.pending`（用户在本会话选的“下一个请求用哪个模型”）；
 * ② 会话已记录的 `request/header` 路由（上一次实际用的）；
 * ③ `agentDefaultModel.currentSelection()`（部署默认）。
 *
 * 容错：投影服务缺失 / 投影未注册（`stateOf` 返回 undefined）/ agentCtx 不是真正的
 * cordis scope（单测最小桩）时，逐级降级；`installModelSelection` 本身抛错也只 warn
 * 不阻断 setup（宿主会话至少还能靠 `AgentOptions` 起 turn）。
 * @param agentCtx - setup 期的 agent scope 上下文（真实 DSH 为 cordis Context）。
 * @param deps - 默认模型/投影服务访问面。
 * @returns disposer（撤销两个 scoped 监听器），失败时为 no-op。
 */
export function installHostModelSelection(agentCtx: AgentSetupContext, deps: HostModelSelectionDeps): () => void {
  const session = (agentCtx as { agent?: { session?: unknown } }).agent?.session;
  const ref: ModelSelectionRef = {
    get current(): ModelSelection | undefined {
      const pending = asModelSelection(deps.projections?.stateOf(session, 'modelSelection')?.pending);
      if (pending !== undefined) {
        return pending;
      }
      return loggedRoute((agentCtx as { agent?: unknown }).agent) ?? deps.defaults?.currentSelection();
    },
    set current(next: ModelSelection | undefined) {
      // 引擎不消费外部写入（写入方是 DSH controller 自己的 selection 实例）；
      // 保留 setter 以满足 `ModelSelectionRef` 的可变契约（等价于丢弃）。
      void next;
    },
    assembled: undefined,
  };
  try {
    return installModelSelection(agentCtx as unknown as Parameters<typeof installModelSelection>[0], ref);
  } catch (error) {
    void error;
    return () => {};
  }
}

/**
 * 创建宿主主代理 setup 回调的入参。
 */
export interface CreateHostAgentSetupOptions extends HostModelSelectionDeps {
  /** 工作流实例 ID。 */
  readonly instanceId: string;
  /** `ctx.agentPresets` 服务（由引擎在 create 前 resolve 并传入；无 preset 部署时为 undefined）。 */
  readonly presets?: AgentPresetsSeam;
}

/**
 * 创建宿主主代理的 setup 回调（create 与 resume 共用，保证注册行为一致）。
 *
 * 顺序对齐 DSH `composeAgent`：先装模型选择（{@link installHostModelSelection}），
 * 再挂 preset。`presets` 服务缺失时（无 preset 部署）跳过 mount。
 * @param options - 实例 ID、模型选择服务面与（可选的）agentPresets 服务。
 * @returns 宿主主代理的 setup 回调。
 */
export function createHostAgentSetup(options: CreateHostAgentSetupOptions): AgentSetup {
  const { presets } = options;
  const selectionDeps: HostModelSelectionDeps = {
    defaults: options.defaults,
    projections: options.projections,
  };
  return async (agentCtx) => {
    // ① agent-scoped 模型选择（宿主会话必须自己跑 turn，见文件头「为什么必须装模型选择」）。
    installHostModelSelection(agentCtx, selectionDeps);
    // ② 默认 preset（系统提示词/skills/工具全进来）；同参同闭包 → create/resume 行为一致。
    if (presets === undefined) {
      return;
    }
    await presets.mount(agentCtx);
  };
}
