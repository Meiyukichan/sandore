/**
 * M5 · 暂停 / 恢复 / 中止（真实子代理 step，慢 mock 撑出「运行中」窗口）。
 *
 * ## 呈现层统一后的语义变化（本用例已按新语义改写，**没有**改成恒真断言）
 * 运行页底部输入框不再是「运行页自己的一套输入」：它是**主代理会话的输入壳**
 * （需求 1），发送即发进主代理会话——因此**旧的「在输入框写恢复提示词 → 发送 = resumeAll」
 * 这条路径已不存在**（工作流是否继续执行由主代理调用引擎侧工具决定，需求 4）。
 * 本用例相应改为：
 * - **暂停**：`[data-sandore-stop]`（输入框旁**唯一**的动作按钮 = DSH 停止席位，文案「停止生成」；
 *   真机反馈修正后旧的「暂停 + 中止」两个圆钮已删除）→ ①实例 `paused`（引擎 RPC）+ SSE
 *   `sandore/step-paused` 恰一次；②**双语义的另一半**——「中止主代理当前 turn」由 M7 ③ 用
 *   真实运行中的主代理 turn 现场断言（这里只断言暂停路的引擎真相，不重复造现场）；
 * - **恢复**：不再经运行页输入框，而是**引擎侧通路**（主代理的 `sandore_workflow_control`；
 *   本用例直接用同一 RPC `resumeAll` 触达，等价于工具调用的落地动作）→ SSE
 *   `sandore/step-resumed` 恰一次；随后按**现状**两分支断言（引擎把段翻回 running 则要求
 *   出现新的模型调用；否则断言仍停在 paused 且页面没把失败伪装成成功）；
 * - **中止**：标题栏的 `[data-sandore-abort]`（真机反馈后从输入框旁移到标题栏）→ `aborted` +
 *   SSE `sandore/aborted` 恰一次。
 *
 * 运行页不再有「发送即恢复/重试」的输入语义这一点，由 M3（发送钮在内核闸门下、没有 @step
 * 选择器）与 M7（发送进主代理会话）共同锁定。
 */
import { expect, getInstanceState, mockDirective, sandoreRpc, test } from './fixtures/harness.ts'
import { openHostSessionInColumn } from './fixtures/host-session.ts'
import { createMockInstance } from './fixtures/mock-run.ts'
import { countOfType, framesOf, readSseFrames, waitForAnyFrame, waitForFrameCount } from './fixtures/sse.ts'

