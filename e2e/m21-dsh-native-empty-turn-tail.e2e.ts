/**
 * M21 · **DSH 原生主代理会话页**里「空 turn 的 turn-tail 行」不占位（权宜之计的真机验证）。
 *
 * ## 与 M19 的分工（两处不同的页面，别混）
 * - **M19**：*我们自己的* 主代理卡片（`[data-main-agent-chat]`，sandore 运行页里的独立卡片）
 *   —— 那条路径由我们自己的渲染器抑制（`stepChatTurnsWithContentOf`）。
 * - **M21（本用例）**：**DSH 原生的会话页**（侧栏搜索 → 中心列打开的宿主会话）—— 那一页的
 *   turn-tail 行由 DSH 自己渲染，我们的渲染器管不到，只能靠权宜之计注入的一条样式规则
 *   （`packages/client/dsh-native-turn-tail.ts`，见其文件头与
 *   `docs/workarounds/dsh-empty-turn-tail.md`）。
 *
 * ## 真机断言（判据不放宽）
 * 1. **注入面**：页面里存在 `<style id="dsh-sandore-workaround-empty-turn-tail"
 *    data-sandore-workaround="empty-turn-tail">`（插件真的把这条件用规则装进了这一页）；
 * 2. **空行一律不占位**：DOM 里每个「空 turn 的 turn-tail 行」（行内没有 `[data-turn-tail]`
 *    且链上没内容）`display: none`、高度 0；
 * 3. **防恒真**：盘面（`session.jsonl.zstd` 切 turn）必须真的有 ≥1 个空 turn，且 DOM 里
 *    被隐藏的空行数 === 盘面空 turn 数；
 * 4. **正向对照**：有内容的 turn-tail（带 `data-turn-tail`）照常可见且带文本；
 * 5. **这一条就是「权宜之计在治什么」的证据**：在同一个真浏览器页面里**临时停用**这条规则
 *    （`style.disabled = true`，不改任何文件），量出可见行之间的间距从 `g` 变成 `g + 16×n`
 *    （n = 夹在两者之间的空行数）——即被隐藏的每一行原本都在吃 DSH 的 16px 列间距；
 *    随后恢复启用，量回原值。
 *
 * 取证落盘：`e2e/.artifacts/dsh-native-empty-turn-tail.txt`。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT, expect, getInstanceState, mockDirective, test } from './fixtures/harness.ts'
import { openHostSessionInColumn } from './fixtures/host-session.ts'
import { readHostTurns, renderHostTurns } from './fixtures/host-turns.ts'
import { createMockThreeStepInstance } from './fixtures/mock-run.ts'

/** 权宜之计注入的元素 id / 标记（与 `packages/client/dsh-native-turn-tail.ts` 一致）。 */
const STYLE_ID = 'dsh-sandore-workaround-empty-turn-tail'
const STYLE_MARKER = 'empty-turn-tail'

