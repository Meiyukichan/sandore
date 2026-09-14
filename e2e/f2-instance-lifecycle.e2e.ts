/**
 * F 层用例 · 阶段 2：建实例（含 cwd browse 路径）/ running 渲染 / 能力边界 / 完成与中止。
 *
 * F 层定义：**无 LLM**（纯 shell 步），全绿、秒级～十几秒。
 * 前置：隔离 3090 实例由 `dsh` fixture 拉起；定义经 RPC 幂等导入。
 */
import { randomUUID } from 'node:crypto'

import {
  createInstanceFromUi, ensureDefinition, expect, getInstanceState, listDefinitions,
  listInstances, openSeat, switchListMode, test,
} from './fixtures/harness.ts'
import { countOfType, framesOf, readSseFrames, waitForFrameCount } from './fixtures/sse.ts'
import { FAST_ECHO_MARKER, FAST_WORKFLOW_NAME, FAST_WORKFLOW_YAML, SLOW_WORKFLOW_NAME, SLOW_WORKFLOW_YAML } from './fixtures/workflows.ts'

/** 每轮唯一的需求文本（用于从 listInstances 反查 instanceId，避免跨轮撞号）。 */
function uniqueRequirement(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

test.describe('F2 实例生命周期', () => {
  // 前置造数（幂等）：两个 shell 定义。UI 导入路径已由 F1 的 ④ 单独覆盖。
  // 注意：不能用 beforeAll——`page` 是 per-test fixture（playwright 明确禁止）。
  test.beforeEach(async ({ page }) => {
    await ensureDefinition(page, FAST_WORKFLOW_YAML, FAST_WORKFLOW_NAME)
    await ensureDefinition(page, SLOW_WORKFLOW_YAML, SLOW_WORKFLOW_NAME)
  })

  test('⑥ 纯 UI 建实例（含 cwd 浏览「编辑路径」路径）→ 运行视图出现', async ({ page, workspace }) => {
    test.setTimeout(120_000)
    await openSeat(page)
    await switchListMode(page, '实例')

    const requirement = uniqueRequirement('e2e-f-create')
    const definition = (await listDefinitions(page)).find(entry => entry.name === FAST_WORKFLOW_NAME)
    expect(definition, '前置定义应存在').toBeDefined()

    const instanceId = await createInstanceFromUi(page, {
      workflowName: FAST_WORKFLOW_NAME,
      requirement,
      cwd: workspace,
    })

    // 运行视图渲染 + RPC 侧能查到该实例（UI 与 host 一致）。
    await expect(page.locator('[data-sandore-run-view]').last()).toBeVisible()
    const instances = await listInstances(page)
    const created = instances.find(instance => instance.instanceId === instanceId)
    expect(created, 'RPC listInstances 应包含刚创建的实例').toBeDefined()
    // 落库定义键是 `wfl-{uuid}`（importDefinitionFromYaml 走 createDefinition）。
    expect(created?.workflowId).toBe(definition?.id)
    expect(created?.workflowId).toMatch(/^wfl-/)
    expect(created?.originalInput).toBe(requirement)

    // 该用例的实例应最终完成（快定义两个 echo 步），并留下可见的 shell 输出。
    await expect(page.locator('[data-sandore-timeline]').last()).toBeVisible()
    await expect
      .poll(async () => (await getInstanceState(page, instanceId)).status, { timeout: 45_000 })
      .toBe('completed')
    await expect(page.locator('[data-sandore-timeline]').last()).toContainText(FAST_ECHO_MARKER, { timeout: 30_000 })
  })

  test('⑦⑧ 慢 shell 步：running 渲染 + 内嵌会话区不出现（能力边界显式断言）', async ({ page, workspace }) => {
    test.setTimeout(150_000)
    await openSeat(page)
    await switchListMode(page, '实例')

    const requirement = uniqueRequirement('e2e-f-running')
    const instanceId = await createInstanceFromUi(page, {
      workflowName: SLOW_WORKFLOW_NAME,
      requirement,
      cwd: workspace,
    })

    // ⑦ 运行视图渲染：时间线 + step 卡片存在。
    const timeline = page.locator('[data-sandore-timeline]').last()
    await expect(timeline).toBeVisible()
    await expect(page.locator('[data-tl-step]').first()).toBeVisible({ timeout: 30_000 })
    // step 卡片上的状态按钮（aria-label = 状态文案）在 running 时是「运行中」。
    await expect(page.getByRole('button', { name: '运行中' }).first()).toBeVisible({ timeout: 30_000 })
    // 运行中实例的 host 侧状态确为 running（避免与「已完成」混淆）。
    expect((await getInstanceState(page, instanceId)).status).toBe('running')
    // 底部输入区在运行态挂载；输入框区**没有**任何暂停/停止/中止按钮（真机反馈第三轮），
    // 实例「中止」按钮在标题栏（`[data-sandore-abort]`）。
    const composer = page.locator('[data-sandore-disc-input]').first()
    await expect(composer).toBeVisible()
    await expect(composer.locator('[data-sandore-stop]')).toHaveCount(0)
    for (const label of ['暂停', '停止生成', '中止']) {
      await expect(composer.locator(`button[aria-label="${label}"]`)).toHaveCount(0)
    }
    await expect(page.locator('[data-sandore-run-view] [data-sandore-abort]')).toHaveCount(1)

    // ⑧ ★ 能力边界：内嵌会话区 `[data-step-chat]` **只在真实子代理 step 的
    // running/paused 挂载**（UnifiedTimeline 的 realSession 分支）；shell 步是合成会话
    // → 运行期间计数必须为 0。这条断言是 F 层的边界声明，不是缺陷：
    // 内嵌 ChatView / @step / 重试需 mock 或真模型（M/R 层）。
    await page.waitForTimeout(3000)
    expect((await getInstanceState(page, instanceId)).status, 'shell 步应仍在运行（睡眠中）').toBe('running')
    expect(await page.locator('[data-step-chat]').count(), '[data-step-chat] 不应为 shell step 挂载').toBe(0)

    // ⑪ 中止：running 态点标题栏的「中止」→ host 侧已中止 + 引擎广播 `sandore/aborted`。
    const abortClickedAt = Date.now()
    await page.locator('[data-sandore-run-view] [data-sandore-abort]').click()
    await expect
      .poll(async () => (await getInstanceState(page, instanceId)).status, { timeout: 30_000 })
      .toBe('aborted')
    // 状态徽标回落（timeline 或实例列表中出现「已中止」）。
    await expect(page.getByText('已中止').first()).toBeVisible({ timeout: 30_000 })
    // **有界等待**（时序 flake 修复，见 fixtures/sse.ts 的模块头）：RPC 状态翻转与 SSE 广播
    // 是两条独立通路，帧可能稍晚到达；「至少一次」的判据不变（等待空间换成时间，不是放宽）。
    await waitForFrameCount(page, instanceId, 'sandore/aborted', {
      atLeast: 1,
      timeoutMs: 20_000,
      since: abortClickedAt,
    })
    const abortFrames = framesOf(await readSseFrames(page), instanceId)
    // 中止广播**至少**一次：正常路径由 `abortInstance` 单发，另有引擎兜底分支
    // （`workflow-engine.ts:1471-1485` 的竞态守卫）在某些时序下再发一次——最小次数才是契约，
    // 是否为 1 属可用性观感问题，已在交付报告里作为**可改进点**记录（不在 e2e 中放宽为软断言）。
    expect(countOfType(abortFrames, 'sandore/aborted'), '中止应广播 sandore/aborted').toBeGreaterThanOrEqual(1)
    // 中止路径**不发** `sandore/end`（引擎中止分支直接 return，见 workflow-engine.ts:1486）。
    expect(countOfType(abortFrames, 'sandore/end'), '中止路径不应发 sandore/end').toBe(0)
  })

  test('⑨ 实例完成后：状态「已完成」+ shell 输出可见', async ({ page, workspace }) => {
    test.setTimeout(150_000)
    await openSeat(page)
    await switchListMode(page, '实例')

    const requirement = uniqueRequirement('e2e-f-completed')
    const instanceId = await createInstanceFromUi(page, {
      workflowName: FAST_WORKFLOW_NAME,
      requirement,
      cwd: workspace,
    })

    await expect
      .poll(async () => (await getInstanceState(page, instanceId)).status, { timeout: 60_000 })
      .toBe('completed')

    // 页面侧：等 RunView 的轮询/SSE 落到「已完成」。
    const runView = page.locator('[data-sandore-run-view]').last()
    await expect(runView).toBeVisible()
    await expect(runView.getByText('已完成').first()).toBeVisible({ timeout: 45_000 })
    // shell 步的输出（echo 文本）在时间线里可见（MarkdownText 渲染）。
    await expect(page.locator('[data-sandore-timeline]').last()).toContainText(FAST_ECHO_MARKER, { timeout: 30_000 })

    // 终态不做内嵌会话（与 ⑧ 同一条边界，可从完成侧再确认一次）。
    expect(await page.locator('[data-step-chat]').count()).toBe(0)

    // 实例列表里的状态徽标也应为「已完成」（切回列表视图）。
    await switchListMode(page, '实例')
    const row = page.locator('[data-sandore-wf-list] li', { hasText: requirement }).first()
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row.getByText('已完成')).toBeVisible()
  })
})
