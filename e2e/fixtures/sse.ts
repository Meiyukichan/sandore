/**
 * 页面侧 SSE（`/sandore/events`）采集器：把 host 推来的 `sandore/*` 事件留在浏览器
 * 内存里，供对账断言读取。
 *
 * 帧格式（`workflow-engine.ts` 的 `emitContained('sandore/x', [info, ...rest])` +
 * 兼容层的 `{type, data:{args}}` 包装）：`data.args[0]` 恒为
 * `DagRunInfo { taskId, workflowId }`，其余参数按事件语义排布。
 *
 * 采集器必须**先于应用**装好（应用一进页面就建 EventSource，且历史事件在订阅时重放）：
 * 用 `page.addInitScript`，不要用 `page.evaluate` 事后补装。
 *
 * ## 为什么要有 {@link waitForFrameCount}（时序 flake 修复）
 * `sandore/*` 广播与 RPC 返回走**两条独立的通路**（RPC 响应 vs SSE 推流），二者到达浏览器的
 * 先后**没有顺序保证**：`await remote.abortInstance(...)` 返回时实例状态已经翻转，但同一动作
 * 触发的 `sandore/aborted` 帧可能还在网络上（实测差的只是几毫秒到几十毫秒）。
 * 所以「先轮询 RPC 状态、再**一次性**读采集器」会偶发红——那不是丢帧，是**延迟**。
 * 本模块提供**有界等待**：轮询到目标计数（超时给出可读诊断），并把「首次看到该帧用了多久」
 * 追加写进 `e2e/.artifacts/sse-frame-timing.log`，作为「延迟而非丢帧」的实测依据。
 *
 * @module e2e/fixtures/sse
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Page } from '@playwright/test'

/** 一条 SSE 帧。 */
export interface SseFrame {
  readonly type: string
  readonly data?: { readonly args?: readonly unknown[] }
}

/**
 * `addInitScript` 里注入的采集器源码（在文档脚本之前执行）。
 *
 * ⚠️ 这个函数会被**序列化后送进浏览器执行**，因此不能引用模块作用域的任何标识符
 * （常量会被编译成外层变量名，在页面里就是 `undefined` → `X is not defined`）。
 * 所有字面量必须self-contained地写在本函数体内。
 */
function installer(): void {
  const sink: SseFrame[] = []
  ;(window as unknown as Record<string, unknown>)['__sandoreE2eSse'] = sink
  const source = new EventSource('/sandore/events')
  source.addEventListener('message', (event: MessageEvent) => {
    try {
      sink.push(JSON.parse(event.data as string) as SseFrame)
    } catch {
      // 非法帧忽略（对齐 client 侧 sandore-sse.ts 的容错）。
    }
  })
}

/** 在导航前挂上采集器（幂等：重复调用只多装一个 EventSource，不影响数据）。 */
export async function installSseCollector(page: Page): Promise<void> {
  await page.addInitScript(installer)
}

/** 读取当前已采集的全部帧（快照拷贝）。 */
export function readSseFrames(page: Page): Promise<SseFrame[]> {
  // 同理：evaluate 的回调也在浏览器里执行 → 字面量写在函数体内。
  return page.evaluate(() => {
    const sink = (window as unknown as Record<string, unknown>)['__sandoreE2eSse'] as SseFrame[] | undefined
    return (sink ?? []).slice()
  })
}

/** 取帧的 `DagRunInfo.taskId`（`data.args[0].taskId`）。 */
export function frameTaskId(frame: SseFrame): string | undefined {
  const info = frame.data?.args?.[0] as { taskId?: string } | undefined
  return info?.taskId
}

/** 取帧的第 n 个参数（`data.args[n]`）。 */
export function frameArg(frame: SseFrame, index: number): unknown {
  return frame.data?.args?.[index]
}

/** 目标实例的帧（按 `DagRunInfo.taskId` 过滤）。 */
export function framesOf(frames: readonly SseFrame[], instanceId: string): SseFrame[] {
  return frames.filter(frame => frameTaskId(frame) === instanceId)
}

/** 某实例某类事件的出现次数。 */
export function countOfType(frames: readonly SseFrame[], type: string): number {
  return frames.filter(frame => frame.type === type).length
}

/** 诊断串：本实例收到的事件类型清单 + 全量帧数（断言失败时贴进消息）。 */
export function describeFrames(mine: readonly SseFrame[], all: readonly SseFrame[]): string {
  const types = [...new Set(mine.map(frame => frame.type))].sort()
  return `本实例 SSE 事件类型：${JSON.stringify(types)}；收到的全部帧数：${all.length}`
}

/**
 * 本实例帧的**类型序列**（按到达顺序，含重复；用于诊断「帧到底来没来、顺序如何」）。
 * @param mine - 已过滤到本实例的帧。
 * @returns 形如 `sandore/start → sandore/step-started → …` 的串（超长时截断中间）。
 */
export function sequenceOf(mine: readonly SseFrame[]): string {
  const types = mine.map(frame => frame.type)
  if (types.length <= 24) return types.join(' → ')
  return [...types.slice(0, 12), `…(+${String(types.length - 24)})…`, ...types.slice(-12)].join(' → ')
}

/** {@link waitForFrameCount} 的选项。 */
export interface WaitFrameOptions {
  /** 期望的最少条数（默认 1）；判据是 `count >= atLeast`。 */
  readonly atLeast?: number
  /** 上限（默认 20s）。 */
  readonly timeoutMs?: number
  /** 轮询间隔（默认 150ms）。 */
  readonly intervalMs?: number
  /** 失败诊断里附加的现场信息（例如实例状态）。 */
  readonly extra?: () => Promise<string> | string
  /** 期望的**精确**条数；给出时同时断言不超过它（重复帧会立刻失败，而不是等到超时）。 */
  readonly exactly?: number
  /** 计时台账的标签（默认按事件类型）。 */
  readonly label?: string
  /**
   * 计时起点（epoch ms）：给出时台账额外记录「从那个时刻到首次看到该帧」的耗时
   * （例如「点中止 → 收到 sandore/aborted」的端到端延迟），用于证明「延迟而非丢帧」。
   */
  readonly since?: number
}

