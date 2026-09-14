/**
 * `step-chat-autofill.ts` 的单元测试（批 A2）——纯逻辑层，node 环境（无 React/DOM）：
 * - 触发门矩阵：不可见 / 非 open / 已补齐（hasMore=false）/ 错误态 → 不启动；
 * - 连续补齐直到 `hasMore === false`（每页之间 await 一次快照稳定）；
 * - 页数上限（缺省常量 + 端口覆盖）→ `limit` 停止并闩锁（再 trigger 不重启）；
 * - 失败按退避序列重试，序列耗尽 → `failed` 停止（退避一次的场景）；
 * - 卸载中止：dispose 取消在飞退避定时器、作废在飞 loadOlder 的后续投递
 *   （generation 守卫）；
 * - 并发重复投递守卫：同一 tick 多次 trigger 只投递一次；
 * - `loadingOlder` 悬挂：等待上限后 `stalled` 停止（不空转、不重复投递）。
 *
 * 端口全部为假实现（假 session / 假分页能力面）：`schedule` 注入手动泵，
 * 「失败 → 退避 → 重试」路径完全确定性，不依赖假定时器与真实宏任务交错。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-chat-autofill.spec
 */
import { describe, expect, it } from 'vitest'

import {
  createStepChatAutofill,
  STEP_CHAT_AUTOFILL_MAX_INFLIGHT_WAITS,
  STEP_CHAT_AUTOFILL_MAX_PAGES,
  STEP_CHAT_AUTOFILL_RETRY_DELAYS_MS,
  stepChatAutofillAllowedOf,
  type StepChatAutofillGate,
  type StepChatAutofillPorts,
} from './step-chat-autofill.ts'

/** 一页的行为脚本：成功（推进 hasMore 序列）或失败（拒绝）。 */
type PageStep = 'page' | 'fail'

/** 手动泵定时器（测试自己决定何时到点）。 */
interface ManualTimer {
  readonly delayMs: number
  readonly run: () => void
  cancelled: boolean
}

