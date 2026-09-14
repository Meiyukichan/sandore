/**
 * M8 · **主代理卡片全局唯一 + 每个 step 面板显示自己的会话**（真机取证 + 回归护栏）。
 *
 * 用户真机反馈：「你把每个 step 下面，都强行塞入了主代理的消息」。本用例用**事实**回答
 * 两件事，并把结论 dump 到 `e2e/.artifacts/m8-main-agent-uniqueness.txt`：
 *
 * 1. **主代理卡片出现几次、出现在哪**：`[data-tl-main-agent]` / `[data-main-agent-chat]`
 *    的全局计数；每张卡片的父节点是否为步骤列表容器（= 兄弟节点而非某个 step 的后代）；
 *    每张 step 卡片内部的 `[data-tl-main-agent]` / `[data-main-agent-chat]` 计数。
 * 2. **每个 step 面板渲染的会话归属**：逐个 step 面板取首行文本，判断它显示的是
 *    **该 step 自己的子代理会话**（含 step 自己的提示词文本 / 「你正在执行工作流中的一个 Step」）
 *    还是**主代理会话**的内容（含引擎注入的「请调用 sandore_workflow_run 启动」或
 *    主代理的启动回复「工作流已启动」）。若某 step 面板显示的是主代理会话 ⇒ 会话错绑，
 *    这是本用例要钉死的最高优先级缺陷。
 *
 * 现场构造：**三个** prompt 步（前两步短 hold 很快 completed、第三步长 hold 保持 running）
 * —— 只有 ≥3 个 step 都真实进入过 running/completed，「全局 1 张」与「每步 1 张（= 3 张）」
 * 才能在计数上被区分开（两步不够）。主代理输出由用户在运行页输入框真实发送一条消息触发
 * （与 M7 同一条通路）。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT, expect, getInstanceState, mockDirective, test, type Page } from './fixtures/harness.ts'
import { createMockThreeStepInstance } from './fixtures/mock-run.ts'

/** 唯一句柄（只出现在用户敲进输入框的那条消息里 → 防假通过）。 */
function handleOf(label: string): string {
  return `M8-${label}-${Math.random().toString(36).slice(2, 10)}`
}

/** 打开运行视图（幂等）。 */
async function openRunView(page: Page): Promise<void> {
  const entry = page.locator('[data-sandore-seat-entry]').first()
  if (await entry.getAttribute('aria-expanded') !== 'true') await entry.click()
  await expect(page.locator('[data-sandore-seat-view]').first()).toBeVisible()
  await expect(page.locator('[data-sandore-run-view]').last()).toBeVisible({ timeout: 30_000 })
}

/** 取证结果（浏览器侧 evaluate 的返回形状）。 */
interface UniquenessProbe {
  readonly mainCardCount: number
  readonly mainChatCount: number
  readonly stepCardCount: number
  readonly stepChatCount: number
  readonly mainCards: readonly {
    readonly anchor: string
    readonly parentIsTimeline: boolean
    readonly insideStepCard: boolean
    readonly timelineChildIndex: number
    readonly isLast: boolean
    readonly collapsed: string | null
    readonly text: string
  }[]
  readonly stepCards: readonly {
    readonly index: number
    readonly stepLabel: string
    readonly mainCardsInside: number
    readonly mainChatInside: number
    readonly stepChatPanels: number
    readonly text: string
  }[]
  readonly stepPanels: readonly {
    readonly cardIndex: number
    readonly rows: readonly string[]
    readonly ownsStepPrompt: boolean
    readonly looksMainAgent: boolean
  }[]
  readonly mainPanel: { readonly rows: readonly string[]; readonly looksMainAgent: boolean } | null
}

/** 主代理会话内容的标记（引擎注入的启动上下文 + 主代理的启动回复）。 */
const MAIN_AGENT_MARKERS = ['请调用 sandore_workflow_run', '工作流已启动'] as const
/** step 子代理会话内容的标记（引擎组装的 step 系统提示词）。 */
const STEP_OWN_MARKERS = ['你正在执行工作流中的一个 Step'] as const

