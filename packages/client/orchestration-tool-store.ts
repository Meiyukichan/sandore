/**
 * orchestration-tool-store.ts：`sandore_workflow_run` / `sandore_workflow_control` 工具行
 * 内嵌导航 UI 的**实时实例状态**模块级 store（零新 RPC：复用运行页同一条
 * `getInstanceState` + `/sandore/events` SSE 通道）。
 *
 * ## 为什么需要它
 * 工具行渲染在**会话面板**里（主代理卡片的 tool-call 行），而面板组件树不携带 cordis
 * ctx（与本仓库既有的 `installStepChatSessions` / `installStepChatInstance` 同因）。
 * 因此沿用同一套「模块级持有 + 安装/卸载配对」风格：`index.ts` 在 apply 期把运行页那份
 * remote 面安装进来，工具行组件按 `instanceId` 订阅。
 *
 * ## 刷新策略（三条来源，去重合并）
 * 1. 首次订阅 → 立即拉一次；
 * 2. `/sandore/events` SSE 任意事件 → 短去抖（{@link SSE_DEBOUNCE_MS}）后刷新**已订阅**的实例
 *    （事件载荷里没有稳定的实例过滤面，且同一时刻可见的工具行只有个位数，全刷最稳）；
 * 3. 实例仍非终态 → 低频兜底轮询（{@link POLL_MS}），终态后停表（与 RunView 同款口径）。
 *
 * 无订阅者时彻底停表并删除条目（面板滚出窗口 / 卸载不留后台请求）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/orchestration-tool-store
 */
import { subscribeSandoreSse } from './sandore-sse.ts'
import {
  orchestrationNavOf,
  orchestrationNavSignature,
  type OrchestrationNavModel,
} from './orchestration-tool-model.ts'

/** SSE 事件到达后的短去抖（同一批事件常连着来；避免一帧打多个 RPC）。 */
export const SSE_DEBOUNCE_MS = 300

/** 非终态实例的兜底轮询间隔（SSE 断线时仍能推进；终态后停表）。 */
export const POLL_MS = 4000

/** 工具行渲染所需的 remote 面（与 `RunViewRemote` 的子集同形）。 */
export interface OrchestrationToolRemote {
  /** 实例状态快照（`RemoteResult<WorkflowTaskState>`；解包由 store 负责）。 */
  getInstanceState(instanceId: string): Promise<unknown>
}

/** 安装面（`index.ts` 在 apply 期给）。 */
export interface OrchestrationToolFaces {
  readonly remote: OrchestrationToolRemote
}

/** 一个实例的订阅快照（`useSyncExternalStore` 的取值面；引用稳定）。 */
export type OrchestrationInstanceSnapshot =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string; readonly nav?: OrchestrationNavModel | undefined }
  | { readonly kind: 'ready'; readonly nav: OrchestrationNavModel }

/** 一个实例的订阅条目。 */
interface Entry {
  snapshot: OrchestrationInstanceSnapshot
  signature: string
  readonly listeners: Set<() => void>
  timer: ReturnType<typeof setInterval> | undefined
  inflight: boolean
}

/** 当前安装的 faces（未安装 = 工具行只显示默认文本结果，不渲染导航）。 */
let faces: OrchestrationToolFaces | undefined
/** 实例 id → 订阅条目。 */
const entries = new Map<string, Entry>()
/** SSE 去抖计时器（全局一个）。 */
let sseTimer: ReturnType<typeof setTimeout> | undefined
/** faces 安装时的 SSE 退订（无订阅者时保持连接由 sandore-sse 自身引用计数管理）。 */
let unsubscribeSse: (() => void) | undefined

/** 实例状态是否仍在推进（未知状态按「仍在推进」处理，保守）。 */
function isLive(status: string): boolean {
  return status === '' || status === 'running' || status === 'pending' || status === 'interacting'
    || status === 'paused' || status === 'ready' || status === 'blocked'
}

/** 解包 `RemoteResult`（`ok:false` 抛；与 remote.ts 的 unwrap 同语义，避免相互依赖）。 */
function unwrapState(result: unknown): unknown {
  if (result !== null && typeof result === 'object' && 'ok' in result) {
    const record = result as { readonly ok?: unknown; readonly value?: unknown; readonly error?: { readonly message?: unknown } }
    if (record.ok === false) {
      throw new Error(typeof record.error?.message === 'string' ? record.error.message : 'getInstanceState failed')
    }
    return record.value
  }
  return result
}

/** 通知一个实例的订阅者（用当前快照）。 */
function emit(entry: Entry): void {
  for (const listener of [...entry.listeners]) {
    try {
      listener()
    } catch (error) {
      console.error('ui-sandore: orchestration tool listener failed', error)
    }
  }
}

/** 写入快照（签名相同 → 复用旧对象，保证 uSES 快照引用稳定）。 */
function commit(instanceId: string, entry: Entry, next: OrchestrationInstanceSnapshot, signature: string): void {
  const changed = signature !== entry.signature || next.kind !== entry.snapshot.kind
    || (next.kind === 'error' && entry.snapshot.kind === 'error' && next.message !== entry.snapshot.message)
  entry.snapshot = changed || next.kind !== 'ready'
    ? next
    : entry.snapshot
  entry.signature = signature
  if (changed) emit(entry)
}

