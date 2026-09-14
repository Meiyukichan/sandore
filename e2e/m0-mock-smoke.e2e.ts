/**
 * M0 · mock LLM 金路径冒烟：prompt 步真的跑起来，`[data-step-chat]` 真的挂载并显示 mock 输出。
 *
 * 这是 M 层全部用例的**前置证明**（也是排查用最小现场）：
 * 1. 临时 profile 的 `cordis.patch.yml` 把 mock adapter 行挂上了（provider `e2e-mock`）；
 * 2. YAML 的 L1 路由（`providerId`/`modelId`）让 prompt 步走到 mock；
 * 3. 真实子代理（`subagents.startContinuable`，provider `fork`）建起来了；
 * 4. `StepChatPanel` 因此挂载 —— 否则 M1–M6 无从谈起。
 *
 * 用 `hold=8000` 把「内容已完整可见」与「step 仍 running」拉成同一个窗口：面板只在
 * 真实子代理段挂载，而 mock 默认瞬时返回，不 hold 就会与 turn 结束赛跑。
 *
 * **需求 3（本次变更）**：完成（completed）后 step 下方**仍是会话区**——不再被收尾
 * 总结替换成一段「Agent 输出」文本。故本用例在实例 completed 之后再多断言三条：
 * `[data-step-chat]` 计数 ≥ 1、面板内可见会话消息（mock 文本 + user 行）、user 消息行
 * 是折叠标题行（含「用户消息」）。收尾总结仍照旧作为传给后续 step 的输出内容留在引擎
 * 数据层（本用例不碰引擎，只证明它不再显示在卡片下方替代会话区）。
 */
import { MOCK_MODEL, MOCK_PROVIDER, expect, getInstanceState, mockDirective, test } from './fixtures/harness.ts'
import { createMockInstance } from './fixtures/mock-run.ts'

test.describe('M0 mock LLM 金路径', () => {
  test('prompt 步经 mock 模型跑通，内嵌会话面板挂载并显示 mock 输出', async ({ page, dsh, workspace, problems }) => {
    test.setTimeout(90_000)
    const mockText = 'mock-ok-smoke'
    const instance = await createMockInstance(page, {
      promptText: `输出一句话即可。${mockDirective({ text: mockText, hold: 8_000 })}`,
      cwd: workspace,
      label: 'e2e-m0-smoke',
    })

    // ① 内嵌会话面板（真实子代理 step 的 running 态才挂载）。
    const panel = page.locator('[data-step-chat]').first()
    await expect(panel, `未挂载 [data-step-chat]（mock provider ${MOCK_PROVIDER}/${MOCK_MODEL} 可能没生效）\n--- dsh log ---\n${dsh.logTail()}`)
      .toBeVisible({ timeout: 60_000 })

    // ② 面板里出现 mock 文本（= 模型输出真的回流到子代理会话）。
    await expect(panel.getByText(mockText).first())
      .toBeVisible({ timeout: 60_000 })

    // ②b **负向断言**：step 下方不得落在「子代理会话加载失败」态（该错误态是面板内 UI、
    // console 无痕，只断言「面板出现 + console 干净」会漏掉它）。生产真实使用曾出现
    // `subagent/unauthorized: subagent does not belong to the supplied parent`。
    await expect(
      panel.locator('[data-step-chat-open-native]'),
      '面板落在加载失败态（应显示真实消息）',
    ).toHaveCount(0)
    await expect(panel.getByText('子代理会话加载失败')).toHaveCount(0)

    // ③ host 侧对账：该 step 真的 completed（hold 结束后 turn 正常收尾）。
    await expect
      .poll(async () => (await getInstanceState(page, instance.instanceId)).status, { timeout: 60_000 })
      .toBe('completed')
    const state = await getInstanceState(page, instance.instanceId)
    expect(state.executedSteps.map(step => step.stepId)).toEqual([instance.stepId])
    // ④ mock adapter 真的被调用过（host 进程 stderr 里的诊断行）。
    expect(dsh.logTail()).toContain('[e2e-mock] call#')

    // ⑤ **需求 3**：实例 completed 后 step 下方**仍是会话区**（不被收尾总结替换）。
    // 判断标准取自产品要求：completed 的 step 卡片下方能看到会话消息，而不是只剩一段
    // 总结文本。故三条一起断言（面板在 + 面板内有会话消息 + user 行是折叠标题行）。
    await expect(
      page.locator('[data-step-chat]'),
      'completed 后 [data-step-chat] 应仍在（需求 3：不再用收尾总结替换会话区）',
    ).toHaveCount(1)
    const panelAfterDone = page.locator('[data-step-chat]').first()
    await expect(panelAfterDone).toBeVisible()
    // 会话消息仍在：mock 的最终答复文本 + user 消息折叠行（需求 2 的标题文案）。
    await expect(panelAfterDone.getByText(mockText).first()).toBeVisible({ timeout: 30_000 })
    const userFold = panelAfterDone.locator('[data-variant="user"]').first()
    await expect(userFold).toContainText('用户消息')
    await expect(panelAfterDone.locator('[data-chat-flow-kind="assistant-step"], [data-chat-flow-kind="turn-process"]').first())
      .toBeAttached()
    // 过程按官方折叠语义折叠（turn 闭合后 turn-process 控制行出现；成员行 hidden）。
    await expect(panelAfterDone.locator('[data-chat-flow-kind="turn-process"]').first())
      .toBeAttached({ timeout: 30_000 })
    // 面板没有落到「加载失败」占位（completed 段的会话仍可读）。
    await expect(panelAfterDone.locator('[data-step-chat-open-native]')).toHaveCount(0)
    await expect(panelAfterDone.getByText('子代理会话加载失败')).toHaveCount(0)

    expect(problems, `页面出现 console error / pageerror：${problems.join(' | ')}`).toEqual([])
  })
})
