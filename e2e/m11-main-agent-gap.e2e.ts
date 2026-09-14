/**
 * M11 · 主代理卡片里的**巨大空白**（真机缺陷复现 + 取证 + 回归断言）。
 *
 * 用户真机原话：
 * > 「这个好像是之前工作流返回结果是通过用户消息返回，所以之前有一个用户消息的右边消息泡，
 * >  所以有这么大的空白，但是现在不是采用左边上下文注入吗？怎么还有这么大的空白」
 *
 * 现象：主代理卡片内容顺序 = 启动汇报 → **巨大空白** → 终态汇报（「…已结束，状态 completed」）。
 * 怀疑：引擎的终态通知已改成左侧「上下文注入」形态（`source.kind='plugin'`），但那一行**仍套着
 * 原来右侧 user 气泡的容器**（空内容却保留高度/对齐/间距），于是渲染出一段空白。
 *
 * 本用例（真机，mock 工作流）做三件事：
 * 1. 让实例跑完（短 hold）→ 主代理先有启动汇报、后有终态汇报 ⇒ 复现两段汇报之间的大空白；
 * 2. **逐行取证**：主代理卡片内每一行的 kind / 文本 / boundingBox（top/height）/ 行间距，
 *    以及那段空白所属元素的 `getBoundingClientRect()` + 关键 computed style，dump 到
 *    `e2e/.artifacts/main-agent-gap.txt`；
 * 3. **回归断言**（真机计数，不放宽）：
 *    - 不存在「有高度（>4px）但无文本、也无可见子元素」的行（排除有意义的占位）；
 *    - 上下文注入行**不右对齐**（其左边界与普通行一致；且没有 `align-self: flex-end` 之类的右贴靠）；
 *    - 相邻行间距与普通行间距一致（用实测值断言，容差 ±4px）。
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT, expect, getInstanceState, mockDirective, test, type Page } from './fixtures/harness.ts'
import { createMockInstance } from './fixtures/mock-run.ts'

/** 卡片内一行（或任意元素）的取证形状。 */
interface RowProbe {
  readonly index: number
  readonly tag: string
  readonly className: string
  readonly kind: string | null
  readonly top: number
  readonly bottom: number
  readonly height: number
  readonly left: number
  readonly right: number
  readonly alignSelf: string
  readonly display: string
  readonly marginTop: string
  readonly marginBottom: string
  readonly paddingTop: string
  readonly paddingBottom: string
  readonly minHeight: string
  readonly textLength: number
  readonly text: string
  readonly visibleChildren: number
  readonly visibleChildrenHeight: number
  /** 第一个可见子元素的左/右边界（判定「内容是否左锚」——右贴靠气泡的内容会靠右）。 */
  readonly firstChildLeft: number
  readonly firstChildRight: number
  readonly isMainAgentRow: boolean
  readonly isContextRow: boolean
}