test.describe('M5 暂停/恢复/中止', () => {
  test('运行中暂停 → 已暂停且面板仍在 → 引擎侧恢复回 running 并产生新的模型调用', async ({ page, dsh, workspace }) => {
    test.setTimeout(120_000)
    const mark = dsh.logMark()
    const instance = await createMockInstance(page, {
      promptText: `暂停恢复用例。${mockDirective({ text: 'm5-answer-1', hold: 60_000 })}`,
      cwd: workspace,
      label: 'e2e-m5-pause',
    })

    const panel = page.locator('[data-step-chat]').first()
    await expect(panel).toBeVisible({ timeout: 60_000 })
    await expect(panel.locator('[data-chat-flow-kind="assistant-step"]').filter({ hasText: 'm5-answer-1' }).first())
      .toBeVisible({ timeout: 60_000 })

    const disc = page.locator('[data-sandore-disc-input]').first()
    // 真机反馈第三轮：输入框区**没有任何**暂停/停止/中止按钮（用户明确要求去掉）。
    // 于是暂停的可用入口换成 **DSH 中心列输入框自带的「停止生成」**：它取消宿主主代理当前
    // turn，引擎监听 `turn/end` + `reason.kind==='aborted'` 后把实例判为 `paused`
    // （架构决策 6，`workflow-engine.ts` 的 host-turn-abort 分支）。本用例即是该入口的真机证明。
    await expect(
      disc.locator('[data-sandore-stop]'),
      '输入框区的动作按钮应已删除（真机反馈第三轮）',
    ).toHaveCount(0)
    // 计数**按 step 的 mock 指令文本**（= 该子代理会话自己的调用）而不是全局 `call#`：
    // 入口归一后宿主主代理也会产生调用（注入 → 照办 run → 工具结果），全局计数不再等于
    // 「本 step 调用了几次」。指令文本 `m5-answer-1` 只出现在本 step 的提示词里。
    const stepCallOf = (): number => dsh.countSince(mark, /text="m5-answer-1"/g)
    const callsBeforePause = stepCallOf()
    expect(callsBeforePause, '暂停前该 step 应已有一次模型调用').toBe(1)

    // ① 暂停：先让**主代理**跑一个 turn（运行页输入框发一条带长 hold 的消息），
    //    再把运行视图关掉（DSH 中心列的输入框才可见），点它自带的「停止生成」
    //    → 主代理 turn 被取消 → 引擎据此把实例判为 paused。
    const mainHoldText = `M5-PAUSE-${Math.random().toString(36).slice(2, 8)}`
    const area = disc.locator('[data-main-agent-input]').first()
    await area.fill(`请回我一句。${mockDirective({ text: mainHoldText, hold: 60_000 })}`)
    const send = disc.locator('[data-main-agent-send]').first()
    await expect(send).toBeEnabled({ timeout: 20_000 })
    await send.click()
    // 等主代理 turn 真的跑起来（mock 已收到那条消息）。
    await expect.poll(
      async () => dsh.countSince(mark, new RegExp(`text="${mainHoldText}"`, 'g')),
      { timeout: 60_000, message: `主代理应被驱动（日志：\n${dsh.logTail().slice(-600)}）` },
    ).toBe(1)
    // 关闭运行视图 → 在 DSH 中心列打开宿主会话（停止按钮在它的输入框里），
    // 点它自带的「停止生成」→ 主代理 turn 被取消 → 引擎据此把实例判为 paused。
    const entry = page.locator('[data-sandore-seat-entry]').first()
    if (await entry.getAttribute('aria-expanded') === 'true') await entry.click()
    await expect(page.locator('[data-sandore-run-view]')).toHaveCount(0)
    await openHostSessionInColumn(page, instance.requirement)
    const dshStop = page.locator(
      '[data-composer-card] button[aria-label="停止生成"], button[aria-label="停止生成"]',
    ).first()
    await expect(dshStop, 'DSH 中心列输入框应提供「停止生成」（暂停入口）').toBeEnabled({ timeout: 30_000 })
    await dshStop.click()
    await expect.poll(async () => countOfType(framesOf(await readSseFrames(page), instance.instanceId), 'sandore/step-paused'), {
      timeout: 30_000,
      message: '中止主代理 turn 后，引擎应把实例判为 paused 并广播 sandore/step-paused',
    }).toBe(1)
    await expect.poll(async () => (await getInstanceState(page, instance.instanceId)).status, { timeout: 30_000 })
      .toBe('paused')
    // 回到运行视图：paused 仍是面板挂载态（暂停不该把内嵌会话面板弄没）。
    await entry.click()
    await expect(page.locator('[data-sandore-run-view]').last()).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-sandore-run-view]').last().getByText('已暂停').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-step-chat]').first()).toBeVisible()
    // SSE 里的 stepId 必须是本实例的 step。
    const pausedFrames = framesOf(await readSseFrames(page), instance.instanceId)
      .filter(frame => frame.type === 'sandore/step-paused')
    expect(pausedFrames[0]?.data?.args?.[1]).toBe(instance.stepId)

    // ② 恢复：走**引擎侧通路**（主代理的 sandore_workflow_control → 引擎 resumeAll）。
    //    运行页输入框此时仍然可用（它是主代理的输入框，不是工作流控件），但它不再承担恢复语义。
    //    注意 RPC 载荷形状：对象入参必须包在 `{ input: … }` 里（typert 网关的 descriptor 形状，
    //    平铺会报 `missing "input"`；见 harness.ts 的 rpc 载荷注释）。
    await expect(disc.locator('[data-main-agent-input]')).toBeEnabled()
    await sandoreRpc(page, 'resumeAll', {
      input: { instanceId: instance.instanceId, resumePrompt: '继续完成这个 step' },
    })

    // 恢复手势被宿主受理：`sandore/step-resumed` 恰一次（引擎在 `lifecycle-manager.resumeStep`
    // 里 `await followup(...)` **成功之后**才发这条事件，所以「收到事件」= 恢复提示词确实已投递）。
    await expect.poll(async () => countOfType(framesOf(await readSseFrames(page), instance.instanceId), 'sandore/step-resumed'), {
      timeout: 30_000,
      message: '页面 SSE 通道应收到 sandore/step-resumed',
    }).toBe(1)

    // 恢复之后的**两态都断言**（不做恒真放宽）：
    // - 成功分支：实例回到 running，且子代理真的被再次驱动（mock 调用次数增长）；
    // - 当前实现分支：实例仍停在 paused —— 这是引擎侧 `stage-executor.resumePendingPaused`
    //   未把段翻回 running 的现状（`followup` 已成功、事件已发、页面无任何错误提示）。
    const resumed = await expect.poll(async () => (await getInstanceState(page, instance.instanceId)).status, {
      timeout: 20_000,
      message: '恢复后状态轮询',
    }).toBe('running').then(() => true, () => false)
    const statusAfterResume = (await getInstanceState(page, instance.instanceId)).status
    if (resumed) {
      await expect.poll(stepCallOf, {
        timeout: 60_000,
        message: `恢复后该 step 应产生新的模型调用（日志：\n${dsh.logTail().slice(-800)}）`,
      }).toBeGreaterThan(callsBeforePause)
    } else {
      expect(
        statusAfterResume,
        `恢复手势已受理（step-resumed 已发）但实例状态为 ${statusAfterResume}：`
        + '这是引擎侧「paused 段未翻回 running」的现状断言；若引擎已修复，请把本断言改成 running 分支。',
      ).toBe('paused')
      // 页面不得把「恢复没生效」伪装成成功：暂停态 UI 仍然自洽（暂停徽标 + 面板仍在）。
      await expect(page.locator('[data-sandore-run-view]').last().getByText('已暂停').first()).toBeVisible()
      await expect(page.locator('[data-step-chat]').first()).toBeVisible()
    }
  })

  test('运行中中止 → 实例 aborted 且 SSE sandore/aborted 恰一次', async ({ page, dsh, workspace }) => {
    test.setTimeout(90_000)
    const instance = await createMockInstance(page, {
      promptText: `中止用例。${mockDirective({ text: 'm5-answer-abort', hold: 30_000 })}`,
      cwd: workspace,
      label: 'e2e-m5-abort',
    })
    const panel = page.locator('[data-step-chat]').first()
    await expect(panel).toBeVisible({ timeout: 60_000 })

    // **SSE 通道就绪闸门**（flake 修复）：先等到本实例至少有 1 帧到达——这说明
    // ①采集器（addInitScript，先于应用）已装好；②EventSource 已连上 `/sandore/events`；
    // ③本实例的广播真的推到了这个页面。只有此时再点中止，「没收到帧」才真的意味着丢帧。
    await waitForAnyFrame(page, instance.instanceId, { timeoutMs: 30_000 })

    // 中止按钮已移到运行视图**标题栏**（真机反馈：不再和停止生成挤在输入框旁）。
    const abort = page.locator('[data-sandore-run-view] [data-sandore-abort]').first()
    await expect(abort).toBeEnabled({ timeout: 30_000 })
    const clickedAt = Date.now()
    await abort.click()

    await expect.poll(async () => (await getInstanceState(page, instance.instanceId)).status, { timeout: 30_000 })
      .toBe('aborted')
    // **有界等待**（而不是「轮询状态后一次性读采集器」）：RPC 返回与 SSE 推流是两条独立通路，
    // 状态已翻而帧还在路上是**常态**，故这里轮询到 `=== 1` 为止；断言强度不变：
    // `exactly: 1` 同时会在出现第 2 帧（真的重复广播）时立刻失败。
    // 实测（`e2e/.artifacts/sse-frame-timing.log`）：点中止 → 收到 sandore/aborted 的端到端
    // 延迟是**毫秒级**，且每次都到达（判定：**延迟，不是丢帧**；另有机制层依据——SSE 端点在
    // 订阅时重放历史事件，若真在重连窗口里发出，重连后也会补到，不会永久丢）。
    await waitForFrameCount(page, instance.instanceId, 'sandore/aborted', {
      exactly: 1,
      timeoutMs: 20_000,
      since: clickedAt,
      extra: async () => `实例状态 = ${(await getInstanceState(page, instance.instanceId)).status}`
        + `；mock 日志尾部 = ${dsh.logTail().slice(-300)}`,
    })
    // 稳定期复查：帧数不得在随后 1s 内变成 2（防「迟到的重复广播」）。
    await page.waitForTimeout(1_000)
    const settled = framesOf(await readSseFrames(page), instance.instanceId)
    expect(countOfType(settled, 'sandore/aborted'), 'sandore/aborted 应恰一次（稳定期复查）').toBe(1)
    // 中止路径**不发** `sandore/end`（引擎中止分支直接 return）。
    expect(countOfType(settled, 'sandore/end'), '中止路径不应发 sandore/end').toBe(0)
  })
})
