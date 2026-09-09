/**
 * 子代理会话事件日志的版本适配读取（rc.1 适配）。
 *
 * 上游 dsh-session 0.1.2（含 0.1.2-rc.1）：`Session.events` 直读属性已删，读取
 * 全量快照的公开方法为 `Session.snapshotEvents()`；更早宿主（及测试 mock）仍暴露
 * `session.events` 数组。microflow 各消费点（step-runner / finalize-manager /
 * fork-session）统一经本 helper 读取：数组直通、缺省回退 `snapshotEvents()`、
 * 两者皆无返回空数组——保证迭代处永远拿到数组，杜绝
 * 「events is not iterable」类运行期崩溃。
 * @module @meiyukichan/dsh-sandore/microflow/src/session-events
 */

/** 会话对象的最小探测面（dsh Session / 测试 mock / 合成桩结构兼容）。 */
export interface SessionEventLogLike {
  /** 旧宿主/测试 mock 的直读事件数组（rc.1 起已删）。 */
  readonly events?: readonly unknown[]
  /** rc.1+ 的全量快照读取（dsh-session 0.1.2+）。 */
  readonly snapshotEvents?: () => readonly unknown[]
}

/**
 * 读取会话事件日志（恒返回数组；元素类型由调用方按上下文推断）。
 * @param session - 会话对象（可能为 undefined/桩）。
 * @returns 事件数组：`session.events`（数组时直通）→ `snapshotEvents()` → `[]`。
 */
export function sessionEventList<T = unknown>(
  session: SessionEventLogLike | null | undefined,
): readonly T[] {
  if (session === null || typeof session !== 'object') return []
  const direct = (session as { events?: unknown }).events
  if (Array.isArray(direct)) return direct as readonly T[]
  const snap = (session as { snapshotEvents?: unknown }).snapshotEvents
  if (typeof snap === 'function') {
    const snapshot = (snap as () => unknown)()
    return Array.isArray(snapshot) ? snapshot as readonly T[] : []
  }
  return []
}
