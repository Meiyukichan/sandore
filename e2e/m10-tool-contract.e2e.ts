/**
 * M10 · 工具面契约（P1–P5）在**真机**上的断言（mock LLM 驱动，3090 隔离实例）。
 *
 * ## 为什么需要这一层
 * P1–P5 的修复点都在「模型调用 `sandore_workflow*` 时看到的**返回信封**」上，而单测
 * （`packages/workflow/host-tools.spec.ts` / `workflow-engine.spec.ts`）用的是 fake host，
 * 只能证明工具函数的行为。本用例把**同一条链路**搬到真机：
 * 往实例宿主会话的主代理输入框投一条自带 `[[e2e-mock once=1 tool=… toolargs=…]]` 指令的
 * 消息（语法见 `e2e/mock-llm/index.js` 与 `mockDirective`），于是**真实主代理的那一次
 * 模型调用**会产出对应的 tool-call，再由真实 DSH 工具注册表执行真实工具对象。
 *
 * ## 断言面（为什么这样断言才不是恒真）
 * 1. **工具行**：主代理会话面板 `[data-main-agent-chat]` 里按 `[data-tool="<工具名>"]`
 *    定位那一行（ToolRow 的 `data-tool`/`data-state`），展开后读它的输出文本 —— 即
 *    **工具返回的信封 JSON**。断言的是信封内容（错误码/文案/字段名），不是页面文案。
 * 2. **状态面**：`getInstanceState` RPC 的 `executedSteps`（段模型真相）+ `userMessages`
 *    （投递是否落盘）；`listInstances` 的条数（拒绝是否真的没有副作用）。
 * 3. **SSE 面**：`sandore/step-message` 帧数（投递是否真的发生）。
 *
 * 逐条覆盖：
 * - **P4**：`run` 带旧参数 `hostSessionId` → 必须报错且列出可用参数；实例数不变（没有启动）。
 * - **P1**：`control continue` 指向一个**已完成**的 step → `ok:false` + `STEP_CONTROL_FAILED`
 *   （旧行为是 `ok:true`，模型会误报「已恢复」）。
 * - **P3**：running 的 step 可收消息（不误伤正常路径）；实例暂停后同一 step **被拒**且错误
 *   含当前状态 + 建议动作，同时**没有**新的 `kind:'message'` 落盘 / `sandore/step-message` 帧；
 *   向已完成的 step 发消息同样被拒（说明「已完成」而不是静默投递）。
 * - **P5**：`status detail=steps` 的返回里是 `segmentCount` + `distinctStepCount`（按执行段计数）。
 * - **P2**：pause → resume → `continue`（不带 scope）**不会**出现「选中了它又报
 *   running 既非 paused 也非 failed」的自相矛盾（两种引擎现状下都自洽）。
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT, expect, getInstanceState, mockDirective, sandoreRpc, test, type Page } from './fixtures/harness.ts'
import { createMockInstance, createMockTwoStepInstance } from './fixtures/mock-run.ts'
import { countOfType, framesOf, readSseFrames } from './fixtures/sse.ts'

/**
 * 真机信封取证落盘（对齐 M8 的 `e2e/.artifacts/host-wakeups.txt` 习惯）：
 * 每条被断言的返回信封原文写进 `e2e/.artifacts/m10-envelopes.txt`，供报告直接引用
 * （断言失败时也能一眼看到工具到底回了什么）。每次运行覆盖。
 */
const ENVELOPE_DUMP = join(REPO_ROOT, 'e2e', '.artifacts', 'm10-envelopes.txt')
writeFileSync(ENVELOPE_DUMP, '# M10 真机工具信封取证（每次运行覆盖）\n', 'utf8')

function dumpEnvelope(label: string, tool: string, args: unknown, text: string): void {
  appendFileSync(ENVELOPE_DUMP, `\n### ${label}\ntool=${tool}\nargs=${JSON.stringify(args)}\nreturn=${text}\n`, 'utf8')
}

/** 主代理输入壳（运行页底部：实例宿主会话的输入面）。 */
function discussion(page: Page) {
  return page.locator('[data-sandore-disc-input]').first()
}

/**
 * 往宿主主代理会话投一条「一次性工具调用」消息，并等该工具行出现。
 *
 * `once=1`（而不是 `tools=K`）的语义是「指令文本出现即照办一次」——这条消息是该会话
 * 第几次模型调用不可预知（照办 run、工具结果回灌、终态通知都占号），见 m4 的注释。
 *
 * @param page - 已就绪页面。
 * @param options.tool - 工具名。
 * @param options.args - tool-call 的 JSON 参数（原样投给工具，故可故意带未知键）。
 * @returns 该工具**最新**一行的 locator（同会话里可能已有历史的同名行，例如 `run`）。
 */
