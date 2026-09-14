/**
 * M3 · **呈现层统一后**：step 面板内没有输入框（能力边界），运行页输入框是**独立输入框**。
 *
 * 被测面有三层，本用例三层都断言（缺一不可）：
 * 1. **面板内**（`[data-step-chat]`）：面板不再有输入壳/输入面/发送钮/排队提示/触发菜单锚点
 *    ——`[data-step-chat-composer-seat]` 等计数必须为 0。**不是恒真断言**：同一页面里
 *    运行页底部真的有一个可输入的输入框（下一条），所以「找不到输入框」只对面板成立；
 * 2. **运行页**（`[data-sandore-disc-input]`）：底部输入框是**独立实现**
 *    （`main-agent-input.tsx`，视觉/宽度**逐值照抄** DSH 默认会话输入框）——原生 `textarea` +
 *    同款圆角卡/发送钮/占位层 + 同款动作行（左：权限下拉；右：暂停/中止 → 模型下拉 → 发送），
 *    **不挂 DSH 输入内核**（无 `[data-composer-input]` / `[data-composer-kernel]` /
 *    `[data-composer-took-root]`，也没有 contenteditable）⇒ 与 DSH 中心列的输入框彻底隔离；
 *    空草稿时发送钮禁用、暂停/中止按钮常驻（暂停按钮的双语义见 M5 / M7③）；
 *    **唯一不抄**：左下角 `+` 附件按钮（用户明确要求）；输入框上方那行「主代理 / 消息发给
 *    主代理（不是发给某个 Step）」标签也**已删除**；
 * 3. **需求 2**：运行页**不再有** `@step` 结构化引用入口（`[data-sandore-step-picker]`）。
 *
 * 历史沿革：本用例原本测「面板 composer 的 Enter/Shift+Enter」→ 需求 1 后改成「面板没有
 * 输入框」→ 呈现层统一后运行页输入框先换成「主代理输入壳（共享 DSH 内核 + 接管编辑器根）」，
 * 又被用户否决（观感/行为都"诡异"）→ 改为**独立输入框** → 真机反馈「完全不一样」后再要求
 * **逐值照抄 DSH**（宽度轴/容器/按钮/下拉）。故第 2 层的断言从「DSH 内核标记」改成
 * 「独立输入框结构 + 无内核标记 + DSH 同款席位」；发送语义/草稿独立性由 M7① 与 M7④ 承担。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT, expect, mockDirective, test } from './fixtures/harness.ts'
import { createMockInstance } from './fixtures/mock-run.ts'

/**
 * 输入框取证：把关键 computed style + class 清单 dump 到
 * `e2e/.artifacts/m3-main-agent-input-dom.txt`，便于逐值与 DSH `InputBar.module.css` 核对。
 */
