/**
 * M2 · turn-process 折叠语义（**turn 闭合**后才折叠）。
 *
 * 判定来源（`packages/client/step-view/step-row-data.ts` 的 `stepChatProcessSeatOf`，
 * 逐字移植 rc.1 `ChatNodeSeat`）：
 * - `windowReady` 要求 `presentation.turnClosed`（该轮**已闭合**）+ 有答复边界 + 历史完整；
 * - 成员行（`[data-turn-process-member]`）= 进程窗口 [processStartSeq, answerAnchorSeq)
 *   内的非独立行 → 折叠时带 `hidden`（行壳 `hidden="until-found"`）；
 * - 答复行（`[data-turn-process-answer]`）= `assistant-step` 且是 `answerStep`，折叠时**可见**；
 * - turn-process 控制行在窗口未就绪时是 `controllerInactive` → **整行隐藏**（这也是
 *   「单轮未闭合时不折叠」的对照现象）。
 *
 * 因此本用例必须造出「前一轮已闭合、当前仍在 running」的窗口：先让子代理跑完第一轮
 * （3 次工具调用 + 答复文本），在 hold 窗口内**再给该 step 排一条消息** → 第一轮闭合、
 * 第二轮开始 → 此时才出现折叠。
 *
 * 对照组（**窗口不全时不折叠**）就在同一用例的第一步：第一轮还开着时，成员行/答复行
 * 锚点计数必须为 0 —— 这样「折叠」不是恒真断言，而是有真值的两态差异。
 *
 * **呈现层统一（本批）**：面板内嵌输入框与运行页的 `@step` 选择器**都已移除**，故排队第二条
 * 消息的新路径是「运行页主代理输入壳里用自然语言说 → 主代理调用引擎侧
 * `sandore_workflow_send_message`」（与 M4① 完全同一条链路；本用例用 mock 指令驱动那次
 * 工具调用，投递对账改用页面 SSE 的 `sandore/step-message` 帧 —— 新语义下投递
 * **不再写** host 的 `userMessages`，见 M13）。
 */
import { expect, getInstanceState, mockDirective, test } from './fixtures/harness.ts'
import { createMockInstance } from './fixtures/mock-run.ts'
import { frameArg, framesOf, readSseFrames } from './fixtures/sse.ts'

/** 第一轮的工具调用轮数（决定披露头的 tool-calls 计数）。 */
const TOOL_ROUNDS = 3

