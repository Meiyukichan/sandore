/**
 * F 层用例 · 阶段 3：SSE 对账（`sandore/end` 恰一次）+ 外层时间线窗口策略（真实 DOM）。
 *
 * SSE 与窗口两条用例都**自持页面**：采集器必须用 initScript 在应用建 EventSource
 * 之前就位，所以用 playwright 原生 `browser` fixture 新建 context/page，而不是
 * harness 的 `page`（后者的就绪逻辑会先导航）。
 */
import { randomUUID } from 'node:crypto'

import {
  createInstanceFromUi, dismissOnboarding, ensureDefinition, expect, getInstanceState, openSeat,
  switchListMode, test, type Browser, type DshServer, type Page,
} from './fixtures/harness.ts'
import {
  countOfType, describeFrames, frameArg, framesOf, installSseCollector, readSseFrames,
  type SseFrame,
} from './fixtures/sse.ts'
import {
  CHAIN_STAGE_COUNT, CHAIN_WORKFLOW_NAME, CHAIN_WORKFLOW_YAML, FAST_WORKFLOW_NAME, FAST_WORKFLOW_YAML,
} from './fixtures/workflows.ts'

/** 外层时间线默认尾部窗口（对齐 `timeline-window.ts` 的 TIMELINE_MAX_STEPS）。 */
const TIMELINE_MAX_STEPS = 5
/** 扩窗一页的步长（对齐 `timeline-window.ts` 的 TIMELINE_STEPS_PAGE）。 */
const TIMELINE_STEPS_PAGE = 5

/** 起一个已装好 SSE 采集器的页面（采集器先于应用脚本就位）。 */
async function openCollectingPage(
  browser: Browser,
  dsh: DshServer,
): Promise<{ page: Page; frames: () => Promise<SseFrame[]>; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1700, height: 1000 }, locale: 'zh-CN' })
  const page = await context.newPage()
  await installSseCollector(page)
  await page.goto(dsh.url, { waitUntil: 'domcontentloaded' })
  await dismissOnboarding(page)
  await expect(page.locator('[data-sandore-seat-entry]').first()).toBeVisible({ timeout: 30_000 })
  return {
    page,
    frames: () => readSseFrames(page),
    close: () => context.close(),
  }
}

