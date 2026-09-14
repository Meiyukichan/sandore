/**
 * M18 · 三个工具的调用行里内嵌**工作流导航 UI**（用户需求）。
 *
 * ## 用户原话
 * > 「dsh 默认的 workflow 工具，调用起来后会有一个 UI，一种类似于目录树的 UI……我希望
 * >  run / 暂停和 continue 工作流这三个工具，除了现在默认的返回外，还要有 UI，就直接用
 * >  工作流导航的，风格和 dsh 默认的 workflow 一致」
 *
 * ## 本用例（真机、mock LLM）
 * 1. UI 建实例 → 引擎的**启动注入**让主代理真的调用 `sandore_workflow_run`
 *    → 工具行里除默认文本结果外，出现导航卡片（`[data-sandore-tool-nav]`，`run`）；
 * 2. 往主代理会话投一条带 `[[e2e-mock once=1 tool=sandore_workflow_control
 *    toolargs={"action":"pause"}]]` 的消息 → 主代理调用 control(pause)
 *    → 出现 `control` 卡片且动作 chip=暂停、状态点/状态属性反映 `paused`；
 * 3. 同样再来一条 `action:"continue"` → 出现 `control` 卡片、动作 chip=继续、状态回到推进中；
 * 4. 折叠：整条读头可点，折叠后卡体从 DOM 消失、再点回来（进度读数留在读头里）；
 * 5. 默认文本结果**照旧**（需求明说「除了现在默认的返回外」）。
 *
 * 取证落盘：`e2e/.artifacts/orchestration-tool-view.txt`（每张卡片的锚点/状态/树节点文本）。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT, expect, getInstanceState, mockDirective, test } from './fixtures/harness.ts'
import { openHostSessionInColumn } from './fixtures/host-session.ts'
import { createMockInstance } from './fixtures/mock-run.ts'

/** 强制主代理调用某个 sandore 工具的消息文本（`once=1`：指令出现即照办一次）。 */
function forceToolMessage(tool: string, args: Record<string, unknown>): string {
  return `请照做：${mockDirective({ once: 1, tool, toolargs: JSON.stringify(args) })}`
}