/** 浏览器侧取证：卡片计数 + 每张 step 卡片内部计数 + 每个会话面板的首行文本与归属判定。 */
async function probe(page: Page, mainHandle: string): Promise<UniquenessProbe> {
  return page.evaluate(({ mainMarkers, stepMarkers }) => {
    const timeline = document.querySelector('[data-sandore-timeline]')
    const children = timeline === null ? [] : [...timeline.children]
    const compact = (text: string | null): string => (text ?? '').replace(/\s+/g, ' ').trim()
    const anyOf = (text: string, markers: readonly string[]): boolean => markers.some(marker => text.includes(marker))
    const mainCards = [...document.querySelectorAll('[data-tl-main-agent]')].map((card) => {
      const text = compact(card.textContent)
      return {
        anchor: text.slice(0, 60),
        parentIsTimeline: card.parentElement === timeline,
        insideStepCard: card.closest('[data-tl-step]') !== null,
        timelineChildIndex: children.indexOf(card),
        isLast: timeline !== null && timeline.lastElementChild === card,
        collapsed: card.querySelector('[data-tl-main-agent-toggle]')?.getAttribute('aria-expanded') ?? null,
        text: text.slice(0, 160),
      }
    })
    const stepCards = [...document.querySelectorAll('[data-tl-step]')].map((card, index) => {
      const text = compact(card.textContent)
      return {
        index,
        stepLabel: text.slice(0, 40),
        mainCardsInside: card.querySelectorAll('[data-tl-main-agent]').length,
        mainChatInside: card.querySelectorAll('[data-main-agent-chat]').length,
        stepChatPanels: card.querySelectorAll('[data-step-chat]').length,
        text: text.slice(0, 160),
      }
    })
    const rowsOf = (panel: Element): readonly string[] =>
      [...panel.querySelectorAll('[data-chat-flow-kind]')].slice(0, 4).map(row => compact(row.textContent).slice(0, 140))
    const stepPanels = [...document.querySelectorAll('[data-tl-step]')].map((card, cardIndex) => {
      const panel = card.querySelector('[data-step-chat]')
      const rows = panel === null ? [] : rowsOf(panel)
      const text = rows.join(' ⏎ ')
      return {
        cardIndex,
        rows,
        ownsStepPrompt: anyOf(text, stepMarkers),
        looksMainAgent: anyOf(text, mainMarkers),
      }
    })
    const mainPanel = document.querySelector('[data-main-agent-chat]')
    return {
      mainCardCount: mainCards.length,
      mainChatCount: document.querySelectorAll('[data-main-agent-chat]').length,
      stepCardCount: stepCards.length,
      stepChatCount: document.querySelectorAll('[data-step-chat]').length,
      mainCards,
      stepCards,
      stepPanels,
      mainPanel: mainPanel === null
        ? null
        : { rows: rowsOf(mainPanel), looksMainAgent: anyOf(rowsOf(mainPanel).join(' ⏎ '), mainMarkers) },
    }
  }, { mainMarkers: [...MAIN_AGENT_MARKERS, mainHandle], stepMarkers: [...STEP_OWN_MARKERS] })
}