/** 计时台账路径（每次运行追加，跨全量运行累积「首次看到该帧的耗时」分布）。 */
const TIMING_LOG = join(import.meta.dirname, '..', '.artifacts', 'sse-frame-timing.log')

/** 追加一行计时台账（失败静默：取证不能反过来让用例红）。 */
function recordTiming(line: string): void {
  try {
    mkdirSync(dirname(TIMING_LOG), { recursive: true })
    appendFileSync(TIMING_LOG, `${line}\n`, 'utf8')
  } catch {
    // 忽略：台账只是取证材料。
  }
}

/**
 * **有界等待**本实例某类事件帧达到期望条数（消除「帧只是稍晚到达」造成的偶发红）。
 *
 * 语义（**不放宽断言**）：
 * - `exactly` 给出时，轮询到 `=== exactly` 即返回；若**超过** `exactly`（真的重复广播）立即抛错；
 * - 未给出时用 `atLeast`（默认 1）：`>= atLeast` 即返回；
 * - 超时抛出**可读诊断**：期望值、实际计数、本实例事件类型序列、全部帧数、额外现场信息。
 *
 * 另外把「调用开始 → 首次看到该帧」的耗时追加进 `e2e/.artifacts/sse-frame-timing.log`
 * （延迟 vs 丢帧的实测依据）。
 * @param page - 被测页面。
 * @param instanceId - 目标实例（按 `DagRunInfo.taskId` 过滤）。
 * @param type - 事件类型（如 `sandore/aborted`）。
 * @param options - 见 {@link WaitFrameOptions}。
 * @returns 该类型的帧（便于继续做参数断言）。
 */
export async function waitForFrameCount(
  page: Page,
  instanceId: string,
  type: string,
  options: WaitFrameOptions = {},
): Promise<SseFrame[]> {
  const atLeast = options.exactly ?? options.atLeast ?? 1
  const timeoutMs = options.timeoutMs ?? 20_000
  const intervalMs = options.intervalMs ?? 150
  const started = Date.now()
  let last = 0
  let firstSeenMs: number | undefined
  let lastAll: readonly SseFrame[] = []
  let lastMine: SseFrame[] = []
  for (;;) {
    lastAll = await readSseFrames(page)
    lastMine = framesOf(lastAll, instanceId)
    last = countOfType(lastMine, type)
    if (last >= atLeast) {
      firstSeenMs ??= Date.now() - started
      if (options.exactly !== undefined && last > options.exactly) {
        const extra = options.extra === undefined ? '' : `\n现场：${await options.extra()}`
        throw new Error(
          `${type} 出现了 ${String(last)} 次（期望恰 ${String(options.exactly)} 次）——重复广播${extra}`
          + `\n本实例事件序列：${sequenceOf(lastMine)}`,
        )
      }
      recordTiming(
        `[${new Date().toISOString()}] type=${type} instance=${instanceId} expected=${String(options.exactly ?? atLeast)}`
        + ` observed=${String(last)} firstSeenAfterMs=${String(firstSeenMs)} verdict=delivered`
        + (options.since === undefined ? '' : ` sinceStartMs=${String(Date.now() - options.since)}`),
      )
      break
    }
    if (Date.now() - started > timeoutMs) {
      const extra = options.extra === undefined ? '' : `\n现场：${await options.extra()}`
      recordTiming(
        `[${new Date().toISOString()}] type=${type} instance=${instanceId} expected=${String(options.exactly ?? atLeast)}`
        + ` observed=${String(last)} timeoutMs=${String(timeoutMs)} verdict=TIMEOUT`,
      )
      throw new Error(
        `等待 ${type} 超时（${String(timeoutMs)}ms）：期望 ≥${String(atLeast)} 次，实际 ${String(last)} 次`
        + `\n本实例事件序列：${sequenceOf(lastMine)}`
        + `\n${describeFrames(lastMine, lastAll)}${extra}`,
      )
    }
    await page.waitForTimeout(intervalMs)
  }
  return framesOf(await readSseFrames(page), instanceId).filter(frame => frame.type === type)
}

/**
 * **SSE 通道就绪**闸门：等到该实例至少出现 1 帧（说明采集器已装好、连接已建立、
 * 且本实例的广播真的推到了这个页面）——用于「点中止之前先确认通道是活的」这类场景。
 * @param page - 被测页面。
 * @param instanceId - 目标实例。
 * @param options - `timeoutMs`（默认 20s）。
 * @returns 已到达的帧（本实例）。
 */
export async function waitForAnyFrame(
  page: Page,
  instanceId: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<SseFrame[]> {
  const timeoutMs = options.timeoutMs ?? 20_000
  const started = Date.now()
  for (;;) {
    const all = await readSseFrames(page)
    const mine = framesOf(all, instanceId)
    if (mine.length > 0) {
      recordTiming(
        `[${new Date().toISOString()}] type=*any* instance=${instanceId} expected=1`
        + ` observed=${String(mine.length)} firstSeenAfterMs=${String(Date.now() - started)} verdict=channel-ready`,
      )
      return mine
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `等待本实例的任意 SSE 帧超时（${String(timeoutMs)}ms）——通道未就绪或本实例没有任何广播`
        + `\n${describeFrames([], all)}`,
      )
    }
    await page.waitForTimeout(150)
  }
}
