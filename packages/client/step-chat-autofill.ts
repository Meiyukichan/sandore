/**
 * step-chat-autofill：内嵌会话面板的「自动补齐完整历史」驱动（批 A2）。
 *
 * 背景（批 A 之后的事实）：面板首屏只拿到 DSH 会话加载窗（一页 50 条），长会话
 * `hasMore === true` → 按官方折叠语义整列**不折叠**（`historyIncomplete`，见
 * StepChatPanel 的 `stepChatProcessSeatOf` 接线）——观众看到的是「一大片未折叠的
 * 尾部消息 + 一个手动『加载更早』按钮」。批 A2 把「完整消息」做成默认体验：面板
 * 可见时自动连续 `loadOlder()` 直到窗口补齐；补齐后 `hasMore === false` → 折叠
 * 语义自动恢复官方行为（进程折叠条回来），手动按钮随之消失。
 *
 * 本模块是**框架无关的驱动**（不 import React / DOM，可在 node 环境单测）：
 * - 输入只有一个端口工厂 `portsOf()`：驱动**每轮**（而非每次渲染）重新读取「触发门
 *   + 分页状态 + 补页能力」，所以面板侧的闭包恒读到最新快照，驱动本身也不必绑在
 *   渲染次数上（会话切换由面板 dispose + 重建实例承担）；
 * - 触发门是纯函数 `stepChatAutofillAllowedOf`：binding 就绪 + 面板可见 +
 *   `openState === 'open'` + 无错误态 + `hasMore`（任一条不满足即不补齐）；
 * - 每轮之间 `await settle()`（面板实现为「让出一帧，隐藏标签页时定时器兜底」）：
 *   prepend 落地、快照发布完成之后才决定下一页，避免并发重复投递（另有
 *   `loadingOlder` 悬挂等待 + 页数上限兜底）；
 * - 终止原因：`complete`（hasMore === false）/ `limit`（页数上限）/ `failed`
 *   （退避耗尽）/ `gate`（门关闭——可见性/openState 恢复后由面板再次 trigger）/
 *   `stalled`（loadingOlder 长期悬挂，别的通道占着）/ `disposed`（卸载/换会话）；
 * - `limit` 与 `failed` 会**闩锁**：`trigger()` 不再自动重启，把选择权交回手动
 *   「加载更早」按钮（按钮仍在——门只要求 hasMore）；只有 dispose 后重建实例才
 *   清除闩锁。这保证「上限/失败」不会变成无界重试。
 * - 卸载守卫（generation）：`dispose()` 置位终止标记、自增纪元、取消在飞的退避
 *   定时器；所有 await 之后都要重新检查终止标记，故卸载/换会话后不可能再投递。
 *
 * 保位不在本模块内：面板把「量 scrollHeight → loadOlder → rAF 按 ΔscrollHeight
 * 补偿 scrollTop」整段作为 `loadOlder` 端口传进来（批 A 的 prepend 保位纯函数
 * `stepChatPrependScrollTopOf`，见 step-chat-paging.ts），自动与手动走同一条路径，
 * 自动补齐因此和手动点击一样不推走读者视线。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-chat-autofill
 */

import type { StepChatPagingState } from './step-chat-paging.ts'

/**
 * 自动补齐的**页数上限**（一页 = DSH 会话加载窗的 50 条 → 上限即 500 条）。
 *
 * 为什么是 10 页：面板是「step 卡片里的内嵌预览」，不是会话主页——每次
 * `loadOlder()` 都会把更早一页的**全部节点**装配进内存（节点 + ChatSnapshot +
 * 行 DOM），无上限补齐会让超长会话（数百轮）在运行视图里驻留整段历史：内存与
 * 首屏补齐耗时都随页数线性上涨。10 页是我们实测（rc.1 宿主 + 长会话）里
 * 「观感已完整、内存/时间可接受」的折中：补齐 500 条后仍打开就继续加载的
 * 长会话，用户仍可手动点「加载更早」逐页续看（上限只约束**自动**补齐）。
 */