async function dumpInputForensics(seat: import('@playwright/test').Locator): Promise<string> {
  const data = await seat.evaluate((node) => {
    const pick = (el: Element | null, keys: readonly string[]): Record<string, string> => {
      if (el === null) return {}
      const style = getComputedStyle(el)
      const out: Record<string, string> = {}
      for (const key of keys) out[key] = style.getPropertyValue(key)
      return out
    }
    const root = node as HTMLElement
    const card = root.querySelector('[data-main-agent-input-card]')
    const area = root.querySelector('[data-main-agent-input]')
    const send = root.querySelector('[data-main-agent-send]')
    const placeholder = root.querySelector('[data-main-agent-input-scroll] + *')
    void placeholder
    const row = card === null ? null : card.lastElementChild
    return {
      rootClass: root.className,
      rootStyle: pick(root, ['display', 'flex-direction', 'align-items', 'padding-left', 'padding-bottom', 'width']),
      vars: {
        msgContentWidth: getComputedStyle(root).getPropertyValue('--sandore-msg-content-width').trim(),
        cardWidthResolved: pick(card, ['width'])['width'] ?? '',
      },
      axis: (() => {
        const column = document.querySelector('[data-sandore-run-view] [class*="column"]') as HTMLElement | null
        if (column === null) return null
        const columnRect = column.getBoundingClientRect()
        const cardRect = card?.getBoundingClientRect()
        const style = getComputedStyle(column)
        const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
        return {
          columnContentWidth: Math.round(column.clientWidth - padding),
          columnCenterX: Math.round(columnRect.left + columnRect.width / 2),
          cardWidth: Math.round(cardRect?.width ?? 0),
          cardCenterX: Math.round((cardRect?.left ?? 0) + (cardRect?.width ?? 0) / 2),
        }
      })(),
      cardClass: card?.className ?? null,
      card: pick(card, ['width', 'max-width', 'border-radius', 'background-color', 'box-shadow', 'padding-top', 'gap', 'font-size', 'line-height']),
      rowClass: row?.className ?? null,
      row: pick(row, ['display', 'justify-content', 'gap', 'padding', 'container-type']),
      areaClass: area?.className ?? null,
      area: pick(area, ['padding', 'font-family', 'font-size', 'line-height', 'color', 'caret-color', 'background-color', 'resize']),
      sendClass: send?.className ?? null,
      send: pick(send, ['width', 'height', 'border-radius', 'background-color', 'color', 'transform', 'opacity']),
      seats: {
        accessTrigger: root.querySelector('[data-main-agent-access] button')?.textContent ?? null,
        modelTrigger: root.querySelector('[data-main-agent-model-trigger] button')?.textContent ?? null,
        hasPlusButton: root.querySelector('[aria-haspopup="listbox"]') !== null,
        labelRow: root.querySelector('[data-sandore-main-input-label]') !== null,
      },
    }
  })
  const text = [
    '# M3 运行页主代理输入框 DOM/样式取证',
    `时间：${new Date().toISOString()}`,
    '',
    '## 与 DSH InputBar.module.css 逐值对照（本文件的每一行都是浏览器里真实解析出的 computed style）',
    '```json',
    JSON.stringify(data, null, 2),
    '```',
    '',
  ].join('\n')
  writeFileSync(join(REPO_ROOT, 'e2e', '.artifacts', 'm3-main-agent-input-dom.txt'), text, 'utf8')
  return text
}

