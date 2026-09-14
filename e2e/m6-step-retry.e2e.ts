/**
 * M6 · failed 段的复试行三模式（continue / revert / fork）。
 *
 * ## 现场真值（本用例的断言全部来自实测，不是设计文档推断）
 * - failed 的真实子代理 step 会挂载 StepChatPanel，**open 态**下复试行落在
 *   **面板底部动作位** `[data-step-chat-retry-seat]`（需求 1 起那个位置不再有输入框；
 *   历史位置曾是 composer seat）：
 *   `[data-step-chat-retry-row]`（`data-step-chat-retry-step="<stepId>"`）+ 三个模式按钮
 *   `[data-step-chat-retry-mode="continue|revert|fork"]`（文案 继续/回退/分叉）+ 提交
 *   `[data-step-chat-retry-submit]`（文案 重试），提交默认可用；
 *   提交的 `message` 是**固定默认串**（需求 1：面板没有草稿可作载荷，见
 *   `step-view/StepRetryRow.tsx` 头注释）；
 * - 点提交后，引擎**在提交任何新段/事件之前** fail-fast（`recovery-manager.retryStep` 的
 *   F1 语义：DSH 0.1.2-rc.1 对已结算子代理 dispose，continuable 状态已注销）→
 *   页面原样展示引擎文案 `[data-step-chat-retry-error]` + 引导 `[data-step-chat-retry-disposed]`，
 *   且**不产生** `sandore/step-retried` 事件（这也是「提交前 fail-fast」的可对账证据）；
 * - 因此本用例断言的是**引擎+面板的真实契约**：三模式入口齐全、提交手势可达、失败语义
 *   原样可见、事件序里没有伪造的重试；而**不是**「重试成功」。后者在本 DSH 版本不可达
 *   （已结算子代理被 dispose），报告里作为已知缺口说明。
 *
 * 事件序对账：`step-failed` 恰一次、`step-retried` 恰 0 次、实例终态 failed 不变。
 */
import { expect, getInstanceState, mockDirective, test } from './fixtures/harness.ts'
import { createMockInstance } from './fixtures/mock-run.ts'
import { countOfType, frameArg, framesOf, readSseFrames, waitForFrameCount } from './fixtures/sse.ts'

/** 让 step 稳定失败的最小指令：模型侧直接以 error 终止（不吃 hold，失败快且可复现）。 */
const FAIL_DIRECTIVE = mockDirective({ fail: true })