/** 把取证结果写成人类可读文本（同时返回，便于在断言失败信息里直接看）。 */
function renderProbe(result: UniquenessProbe, label: string, segments: string): string {
  const text = [
    `# M8 主代理卡片唯一性 + step 会话归属取证（${label}）`,
    `时间：${new Date().toISOString()}`,
    '',
    '## 全局计数',
    `- [data-tl-main-agent] 主代理卡片数：${String(result.mainCardCount)}（期望 1）`,
    `- [data-main-agent-chat] 主代理会话面板数：${String(result.mainChatCount)}（期望 1）`,
    `- [data-tl-step] step 卡片数：${String(result.stepCardCount)}`,
    `- [data-step-chat] step 会话面板数：${String(result.stepChatCount)}`,
    '',
    '## 每张主代理卡片',
    ...result.mainCards.flatMap((card, index) => [
      `[${String(index)}] 父节点是步骤列表容器：[data-sandore-timeline] → ${String(card.parentIsTimeline)}`,
      `     在步骤列表子节点中的下标：${String(card.timelineChildIndex)}`,
      `     是否在步骤列表最后一张：${String(card.isLast)}（真机反馈要求 true）`,
      `     折叠态（aria-expanded）：${String(card.collapsed)}`,
      `     位于某个 step 卡片内部：${String(card.insideStepCard)}（必须 false）`,
      `     文本：${card.text}`,
    ]),
    '',
    '## 每张 step 卡片内部的计数（必须全 0：主代理卡片/面板绝不进 step 卡片）',
    ...result.stepCards.map(card => `[${String(card.index)}] ${card.stepLabel} | 内含主代理卡片 ${String(card.mainCardsInside)} | 内含主代理面板 ${String(card.mainChatInside)} | 内含 step 面板 ${String(card.stepChatPanels)}`),
    '',
    '## 每个 step 面板显示的会话归属（关键：必须是该 step 自己的子代理会话）',
    ...result.stepPanels.flatMap(panel => [
      `[step 卡片 ${String(panel.cardIndex)}] 含 step 自己的提示词标记：${String(panel.ownsStepPrompt)} | 含主代理会话标记：${String(panel.looksMainAgent)}（必须 false）`,
      ...panel.rows.map((row, index) => `     首行[${String(index)}]：${row}`),
    ]),
    '',
    '## 主代理卡片面板显示的会话',
    `- 含主代理会话标记：${String(result.mainPanel?.looksMainAgent ?? false)}（期望 true）`,
    ...(result.mainPanel?.rows ?? []).map((row, index) => `     首行[${String(index)}]：${row}`),
    '',
    '## 引擎侧 segment 数据（executedSteps[].sessionMeta：childId 是否等于 instanceId）',
    segments,
    '',
  ].join('\n')
  writeFileSync(join(REPO_ROOT, 'e2e', '.artifacts', 'm8-main-agent-uniqueness.txt'), text, 'utf8')
  return text
}

