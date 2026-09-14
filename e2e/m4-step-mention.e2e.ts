/**
 * M4 · `@step` 结构化引用已退役 → **自然语言 + 主代理工具调用**（呈现层统一）。
 *
 * ## ① 新的投递路径（本批的核心断言）
 * 用户不再用 `@step` 选择器指定目标，而是**在主代理输入框里用自然语言说**「给 xx 步骤发消息」；
 * 由主代理按其协作上下文调用引擎侧工具 `sandore_workflow_send_message` 完成投递。
 * 本用例用 mock LLM 的指令语法把这条链路**端到端**跑通（不是断言 UI 接线）：
 * - 运行页输入框（主代理输入壳）里输入的消息**自身携带 mock 指令**
 *   （`tools=2 tool=sandore_workflow_send_message toolargs={"targets":["<stepId>"],"message":…}`），
 *   于是宿主主代理的那一次模型调用会产出对应的 tool-call；
 * - 对账三条（三条互相独立，缺一不可）：
 *   1. 页面 SSE `sandore/step-message` 恰一次，`args[1]` = 目标 step 定义 id、`args[3]` = 文本；
 *   2. host 状态**不再新增** `userMessages{kind:'message'}`（新语义：投递只落在子代理会话 +
 *      SSE 帧；discussion 页只展示 step agent 消息与主代理消息，见 M13），而原始需求那条
 *      `kind:'input'` 仍在（对照：不是「一条 userMessages 都没有」）；
 *   3. mock 日志里出现 `[e2e-mock] host-run session=<instanceId>`（宿主主代理真的被驱动了）。
 * - **假通过防线**：目标文本 `m4-step-msg` 与 step id 都不出现在工作流定义/需求里，只出现在
 *   这条消息里；断言的是**引擎收到的投递载荷**（SSE + host 状态），不是页面文案。
 *
 * ## ② 静态入口已删除
 * - 运行页 `[data-sandore-step-picker]` 计数为 0（需求 2：结构化引用入口删除）；
 * - step 面板内没有任何输入面 / 触发菜单（`[data-trigger-menu]` / `[data-composer-input]`）；
 * - 反向对照（非恒真）：同一页面的主代理输入框**真的在**（`[data-main-agent-input]` = 1 且是
 *   原生 `textarea`），所以 ①/② 的「没有」是结构化引用特有的结构，而不是「整页没有输入能力」。
 *
 * 历史沿革：本用例原有两个测试——① 用 picker 定点发送（`sendStepMessage` RPC）；② 面板 composer
 * 的 `@` 菜单 chip。两者都随需求 2 退役：① 改写成上面「自然语言 → 主代理工具调用」，
 * ② 改为静态入口删除 + 主代理输入框存在的对照断言（不改成恒真断言）。
 */
import { expect, getInstanceState, mockDirective, test } from './fixtures/harness.ts'
import { createMockInstance } from './fixtures/mock-run.ts'
import { countOfType, frameArg, framesOf, readSseFrames } from './fixtures/sse.ts'

