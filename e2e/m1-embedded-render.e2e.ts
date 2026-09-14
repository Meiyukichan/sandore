/**
 * M1 · 内嵌会话渲染 + 完整消息（**不受旧「最新 10 条」限制**）。
 *
 * 构造：mock 让同一子代理会话做 `TOOL_ROUNDS` 轮 tool-call（每轮写一个文件）后再返回最终
 * 文本 —— 于是会话至少有 `1 + 2×K + 1` 条消息（用户 + K×(assistant tool-call + tool-result)
 * + 最终 assistant），**超过旧的 10 条上限**。
 *
 * 对账（不靠魔数，而是三条独立真值互相印证）：
 * 1. **宿主真值**：DSH 进程 stderr 的 `[e2e-mock] call#…` 行数 = K+1（K 轮 tool + 1 轮文本）
 *    —— 证明会话真的发生了这么多轮模型调用；
 * 2. **文件真值**：工作目录里出现 K 个由工具真实写出的文件 —— 证明 tool-call 行对应真实消息；
 * 3. **DOM 真值**：面板渲染出 K 条 `[data-chat-flow-kind="tool-call"]` 与 ≥ 2K+2 条行 ——
 *    证明面板把整段会话（>10 条消息）全量渲染，而不是只留最近 10 条。
 *
 * 说明：DSH 会话加载窗约一页 50 条消息，本用例构造的会话（约 14 条）**不会**触发
 * `hasMore`，因此「加载更早 / 自动补齐」在这里应当不存在 —— 一并断言「无分页提示」，
 * 这样若有意外截断（例如旧 10 条上限回归）也会立刻暴露。
 *
 * ## 需求 2 的真机证据（左边界对齐）
 * mock 指令 `think=…` 让最终文本轮先产出一个 reasoning 块 → 面板里出现**真实的
 * 「思考」折叠行**；此时用 `boundingBox()` 比较 user 折叠行与思考行的左边界 x
 * （±1px 容差）——这是「用户消息行与思考行齐平、都在左侧」的**真实排版**证据
 * （jsdom 只能证明 class 同源，见 step-view/user-message-row.spec.ts）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { expect, mockDirective, test } from './fixtures/harness.ts'
import { createMockInstance } from './fixtures/mock-run.ts'

/** tool 轮数（每轮 = 1 条 assistant(tool-call) + 1 条 tool-result）。 */
const TOOL_ROUNDS = 6

/** 思考行文本（`think=` 指令；无空格——mock 指令值按空白分词）。 */
const THINK_TEXT = 'm1-think-first-line'