test.describe('M8 主代理卡片全局唯一 + step 面板会话归属', () => {
  test('三步工作流：主代理卡片恒 1 张（不进任何 step 卡片），每个 step 面板显示自己的会话', async ({ page, workspace }) => {
    test.setTimeout(300_000)
    const instance = await createMockThreeStepInstance(page, {
      promptTexts: [
        `第一步。${mockDirective({ text: 'm8-step-one', hold: 3_000 })}`,
        `第二步。${mockDirective({ text: 'm8-step-two', hold: 3_000 })}`,
        `第三步。${mockDirective({ text: 'm8-step-three', hold: 240_000 })}`,
      ],
      cwd: workspace,
      label: 'e2e-m8-unique',
    })

    // 等到「前两步 completed、第三步 running」的现场：三个 step 卡片都在，且第三条仍在跑。
    await expect(page.locator('[data-tl-step]'), '应渲染三条 step 卡片').toHaveCount(3, { timeout: 120_000 })
    await expect(
      page.locator('[data-step-chat]').filter({ hasText: 'm8-step-two' }).first(),
      '第二步应已跑过（它自己的会话面板有答复）',
    ).toBeVisible({ timeout: 120_000 })
    await expect(
      page.locator('[data-step-chat]').filter({ hasText: 'm8-step-three' }).first(),
      '第三步应在运行中',
    ).toBeVisible({ timeout: 120_000 })

    // 触发主代理输出：用户在运行页输入框真实发送一条消息（走 M7 同一条通路）。
    await openRunView(page)
    const mainText = handleOf('MAIN-REPLY')
    const area = page.locator('[data-sandore-disc-input] [data-main-agent-input]').first()
    await expect(area).toBeVisible({ timeout: 30_000 })
    await area.fill(`请回我一句话。${mockDirective({ text: mainText, hold: 120_000 })}`)
    const send = page.locator('[data-sandore-disc-input] [data-main-agent-send]').first()
    await expect(send).toBeEnabled({ timeout: 20_000 })
    await send.click()

    // 主代理回应后：卡片出现（出现条件不变），随后做唯一性取证。
    await expect(page.locator('[data-tl-main-agent]').first()).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('[data-main-agent-chat]').getByText(mainText).first()).toBeVisible({ timeout: 60_000 })
    // 让「第三步仍 running」的现场稳定后再取证（避免最后一步恰好完成导致锚点退化）。
    const result = await probe(page, mainText)
    // 引擎侧数据面：executedSteps[] 的 sessionMeta（childId / hostSessionId）与 instanceId 的关系
    // ——面板显示的是谁的会话，最终取决于这里给的 childId。（取证容错：读不到就如实记下。）
    const segments = await (async (): Promise<string> => {
      try {
        const state = await getInstanceState(page, instance.instanceId)
        const raw = state.raw as {
          executedSteps?: readonly { id?: string; stepId?: string; status?: string; sessionMeta?: { childId?: string; hostSessionId?: string; synthetic?: boolean } }[]
        }
        return [
          `- instanceId（= 宿主会话 id）：${instance.instanceId}`,
          ...(raw.executedSteps ?? []).map((step, index) => {
            const meta = step.sessionMeta
            return `- 段[${String(index)}] stepId=${String(step.stepId ?? step.id)} status=${String(step.status)}`
              + ` childId=${String(meta?.childId)} hostSessionId=${String(meta?.hostSessionId)} synthetic=${String(meta?.synthetic)}`
              + ` | childId === instanceId ? ${String(meta?.childId === instance.instanceId)}`
          }),
        ].join('\n')
      } catch (error) {
        return `- 读取实例状态失败：${String(error)}`
      }
    })()
    const text = renderProbe(result, '三步现场 · 主代理已回应', segments)

    // ── 回归护栏（真机计数，不是恒真断言）────────────────────────────────────
    expect(result.mainCardCount, `主代理卡片必须全局唯一：\n${text}`).toBe(1)
    expect(result.mainChatCount, `主代理会话面板必须全局唯一：\n${text}`).toBe(1)
    expect(result.stepCardCount, '应有三条 step 卡片').toBe(3)
    // ① 不是「每步一张」：任何 step 卡片内部都不得有主代理卡片/面板。
    for (const card of result.stepCards) {
      expect(card.mainCardsInside, `step 卡片 [${String(card.index)}] 内部不应有主代理卡片：\n${text}`).toBe(0)
      expect(card.mainChatInside, `step 卡片 [${String(card.index)}] 内部不应有主代理面板：\n${text}`).toBe(0)
      expect(card.stepChatPanels, `step 卡片 [${String(card.index)}] 应挂自己的会话面板`).toBe(1)
    }
    // ② 卡片是步骤列表容器的直接子节点（兄弟卡片语义）+ **固定在最后一张**（真机反馈）。
    expect(result.mainCards[0]?.parentIsTimeline, '主代理卡片应是步骤列表容器的直接子节点').toBe(true)
    expect(result.mainCards[0]?.insideStepCard, '主代理卡片不得位于任何 step 卡片内部').toBe(false)
    expect(result.mainCards[0]?.isLast, `主代理卡片应固定在步骤列表最后一张：\n${text}`).toBe(true)
    // ③ **会话归属**：每个 step 面板显示的是它自己的会话，绝不能是主代理会话。
    expect(result.stepPanels, '应能读到三个 step 面板').toHaveLength(3)
    for (const panel of result.stepPanels) {
      expect(
        panel.looksMainAgent,
        `step 卡片 [${String(panel.cardIndex)}] 的面板显示的是**主代理会话**内容（会话错绑）：\n${text}`,
      ).toBe(false)
      expect(
        panel.ownsStepPrompt,
        `step 卡片 [${String(panel.cardIndex)}] 的面板应含该 step 自己的提示词标记：\n${text}`,
      ).toBe(true)
    }
    // ④ 主代理卡片面板显示的才是主代理会话。
    expect(result.mainPanel?.looksMainAgent, `主代理卡片应显示主代理会话内容：\n${text}`).toBe(true)
  })
})