/** 页面侧量测：空行判定 + 「夹在两个可见行之间的最大一段空行」的间距。 */
async function measure(page: import('@playwright/test').Page): Promise<{
  readonly marker: { readonly present: boolean; readonly marked: boolean; readonly disabled: boolean }
  readonly tails: readonly { readonly empty: boolean; readonly display: string; readonly height: number; readonly text: number }[]
  readonly emptyCount: number
  readonly visibleRealTails: number
  readonly run: { readonly count: number; readonly gap: number } | null
}> {
  return page.evaluate(id => {
    const style = document.getElementById(id) as HTMLStyleElement | null
    const column = document.querySelector('[data-chat-flow]')
    const rows = [...(column?.children ?? [])].filter(el => el.getAttribute('data-chat-flow-kind') !== null)
    const tails = rows
      .filter(el => el.getAttribute('data-chat-flow-kind') === 'turn-tail')
      .map(el => {
        const rect = el.getBoundingClientRect()
        return {
          empty: el.querySelector('[data-turn-tail]') === null
            && (el.querySelector("[data-slot='conversation.chat.turnTail']")?.childElementCount ?? 0) === 0,
          display: getComputedStyle(el).display,
          height: Math.round(rect.height * 10) / 10,
          text: (el.textContent ?? '').trim().length,
        }
      })
    const visible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect()
      return getComputedStyle(el).display !== 'none' && rect.height > 0
    }
    // 夹在两个可见行之间的**最长一段连续空行**：它的「上一可见行底 → 下一可见行顶」距离
    // 就是这条规则是否真的省下布局的证据（每多一行空壳就多一条 --dsh-chat-flow-gap）。
    let run: { count: number; gap: number } | null = null
    for (let index = 0; index < rows.length; index += 1) {
      const el = rows[index]!
      const isEmptyTail = el.getAttribute('data-chat-flow-kind') === 'turn-tail'
        && el.querySelector('[data-turn-tail]') === null
        && (el.querySelector("[data-slot='conversation.chat.turnTail']")?.childElementCount ?? 0) === 0
      if (!isEmptyTail) continue
      let end = index
      while (end + 1 < rows.length) {
        const next = rows[end + 1]!
        const nextEmpty = next.getAttribute('data-chat-flow-kind') === 'turn-tail'
          && next.querySelector('[data-turn-tail]') === null
          && (next.querySelector("[data-slot='conversation.chat.turnTail']")?.childElementCount ?? 0) === 0
        if (!nextEmpty) break
        end += 1
      }
      let before = index - 1
      while (before >= 0 && !visible(rows[before]!)) before -= 1
      let after = end + 1
      while (after < rows.length && !visible(rows[after]!)) after += 1
      if (before >= 0 && after < rows.length) {
        const gap = Math.round((rows[after]!.getBoundingClientRect().top - rows[before]!.getBoundingClientRect().bottom) * 10) / 10
        const count = end - index + 1
        if (run === null || count > run.count) run = { count, gap }
      }
      index = end
    }
    return {
      marker: {
        present: style !== null,
        marked: style?.getAttribute('data-sandore-workaround') === 'empty-turn-tail',
        disabled: style?.disabled === true,
      },
      tails,
      emptyCount: tails.filter(tail => tail.empty).length,
      visibleRealTails: tails.filter(tail => !tail.empty && tail.display !== 'none' && tail.height > 0).length,
      run,
    }
  }, STYLE_ID)
}