/** 主代理卡片内的逐行取证（含「空白候选」与行距统计）。 */
async function probeCard(page: Page): Promise<{
  rows: readonly RowProbe[]
  gapSuspects: readonly RowProbe[]
  gaps: readonly number[]
  visibleGaps: readonly number[]
  maxVisibleGap: number
  innerGapSuspects: readonly (RowProbe & { readonly visibleChildrenHeight: number })[]
  cardText: string
}> {
  return page.locator('[data-main-agent-chat]').first().evaluate((panel) => {
    const flow = panel.querySelector('[data-chat-flow]') ?? panel
    const direct = [...flow.children] as HTMLElement[]
    const described = direct.map((node, index) => {
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
      const childRects = [...node.children]
        .map(child => child.getBoundingClientRect())
        .filter(childRect => childRect.width > 0 && childRect.height > 0)
      return {
        index,
        tag: node.tagName.toLowerCase(),
        className: String(node.className),
        kind: node.getAttribute('data-chat-flow-kind'),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        alignSelf: style.alignSelf,
        display: style.display,
        marginTop: style.marginTop,
        marginBottom: style.marginBottom,
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
        minHeight: style.minHeight,
        textLength: text.length,
        text: text.slice(0, 80),
        visibleChildren: childRects.length,
        visibleChildrenHeight: Math.round(childRects.reduce((sum, rect2) => sum + rect2.height, 0)),
        firstChildLeft: Math.round(childRects[0]?.left ?? rect.left),
        firstChildRight: Math.round(childRects[0]?.right ?? rect.right),
        isMainAgentRow: node.getAttribute('data-chat-flow-kind') === 'assistant-step',
        isContextRow: node.getAttribute('data-chat-flow-kind') === 'context',
      }
    })
    // 「空白候选」：有高度（>4px）但没文本、也没有可见子元素。
    const gapSuspects = described.filter(row => row.height > 4 && row.textLength === 0 && row.visibleChildren === 0)
    // 相邻行之间的垂直间距（top[i+1] - bottom[i]），排除负数（重叠）。
    const gaps: number[] = []
    for (let index = 1; index < described.length; index += 1) {
      const gap = (described[index]?.top ?? 0) - (described[index - 1]?.bottom ?? 0)
      if (gap >= 0) gaps.push(gap)
    }
    // **只看可见行**（折叠成员 rect 恒 0，不是视觉间距）。
    const visible = described.filter(row => row.height > 0)
    const visibleGaps: number[] = []
    for (let index = 1; index < visible.length; index += 1) {
      const gap = (visible[index]?.top ?? 0) - (visible[index - 1]?.bottom ?? 0)
      if (gap >= 0) visibleGaps.push(gap)
    }
    // 行内部空内容：可见行的高度明显大于其可见子元素高度和（且文字很少）。
    const innerGapSuspects = visible.filter(row =>
      row.visibleChildren > 0
      && row.textLength < 200
      && row.height - row.visibleChildrenHeight > 24)
    return {
      rows: described,
      gapSuspects,
      gaps,
      visibleGaps,
      maxVisibleGap: visibleGaps.length === 0 ? 0 : Math.max(...visibleGaps),
      innerGapSuspects,
      cardText: (panel.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    }
  })
}

/** 把取证写成人类可读文本（同时返回，便于断言失败信息里直接看）。 */
function renderProbe(
  result: Awaited<ReturnType<typeof probeCard>>,
  label: string,
  fileName = 'main-agent-gap.txt',
): string {
  const visSorted = [...result.visibleGaps].sort((a, b) => a - b)
  const text = [
    `# M11 主代理卡片「巨大空白」取证（${label}）`,
    `时间：${new Date().toISOString()}`,
    '',
    '## 行距统计（相邻行 top[i+1] - bottom[i]，px）',
    `- 全部行距（含被折叠的 0 高度行）：${JSON.stringify(result.gaps)}`,
    `- **可见行**行距（height > 0）：${JSON.stringify(result.visibleGaps)}`,
    `- 可见行距 最小/中位/最大：${String(visSorted[0] ?? -1)} / ${String(visSorted[Math.floor(visSorted.length / 2)] ?? -1)} / ${String(result.maxVisibleGap)}`,
    '',
    '## 空白候选（有高度 > 4px、无文本、无可见子元素）',
    result.gapSuspects.length === 0
      ? '- 无（没有空壳行）'
      : result.gapSuspects.map(row => [
        `- 行[${String(row.index)}] <${row.tag}> kind=${String(row.kind)} class=${row.className}`,
        `    rect: top=${String(row.top)} bottom=${String(row.bottom)} height=${String(row.height)} left=${String(row.left)} right=${String(row.right)}`,
        `    style: display=${row.display} align-self=${row.alignSelf} margin=${row.marginTop}/${row.marginBottom} padding=${row.paddingTop}/${row.paddingBottom} min-height=${row.minHeight}`,
        `    可见子元素=${String(row.visibleChildren)} 文本长度=${String(row.textLength)}`,
      ].join('\n')).join('\n'),
    '',
    '## 行内部空内容候选（可见行高度 − 可见子元素高度和 > 24px）',
    result.innerGapSuspects.length === 0
      ? '- 无'
      : result.innerGapSuspects.map(row =>
        `- 行[${String(row.index)}] kind=${String(row.kind)} h=${String(row.height)} childrenH=${String(row.visibleChildrenHeight)} text=${String(row.textLength)}`).join('\n'),
    '',
    '## 逐行取证（卡片内容区的直接子节点；h=0 表示被折叠隐藏、不参与视觉间距）',
    ...result.rows.map(row => [
      `[${String(row.index)}] <${row.tag}> kind=${String(row.kind)} h=${String(row.height)} top=${String(row.top)} left=${String(row.left)} right=${String(row.right)} align-self=${row.alignSelf} childrenH=${String(row.visibleChildrenHeight)}`,
      `    文本(${String(row.textLength)}字)：${row.text}`,
    ].join('\n')),
    '',
    '## 卡片文本前缀',
    result.cardText,
    '',
  ].join('\n')
  writeFileSync(join(REPO_ROOT, 'e2e', '.artifacts', fileName), text, 'utf8')
  appendFileSync(
    join(REPO_ROOT, 'e2e', '.artifacts', 'main-agent-gap-history.log'),
    `[${new Date().toISOString()}] label=${label} rows=${String(result.rows.length)}`
    + ` visibleRows=${String(result.rows.filter(row => row.height > 0).length)}`
    + ` visibleGaps=${JSON.stringify(result.visibleGaps)} maxVisibleGap=${String(result.maxVisibleGap)}`
    + ` suspects=${String(result.gapSuspects.length)} innerSuspects=${String(result.innerGapSuspects.length)}\n`,
    'utf8',
  )
  return text
}

test.describe('M11 主代理卡片不出现「巨大空白」', () => {
  test('启动汇报与终态汇报之间没有空壳行；注入行左对齐、行距与普通行一致', async ({ page, dsh, workspace }) => {
    test.setTimeout(180_000)
    const mark = dsh.logMark()
    // 短 hold（2s）让工作流很快跑到 completed ⇒ 引擎发出终态通知 ⇒ 主代理产出第二条汇报。
    const instance = await createMockInstance(page, {
      promptText: `空白取证用例。${mockDirective({ text: 'm11-step-answer', hold: 2_000 })}`,
      cwd: workspace,
      label: 'e2e-m11-gap',
    })
    const card = page.locator('[data-tl-main-agent]').first()
    await expect(card, '主代理卡片应出现（启动汇报）').toBeVisible({ timeout: 90_000 })
    await expect(page.locator('[data-main-agent-chat]')).toHaveCount(1)

    // 再从运行页输入框发一条**带工具轮次**的消息（复刻真机「10 次工具调用」的回合结构）：
    // mock 的 `tools=K` 按会话计数，故这里给出一个较大的 K 让宿主主代理本回合多跑几轮工具。
    const area = page.locator('[data-sandore-disc-input] [data-main-agent-input]').first()
    await expect(area).toBeVisible({ timeout: 30_000 })
    await area.fill(`请回我一句。${mockDirective({
      text: 'm11-main-answer',
      tools: 5,
      tool: 'write',
      toolargs: '{"file_path":"m11-tool-{n}.txt","content":"x"}',
    })}`)
    const send = page.locator('[data-sandore-disc-input] [data-main-agent-send]').first()
    await expect(send).toBeEnabled({ timeout: 20_000 })
    await send.click()
    await expect.poll(
      async () => dsh.countSince(mark, /text="m11-main-answer"/g),
      { timeout: 60_000, message: `主代理应被驱动（日志：\n${dsh.logTail().slice(-600)}）` },
    ).toBeGreaterThanOrEqual(1)

    // 等实例终态 + 主代理的第二条汇报（终态通知 → 主代理回话）。
    await expect.poll(
      async () => (await getInstanceState(page, instance.instanceId)).status,
      { timeout: 120_000, message: '工作流应跑到终态（completed）' },
    ).toBe('completed')
    await expect.poll(
      async () => dsh.countSince(mark, /\[e2e-mock\] host-run /g),
      { timeout: 60_000, message: `主代理应被启动注入驱动（日志：\n${dsh.logTail().slice(-600)}）` },
    ).toBeGreaterThanOrEqual(1)
    // ④ 终态规格：**默认展开**且卡体**真的有消息文本**（真机缺陷「完成后下面的消息为空」的回归断言）。
    //    注意：这里**不点击**折叠开关——点击会掩盖「终态没展开」的回归。
    await expect.poll(
      async () => (await page.locator('[data-main-agent-chat]').count()),
      { timeout: 90_000, message: '终态时主代理卡片仍应挂载（卡体渲染）' },
    ).toBe(1)
    await expect(
      page.locator('[data-tl-main-agent-toggle]').first(),
      '终态默认展开（不会自动折叠）',
    ).toHaveAttribute('aria-expanded', 'true', { timeout: 30_000 })
    await expect.poll(async () => (await page.locator('[data-main-agent-chat]').first().textContent()) ?? '', {
      timeout: 90_000,
      message: '主代理应产出终态汇报（含「已结束」）',
    }).toContain('已结束')
    const terminalBody = (await page.locator('[data-main-agent-chat]').first().textContent()) ?? ''
    expect(terminalBody.length, '终态卡体不能为空（必须有主代理的消息文本）').toBeGreaterThan(20)

    const result = await probeCard(page)
    const text = renderProbe(result, '启动汇报 → 终态汇报')

    // ① 没有空壳行（有高度、无文本、无可见子元素）。
    expect(
      result.gapSuspects.map(row => `[${String(row.index)}] <${row.tag}> h=${String(row.height)} class=${row.className}`),
      `不应存在「有高度但无内容」的行：\n${text}`,
    ).toEqual([])
    // ② 行距一致：**只看可见行**（height > 0；折叠成员的 rect 恒为 0，不参与视觉间距计算），
    //    任何可见行距都不得超过「常见行距 + 4px」（防止某一行撑出大空白）。
    const visibleGaps = result.visibleGaps
    expect(visibleGaps.length, `应有可见行距可算：\n${text}`).toBeGreaterThan(0)
    const sortedGaps = [...visibleGaps].sort((a, b) => a - b)
    const median = sortedGaps[Math.floor(sortedGaps.length / 2)] ?? 0
    const worst = sortedGaps[sortedGaps.length - 1] ?? 0
    expect(worst, `最大可见行距 ${String(worst)}px 不应显著超过常见行距 ${String(median)}px：\n${text}`)
      .toBeLessThanOrEqual(median + 4)
    // ③ 可见行内部也不应有「大段空内容」（行高远大于其可见子元素的高度和）。
    expect(
      result.innerGapSuspects.map(row => `[${String(row.index)}] kind=${String(row.kind)} h=${String(row.height)} childrenH=${String(row.visibleChildrenHeight)} text=${String(row.textLength)}`),
      `可见行内部出现了大段空内容：\n${text}`,
    ).toEqual([])
    // ④ 上下文注入行**不是**右贴靠气泡：其**可见**注入行的左边界与普通行一致，
    //    且 align-self 不是 flex-end/right。
    const visibleContextRows = result.rows.filter(row => row.isContextRow && row.height > 0)
    const assistantRows = result.rows.filter(row => row.isMainAgentRow && row.height > 0)
    expect(assistantRows.length, `应能取到可见的主代理消息行：\n${text}`).toBeGreaterThanOrEqual(1)
    const assistantLeft = assistantRows[0]?.left ?? 0
    for (const row of visibleContextRows) {
      expect(Math.abs(row.left - assistantLeft), `注入行左边界应与普通行一致：\n${text}`).toBeLessThanOrEqual(2)
      expect(row.alignSelf).not.toBe('flex-end')
      expect(row.alignSelf).not.toBe('end')
    }
    // ⑤ 不存在**空的右贴靠气泡**（用户怀疑的「旧 user 消息泡占位」）：kind=user 且无文本的可见行。
    const emptyUserBubbles = result.rows
      .filter(row => row.kind === 'user' && row.height > 0 && row.textLength === 0)
    expect(emptyUserBubbles.map(row => `[${String(row.index)}] h=${String(row.height)}`), `不应有空 user 气泡：\n${text}`)
      .toEqual([])
    // ⑥ 全屏校验：卡片面板里最大的「可见行间空白」不得超过 常见行距 + 4（同一判据，换一种取法）。
    expect(result.maxVisibleGap, `卡片内最大可见空白 ${String(result.maxVisibleGap)}px 过大：\n${text}`)
      .toBeLessThanOrEqual(median + 4)

    // ⑦ **展开所有折叠的进程组**（context 注入行/member 行默认 hidden、rect 恒 0）后再验一次：
    //    展开后可见的注入行必须与普通行**左对齐**（不是右贴靠气泡），且展开不引入大空白。
    const foldToggles = page.locator('[data-main-agent-chat] [data-chat-flow-kind="turn-process"] button')
    const foldCount = await foldToggles.count()
    let expandedFolds = 0
    for (let index = 0; index < foldCount; index += 1) {
      const toggle = foldToggles.nth(index)
      if (await toggle.getAttribute('aria-expanded') === 'false') {
        await toggle.click()
        expandedFolds += 1
      }
    }
    if (expandedFolds > 0) {
      await page.waitForTimeout(500)
      const expanded = await probeCard(page)
      const expandedText = renderProbe(expanded, `展开 ${String(expandedFolds)} 个进程组后的注入行对齐`, 'main-agent-gap-expanded.txt')
      const expandedContext = expanded.rows.filter(row => row.isContextRow && row.height > 0)
      expect(expandedContext.length, `展开后应能看到上下文注入行：\n${expandedText}`).toBeGreaterThanOrEqual(1)
      const visibleAssistant = expanded.rows.filter(row => row.isMainAgentRow && row.height > 0)
      const baseLeft = visibleAssistant[0]?.left ?? 0
      for (const row of expandedContext) {
        expect(
          Math.abs(row.left - baseLeft),
          `注入行必须与普通行左对齐（left=${String(row.left)} vs 普通行 ${String(baseLeft)}）：\n${expandedText}`,
        ).toBeLessThanOrEqual(2)
        expect(row.alignSelf, '注入行不得用 align-self 右贴靠').not.toBe('flex-end')
        // 右贴靠气泡的判据：**内容**被推到行的右侧（首个子元素左边界远离行左边界）。
        // 我们的注入行是整宽左锚块（左边界即行左边界）。
        expect(
          row.firstChildLeft - row.left,
          `注入行内容应左锚（首子元素 left=${String(row.firstChildLeft)} / 行 left=${String(row.left)}）：\n${expandedText}`,
        ).toBeLessThanOrEqual(4)
      }
      // 展开后的可见行距同样不得出现大空白。
      const expandedGaps = [...expanded.visibleGaps].sort((a, b) => a - b)
      const expandedMedian = expandedGaps[Math.floor(expandedGaps.length / 2)] ?? 0
      expect(expanded.maxVisibleGap, `展开进程组后出现大空白：\n${expandedText}`)
        .toBeLessThanOrEqual(expandedMedian + 4)
    }
  })

  test('折叠后可点开：卡头任意区域都能展开，且展开后 >3s 不被自动收回', async ({ page, dsh, workspace }) => {
    test.setTimeout(180_000)
    const mark = dsh.logMark()
    await createMockInstance(page, {
      promptText: `卡头点击用例。${mockDirective({ text: 'm11-click-answer', hold: 90_000 })}`,
      cwd: workspace,
      label: 'e2e-m11-click',
    })
    const card = page.locator('[data-tl-main-agent]').first()
    await expect(card, '主代理卡片应出现（启动汇报）').toBeVisible({ timeout: 90_000 })
    const toggle = page.locator('[data-tl-main-agent-toggle]').first()

    // 真机缺陷复现路径：先等自动折叠（消息停更 >3s）。
    await expect(toggle, '消息停更 3 秒后应自动折叠').toHaveAttribute('aria-expanded', 'false', { timeout: 30_000 })
    await expect(page.locator('[data-main-agent-chat]'), '折叠态卡体不渲染').toHaveCount(0)

    /** 卡头按钮的 viewport 几何（取不到就断言失败——卡头必须始终可量）。 */
    const headBox = async (): Promise<{ x: number; y: number; width: number; height: number }> => {
      const box = await toggle.boundingBox()
      expect(box, '卡头按钮应能取到几何').not.toBeNull()
      return { x: box!.x, y: box!.y, width: box!.width, height: box!.height }
    }

    // ── 多元素体检 ────────────────────────────────────────────────────────────
    // 全量跑里页面可能还原/残留上一用例打开过的列（两个运行视图同屏）：此时 `.first()`
    // 可能量到**不可见那一个**的坐标，点击就落到可见列里的别的元素上（真机失败信息命中的
    // `div.stepChatColumn`）。这里把页面上每个卡头按钮的几何/可见性都记下来。
    const layoutLines: string[] = []
    {
      const counts = await page.evaluate(() => ({
        runViews: document.querySelectorAll('[data-sandore-run-view]').length,
        timelines: document.querySelectorAll('[data-sandore-timeline]').length,
        cards: document.querySelectorAll('[data-tl-main-agent]').length,
        toggles: document.querySelectorAll('[data-tl-main-agent-toggle]').length,
        stepChats: document.querySelectorAll('[data-step-chat]').length,
        mainChats: document.querySelectorAll('[data-main-agent-chat]').length,
      }))
      layoutLines.push(
        `运行视图=${String(counts.runViews)} 时间轴=${String(counts.timelines)} 主代理卡=${String(counts.cards)}`
        + ` 卡头按钮=${String(counts.toggles)} step 面板=${String(counts.stepChats)} 主代理卡体=${String(counts.mainChats)}`,
      )
      const toggleHandles = await page.locator('[data-tl-main-agent-toggle]').all()
      for (const [index, handle] of toggleHandles.entries()) {
        const box = await handle.boundingBox()
        const style = await handle.evaluate((el) => {
          const computed = getComputedStyle(el)
          const rect = el.getBoundingClientRect()
          return {
            visibility: computed.visibility,
            display: computed.display,
            pointerEvents: computed.pointerEvents,
            offsetParent: (el as HTMLElement).offsetParent !== null,
            inViewport: rect.bottom > 0 && rect.top < window.innerHeight,
          }
        })
        layoutLines.push(
          `  卡头[${String(index)}] box=${box === null
            ? 'null'
            : `(${box.x.toFixed(1)},${box.y.toFixed(1)},${box.width.toFixed(1)}×${box.height.toFixed(1)})`}`
          + ` visibility=${style.visibility} display=${style.display} pointer-events=${style.pointerEvents}`
          + ` offsetParent=${String(style.offsetParent)} 在视口内=${String(style.inViewport)}`,
        )
      }
    }

    // ── 坐标漂移采样（「点不到」的成因判定，2.5s × 100ms）──────────────────────
    // 卡头在 viewport 里的 y 若还在变（上方 step 面板仍在长：分页自动补齐/行渲染），
    // 那么「先量坐标、后点击」就会点到别的元素上——真机失败信息里命中的
    // `div.stepChatColumn` 正是上方 step 面板的列容器。这里把位移量测出来写进取证。
    const driftLedger: string[] = []
    const driftY: number[] = []
    for (let index = 0; index < 25; index += 1) {
      const box = await headBox()
      const autofill = await page.locator('[data-step-chat-autofill]').count()
      driftY.push(box.y)
      driftLedger.push(
        `t=${String(index * 100)}ms y=${box.y.toFixed(1)} w=${box.width.toFixed(1)} h=${box.height.toFixed(1)}`
        + ` 面板自动补齐中=${String(autofill)}`,
      )
      await page.waitForTimeout(100)
    }
    const driftRange = Math.max(...driftY) - Math.min(...driftY)

    /**
     * 等卡头「停住」再点：连续 3 次采样（120ms 间隔）几何与「是否有面板在自动补齐更早
     * 历史」都完全一致才算稳定。不稳定就等——把「坐标在测量与点击之间失效」这个真机
     * 失败成因从测试里消掉（而不是靠 sleep 撞运气）。
     *
     * 退化框（列还没布局好：宽 < 40 或高 < 8，此时框中心是面板边缘、点下去必然落到
     * 别的元素上）一律不算稳定样本——必须等到一个**正常大小**的卡头框。
     */
    const waitStableHead = async (timeoutMs = 20_000): Promise<{
      readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
      readonly waitedMs: number
    }> => {
      const startedAt = Date.now()
      let previous = ''
      let stable = 0
      let box = await headBox()
      while (Date.now() - startedAt < timeoutMs) {
        box = await headBox()
        const sane = box.width >= 40 && box.height >= 8
        const autofill = await page.locator('[data-step-chat-autofill]').count()
        const key = `${box.x.toFixed(1)}|${box.y.toFixed(1)}|${box.width.toFixed(1)}|${box.height.toFixed(1)}|${String(autofill)}`
        if (sane && key === previous) {
          stable += 1
          if (stable >= 2) return { box, waitedMs: Date.now() - startedAt }
        } else {
          stable = 0
          previous = key
        }
        await page.waitForTimeout(120)
      }
      return { box, waitedMs: Date.now() - startedAt }
    }

    /** 一个坐标下的真实命中（元素名 + 是否落在卡头按钮内 + 前 4 层的命中链）。 */
    const hitAt = async (px: number, py: number): Promise<{
      readonly hit: string
      readonly inToggle: boolean
      readonly chain: string
    }> => page.evaluate(({ x, y }) => {
      const describe = (el: Element): string => {
        const cls = String(el.className).split(' ')[0] ?? ''
        return `${el.tagName.toLowerCase()}${cls === '' ? '' : `.${cls}`}`
      }
      const node = document.elementFromPoint(x, y)
      if (node === null) return { hit: 'null', inToggle: false, chain: '' }
      return {
        hit: describe(node),
        inToggle: node.closest('[data-tl-main-agent-toggle]') !== null,
        chain: document.elementsFromPoint(x, y).slice(0, 4).map(describe).join(' < '),
      }
    }, { x: px, y: py })

    /** 记录一次点击的「真实命中元素」+ 点击后的状态（取证用）。 */
    const probeHit = async (label: string, selector: string | null): Promise<{
      readonly label: string
      readonly hit: string
      readonly expanded: string | null
      readonly bodyRows: number
      readonly attempts: number
      readonly notes: readonly string[]
    }> => {
      const target = selector === null ? toggle : page.locator(selector).first()
      const notes: string[] = []
      // 命中校验 + 重试：坐标必须先量稳、再核对命中确实落在卡头按钮内，才真点。
      // 三次都没落在按钮内时照旧真点一次，让断言给出真实失败（不放宽判据）。
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        // 重试前先把状态复位到折叠态（避免「上一次点击其实生效了、只是状态读晚了」把
        // 下一次点击变成折叠）。
        if (attempt > 1 && await toggle.getAttribute('aria-expanded') === 'true') {
          await toggle.click()
          await page.waitForTimeout(150)
        }
        const { box, waitedMs } = await waitStableHead()
        // 子区域（头像/标题/状态/箭头）用**子元素自己的框**：证明每一块都能点开。
        const regionBox = selector === null ? box : await target.boundingBox()
        expect(regionBox, `${label}：应能取到可点区域`).not.toBeNull()
        // 退化框（宽/高 < 2px）：列还没布局好，框中心不是这块区域的真实位置，直接重测。
        if (regionBox!.width < 2 || regionBox!.height < 2) {
          notes.push(
            `第 ${attempt} 次：${label} 的可点区域退化为 ${regionBox!.width.toFixed(1)}×${regionBox!.height.toFixed(1)}px`
            + '（布局未就绪），重测坐标',
          )
          await page.waitForTimeout(200)
          continue
        }
        const x = regionBox!.x + regionBox!.width / 2
        const y = regionBox!.y + regionBox!.height / 2
        const probe = await hitAt(x, y)
        if (attempt > 1 || !probe.inToggle) {
          notes.push(
            `第 ${attempt} 次：命中 ${probe.hit}${probe.inToggle ? '（在卡头按钮内）' : '（**不在卡头按钮内**）'}`
            + ` @(${x.toFixed(1)},${y.toFixed(1)})，等待稳定 ${String(waitedMs)}ms；命中链 ${probe.chain}`,
          )
        }
        if (!probe.inToggle) continue
        await page.mouse.click(x, y)
        // 点击后立刻核对状态；展开态可能晚一两帧到（300ms 内没到再补看一次），
        // 真没生效就当作「坐标/状态竞态」重测重点（每次尝试都记进取证）。
        await page.waitForTimeout(300)
        let expanded = await toggle.getAttribute('aria-expanded')
        if (expanded !== 'true') {
          await page.waitForTimeout(500)
          expanded = await toggle.getAttribute('aria-expanded')
        }
        const bodyRows = await page.locator('[data-main-agent-chat] [data-chat-flow-kind]').count()
        if (expanded === 'true') {
          return { label, hit: probe.hit, expanded, bodyRows, attempts: attempt, notes }
        }
        notes.push(
          `第 ${attempt} 次：命中 ${probe.hit}（在卡头按钮内）但点击后 aria-expanded=${String(expanded)}`
          + ` @(${x.toFixed(1)},${y.toFixed(1)})——视为未生效，重测坐标再点`,
        )
      }
      const box = await headBox()
      if (box.width < 40 || box.height < 8) {
        notes.push(`兜底前卡头框已退化：${box.width.toFixed(1)}×${box.height.toFixed(1)}px（列布局未就绪）`)
      }
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      const fallback = await hitAt(x, y)
      await page.mouse.click(x, y)
      await page.waitForTimeout(300)
      notes.push(`兜底点击：命中 ${fallback.hit} @(${x.toFixed(1)},${y.toFixed(1)})；命中链 ${fallback.chain}`)
      return {
        label,
        hit: fallback.hit,
        expanded: await toggle.getAttribute('aria-expanded'),
        bodyRows: await page.locator('[data-main-agent-chat] [data-chat-flow-kind]').count(),
        attempts: 4,
        notes,
      }
    }

    const regions: readonly (readonly [string, string | null])[] = [
      ['整条卡头（空白处）', null],
      ['头像 M', '[data-tl-main-agent-avatar]'],
      ['标题「主代理」', '[data-tl-main-agent-title]'],
      ['状态 chip', '[data-tl-main-agent-status]'],
      ['折叠箭头', '[data-tl-main-agent-chevron]'],
    ]
    const evidence: string[] = []
    const tail: string[] = []
    /** 取证文件**每点一次就落盘一次**：失败也留下现场（断言抛错前先 flush）。 */
    const flush = (): void => {
      writeFileSync(
        join(REPO_ROOT, 'e2e', '.artifacts', 'main-agent-card-head-click.txt'),
        [
          '# M11 主代理卡片「点击展开」取证（真机）',
          `时间：${new Date().toISOString()}`,
          '',
          '## 页面元素体检（多运行视图/不可见卡头会让「先量后点」量到错的元素）',
          ...layoutLines,
          '',
          '## 卡头坐标漂移采样（2.5s × 100ms；y 是卡头在 viewport 里的位置）',
          '判据：位移极差 = 0 ⇒ 卡头静止（按测量坐标点击必然生效）；> 0 ⇒ 卡头还在被上方',
          'step 面板的增长推着走，「先量后点」会落到别的元素上（真机失败信息里命中的',
          '`div.stepChatColumn` 就是上方 step 面板的列容器）。',
          ...driftLedger,
          `位移极差（y）= ${driftRange.toFixed(1)}px`,
          '',
          '## 逐区域点击（每次都从折叠态起步；点击前先等卡头停住，并核对命中确实落在卡头按钮内）',
          'hit = 点击坐标下 `elementFromPoint` 的真实元素；命中链 = `elementsFromPoint` 前 4 层。',
          ...evidence,
          '',
          ...tail,
          `## mock 日志片段：${dsh.logSince(mark).slice(-200).replace(/\n/g, ' | ')}`,
          '',
        ].join('\n'),
        'utf8',
      )
    }
    for (const [label, selector] of regions) {
      // 每次从**折叠态**起步：先确保折叠（点一下卡头）。
      if (await toggle.getAttribute('aria-expanded') === 'true') {
        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      }
      const observed = await probeHit(label, selector)
      evidence.push(
        `- 点击「${label}」→ 命中 ${observed.hit}；aria-expanded=${String(observed.expanded)}；`
        + `卡体行数=${String(observed.bodyRows)}；尝试次数=${String(observed.attempts)}`,
      )
      for (const note of observed.notes) evidence.push(`  · ${note}`)
      // 断言之前先落盘：失败现场必须有命中元素/尝试记录可查。
      flush()
      // 失败信息自带诊断（不是只说「应展开」）：命中元素 + 尝试次数 + 每次的命中链 +
      // 页面元素体检 + 卡头框——真机复现时不必再猜「到底被谁挡住了/坐标错在哪」。
      const finalBox = JSON.stringify(await headBox())
      expect(
        observed.expanded,
        `点击「${label}」应展开（真机命中：${observed.hit}；尝试 ${String(observed.attempts)} 次）`
        + `\n  页面元素体检：${layoutLines[0] ?? '（无）'}`
        + `\n  卡头框：${finalBox}`
        + (observed.notes.length === 0 ? '' : `\n  诊断：\n    ${observed.notes.join('\n    ')}`),
      ).toBe('true')
      expect(observed.bodyRows, `点击「${label}」后卡体应有消息行（命中：${observed.hit}）`).toBeGreaterThan(0)
      // 卡体里必须有主代理的消息文本（不只是元素存在）。
      await expect(page.locator('[data-main-agent-chat]').first()).toContainText('mock-ok', { timeout: 30_000 })
    }

    // 最后一次点击后**等 >3 秒**：展开必须保持住（手动优先，无自动折叠竞态）。
    await page.waitForTimeout(3_500)
    const keptOpen = await toggle.getAttribute('aria-expanded')
    tail.push(`## 展开保持：最后一次点击后等 3.5s → aria-expanded=${String(keptOpen)}（必须 true = 手动优先生效）`)
    flush()
    expect(
      keptOpen,
      '手动展开后 >3s 仍应保持展开（自动折叠计时已被取消）',
    ).toBe('true')
    await expect(page.locator('[data-main-agent-chat]').first()).toContainText('mock-ok')

    // 折叠 → 复核手动折叠仍然好用（自动逻辑未被破坏）。
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    tail.push('## 之后手动折叠一次 → aria-expanded=false（手动折叠仍可用）')
    flush()
  })
})