test.describe('M2 turn-process 折叠', () => {
  test('turn 未闭合不折叠（对照）；排队第二条消息后前一轮闭合 → 成员行隐藏、答复行可见', async ({ page, dsh, workspace }) => {
    test.setTimeout(120_000)
    const instance = await createMockInstance(page, {
      promptText: `折叠语义用例。${mockDirective({
        text: 'm2-first-answer',
        tools: TOOL_ROUNDS,
        tool: 'write',
        toolargs: '{"file_path":"m2-round-{n}.txt","content":"r{n}"}',
        // 每轮答复后仍留 20s 窗口：足够完成「未折叠」对照断言、排队第二条消息，
        // 并在第二轮 running 期间做完折叠断言与展开交互。
        hold: 20_000,
      })}`,
      cwd: workspace,
      label: 'e2e-m2-fold',
    })

    const panel = page.locator('[data-step-chat]').first()
    await expect(panel).toBeVisible({ timeout: 60_000 })
    const answerRow = panel.locator('[data-chat-flow-kind="assistant-step"]').filter({ hasText: 'm2-first-answer' })
    await expect(answerRow.first()).toBeVisible({ timeout: 60_000 })

    // ── 对照组：第一轮尚未闭合（hold 窗口内）→ 不折叠。
    await expect(panel.locator('[data-turn-process-member]')).toHaveCount(0)
    await expect(panel.locator('[data-turn-process-answer]')).toHaveCount(0)
    // 控制行此时是「未就绪」态：整行 hidden（`controllerInactive`）。
    await expect(panel.locator('[data-chat-flow-kind="turn-process"][hidden]')).toHaveCount(1)

    // ── 排队第二条消息（呈现层统一后：唯一入口 = 运行页主代理输入框 + 主代理工具调用）。
    // **为什么不能用面板 composer**：面板内嵌输入框（含 @ 触发菜单）已整块移除；
    // 运行页的 `@step` 选择器也已退役。用户在**独立的主代理输入框**里用自然语言说「给这个 step
    // 发消息」，由主代理按注入的协作上下文调用 `sandore_workflow_send_message` 完成投递
    // （本条消息内嵌 mock 指令，让宿主主代理那一次模型调用产出该 tool-call）。
    const disc = page.locator('[data-sandore-disc-input]').first()
    const surface = disc.locator('[data-main-agent-input]').first()
    await expect(surface).toBeVisible({ timeout: 30_000 })
    await expect(surface).toBeEnabled()
    // **必须单行**：主代理输入框里 Enter 就是发送（换行要 Shift+Enter），多行文本会被拆成多条消息。
    // **`once=1`**：让主代理在收到这条消息后的**下一次**调用产出 send_message 的 tool-call
    // （按次数写 `tools=K` 不可预知——工具结果回灌/终态通知都会占号）。
    await surface.fill(
      `请把下面这句话发给步骤 ${instance.stepId}：m2-second-turn ${mockDirective({
        once: 1,
        tool: 'sandore_workflow_send_message',
        toolargs: `{"targets":["${instance.stepId}"],"message":"m2-second-turn"}`,
      })}`,
    )
    const sendButton = disc.locator('[data-main-agent-send]').first()
    await expect(sendButton).toBeEnabled({ timeout: 30_000 })
    await sendButton.click()
    // 投递可见证据（新语义）：页面 SSE 收到该 step 的 `sandore/step-message` 帧，且载荷文本
    // 就是这条消息。**不再**用 host `userMessages` 对账 —— 投递已不写 state（M13 锁死）。
    await expect.poll(async () => {
      const frames = framesOf(await readSseFrames(page), instance.instanceId)
        .filter(frame => frame.type === 'sandore/step-message')
      return frames.filter(frame => frameArg(frame, 3) === 'm2-second-turn').length
    }, { timeout: 60_000, message: '主代理工具调用应把第二条消息投递给该 step（SSE 帧对账）' }).toBe(1)

    // ── 第一轮闭合后：折叠出现（成员行隐藏 + 答复行可见）。
    const members = panel.locator('[data-turn-process-member]')
    await expect.poll(async () => members.count(), {
      timeout: 60_000,
      message: '第一轮闭合后应出现进程成员行锚点',
    }).toBeGreaterThanOrEqual(1)
    const memberCount = await members.count()
    await expect(panel.locator('[data-turn-process-member][hidden]')).toHaveCount(memberCount)

    const foldedAnswer = panel.locator('[data-turn-process-answer]')
    await expect(foldedAnswer).toHaveCount(1)
    await expect(foldedAnswer).toBeVisible()
    await expect(foldedAnswer).toContainText('m2-first-answer')

    // 控制行转为「可折叠」：披露头带本轮的 tool-calls 计数，且默认收起（aria-expanded=false）。
    const disclosure = panel.locator('[data-turn-process]').first()
    await expect(disclosure).toBeVisible({ timeout: 30_000 })
    await expect(disclosure).toHaveAttribute('data-turn-process-tool-calls', String(TOOL_ROUNDS))
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    // 折叠只发生在**已闭合**的那一轮：turn 1 的控制行不再 hidden，而当前仍在跑的 turn 2
    // 控制行恰好是 `controllerInactive`（hidden）——两条断言互为对照，避免「只看总数」。
    const turn1ProcessRow = panel.locator('[data-chat-flow-kind="turn-process"][data-chat-turn="1"]')
    expect(await turn1ProcessRow.getAttribute('hidden'), 'turn 1 的控制行折叠后应可见').toBeNull()
    await expect.poll(async () => panel.locator('[data-chat-flow-kind="turn-process"][hidden]').count(), { timeout: 15_000 })
      .toBe(1)
    expect(await panel.locator('[data-chat-flow-kind="turn-process"][hidden]').first().getAttribute('data-chat-turn'))
      .toBe('2')
    // 成员行全部属于已闭合的 turn 1。
    await expect(panel.locator('[data-chat-turn="1"][data-turn-process-member]')).toHaveCount(memberCount)

    // 展开披露头 → 成员行全部回到可见（折叠是**可逆**的交互，不是不可恢复的截断）。
    await disclosure.click()
    await expect.poll(async () => panel.locator('[data-turn-process-member][hidden]').count(), { timeout: 15_000 }).toBe(0)
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true')

    // 实例仍在跑（第二轮），面板未卸载 —— 上面所有断言都发生在同一次挂载内。
    expect((await getInstanceState(page, instance.instanceId)).status).toBe('running')
  })
})