test.describe('M21 DSH 原生会话页空 turn-tail 不占位（权宜之计）', () => {
  test('空 turn 的 turn-tail 被隐藏、正常尾部照常可见，且隐藏确实省下 16px 列间距', async ({ page, dsh, workspace }) => {
    test.setTimeout(300_000)
    const instance = await createMockThreeStepInstance(page, {
      promptTexts: [
        `M21 第一步。${mockDirective({ text: 'm21-answer-1' })}`,
        `M21 第二步。${mockDirective({ text: 'm21-answer-2' })}`,
        `M21 第三步。${mockDirective({ text: 'm21-answer-3' })}`,
      ],
      cwd: workspace,
      label: 'e2e-m21',
    })
    await expect.poll(async () => (await getInstanceState(page, instance.instanceId)).status, { timeout: 240_000 })
      .toMatch(/completed|failed|aborted/)

    // 打开 **DSH 原生**宿主会话页（侧栏搜索 → 中心列）。
    await openHostSessionInColumn(page, instance.requirement)

    // 等页面的行渲染落定（终态后不再流式；给 markdown/折叠一帧时间）。
    await page.waitForTimeout(1_500)
    const suppressed = await measure(page)
    // 归属检查：确认我们量的是 DSH 原生列（不是 sandore 面板里的卡）。
    const nativeColumn = await page.evaluate(() => {
      const column = document.querySelector('[data-chat-flow]')
      return column !== null && column.closest('[data-sandore-seat-view]') === null
    })

    // 盘面真值：宿主会话的空 turn 数（被 park 的结算通知留下）。
    const turns = readHostTurns(dsh.home, instance.instanceId)
    const emptyTurns = turns.filter(turn => turn.empty)

    // 真浏览器里的「停用 → 量 → 恢复」对照（不改文件、不改产品代码）。
    // 注意：`<style>` 的 `disabled` 是 **IDL 属性**（`style.disabled = true`），没有对应的
    // HTML 内容属性——`setAttribute('disabled')` 是无效的（第一版就在这里量到 delta=0）。
    await page.evaluate(id => { const style = document.getElementById(id) as HTMLStyleElement | null; if (style !== null) style.disabled = true }, STYLE_ID)
    const enabled = await measure(page)
    const disabled = await page.evaluate(id => {
      const style = document.getElementById(id) as HTMLStyleElement | null
      return style?.disabled === true
    }, STYLE_ID)
    await page.evaluate(id => { const style = document.getElementById(id) as HTMLStyleElement | null; if (style !== null) style.disabled = false }, STYLE_ID)
    const restored = await measure(page)

    writeFileSync(
      join(REPO_ROOT, 'e2e', '.artifacts', 'dsh-native-empty-turn-tail.txt'),
      [
        '# M21 DSH 原生会话页空 turn-tail（权宜之计真机取证）',
        `时间：${new Date().toISOString()}`,
        `实例：${instance.instanceId}（会话标题 = ${instance.requirement}）`,
        `量测的列是 DSH 原生列（不在 sandore 面板里）：${String(nativeColumn)}`,
        '',
        renderHostTurns(turns),
        '',
        '## 汇总', 
        `注入元素：present=${String(suppressed.marker.present)} marker=${String(suppressed.marker.marked)}`
        + `（标记值应为 ${STYLE_MARKER}）`,
        `盘面 turn 数=${String(turns.length)} 空 turn 数=${String(emptyTurns.length)}`,
        `DOM turn-tail 行=${String(suppressed.tails.length)} 其中空行=${String(suppressed.emptyCount)}`
        + ` 可见的正常尾部=${String(suppressed.visibleRealTails)}`,
        `禁用规则后：空行 display=${enabled.tails.filter(tail => tail.empty).map(tail => tail.display).join(',') || '无'}`
        + `；恢复后 disabled 属性=${String(disabled)}`,
        `间距（上一可见行底 → 下一可见行顶）：规则生效=${String(suppressed.run?.gap ?? 'n/a')}`
        + ` 停用后=${String(enabled.run?.gap ?? 'n/a')} 空行数=${String(suppressed.run?.count ?? 'n/a')}`,
        `恢复后复测=${String(restored.run?.gap ?? 'n/a')}`,
        '',
        `## 逐行（空行判定 / display / 高度 / 文本长度）`,
        ...suppressed.tails.map((tail, index) =>
          `[${String(index)}] 空行=${String(tail.empty)} display=${tail.display} h=${tail.height.toFixed(1)} 文本=${String(tail.text)}字`),
        '',
      ].join('\n'),
      'utf8',
    )

    // ① 注入面：规则确实装进了这一页，且带权宜之计标记。
    expect(suppressed.marker.present, '权宜之计的 <style> 应注入 DSH 原生会话页').toBe(true)
    expect(suppressed.marker.marked, '注入元素应带 data-sandore-workaround 标记').toBe(true)
    expect(nativeColumn, '量测的应是 DSH 原生会话列（不在 sandore 面板内）').toBe(true)

    // ② 防恒真：多步实例必须真的产生空 turn（否则本用例什么也没证明）。
    expect(emptyTurns.length, `盘面应有空 turn（被 park 的结算通知）：\n${renderHostTurns(turns)}`).toBeGreaterThanOrEqual(1)
    expect(suppressed.emptyCount, 'DOM 里应能找到空 turn 的 turn-tail 行').toBeGreaterThanOrEqual(1)
    // 盘面与 DOM 一一对应。
    expect(suppressed.emptyCount, 'DOM 空行数应等于盘面空 turn 数').toBe(emptyTurns.length)

    // ③ 空行一律不占位（display:none；高度 0）。
    const visibleEmpty = suppressed.tails.filter(tail => tail.empty && (tail.display !== 'none' || tail.height > 0))
    expect(visibleEmpty, '空 turn 的 turn-tail 行不得可见/占位').toEqual([])

    // ④ 正向对照：有内容的尾部照常可见且带文本。
    expect(suppressed.visibleRealTails, '有内容的 turn-tail 必须照常可见').toBeGreaterThanOrEqual(1)
    expect(
      suppressed.tails.filter(tail => !tail.empty && tail.text === 0),
      '正常尾部应带内容（复制/时钟/用量读数）',
    ).toEqual([])

    // ⑤ 权宜之计治的就是「每行白吃 16px」：停用后间距应增加 16 × n，恢复后回到原值。
    expect(suppressed.run, '应能找到夹在两个可见行之间的一段空行（否则量不到间距对照）').not.toBeNull()
    expect(enabled.run, '停用规则后同样应量到该段空行').not.toBeNull()
    const expectedDelta = 16 * (suppressed.run?.count ?? 0)
    expect(
      Math.round(((enabled.run?.gap ?? 0) - (suppressed.run?.gap ?? 0)) * 10) / 10,
      `停用规则后间距应增加 16 × ${String(suppressed.run?.count ?? 0)}px（证明每行原本都在吃 DSH 的列间距）`,
    ).toBeCloseTo(expectedDelta, 1)
    expect(restored.run?.gap, '恢复规则后间距应回到原值').toBeCloseTo(suppressed.run?.gap ?? 0, 1)
  })
})