export const STEP_CHAT_AUTOFILL_MAX_PAGES = 10

/**
 * 失败退避序列（毫秒）；每次失败取下一跳，序列耗尽仍失败 → 停止自动补齐。
 *
 * 1s 给瞬态失败（host 忙/网络抖动）一个几乎无感的恢复窗口；3s 是第二轮也是最后
 * 一轮——再失败就说明不是瞬态（宿主拒绝、会话已 disposed），继续自动重试只会把
 * 用户的注意力钉在一个不会成功的动作上，故停止并把「加载更早」按钮留给用户。
 */
export const STEP_CHAT_AUTOFILL_RETRY_DELAYS_MS: readonly number[] = [1000, 3000]

/**
 * `loadingOlder` 悬挂时的等待轮数上限（每轮 = 一次 settle，面板约一帧）。
 *
 * `loadingOlder` 为真表示**别的通道**（手动按钮/上一页）正在飞：本驱动不重复
 * 投递，只等一拍再看。正常情况一拍就放行；宿主异常把该标记卡住时（永不复位）
 * 不能无限空转，超过此轮数即判 `stalled` 停止——提示行消失，手动按钮仍在。
 */
export const STEP_CHAT_AUTOFILL_MAX_INFLIGHT_WAITS = 120

/** 自动补齐的触发门（纯数据；面板每轮经 `readGate()` 重读一份）。 */
export interface StepChatAutofillGate {
  /** binding 已就绪（面板拿到会话绑定，能读快照、能 loadOlder）。 */
  readonly bindingReady: boolean
  /**
   * 面板容器可见。面板用 IntersectionObserver 观测自己的滚动视口；宿主没有稳定
   * 可见性信号时（无 IntersectionObserver 的非浏览器宿主）面板恒传 true——
   * 「挂载即开始」，见 StepChatPanel 的可见性 effect 注释。
   */
  readonly visible: boolean
  /** 会话开窗态：只有 `'open'` 允许补齐（cold/loading/error 都不补齐）。 */
  readonly openState: string
  /** 错误态（快照 openError 非空）：带错即不补齐，等自愈/重试改变开窗态。 */
  readonly failed: boolean
  /** 当拍分页状态（`hasMore` 是补齐的驱动量，`loadingOlder` 是并发守卫）。 */
  readonly paging: StepChatPagingState
}

/**
 * 触发门判定（纯函数）：五条全部满足才允许自动补齐。
 * @param gate - 当拍门数据（面板经 `readGate()` 从会话快照 + 可见性装配）。
 * @returns 是否允许发起/继续自动补齐。
 */
export function stepChatAutofillAllowedOf(gate: StepChatAutofillGate): boolean {
  return gate.bindingReady
    && gate.visible
    && gate.openState === 'open'
    && !gate.failed
    && gate.paging.hasMore
}

/** 自动补齐的停止原因（诊断/单测；同一实例上为最后一次停止的原因）。 */
export type StepChatAutofillStopReason =
  /** 窗口补齐（hasMore === false）：目标达成，折叠语义恢复官方行为。 */
  | 'complete'
  /** 页数上限：停止自动补齐，手动按钮仍在（闩锁，不自动重启）。 */
  | 'limit'
  /** 退避序列耗尽仍失败：停止自动补齐，手动按钮仍在（闩锁，不自动重启）。 */
  | 'failed'
  /** 门关闭（不可见/非 open/错误态）：可见性恢复后面板会再次 trigger()。 */
  | 'gate'
  /** `loadingOlder` 悬挂超过等待上限（别的通道占着）：停止并交出控制权。 */
  | 'stalled'
  /** 实例已 dispose（卸载/会话切换）：一切在飞结果作废。 */
  | 'disposed'

/** 可取消的定时器（`schedule` 端口的返回值；dispose/停止时必须取消）。 */
export interface StepChatAutofillTimer {
  /** 取消定时回调（幂等语义由实现保证）。 */
  cancel(): void
}

/**
 * 定时器工厂端口（缺省 `setTimeout`）。单测注入手动泵即可完全确定性地驱动
 * 「失败 → 退避 → 重试」路径，不必依赖假定时器与真实宏任务交错。
 */
