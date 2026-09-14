/**
 * M9 · **step 执行子代理必须全新**的真机断言（2026-09 真机缺陷）。
 *
 * ## 缺陷
 * step 子代理此前经 DSH `fork` provider 创建（`startContinuable({ provider: 'fork' })`），
 * 而 fork provider 会把**父代理（宿主主代理）会话的闭合 turn 前缀**作为 seed 灌进子代理
 * （`packages/subagent/subagent-fork-in-process/src/index.ts:48-54,76-90`，
 * `inheritsParentContext = true`）→ 每个 step 面板里都能看到主代理的「工作流已启动」
 * 「进展更新」等文本。修复：执行类子代理改用 `spawn`（`inheritsParentContext = false`，
 * 无 seed），评估/重试类 fork 保持以 step 会话为源（不变）。
 *
 * ## 本用例断言（真机）
 * 1. 宿主真值：每个 step 段的 `sessionMessages`（来自该 step 自己的子代理会话）**不含**
 *    主代理文本；
 * 2. DOM 真值：**每个** `[data-step-chat]` 面板不含主代理文本（「工作流已启动」/「实例 ID」/
 *    「进展更新」/ 我们的注入标题「## 用户指令」），且该面板**首条 user 行**是本 step 自己的
 *    提示词（`你正在执行工作流中的一个 Step`）。
 *
 * 前置事实：宿主主代理此时**必然**产生过文本（启动注入唤醒 → 照办 `sandore_workflow_run`；
 * 实例终态还有一条收尾通知），所以「面板里没有主代理文本」是有意义的负向断言，而不是空场。
 */
import { expect, getInstanceState, mockDirective, test } from './fixtures/harness.ts'
import { createMockTwoStepInstance } from './fixtures/mock-run.ts'

/**
 * 主代理文本的特征片段（出现即说明父会话历史被 seed 进了 step 子代理）。
 *
 * 注意**不要**把 `## 用户指令` 列进来：它本身就是我们组装给 step 子代理的提示词结构
 * （`PROMPT_MAIN_HEADER` + `<UserInstruction>` 节），属于该 step 自己的上下文。
 */
const HOST_TEXT_MARKERS = [
  '工作流已启动',            // 主代理启动汇报（真机截图里的第一条）
  '实例 ID',                 // 同上
  '进展更新',                // 主代理中途汇报（真机截图里的第二条）
  '[sandore 工作流]',        // 引擎终态通知文本
  '请调用 sandore_workflow_run', // 引擎启动注入（只发给宿主会话）
  '用户选择用工作流「',       // 启动注入首行（只发给宿主会话）
] as const

test.describe('M9 step 执行子代理必须全新', () => {
  test('每个 step 面板的会话只含该 step 自己的上下文，不出现主代理文本', async ({ page, dsh, workspace, problems }) => {
    test.setTimeout(120_000)

    const instance = await createMockTwoStepInstance(page, {
      firstPromptText: `第一步：输出一句话。${mockDirective({ text: 'm9-step-a-ok' })}`,
      secondPromptText: `第二步：输出一句话。${mockDirective({ text: 'm9-step-b-ok' })}`,
      cwd: workspace,
      label: 'e2e-m9-fresh',
    })

    await expect
      .poll(async () => (await getInstanceState(page, instance.instanceId)).status, { timeout: 90_000 })
      .toBe('completed')

    // 前置事实：宿主主代理确实产生过文本（否则下面的负向断言没有意义）。
    // 判据：宿主会话（= 实例 id）的 mock 调用发生过（照办 run 那次）+ 我们注入了协作上下文。
    expect(dsh.logTail()).toContain('[e2e-mock] call#')

    // ── ① 宿主真值：每个 step 段的会话消息（来自子代理会话）不含主代理文本 ──────────
    const state = await getInstanceState(page, instance.instanceId)
    expect(state.executedSteps).toHaveLength(2)
    for (const step of state.executedSteps) {
      const messages = JSON.stringify(step.sessionMessages ?? [])
      for (const marker of HOST_TEXT_MARKERS) {
        expect(
          messages,
          `step ${step.stepId} 的会话消息里出现了主代理文本「${marker}」：${messages}`,
        ).not.toContain(marker)
      }
    }

    // ── ② DOM 真值：每个 step 面板都不含主代理文本，且首条 user 行是本 step 的提示词 ──
    const panels = page.locator('[data-step-chat]')
    await expect(panels).toHaveCount(2)
    for (let index = 0; index < 2; index += 1) {
      const panel = panels.nth(index)
      await expect(panel).toBeVisible({ timeout: 30_000 })
      for (const marker of HOST_TEXT_MARKERS) {
        await expect(
          panel,
          `step 面板 #${index} 里出现了主代理文本「${marker}」——说明父会话历史被 seed 进了 step 子代理`,
        ).not.toContainText(marker)
      }
      // 首条 user 行 = 本 step 自己的提示词（`PROMPT_MAIN_HEADER` 首行）。
      const firstUserRow = panel.locator('[data-variant="user"]').first()
      await expect(
        firstUserRow,
        `step 面板 #${index} 的首条 user 行不是本 step 的提示词`,
      ).toContainText('你正在执行工作流中的一个 Step')
    }

    expect(problems, `页面出现 console error / pageerror：${problems.join(' | ')}`).toEqual([])
  })
})
