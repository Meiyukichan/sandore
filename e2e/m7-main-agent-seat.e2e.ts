/**
 * M7 · **呈现层统一**（用户决策 1/3/4，含三轮真机修正）真实浏览器验收：
 * 独立输入框 / 主代理独立卡片 / 暂停按钮双语义 / 与 DSH 中心列输入框的隔离 / 下拉真功能。
 *
 * 五条断言各自独立、都不做恒真放宽：
 *
 * ## ① 运行页输入框 = **独立输入框**（不挂 DSH 输入壳）
 * - 结构：`[data-sandore-main-input]` 内的原生 `textarea`（`[data-main-agent-input]`）+
 *   `[data-main-agent-send]`；**没有** `[data-composer-input]` / `[data-composer-kernel]` /
 *   `[data-composer-took-root]` / `contenteditable` ⇒ 与 DSH 输入内核无关；
 * - 可输入可发送：打字使发送钮由禁用到可用，点发送后**主代理会话真的被驱动**
 *   （对账：mock 日志里出现 `text="<唯一句柄>"`——句柄只出现在「用户敲进输入框的这条消息」里，
 *   绝不写进需求/定义，避免假通过）；草稿发送后清空；
 * - **草稿独立**：先往 DSH 中心列自己的输入框里敲一串 `DSH-DRAFT-*` 草稿（运行视图此时关闭，
 *   该输入框可见可输入），再打开运行视图 → 运行页输入框**是空的**（不共享、不同步）。
 *
 * ## ② 主代理独立卡片：同级 + 位置 + 「主代理有消息就插入」（真机反馈修正）
 * - **同级**：`[data-tl-main-agent]` 是步骤列表容器（`[data-sandore-timeline]`）的**直接子节点**，
 *   且 `[data-tl-step] [data-tl-main-agent]` 计数为 0（**不是**任何 step 卡片的后代）；
 * - **位置**：紧跟**正在执行**的那张 step 卡片（构造两条 step：第一条短 hold 很快 completed、
 *   第二条长 hold 保持 running ⇒ 必须在 running 那条之后，而不是已完成的后面）；
 * - **出现条件 = 主代理有助手消息**（修正后**不再要求用户先发过消息**）——启动注入让主代理
 *   汇报「工作流已启动…」时就该出现；用户再发一条后仍是**同一张卡片**刷新出新回复
 *   （全局恒为 1 张，见 M8 的三步取证）；
 * - **卡头**：头像字母 `M` + 标题「主代理」（与 step 卡片同一套 class/令牌）。
 * - 现场取证：把步骤列表的子节点顺序与层级 dump 到 `e2e/.artifacts/m7-main-agent-card-dom.txt`。
 *
 * ## ③ 主代理 turn 中止（需求 4；**真机反馈第三轮的入口变更**）
 * - 输入框区的停止按钮已被用户要求删除（真机原话：「还是有个暂停按钮在输入框那里……去掉这个按钮」），
 *   故暂停入口改为 **DSH 中心列输入框自带的「停止生成」**：它取消宿主主代理当前 turn，
 *   引擎据此把实例判为 `paused`（架构决策 6，`workflow-engine.ts` 的 host-turn-abort 分支）；
 * - 先制造「主代理正在跑一个 turn」的现场（发送带 25s `hold` 的消息）；反向对照：回复文本可见；
 * - 关运行视图 → 在中心列打开宿主会话 → 点它的「停止生成」→ 实例 `paused` + SSE
 *   `sandore/step-paused` 恰 1（暂停可达的真机证明）；再回运行视图断言主代理「运行中」状态行
 *   消失（`hold` 未满即收尾 ⇒ turn 被 abort）。
 *
 * ## ④ 与 DSH 中心列输入框的隔离（**取代旧的「根接管 + 归还」断言**）
 * 旧实现会接管 DSH 中心列输入框的编辑器根、卸载时归还；新实现是独立输入框，**全程不碰**：
 * - 打开运行视图前先在中心列敲一串草稿；
 * - 运行视图打开期间：`[data-composer-took-root]` 计数 0；中心列输入框**仍保留那串草稿**
 *   （若根被抢走，文本会从它的 DOM 里消失——这是「没被接管」的直接证据）；
 * - 关闭运行视图后：中心列输入框仍可编辑、草稿还在、还能继续打字。
 *
 * ## ⑤ 下拉是**真功能**（真机反馈：「按钮下拉都要一模一样」且必须真能改东西）
 * - **模型下拉**：触发器在发送钮左侧；菜单里选中第二个模型（`mock-2`）后，
 *   **下一次主代理调用真的用新模型**（对账：同一行 mock 日志里同时出现新模型与那句唯一句柄）；
 * - **权限下拉**：触发器在工具行左侧（DSH `.tools` 位置）；选中 `read-only` 后
 *   ①界面上的访问模式文案跟着变，②引擎侧实例快照 `permission` 真的变成 `read-only`
 *   （DSH `/permission` 命令 + 引擎 `updateInstancePermissionMode` 双通路）。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT, expect, getInstanceState, mockDirective, test, type Page } from './fixtures/harness.ts'
import { dshColumnComposer, openHostSessionInColumn } from './fixtures/host-session.ts'
import { createMockInstance, createMockTwoStepInstance } from './fixtures/mock-run.ts'
import { countOfType, framesOf, readSseFrames } from './fixtures/sse.ts'

/** 唯一句柄（只出现在「用户敲进去的文本」里，绝不写进需求/定义 → 防假通过）。 */
function handleOf(label: string): string {
  return `M7-${label}-${Math.random().toString(36).slice(2, 10)}`
}

