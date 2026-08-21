/**
 * StepSessionChat 的模块级宿主访问（单插件单实例的实用简化）。
 *
 * `StepSessionChat` 需要 DSH 运行时服务（sessions / slots / workspaces / locale），
 * 但时间线组件树（WorkflowOverlay → EditorPane → RunView → UnifiedTimeline）不携带
 * cordis ctx。为避免把宿主逐层透传 4 个组件，这里在插件 apply 时把服务子集存入
 * 模块级单例，卸载时清除（`ctx.effect` 绑定 fiber）。sandore 是 cordis.yml 单行
 * 挂载的单实例插件，模块级状态与实例一一对应，可接受；多实例/HMR 场景由
 * install/dispose 配对保证不串台。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-session-chat-host
 */
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ObservableSnapshot, SessionBinding, SessionId, SessionListState,
} from '@deepseek-ai/dsh-client-runtime/client'

/** `ctx.slots` 的最小读面（renderSlot 派发所需；SlotRegistry 结构兼容）。 */
export interface StepChatSlotsFace {
  /** 单/keyed/list 的逐 cell 胜者；chain 原样透传。 */
  entriesOfSlot(key: string): readonly unknown[]
  /** 原始注册条目（chain 选举用；SlotRegistry.entries）。 */
  entries(key: string): readonly unknown[]
  /** 声明规格（kind/scope + 可选 spec 级 inject）。 */
  spec(key: string): { readonly kind: 'single' | 'list' | 'keyed' | 'chain'; readonly scope: string; readonly inject?: object } | undefined
  /** 订阅 slot 注册变更（uSES subscribe 侧）。 */
  subscribe(key: string, fn: () => void): () => void
  /** 单调版本号（uSES getSnapshot 侧）。 */
  getVersion(key: string): number
}

/** StepSessionChat 需要的宿主服务子集（apply 时从 ctx 提取）。 */
export interface StepChatHost {
  /** sessions 服务最小面。 */
  sessions: {
    /** 会话列表源（useSessions 标准钩子的数据源）。 */
    list: ObservableSnapshot<SessionListState>
    /** 解析会话 binding（SessionBinding.session 为订阅面）。 */
    binding(id: SessionId): SessionBinding | undefined
    /** fork 源会话（ChatView forkAt 用）。 */
    fork(opts: { sessionId: SessionId; atSeq?: number; increaseTitle?: boolean }): Promise<SessionId>
    /** 打开会话（fork 子会话落地后跳转）。 */
    open(id: SessionId): void
  }
  /** slots 服务读面（keyed renderSlot 派发）。 */
  slots: StepChatSlotsFace
  /** workspaces 服务最小面（ChatView openFile 落点）。 */
  workspaces: {
    openPath(path: string): Promise<void>
  }
  /** locale 服务面：bind 出翻译函数 + 修订号可订阅（切换语言时重渲染）。 */
  locale: {
    getSnapshot(): { revision: number }
    subscribe(fn: () => void): () => void
  }
  /** locale 服务 bind（conversation 命名空间 t 座）。 */
  bindLocale(ns: string): Translate
}

let current: StepChatHost | undefined

/**
 * 安装宿主（apply 时经 ctx.effect 调用）。
 * @param host - 从 ctx 提取的服务子集。
 * @returns disposer：插件卸载时清除（避免残留引用串台）。
 */
export function installStepChatHost(host: StepChatHost): () => void {
  current = host
  return () => {
    if (current === host) current = undefined
  }
}

/** 读取宿主（未安装/已卸载返回 undefined，组件渲染降级占位）。 */
export function getStepChatHost(): StepChatHost | undefined {
  return current
}