/** 刷新一个实例的状态快照（并发去重：同一实例同时只允许一个在飞请求）。 */
async function refresh(instanceId: string): Promise<void> {
  const entry = entries.get(instanceId)
  if (entry === undefined || entry.inflight || faces === undefined) return
  entry.inflight = true
  try {
    const state = unwrapState(await faces.remote.getInstanceState(instanceId))
    const current = entries.get(instanceId)
    if (current !== entry) return
    const nav = orchestrationNavOf(state)
    commit(instanceId, entry, { kind: 'ready', nav }, orchestrationNavSignature(nav))
  } catch (error) {
    const current = entries.get(instanceId)
    if (current !== entry) return
    commit(instanceId, entry, { kind: 'error', message: error instanceof Error ? error.message : String(error) }, `error:${String(error)}`)
  } finally {
    entry.inflight = false
  }
}

/** 维护低频兜底轮询：只要还有「非终态」的已订阅实例就开着，全终态则停表。 */
function syncPoll(instanceId: string, entry: Entry): void {
  const live = entry.snapshot.kind !== 'ready' || isLive(entry.snapshot.nav.status)
  const shouldPoll = live && entry.listeners.size > 0
  if (shouldPoll && entry.timer === undefined) {
    entry.timer = setInterval(() => { void refresh(instanceId) }, POLL_MS)
  } else if (!shouldPoll && entry.timer !== undefined) {
    clearInterval(entry.timer)
    entry.timer = undefined
  }
}

/** SSE 去抖刷新（一次性覆盖所有已订阅实例）。 */
function scheduleSseRefresh(): void {
  if (sseTimer !== undefined) return
  sseTimer = setTimeout(() => {
    sseTimer = undefined
    for (const instanceId of [...entries.keys()]) void refresh(instanceId)
  }, SSE_DEBOUNCE_MS)
}

/**
 * 安装 faces（`index.ts` 的 apply 期调用；同一时刻只允许一份，重复安装先撤旧的）。
 * @param next - 运行页同款 remote 面（`getInstanceState`）。
 * @returns disposer：撤下 faces、清空全部订阅与计时器。
 */
export function installOrchestrationToolFaces(next: OrchestrationToolFaces): () => void {
  uninstallOrchestrationToolFaces()
  faces = next
  unsubscribeSse = subscribeSandoreSse(() => { scheduleSseRefresh() })
  return () => { uninstallOrchestrationToolFaces() }
}

/** 撤下 faces（幂等；测试隔离也用）。 */
export function uninstallOrchestrationToolFaces(): void {
  faces = undefined
  unsubscribeSse?.()
  unsubscribeSse = undefined
  if (sseTimer !== undefined) {
    clearTimeout(sseTimer)
    sseTimer = undefined
  }
  for (const entry of entries.values()) {
    if (entry.timer !== undefined) clearInterval(entry.timer)
  }
  entries.clear()
}

/**
 * 订阅一个实例的导航快照（工具行挂载时调用；首个订阅者触发拉取与轮询）。
 * @param instanceId - 工作流实例 id。
 * @param listener - 变更回调（`useSyncExternalStore` 的 subscribe）。
 * @returns 退订函数（最后一个订阅者退订时停表并删条目）。
 */
export function subscribeOrchestrationInstance(instanceId: string, listener: () => void): () => void {
  let entry = entries.get(instanceId)
  if (entry === undefined) {
    entry = { snapshot: { kind: 'loading' }, signature: '', listeners: new Set(), timer: undefined, inflight: false }
    entries.set(instanceId, entry)
  }
  entry.listeners.add(listener)
  if (faces !== undefined && entry.signature === '') void refresh(instanceId)
  syncPoll(instanceId, entry)
  return () => {
    const current = entries.get(instanceId)
    if (current === undefined) return
    current.listeners.delete(listener)
    if (current.listeners.size > 0) {
      syncPoll(instanceId, current)
      return
    }
    if (current.timer !== undefined) clearInterval(current.timer)
    entries.delete(instanceId)
  }
}

/**
 * 立刻刷新一个实例的快照（无订阅者/未安装 faces 时是空操作）。
 *
 * 用途：需要**立即**取新快照的调用方——SSE 去抖路径内部用的是同一个函数；工具行的
 * 「暂停/继续」结果到达后也可以直接调它，不必等下一轮事件/轮询。
 * @param instanceId - 工作流实例 id。
 * @returns 刷新完成（失败已折叠成 error 快照，不抛）。
 */
export async function refreshOrchestrationInstance(instanceId: string): Promise<void> {
  await refresh(instanceId)
}

/**
 * 读取一个实例的导航快照（`useSyncExternalStore` 的 getSnapshot；未订阅 → undefined）。
 * @param instanceId - 工作流实例 id。
 * @returns 快照（引用稳定：无变化时是同一个对象）。
 */
export function orchestrationInstanceSnapshot(instanceId: string): OrchestrationInstanceSnapshot | undefined {
  return entries.get(instanceId)?.snapshot
}

/** 清空 store（单测隔离用；生产路径由各订阅者退订配对清理）。 */
export function clearOrchestrationToolStore(): void {
  uninstallOrchestrationToolFaces()
}