export type StepChatAutofillScheduler = (run: () => void, delayMs: number) => StepChatAutofillTimer

/** 驱动端口（面板装配；每轮经 `portsOf()` 重新取值）。 */
export interface StepChatAutofillPorts {
  /** 当拍触发门（面板在这里读会话快照与可见性；不缓存）。 */
  readGate(): StepChatAutofillGate
  /**
   * 拉更早一页。面板传「保位版 loadOlder」（量 scrollHeight → prepend → rAF 按
   * ΔscrollHeight 补偿），**拒绝即失败**（驱动据此退避重试）。
   */
  loadOlder(): Promise<void>
  /** 每轮之间的快照稳定等待（缺省 `await Promise.resolve()`）。 */
  settle?(): Promise<void>
  /** 一页成功落地后的回调（诊断/测试取证；保位已由 loadOlder 端口自带）。 */
  onPageLoaded?(): void
  /** 进行中态变化（面板据此显示/隐藏「正在加载更早的消息…」提示行）。 */
  onActiveChange?(active: boolean): void
  /** 页数上限覆盖（缺省 {@link STEP_CHAT_AUTOFILL_MAX_PAGES}）。 */
  maxPages?: number
  /** 失败退避序列覆盖（缺省 {@link STEP_CHAT_AUTOFILL_RETRY_DELAYS_MS}）。 */
  retryDelaysMs?: readonly number[]
  /** 定时器工厂覆盖（缺省 `setTimeout`；单测注入手动泵）。 */
  schedule?: StepChatAutofillScheduler
}

/** 自动补齐驱动实例（面板随会话/分页能力重建，卸载时 dispose）。 */
export interface StepChatAutofillRun {
  /**
   * 触发一次自动补齐。幂等：进行中、已闩锁（limit/failed）、已 dispose 时 no-op；
   * 门关闭时立即结束（不做任何投递），门恢复后由面板再次调用。
   */
  trigger(): void
  /** 中止：取消在飞的退避定时器 + 让一切在飞结果作废（卸载/会话切换的 generation 守卫）。 */
  dispose(): void
  /** 是否进行中（提示行显隐；面板另有 state 版本供渲染）。 */
  isActive(): boolean
  /** 本实例已自动补齐的页数（诊断/单测）。 */
  pages(): number
  /** 最近一次停止原因（未跑过 → undefined）。 */
  stopReason(): StepChatAutofillStopReason | undefined
  /** 中止纪元（dispose 每次 +1；单测断言「卸载后不再投递」）。 */
  generation(): number
}

/** 缺省定时器工厂（浏览器/Node 皆有的 `setTimeout`）。 */
const defaultSchedule: StepChatAutofillScheduler = (run, delayMs) => {
  const id = setTimeout(run, delayMs)
  return { cancel: () => { clearTimeout(id) } }
}

/** 缺省快照稳定等待：让出一个微任务（调用方的发布回调已跑完）。 */
const settleMicrotask = (): Promise<void> => Promise.resolve()

/**
 * 创建一个自动补齐驱动。
 * @param portsOf - 端口工厂。**每轮**调用一次（不缓存返回值），故面板可以把
 *   `readGate`/`loadOlder` 写成读 ref 的闭包而不会读到过期状态。
 * @returns 驱动实例（面板在 effect 里创建，cleanup 里 dispose）。
 */