test.describe('M6 failed 段复试行', () => {
  test('三模式入口齐全；continue 提交暴露引擎 fail-fast 语义且不伪造 step-retried', async ({ page, workspace }) => {
    test.setTimeout(90_000)
    const instance = await createMockInstance(page, {
      promptText: `重试（continue）用例。${FAIL_DIRECTIVE}`,
      cwd: workspace,
      label: 'e2e-m6-continue',
    })
    await expect.poll(async () => (await getInstanceState(page, instance.instanceId)).status, { timeout: 60_000 })
      .toBe('failed')

    const panel = page.locator('[data-step-chat]').first()
    await expect(panel).toBeVisible({ timeout: 30_000 })

    // ① 复试行：锚点 + 步骤定位 + 三个模式 + 提交按钮。
    const row = panel.locator('[data-step-chat-retry-row]').first()
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row).toHaveAttribute('data-step-chat-retry-step', instance.stepId)
    const modes = row.locator('[data-step-chat-retry-mode]')
    await expect(modes).toHaveCount(3)
    for (const mode of ['continue', 'revert', 'fork'] as const) {
      await expect(row.locator(`[data-step-chat-retry-mode="${mode}"]`)).toBeEnabled()
    }
    // 复试行与面板底部的归属：open 态下落在**底部动作位**（需求 1：这个位置原先是
    // 输入框 seat，现在是重试行所在）；占位态那份在
    // `[data-step-chat-retry-placeholder]` 内，见 StepChatPanel 的两条渲染路径。
    expect(await row.evaluate(node => node.closest('[data-step-chat-retry-seat]') !== null)).toBe(true)
    // 需求 1：面板内不再有输入框（这条断言与 M3 一致，此处顺带锁住 failed 段同款结构）。
    await expect(panel.locator('[data-step-chat-composer-seat]')).toHaveCount(0)
    await expect(panel.locator('[data-composer-input]')).toHaveCount(0)

    // ② 提交 continue：引擎 fail-fast 文案原样展示 + 销毁引导。
    await row.locator('[data-step-chat-retry-submit]').click()
    const error = panel.locator('[data-step-chat-retry-error]').first()
    await expect(error).toBeVisible({ timeout: 30_000 })
    await expect(error).toContainText('不能重试')
    await expect(panel.locator('[data-step-chat-retry-disposed]').first()).toBeVisible()

    // ③ 事件对账：step-failed 恰一次、**没有** step-retried（fail-fast 发生在提交任何新段之前）、
    //    实例仍是 failed（没有半提交状态）。
    //    **有界等待**（时序 flake 修复，见 fixtures/sse.ts 模块头）：失败广播与前端文案是两条
    //    通路，帧可能稍晚到达；`exactly: 1` 保证「恰一次」的强度不变（出现第 2 帧立刻失败）。
    await waitForFrameCount(page, instance.instanceId, 'sandore/step-failed', {
      exactly: 1,
      timeoutMs: 20_000,
      extra: async () => `实例状态 = ${(await getInstanceState(page, instance.instanceId)).status}`,
    })
    const frames = framesOf(await readSseFrames(page), instance.instanceId)
    expect(countOfType(frames, 'sandore/step-failed'), 'step-failed 应恰一次').toBe(1)
    expect(countOfType(frames, 'sandore/step-retried'), 'fail-fast 路径不应发出 step-retried').toBe(0)
    expect(frameArg(frames.find(frame => frame.type === 'sandore/step-failed')!, 1)).toBe(instance.stepId)
    expect((await getInstanceState(page, instance.instanceId)).status).toBe('failed')
  })

  test('revert / fork 模式：切换模式拉取回退点候选，提交后同样暴露引擎语义', async ({ page, workspace }) => {
    test.setTimeout(90_000)
    const instance = await createMockInstance(page, {
      promptText: `重试（revert/fork）用例。${FAIL_DIRECTIVE}`,
      cwd: workspace,
      label: 'e2e-m6-revert',
    })
    await expect.poll(async () => (await getInstanceState(page, instance.instanceId)).status, { timeout: 60_000 })
      .toBe('failed')

    const panel = page.locator('[data-step-chat]').first()
    const row = panel.locator('[data-step-chat-retry-row]').first()
    await expect(row).toBeVisible({ timeout: 30_000 })

    // revert 模式：出现回退点选择位（`listRevertBoundaries` 已拉取；子代理已销毁 → 候选为空
    // 或不可用，面板给出可读占位而不是崩掉）。
    await row.locator('[data-step-chat-retry-mode="revert"]').click()
    const boundary = row.locator('[data-step-chat-retry-boundary]')
    await expect(boundary).toBeVisible({ timeout: 30_000 })
    // 回退点为空时面板禁用选择位并给空选项（不静默提交一个不存在的边界）。
    const boundaryDisabled = await boundary.isDisabled().catch(() => false)
    if (boundaryDisabled) {
      await expect(boundary.locator('option')).toHaveCount(1)
    }

    // fork 模式：切过去后回退点选择位消失（fork 不需要用户选边界）。
    await row.locator('[data-step-chat-retry-mode="fork"]').click()
    await expect(row.locator('[data-step-chat-retry-boundary]')).toHaveCount(0)

    // 提交（fork）：同样落到引擎 fail-fast，错误行可见、实例状态不变。
    await row.locator('[data-step-chat-retry-submit]').click()
    await expect(panel.locator('[data-step-chat-retry-error]').first()).toBeVisible({ timeout: 30_000 })
    const frames = framesOf(await readSseFrames(page), instance.instanceId)
    expect(countOfType(frames, 'sandore/step-retried'), 'fail-fast 路径不应发出 step-retried').toBe(0)
    expect((await getInstanceState(page, instance.instanceId)).status).toBe('failed')
  })
})
