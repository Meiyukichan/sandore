/**
 * R1 · **真模型**（真实 API）金路径冒烟：prompt 步经真实 provider 跑通，
 * 且 **step 下方真的显示真实模型回复**。
 *
 * 与 M 层的差别（R 层存在的理由）：
 * - 不装 mock provider（harness 在 `SANDBORE_E2E_REAL=1` 时强制关闭 mock 行）；
 * - prompt 步**不写 L1 路由** → 继承临时 home `settings.yaml` 的 `agent-default-model`
 *   （真 provider / 真 model），凭据由 harness **只读复制**生产 `.credentials.yaml` 进临时 home；
 * - 断言依据是「模型真实生成的文本出现在 step 下方的会话区」，而不是 mock 的确定文本。
 *
 * ## 需求 3 的验收点（本用例的核心，`SANDBORE_E2E_REAL=1` 时才跑）
 * 实例 **completed 之后**：
 * - `[data-step-chat]` **仍在**（计数 ≥ 1）——历史行为是完成后卸载面板、把 step 下方
 *   换成一段收尾总结（「Agent 输出」）；需求 3 改为**不再替换**，收尾总结只作为传给
 *   后续 step 的输出内容留在引擎数据层；
 * - 面板内可见**会话消息**（user 行 + assistant 回复行/进程折叠行）；
 * - user 消息行是**折叠标题行**（含「用户消息」字样，需求 2）。
 *
 * ## 断言设计上的两个坑（都踩过，这里显式规避）
 * 1. **假通过**：若把期望输出写进提示词（如「请回复 REAL-OK」），`getByText('REAL-OK')`
 *    会匹配到**提示词本身**，于是「面板出现输出」永远为真 —— 等于没测。故期望串
 *    {@link EXPECTED} 刻意**不出现在提示词里**，并额外断言用户提示行**不含**它。
 * 2. **折叠态**：turn 闭合后 DSH 会把过程折叠为 `turn-process`（`hidden="until-found"` +
 *    可见「已完成」标签，即产品要求的「完成后折叠过程」），此元素按 Playwright 判定
 *    **不可见** —— 那是官方语义而非缺陷，故用 `toContainText`（只要求 attached）。
 *
 * 注：需求 2 的**左边界齐平**（user 折叠行 vs 思考行，boundingBox ±1px）由
 * `e2e/m1-embedded-render.e2e.ts` 承担——那里用 `think=` mock 指令**确定性**地造出
 * 一条真实思考行；真模型不保证产出 reasoning 块，故不在本用例里做依赖推理输出的排版断言。
 *
 * ## 入口归一后的前置（本批新增说明，**代码未改**）
 * 归一后工作流的**唯一启动入口**是宿主主代理调用 `sandore_workflow_run`：真模型会读到注入的
 * 协作上下文（`packages/workflow/host-context.ts` 的文案，含 `workflowId = "…"`）并自己发起
 * 这次工具调用——这正是生产路径，M 层的 mock「照办」分支只是它的替身（真模型模式下不生效，
 * 因为 mock provider 被强制关闭）。因此本用例若停在「实例长期 pending / 没有 `[data-step-chat]`」，
 * 排查方向是「主代理有没有真的调 run 工具」，而不是 step 子代理侧。
 *
 * 默认跳过；启用：
 * ```powershell
 * $env:SANDBORE_E2E_REAL='1'; npx playwright test e2e/r1-real-smoke.e2e.ts
 * ```
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { REAL_ENABLED, REAL_MODEL, REAL_PROVIDER, REPO_ROOT, expect, getInstanceState, test } from './fixtures/harness.ts'
import { createRealInstance } from './fixtures/mock-run.ts'

/**
 * 期望的模型输出：字母表前三字母连写。
 * **刻意不出现在提示词字面里**（提示词只说「前三个字母」），否则断言会把提示词当成输出。
 */
const EXPECTED = 'ABC'