test.describe('M3 运行页输入框与面板输入框边界（呈现层统一）', () => {
  test('面板内没有输入面；运行页输入框是独立输入框且没有 @step 选择器', async ({ page, workspace }) => {
    test.setTimeout(90_000)
    await createMockInstance(page, {
      // hold 撑出「面板已挂载且内容可见」的窗口（断言都在 running 期完成）。
      promptText: `输入框用例。${mockDirective({ text: 'm3-first-answer', hold: 20_000 })}`,
      cwd: workspace,
      label: 'e2e-m3-composer',
    })

    const panel = page.locator('[data-step-chat]').first()
    await expect(panel).toBeVisible({ timeout: 60_000 })
    await expect(panel.getByText('m3-first-answer').first()).toBeVisible({ timeout: 60_000 })

    // ① 面板内没有任何输入面（逐条锚点断言，不是「整页找不到」式的恒真）。
    await expect(
      panel.locator('[data-step-chat-composer-seat]'),
      '面板内不应再有输入框 seat（需求 1）',
    ).toHaveCount(0)
    await expect(panel.locator('[data-step-chat-composer]')).toHaveCount(0)
    await expect(panel.locator('[data-composer-input]')).toHaveCount(0)
    await expect(panel.locator('[data-composer-send]')).toHaveCount(0)
    await expect(panel.locator('[data-composer-queue-hint]')).toHaveCount(0)
    await expect(panel.locator('[data-composer-menu-anchor]')).toHaveCount(0)
    await expect(panel.locator('textarea')).toHaveCount(0)
    // 去 `+` 号（历史断言）自然继续成立：面板内没有「指令」按钮。
    await expect(panel.getByRole('button', { name: '指令' })).toHaveCount(0)
    // 面板本身仍在（会话消息区没被误删）。
    await expect(panel.locator('[data-chat-flow-kind="user"]').first()).toBeVisible()

    // ② 运行页输入框 = **独立输入框**（DSH InputBar 同款壳；不挂 DSH 输入内核）。
    const disc = page.locator('[data-sandore-disc-input]').first()
    await expect(disc).toBeVisible({ timeout: 20_000 })
    const seat = disc.locator('[data-sandore-main-input]').first()
    await expect(seat).toBeVisible()
    const area = seat.locator('[data-main-agent-input]')
    await expect(area).toHaveCount(1)
    expect(await area.evaluate(node => node.tagName), '文本面应是原生 textarea（独立实现）').toBe('TEXTAREA')
    await expect(area).toHaveAttribute('aria-label', '给主代理发消息…')
    // 真机反馈修正：输入框上方那行标签**已删除**（用户明确不要）。
    await expect(disc.locator('[data-sandore-main-input-label]')).toHaveCount(0)
    // 与 DSH 输入壳隔离（不挂内核/不接管根）：结构性断言，逐条为 0。
    await expect(disc.locator('[data-composer-input]')).toHaveCount(0)
    await expect(disc.locator('[data-composer-kernel]')).toHaveCount(0)
    await expect(disc.locator('[data-composer-took-root]')).toHaveCount(0)
    await expect(disc.locator('[data-composer-menu-anchor]')).toHaveCount(0)
    await expect(disc.locator('[contenteditable="true"]')).toHaveCount(0)
    // 席位（照 DSH InputBar）：左 = 权限下拉；右 = 模型下拉 → 发送（**没有**任何动作按钮）。
    await expect(disc.locator('[data-main-agent-access]')).toHaveCount(1)
    await expect(disc.locator('[data-main-agent-model-trigger]')).toHaveCount(1)
    // **唯一不抄**：左下角 `+` 附件按钮不存在（DSH 的 `input.commands` 按钮）。
    await expect(disc.getByRole('button', { name: '指令' })).toHaveCount(0)
    await expect(disc.locator('[data-composer-menu-anchor]')).toHaveCount(0)
    // 真机反馈第三轮：输入框区**没有任何**暂停/停止/中止按钮（用户明确要求去掉）。
    await expect(disc.locator('[data-sandore-stop]'), '输入框区的停止按钮应已删除').toHaveCount(0)
    for (const label of ['暂停', '停止生成', '中止']) {
      await expect(disc.locator(`button[aria-label="${label}"]`), `不应有 aria-label="${label}" 的按钮`).toHaveCount(0)
    }
    const suspicious = await disc.evaluate(node => [...node.querySelectorAll('button')]
      .filter((button) => {
        const text = `${button.getAttribute('aria-label') ?? ''}${button.getAttribute('title') ?? ''}${button.textContent ?? ''}`
        return /暂停|停止|中止/.test(text)
      })
      .map(button => button.getAttribute('aria-label') ?? button.textContent ?? ''))
    expect(suspicious, '输入框区不应出现暂停/停止/中止按钮').toEqual([])
    await expect(
      page.locator('[data-sandore-run-view] [data-sandore-abort]'),
      '实例中止按钮仍在（在标题栏，不在输入框区）',
    ).toHaveCount(1)
    // 空草稿：发送钮禁用。
    await expect(seat.locator('[data-main-agent-send]')).toBeDisabled()
    // 宽度基准（真机反馈修正）：以**step 消息列**为准，输入卡 = 消息列内容宽 + 24px，且同轴心。
    const metrics = await seat.evaluate(() => {
      const root = document.querySelector('[data-sandore-main-input]') as HTMLElement | null
      const card = document.querySelector('[data-main-agent-input-card]') as HTMLElement | null
      const column = document.querySelector('[data-sandore-run-view] [class*="column"]') as HTMLElement | null
      const colStyle = column === null ? null : getComputedStyle(column)
      const colPad = colStyle === null
        ? 0
        : Number.parseFloat(colStyle.paddingLeft) + Number.parseFloat(colStyle.paddingRight)
      const colContent = column === null ? 0 : column.clientWidth - colPad
      const cardRect = card?.getBoundingClientRect()
      const colRect = column?.getBoundingClientRect()
      const rootEl = root ?? card
      return {
        // 变量发布在祖先（对话列）的 inline style 上，故必须用 computed style 读继承值。
        publishedVar: rootEl === null
          ? ''
          : getComputedStyle(rootEl).getPropertyValue('--sandore-msg-content-width').trim(),
        columnContentWidth: Math.round(colContent),
        cardWidth: Math.round(cardRect?.width ?? 0),
        cardCenterX: Math.round((cardRect?.left ?? 0) + (cardRect?.width ?? 0) / 2),
        columnCenterX: Math.round((colRect?.left ?? 0) + (colRect?.width ?? 0) / 2),
      }
    })
    expect(metrics.publishedVar, '消息列内容宽应已发布为 px').toMatch(/^\d+px$/)
    expect(metrics.cardWidth, `输入卡应 = 消息列内容宽 + 24px（实测 ${String(metrics.columnContentWidth)} / ${String(metrics.cardWidth)}）`)
      .toBe(metrics.columnContentWidth + 24)
    expect(
      Math.abs(metrics.cardCenterX - metrics.columnCenterX),
      `输入卡应与消息列同轴心（卡中心 ${String(metrics.cardCenterX)} vs 消息列中心 ${String(metrics.columnCenterX)}）`,
    ).toBeLessThanOrEqual(1)
    // 取证：dump 关键 computed style + class 清单（供人工与 DSH 样式逐值核对）。
    const forensics = await dumpInputForensics(seat)
    expect(forensics).toContain('M3 运行页主代理输入框 DOM/样式取证')

    // ③ 需求 2：`@step` 结构化引用（运行页 step 选择器）已删除。
    await expect(page.locator('[data-sandore-step-picker]')).toHaveCount(0)
    await expect(disc.locator('[data-sandore-step-picker]')).toHaveCount(0)
    // 反向对照（非恒真）：选择器不在，但独立输入框真的在——证明删的是「结构化引用入口」
    // 而不是「整个输入能力」。
    await expect(disc.locator('[data-main-agent-input]')).toHaveCount(1)
  })

  test('ask 接管卡（问题选择）与输入框同宽同轴心（真机反馈：宽度必须统一）', async ({ page, dsh, workspace }) => {
    test.setTimeout(180_000)
    const mark = dsh.logMark()
    // 让 step 子代理**真的**调用 `sandore_ask_user_question`（mock 的 `once=1` 强制工具调用），
    // 于是引擎产生一条 pending question → 运行视图渲染 ask 接管卡（真实弹层，不是桩）。
    await createMockInstance(page, {
      promptText: `提问用例。${mockDirective({
        once: 1,
        tool: 'sandore_ask_user_question',
        toolargs: '{"questions":[{"id":"q1","header":"宽度取证","question":"这个弹层和输入框一样宽吗？","options":[{"label":"是"},{"label":"否"}]}]}',
        hold: 60_000,
      })}`,
      cwd: workspace,
      label: 'e2e-m3-ask',
    })
    // 先量输入框（正常态）的宽度与中心。
    const input = page.locator('[data-main-agent-input-card]').first()
    await expect(input).toBeVisible({ timeout: 60_000 })
    const inputMetrics = await input.evaluate((card) => {
      const rect = card.getBoundingClientRect()
      return { width: Math.round(rect.width), centerX: Math.round(rect.left + rect.width / 2) }
    })
    // 等 ask 接管卡出现（step 真调工具 → 引擎 pending question → 接管输入区）。
    const takeover = page.locator('[data-sandore-takeover="question"]').first()
    await expect(takeover, `ask 接管卡应出现（日志：\n${dsh.logTail().slice(-600)}）`).toBeVisible({ timeout: 120_000 })
    const card = takeover.locator('[class*="questionCard"]').first()
    const takeoverMetrics = await card.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      const column = document.querySelector('[data-sandore-run-view] [class*="column"]') as HTMLElement | null
      const columnRect = column?.getBoundingClientRect()
      const padding = column === null
        ? 0
        : Number.parseFloat(getComputedStyle(column).paddingLeft) + Number.parseFloat(getComputedStyle(column).paddingRight)
      return {
        width: Math.round(rect.width),
        centerX: Math.round(rect.left + rect.width / 2),
        columnContentWidth: column === null ? 0 : Math.round(column.clientWidth - padding),
        columnCenterX: columnRect === undefined ? 0 : Math.round(columnRect.left + columnRect.width / 2),
        // 卡片实际消费的宽度基准（继承自对话列的变量）——两张卡共用它，故与它比较是**精确**断言。
        publishedVar: Number.parseFloat(getComputedStyle(node).getPropertyValue('--sandore-msg-content-width')),
      }
    })
    // ① 规则（精确）：接管卡宽度 = 它消费的宽度基准（= 消息列内容宽）+ 24px。
    expect(
      takeoverMetrics.width,
      `ask 接管卡宽度应 = 宽度基准 + 24px（卡 ${String(takeoverMetrics.width)} / 基准 ${String(takeoverMetrics.publishedVar)}）`,
    ).toBe(takeoverMetrics.publishedVar + 24)
    // ② 基准本身就是消息列内容宽（±4px：滚动条在两次测量之间可能变化）。
    expect(
      Math.abs(takeoverMetrics.publishedVar - takeoverMetrics.columnContentWidth),
      `宽度基准应等于消息列内容宽（基准 ${String(takeoverMetrics.publishedVar)} vs 实测 ${String(takeoverMetrics.columnContentWidth)}）`,
    ).toBeLessThanOrEqual(4)
    // ③ 与输入框同宽同轴心。容差 4px：两组测量发生在**不同时刻**（接管卡出现时输入框已卸载），
    //    期间消息区滚动条可能增减（±2px 布局宽度）；严格相等那条由 ① 承担（两者各自对着同一基准量）。
    expect(
      Math.abs(takeoverMetrics.width - inputMetrics.width),
      `ask 接管卡应与输入框同宽（卡 ${String(takeoverMetrics.width)} vs 输入框 ${String(inputMetrics.width)}）`,
    ).toBeLessThanOrEqual(4)
    expect(
      Math.abs(takeoverMetrics.centerX - inputMetrics.centerX),
      `ask 接管卡应与输入框同轴心（${String(takeoverMetrics.centerX)} vs ${String(inputMetrics.centerX)}）`,
    ).toBeLessThanOrEqual(4)
    // ④ 与消息列同轴心。
    expect(Math.abs(takeoverMetrics.centerX - takeoverMetrics.columnCenterX)).toBeLessThanOrEqual(2)
    // 取证：把两组实测值 dump 到 artifacts（供人工核对）。
    const dump = [
      '# M3 接管卡（ask）与输入框宽度取证',
      `时间：${new Date().toISOString()}`,
      '',
      `- 输入卡宽度：${String(inputMetrics.width)}px（中心 x ${String(inputMetrics.centerX)}）`,
      `- ask 接管卡宽度：${String(takeoverMetrics.width)}px（中心 x ${String(takeoverMetrics.centerX)}）`,
      `- 消息列内容宽：${String(takeoverMetrics.columnContentWidth)}px（中心 x ${String(takeoverMetrics.columnCenterX)}）`,
      '- 规则：三者都 = 消息列内容宽 + 24px 且同轴心（规则断言为严格相等；两者互比为 ≤4px，'
      + '因为两次测量跨越了接管卡出现/消失（消息区滚动条可能增减 2px））',
      `- mock 日志片段：${dsh.logSince(mark).slice(-240).replace(/\n/g, ' | ')}`,
      '',
    ].join('\n')
    writeFileSync(join(REPO_ROOT, 'e2e', '.artifacts', 'm3-takeover-width.txt'), dump, 'utf8')
  })
})
