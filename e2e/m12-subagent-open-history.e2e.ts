/**
 * M12 · 从 step 标题进入子代理会话页：**不该出现「历史加载失败」**（真机缺陷复现 + 回归）。
 *
 * 用户真机原话：
 * > 「从 step 标题那里点击进去子代理页面，有历史消息，但是最开头显示的是：
 * >  历史加载失败：subagent Sessions require their durable parent address（session/agent-busy）」
 *
 * 根因（DSH 源码为证）：`session-controller/src/history.ts:273-279` 对 `kind:'session'` 的普通地址
 * 访问 `origin === 'subagent'` 的会话直接抛 `session/agent-busy`；而会话实例用的地址来自
 * `session.ts:763`（`this.address` 为空即退化成普通地址）。我们的 step 标题入口原先走普通
 * `sessions.open(childId)`，宿主的 `manager.select()` 会把面板先前装配的 subagent 地址清成
 * undefined ⇒ 打开后**历史请求**退回普通地址 → 报错（首屏仍有历史，因为面板那侧已经加载过一版）。
 *
 * 修法：打开与 transport 装配收进同一个函数 `openStepChatSessionInHost`
 * （`packages/client/step-chat-source.ts`）——先按 durable 地址开，打开后**再装配同一个地址**。
 *
 * 本用例真机断言（三条都做实质判定）：
 * 1. 进入子代理会话页后，**最开头不出现** 「历史加载失败」/「durable parent address」/
 *    `session/agent-busy` 之类文案（判定面板/会话首段文本）；
 * 2. 首屏真实消息仍在（有 assistant/user 行，不是空壳）；
 * 3. 若出现「加载更早」，点它**不产生**错误行（成功加载更早历史）。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT, expect, mockDirective, test, type Page } from './fixtures/harness.ts'
import { createMockInstance } from './fixtures/mock-run.ts'

/** 进入 DSH 中心列里 commit 后的子代理会话页时会出现的错误文案（不许出现）。 */
const FORBIDDEN_TEXTS = ['历史加载失败', 'durable parent address', 'agent-busy', '加载失败'] as const

/** 收集 DSH 中心列里子代理会话页的首段文本与错误行锚点。 */
async function probeColumn(page: Page): Promise<{
  texts: readonly string[]
  forbidden: readonly string[]
  rows: number
  errorRows: number
  hasLoadOlder: boolean
  firstRows: readonly string[]
}> {
  return page.evaluate((forbiddenList) => {
    const column = document.querySelector('[data-pane="conversation"]')
      ?? document.querySelector('[class*="centerCol"]')
      ?? document.body
    const scoped = column as HTMLElement
    const body = (scoped.textContent ?? '').replace(/\s+/g, ' ')
    const forbidden = forbiddenList.filter(needle => body.includes(needle))
    const rows = [...scoped.querySelectorAll('[data-chat-flow-kind]')]
    return {
      texts: [body.slice(0, 400)],
      forbidden,
      rows: rows.length,
      errorRows: [...scoped.querySelectorAll('[class*="error"], [role="alert"]')]
        .filter(node => ((node.textContent ?? '').includes('失败') || (node.textContent ?? '').includes('busy')))
        .length,
      hasLoadOlder: [...scoped.querySelectorAll('button')].some(button => (button.textContent ?? '').includes('加载更早')),
      firstRows: rows.slice(0, 6).map(row => (row.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)),
    }
  }, [...FORBIDDEN_TEXTS])
}

test.describe('M12 进入子代理会话页不报历史加载失败', () => {
  test('step 标题 → 子代理会话页：无「历史加载失败」，首屏有真实消息，「加载更早」可用', async ({ page, workspace }) => {
    test.setTimeout(180_000)
    const instance = await createMockInstance(page, {
      // 长 hold：step 保持 running，标题可点、面板在；会话有真实消息（提示词 + 答复）。
      promptText: `子代理历史用例。${mockDirective({ text: 'm12-answer', hold: 90_000 })}`,
      cwd: workspace,
      label: 'e2e-m12-history',
    })
    const panel = page.locator('[data-step-chat]').first()
    await expect(panel).toBeVisible({ timeout: 60_000 })
    await expect(panel.getByText('m12-answer').first()).toBeVisible({ timeout: 60_000 })

    // 从 **step 标题** 进入子代理会话页（真机路径：`.authorLink` 的可访问名 = step.open）。
    const titleLink = page.locator('[data-tl-step] button[class*="authorLink"]').first()
    await expect(titleLink, 'step 标题应是可点击的会话入口').toBeVisible({ timeout: 30_000 })
    await titleLink.click()
    // 进入后：DSH 中心列渲染该子代理会话页（运行视图已关）。
    await expect(page.locator('[data-sandore-run-view]')).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(async () => (await probeColumn(page)).rows, {
      timeout: 60_000,
      message: '子代理会话页应渲染出会话行',
    }).toBeGreaterThan(0)
    // 等历史装配稳定（真机原缺陷就是打开后紧接着的历史请求失败）。
    await page.waitForTimeout(3_000)

    const probe = await probeColumn(page)
    const text = [
      '# M12 子代理会话页取证（从 step 标题进入）',
      `时间：${new Date().toISOString()}`,
      '',
      `- 会话行数：[data-chat-flow-kind] = ${String(probe.rows)}`,
      `- 错误行计数（class*="error"/role=alert 且含「失败」「busy」）= ${String(probe.errorRows)}`,
      `- 命中禁止文案：${JSON.stringify(probe.forbidden)}（必须为空数组）`,
      `- 是否有「加载更早」按钮：${String(probe.hasLoadOlder)}`,
      '',
      '## 首屏前几行文本',
      ...probe.firstRows.map((row, index) => `[${String(index)}] ${row}`),
      '',
      '## 会话页文本前缀',
      probe.texts[0] ?? '',
      '',
    ].join('\n')
    writeFileSync(join(REPO_ROOT, 'e2e', '.artifacts', 'm12-subagent-history.txt'), text, 'utf8')

    // ① 不许出现「历史加载失败 / durable parent address / agent-busy」。
    expect(probe.forbidden, `子代理会话页出现了禁止文案：\n${text}`).toEqual([])
    expect(probe.errorRows, `子代理会话页出现了错误行：\n${text}`).toBe(0)
    // ② 首屏有真实消息（不是空壳）。
    expect(probe.rows, `首屏应有真实消息行：\n${text}`).toBeGreaterThan(0)
    expect(probe.firstRows.join(' '), `首屏应含该 step 的会话内容：\n${text}`).toContain('m12-answer')
    // ③ 有「加载更早」时点一下：加载更早**不得**报错（真机缺陷的第二半）。
    if (probe.hasLoadOlder) {
      await page.locator('button', { hasText: '加载更早' }).first().click()
      await page.waitForTimeout(2_000)
      const after = await probeColumn(page)
      expect(after.forbidden, `点击「加载更早」后出现了禁止文案：\n${text}`).toEqual([])
      expect(
        (await page.locator('[data-sandore-run-view]').count()),
        '加载更早不应把运行视图弄回来',
      ).toBe(0)
    }
  })
})