test.describe('R1 真模型金路径（SANDBORE_E2E_REAL=1）', () => {
  test.skip(!REAL_ENABLED, 'R 层需要 SANDBORE_E2E_REAL=1（真 provider 凭据 + 真实 token 消耗）')

  test('prompt 步经真实 provider 跑通，step 下方显示真实模型回复', async ({ page, dsh, workspace, problems }) => {
    test.setTimeout(10 * 60_000)
    const instance = await createRealInstance(page, {
      promptText: '请把英文字母表的前三个字母按顺序连写在一起，只回复这三个字母本身，不要任何其他文字、空格或标点。',
      cwd: workspace,
      label: 'e2e-r1-real',
    })

    // ① 内嵌会话面板挂载（真实子代理 step 的 running 态才挂载）。
    const panel = page.locator('[data-step-chat]').first()
    await expect(
      panel,
      `未挂载 [data-step-chat]（真模型 ${REAL_PROVIDER}/${REAL_MODEL}）\n--- dsh log ---\n${dsh.logTail()}`,
    ).toBeVisible({ timeout: 180_000 })

    // ② 负向断言：step 下方**不得**落在「子代理会话加载失败」态。
    // 生产真实使用出现过 `subagent/unauthorized: subagent does not belong to the supplied
    // parent`（旧引擎把合成占位 childId 当真实子代理地址）——该错误是**面板内的错误态 UI**、
    // console 无痕，只断言「面板出现 + console 干净」会正好漏掉它。
    await expect(
      panel.locator('[data-step-chat-open-native]'),
      '面板落在加载失败态（step 下方显示「子代理会话加载失败」而非真实消息）',
    ).toHaveCount(0)
    await expect(panel.locator('[data-step-chat-error-detail]')).toHaveCount(0)
    await expect(panel.getByText('子代理会话加载失败')).toHaveCount(0)

    // ③ host 侧对账：实例真的 completed（= 该 turn 闭合、会话内容完整）。
    await expect
      .poll(async () => (await getInstanceState(page, instance.instanceId)).status, { timeout: 300_000 })
      .toBe('completed')
    const state = await getInstanceState(page, instance.instanceId)
    expect(state.executedSteps.map(step => step.stepId)).toEqual([instance.stepId])

    // ③b **完成后现场取证**（先落盘再断言：否则断言一失败就拿不到现场）。
    // 关注点：实例 completed 后 step 下方的会话区是否仍存在、显示了什么。
    const panelCountAfterDone = await page.locator('[data-step-chat]').count()
    const kindsAfterDone = await page.locator('[data-step-chat] [data-chat-flow-kind]').evaluateAll(
      nodes => nodes.map(node => node.getAttribute('data-chat-flow-kind')),
    )
    const runViewText = await page.locator('[data-sandore-run-view]').first().innerText().catch(() => '(无 run view)')
    const stepCardText = await page.locator('[data-sandore-run-view]').first()
      .locator('text=' + instance.stepId).first().innerText().catch(() => '(未找到 step 卡片)')
    writeFileSync(
      join(REPO_ROOT, 'e2e', '.artifacts', 'r1-panel.txt'),
      [
        `# 实例 completed 后的现场（真模型 ${REAL_PROVIDER}/${REAL_MODEL}）`,
        `## [data-step-chat] 计数（完成前曾为 1）: ${panelCountAfterDone}`,
        `## 面板内 data-chat-flow-kind 序列: ${JSON.stringify(kindsAfterDone)}`,
        `## step 卡片文本: ${stepCardText}`,
        `## run view 文本:`,
        runViewText,
      ].join('\n'),
      'utf8',
    )

    // ③c **需求 3 的验收点**：实例 completed 后 step 下方**仍是会话区**。
    // 历史行为：完成后面板卸载、step 下方只剩一段收尾总结（「Agent 输出」）——那正是本次
    // 要取消的替换；现在收尾总结只作为传给后续 step 的输出内容留在引擎数据层。
    await expect.poll(async () => page.locator('[data-step-chat]').count(), {
      timeout: 60_000,
      message: 'completed 后 step 下方应仍挂着会话面板（需求 3：不再用收尾总结替换会话区）',
    }).toBeGreaterThanOrEqual(1)

    // ④ 正向：step 下方有**用户提示行**，且面板（含被折叠的过程）里出现**模型输出**。
    await expect(panel.locator('[data-chat-flow-kind="user"]').first()).toBeVisible({ timeout: 60_000 })
    await expect(
      panel.locator('[data-chat-flow-kind="turn-process"], [data-chat-flow-kind="assistant-step"]').first(),
      'step 下方没有助手回复行（只有提示/上下文行）',
    ).toBeAttached({ timeout: 120_000 })
    await expect(panel).toContainText(new RegExp(EXPECTED, 'i'), { timeout: 120_000 })
    // 反向自证：用户提示行**不含**期望串 → 证明上面匹配到的是模型输出而非提示词。
    await expect(panel.locator('[data-chat-flow-kind="user"]').first())
      .not.toContainText(new RegExp(EXPECTED, 'i'))

    // ④b **需求 2**：user 消息行是折叠标题行（标题「用户消息」+ 单行摘要 + 可展开）。
    // 折叠态下完整消息不在可见文本里 —— 用 attached/属性语义断言，避免与官方折叠语义打架。
    const userFold = panel.locator('[data-variant="user"]').first()
    await expect(userFold, 'user 消息行应是折叠标题行（需求 2）').toBeAttached({ timeout: 30_000 })
    await expect(userFold).toContainText('用户消息')
    // 展开 → 完整提示词可见（点开看完整消息是需求 2 的一半）。
    await userFold.locator('[data-disclosure-row]').first().click()
    await expect(userFold).toHaveAttribute('data-expanded', 'true')
    await expect(userFold).toContainText('前三个字母')

    // ⑤ 现场取证：把 step 下方真实文本与行 kind 落盘（供人工/代理核对页面显示内容）。
    const kinds = await panel.locator('[data-chat-flow-kind]').evaluateAll(
      nodes => nodes.map(node => node.getAttribute('data-chat-flow-kind')),
    )
    writeFileSync(
      join(REPO_ROOT, 'e2e', '.artifacts', 'r1-panel.txt'),
      [
        `# step 下方面板现场（真模型 ${REAL_PROVIDER}/${REAL_MODEL}）`,
        `## data-chat-flow-kind 序列: ${JSON.stringify(kinds)}`,
        `## 面板 innerText:`,
        await panel.innerText(),
      ].join('\n'),
      'utf8',
    )

    // ⑥ render 崩溃护栏：真机渲染期间不得出现任何 console error / pageerror。
    expect(problems, `页面出现 console error / pageerror：${problems.join(' | ')}`).toEqual([])
  })
})
