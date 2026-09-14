/**
 * cordis 服务的安全读取（可选依赖语义）。
 *
 * 背景（**真实 e2e 暴露的生产崩溃**，jsdom 单测无法覆盖）：`binding.ctx` 是 sandore
 * 自己的 cordis scoped ctx，而 cordis 对**未在 `inject` 里声明**的服务做属性读会抛
 * `cannot get property "conversation" without inject`。此前 `composer-bar.ts` /
 * `dsh-composer.ts` 都用
 * ```ts
 * (ctx as { conversation?: unknown }).conversation
 * ```
 * 直读 conversation —— 在 jsdom 桩里是普通对象、读不出事；在真实席位里 render 期即抛，
 * 被席位 error boundary 接住 → 整个 RunView 被替换成 DSH 原生对话列（`[data-sandore-run-view]`
 * 卸载），面板与输入框全部消失。
 *
 * 本插件不能把 `conversation` 放进 `inject`：它是**可选**的探测目标（旧宿主 / 非会话
 * scope / 宿主 HMR 卸载后都必须降级为只读面板），声明成硬依赖会让插件一直等它。
 *
 * 读取顺序：
 * 1. `ctx.get(name)` —— cordis 官方显式读取方式，不要求 `inject`，不会因「未声明」而抛；
 * 2. 回退属性读（jsdom 单测的桩 ctx 是普通对象、没有 `get`），并 `try/catch` 兜住
 *    cordis 的未注入抛错。
 *
 * 任何异常（含 ctx 不是对象）都归一为「无值」，由调用方按不可用降级——**渲染期绝不抛**。
 *
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/scope-service
 */

/**
 * 读取 scoped ctx 上的服务（`ctx.get()` 优先，属性读回退；永不抛）。
 *
 * @param ctx - 任意候选 scoped ctx（非对象一律视为无值）。
 * @param name - 服务名（如 `'conversation'`）。
 * @returns 服务对象；不可用时为 `undefined`。
 */
export function readScopeService(ctx: unknown, name: string): unknown {
  if (typeof ctx !== 'object' || ctx === null) return undefined
  try {
    // 读 `ctx.get` 这一步本身也可能抛（Proxy 陷阱）→ 整体兜住后落到属性读。
    const getter = (ctx as { readonly get?: unknown }).get
    if (typeof getter === 'function') {
      try {
        const viaGet = (getter as (key: string) => unknown).call(ctx, name)
        if (viaGet !== undefined && viaGet !== null) return viaGet
      } catch {
        // 部分宿主的 get 只解析已声明依赖 → 落到属性读再试一次。
      }
    }
  } catch {
    // 忽略：getter 读取失败时属性读是唯一退路。
  }
  try {
    // cordis 未注入服务的属性读在此抛错（正是本模块存在的理由）→ 归一为无值。
    return (ctx as Record<string, unknown>)[name]
  } catch {
    return undefined
  }
}