async function driveToolCall(page: Page, options: { tool: string; args: Record<string, unknown> }) {
  const rows = page.locator(`[data-main-agent-chat] [data-tool="${options.tool}"]`)
  const before = await rows.count()
  const surface = discussion(page).locator('[data-main-agent-input]').first()
  await expect(surface).toBeEnabled({ timeout: 30_000 })
  // 文本里内嵌指令；**必须单行**（主代理输入框 Enter 即发送）。
  await surface.fill(`请照办这次工具调用：${mockDirective({
    once: 1,
    tool: options.tool,
    toolargs: JSON.stringify(options.args),
  })}`)
  const send = discussion(page).locator('[data-main-agent-send]').first()
  await expect(send).toBeEnabled({ timeout: 30_000 })
  await send.click()
  await expect.poll(() => rows.count(), {
    timeout: 60_000,
    message: `主代理应产出 ${options.tool} 的工具行`,
  }).toBeGreaterThan(before)
  return rows.last()
}

/**
 * 展开工具行并读它的**完整文本**（IN 参数 + OUT 输出）。
 *
 * 三个必须踩准的实现细节（全部由 `m10-debug` 的 DOM dump 实证，不是猜的）：
 * 1. `onClick` 挂在 `[data-disclosure-row]`（DisclosureRow 的行本身）上，点击**外层**
 *    `[data-tool]` 包装 div 不会冒泡到子节点；
 * 2. 该行**必须用 `dispatchEvent('click')` 而不是 `click()`**：主代理面板在实例运行期
 *    持续重渲染，Playwright 的 actionability 检查（visible/enabled/**stable**）永远等不到
 *    稳定点，`.click()` 直接超时（实测 `TimeoutError: waiting for element to be visible,
 *    enabled and stable`）——而派发 DOM click 一次即生效（`aria-expanded` 转 true、
 *    正文渲染出 IN/OUT）；
 * 3. `DisclosureRow` 只在 `open` 时渲染 children（`{open && children}`，DSH
 *    `ui-primitives/DisclosureRow.tsx` 第 101 行），行展开态是**行本地 `useState`**，
 *    面板重挂会把它复位 → 循环「读 → 未见信封就再派发一次」直到 OUT 段出现
 *    （我们的信封 JSON 里恒有 `"ok"`）。
 *
 * 读 `textContent` 而不是 `innerText`：折叠摘要与展开正文在同一子树里，`textContent`
 * 不受 display 影响，断言更稳。
 */
async function envelopeTextOf(row: ReturnType<Page['locator']>): Promise<string> {
  const read = async (): Promise<string> => row.evaluate(
    element => (element.textContent ?? '').replace(/\s+/g, ' '),
  ).catch(() => '');
  const toggle = row.locator('[data-disclosure-row]').first();
  let text = await read();
  await expect.poll(async () => {
    text = await read();
    if (text.includes('"ok"')) return text;
    if (await toggle.count() > 0) await toggle.dispatchEvent('click').catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 150));
    text = await read();
    return text;
  }, { timeout: 30_000, message: '展开工具行后应能读到返回信封（OUT 段的 JSON）' }).toContain('"ok"');
  return text;
}