/** 打开运行视图（幂等）。 */
async function openRunView(page: Page): Promise<void> {
  const entry = page.locator('[data-sandore-seat-entry]').first()
  if (await entry.getAttribute('aria-expanded') !== 'true') await entry.click()
  await expect(page.locator('[data-sandore-seat-view]').first()).toBeVisible()
  await expect(page.locator('[data-sandore-run-view]').last()).toBeVisible({ timeout: 30_000 })
}

/** 关闭运行视图（RunView 卸载 → 运行页输入框卸载）。 */
async function closeRunView(page: Page): Promise<void> {
  const entry = page.locator('[data-sandore-seat-entry]').first()
  if (await entry.getAttribute('aria-expanded') === 'true') await entry.click()
  await expect(page.locator('[data-sandore-run-view]')).toHaveCount(0)
}

/** 运行页独立输入框（只匹配运行视图内的那个）。 */
function runInput(page: Page) {
  return page.locator('[data-sandore-disc-input] [data-main-agent-input]').first()
}

/** 运行页发送钮。 */
function runSend(page: Page) {
  return page.locator('[data-sandore-disc-input] [data-main-agent-send]').first()
}

/**
 * 现场取证：把步骤列表（`[data-sandore-timeline]`）的直接子节点顺序 + 主代理卡片的层级
 * dump 成文本，供人工核对「它是一张独立卡片而不是塞进 step 里」。
 * @returns 同一份文本（用例内还要按它做位置断言）。
 */
