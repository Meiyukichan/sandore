/**
 * M13 · 「引擎自己造的指令性文本不再进 discussion」（用户要求）。
 *
 * ## 背景（用户原话）
 * 之前在工作流执行中「发送消息暂停 → 再发送继续执行：请继续完成当前任务」时，引擎会把这条
 * 恢复指令 `appendUserMessage` 写进实例状态，前端 discussion 区（`[data-sandore-timeline]`
 * 的 `[data-tl-user]` 行）就把它当「用户消息」显示出来。用户要求：**不再显示、也不记录** ——
 * 「现在我们只有 step agent 的消息和 main 代理消息，其他的不展示了；消息给主代理就行」。
 *
 * ## 本用例锁什么（真机、mock LLM、3090 隔离实例）
 * 1. **负向**：`pauseAll` → `resumeAll`（带一条可识别的恢复提示词）之后
 *    - discussion 时间轴的**用户消息行**（`[data-tl-user]`）里没有这条恢复提示词，
 *      且这样的行**恰 1 条**（= 原始需求，旧行为会多出一行带 resume 徽标的用户消息）；
 *    - `getInstanceState` 的 `userMessages` 里**没有**任何 `kind:'resume'` 记录、也没有该文本。
 * 2. **正向对照（防恒真）**：
 *    - 时间轴里**仍有**原始需求那条用户消息（`kind:'input'`，真实用户输入，用户明确保留），
 *      且它是唯一那个带 kind 徽标的行、徽标就是 `input`（`buildTimeline` 的用户消息白名单
 *      只放行真实输入；遗留的 resume/retry/answer/message 行连徽标带气泡一起不渲染）；
 *    - step agent 消息仍正常显示（该 step 面板里能看到它自己的答复文本；恢复指令仍会出现在
 *      **step 子代理自己的会话**里 —— 那正是用户要保留的「step agent 消息」通道）；
 *    - 主代理消息仍正常显示（主代理会话面板里能看到用户自己发的那句话）。
 *
 * 与 M5 的分工：M5 锁「暂停/恢复的引擎语义 + SSE 事件」，本用例只锁「讨论页的展示口径」。
 */
import { expect, getInstanceState, mockDirective, sandoreRpc, test } from './fixtures/harness.ts'
import { createMockInstance } from './fixtures/mock-run.ts'
import { countOfType, framesOf, readSseFrames } from './fixtures/sse.ts'

/** 恢复提示词的识别文本（不出现在定义/需求里，只出现在恢复指令里）。 */
const RESUME_TEXT = 'm13-resume-instruction'