test.describe('M10 工具面契约（P1–P5 真机断言）', () => {
  test('P4：run 的旧参数/未知键必须报错并列出可用参数（且不启动实例）', async ({ page, workspace }) => {
    test.setTimeout(180_000)
    const instance = await createMockInstance(page, {
      promptText: `P4 用例。${mockDirective({ text: 'm10-p4-answer', hold: 60_000 })}`,
      cwd: workspace,
      label: 'e2e-m10-p4',
    })
    await expect(page.locator('[data-step-chat]').first()).toBeVisible({ timeout: 60_000 })
    const instancesBefore = (await sandoreRpc<unknown[]>(page, 'listInstances', {})).length

    // 旧版本参数 `hostSessionId`（架构决策 1 已删除该入参）：必须**报错**而不是静默忽略后照常启动。
    const row = await driveToolCall(page, {
      tool: 'sandore_workflow_run',
      args: { workflowId: 'wfl-any', originalInput: 'p4-probe', hostSessionId: instance.instanceId },
    })
    const text = await envelopeTextOf(row)
    dumpEnvelope('P4 run 未知键 hostSessionId', 'sandore_workflow_run', { workflowId: 'wfl-any', originalInput: 'p4-probe', hostSessionId: instance.instanceId }, text)
    expect(text, '应点名未知参数').toContain('hostSessionId')
    expect(text, '错误应说明未知参数不被忽略').toContain('未知参数')
    expect(text, '错误应列出可用参数供自纠').toContain('可用参数')
    expect(text).toContain('workflowId')
    expect(text).toContain('originalInput')
    expect(text, 'unknown-key 必须是 INVALID_OPERATION').toContain('INVALID_OPERATION')

    // 拒绝发生在任何副作用之前：没有新实例被启动。
    const instancesAfter = (await sandoreRpc<unknown[]>(page, 'listInstances', {})).length
    expect(instancesAfter, '被拒的 run 不应启动任何实例').toBe(instancesBefore)
  })

  test('P1/P3/P5：已完成 step 的 continue 全失败、暂停 step 不可收消息、steps 计数按执行段', async ({ page, workspace }) => {
    test.setTimeout(240_000)
    // 两步实例：step-first 短 hold 很快 completed；step-second 长 hold 保持 running。
    const instance = await createMockTwoStepInstance(page, {
      firstPromptText: `P1/P3/P5 第一步。${mockDirective({ text: 'm10-first-answer' })}`,
      secondPromptText: `P1/P3/P5 第二步。${mockDirective({ text: 'm10-second-answer', hold: 90_000 })}`,
      cwd: workspace,
      label: 'e2e-m10-contract',
    })
    const [firstStep, secondStep] = instance.stepIds
    await expect(page.locator('[data-step-chat]').first()).toBeVisible({ timeout: 60_000 })

    // 等第一步真的 completed、第二步真的 running（段模型真相，不猜）。
    await expect.poll(async () => (await getInstanceState(page, instance.instanceId)).executedSteps
      .find(step => step.stepId === firstStep)?.status, { timeout: 60_000 }).toBe('completed')

    // ── P3（正常路径不误伤）：running 的 step 可以收消息 ──────────────────────────
    const okRow = await driveToolCall(page, {
      tool: 'sandore_workflow_send_message',
      args: { targets: [secondStep], message: 'm10-steer-1' },
    })
    const okText = await envelopeTextOf(okRow)
    dumpEnvelope('P3 running step 可投递', 'sandore_workflow_send_message', { targets: [secondStep], message: 'm10-steer-1' }, okText)
    expect(okText, 'running 的 step 应投递成功').toContain('"ok": true')
    expect(okText, '投递面应列出生效目标').toContain('"delivered"')
    expect(okText).toContain(secondStep)
    expect(okText).not.toContain('STEP_DELIVERY_FAILED')

    // ── P3（已完成 step）：拒绝且说明「已完成」──────────────────────────────────
    const doneRow = await driveToolCall(page, {
      tool: 'sandore_workflow_send_message',
      args: { targets: [firstStep], message: 'm10-steer-done' },
    })
    const doneText = await envelopeTextOf(doneRow)
    dumpEnvelope('P3 completed step 被拒', 'sandore_workflow_send_message', { targets: [firstStep], message: 'm10-steer-done' }, doneText)
    expect(doneText, '已完成的 step 应被拒').toContain('STEP_DELIVERY_FAILED')
    expect(doneText).toContain("status 'completed'")
    expect(doneText, '错误应给建议动作').toContain('无需再发消息')

    // ── P1：continue 指向已完成的 step → 全部目标失败 → ok:false + STEP_CONTROL_FAILED ──
    const failedRow = await driveToolCall(page, {
      tool: 'sandore_workflow_control',
      args: { action: 'continue', scope: firstStep },
    })
    const failedText = await envelopeTextOf(failedRow)
    dumpEnvelope('P1 continue 全失败', 'sandore_workflow_control', { action: 'continue', scope: firstStep }, failedText)
    expect(failedText, '全失败必须是 ok:false').toContain('"ok": false')
    expect(failedText, '全失败应有明确错误码').toContain('STEP_CONTROL_FAILED')
    expect(failedText, 'per-step 细节仍保留').toContain('neither paused nor failed')
    expect(failedText).toContain(firstStep)

    // ── P3（暂停后）：同一 running step 被拒 + 无投递落盘 + 无 SSE 帧 ─────────────
    const markFrames = framesOf(await readSseFrames(page), instance.instanceId)
    const messagesBefore = (await getInstanceState(page, instance.instanceId)).raw.userMessages as
      | readonly { kind?: string }[]
      | undefined
    const kindMessagesBefore = (messagesBefore ?? []).filter(entry => entry.kind === 'message').length

    await sandoreRpc(page, 'pauseAll', { input: { instanceId: instance.instanceId } })
    await expect.poll(async () => (await getInstanceState(page, instance.instanceId)).status, { timeout: 30_000 })
      .toBe('paused')

    const pausedRow = await driveToolCall(page, {
      tool: 'sandore_workflow_send_message',
      args: { targets: [secondStep], message: 'm10-steer-paused' },
    })
    const pausedText = await envelopeTextOf(pausedRow)
    dumpEnvelope('P3 paused step 被拒', 'sandore_workflow_send_message', { targets: [secondStep], message: 'm10-steer-paused' }, pausedText)
    expect(pausedText, '暂停的 step 必须被拒（旧行为是 ok:true 静默投递）').toContain('STEP_DELIVERY_FAILED')
    expect(pausedText).toContain("status 'paused'")
    expect(pausedText, '错误必须给出可自纠的下一步动作').toContain('sandore_workflow_control')
    expect(pausedText, '被拒的文案必须带恢复动作').toContain('continue')

    // 没有新的投递落盘（kind:'message' 计数不变）—— 拒绝是真的拒绝，不是「报错但也投了」。
    const after = await getInstanceState(page, instance.instanceId)
    const kindMessagesAfter = ((after.raw.userMessages ?? []) as readonly { kind?: string }[])
      .filter(entry => entry.kind === 'message').length
    expect(kindMessagesAfter, '被拒的投递不应落 userMessages').toBe(kindMessagesBefore)
    // 也没有新的 sandore/step-message 帧。
    const nowFrames = framesOf(await readSseFrames(page), instance.instanceId)
    expect(countOfType(nowFrames, 'sandore/step-message')).toBe(countOfType(markFrames, 'sandore/step-message'))

    // ── P5：steps 计数是「执行段数」+「去重 step 数」──────────────────────────────
    const stepsRow = await driveToolCall(page, {
      tool: 'sandore_workflow_status',
      args: { detail: 'steps' },
    })
    const stepsText = await envelopeTextOf(stepsRow)
    dumpEnvelope('P5 status steps 计数', 'sandore_workflow_status', { detail: 'steps' }, stepsText)
    expect(stepsText, '旧字段 stepCount 已改名，避免被读成「步骤数」').toContain('segmentCount')
    expect(stepsText).toContain('distinctStepCount')
    expect(stepsText).not.toContain('"stepCount"')
  })

  test('P2：pause → resume 之后 continue（不带 scope）自洽，不出现「选中它又报 running」', async ({ page, workspace }) => {
    test.setTimeout(180_000)
    const instance = await createMockInstance(page, {
      promptText: `P2 用例。${mockDirective({ text: 'm10-p2-answer', hold: 90_000 })}`,
      cwd: workspace,
      label: 'e2e-m10-p2',
    })
    await expect(page.locator('[data-step-chat]').first()).toBeVisible({ timeout: 60_000 })

    // 造出「同一步骤多个执行段」的现实形态：暂停一次 → 恢复一次。
    await sandoreRpc(page, 'pauseAll', { input: { instanceId: instance.instanceId } })
    await expect.poll(async () => (await getInstanceState(page, instance.instanceId)).status, { timeout: 30_000 })
      .toBe('paused')
    await sandoreRpc(page, 'resumeAll', { input: { instanceId: instance.instanceId, resumePrompt: '继续' } })
    // 等恢复手势被引擎受理（step-resumed 帧出现）——此时段模型里已经不止一段。
    await expect.poll(async () => countOfType(
      framesOf(await readSseFrames(page), instance.instanceId), 'sandore/step-resumed',
    ), { timeout: 30_000 }).toBeGreaterThan(0)

    // 不带 scope 的 continue：无论引擎把「最新段」落在 paused 还是 running，都必须**自洽**：
    // - 最新段 paused/failed → ok:true 且 resumed/retried 里有这个 step；
    // - 最新段不是 paused/failed → 目标集为空 → ok:false + 「nothing to continue」。
    // 旧实现会返回 ok:true 但 data.failures 里写「选中了它又报 running 既非 paused 也非 failed」。
    const row = await driveToolCall(page, {
      tool: 'sandore_workflow_control',
      args: { action: 'continue' },
    })
    const text = await envelopeTextOf(row)
    dumpEnvelope('P2 continue 自洽（多段实例）', 'sandore_workflow_control', { action: 'continue' }, text)
    expect(text, '不再出现自相矛盾的失败行').not.toContain('neither paused nor failed')
    expect(text, '不再出现把不存在/不可继续混为一谈的 unknown').not.toContain("status 'unknown'")
    const consistent = text.includes('"ok": true') || text.includes('nothing to continue')
    expect(
      consistent,
      `continue 的返回必须自洽（ok:true 且实际恢复了目标，或 ok:false + nothing to continue）：${text.slice(0, 600)}`,
    ).toBe(true)
  })
})
