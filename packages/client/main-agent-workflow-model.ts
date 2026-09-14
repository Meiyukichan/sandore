/**
 * 主代理会话内「工作流」tab 的纯逻辑（**无 React、无 RPC**，便于单测）。
 *
 * ## 为什么单独成模块
 * 两个 WebUI 宿主（侧栏工作流页 vs 主代理会话内的 tab）共用**同一份** `RunView`，
 * 差别只有参数（`hostFilter` / `showDiscussionInput`）。参数里唯一有语义的那条就是
 * 「按哪个宿主会话过滤实例」——把它做成一个纯函数放在这里，单测不必渲染组件树即可
 * 钉死过滤语义；`RunView` 与 tab 注册层都只引用这一处判定，杜绝两份过滤逻辑漂移。
 *
 * ## 过滤键 = 实例 id
 * 引擎侧的恒等式是 `hostAgent.id ≡ 宿主会话 id ≡ instanceId`（AGENTS.md「实例身份恒等式」，
 * 见 `packages/workflow/workflow-engine.ts` 的 `startInstance`：`const hostSessionId = instanceId`）。
 * `InstanceSummary` 上**没有** `hostSessionId` 字段（`packages/workflow/wire.ts`），
 * 因此「属于哪个主代理会话」的唯一可靠键就是 `instanceId` 本身。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/main-agent-workflow-model
 */
import type { InstanceSummary } from '@meiyukichan/dsh-sandore/remote'

/**
 * 该实例是否绑定到宿主会话 `hostSessionId`。
 *
 * 入参用结构面（只读 `instanceId`）而非完整 `InstanceSummary`：调用面既有列表行，
 * 也可能只有 id，收窄成结构面后两处都能用，且不影响单测构造最小数据。
 * @param instance - 实例摘要（或任意带 `instanceId` 的行）。
 * @param hostSessionId - 宿主（主代理）会话 id；空值一律判否（不把「自己」认成别人）。
 * @returns 绑定返回 true。
 */
export function instanceBoundToHost(
  instance: { readonly instanceId: string },
  hostSessionId: string,
): boolean {
  if (hostSessionId === '') return false
  return instance.instanceId === hostSessionId
}

/**
 * 从实例清单里挑出属于 `hostSessionId` 的那一条（**只可能有一条**：实例 id 恒等于宿主
 * 会话 id，清单是 map 派生、键唯一）。
 *
 * 取第一条而不是「最后一条」：清单键唯一，多条只是异常输入；第一条让行为可预测
 * （按 `listInstances` 的返回顺序，确定性）。
 * @param instances - `listInstances()` 的返回。
 * @param hostSessionId - 宿主（主代理）会话 id。
 * @returns 命中行，未命中返回 undefined（调用方据此渲染空态）。
 */
export function hostBoundInstance(
  instances: readonly InstanceSummary[],
  hostSessionId: string,
): InstanceSummary | undefined {
  return instances.find(instance => instanceBoundToHost(instance, hostSessionId))
}