test.describe('M13 恢复指令不进 discussion', () => {
  test('暂停 → 继续：恢复指令不显示、不记录；step agent 与 main 代理消息照常显示', async ({ page, workspace }) => {
    test.setTimeout(180_000)
    const instance = await createMockInstance(page, {
      promptText: `M13 用例。${mockDirective({ text: 'm13-step-answer', hold: 90_000 })}`,
      cwd: workspace,
      label: 'e2e-m13',
    })
    const panel = page.locator('[data-step-chat]').first()
    await expect(panel).toBeVisible({ timeout: 60_000 })
    // 正向对照 ①：step agent 自己的答复先出现（面板 = step agent 消息的展示位）。
    await expect(panel.locator('[data-chat-flow-kind="assistant-step"]').filter({ hasText: 'm13-step-answer' }).first())
      .toBeVisible({ timeout: 60_000 })

    // 主代理侧：用户自己发一句话（这句**应该**在 main 代理消息里显示）。
    const disc = page.locator('[data-sandore-disc-input]').first()
    const surface = disc.locator('[data-main-agent-input]').first()
    await expect(surface).toBeEnabled({ timeout: 30_000 })
    const userLine = 'm13-user-said-this'
    await surface.fill(userLine)
    await disc.locator('[data-main-agent-send]').first().click()
    await expect(page.locator('[data-main-agent-chat]').getByText(userLine).first())
      .toBeVisible({ timeout: 60_000 })

    // 暂停 → 继续（恢复指令带识别文本）。
    await sandoreRpc(page, 'pauseAll', { input: { instanceId: instance.instanceId } })
    await expect.poll(async () => (await getInstanceState(page, instance.instanceId)).status, { timeout: 30_000 })
      .toBe('paused')
    await sandoreRpc(page, 'resumeAll', {
      input: { instanceId: instance.instanceId, resumePrompt: `请继续完成当前任务 ${RESUME_TEXT}` },
    })
    // 恢复手势确实被引擎受理（事件先到，再断言展示面）。
    await expect.poll(async () => countOfType(
      framesOf(await readSseFrames(page), instance.instanceId), 'sandore/step-resumed',
    ), { timeout: 30_000 }).toBeGreaterThan(0)

    // ── 负向断言 1：discussion 的**用户消息行**里没有这条恢复指令 ─────────────────
    // 注意断言面：`[data-tl-user]` 是 discussion 时间轴上的用户气泡（`kind` 徽标那行），
    // 也就是用户报的那条「被加进 discuss 页面的用户消息」。**不能**拿整个
    // `[data-sandore-timeline]` 的文本做负向断言——它里面嵌套着 step 面板，而 step 面板
    // 展示的是该 **step 子代理自己的会话**（系统提示词 + 投递给它的用户消息 + 它的答复），
    // 恢复指令本来就应该出现在那里（那是用户明确要保留的「step agent 消息」）。
    await page.waitForTimeout(1_000)
    const timeline = page.locator('[data-sandore-timeline]').first()
    await expect(timeline).toBeVisible({ timeout: 30_000 })
    const userRows = timeline.locator('[data-tl-user]')
    // 恰 1 行 = 原始需求；恢复指令不能新增一行（旧行为会多出一行带 resume 徽标的用户消息）。
    await expect(userRows, 'discussion 用户消息行应恰为原始需求那一条').toHaveCount(1)
    await expect(userRows.filter({ hasText: RESUME_TEXT })).toHaveCount(0)
    // 活下来的那行必须带 `kind:'input'` 徽标（`buildTimeline` 白名单只放行真实用户输入；
    // 遗留的 resume/retry/answer/message 行连徽标带气泡一起不渲染）。
    await expect(userRows.first().locator('[data-tl-user-kind]')).toHaveAttribute('data-tl-user-kind', 'input')
    await expect(userRows.first().locator('[data-tl-user-kind="resume"], [data-tl-user-kind="retry"], [data-tl-user-kind="message"], [data-tl-user-kind="answer"]'))
      .toHaveCount(0)
    const userRowText = (await userRows.first().innerText()).replace(/\s+/g, ' ')
    expect(userRowText, '唯一那条用户消息应是原始需求').toContain(instance.requirement)
    expect(userRowText, '恢复指令不应出现在 discussion 用户消息行里').not.toContain(RESUME_TEXT)

    // ── 负向断言 2：state 里也没有记录（不显示 = 不记录）────────────────────────
    const state = await getInstanceState(page, instance.instanceId)
    const userMessages = (state.raw.userMessages ?? []) as readonly { kind?: string; content?: string }[]
    expect(
      userMessages.filter(entry => entry.kind === 'resume'),
      'resumeStep/resumeAllSteps 不应再写 userMessages',
    ).toHaveLength(0)
    expect(
      userMessages.filter(entry => (entry.content ?? '').includes(RESUME_TEXT)),
      '恢复提示词不应出现在 state.userMessages 里',
    ).toHaveLength(0)

    // ── 正向对照 ②：原始需求（真实用户输入）仍在时间轴上 ─────────────────────────
    await expect(userRows.filter({ hasText: instance.requirement }).first(), '原始需求那条用户消息应仍在')
      .toBeVisible({ timeout: 30_000 })
    expect(userMessages.filter(entry => entry.kind === 'input')).toHaveLength(1)

    // ── 正向对照 ③：step agent 消息与 main 代理消息都仍在 ────────────────────────
    await expect(panel.locator('[data-chat-flow-kind="assistant-step"]').filter({ hasText: 'm13-step-answer' }).first())
      .toBeVisible()
    await expect(page.locator('[data-main-agent-chat]').getByText(userLine).first()).toBeVisible()
  })
})