async function dumpTimelineDom(page: Page, label: string): Promise<string> {
  const described = await page.locator('[data-sandore-timeline]').last().evaluate((flow) => {
    const rows = [...flow.children].map((child, index) => {
      const kind = child.hasAttribute('data-tl-main-agent')
        ? 'MAIN-AGENT-CARD'
        : child.hasAttribute('data-tl-step')
          ? 'STEP-CARD'
          : child.hasAttribute('data-tl-user')
            ? 'USER-MSG'
            : child.tagName.toLowerCase()
      return {
        index,
        kind,
        stepChatPanels: child.querySelectorAll('[data-step-chat]').length,
        mainAgentPanels: child.querySelectorAll('[data-main-agent-chat]').length,
        text: (child.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 90),
      }
    })
    const main = flow.querySelector('[data-tl-main-agent]')
    // 卡头取证：头像/标题/textContent + computed style（与 step 卡片同款 class 的证据）。
    const head = main?.querySelector('[data-tl-main-agent-avatar]')
    const title = main?.querySelector('[data-tl-main-agent-title]')
    const stepAvatar = flow.querySelector('[data-tl-step] [class*="avatar"]')
    const pick = (el: Element | null | undefined, keys: readonly string[]): Record<string, string> => {
      if (el === null || el === undefined) return {}
      const style = getComputedStyle(el)
      const out: Record<string, string> = {}
      for (const key of keys) out[key] = style.getPropertyValue(key)
      return out
    }
    return {
      rows,
      mainAgentCardParentIsTimeline: main !== null && main.parentElement === flow,
      mainAgentCardInsideStepCard: flow.querySelector('[data-tl-step] [data-tl-main-agent]') !== null,
      mainAgentCardIndex: [...flow.children].findIndex(child => child.hasAttribute('data-tl-main-agent')),
      mainAgentCardIsLast: main !== null && flow.lastElementChild === main,
      mainAgentCardCollapsed: main?.querySelector('[data-tl-main-agent-toggle]')?.getAttribute('aria-expanded'),
      stepCardIndexes: [...flow.children]
        .map((child, index) => (child.hasAttribute('data-tl-step') ? index : -1))
        .filter(index => index >= 0),
      cardHead: {
        avatarText: head?.textContent ?? null,
        avatarClass: head?.className ?? null,
        avatarStyle: pick(head, ['width', 'height', 'border-radius', 'background-color', 'color', 'font-size', 'font-weight', 'display', 'align-items', 'justify-content']),
        titleText: title?.textContent ?? null,
        titleClass: title?.className ?? null,
        titleStyle: pick(title, ['font-size', 'font-weight', 'color']),
        stepAvatarClass: stepAvatar?.className ?? null,
        stepAvatarStyle: pick(stepAvatar, ['width', 'height', 'border-radius', 'background-color', 'color', 'font-size', 'font-weight']),
      },
    }
  })
  const text = [
    `# M7 主代理卡片 DOM 取证（${label}）`,
    `时间：${new Date().toISOString()}`,
    '',
    '## 判定',
    `- 主代理卡片的父节点 === 步骤列表容器：[data-sandore-timeline] → ${String(described.mainAgentCardParentIsTimeline)}（true 才说明它是**同级独立卡片**）`,
    `- 主代理卡片出现在任何 step 卡片内部：${String(described.mainAgentCardInsideStepCard)}（必须 false）`,
    `- 主代理卡片在列表中的下标：${String(described.mainAgentCardIndex)}`,
    `- 主代理卡片是否在步骤列表最后一张：${String(described.mainAgentCardIsLast)}（true = 真机反馈要求的「固定最下面」）`,
    `- 主代理卡片折叠态（aria-expanded）：${String(described.mainAgentCardCollapsed)}（有新消息时应为 true）`,
    `- step 卡片在列表中的下标：${JSON.stringify(described.stepCardIndexes)}`,
    '',
    '## 卡头取证（头像 = 字母 M + 标题 =「主代理」，与 step 卡片同一套 class/令牌）',
    `- 头像文本：${String(described.cardHead.avatarText)}（应为 M）`,
    `- 头像 class（与 step 卡片头像比较）：主代理 ${String(described.cardHead.avatarClass)} / step ${String(described.cardHead.stepAvatarClass)}`,
    `- 头像 computed：${JSON.stringify(described.cardHead.avatarStyle)}`,
    `- step 头像 computed：${JSON.stringify(described.cardHead.stepAvatarStyle)}`,
    `- 标题文本：${String(described.cardHead.titleText)}（应为「主代理」）`,
    `- 标题 computed：${JSON.stringify(described.cardHead.titleStyle)}`,
    `- 头像 class 是否与 step 头像一致（true = 复用了同一套实现，含 avatarAgent 类）：${String(
      described.cardHead.avatarClass !== null
      && described.cardHead.stepAvatarClass !== null
      && described.cardHead.avatarClass.split(' ').every(cls => described.cardHead.stepAvatarClass!.includes(cls)),
    )}`,
    '',
    '## 步骤列表的直接子节点（顺序即 DOM 顺序）',
    ...described.rows.map(row => [
      `[${String(row.index)}] ${row.kind}`,
      `    内部 step 会话面板 [data-step-chat] × ${String(row.stepChatPanels)}`,
      `    内部主代理面板 [data-main-agent-chat] × ${String(row.mainAgentPanels)}`,
      `    文本：${row.text}`,
    ].join('\n')),
    '',
  ].join('\n')
  writeFileSync(join(REPO_ROOT, 'e2e', '.artifacts', 'm7-main-agent-card-dom.txt'), text, 'utf8')
  return text
}