test.describe('M1 内嵌会话渲染与完整消息', () => {
  test('prompt 步的内嵌面板全量渲染多轮工具会话（>10 条消息，含分页守卫）', async ({ page, dsh, workspace }) => {
    test.setTimeout(90_000)
    const mark = dsh.logMark()
    // 工具用**绝对路径**（脱离子代理 cwd 的不确定性）：路径由本用例注入 mock 指令。
    const target = (round: number): string => join(workspace, `m1-round-${round}.txt`).replace(/\\/g, '/')
    await createMockInstance(page, {
      promptText: `请连续执行 ${TOOL_ROUNDS} 轮文件写入，然后总结。${mockDirective({
        text: 'final-m1-answer',
        tools: TOOL_ROUNDS,
        tool: 'write',
        toolargs: `{"file_path":"${target(1).replace('1.txt', '{n}.txt')}","content":"round-{n}"}`,
        // 需求 2 的证据来源：最终文本轮先产出一个 reasoning 块 → 面板出现真实「思考」行。
        think: THINK_TEXT,
        // 最终文本可见后仍保持 running，让所有 DOM 断言都在面板挂载期内完成。
        hold: 20_000,
      })}`,
      cwd: workspace,
      label: 'e2e-m1-render',
    })

    const panel = page.locator('[data-step-chat]').first()
    await expect(panel).toBeVisible({ timeout: 60_000 })
    // 最终答复出现 = K 轮工具全部跑完（每轮都要一次模型调用）。
    // 注意**必须限定 assistant-step 行**：Step 提示词里内嵌了同一段 mock 指令文本，
    // 直接 getByText 会被 user 行（提示词）命中，从而在工具轮还没跑完时就假阳。
    const answer = panel.locator('[data-chat-flow-kind="assistant-step"]').filter({ hasText: 'final-m1-answer' })
    await expect(answer.first()).toBeVisible({ timeout: 60_000 })

    const flow = panel.locator('[data-chat-flow]').first()
    await expect(flow).toBeVisible()

    // ① 宿主真值：本**子代理会话**恰好 K+1 次模型调用。
    //    计数按该 step 的 mock 指令文本（`text="final-m1-answer"`）——入口归一后宿主主代理
    //    自己也会产生调用（注入 → 照办 run → 工具结果），全局 `call#` 计数不再等于本 step 的次数。
    const calls = dsh.countSince(mark, /text="final-m1-answer"/g)
    expect(calls, `本 step 的模型调用次数应 = tool 轮数 + 1（实际日志：\n${dsh.logTail().slice(-1500)}）`).toBe(TOOL_ROUNDS + 1)

    // ② 文件真值：工具调用真的落盘（证明 tool-call 行不是纯装饰）。
    const written = Array.from({ length: TOOL_ROUNDS }, (_, index) => join(workspace, `m1-round-${index + 1}.txt`))
    const missing = written.filter(path => !existsSync(path))
    expect(missing, `工具应写出全部 ${TOOL_ROUNDS} 个文件，缺失：${missing.join(', ')}`).toEqual([])

    // ③ DOM 真值：整段会话全量渲染（旧实现只留最新 10 条）。
    const rows = panel.locator('[data-chat-anchor-key]')
    const toolCallRows = panel.locator('[data-chat-flow-kind="tool-call"]')
    await expect(toolCallRows).toHaveCount(TOOL_ROUNDS)
    const rowCount = await rows.count()
    expect(rowCount, `面板应渲染 ≥ ${2 * TOOL_ROUNDS + 2} 行（实际 ${rowCount}）`).toBeGreaterThanOrEqual(2 * TOOL_ROUNDS + 2)

    // 会话首条（Step 提示词）与末条（最终答复）都在 DOM 里 —— 真正的「全量」而非尾部窗口。
    // 需求 2 起 user 行是**折叠标题行**：折叠态只显示 `用户消息 · <首行摘要>`，完整消息在
    // 展开体里（所以「首条在」= 首行摘要可见 + 后续行不泄漏；展开后再断言完整提示词）。
    const userFold = panel.locator('[data-variant="user"]').first()
    await expect(userFold).toBeAttached()
    await expect(userFold).toContainText('用户消息')
    // 首行摘要 = 该 user 消息的首行（引擎包装文案的第一行；任务文本在后续行）。
    await expect(userFold).toContainText('你正在执行工作流中的一个 Step')
    await expect(
      userFold,
      '折叠态不应泄漏完整消息（需求 2：超出一行省略，点开才看全文）',
    ).not.toContainText('请连续执行 6 轮文件写入')
    await expect(panel.locator('[data-chat-flow-kind="assistant-step"]').last().getByText('final-m1-answer').first())
      .toBeVisible()

    // ④ 分页守卫：本会话远小于一页会话消息 → 不应出现「正在加载更早的消息…」/「加载更早」。
    await expect(panel.locator('[data-step-chat-autofill]')).toHaveCount(0)
    await expect(panel.locator('.stepChatOlder')).toHaveCount(0)

    // ⑤ 需求 2：user 消息行是与「思考」行**同源同左**的折叠行。
    // 思考行由 `think=` 指令产出（真实 reasoning 块 → ReasoningRow），真实存在且带同一套
    // 折叠行锚点（data-variant / data-disclosure-row / aria-expanded）。
    const thinkFold = panel.locator('[data-variant="think"]').first()
    await expect(thinkFold, '真实 reasoning 行未渲染（think 指令未生效？）').toBeAttached({ timeout: 60_000 })
    await expect(thinkFold).toContainText('思考')
    await expect(thinkFold).toContainText(THINK_TEXT)

    // ★ 左边界对齐（**真实排版证据**）：user 折叠行与思考行的左边界 x 相等（±1px）。
    // 本用例处于 running（turn 未闭合）故两条行都不折叠、都有真实盒子（折叠态元素带
    // hidden="until-found" 时 Playwright 视为不可见，这里不依赖可见性判断，直接量几何）。
    const [userBox, thinkBox] = await Promise.all([
      userFold.boundingBox(),
      thinkFold.boundingBox(),
    ])
    expect(userBox, 'user 折叠行应有真实盒子').not.toBeNull()
    expect(thinkBox, '思考行应有真实盒子').not.toBeNull()
    expect(
      Math.abs((userBox?.x ?? 0) - (thinkBox?.x ?? 0)),
      `user 折叠行左边界 ${String(userBox?.x)} 应与思考行 ${String(thinkBox?.x)} 齐平（±1px）`,
    ).toBeLessThanOrEqual(1)
    // 两条行同宽（同一列内容盒）——宽度不同说明容器结构不同（左对齐的另一面证据）。
    expect(
      Math.abs((userBox?.width ?? 0) - (thinkBox?.width ?? 0)),
      `user 折叠行宽 ${String(userBox?.width)} 应与思考行 ${String(thinkBox?.width)} 一致（同一列内容盒）`,
    ).toBeLessThanOrEqual(1)
    // 反向对照（不是恒真）：user 折叠行必须**从消息列左缘开始**、且横跨整列——
    // 旧气泡是右对齐的窄泡泡（左缘远在列右侧），这里左缘相等 + 同宽即排除回归。
    const columnBox = await panel.locator('[data-chat-flow]').first().boundingBox()
    expect(columnBox, '消息列应有真实盒子').not.toBeNull()
    expect(
      Math.abs((userBox?.x ?? 0) - (columnBox?.x ?? 0)),
      `user 折叠行左缘 ${String(userBox?.x)} 应等于消息列左缘 ${String(columnBox?.x)}`,
    ).toBeLessThanOrEqual(1)
    expect(
      Math.abs((userBox?.width ?? 0) - (columnBox?.width ?? 0)),
      `user 折叠行宽 ${String(userBox?.width)} 应等于列宽 ${String(columnBox?.width)}（整行左对齐，而非右侧窄气泡）`,
    ).toBeLessThanOrEqual(1)

    // ⑥ 需求 2 的交互：点开折叠行 → 完整消息（首行之后的正文）可见；再点收起。
    await userFold.locator('[data-disclosure-row]').first().click()
    await expect(userFold).toHaveAttribute('data-expanded', 'true')
    await expect(userFold).toContainText('请连续执行 6 轮文件写入')
    await expect(panel.locator('[data-variant="user"][data-expanded]')).toHaveCount(1)
    await userFold.locator('[data-disclosure-row]').first().click()
    await expect(userFold).not.toHaveAttribute('data-expanded', 'true')
  })
})