test.describe('M18 工具行内嵌工作流导航', () => {
  test('run / pause / continue 三个工具行都渲染导航 UI，且随实例推进刷新', async ({ page, dsh, workspace }) => {
    test.setTimeout(300_000)
    const instance = await createMockInstance(page, {
      // 长 hold：实例保持 running，供 pause/continue 有真实状态可切。
      promptText: `M18 用例。${mockDirective({ text: 'm18-step-answer', hold: 120_000 })}`,
      cwd: workspace,
      label: 'e2e-m18',
    })

    // ① run 工具行：默认结果仍在 + 导航卡片出现。
    // 主代理卡片默认自动折叠（消息停更 3s）→ 先把卡体展开，工具行才在 DOM 里。
    const cardToggle = page.locator('[data-tl-main-agent-toggle]').first()
    await expect(cardToggle, '主代理卡片应出现').toBeVisible({ timeout: 90_000 })
    const expandCard = async (): Promise<void> => {
      if (await page.locator('[data-main-agent-chat]').count() === 0) {
        await cardToggle.click()
      }
      await expect(page.locator('[data-main-agent-chat]').first()).toBeVisible({ timeout: 30_000 })
      // 工具行落在 turn-process 折叠组里（成员行默认 `hidden="until-found"` → 不占布局、
      // 不可见）：把组里的折叠开关全部展开，工具行与内嵌导航才会显示出来。
      for (let round = 0; round < 8; round += 1) {
        const collapsed = page.locator(
          '[data-main-agent-chat] [data-chat-flow-kind="turn-process"] button[aria-expanded="false"]',
        )
        if (await collapsed.count() === 0) break
        await collapsed.first().click({ timeout: 5_000 }).catch(() => {})
        await page.waitForTimeout(150)
      }
    }
    await expandCard()
    const card = page.locator('[data-main-agent-chat]').first()
    const runCard = card.locator('[data-sandore-tool-nav][data-orchestration-tool="run"]').first()
    await expect(runCard, 'run 工具行里应出现工作流导航卡片（启动注入 → 主代理调用 run）')
      .toBeVisible({ timeout: 90_000 })
    await expect(runCard).toHaveAttribute('data-orchestration-instance', instance.instanceId)
    await expect(runCard).toHaveAttribute('data-orchestration-instance-source', 'result')
    // 默认文本结果（工具调用行）仍在。
    await expect(card.getByText('sandore_workflow_run', { exact: false }).first()).toBeVisible()
    // 树：阶段/步骤节点渲染出来（复用 TreeNav；compact 变体）。
    const runNav = runCard.locator('[data-sandore-tree-nav]')
    await expect(runNav, '导航卡体里应是复用的工作流导航（TreeNav）').toBeVisible({ timeout: 30_000 })
    // 同一个 `<nav>` 上还挂着紧凑态标记（省掉自身标题栏，行高/缩进不变）。
    await expect(runNav).toHaveAttribute('data-tree-nav-compact', 'true')
    // 用户真机缺陷：读头已写工作流名，树里不得再出现同名根行（重复节点）。
    const panelHeadTitle = (await runCard.locator('[data-orchestration-title]').first().textContent()) ?? ''
    const panelTreeRowTexts = await runNav.locator('[data-disclosure-row]').allTextContents()
    expect(
      panelTreeRowTexts.map(text => text.replace(/\s+/g, ' ').trim()).filter(text => text === panelHeadTitle),
      `树里不得出现与读头同名的工作流根行：${panelTreeRowTexts.join(' | ')}`,
    ).toEqual([])
    await expect(runNav.locator('[data-tree-workflow-children]')).toHaveCount(1)
    await expect.poll(async () => runCard.locator('[data-orchestration-progress]').first().textContent(), {
      timeout: 30_000,
      message: '读头应有进度读数（x/y 步）',
    }).toMatch(/\d+\/\d+ 步/u)
    // 状态属性反映实例状态（running/paused 之间切换；终态也可能出现）。
    const runStatus = await runCard.getAttribute('data-orchestration-status')
    expect(['running', 'paused', 'completed', 'failed', 'aborted']).toContain(String(runStatus))

    // ② 折叠：整条读头可点，卡体消失/回来。
    const toggle = runCard.locator('[data-orchestration-toggle]').first()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(runCard.locator('[data-orchestration-body]')).toHaveCount(0)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(runCard.locator('[data-orchestration-body]')).toHaveCount(1)

    /** 往主代理会话投一条消息（驱动它调用某个 sandore 工具）。 */
    const sendToMainAgent = async (message: string): Promise<void> => {
      const disc = page.locator('[data-sandore-disc-input]').first()
      const surface = disc.locator('[data-main-agent-input]').first()
      await expect(surface).toBeEnabled({ timeout: 30_000 })
      await surface.fill(message)
      await disc.locator('[data-main-agent-send]').first().click()
    }

    // ③ pause：control 工具行出现且反映暂停态。
    await sendToMainAgent(forceToolMessage('sandore_workflow_control', { action: 'pause' }))
    const pauseCard = card.locator('[data-sandore-tool-nav][data-orchestration-tool="control"][data-orchestration-action="pause"]').first()
    await expect(async () => {
      await expandCard()
      expect(await pauseCard.count(), 'control(pause) 工具行里应出现导航卡片').toBeGreaterThan(0)
    }).toPass({ timeout: 90_000 })
    await expect(pauseCard).toHaveAttribute('data-orchestration-instance', instance.instanceId)
    await expect(pauseCard.locator('[data-orchestration-action-chip]')).toHaveText('暂停')
    // 状态随实例推进刷新（不需要刷新页面）：实例真的 paused。
    await expect.poll(async () => (await getInstanceState(page, instance.instanceId)).status, { timeout: 60_000 })
      .toBe('paused')
    await expect(pauseCard, '导航卡片应反映实例已暂停').toHaveAttribute('data-orchestration-status', 'paused', { timeout: 60_000 })

    // ④ continue：再来一张 control 卡片，状态回到推进中。
    await sendToMainAgent(forceToolMessage('sandore_workflow_control', { action: 'continue' }))
    const continueCard = card.locator('[data-sandore-tool-nav][data-orchestration-tool="control"][data-orchestration-action="continue"]').first()
    await expect(async () => {
      await expandCard()
      expect(await continueCard.count(), 'control(continue) 工具行里应出现导航卡片').toBeGreaterThan(0)
    }).toPass({ timeout: 90_000 })
    await expect(continueCard.locator('[data-orchestration-action-chip]')).toHaveText('继续')
    await expect.poll(async () => (await getInstanceState(page, instance.instanceId)).status, { timeout: 60_000 })
      .not.toBe('paused')
    await expect(continueCard, '恢复后导航卡片状态应回到推进中').toHaveAttribute('data-orchestration-status', 'running', { timeout: 60_000 })

    // ⑤ 取证：每张卡片的锚点 + 树节点文本（逐卡 dump）。
    const dump = await page.evaluate(() => {
      const root = document.querySelector('[data-main-agent-chat]')
      if (root === null) return []
      return [...root.querySelectorAll('[data-sandore-tool-nav]')].map((el, index) => {
        const tree = el.querySelector('[data-sandore-tree-nav]')
        return {
          index,
          tool: el.getAttribute('data-orchestration-tool'),
          instance: el.getAttribute('data-orchestration-instance'),
          status: el.getAttribute('data-orchestration-status'),
          action: el.getAttribute('data-orchestration-action'),
          source: el.getAttribute('data-orchestration-instance-source'),
          progress: el.querySelector('[data-orchestration-progress]')?.textContent ?? null,
          expanded: el.querySelector('[data-orchestration-toggle]')?.getAttribute('aria-expanded') ?? null,
          treeNodes: tree === null
            ? []
            // 树行锚点：DSH DisclosureRow 的 `[data-disclosure-row]`（workflow/stage/step 行）
            // + 叶子行 `[data-tree-leaf]`。**不按 CSS module 类名数**（类名是哈希的）。
            : [...tree.querySelectorAll('[data-disclosure-row], [data-tree-leaf]')].length,
          treeText: (tree?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 200),
        }
      })
    })
    writeFileSync(
      join(REPO_ROOT, 'e2e', '.artifacts', 'orchestration-tool-view.txt'),
      [
        '# M18 工具行内嵌工作流导航（真机取证）',
        `时间：${new Date().toISOString()}`,
        `实例：${instance.instanceId}`,
        '',
        '## 卡片（`[data-main-agent-chat] [data-sandore-tool-nav]`）',
        ...dump.map(entry =>
          `[${String(entry.index)}] tool=${String(entry.tool)} instance=${String(entry.instance)}`
          + ` status=${String(entry.status)} action=${String(entry.action)} source=${String(entry.source)}`
          + ` 进度=${String(entry.progress)} expanded=${String(entry.expanded)} 树节点数=${String(entry.treeNodes)}`
          + `\n    树文本：${entry.treeText}`),
        '',
        `## mock 日志片段：${dsh.logTail().slice(-300).replace(/\n/g, ' | ')}`,
        '',
      ].join('\n'),
      'utf8',
    )

    // 断言取证面：三张卡片都在（run + pause + continue）。
    const tools = dump.map(entry => `${String(entry.tool)}:${String(entry.action)}`)
    expect(tools, `应有 run 卡片与 pause/continue 两张 control 卡片：${tools.join(', ')}`)
      .toEqual(expect.arrayContaining(['run:null', 'control:pause', 'control:continue']))
    for (const entry of dump) {
      expect(entry.instance, `卡片 ${String(entry.index)} 应绑定本实例`).toBe(instance.instanceId)
      expect(entry.treeNodes, `卡片 ${String(entry.index)} 的树应有节点`).toBeGreaterThan(0)
    }
  })

  test('主代理会话页（DSH 原生工具行）里同样渲染导航 UI，且 pause/continue 状态联动', async ({ page, dsh, problems, workspace }) => {
    test.setTimeout(300_000)
    const instance = await createMockInstance(page, {
      // 长 hold（10 分钟）：DSH 会话页要开窗、展开折叠、再跑 pause/continue，窗口必须够长。
      promptText: `M18 主代理会话页用例。${mockDirective({ text: 'm18-dsh-answer', hold: 600_000 })}`,
      cwd: workspace,
      label: 'e2e-m18-dsh',
    })

    /** 往主代理会话投一条消息（驱动它调用某个 sandore 工具）。 */
    const sendToMainAgent = async (message: string): Promise<void> => {
      const disc = page.locator('[data-sandore-disc-input]').first()
      const surface = disc.locator('[data-main-agent-input]').first()
      await expect(surface).toBeEnabled({ timeout: 30_000 })
      await surface.fill(message)
      await disc.locator('[data-main-agent-send]').first().click()
    }

    /** 往**主代理会话**（本用例此刻中心列就是它）投一条消息：DSH 自己的输入框 + Enter。 */
    const sendToMainAgentInDsh = async (message: string): Promise<void> => {
      const composer = page.locator('[data-composer-input]').first()
      await expect(composer, 'DSH 主代理会话输入框应存在').toHaveCount(1, { timeout: 30_000 })
      // 直接 focus（不经命中测试：中心列上方可能有 overlay 层，点会被拦）。
      await composer.evaluate((el) => { (el as HTMLElement).focus() })
      await page.keyboard.type(message)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(500)
    }

    // ① 在 **DSH 中心列**打开主代理会话（宿主会话；标题 = 建实例时的 requirement）。
    await openHostSessionInColumn(page, instance.requirement)
    const dshColumn = page.locator('[data-composer-input]')
      .filter({ hasNot: page.locator('[data-sandore-seat-view]') })
      .first()
      .locator('xpath=ancestor::*[contains(@class,"column") or @data-conversation-column][1]')
    // DSH 会话页自己的轮次折叠：工具行是 `div.flowItem[hidden="until-found"]`（折叠的进程组成员
    // 行，诊断见 `orchestration-tool-view-dsh-visibility.txt`）→ 必须把该轮的进程折叠展开，
    // 工具行才会真正可见。这里点的是 **DSH 原生**的折叠开关（一律排除 sandore 面板子树）。
    // DSH 的折叠开关不一定带 `aria-expanded`（实测是「N 次工具调用」这样的按钮），
    // 故按**可访问名**点，且每个开关只点一次（避免把已展开的点回去）。
    const expandDshFolds = async (): Promise<void> => {
      const folds = page.locator('button:not([data-sandore-seat-view] *)')
        .filter({ hasText: /次工具调用|已思考|次推理|思考中/ })
      const count = await folds.count()
      for (let index = 0; index < count; index += 1) {
        const fold = folds.nth(index)
        if (!(await fold.isVisible().catch(() => false))) continue
        await fold.click({ timeout: 5_000 }).catch(() => {})
        await page.waitForTimeout(150)
      }
    }
    await expandDshFolds()
    // 该会话页里的工具行卡片（DSH 的 tool.call.toolview 槽 → 我们注册的视图）。
    // 用 CSS 排除 sandore 面板（`[data-sandore-seat-view]` 子树）里的同名卡片。
    const dshRunCard = page.locator(
      '[data-sandore-tool-nav][data-orchestration-tool="run"]:not([data-sandore-seat-view] *)',
    ).first()
    // 诊断（无论成败都落盘）：卡在 DSH 会话页里的**祖先链**与各自 display/visibility/hidden，
    // 用来判「为什么它是 hidden」——DSH 折叠组、非激活列、还是我们自己的样式。
    const visibilityDiagnostic = await page.evaluate(() => {
      const el = document.querySelector(
        '[data-sandore-tool-nav][data-orchestration-tool="run"]:not([data-sandore-seat-view] *)',
      )
      if (el === null) return ['（DSH 会话页里没找到 run 卡）']
      const lines: string[] = []
      let node: Element | null = el
      for (let depth = 0; node !== null && depth < 14; depth += 1) {
        const style = getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        lines.push(
          `${'  '.repeat(depth)}${node.tagName.toLowerCase()}`
          + ` cls=${String(node.className).slice(0, 48)}`
          + ` display=${style.display} visibility=${style.visibility}`
          + ` hidden=${node.getAttribute('hidden') ?? '-'}`
          + ` aria-expanded=${node.getAttribute('aria-expanded') ?? '-'}`
          + ` rect=${Math.round(rect.width)}x${Math.round(rect.height)}`,
        )
        node = node.parentElement
      }
      return lines
    })
    writeFileSync(
      join(REPO_ROOT, 'e2e', '.artifacts', 'orchestration-tool-view-dsh-visibility.txt'),
      [
        '# DSH 会话页 run 卡的祖先链（为什么 hidden）',
        `时间：${new Date().toISOString()}`,
        ...visibilityDiagnostic,
        '',
      ].join('\n'),
      'utf8',
    )
    await expect(dshRunCard, 'DSH 主代理会话页的工具行里应出现导航卡（tool.call.toolview 注册）')
      .toBeVisible({ timeout: 90_000 })
    await expect(dshRunCard).toHaveAttribute('data-orchestration-instance', instance.instanceId)
    // 默认结果行仍在（命中 key 会替换通用卡片，故由我们的视图自带）。
    await expect(
      page.locator('[data-tool="sandore_workflow_run"]:not([data-sandore-seat-view] *)').first(),
    ).toBeVisible()
    // 树 + 进度读数。
    const dshNav = dshRunCard.locator('[data-sandore-tree-nav]')
    await expect(dshNav, 'DSH 会话页的卡体里应是复用的工作流导航').toBeVisible({ timeout: 30_000 })
    await expect(dshRunCard.locator('[data-orchestration-progress]').first()).toHaveText(/\d+\/\d+ 步/u)
    await expect.poll(async () => dshNav.locator('[data-disclosure-row], [data-tree-leaf]').count(), {
      timeout: 30_000,
      message: '导航树应有阶段/步骤节点',
    }).toBeGreaterThan(0)
    // 用户真机缺陷：读头已写工作流名（+ 状态 + 进度），树里**不得**再出现同名根行
    // （展开后第一个根节点又叫 `test-workflow` 那种重复）。
    const dshHeadTitle = (await dshRunCard.locator('[data-orchestration-title]').first().textContent()) ?? ''
    expect(dshHeadTitle.length, '读头应有工作流名').toBeGreaterThan(0)
    const dshTreeRowTexts = await dshNav.locator('[data-disclosure-row]').allTextContents()
    expect(
      dshTreeRowTexts.map(text => text.replace(/\s+/g, ' ').trim()).filter(text => text === dshHeadTitle),
      `树里不得出现与读头同名的工作流根行：${dshTreeRowTexts.join(' | ')}`,
    ).toEqual([])
    // 根行已换成它原本给 Stage 行用的容器（缩进/留白保持不变）。
    await expect(dshNav.locator('[data-tree-workflow-children]')).toHaveCount(1)

    // ①b 顶部间距（真机反馈：「树的第一行离读头/卡片体太远」）：
    //     量「读头底 → 第一条 stage 行顶」的距离，并**同一次运行里**先复现改前的三层
    //     顶部留白（内联样式覆盖，只作用于紧凑路径，不改任何源码）量一份 before，
    //     再撤掉覆盖量 after —— 两个数字都来自同一台真机、同一张卡片。
    /** 量一次「读头底 → 第一条 stage 行顶」。 */
    const measureGap = async (): Promise<{ gap: number; headBottom: number; firstRowTop: number; bodyTop: number | null }> =>
      page.evaluate(() => {
        const card = document.querySelector(
          '[data-sandore-tool-nav][data-orchestration-tool="run"]:not([data-sandore-seat-view] *)',
        )
        const head = card?.querySelector('[data-orchestration-toggle]')
        const firstRow = card?.querySelector('[data-tree-workflow-children] [data-disclosure-row]')
        if (card === null || card === undefined || head === null || head === undefined
          || firstRow === null || firstRow === undefined) return null
        const headBox = head.getBoundingClientRect()
        const rowBox = firstRow.getBoundingClientRect()
        const bodyBox = card.querySelector('[data-orchestration-body]')?.getBoundingClientRect()
        return {
          headBottom: Math.round(headBox.bottom),
          bodyTop: bodyBox === undefined ? null : Math.round(bodyBox.top),
          firstRowTop: Math.round(rowBox.top),
          gap: Math.round(rowBox.top - headBox.bottom),
        }
      }).then(result => {
        expect(result, '应能量到卡片头部与第一条 stage 行').not.toBeNull()
        return result!
      })
    // 「改前」= 复原三层顶部留白（卡片 navSlot 4px + 树身紧凑态 6px + stage 列表 4px）。
    const BEFORE_STYLE_ID = 'm18-spacing-before'
    await page.evaluate((id: string) => {
      const style = document.createElement('style')
      style.id = id
      // 只压紧凑路径的顶部三层。注意类名形如 `sx2gdm_navSlot`（前缀哈希 + 原名，
      // 原名两侧**没有**下划线）——用 `[class*="navSlot"]` 这类子串选择器命中。
      style.textContent = [
        '[class*="navSlot"] { padding: 4px 0 6px !important; }',
        '[class*="bodyCompact"] { padding: 6px 6px 8px !important; }',
        '[class*="bodyCompact"] [class*="stageList"] { padding-top: 4px !important; }',
      ].join('\n')
      document.head.appendChild(style)
    }, BEFORE_STYLE_ID)
    await page.waitForTimeout(120)
    const spacingBefore = await measureGap()
    // 诊断：把三层的实际类名与 computed padding 一起记下来（若覆盖没生效，一眼能看出）。
    const spacingDebug = await page.evaluate(() => {
      const card = document.querySelector(
        '[data-sandore-tool-nav][data-orchestration-tool="run"]:not([data-sandore-seat-view] *)',
      )
      const navSlot = card?.querySelector('[class*="navSlot"]') ?? card?.querySelector('[data-orchestration-nav]')
      const body = card?.querySelector('[class*="bodyCompact"]')
      const stageList = card?.querySelector('[class*="stageList"]')
      const describe = (el: Element | null | undefined): string => el === null || el === undefined
        ? '（无）'
        : `${el.tagName.toLowerCase()}.${String(el.className)} pad=${getComputedStyle(el).padding}`
      return [describe(navSlot), describe(body), describe(stageList)]
    })
    await page.evaluate((id: string) => { document.getElementById(id)?.remove() }, BEFORE_STYLE_ID)
    await page.waitForTimeout(120)
    const spacingAfter = await measureGap()
    writeFileSync(
      join(REPO_ROOT, 'e2e', '.artifacts', 'orchestration-tool-view-spacing.txt'),
      [
        '# 工具行内嵌工作流导航：顶部间距取证（真机，同一次运行 before/after）',
        `时间：${new Date().toISOString()}`,
        `实例：${instance.instanceId}`,
        '',
        '量点：`[data-sandore-tool-nav]` 卡片的读头（`[data-orchestration-toggle]`）底缘',
        '      → `[data-tree-workflow-children]` 内第一条 stage 行（`[data-disclosure-row]`）顶缘。',
        '',
        `**改前（复原三层顶部留白：卡片 navSlot 4px + 树身紧凑态 6px + stage 列表 4px）：`
        + `间距 = ${String(spacingBefore.gap)}px**`
        + `（读头底 y=${String(spacingBefore.headBottom)}、卡体顶 y=${String(spacingBefore.bodyTop)}、`
        + `第一行顶 y=${String(spacingBefore.firstRowTop)}）`,
        `**改后（当前实现：卡片 navSlot 2px，树身紧凑态顶部 0、stage 列表顶部 0）：`
        + `间距 = ${String(spacingAfter.gap)}px**`
        + `（读头底 y=${String(spacingAfter.headBottom)}、卡体顶 y=${String(spacingAfter.bodyTop)}、`
        + `第一行顶 y=${String(spacingAfter.firstRowTop)}）`,
        '',
        `断言：改后间距 ≤ 8px（实测 ${String(spacingAfter.gap)}px）。`,
        `覆盖诊断（改前状态下的三层实测）：${spacingDebug.join(' | ')}`,
        '未动的部分：行高（stage 32px / step 24px）、缩进（padding-left 16px）、状态点与 chevron 对齐、',
        '叶子行样式；运行页（非紧凑）左栏树与 DSH 原生页不受影响（覆盖只落在紧凑路径的顶部留白）。',
        '',
      ].join('\n'),
      'utf8',
    )
    expect(spacingAfter.gap, `读头到第一条 stage 行的间距应 ≤ 8px（实测 ${String(spacingAfter.gap)}px）`)
      .toBeLessThanOrEqual(8)
    expect(spacingBefore.gap, '改前应明显更大（证明这次确实收紧了）').toBeGreaterThan(spacingAfter.gap)

    // ② 折叠可开合。
    const dshToggle = dshRunCard.locator('[data-orchestration-toggle]').first()
    await expect(dshToggle).toHaveAttribute('aria-expanded', 'true')
    await dshToggle.click()
    await expect(dshToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(dshRunCard.locator('[data-orchestration-body]')).toHaveCount(0)
    await dshToggle.click()
    await expect(dshRunCard.locator('[data-orchestration-body]')).toHaveCount(1)

    // ③ pause：DSH 会话页里的 control 卡片出现且状态联动为 paused。
    await sendToMainAgentInDsh(forceToolMessage('sandore_workflow_control', { action: 'pause' }))
    const dshPauseCard = page.locator(
      '[data-sandore-tool-nav][data-orchestration-tool="control"][data-orchestration-action="pause"]:not([data-sandore-seat-view] *)',
    ).first()
    await expect(async () => {
      // 新工具行又落进新的一轮折叠组里 → 每轮先展开 DSH 的 disclosure 再断言。
      await expandDshFolds()
      expect(await dshPauseCard.count(), 'DSH 会话页应出现 control(pause) 导航卡').toBeGreaterThan(0)
    }).toPass({ timeout: 90_000 })
    await expect.poll(async () => (await getInstanceState(page, instance.instanceId)).status, { timeout: 60_000 })
      .toBe('paused')
    await expect(dshPauseCard).toHaveAttribute('data-orchestration-status', 'paused', { timeout: 60_000 })
    await expect(dshPauseCard.locator('[data-orchestration-action-chip]')).toHaveText('暂停')

    // ④ continue：回到推进中。
    await sendToMainAgentInDsh(forceToolMessage('sandore_workflow_control', { action: 'continue' }))
    const dshContinueCard = page.locator(
      '[data-sandore-tool-nav][data-orchestration-tool="control"][data-orchestration-action="continue"]:not([data-sandore-seat-view] *)',
    ).first()
    await expect(async () => {
      await expandDshFolds()
      expect(await dshContinueCard.count(), 'DSH 会话页应出现 control(continue) 导航卡').toBeGreaterThan(0)
    }).toPass({ timeout: 90_000 })
    await expect(dshContinueCard).toHaveAttribute('data-orchestration-status', 'running', { timeout: 90_000 })

    // ⑤ 取证：DSH 会话页内每张卡片 + 该页是否有 seat-view（确保取的不是 sandore 面板那条）。
    const dshDump = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-sandore-tool-nav]')]
      return cards.map((el, index) => {
        const tree = el.querySelector('[data-sandore-tree-nav]')
        return {
          index,
          inSeatView: el.closest('[data-sandore-seat-view]') !== null,
          inMainAgentCard: el.closest('[data-main-agent-chat]') !== null,
          tool: el.getAttribute('data-orchestration-tool'),
          instance: el.getAttribute('data-orchestration-instance'),
          status: el.getAttribute('data-orchestration-status'),
          action: el.getAttribute('data-orchestration-action'),
          source: el.getAttribute('data-orchestration-instance-source'),
          progress: el.querySelector('[data-orchestration-progress]')?.textContent ?? null,
          treeNodes: tree === null ? 0 : tree.querySelectorAll('[data-disclosure-row], [data-tree-leaf]').length,
          treeText: (tree?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 160),
        }
      })
    })
    writeFileSync(
      join(REPO_ROOT, 'e2e', '.artifacts', 'orchestration-tool-view-dsh-session.txt'),
      [
        '# M18 主代理会话页（DSH 原生工具行）内嵌工作流导航（真机取证）',
        `时间：${new Date().toISOString()}`,
        `实例：${instance.instanceId}`,
        '',
        '## 页面上所有导航卡（inSeatView=sandore 面板内；inMainAgentCard=运行页主代理卡片内）',
        ...dshDump.map(entry =>
          `[${String(entry.index)}] tool=${String(entry.tool)} instance=${String(entry.instance)}`
          + ` status=${String(entry.status)} action=${String(entry.action)} source=${String(entry.source)}`
          + ` 进度=${String(entry.progress)} 树节点数=${String(entry.treeNodes)}`
          + ` inSeatView=${String(entry.inSeatView)} inMainAgentCard=${String(entry.inMainAgentCard)}`
          + `\n    树文本：${entry.treeText}`),
        '',
        `## DSH 会话页可见（非 sandore 面板/非主代理卡内的那几张 = DSH 原生工具行）`,
        `console/pageerror problems：${problems.length === 0 ? '无' : problems.join(' | ')}`,
        '',
      ].join('\n'),
      'utf8',
    )

    // 断言：DSH 原生工具行（既不在 seat-view 也不在主代理卡片里）确实有我们的卡。
    const nativeCards = dshDump.filter(entry => !entry.inSeatView && !entry.inMainAgentCard)
    expect(
      nativeCards.map(entry => `${String(entry.tool)}:${String(entry.action)}`),
      `DSH 原生工具行应有 run + pause + continue 三张卡：\n${JSON.stringify(dshDump, null, 2)}`,
    ).toEqual(expect.arrayContaining(['run:null', 'control:pause', 'control:continue']))
    for (const entry of nativeCards) {
      expect(entry.instance, 'DSH 原生卡应绑定本实例').toBe(instance.instanceId)
      expect(entry.treeNodes, 'DSH 原生卡的树应有节点').toBeGreaterThan(0)
    }
    // 不重复渲染：同一工具名在同一处（DSH 会话页）只应有一张 run 卡。
    expect(nativeCards.filter(entry => entry.tool === 'run')).toHaveLength(1)
    // 渲染不破坏 DSH 原有工具行：无 console error / pageerror。
    expect(problems, `页面出现 console error / pageerror：${problems.join(' | ')}`).toEqual([])
  })
})