/** 从 dump 文本里读出位置信息（避免在用例里重复 evaluate）。 */
function positionOf(domText: string): { mainIndex: number; stepIndexes: number[]; lastIndex: number } {
  const mainIndex = Number(/主代理卡片在列表中的下标：(-?\d+)/.exec(domText)?.[1] ?? '-1')
  const stepIndexes = JSON.parse(/step 卡片在列表中的下标：(\[[^\]]*\])/.exec(domText)?.[1] ?? '[]') as number[]
  const rows = [...domText.matchAll(/^\[(\d+)\] /gm)].map(match => Number(match[1]!))
  const lastIndex = rows.length === 0 ? -1 : Math.max(...rows)
  return { mainIndex, stepIndexes, lastIndex }
}

test.describe('M7 独立输入框 / 主代理独立卡片 / 暂停双语义 / 与 DSH 输入框隔离', () => {
  test('① 独立输入框：可输入可发送（主代理会话真的收到），草稿与 DSH 中心列互不共享', async ({ page, dsh, workspace }) => {
    test.setTimeout(150_000)
    const mark = dsh.logMark()
    const instance = await createMockInstance(page, {
      promptText: `独立输入框用例。${mockDirective({ text: 'm7-input-answer', hold: 60_000 })}`,
      cwd: workspace,
      label: 'e2e-m7-input',
    })

    // 先在 DSH 中心列（运行视图关闭时可见可输入）敲一串草稿，用于「草稿独立」对账。
    await closeRunView(page)
    await openHostSessionInColumn(page, instance.requirement)
    const dshDraft = handleOf('DSH-DRAFT')
    await page.locator('[data-composer-input]').first().click()
    await page.keyboard.type(dshDraft, { delay: 5 })
    await expect.poll(async () => (await dshColumnComposer(page)).text, { timeout: 20_000 }).toContain(dshDraft)

    // 打开运行视图：运行页输入框是**独立**的（草稿为空，不共享中心列那串）。
    await openRunView(page)
    const area = runInput(page)
    await expect(area).toHaveAttribute('aria-label', '给主代理发消息…', { timeout: 30_000 })
    await expect(area).toHaveValue('')
    const send = runSend(page)
    await expect(send).toBeDisabled() // 空草稿

    // 可输入可发送：句柄写进**本条消息自带的 mock 指令**里 ⇒ mock 的响应文本就等于该句柄，
    // 于是「宿主会话被这条消息驱动」有了精确对账点（该指令只存在于这条消息中）。
    const seatDraft = handleOf('SEAT')
    await area.click()
    await page.keyboard.type(`请回我一句 ${mockDirective({ text: seatDraft })}`, { delay: 5 })
    await expect(send).toBeEnabled({ timeout: 20_000 })
    await send.click()
    await expect(area).toHaveValue('') // 发送后清空
    await expect.poll(
      async () => dsh.countSince(mark, new RegExp(`text="${seatDraft}"`, 'g')),
      { timeout: 60_000, message: `主代理会话应被这条消息驱动（日志：\n${dsh.logTail().slice(-800)}）` },
    ).toBe(1)
    // 主代理回了话 ⇒ 主代理卡片出现且带这句回复（需求 3 的最小闭环）。
    await expect(page.locator('[data-tl-main-agent]')).toHaveCount(1, { timeout: 60_000 })
    await expect(page.locator('[data-main-agent-chat]').getByText(seatDraft).first()).toBeVisible({ timeout: 30_000 })

    // 关闭运行视图后：中心列的草稿仍在（两边互不影响），且仍可继续输入。
    await closeRunView(page)
    await expect.poll(async () => (await dshColumnComposer(page)).text, { timeout: 20_000 }).toContain(dshDraft)
    await page.locator('[data-composer-input]').first().click()
    await page.keyboard.type('X')
    await expect.poll(async () => (await dshColumnComposer(page)).text, { timeout: 20_000 }).toContain('X')
  })

  test('② 主代理卡片是同级独立卡片、紧跟正在执行的 step，且主代理回应后才出现（③ 暂停双语义）', async ({ page, dsh, workspace }) => {
    test.setTimeout(240_000)
    // 两步 prompt（同 Stage 线性）：第一步短 hold 很快 completed、第二步长 hold 保持 running
    // ⇒ 列表里同时存在「已完成的一条」与「正在执行的一条」，才能把「卡片紧跟**正在执行的**
    //   step」与「贴在已完成那条后面」区分开（真机 bug 正是后者）。
    const instance = await createMockTwoStepInstance(page, {
      firstPromptText: `第一步。${mockDirective({ text: 'm7-step-one', hold: 3_000 })}`,
      secondPromptText: `第二步。${mockDirective({ text: 'm7-step-two', hold: 240_000 })}`,
      cwd: workspace,
      label: 'e2e-m7-card',
    })
    const stepPanel = page.locator('[data-step-chat]').first()
    await expect(stepPanel).toBeVisible({ timeout: 60_000 })
    // 等到第二步（正在执行的那条）的会话面板出现：此前第一步已 completed。
    await expect(
      page.locator('[data-step-chat]').filter({ hasText: 'm7-step-two' }).first(),
      '第二步应在运行中（它的会话面板挂载并显示其答复）',
    ).toBeVisible({ timeout: 120_000 })
    await expect(page.locator('[data-tl-step]'), '应渲染两条 step 卡片').toHaveCount(2, { timeout: 30_000 })

    // ②a **主代理有消息就插入**（真机反馈修正）：用户还没发消息，但启动注入已经让主代理
    //     汇报过「工作流已启动…」⇒ 卡片**就该出现**（不再要求「用户先发过消息」）。
    const mainCard = page.locator('[data-tl-main-agent]').first()
    await expect(mainCard, '主代理有了助手消息（启动汇报）后卡片应出现').toBeVisible({ timeout: 90_000 })
    // 卡头：头像字母 `M` + 标题「主代理」（与 step 卡片同一套实现）。
    await expect(page.locator('[data-tl-main-agent-avatar]')).toHaveText('M')
    await expect(page.locator('[data-tl-main-agent-title]')).toHaveText('主代理')
    await expect(
      page.locator('[data-tl-step] [data-tl-main-agent]'),
      '主代理卡片绝不能出现在 step 卡片内部（必须是同级独立卡片）',
    ).toHaveCount(0)
    await expect(
      page.locator('[data-sandore-timeline] > [data-tl-main-agent]'),
      '主代理卡片应是步骤列表容器的直接子节点',
    ).toHaveCount(1)
    // ②b 真机反馈修正：**始终在步骤列表最后一张**（不再紧跟正在执行的 step）+ **默认折叠**。
    const beforeSend = await page.locator('[data-sandore-timeline]').last().evaluate(flow => ({
      cardIndex: [...flow.children].findIndex(child => child.hasAttribute('data-tl-main-agent')),
      count: flow.children.length,
      expanded: flow.querySelector('[data-tl-main-agent-toggle]')?.getAttribute('aria-expanded') ?? null,
      bodyRendered: flow.querySelector('[data-tl-main-agent] [data-main-agent-chat]') !== null,
    }))
    expect(beforeSend.cardIndex, '卡片应固定在列表最后一张').toBe(beforeSend.count - 1)
    expect(beforeSend.expanded, '没有新消息输出时默认折叠').toBe('false')
    expect(beforeSend.bodyRendered, '折叠时卡体（消息区）不渲染').toBe(false)

    // 发一条消息（带 25s hold：既驱动主代理回应，又留出「运行中」窗口给 ③ 用）。
    const mainText = handleOf('MAIN-REPLY')
    const area = runInput(page)
    await area.click()
    await page.keyboard.type(`请回我一句话。${mockDirective({ text: mainText, hold: 25_000 })}`, { delay: 5 })
    const send = runSend(page)
    await expect(send).toBeEnabled({ timeout: 20_000 })
    await send.click()

    // ②c 新消息到达 → 同一张卡片**自动展开**并显示新回复（全局仍恰 1 张、仍在最后）。
    const toggle = page.locator('[data-tl-main-agent-toggle]').first()
    await expect(
      page.locator('[data-main-agent-chat]').getByText(mainText).first(),
      '主代理的新回复应出现在同一张卡片里（新消息到达即自动展开）',
    ).toBeVisible({ timeout: 60_000 })
    await expect(toggle, '新消息到达 → 展开').toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('[data-tl-main-agent]'), '卡片全局唯一').toHaveCount(1)
    // ②d **消息不再更新 3 秒 → 自动折叠**（用户规格：三秒后折叠这个主代理 step）。
    await expect(
      toggle,
      '最后一条消息之后 3 秒无新增 → 自动折叠（卡体收起、卡头仍在）',
    ).toHaveAttribute('aria-expanded', 'false', { timeout: 20_000 })
    await expect(page.locator('[data-main-agent-chat]'), '折叠后卡体不渲染').toHaveCount(0)
    await expect(page.locator('[data-tl-main-agent-title]')).toHaveText('主代理')
    // 手动点开（取证与后续断言需要卡体在 DOM 里；位置断言本来与折叠无关）。
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const domText = await dumpTimelineDom(page, '主代理回应后')
    expect(domText).toContain('主代理卡片的父节点 === 步骤列表容器：[data-sandore-timeline] → true')
    expect(domText).toContain('主代理卡片出现在任何 step 卡片内部：false')
    expect(domText).toContain('主代理卡片是否在步骤列表最后一张：true')
    const { mainIndex, stepIndexes, lastIndex } = positionOf(domText)
    expect(stepIndexes, '应有两条 step 卡片（第一条已完成、第二条运行中）').toHaveLength(2)
    expect(mainIndex, '主代理卡片应固定在步骤列表最后一张').toBe(lastIndex)
    // 卡片内容：宿主会话的会话视图（独立锚点，不混进 step 面板计数）+ 头壳。
    await expect(page.locator('[data-main-agent-chat]')).toHaveCount(1)
    await expect(mainCard).toContainText('主代理')
    await expect(page.locator('[data-main-agent-chat]').getByText(mainText).first()).toBeVisible({ timeout: 60_000 })

    // ③ 主代理 turn 中止（输入框区已无停止按钮，真机反馈第三轮）：暂停入口 = **DSH 中心列
    //    输入框自带的「停止生成」**——它取消宿主主代理当前 turn，引擎据此把实例判为 paused。
    expect(
      countOfType(framesOf(await readSseFrames(page), instance.instanceId), 'sandore/step-paused'),
      '暂停前不应有 step-paused（本用例的基线）',
    ).toBe(0)
    // 运行页输入框区**没有**任何动作按钮（防复发）。
    await expect(page.locator('[data-sandore-disc-input] [data-sandore-stop]')).toHaveCount(0)
    // 关运行视图 → 中心列打开宿主会话 → 点 DSH 的「停止生成」。
    await closeRunView(page)
    await openHostSessionInColumn(page, instance.requirement)
    const dshStop = page.locator(
      '[data-composer-card] button[aria-label="停止生成"], button[aria-label="停止生成"]',
    ).first()
    await expect(dshStop, 'DSH 输入框的「停止生成」是暂停入口').toBeEnabled({ timeout: 30_000 })
    await dshStop.click()
    await expect.poll(
      async () => countOfType(framesOf(await readSseFrames(page), instance.instanceId), 'sandore/step-paused'),
      { timeout: 30_000, message: '中止主代理 turn 后引擎应把实例判为 paused（SSE 对账）' },
    ).toBe(1)
    await expect.poll(async () => (await getInstanceState(page, instance.instanceId)).status, { timeout: 30_000 })
      .toBe('paused')
    // 回运行视图：实例暂停态 + 主代理卡片不再「正在响应」（turn 已被 abort，不是自然跑满 25s）。
    await openRunView(page)
    await expect(page.locator('[data-sandore-run-view]').last().getByText('已暂停').first()).toBeVisible({ timeout: 30_000 })
    await expect(
      page.locator('[data-main-agent-chat]').getByText('Deep diving').first(),
      '主代理 turn 未被中止（运行中状态行仍在；DSH 侧只有 abort 当前 turn 这一种「停」）',
    ).toHaveCount(0, { timeout: 30_000 })
    // 卡体此时多半已被自动折叠（3s 规则）——手动展开后复核回复文本仍在。
    const toggleAfter = page.locator('[data-tl-main-agent-toggle]').first()
    if (await toggleAfter.getAttribute('aria-expanded') !== 'true') await toggleAfter.click()
    await expect(mainCard.getByText(mainText).first()).toBeVisible({ timeout: 30_000 })
    expect(dsh.logTail(), '主代理 turn 应被驱动过（mock 日志）').toContain('[e2e-mock] call#')
  })

  test('④ 与 DSH 中心列输入框隔离：不接管编辑器根，草稿与可编辑性全程不受影响', async ({ page, workspace }) => {
    test.setTimeout(150_000)
    const instance = await createMockInstance(page, {
      promptText: `隔离用例。${mockDirective({ text: 'm7-isolate-answer', hold: 60_000 })}`,
      cwd: workspace,
      label: 'e2e-m7-isolate',
    })

    // 前置：中心列显示宿主会话，并在它自己的输入框里留一串草稿（旧实现会把这串文本
    // 从中心列的 DOM 里「搬走」——不接管就意味着它一直在这里）。
    await closeRunView(page)
    await openHostSessionInColumn(page, instance.requirement)
    const dshDraft = handleOf('KEEP')
    await page.locator('[data-composer-input]').first().click()
    await page.keyboard.type(dshDraft, { delay: 5 })
    await expect.poll(async () => (await dshColumnComposer(page)).text, { timeout: 20_000 }).toContain(dshDraft)

    // 打开运行视图（同一个会话）：运行页输入框是独立实现 ⇒ 不接管、不抢根。
    await openRunView(page)
    await expect(runInput(page)).toBeVisible({ timeout: 30_000 })
    await expect(
      page.locator('[data-composer-took-root]'),
      '独立输入框不该有任何「接管 DSH 输入壳」的痕迹',
    ).toHaveCount(0)
    expect((await dshColumnComposer(page)).text, 'DSH 中心列草稿应原地不动（未被接管）').toContain(dshDraft)

    // 关闭运行视图后：中心列输入框仍可编辑、草稿还在、还能继续打字。
    await closeRunView(page)
    await expect.poll(async () => (await dshColumnComposer(page)).editable, {
      timeout: 30_000,
      message: '关闭运行视图后 DSH 中心列输入框应仍可编辑',
    }).toBe(true)
    await expect.poll(async () => (await dshColumnComposer(page)).text, { timeout: 20_000 }).toContain(dshDraft)
    await page.locator('[data-composer-input]').first().click()
    await page.keyboard.type('Y')
    await expect.poll(async () => (await dshColumnComposer(page)).text, { timeout: 20_000 }).toContain('Y')
  })

  test('⑤ 下拉是真功能：模型下拉切换主代理会话模型、权限下拉改变实例权限模式', async ({ page, dsh, workspace }) => {
    test.setTimeout(240_000)
    const mark = dsh.logMark()
    const instance = await createMockInstance(page, {
      promptText: `下拉用例。${mockDirective({ text: 'm7-select-answer', hold: 90_000 })}`,
      cwd: workspace,
      label: 'e2e-m7-select',
    })
    const disc = page.locator('[data-sandore-disc-input]').first()
    await expect(disc).toBeVisible({ timeout: 60_000 })

    // ── ① 模型下拉：切换成第二个模型（mock-2），并证明**下一次主代理调用真的用了它** ──
    const modelTrigger = disc.locator('[data-main-agent-model-trigger] button').first()
    await expect(modelTrigger, '模型下拉触发器应在运行页输入框上（发送钮左侧）').toBeVisible({ timeout: 30_000 })
    const beforeModel = (await modelTrigger.textContent()) ?? ''
    await modelTrigger.click()
    const modelMenu = disc.locator('[role="menu"]').first()
    await expect(modelMenu, '模型菜单应打开').toBeVisible({ timeout: 20_000 })
    // 两级菜单：先钻入「模型」，再选 E2E Mock 2（mock provider 广告的第二个模型）。
    const modelCell = modelMenu.getByRole('menuitem', { name: '模型' }).first()
    if (await modelCell.count() > 0) await modelCell.click()
    const option = page.getByRole('menuitemradio', { name: /E2E Mock 2/ }).first()
    await expect(option, '第二个模型应出现在菜单里（mock provider 广告两个模型）').toBeVisible({ timeout: 20_000 })
    await option.click()
    await expect.poll(async () => (await modelTrigger.textContent()) ?? '', {
      timeout: 30_000,
      message: '选中后触发器文案应变成新模型',
    }).toContain('E2E Mock 2')
    expect(beforeModel, '切换前触发器不应已是新模型（防恒真）').not.toContain('E2E Mock 2')

    // 切换后发一条带唯一句柄的消息：mock 日志里同一行必须同时出现新模型与该句柄
    // ⇒「主代理会话的下一次调用真的用了新模型」有了精确对账（句柄只在主代理会话里）。
    const modelProof = handleOf('MODEL-PROOF')
    const area = runInput(page)
    await area.fill(`模型切换验证。${mockDirective({ text: modelProof })}`)
    const send = runSend(page)
    await expect(send).toBeEnabled({ timeout: 20_000 })
    await send.click()
    await expect.poll(async () => dsh.countSince(mark, new RegExp(`model=mock-1-2\\b[^\\n]*text="${modelProof}"`, 'g')), {
      timeout: 60_000,
      message: `主代理的下一次调用应使用切换后的模型（日志：\n${dsh.logTail().slice(-600)}）`,
    }).toBeGreaterThanOrEqual(1)

    // ── ② 权限下拉：切到 read-only，界面文案 + 引擎实例快照双对账 ──
    const accessTrigger = disc.locator('[data-main-agent-access] button').first()
    await expect(accessTrigger, '权限下拉触发器应在工具行左侧（DSH .tools 位置）').toBeVisible({ timeout: 30_000 })
    await accessTrigger.click()
    const accessMenu = disc.locator('[role="menu"][aria-label]').last()
    await expect(accessMenu).toBeVisible({ timeout: 20_000 })
    const readOnly = accessMenu.getByRole('menuitemradio', { name: '仅可查看' }).first()
    await expect(readOnly, '权限菜单应列出三档预设（i18n 与 DSH 同文案）').toBeVisible({ timeout: 20_000 })
    await readOnly.click()
    await expect.poll(async () => (await accessTrigger.textContent()) ?? '', {
      timeout: 30_000,
      message: '权限触发器文案应变成「仅可查看」（DSH 同文案）',
    }).toContain('仅可查看')
    // 引擎侧真值：实例快照的 permission 必须同步为 read-only（引擎 RPC 通路生效）。
    await expect.poll(
      async () => ((await getInstanceState(page, instance.instanceId)).raw as { permission?: string }).permission,
      { timeout: 30_000, message: '引擎侧实例权限模式应变成 read-only' },
    ).toBe('read-only')
  })
})
