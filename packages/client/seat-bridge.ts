/**
 * seat-bridge：自挂载工作流视图（非 slot 渲染机）所需的三个模块级单例：
 * face（业务 RPC）、locale t（与 slot 同源的 ctx.locale.bind）、workspaces 源。
 *
 * 自挂载组件树（view-seat 经 createRoot 渲染）拿不到 slot 注入 props，统一经本
 * 模块在 apply 期间注入、组件运行时经 hooks 读取（StepChatPanel 的 install 同款
 * 模式）。locale 侧订阅 LocaleRuntime 的快照通知：每次变更 bump 内部 revision 并
 * 转发给组件订阅者——`bind(NS)` 返回的翻译函数引用稳定（调用时读当前语言），
 * revision 变化驱动整树重渲染后文本即新语言（与 slot 渲染机同一信号源）。
 * @module @meiyukichan/dsh-sandore/src/client/seat-bridge
 */
import { useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'

import { NS } from './locales.ts'
import type { WorkflowOverlayFace } from './workflow-face.ts'

/** workspaces 服务 list 的可观察形状（避免为类型引入新 peer 依赖）。 */
export interface WorkspaceSourceLike {
  /** 读取引用稳定的当前快照。 */
  getSnapshot(): { items: readonly WorkspaceView[]; archivedSessionIds?: readonly string[] }
  /** 订阅快照失效；返回退订函数。 */
  subscribe(fn: () => void): () => void
}

/** locale 服务的可观察 + bind 形状（运行时即 LocaleRuntime 的窄面）。 */
export interface SeatLocaleLike {
  /** 绑定命名空间翻译函数（同一 ns 稳定引用，调用时读当前语言）。 */
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string
  /** 订阅 locale 快照变更（语言切换 / 字典注册）；返回退订函数。 */
  subscribe(fn: () => void): () => void
}

let face: WorkflowOverlayFace | undefined
let locale: SeatLocaleLike | undefined
let workspaceSource: WorkspaceSourceLike | undefined
let uninstallLocale: (() => void) | undefined
/** 模块级缓存 bind(NS) 结果（clear/install 时重置，防跨插件生命周期串台）。 */
let boundT: ((key: string, params?: Record<string, unknown>) => string) | undefined
/** locale 快照修订计数：install/clear/locale 变更时递增，驱动 useSyncExternalStore。 */
let revision = 0
const listeners = new Set<() => void>()

/** 通知全部组件侧订阅者（face / locale revision 的失效信号）。 */
function notify(): void {
  for (const fn of [...listeners]) fn()
}

/** 订阅桥变化（face 替换、locale revision 递增）；返回退订函数。 */
export function subscribeSeat(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * 安装单例（幂等：重装先清旧引用与旧 locale 订阅）。
 * @param value - 工作流业务 face（index.ts 装配）。
 * @param localeLike - `ctx.locale` 的窄面（bind + subscribe）。
 * @param workspaces - `ctx.workspaces.list` 可观察源；宿主缺服务时传 undefined。
 */
export function installSeatBridge(
  value: WorkflowOverlayFace,
  localeLike: SeatLocaleLike,
  workspaces: WorkspaceSourceLike | undefined,
): void {
  clearSeatBridge()
  face = value
  locale = localeLike
  workspaceSource = workspaces
  uninstallLocale = localeLike.subscribe(() => {
    revision += 1
    notify()
  })
  revision += 1
  notify()
}

/** 清除单例与 locale 订阅（apply 的 ctx.effect 清理时调用；幂等）。 */
export function clearSeatBridge(): void {
  uninstallLocale?.()
  uninstallLocale = undefined
  face = undefined
  locale = undefined
  workspaceSource = undefined
  boundT = undefined
  revision += 1
  notify()
}

// ── 组件侧读取 ──────────────────────────────────────────────────────────────

/** 读取已安装的 face（未安装返回 undefined；供非 hook 场景使用）。 */
export function getSeatFace(): WorkflowOverlayFace | undefined {
  return face
}

/** face 订阅 hook（bridge 未就绪时组件降级渲染 null）。 */
export function useSeatFace(): WorkflowOverlayFace | undefined {
  return useSyncExternalStore(subscribeSeat, getSeatFace)
}

/**
 * locale revision 订阅 hook：与 slot 渲染机同一信号（LocaleRuntime 快照通知），
 * 切换语言 / 字典注册时整树重渲染。
 */
export function useSeatLocaleRevision(): number {
  return useSyncExternalStore(subscribeSeat, () => revision)
}

/** 工作区快照 items 选择 hook（等价 slot 注入的 useWorkspaces；空源回落 []）。 */
export function useSeatWorkspaces(): readonly WorkspaceView[] {
  return useSyncExternalStore(subscribeWorkspaces, getWorkspacesItems)
}

/** 模块级空数组：getSnapshot 必须返回引用稳定值（uSES 缓存要求）。 */
const EMPTY_WORKSPACES: readonly WorkspaceView[] = []

/** uSES subscribe 稳定引用：读模块全局源，避免内联箭头导致每次渲染退订/重订。 */
function subscribeWorkspaces(fn: () => void): () => void {
  const unsubscribe = workspaceSource?.subscribe(fn)
  return () => { unsubscribe?.() }
}

/** uSES getSnapshot 稳定引用：源快照的 items（源保证引用稳定）或模块级空数组。 */
function getWorkspacesItems(): readonly WorkspaceView[] {
  return workspaceSource?.getSnapshot().items ?? EMPTY_WORKSPACES
}

/**
 * 命名空间翻译函数：模块级缓存 `bind(NS)` 结果（LocaleRuntime 对同一 ns 返回
 * 稳定引用，调用时读当前语言；文本随 {@link useSeatLocaleRevision} 的重渲染刷新）。
 * bridge 未安装时返回恒等回退（键原样返回），绝不抛错。
 */
export function seatT(): TranslateNS<'sandore'> {
  if (boundT === undefined && locale !== undefined) boundT = locale.bind(NS)
  const translate = boundT ?? ((key: string) => key)
  return translate
}