test.describe('M4 自然语言投递（主代理调用 sandore_workflow_send_message）', () => {
  test('运行页输入框发出的消息 → 主代理调工具 → step 收到定点投递（SSE + host 状态双对账）', async ({ page, dsh, workspace }) => {
    test.setTimeout(120_000)
    const mark = dsh.logMark()
    const instance = await createMockInstance(page, {
      // hold 撑出「step 仍在运行」的窗口：send_message 只接受 running/interacting 的 step。
      promptText: `定点发送用例。${mockDirective({ text: 'm4-run-answer', hold: 60_000 })}`,
      cwd: workspace,
      label: 'e2e-m4-run',
    })
    const panel = page.locator('[data-step-chat]').first()
    await expect(panel).toBeVisible({ timeout: 60_000 })

    // 主代理输入框：**独立实现**的原生 textarea（不再是 DSH 输入内核的 contenteditable）。
    const disc = page.locator('[data-sandore-disc-input]').first()
    const surface = disc.locator('[data-main-agent-input]').first()
    await expect(surface).toBeVisible({ timeout: 30_000 })
    await expect(surface).toBeEnabled()

    const delivered = 'm4-step-msg'
    // 这条消息就是「用户用自然语言让主代理给某个 step 发消息」的等价物：
    // 文本里内嵌 mock 指令，让宿主主代理的那次调用产出 sandore_workflow_send_message 的 tool-call。
    // **必须单行**：主代理输入框里 Enter 就是发送（换行要 Shift+Enter），多行文本会被拆成多条消息。
    // **`once=1` 而不是 `tools=K`**：这条消息是该会话第几次模型调用不可预知（照办 run、工具结果
    // 回灌、终态通知都会占号），`once` 的语义是「指令文本出现即照办一次」，与次数无关。
    const message = `请把下面这句话发给步骤 ${instance.stepId}：${delivered} ${mockDirective({
      once: 1,
      tool: 'sandore_workflow_send_message',
      toolargs: `{"targets":["${instance.stepId}"],"message":"${delivered}"}`,
    })}`
    await surface.fill(message)
    const send = disc.locator('[data-main-agent-send]').first()
    await expect(send).toBeEnabled({ timeout: 30_000 })
    await send.click()

    // ① 页面 SSE：sandore/step-message 恰一次，stepId / 文本都对得上。
    await expect.poll(
      async () => countOfType(framesOf(await readSseFrames(page), instance.instanceId), 'sandore/step-message'),
      {
        timeout: 60_000,
        message: `页面 SSE 应收到 sandore/step-message（日志：\n${dsh.logTail().slice(-800)}）`,
      },
    ).toBe(1)
    const frames = framesOf(await readSseFrames(page), instance.instanceId)
    const frame = frames.find(item => item.type === 'sandore/step-message')!
    expect(frameArg(frame, 1), 'SSE 的 stepId 应为目标 step').toBe(instance.stepId)
    expect(frameArg(frame, 3), 'SSE 的 message 应为目标文本').toBe(delivered)

    // ② host 状态：**不再**为投递新增 userMessages 记录（新语义：投递只落在子代理会话 +
    //    SSE 帧；讨论页只展示 step agent 消息与主代理消息）。原始需求那条 kind:'input' 仍在，
    //    作为对照（证明「没有 message 记录」不是「userMessages 整体消失」）。
    const state = await getInstanceState(page, instance.instanceId)
    const messages = (state.raw.userMessages ?? []) as readonly { kind?: string; target?: string; content?: string }[]
    const recorded = messages.filter(entry => entry.kind === 'message')
    expect(recorded, '投递不应再写 host userMessages（新语义）').toHaveLength(0)
    expect(messages.filter(entry => entry.kind === 'input'), '原始需求（真实用户输入）应仍在').toHaveLength(1)

    // ③ mock 日志：宿主主代理（= 实例宿主会话）真的被驱动。
    //    划窗用 `countSince(mark)`/`logSince(mark)`——`logTail()` 是整个 worker 共享实例的最后
    //    一段，直接正则会把别的用例那行 host-run 抓进来（踩过：断言「宿主会话 id」时抓到上一条用例的）。
    await expect.poll(
      async () => dsh.countSince(mark, /\[e2e-mock\] host-run /g),
      { timeout: 30_000, message: `宿主主代理未被驱动（日志：\n${dsh.logTail().slice(-800)}）` },
    ).toBe(1)
    const hostRun = /\[e2e-mock\] host-run session=(\S+)/.exec(dsh.logSince(mark))
    expect(hostRun?.[1], '宿主照办应发生在实例宿主会话上（非 step 子代理）').toBe(instance.instanceId)
  })

  test('静态入口已删除（运行页无 picker、面板无输入面），而主代理输入框仍在', async ({ page, workspace }) => {
    test.setTimeout(120_000)
    await createMockInstance(page, {
      promptText: `入口用例。${mockDirective({ text: 'm4-panel-answer', hold: 30_000 })}`,
      cwd: workspace,
      label: 'e2e-m4-panel',
    })
    const panel = page.locator('[data-step-chat]').first()
    await expect(panel.getByText('m4-panel-answer').first()).toBeVisible({ timeout: 60_000 })

    // ① 面板内不再有输入面/触发菜单/装饰 chip。
    await expect(panel.locator('[data-trigger-menu]')).toHaveCount(0)
    await expect(panel.locator('[data-composer-input]')).toHaveCount(0)
    await expect(panel.locator('[data-lexical-decorator]')).toHaveCount(0)
    await expect(panel.locator('[data-step-chat-composer-seat]')).toHaveCount(0)

    // ② 需求 2：运行页的 `@step` 选择器（结构化引用入口）已整体删除。
    await expect(page.locator('[data-sandore-step-picker]')).toHaveCount(0)
    // 反向对照（非恒真）：主代理输入框**真的在**（需求 1），故「没有 picker」不是「整页没有输入能力」。
    // 同时它是**独立实现**：不挂 DSH 输入内核（无 `[data-composer-input]`/`[data-composer-kernel]`）。
    const disc = page.locator('[data-sandore-disc-input]').first()
    await expect(disc.locator('[data-main-agent-input]')).toHaveCount(1)
    await expect(disc.locator('[data-composer-input]')).toHaveCount(0)
    await expect(disc.locator('[data-composer-kernel]')).toHaveCount(0)
    await expect(disc.locator('textarea')).toHaveCount(1)
    // 面板内仍然没有输入面（对照：只有运行页那一处）。
    await expect(panel.locator('[data-composer-input]')).toHaveCount(0)
  })
})