export function createStepChatAutofill(
  portsOf: () => StepChatAutofillPorts,
): StepChatAutofillRun {
  /** 终止标记：dispose 后所有 await 恢复处都会看到它并立即收工。 */
  let disposed = false
  /** 进行中（同一实例同时只允许一个泵；trigger 的并发守卫）。 */
  let running = false
  /** 中止纪元（dispose 计数；面板侧 generation 断言的等价物）。 */
  let generation = 0
  /** 已自动补齐的页数（本实例累计；页数预算按实例计，见 STEP_CHAT_AUTOFILL_MAX_PAGES）。 */
  let pages = 0
  /** 最近一次停止原因。 */
  let stop: StepChatAutofillStopReason | undefined
  /** 对外可见的进行中态（提示行）。 */
  let active = false
  /** 在飞退避定时器的唤醒器（dispose 时用它取消 + 唤醒等待者）。 */
  let wake: (() => void) | undefined

  const notifyActive = (next: boolean): void => {
    if (active === next) return
    active = next
    portsOf().onActiveChange?.(next)
  }

  /** 快照稳定等待（失败/卸载后立即返回；wait 自身不吞异常）。 */
  const settle = async (ports: StepChatAutofillPorts): Promise<void> => {
    if (disposed) return
    await (ports.settle ?? settleMicrotask)()
  }

  /**
   * 有界退避等待。
   * @returns true = 正常到点（可以重试）；false = 等待期间实例被 dispose。
   */
  const wait = (delayMs: number, ports: StepChatAutofillPorts): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const schedule = ports.schedule ?? defaultSchedule
      let settled = false
      const finish = (alive: boolean): void => {
        if (settled) return
        settled = true
        wake = undefined
        resolve(alive)
      }
      const timer = schedule(() => { finish(!disposed) }, delayMs)
      wake = () => {
        timer.cancel()
        finish(false)
      }
    })

  /** 泵：一轮一页，直到终止条件命中（每轮都重读门与世界状态）。 */
  const pump = async (): Promise<void> => {
    let retries = 0
    let inflightWaits = 0
    try {
      for (;;) {
        if (disposed) {
          stop = 'disposed'
          return
        }
        const ports = portsOf()
        const gate = ports.readGate()
        if (!stepChatAutofillAllowedOf(gate)) {
          // 门关闭。窗口已补齐 → complete；只是暂时不可见/非 open → gate（面板在
          // 可见性或开窗态恢复后会再次 trigger，届时从剩余预算继续）。
          stop = gate.paging.hasMore ? 'gate' : 'complete'
          return
        }
        const maxPages = ports.maxPages ?? STEP_CHAT_AUTOFILL_MAX_PAGES
        if (pages >= maxPages) {
          stop = 'limit'
          return
        }
        if (gate.paging.loadingOlder) {
          // 别的通道（手动点击/上一页余波）正在飞：不重复投递，等一拍快照再看。
          if (inflightWaits >= STEP_CHAT_AUTOFILL_MAX_INFLIGHT_WAITS) {
            stop = 'stalled'
            return
          }
          inflightWaits += 1
          await settle(ports)
          continue
        }
        inflightWaits = 0
        try {
          await ports.loadOlder()
        } catch {
          // 失败：快照的 openState/loadingOlder 自行回落（DSH 同）；
          // 按退避序列重试，序列耗尽即停止（闩锁 → 保留手动按钮）。
          const delays = ports.retryDelaysMs ?? STEP_CHAT_AUTOFILL_RETRY_DELAYS_MS
          const delay = delays[retries]
          retries += 1
          if (delay === undefined) {
            stop = 'failed'
            return
          }
          const alive = await wait(delay, ports)
          if (!alive) {
            stop = 'disposed'
            return
          }
          continue
        }
        retries = 0
        pages += 1
        ports.onPageLoaded?.()
        await settle(ports)
      }
    } finally {
      running = false
      notifyActive(false)
    }
  }

  return {
    trigger: (): void => {
      if (disposed || running) return
      // 闩锁：上限/失败后不再自动重启（手动按钮仍可逐页续看）。
      if (stop === 'limit' || stop === 'failed') return
      running = true
      stop = undefined
      notifyActive(true)
      void pump()
    },
    dispose: (): void => {
      if (disposed) return
      disposed = true
      generation += 1
      // 唤醒在飞的退避等待（等待者醒来即看到 disposed → 收工）。
      const pending = wake
      wake = undefined
      pending?.()
      notifyActive(false)
    },
    isActive: (): boolean => active,
    pages: (): number => pages,
    stopReason: (): StepChatAutofillStopReason | undefined => stop,
    generation: (): number => generation,
  }
}