/** 假世界 + 假端口 + 驱动实例。 */
function makeHarness(options: {
  readonly hasMore?: boolean
  readonly loadingOlder?: boolean
  readonly visible?: boolean
  readonly openState?: string
  readonly failed?: boolean
  /** 每次 loadOlder 的行为（超出脚本 → 'page'）。 */
  readonly script?: readonly PageStep[]
  /** 每次**成功**的 loadOlder 之后 hasMore 的取值（超出序列 → 保持当前值）。 */
  readonly hasMoreAfter?: readonly boolean[]
  /** loadOlder 交由测试手动 resolve（断言「在飞期间 dispose」用）。 */
  readonly manualLoadOlder?: boolean
  /** settle 交由测试手动 resolve（断言「等一拍再继续」用）。 */
  readonly manualSettle?: boolean
  readonly maxPages?: number
  readonly retryDelaysMs?: readonly number[]
} = {}) {
  const state = {
    hasMore: options.hasMore ?? true,
    loadingOlder: options.loadingOlder ?? false,
    visible: options.visible ?? true,
    openState: options.openState ?? 'open',
    failed: options.failed ?? false,
  }
  const script = [...(options.script ?? [])]
  const hasMoreAfter = [...(options.hasMoreAfter ?? [])]
  const loads: number[] = []
  const timers: ManualTimer[] = []
  const activeLog: boolean[] = []
  const pendingLoads: { resolve: () => void; reject: (error: Error) => void }[] = []
  const pendingSettles: (() => void)[] = []
  let settles = 0
  let pageCallbacks = 0
  const ports: StepChatAutofillPorts = {
    readGate: (): StepChatAutofillGate => ({
      bindingReady: true,
      visible: state.visible,
      openState: state.openState,
      failed: state.failed,
      paging: { hasMore: state.hasMore, loadingOlder: state.loadingOlder },
    }),
    loadOlder: (): Promise<void> => {
      loads.push(loads.length)
      const step = script.shift() ?? 'page'
      if (step === 'fail') return Promise.reject(new Error('loadOlder failed'))
      state.hasMore = hasMoreAfter.shift() ?? state.hasMore
      if (options.manualLoadOlder === true) {
        return new Promise<void>((resolve, reject) => { pendingLoads.push({ resolve, reject }) })
      }
      return Promise.resolve()
    },
    settle: options.manualSettle === true
      ? () => new Promise<void>((resolve) => {
        pendingSettles.push(() => { settles += 1; resolve() })
      })
      : async () => { settles += 1 },
    onPageLoaded: () => { pageCallbacks += 1 },
    onActiveChange: (active) => { activeLog.push(active) },
    schedule: (run, delayMs) => {
      const timer: ManualTimer = { delayMs, run, cancelled: false }
      timers.push(timer)
      return { cancel: () => { timer.cancelled = true } }
    },
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
    ...(options.retryDelaysMs === undefined ? {} : { retryDelaysMs: options.retryDelaysMs }),
  }
  const run = createStepChatAutofill(() => ports)
  return {
    state,
    run,
    loads,
    timers,
    activeLog,
    pendingLoads,
    stats: () => ({ settles, pageCallbacks }),
    /** 释放所有在飞的 settle 等待（manualSettle 模式；返回释放数）。 */
    releaseSettle: (): number => {
      const waiters = pendingSettles.splice(0)
      for (const waiter of waiters) waiter()
      return waiters.length
    },
    /** 泵完一次到点/微任务边界（假 ports 的 awaits 全是微任务）。 */
    settlePump: () => new Promise<void>((resolve) => { setImmediate(resolve) }),
    /** 触发手动泵里的下一次退避重试（未被 cancel 时）。 */
    fireTimer: (index = 0): void => {
      const timer = timers[index]
      if (timer === undefined) throw new Error(`no timer at ${String(index)}`)
      if (!timer.cancelled) timer.run()
    },
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 触发门（纯函数矩阵）
// ══════════════════════════════════════════════════════════════════════════════

describe('stepChatAutofillAllowedOf（触发门矩阵）', () => {
  const open: StepChatAutofillGate = {
    bindingReady: true,
    visible: true,
    openState: 'open',
    failed: false,
    paging: { hasMore: true, loadingOlder: false },
  }

  it('allows the fill only when every gate input holds', () => {
    expect(stepChatAutofillAllowedOf(open)).toBe(true)
  })

  it('refuses the fill for each closed condition', () => {
    expect(stepChatAutofillAllowedOf({ ...open, bindingReady: false })).toBe(false)
    expect(stepChatAutofillAllowedOf({ ...open, visible: false })).toBe(false)
    expect(stepChatAutofillAllowedOf({ ...open, openState: 'cold' })).toBe(false)
    expect(stepChatAutofillAllowedOf({ ...open, openState: 'loading' })).toBe(false)
    expect(stepChatAutofillAllowedOf({ ...open, openState: 'error' })).toBe(false)
    expect(stepChatAutofillAllowedOf({ ...open, failed: true })).toBe(false)
    expect(stepChatAutofillAllowedOf({
      ...open,
      paging: { hasMore: false, loadingOlder: false },
    })).toBe(false)
  })
})

describe('createStepChatAutofill（触发条件）', () => {
  it('does not start while the panel is not visible', async () => {
    const harness = makeHarness({ visible: false })
    harness.run.trigger()
    await harness.settlePump()
    expect(harness.loads).toHaveLength(0)
    expect(harness.run.isActive()).toBe(false)
    expect(harness.run.stopReason()).toBe('gate')
  })

  it('does not start while the session window is not open', async () => {
    const harness = makeHarness({ openState: 'loading' })
    harness.run.trigger()
    await harness.settlePump()
    expect(harness.loads).toHaveLength(0)
    expect(harness.run.stopReason()).toBe('gate')
  })

  it('does not start in the error state', async () => {
    const harness = makeHarness({ openState: 'error', failed: true })
    harness.run.trigger()
    await harness.settlePump()
    expect(harness.loads).toHaveLength(0)
    expect(harness.run.stopReason()).toBe('gate')
  })

  it('does not start when the window is already complete', async () => {
    const harness = makeHarness({ hasMore: false })
    harness.run.trigger()
    await harness.settlePump()
    expect(harness.loads).toHaveLength(0)
    expect(harness.run.stopReason()).toBe('complete')
  })

  it('resumes after the gate reopens (visibility returns)', async () => {
    // 不可见 → 不投递；恢复可见 + hasMore 仍在 → 面板再次 trigger 后继续补齐。
    const harness = makeHarness({ visible: false, hasMoreAfter: [false] })
    harness.run.trigger()
    await harness.settlePump()
    expect(harness.loads).toHaveLength(0)
    harness.state.visible = true
    harness.run.trigger()
    await harness.settlePump()
    expect(harness.loads).toHaveLength(1)
    expect(harness.run.stopReason()).toBe('complete')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 连续补齐 / 上限 / 失败退避
// ══════════════════════════════════════════════════════════════════════════════

describe('createStepChatAutofill（连续补齐与终止）', () => {
  it('keeps loading pages until hasMore turns false', async () => {
    const harness = makeHarness({ hasMoreAfter: [true, true, false] })
    harness.run.trigger()
    await harness.settlePump()
    expect(harness.loads).toHaveLength(3)
    expect(harness.run.pages()).toBe(3)
    expect(harness.run.stopReason()).toBe('complete')
    // 每页之间 await 一次快照稳定（含收尾那一次）。
    expect(harness.stats().settles).toBe(3)
    expect(harness.stats().pageCallbacks).toBe(3)
    // 进行中态：起 → 落（提示行只在补齐期间存在）。
    expect(harness.activeLog).toEqual([true, false])
  })

  it('stops at the default page cap and latches (no restart on trigger)', async () => {
    const harness = makeHarness()
    harness.run.trigger()
    await harness.settlePump()
    expect(harness.loads).toHaveLength(STEP_CHAT_AUTOFILL_MAX_PAGES)
    expect(harness.run.stopReason()).toBe('limit')
    expect(harness.run.isActive()).toBe(false)
    // 闩锁：上限后 trigger() 不再自动重启（把选择权交回手动按钮）。
    harness.run.trigger()
    await harness.settlePump()
    expect(harness.loads).toHaveLength(STEP_CHAT_AUTOFILL_MAX_PAGES)
    expect(harness.run.stopReason()).toBe('limit')
  })

  it('honours a page-cap override', async () => {
    const harness = makeHarness({ maxPages: 2 })
    harness.run.trigger()
    await harness.settlePump()
    expect(harness.loads).toHaveLength(2)
    expect(harness.run.stopReason()).toBe('limit')
  })

  it('backs off once after a failure and then stops (retry ladder exhausted)', async () => {
    const harness = makeHarness({ script: ['fail', 'fail'], retryDelaysMs: [1000] })
    harness.run.trigger()
    await harness.settlePump()
    expect(harness.loads).toHaveLength(1)
    // 首次失败：按序列第一跳退避（1s），此时候仍在进行中。
    expect(harness.timers).toHaveLength(1)
    expect(harness.timers[0]?.delayMs).toBe(1000)
    expect(harness.run.isActive()).toBe(true)
    harness.fireTimer()
    await harness.settlePump()
    // 重试仍失败且序列耗尽 → 停止（闩锁保留手动按钮）。
    expect(harness.loads).toHaveLength(2)
    expect(harness.run.stopReason()).toBe('failed')
    expect(harness.run.isActive()).toBe(false)
    harness.run.trigger()
    await harness.settlePump()
    expect(harness.loads).toHaveLength(2)
  })

  it('retries through the whole ladder and finishes once a page succeeds', async () => {
    const harness = makeHarness({ script: ['fail', 'fail', 'page'], hasMoreAfter: [false] })
    harness.run.trigger()
    await harness.settlePump()
    expect(harness.loads).toHaveLength(1)
    harness.fireTimer(0) // 1s 跳
    await harness.settlePump()
    expect(harness.loads).toHaveLength(2)
    expect(harness.timers[1]?.delayMs).toBe(STEP_CHAT_AUTOFILL_RETRY_DELAYS_MS[1])
    harness.fireTimer(1) // 3s 跳
    await harness.settlePump()
    expect(harness.loads).toHaveLength(3)
    expect(harness.run.stopReason()).toBe('complete')
    expect(harness.run.pages()).toBe(1) // 失败重试不计入页数
  })

  it('stops as stalled when another channel keeps loadingOlder pinned', async () => {
    const harness = makeHarness({ loadingOlder: true })
    harness.run.trigger()
    for (let i = 0; i < STEP_CHAT_AUTOFILL_MAX_INFLIGHT_WAITS + 4; i += 1) {
      await harness.settlePump()
    }
    expect(harness.loads).toHaveLength(0) // 绝不重复投递
    expect(harness.run.stopReason()).toBe('stalled')
    expect(harness.run.isActive()).toBe(false)
  })

  it('waits one settle and proceeds once the other channel clears loadingOlder', async () => {
    const harness = makeHarness({ loadingOlder: true, hasMoreAfter: [false], manualSettle: true })
    harness.run.trigger()
    await harness.settlePump()
    // 别的通道占着 loadingOlder：只登记一次等待，不重复投递。
    expect(harness.loads).toHaveLength(0)
    expect(harness.run.isActive()).toBe(true)
    harness.state.loadingOlder = false
    expect(harness.releaseSettle()).toBe(1)
    await harness.settlePump()
    expect(harness.loads).toHaveLength(1)
    harness.releaseSettle() // 该页落地后的收尾等待
    await harness.settlePump()
    expect(harness.run.stopReason()).toBe('complete')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 卸载中止（generation）与并发守卫
// ══════════════════════════════════════════════════════════════════════════════

describe('createStepChatAutofill（卸载守卫与并发）', () => {
  it('aborts a pending backoff wait on dispose (generation guard)', async () => {
    const harness = makeHarness({ script: ['fail', 'page'] })
    harness.run.trigger()
    await harness.settlePump()
    expect(harness.loads).toHaveLength(1)
    expect(harness.run.isActive()).toBe(true)
    const generation = harness.run.generation()
    harness.run.dispose()
    expect(harness.run.generation()).toBe(generation + 1)
    // 退避定时器被取消 + 等待被唤醒（不会再有第二次投递）。
    expect(harness.timers[0]?.cancelled).toBe(true)
    harness.fireTimer(0)
    await harness.settlePump()
    expect(harness.loads).toHaveLength(1)
    expect(harness.run.stopReason()).toBe('disposed')
    expect(harness.run.isActive()).toBe(false)
    // dispose 后 trigger 一律 no-op（卸载/换会话后不可能再投递）。
    harness.run.trigger()
    await harness.settlePump()
    expect(harness.loads).toHaveLength(1)
  })

  it('delivers no further page when disposed mid-flight', async () => {
    const harness = makeHarness({ manualLoadOlder: true, hasMoreAfter: [false] })
    harness.run.trigger()
    await harness.settlePump()
    expect(harness.loads).toHaveLength(1)
    harness.run.dispose()
    harness.pendingLoads[0]?.resolve()
    await harness.settlePump()
    expect(harness.loads).toHaveLength(1)
    expect(harness.run.stopReason()).toBe('disposed')
  })

  it('coalesces repeated triggers within one tick into a single delivery', async () => {
    const harness = makeHarness({ hasMoreAfter: [false] })
    harness.run.trigger()
    harness.run.trigger()
    harness.run.trigger()
    await harness.settlePump()
    expect(harness.loads).toHaveLength(1)
    expect(harness.activeLog).toEqual([true, false])
  })
})