test.describe('F3 SSE 对账与时间线窗口', () => {
  // 本文件的两条用例都自持页面（原生 browser + 自建 page），因此不依赖 harness 的
  // `page` fixture，也不需要 beforeAll/beforeEach 造数——定义在各自用例内幂等导入。

  test('⑩ SSE 对账：该实例 sandore/end 恰好一次，且与页面/ host 终态一致', async ({ browser, dsh, workspace }) => {
    test.setTimeout(150_000)
    const { page, frames, close } = await openCollectingPage(browser, dsh)
    try {
      await ensureDefinition(page, FAST_WORKFLOW_YAML, FAST_WORKFLOW_NAME)
      await openSeat(page)
      await switchListMode(page, '实例')

      const requirement = `e2e-f-sse-${randomUUID().slice(0, 8)}`
      const instanceId = await createInstanceFromUi(page, {
        workflowName: FAST_WORKFLOW_NAME,
        requirement,
        cwd: workspace,
      })

      // 先等 host 侧进入终态（快定义两个 echo 步，秒级）。
      await expect
        .poll(async () => (await getInstanceState(page, instanceId)).status, { timeout: 90_000 })
        .toBe('completed')

      // 再等该实例的 sandore/end（终态信号）抵达**页面 SSE 通道**。
      // 引擎可能早于本断言发布事件——但 EventSource 兼容层会在订阅/查询时重放该实例的
      // 历史事件，所以这里只断言「页面确实收到了终态事件」，不做时序假设。
      // 注意：waitForFunction 的回调在**浏览器里**执行，不能引用模块作用域的类型/常量。
      const sawEnd = await page.waitForFunction(
        (id: string) => {
          const sink = (window as unknown as Record<string, unknown>)['__sandoreE2eSse'] as
            { type: string, data?: { args?: readonly unknown[] } }[] | undefined
          return (sink ?? []).some((frame) => {
            const info = (frame.data?.args?.[0] ?? undefined) as { taskId?: string } | undefined
            return frame.type === 'sandore/end' && info?.taskId === id
          })
        },
        instanceId,
        { timeout: 30_000 },
      ).then(() => true, () => false)

      const collected = await frames()
      const mine = framesOf(collected, instanceId)
      const ends = countOfType(mine, 'sandore/end')
      const starts = countOfType(mine, 'sandore/start')
      const aborts = countOfType(mine, 'sandore/aborted')
      const stepCompleted = mine.filter(frame => frame.type === 'sandore/step-completed')

      // ★ 恰一次终态：sandore/end 有且仅有 1 次，无 aborted 混入。
      // （对账失败的诊断信息里带上本实例收到的事件类型清单，便于定位。）
      const diagnosis = describeFrames(mine, collected)
      expect(sawEnd, `页面 SSE 通道未收到 sandore/end。${diagnosis}`).toBe(true)
      expect(ends, `sandore/end 次数应恰为 1（实际 ${ends}）。${diagnosis}`).toBe(1)
      expect(aborts, 'completed 运行不应出现 sandore/aborted').toBe(0)
      expect(starts, 'sandore/start 至少一次').toBeGreaterThanOrEqual(1)
      // 事件序：start 先于 end。
      const startIndex = mine.findIndex(frame => frame.type === 'sandore/start')
      const endIndex = mine.findIndex(frame => frame.type === 'sandore/end')
      expect(startIndex).toBeGreaterThanOrEqual(0)
      expect(startIndex).toBeLessThan(endIndex)
      // 每个 step 恰好完成一次（快定义两步 → 2 次 step-completed，顺序与定义一致）。
      expect(stepCompleted.length, `step-completed 应恰为 2 次。${diagnosis}`).toBe(2)
      const completedStepIds = stepCompleted.map(frame => String(frameArg(frame, 1)))
      expect(completedStepIds).toEqual(['stp-f-fast-1', 'stp-f-fast-2'])

      // 事件与 host 状态一致。
      expect((await getInstanceState(page, instanceId)).status).toBe('completed')
      // 页面终态徽标一致。
      await expect(page.locator('[data-sandore-run-view]').last().getByText('已完成').first())
        .toBeVisible({ timeout: 45_000 })
    } finally {
      await close()
    }
  })

  test('⑫ 外层时间线窗口：截断 → 「加载更早」出现 → 点击扩窗（真实 DOM）', async ({ browser, dsh, workspace }) => {
    test.setTimeout(180_000)
    // 用原生 browser 新建 page（不需要 harness 的 page fixture 预导航，流程自持）。
    const context = await browser.newContext({ viewport: { width: 1700, height: 1000 }, locale: 'zh-CN' })
    const page = await context.newPage()
    try {
      await page.goto(dsh.url, { waitUntil: 'domcontentloaded' })
      await dismissOnboarding(page)
      await expect(page.locator('[data-sandore-seat-entry]').first()).toBeVisible({ timeout: 30_000 })
      await ensureDefinition(page, CHAIN_WORKFLOW_YAML, CHAIN_WORKFLOW_NAME)

      await openSeat(page)
      await switchListMode(page, '实例')

      const requirement = `e2e-f-window-${randomUUID().slice(0, 8)}`
      const instanceId = await createInstanceFromUi(page, {
        workflowName: CHAIN_WORKFLOW_NAME,
        requirement,
        cwd: workspace,
      })
      await expect
        .poll(async () => (await getInstanceState(page, instanceId)).status, { timeout: 90_000 })
        .toBe('completed')
      const state = await getInstanceState(page, instanceId)
      expect(state.executedSteps.length, '长链定义应执行 7 个 step').toBe(CHAIN_STAGE_COUNT)

      const timeline = page.locator('[data-sandore-timeline]').last()
      await expect(timeline).toBeVisible({ timeout: 30_000 })

      // ① 窗口截断：step 卡片数**恰为**默认窗口 TIMELINE_MAX_STEPS（7 步 > 5）——
      //    这条断言直接证明尾部窗口生效（否则会全量渲染 7 个重组件）。
      const stepCards = timeline.locator('[data-tl-step]')
      await expect(stepCards).toHaveCount(TIMELINE_MAX_STEPS, { timeout: 30_000 })

      // ② 「加载更早」出现，且带未渲染条数（`run.loadOlder` + hidden）。
      //    注意 hidden 是**时间线条目**口径（`visibleTimelineWindow` 返回的切片起点），
      //    条目 = step 卡片 + 夹在中间的 user 消息，所以 hidden ≥ 被截断的 step 数。
      const older = timeline.locator('button', { hasText: '加载更早' })
      await expect(older).toBeVisible()
      const olderLabel = (await older.innerText()).trim()
      const hiddenCount = Number(/·\s*(\d+)/.exec(olderLabel)?.[1])
      expect(Number.isInteger(hiddenCount), `「加载更早」应带剩余条数，实际文案「${olderLabel}」`).toBe(true)
      expect(hiddenCount).toBeGreaterThanOrEqual(CHAIN_STAGE_COUNT - TIMELINE_MAX_STEPS)
      expect(hiddenCount).toBeLessThanOrEqual(CHAIN_STAGE_COUNT)

      // ③ 点击扩窗：一页 = TIMELINE_STEPS_PAGE（5）→ 7 步全部渲染，「加载更早」消失。
      await older.click()
      await expect(stepCards).toHaveCount(CHAIN_STAGE_COUNT, { timeout: 30_000 })
      await expect(older).toHaveCount(0)
      // 策略常量自检：默认窗口 + 一页 ≥ 长链步数（7），所以一次点击即可全量。
      expect(TIMELINE_MAX_STEPS + TIMELINE_STEPS_PAGE).toBeGreaterThanOrEqual(CHAIN_STAGE_COUNT)
    } finally {
      await context.close()
    }
  })
})
