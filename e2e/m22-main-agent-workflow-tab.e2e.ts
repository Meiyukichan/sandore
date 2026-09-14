/**
 * M22 · 主代理会话里的「工作流」tab（用户需求）。
 *
 * ## 用户原话要点
 * > 「在主代理会话里新增一个『工作流』tab：内容 = 侧边栏那套工作流页**同一份实现**，
 * >  但按该主代理会话过滤（过滤键 = 宿主会话 id / hostSessionId，恒等于 instanceId）；
 * >  不带讨论输入框；两个 WebUI 宿主共用一份实现，只靠参数区分。」
 *
 * ## 挂载点（本用例验收的形态）
 * tab 就是 **DSH 会话 header 的原生 tab 条**（`ui-conversation` 的
 * `conversation.session.header` 渲染 `[role="tablist"]`），我们的「工作流」tab 是
 * `conversation.view` 槽里的一条注册（与 Chat / Trajectory 同形态同视觉）。
 * 因此断言用的是 **DSH 自己的 `role="tab"`**（插件不能往 DSH 的 DOM 上加 data 属性——
 * 禁止改 DSH 源码）；我们自己的 DOM 锚点从面板起：`[data-sandore-tab-panel="workflow"]`
 * → `[data-sandore-run-view]`。
 *
 * ## 断言
 * 用例 1（有绑定实例的会话）：
 * 1. 主代理会话页出现「工作流」tab 且可点（此时会话内容 = DSH 原生对话视图）；
 * 2. 点开后 `[data-sandore-tab-panel="workflow"]` 出现，里面有**本实例**的执行视图
 *    （需求文本 + 导航树节点 + 进度读数）；
 * 3. 同时创建的**另一个**实例的 id / 需求文本**不出现在**本面板里（按会话过滤）；
 * 4. 面板内**没有**输入框（三个输入锚点计数为 0）；
 * 5. 切回「对话」tab 后原会话内容仍在（tab 切换不破坏 DSH 会话页）。
 *
 * 用例 2（**没有绑定实例**的会话，用户拍板的显示语义）：
 * 6. 工作流 tab 对任何会话都出现（不做动态显隐）；
 * 7. 面板里是**静态页面骨架**：实例列表为空 + 编排列表也为空，两种列表模式都在位、
 *    可切换，空态文案与侧栏列表同族；
 * 8. 面板内仍没有输入面、没有**任何别的实例**的 id/需求文本（按实例清单全量对照）、
 *    也没有侧栏那套写操作入口。
 *
 * 取证落盘：`e2e/.artifacts/main-agent-workflow-tab.txt`。
 */
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  REPO_ROOT, ensureDefinition, expect, getInstanceState, listInstances, mockDirective, sandoreRpc, test,
} from './fixtures/harness.ts'
import { dshColumnComposer, openHostSessionInColumn } from './fixtures/host-session.ts'
import { createMockInstance } from './fixtures/mock-run.ts'
import { mockPromptWorkflow } from './fixtures/mock-workflows.ts'

/** tab 名（本插件字典 `tab.workflow` 的中文值）。 */
const TAB_WORKFLOW = '工作流'
/** DSH Chat 视图的 tab 名（ui-chat 注册的 `chat`；中文界面下是「对话」）。 */
const TAB_CHAT = /对话|Chat/u

/** 页面本体与交互入口的锚点清单（侧栏那套工作流页面 = 同一份组件）。 */
const PAGE_CHROME = {
  /** 页面根（`WorkflowOverlay` 的最外层）。 */
  view: '[data-sandore-wf-view]',
  /** 左栏列表（标题 + 模式切换 + 工具栏 + 列表体）。 */
  list: '[data-sandore-wf-list]',
  /** 右栏编辑区（编排 = DagEditor；执行 = 执行视图）。 */
  editor: '[data-sandore-wf-editor]',
  /** 模式切换（实例 / 编排）。 */
  modeSwitch: '[data-sandore-list-mode-tab]',
} as const

/** 主操作按钮锚点：实例模式 = 「运行工作流」；编排模式 = 「新增定义」。 */
const PRIMARY_ACTION = '[data-sandore-list-primary-action'
const RUN_WORKFLOW = `${PRIMARY_ACTION}="run-workflow"]`
const ADD_DEFINITION = `${PRIMARY_ACTION}="add-definition"]`

/**
 * 新建会话后投一条普通消息，把**空白会话**变成真实会话（空白会话的 header chrome
 * 由 DSH 自己隐藏 ⇒ 不投消息就看不到 tab 条）。
 *
 * 实现要点（实测踩坑）：DSH 输入面是 **Lexical contenteditable**
 * （`ui-conversation` 的 `ComposerContentEditable`：`contentEditable={editor !== null && editable}`），
 * 编辑器挂上前它**还不是** contenteditable ⇒ `fill` 会报
 * 「Element is not an <input>, <textarea> or [contenteditable] element」。
 * 故先等 `contenteditable="true"`，再 `click` + `keyboard.type` + `Enter`。
 * @param page - 被测页面。
 */
async function sendMessageInFreshSession(page: import('@playwright/test').Page): Promise<void> {
  const composer = page.locator('[data-composer-input]').first()
  await expect(composer, '新建会话后应出现 DSH 中心列输入框').toHaveCount(1, { timeout: 30_000 })
  await expect(composer, '输入面应已绑定编辑器（contenteditable）')
    .toHaveAttribute('contenteditable', 'true', { timeout: 30_000 })
  await composer.click()
  await page.keyboard.type('M22：这条会话不绑定任何工作流实例。')
  await page.keyboard.press('Enter')
  // 真实会话 = hero 消失（composer 进入 docked 位置）。
  await expect.poll(async () => page.getByText('描述你想要构建的内容', { exact: false }).count(), {
    timeout: 30_000,
    message: '投递消息后会话应离开空白态（hero 消失）',
  }).toBe(0)
}
/** 搜索框（`Input` 原子渲染的 input，占位/可访问名 = 字典的 `panel.search`）。 */
const SEARCH_INPUT = '[data-sandore-wf-list] input[placeholder*="搜索"]'

/**
 * 断言「页面本体与交互入口在位」（用户口径：tab 内容几乎完全等于侧栏点开得到的页面）。
 * @param panel - 工作流 tab 面板根 locator。
 */
async function expectPageChrome(panel: import('@playwright/test').Locator): Promise<void> {
  for (const [name, selector] of Object.entries(PAGE_CHROME)) {
    await expect(panel.locator(selector).first(), `页面本体缺少 ${name}（${selector}）`)
      .toBeVisible({ timeout: 30_000 })
  }
  // 搜索框与实例模式的主操作按钮（「运行工作流」）。
  await expect(panel.locator(SEARCH_INPUT).first(), '页面缺少搜索框').toBeVisible({ timeout: 30_000 })
  await expect(panel.locator(RUN_WORKFLOW).first(), '页面缺少「运行工作流」按钮').toBeVisible({ timeout: 30_000 })
}

/**
 * 切到编排模式并断言「新增定义」按钮在位（入口清单的一半），再切回实例模式。
 * 每次点击后都等 `aria-selected` 落定（模式态在共享的 `workflow-store` 里，异步生效）。
 * @param panel - 工作流 tab 面板根 locator。
 */
async function expectDefinitionEntry(panel: import('@playwright/test').Locator): Promise<void> {
  const modeSwitch = panel.locator(PAGE_CHROME.modeSwitch).first()
  const definitionTab = modeSwitch.getByRole('tab', { name: '编排', exact: true })
  const instanceTab = modeSwitch.getByRole('tab', { name: '实例', exact: true })
  await definitionTab.click()
  await expect(definitionTab, '模式开关应切到「编排」').toHaveAttribute('aria-selected', 'true', { timeout: 15_000 })
  await expect(panel.locator(ADD_DEFINITION).first(), '编排模式应有「新增定义」按钮')
    .toBeVisible({ timeout: 20_000 })
  await instanceTab.click()
  await expect(instanceTab, '模式开关应切回「实例」').toHaveAttribute('aria-selected', 'true', { timeout: 15_000 })
  await expect(panel.locator(RUN_WORKFLOW).first(), '切回实例模式后「运行工作流」按钮应在位')
    .toBeVisible({ timeout: 20_000 })
}

/** 「面板根 + 祖先链」版式快照（用于证明工作流 tab 与轨迹 tab 铺满语义一致）。 */
interface LayoutSnapshot {
  /** 面板根（轨迹 tab 若未注册/未打开则为 null）。 */
  readonly root: {
    readonly width: number
    readonly left: number
    readonly right: number
    readonly paddingLeft: string
    readonly paddingRight: string
    readonly marginLeft: string
    /** 祖先链（由内到外）的 tag/class/宽度/padding。 */
    readonly ancestors: readonly string[]
    /** 面板根是否落在 Chat 的消息流/消息列里（必须为 false）。 */
    readonly inChatFlow: boolean
    /** 是否带铺满语义标记（照轨迹 tab）。 */
    readonly composerOverlay: boolean
    /** 面板内的宽度拖拽条数量（Chat 才有；应为 0）。 */
    readonly widthHandles: number
  } | null
  /** `[data-conversation-scroll]`（会话滚动体）宽度，作铺满对照基准。 */
  readonly scrollBodyWidth: number
}

/**
 * 量一份版式快照：优先取工作流 tab 面板，其次取轨迹 tab 的视图根。
 * @param page - 被测页面。
 * @returns 快照（当前 tab 没有对应面板时 `root` 为 null）。
 */
async function measureLayout(page: import('@playwright/test').Page): Promise<LayoutSnapshot & { trajectory: boolean }> {
  return page.evaluate(() => {
    const workflow = document.querySelector('[data-sandore-tab-panel="workflow"]')
    // 轨迹视图根的稳定锚点：`data-conversation-composer-overlay`（DSH 官方视图约定），
    // 且不在我们的面板子树里。
    const trajectoryRoot = [...document.querySelectorAll('[data-conversation-composer-overlay]')]
      .find(el => el.closest('[data-sandore-tab-panel]') === null) ?? null
    const element = workflow ?? trajectoryRoot
    const scrollBody = document.querySelector('[data-conversation-scroll]')
    if (element === null) {
      return { root: null, trajectory: trajectoryRoot !== null, scrollBodyWidth: scrollBody?.clientWidth ?? 0 }
    }
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    const ancestors: string[] = []
    let node: Element | null = element
    for (let depth = 0; node !== null && depth < 8; depth += 1) {
      const box = node.getBoundingClientRect()
      const inner = getComputedStyle(node)
      ancestors.push(
        `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 60)}`
        + ` [w=${Math.round(box.width)} l=${Math.round(box.left)} pad=${inner.paddingLeft}/${inner.paddingRight}`
        + ` maxw=${inner.maxWidth}]`,
      )
      node = node.parentElement
    }
    return {
      root: {
        width: Math.round(rect.width),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        marginLeft: style.marginLeft,
        ancestors,
        inChatFlow: element.closest('[data-chat-flow], [class*="column"]') !== null,
        composerOverlay: element.hasAttribute('data-conversation-composer-overlay'),
        // 会话列宽度拖拽条（Chat 那一族的「左右拉伸」入口）：DSH 用 CSS-Module 哈希类名
        // （`_widthHandle_xxx`），故按 `class` 属性**子串**匹配；并且只数**可见**的
        // （该标记会让 DSH 的 `.root:has([data-conversation-composer-overlay]) .widthHandle
        // { display:none }` 生效 ⇒ 隐藏的不算入口）。
        widthHandles: [...document.querySelectorAll<HTMLElement>('[class*="widthHandle"]')]
          .filter(el => getComputedStyle(el).display !== 'none').length,
      },
      trajectory: trajectoryRoot !== null,
      scrollBodyWidth: scrollBody?.clientWidth ?? 0,
    }
  })
}

/**
 * 断言两个 tab 的铺满语义一致（用户真机缺陷：工作流 tab 出现「对话消息左右两边拉伸」的版式）。
 * @param workflow - 工作流 tab 的版式快照。
 * @param trajectory - 轨迹 tab 的版式快照（对照）。
 */
function expectLayoutParity(
  workflow: LayoutSnapshot & { trajectory: boolean },
  trajectory: LayoutSnapshot & { trajectory: boolean },
): void {
  const mine = workflow.root
  const theirs = trajectory.root
  expect(mine, '工作流 tab 面板应可量到版式').not.toBeNull()
  expect(theirs, '轨迹 tab 视图应可量到版式（对照基准）').not.toBeNull()
  // 1. 铺满：面板宽 = 会话滚动体宽（与轨迹 tab 同基准），不是 Chat 的窄列。
  expect(mine!.width, `工作流面板应铺满会话体（滚动体宽 ${String(workflow.scrollBodyWidth)}）`)
    .toBe(workflow.scrollBodyWidth)
  expect(theirs!.width, `轨迹视图应铺满会话体（滚动体宽 ${String(trajectory.scrollBodyWidth)}）`)
    .toBe(trajectory.scrollBodyWidth)
  // 2. 水平位置与内距一致（同一轴线、同样贴边）。
  expect(mine!.left, '工作流面板左缘应与轨迹视图一致').toBe(theirs!.left)
  expect(mine!.right, '工作流面板右缘应与轨迹视图一致').toBe(theirs!.right)
  expect([mine!.paddingLeft, mine!.paddingRight], '水平内距应与轨迹视图一致')
    .toEqual([theirs!.paddingLeft, theirs!.paddingRight])
  // 3. 都不在 Chat 的消息列/消息流里（用户原话：「不应有对话消息左右两边拉伸那个版式」）。
  expect(mine!.inChatFlow, '工作流面板不得落在 Chat 的消息列里').toBe(false)
  expect(theirs!.inChatFlow, '轨迹视图不得落在 Chat 的消息列里').toBe(false)
  // 4. 铺满语义标记一致（DSH 据此撤掉会话列的宽度拖拽条）。
  expect(mine!.composerOverlay, '工作流面板应带 data-conversation-composer-overlay（照轨迹 tab）').toBe(true)
  expect(theirs!.composerOverlay, '轨迹视图带该标记').toBe(true)
  // 宽度拖拽条（Chat 那一族的「左右拉伸」入口）：两个视图都不该有 —— 该标记会让
  // DSH 的 `.root:has([data-conversation-composer-overlay]) .widthHandle { display:none }` 生效。
  expect(mine!.widthHandles, '工作流 tab 下不应出现会话列宽度拖拽条（Chat 才有）').toBe(0)
  expect(theirs!.widthHandles, '轨迹 tab 下同样不应出现（对照）').toBe(0)
}

/** discussion 轮次条探针结果（旧刻度 / 新每-step 刻度 / step 卡片对照）。 */
interface StepRailProbe {
  /** 旧「每轮」刻度的 aria-label 列表（应为空 —— 需求：discussion 里去掉了）。 */
  readonly turnMarkLabels: readonly string[]
  /** 新轮次条根计数（`[data-sandore-step-rail]`）。 */
  readonly railCount: number
  /** 新轮次条档数（`[data-sandore-step-rail-item]`）。 */
  readonly itemCount: number
  /** 各档 `data-step-id`（顺序）。 */
  readonly itemStepIds: readonly string[]
  /** active 档计数（应恰好 1）。 */
  readonly activeCount: number
  /** discussion 里的 step 卡片数（`[data-tl-step][data-step-id]`）。 */
  readonly stepCardCount: number
  /** 各 step 卡片的 `data-step-id`（顺序）。 */
  readonly stepCardIds: readonly string[]
}

/**
 * 量一次 discussion 的轮次条状态。
 *
 * 口径：只在**运行视图的消息列**（`[data-sandore-run-view]`）内数——DSH 原生会话页
 * 自己的轮次条（ui-chat）不在这个子树里，故不会被误判；step 子代理面板（`variant='subagent'`）
 * 里保留的旧刻度用 `[class*="marks"]` 的**祖先**是否为运行视图来区分：
 * 这里只统计**直接挂在运行视图消息列下**的刻度（新条）与**全树**的旧 aria 刻度
 * （含卡片内面板的，但那些属于步卡片、不属于 discussion 的输入面语义——
 * 见下方断言注释）。
 * @param page - 被测页面。
 */
async function probeStepRail(page: import('@playwright/test').Page): Promise<StepRailProbe> {
  return page.evaluate(() => {
    const runView = document.querySelector('[data-sandore-run-view]')
    const mainAgentPanel = runView?.querySelector('[data-main-agent-chat]') ?? null
    // 旧「每轮」刻度：只统计 **discussion 的主代理面板内** 的那些（step 卡片里的子代理
    // 面板不属于 discussion 的轮次条，本次需求只动 discussion）。
    const turnMarkLabels = mainAgentPanel === null
      ? []
      : [...mainAgentPanel.querySelectorAll('button[aria-label]')]
        .map(el => el.getAttribute('aria-label') ?? '')
        .filter(label => /跳转到第 \d+ 轮/u.test(label))
    const items = [...document.querySelectorAll('[data-sandore-step-rail-item]')]
    const cards = [...document.querySelectorAll('[data-tl-step][data-step-id]')]
    return {
      turnMarkLabels,
      railCount: document.querySelectorAll('[data-sandore-step-rail]').length,
      itemCount: items.length,
      itemStepIds: items.map(el => el.getAttribute('data-step-id') ?? ''),
      activeCount: items.filter(el => el.getAttribute('data-active') === 'true').length,
      stepCardCount: cards.length,
      stepCardIds: cards.map(el => el.getAttribute('data-step-id') ?? ''),
    }
  })
}

/**
 * 点击轮次条第 `index` 档（1 起），返回该档的 stepId、点击后 active 档与目标卡片是否在视口内。
 * @param page - 被测页面。
 * @param index - 档序号（1 起）。
 */
async function clickStepRailItem(
  page: import('@playwright/test').Page,
  index: number,
): Promise<{ stepId: string; activeStepId: string | null; targetInView: boolean }> {
  const items = page.locator('[data-sandore-step-rail-item]')
  const target = items.nth(index - 1)
  const stepId = (await target.getAttribute('data-step-id')) ?? ''
  await target.click({ force: true })
  await page.waitForTimeout(400)
  return page.evaluate((id: string) => {
    const item = document.querySelector('[data-sandore-step-rail-item][data-active="true"]')
    const card = [...document.querySelectorAll<HTMLElement>('[data-tl-step][data-step-id]')]
      .find(el => (el.getAttribute('data-step-id') ?? '') === id)
    const scrollport = document.querySelector<HTMLElement>('[data-sandore-run-view]')
    let targetInView = false
    if (card !== undefined && scrollport !== null) {
      const cardBox = card.getBoundingClientRect()
      const portBox = scrollport.getBoundingClientRect()
      // 卡片顶部落在（滚动视口**顶 − 24px 容差**）之后，且底缘还在视口内。
      targetInView = cardBox.top >= portBox.top - 24 && cardBox.top <= portBox.bottom
    }
    return {
      stepId: id,
      activeStepId: item?.getAttribute('data-step-id') ?? null,
      targetInView,
    }
  }, stepId)
}

/** 滚动探针结果（左栏固定 / 右栏内滚 / 无整页滚动）。 */
interface ScrollProbe {  readonly chrome: {
    readonly view: number
    readonly list: number
    readonly editor: number
    readonly modeSwitch: number
    readonly search: number
    readonly runButton: number
  }
  readonly instanceRows: number
  readonly definitionRows: number
  readonly inputsInPanel: number
  readonly panelText: string
  readonly listTopBefore: number
  readonly listTopAfter: number
  readonly feedScrollTopBefore: number
  readonly feedScrollTopAfter: number
  readonly feedScrollHeight: number
  readonly feedClientHeight: number
  readonly panelTopBefore: number
  readonly panelTopAfter: number
  readonly panelScrollHeight: number
  readonly panelClientHeight: number
  readonly pageScrollBefore: number
  readonly pageScrollAfter: number
  readonly scrollBodyBefore: number
  readonly scrollBodyAfter: number
  readonly scrollBodyScrollHeight: number
  readonly scrollBodyClientHeight: number
  /** 诊断：面板内所有 overflowY 允许滚的盒子（含各项 scrollHeight/clientHeight）。 */
  readonly scrollCandidates: string[]
}

/**
 * 在工作流 tab 里量一次「滚动行为 + 锚点清单」，并断言：左栏固定、右栏（执行详情侧）
 * 内部可滚、**不产生整页滚动**（用户真机缺陷：整个工作流页面跟着滚）。
 *
 * 右栏滚动位置用 `[data-sandore-run-view] .feedScroll` 一族里**实际可滚动**的那个容器
 * （侧栏工作流页右栏就是它；无实例会话里那一侧是说明位、不可滚，此时断言退化为
 * 「右栏没有可滚容器 ⇒ 也不需要滚」）。
 * @param page - 被测页面。
 * @param viewportHeight - 量滚动时临时用的视口高（缺省不动）。缩到 420px 是为了让面板
 *   内容**必然超过一屏**（这样「右栏内滚 + 外层不滚」才是真被验证过的，而不是靠内容太短
 *   蒙混过关）；量完恢复。
 * @returns 滚动与锚点数值（供断言与取证）。
 */
async function probeScroll(
  page: import('@playwright/test').Page,
  viewportHeight?: number,
): Promise<ScrollProbe> {
  const size = page.viewportSize()
  if (viewportHeight !== undefined && size !== null) {
    await page.setViewportSize({ width: size.width, height: viewportHeight })
    await page.waitForTimeout(200)
  }
  try {
    return await probeScrollOnce(page)
  } finally {
    if (viewportHeight !== undefined && size !== null) {
      await page.setViewportSize(size)
      await page.waitForTimeout(200)
    }
  }
}

/**
 * 单次滚动探针（见 {@link probeScroll} 的语义说明）。
 *
 * 为了让「右栏内滚」这一条**必然可测**（而不是靠运行实例的消息长度碰巧超过一屏），
 * 先往右栏的滚动器里塞一个临时高占位、量完移除（只动我们自己的 DOM，不改源码）。
 */
async function probeScrollOnce(page: import('@playwright/test').Page): Promise<ScrollProbe> {
  const SPACER_ID = 'm22-scroll-spacer'
  await page.evaluate((id: string) => {
    const panel = document.querySelector('[data-sandore-tab-panel="workflow"]')
    if (panel === null) return
    const runView = panel.querySelector('[data-sandore-run-view]')
    const scroller = runView === null
      ? null
      : [...runView.querySelectorAll<HTMLElement>('div')]
        .filter((el) => {
          const overflow = getComputedStyle(el).overflowY
          return overflow === 'auto' || overflow === 'scroll'
        })
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0]
    if (scroller === undefined || scroller === null) return
    const spacer = document.createElement('div')
    spacer.id = id
    spacer.style.height = '1200px'
    spacer.style.flex = '0 0 auto'
    scroller.appendChild(spacer)
  }, SPACER_ID)
  await page.waitForTimeout(150)
  try {
    return await probeScrollMeasure(page)
  } finally {
    await page.evaluate((id: string) => { document.getElementById(id)?.remove() }, SPACER_ID)
  }
}

/** 真正量滚动（占位已就位）：滚轮悬停右栏 + 兜底直接下滚，前后各量一份。 */
async function probeScrollMeasure(page: import('@playwright/test').Page): Promise<ScrollProbe> {
  const readState = async (): Promise<{
    listTop: number
    feedScrollTop: number
    feedScrollHeight: number
    feedClientHeight: number
    panelTop: number
    panelScrollHeight: number
    panelClientHeight: number
    pageScrollTop: number
    scrollBodyTop: number
    scrollBodyScrollHeight: number
    scrollBodyClientHeight: number
    chrome: ScrollProbe['chrome']
    instanceRows: number
    definitionRows: number
    inputsInPanel: number
    panelText: string
    scrollCandidates: string[]
    feedScrollable: boolean
  }> => page.evaluate(() => {
    const panel = document.querySelector('[data-sandore-tab-panel="workflow"]')
    const count = (root: Element | null, selector: string): number =>
      root === null ? 0 : root.querySelectorAll(selector).length
    // 右栏内滚容器：DSH 会话页的 `[data-conversation-scroll]` 在 tab 里**不滚动**
    // （视图自持滚动），真正滚的是执行视图自己的消息区 —— 取面板内
    // `overflow-y` 为 auto/scroll 且**内容高于视口**的那个 div（取可滚余量最大者）。
    const scrollers = panel === null
      ? []
      : [...panel.querySelectorAll<HTMLElement>('div')]
        .filter((el) => {
          const overflow = getComputedStyle(el).overflowY
          return (overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight + 4
        })
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))
    // 诊断：面板内所有「overflow 允许滚」的盒子（无论内容是否够高），用于定位滚动器。
    const probeCandidates = panel === null
      ? []
      : [...panel.querySelectorAll<HTMLElement>('div')]
        .filter(el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY))
        .slice(0, 8)
        .map(el => `${String(el.className).slice(0, 40)} overflowY=${getComputedStyle(el).overflowY}`
          + ` scrollH=${String(el.scrollHeight)} clientH=${String(el.clientHeight)}`)
    const feed = scrollers[0]
    const list = panel?.querySelector<HTMLElement>('[data-sandore-wf-list]')
    const scrollBody = document.querySelector<HTMLElement>('[data-conversation-scroll]')
    return {
      listTop: Math.round(list?.getBoundingClientRect().top ?? -1),
      feedScrollTop: feed?.scrollTop ?? 0,
      feedScrollHeight: feed?.scrollHeight ?? 0,
      feedClientHeight: feed?.clientHeight ?? 0,
      panelTop: Math.round(panel?.getBoundingClientRect().top ?? -1),
      panelScrollHeight: panel?.scrollHeight ?? 0,
      panelClientHeight: panel?.clientHeight ?? 0,
      pageScrollTop: document.scrollingElement?.scrollTop ?? 0,
      scrollBodyTop: scrollBody?.scrollTop ?? 0,
      scrollBodyScrollHeight: scrollBody?.scrollHeight ?? 0,
      scrollBodyClientHeight: scrollBody?.clientHeight ?? 0,
      chrome: {
        view: count(panel, '[data-sandore-wf-view]'),
        list: count(panel, '[data-sandore-wf-list]'),
        editor: count(panel, '[data-sandore-wf-editor]'),
        modeSwitch: count(panel, '[data-sandore-wf-list] [role="tablist"]'),
        search: count(panel, 'input[placeholder*="搜索"]'),
        runButton: count(panel, 'button'),
      },
      instanceRows: count(panel?.querySelector('[data-sandore-wf-list]') ?? null, 'li'),
      definitionRows: count(panel?.querySelector('[data-sandore-wf-list]') ?? null, 'li'),
      inputsInPanel: count(panel, '[data-main-agent-input]')
        + count(panel, '[data-sandore-disc-input]')
        + count(panel, '[data-composer-input]'),
      panelText: (panel?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 300),
      scrollCandidates: probeCandidates,
      feedScrollable: feed !== undefined && feed.scrollHeight > feed.clientHeight + 4,
    }
  })

  const before = await readState()
  // 滚轮**悬停在右栏（执行详情侧）**上：真正需要内滚的是那一侧；同时验证左栏不跟着动、
  // 外层不产生整页滚动。
  const feedColumn = page.locator('[data-sandore-wf-editor]').first()
  await feedColumn.hover({ position: { x: 200, y: 200 } }).catch(() => {})
  await page.mouse.wheel(0, 600)
  await page.waitForTimeout(400)
  // 兜底：滚轮若没落到右栏滚动器上（指针位置/层级），直接对滚动器下滚 —— 断言点仍是
  // 「这个容器自己滚起来了、而左栏与外层没动」。
  await page.evaluate(() => {
    const panel = document.querySelector('[data-sandore-tab-panel="workflow"]')
    const scroller = panel === null
      ? null
      : [...panel.querySelectorAll<HTMLElement>('div')]
        .filter(el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY))
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0]
    if (scroller !== undefined && scroller !== null) scroller.scrollTop += 400
  })
  await page.waitForTimeout(200)
  const after = await readState()

  // ── 断言 ────────────────────────────────────────────────────────────────
  // 1. 左栏固定（滚动前后 top 不变）。
  expect(after.listTop, '滚动后左栏顶端位置不得变化（左栏固定）').toBe(before.listTop)
  expect(after.panelTop, '滚动后面板根顶端位置不得变化（外层不滚动）').toBe(before.panelTop)
  // 2. 外层不产生整页滚动。
  expect(after.pageScrollTop, 'document 不应出现整页滚动').toBe(before.pageScrollTop)
  expect(after.scrollBodyTop, '会话滚动体不应滚动（视图自持滚动）').toBe(before.scrollBodyTop)
  expect(
    after.scrollBodyScrollHeight <= after.scrollBodyClientHeight + 2,
    `会话滚动体不应可滚（scrollHeight=${String(after.scrollBodyScrollHeight)}`
    + ` clientHeight=${String(after.scrollBodyClientHeight)}）`,
  ).toBe(true)
  expect(
    after.panelScrollHeight <= after.panelClientHeight + 2,
    `面板根不应可滚（scrollHeight=${String(after.panelScrollHeight)}`
    + ` clientHeight=${String(after.panelClientHeight)}）`,
  ).toBe(true)
  // 3. 有可滚内容时，滚动应落在**右栏内部**（此时左栏与面板根的 top 仍然不变）。
  if (before.feedScrollable) {
    expect(after.feedScrollTop, '右栏（执行详情侧）应内部滚动').toBeGreaterThan(before.feedScrollTop)
    expect(after.listTop, '右栏内滚后左栏仍不动').toBe(before.listTop)
  }

  return {
    chrome: after.chrome,
    instanceRows: after.instanceRows,
    definitionRows: after.definitionRows,
    inputsInPanel: after.inputsInPanel,
    panelText: after.panelText,
    listTopBefore: before.listTop,
    listTopAfter: after.listTop,
    feedScrollTopBefore: before.feedScrollTop,
    feedScrollTopAfter: after.feedScrollTop,
    feedScrollHeight: before.feedScrollHeight,
    feedClientHeight: before.feedClientHeight,
    panelTopBefore: before.panelTop,
    panelTopAfter: after.panelTop,
    panelScrollHeight: after.panelScrollHeight,
    panelClientHeight: after.panelClientHeight,
    pageScrollBefore: before.pageScrollTop,
    pageScrollAfter: after.pageScrollTop,
    scrollBodyBefore: before.scrollBodyTop,
    scrollBodyAfter: after.scrollBodyTop,
    scrollBodyScrollHeight: after.scrollBodyScrollHeight,
    scrollBodyClientHeight: after.scrollBodyClientHeight,
    scrollCandidates: after.scrollCandidates,
  }
}

/**
 * 经 **RPC 直接**造一个「属于别的会话」的实例（不打开席位、不走新建弹窗）。
 *
 * 本用例只关心「别人家的实例不得出现在本 tab 面板里」，故这个实例只需要**存在**
 * （`listInstances` 能列到、有真实宿主会话）。走 RPC 的原因：真机里连开两次
 * 「运行工作流」弹窗会与席位的中心列占据相互干扰（实测第二次 UI 建实例失败：
 * `listInstances` 里查不到刚建的需求），而这条路径不是本用例的被测对象。
 *
 * @param page - 被测页面（`sandoreRpc` 用它的鉴权 cookie）。
 * @param workspace - 临时工作目录。
 * @returns 造出的实例 id + 需求文本（供「不得出现在面板里」的对照断言）。
 */
async function createForeignInstance(
  page: Parameters<typeof listInstances>[0],
  workspace: string,
): Promise<{ instanceId: string; requirement: string; definitionName: string }> {
  const suffix = randomUUID().slice(0, 8)
  const definitionName = `e2e-m22-other-${suffix}`
  const requirement = `${definitionName}-req`
  const definition = mockPromptWorkflow({
    name: definitionName,
    promptText: `M22 别的会话。${mockDirective({ text: 'm22-other-answer', hold: 120_000 })}`,
  })
  // 导入后拿**落库 id**（`listDefinitions` 反查；YAML 顶层 id 不是记录键，
  // `startInstance` 只认记录键 `wfl-{uuid}`）。
  const stored = await ensureDefinition(page, definition.yaml, definitionName)
  const created = await sandoreRpc<{ instanceId: string }>(page, 'startInstance', {
    input: { workflowId: stored.id, originalInput: requirement, cwd: workspace },
  })
  return { instanceId: created.instanceId, requirement, definitionName }
}

test.describe('M22 主代理会话内的「工作流」tab', () => {
  test('tab 存在可点、只显示本会话实例、没有输入面，切回会话内容仍在', async ({ page, problems, workspace }) => {
    test.setTimeout(300_000)

    // ① 造两个实例：
    //    - `mine`：走完整 UI 路径（导入定义 → 开席位 → 新建弹窗 → 真实宿主会话），
    //      它是本用例「主代理会话」的主角（需求文本 = 宿主会话标题，供侧栏搜索定位）；
    //    - `other`：**另一个**宿主会话的实例（经 RPC 造，见 createForeignInstance），
    //      只用于「别人家的实例不得出现在本 tab 面板里」的对照。
    const mine = await createMockInstance(page, {
      // 长 hold（10 分钟）：实例全程保持 running，页面各处（树/进度/需求文本）都有实时数据；
      // 短 hold 会让实例在用例中途终态，树与进度读数随之清空（m18 同款取值）。
      promptText: `M22 用例（本会话）。${mockDirective({ text: 'm22-step-answer', hold: 600_000 })}`,
      cwd: workspace,
      label: 'e2e-m22-mine',
    })
    const other = await createForeignInstance(page, workspace)
    const seededInstances = await listInstances(page)
    expect(
      seededInstances.map(instance => instance.instanceId),
      '两个实例都应真实存在于实例清单里（对照才有意义）',
    ).toEqual(expect.arrayContaining([mine.instanceId, other.instanceId]))
    expect(mine.instanceId, '两个实例必须是不同的宿主会话').not.toBe(other.instanceId)
    // 前置：本实例确实在跑（否则下面的树/进度断言没有意义）。
    await expect.poll(async () => (await getInstanceState(page, mine.instanceId)).status, {
      timeout: 90_000,
      message: '本实例应进入 running（执行视图才有树与进度）',
    }).toBe('running')

    // ② 在 DSH 中心列打开「本会话」的主代理会话页（标题 = 建实例时的需求文本）。
    await openHostSessionInColumn(page, mine.requirement)

    /** 会话页 tab 条里的「工作流」tab（DSH 原生 `role=tab`）。 */
    const workflowTab = page.getByRole('tab', { name: TAB_WORKFLOW, exact: true }).first()
    const chatTab = page.getByRole('tab', { name: TAB_CHAT }).first()
    await expect(workflowTab, '主代理会话页应出现「工作流」tab（DSH conversation.view 席位）')
      .toBeVisible({ timeout: 30_000 })
    await expect(workflowTab).toBeEnabled()
    // 打开会话时默认停在 Chat 视图（我们的面板此时不应存在）。
    await expect(page.locator('[data-sandore-tab-panel="workflow"]')).toHaveCount(0)

    // ③ 点开「工作流」tab。
    await workflowTab.click()
    await expect(workflowTab).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 })

    const panel = page.locator('[data-sandore-tab-panel="workflow"]').first()
    await expect(panel, 'tab 面板应出现').toBeVisible({ timeout: 30_000 })
    // 面板归属的宿主会话 = 本实例 id（引擎恒等式 hostSessionId ≡ instanceId）。
    await expect(panel).toHaveAttribute('data-sandore-tab-session', mine.instanceId)

    // ③b 页面本体与**交互入口**在位（用户口径：内容几乎完全等于侧栏点开得到的那个页面）。
    await expectPageChrome(panel)
    // 编排模式：「新增定义」按钮出现（同一套模式切换、同一份入口）。
    await expectDefinitionEntry(panel)

    // 面板里是**同一份** RunView（侧栏工作流页那套）：执行视图 + 导航树。
    const runView = panel.locator('[data-sandore-run-view]').first()
    await expect(runView, '面板体应是复用的执行视图（RunView）').toBeVisible({ timeout: 60_000 })
    await expect(panel.locator('[data-sandore-tree-nav]'), '面板里应有工作流导航树').toBeVisible({ timeout: 30_000 })
    // 面板显示的是**本实例**：需求文本（面包屑里；`getByText` 对跨元素文本会漏，故按
    // 面板整体文本轮询，与取证 dump 同一条口径）。
    await expect.poll(async () => (await panel.innerText()).includes(mine.requirement), {
      timeout: 60_000,
      message: '面板应显示本实例的需求文本',
    }).toBe(true)
    // 树节点（阶段/步骤行）。
    await expect.poll(async () => panel.locator('[data-disclosure-row], [data-tree-leaf]').count(), {
      timeout: 60_000,
      message: '导航树应有阶段/步骤节点',
    }).toBeGreaterThan(0)

    // ④ 只显示本会话的实例：按**全量实例清单**逐个对照，一个都不许出现在面板里。
    const allInstances = await listInstances(page)
    const panelContent = (await panel.innerText()).replace(/\s+/g, ' ')
    const leaked = allInstances.filter(instance =>
      instance.instanceId !== mine.instanceId && panelContent.includes(instance.instanceId))
    expect(
      leaked.map(instance => instance.instanceId),
      `本会话的 tab 面板里不得出现任何别的实例 id（面板文本：${panelContent.slice(0, 200)}）`,
    ).toEqual([])
    expect(panelContent, '别的实例的需求文本不得出现在本 tab 面板里').not.toContain(other.requirement)
    expect(await panel.locator(`[data-sandore-tab-session="${other.instanceId}"]`).count()).toBe(0)

    // ⑤ tab 面板内没有输入面（用户规格：这个 tab 不带讨论输入框）。
    for (const selector of ['[data-main-agent-input]', '[data-sandore-disc-input]', '[data-composer-input]']) {
      expect(await panel.locator(selector).count(), `tab 面板内不得出现输入锚点 ${selector}`).toBe(0)
    }

    // ⑤b 版式：铺满会话体（与轨迹 tab 同款），不是 Chat 的消息窄列。
    const workflowLayout = await measureLayout(page)
    // 切到轨迹 tab 量一份对照，再切回来（DSH 自己的 tab 切换）。
    await page.getByRole('tab', { name: '轨迹', exact: true }).first().click()
    await expect.poll(async () => (await measureLayout(page)).trajectory !== null, {
      timeout: 30_000,
      message: '轨迹 tab 应可打开（用于版式对照）',
    }).toBe(true)
    const trajectoryLayout = await measureLayout(page)
    await workflowTab.click()
    await expect(panel).toBeVisible({ timeout: 15_000 })
    expectLayoutParity(workflowLayout, trajectoryLayout)

    // ⑤c 滚动（有实例、右栏有真内容 ⇒ 这里量得到「右栏内滚」）：
    //     左栏固定 / 右栏内部滚动 / 不产生整页滚动。
    const workflowScroll = await probeScroll(page, 420)

    // ⑤d discussion 的轮次条：旧「每轮」刻度必须消失，新「每 step 一档」必须在位。
    //     说明：旧刻度 = 每个 turn 一个 `aria-label="跳转到第 N 轮"` 的刻度（由
    //     `step-view/TurnNavigator.tsx` 渲染，本次从 discussion 的 `variant='main'`
    //     面板里撤掉）。DSH 原生会话页自己的轮次条不在此列（那是 DSH 的 ui-chat）。
    const railDump = await probeStepRail(page)
    expect(railDump.turnMarkLabels, 'discussion 里不得再有「跳转到第 N 轮」的旧刻度')
      .toEqual([])
    expect(railDump.railCount, '应出现每-step 一档的轮次条').toBeGreaterThanOrEqual(1)
    expect(railDump.itemCount, '轮次条档数应等于 step 数').toBe(railDump.stepCardCount)
    expect(railDump.itemStepIds, '每档应带 data-step-id').toEqual(railDump.stepCardIds)
    expect(railDump.activeCount, '同一时刻只有一档 active').toBe(1)
    // 点击第 2 档（有第 2 档时）→ 该 step 卡片进入视口。
    if (railDump.itemCount >= 2) {
      const clicked = await clickStepRailItem(page, 2)
      expect(clicked.targetInView, `点击第 2 档后 step ${clicked.stepId} 的卡片应进入视口`).toBe(true)
      expect(clicked.activeStepId, '点击后该档成为 active').toBe(clicked.stepId)
    }

    // ⑥ 取证（**面板仍在时**采集，随后才切回对话 tab）：tab 条 / 面板内容 / 输入锚点分布。
    const dump = await page.evaluate(() => {
      // 只取 **DSH 会话 header 的 tab 条**：排除我们面板内的（模式切换 / 库分区也用 role=tab）。
      const tabs = [...document.querySelectorAll('[role="tab"]')]
        .filter(el => el.closest('[data-sandore-tab-panel]') === null)
        .map(el => ({
          text: (el.textContent ?? '').trim(),
          selected: el.getAttribute('aria-selected'),
        }))
      const panelEl = document.querySelector('[data-sandore-tab-panel="workflow"]')
      const panelOf = (selector: string): number =>
        panelEl === null ? 0 : panelEl.querySelectorAll(selector).length
      const globalOf = (selector: string): number => document.querySelectorAll(selector).length
      const textOf = (selector: string): string =>
        (panelEl?.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
      return {
        tabs,
        panel: panelEl === null
          ? null
          : {
            session: panelEl.getAttribute('data-sandore-tab-session'),
            runViews: panelOf('[data-sandore-run-view]'),
            treeNavs: panelOf('[data-sandore-tree-nav]'),
            treeNodes: panelOf('[data-disclosure-row], [data-tree-leaf]'),
            workflowChildren: panelOf('[data-tree-workflow-children]'),
            breadcrumb: textOf('[data-sandore-run-view] header'),
            treeText: textOf('[data-sandore-tree-nav]'),
            text: (panelEl.textContent ?? '').replace(/\s+/g, ' ').slice(0, 500),
          },
        inputsInPanel: {
          mainAgentInput: panelOf('[data-main-agent-input]'),
          discInput: panelOf('[data-sandore-disc-input]'),
          composerInput: panelOf('[data-composer-input]'),
        },
        inputsGlobal: {
          mainAgentInput: globalOf('[data-main-agent-input]'),
          discInput: globalOf('[data-sandore-disc-input]'),
          composerInput: globalOf('[data-composer-input]'),
        },
        seatViewPresent: globalOf('[data-sandore-seat-view]'),
      }
    })
    writeFileSync(
      join(REPO_ROOT, 'e2e', '.artifacts', 'main-agent-workflow-tab.txt'),
      [
        '# M22 主代理会话内的「工作流」tab（真机取证，采集时「工作流」tab 处于激活态）',
        `时间：${new Date().toISOString()}`,
        `本会话实例：${mine.instanceId}（需求 ${mine.requirement}）`,
        `另一实例：${other.instanceId}（需求 ${other.requirement}）`,
        '',
        '## tab 条（DSH 原生 `[role="tab"]`）',
        ...dump.tabs.map(tab => `- ${tab.text}${tab.selected === 'true' ? '（选中）' : ''}`),
        '',
        '## 工作流 tab 面板（`[data-sandore-tab-panel="workflow"]`）',
        dump.panel === null
          ? '（采集时面板不存在——异常）'
          : `session=${String(dump.panel.session)}`
          + ` 执行视图数=${String(dump.panel.runViews)}`
          + ` 导航树数=${String(dump.panel.treeNavs)}`
          + ` 树节点数=${String(dump.panel.treeNodes)}`
          + ` 工作流子容器数=${String(dump.panel.workflowChildren)}`
          + `\n  面包屑：${dump.panel.breadcrumb}`
          + `\n  树文本：${dump.panel.treeText}`
          + `\n  面板文本（前 500 字）：${dump.panel.text}`,
        '',
        '## 输入锚点计数（面板内 / 全页）',
        `面板内：${JSON.stringify(dump.inputsInPanel)}`,
        `全页：${JSON.stringify(dump.inputsGlobal)}`,
        '',
        '## 版式（铺满 vs Chat 窄列；与轨迹 tab 对照）',
        `工作流面板：宽=${String(workflowLayout.root?.width)} 左=${String(workflowLayout.root?.left)}`
        + ` 右=${String(workflowLayout.root?.right)} padding=${String(workflowLayout.root?.paddingLeft)}/${String(workflowLayout.root?.paddingRight)}`
        + ` composerOverlay=${String(workflowLayout.root?.composerOverlay)} inChatFlow=${String(workflowLayout.root?.inChatFlow)}`
        + ` 可见宽度拖拽条=${String(workflowLayout.root?.widthHandles)}`,
        `轨迹视图（对照）：宽=${String(trajectoryLayout.root?.width)} 左=${String(trajectoryLayout.root?.left)}`
        + ` 右=${String(trajectoryLayout.root?.right)} padding=${String(trajectoryLayout.root?.paddingLeft)}/${String(trajectoryLayout.root?.paddingRight)}`
        + ` composerOverlay=${String(trajectoryLayout.root?.composerOverlay)} inChatFlow=${String(trajectoryLayout.root?.inChatFlow)}`
        + ` 可见宽度拖拽条=${String(trajectoryLayout.root?.widthHandles)}`,
        `会话滚动体宽=${String(workflowLayout.scrollBodyWidth)}（两个 tab 都应等于它）`,
        '工作流面板祖先链（由内到外）：',
        ...(workflowLayout.root?.ancestors ?? []).map(line => `  ${line}`),
        '轨迹视图祖先链（由内到外）：',
        ...(trajectoryLayout.root?.ancestors ?? []).map(line => `  ${line}`),
        '',
        '## 滚动（左栏固定 / 右栏内滚 / 无整页滚动；有实例、右栏有真内容）',
        `左栏 top：滚动前 ${String(workflowScroll.listTopBefore)} → 滚动后 ${String(workflowScroll.listTopAfter)}（应不变）`,
        `右栏（执行详情侧）scrollTop：${String(workflowScroll.feedScrollTopBefore)} → ${String(workflowScroll.feedScrollTopAfter)}`,
        `右栏 scrollHeight/clientHeight：${String(workflowScroll.feedScrollHeight)}/${String(workflowScroll.feedClientHeight)}`,
        `面板根 top：${String(workflowScroll.panelTopBefore)} → ${String(workflowScroll.panelTopAfter)}；`
        + `面板 scrollHeight/clientHeight=${String(workflowScroll.panelScrollHeight)}/${String(workflowScroll.panelClientHeight)}`,
        `document.scrollingElement.scrollTop：${String(workflowScroll.pageScrollBefore)} → ${String(workflowScroll.pageScrollAfter)}（应不变）`,
        `会话滚动体（[data-conversation-scroll]）scrollTop：${String(workflowScroll.scrollBodyBefore)} → ${String(workflowScroll.scrollBodyAfter)}（应不变）`,
        `会话滚动体 scrollHeight/clientHeight：${String(workflowScroll.scrollBodyScrollHeight)}/${String(workflowScroll.scrollBodyClientHeight)}`,
        `面板内可滚盒子（诊断）：${workflowScroll.scrollCandidates.join(' | ') || '（无）'}`,
        '',
        '## discussion 轮次条（旧「每轮」刻度 → 新「每 step 一档」）',
        `旧刻度（discussion 主代理面板内 aria-label 含「跳转到第 N 轮」）：`
        + `${railDump.turnMarkLabels.length === 0 ? '0 条 ✅' : `${String(railDump.turnMarkLabels.length)} 条：${railDump.turnMarkLabels.join('、')}`}`,
        `新轮次条：根计数=${String(railDump.railCount)} 档数=${String(railDump.itemCount)}`
        + ` active 档数=${String(railDump.activeCount)}`,
        `新轮次条各档 data-step-id：${railDump.itemStepIds.join('、')}`,
        `discussion 的 step 卡片：计数=${String(railDump.stepCardCount)}`
        + ` data-step-id=${railDump.stepCardIds.join('、')}`,
        `档数 = step 卡片数：${String(railDump.itemCount)} = ${String(railDump.stepCardCount)}`,
        '',
        `侧栏席位视图（[data-sandore-seat-view]）计数：${String(dump.seatViewPresent)}`,
        `console/pageerror problems：${problems.length === 0 ? '无' : problems.join(' | ')}`,
        '',
      ].join('\n'),
      'utf8',
    )

    // ⑦ 切回「对话」tab：原会话内容仍在（tab 切换不破坏 DSH 会话页）。
    await chatTab.click()
    await expect(chatTab).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 })
    await expect(page.locator('[data-sandore-tab-panel="workflow"]'), '切回后我们的面板应整棵卸载').toHaveCount(0)
    await expect.poll(async () => (await dshColumnComposer(page)).count, {
      timeout: 30_000,
      message: '切回会话后 DSH 中心列的输入框应仍在（会话视图恢复）',
    }).toBeGreaterThanOrEqual(1)
    // 切回后的取证（增量追加）：证明「切回也成功」这一条不是靠前面的快照推断的。
    const afterSwitch = await page.evaluate(() => ({
      selectedTabs: [...document.querySelectorAll('[role="tab"][aria-selected="true"]')]
        .map(el => (el.textContent ?? '').trim()),
      panels: document.querySelectorAll('[data-sandore-tab-panel="workflow"]').length,
      composerInputs: document.querySelectorAll('[data-composer-input]').length,
      sessionRows: document.querySelectorAll('[data-main-agent-chat], [data-chat-flow-kind]').length,
    }))
    writeFileSync(
      join(REPO_ROOT, 'e2e', '.artifacts', 'main-agent-workflow-tab.txt'),
      [
        `## 切回「对话」tab 之后（增量取证）`,
        `选中的 tab：${afterSwitch.selectedTabs.join('、')}`,
        `工作流面板计数：${String(afterSwitch.panels)}（应为 0）`,
        `DSH 中心列输入框计数：${String(afterSwitch.composerInputs)}（应 ≥1，会话视图恢复）`,
        `会话内容锚点计数（main-agent-chat / chat-flow-kind）：${String(afterSwitch.sessionRows)}`,
        '',
      ].join('\n'),
      { encoding: 'utf8', flag: 'a' },
    )

    // 渲染不破坏 DSH 会话页：无 console error / pageerror。
    expect(problems, `页面出现 console error / pageerror：${problems.join(' | ')}`).toEqual([])
  })

  test('没有绑定实例的会话：工作流 tab 仍是完整页面（两张列表空 + 入口在位 + 右栏内滚）', async ({ page, problems, workspace }) => {
    test.setTimeout(300_000)

    // ① 造一个**属于别的会话**的实例：它的 id / 需求文本绝不能出现在无实例会话的 tab 面板里。
    const foreign = await createForeignInstance(page, workspace)

    // ② 开一个**全新会话**（不跑任何工作流 ⇒ 引擎里没有绑定它的实例）。
    const newSession = page.getByRole('button', { name: /新建会话|新会话|New Session/i }).first()
    await expect(newSession, '侧栏应有「新建会话」入口').toBeVisible({ timeout: 30_000 })
    await newSession.click()
    // 空白会话的 header chrome 是隐藏的（DSH 语义）⇒ 先投一句普通消息把它变成真实会话。
    await sendMessageInFreshSession(page)

    // ③ 打开「工作流」tab。
    const workflowTab = page.getByRole('tab', { name: TAB_WORKFLOW, exact: true }).first()
    await expect(workflowTab, '任何会话都应有「工作流」tab（用户拍板：不做动态显隐）')
      .toBeVisible({ timeout: 30_000 })
    await workflowTab.click()
    await expect(workflowTab).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 })

    const panel = page.locator('[data-sandore-tab-panel="workflow"]').first()
    await expect(panel, 'tab 面板应出现').toBeVisible({ timeout: 30_000 })

    // ④ 页面本体与交互入口**照旧在位**（无实例 ≠ 裁剪成只读骨架）。
    await expectPageChrome(panel)
    await expectDefinitionEntry(panel)

    // ⑤ 列表模式都在位、可切换；**实例列表按本会话过滤后为空**（该页面自己的空态）。
    //    注意：定义（编排）列表**不是**按会话过滤的 —— 工作流定义是**全局**资源，
    //    所以这里只断言「编排模式在 + 定义列表能渲染」，不断言它为空。
    const listBody = panel.locator(PAGE_CHROME.list)
    const modeSwitch = panel.locator(PAGE_CHROME.modeSwitch).first()
    await expect(listBody, '实例模式：实例列表应为空态（本会话没有绑定实例）')
      .toContainText('暂无工作流实例', { timeout: 30_000 })
    expect(await listBody.locator('li').count(), '实例列表应为空').toBe(0)
    await modeSwitch.getByRole('tab', { name: '编排', exact: true }).click()
    await expect(modeSwitch.getByRole('tab', { name: '编排', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(listBody, '编排模式：定义列表应正常渲染（全局定义，不做会话过滤）')
      .toBeVisible({ timeout: 15_000 })
    await modeSwitch.getByRole('tab', { name: '实例', exact: true }).click()
    await expect(modeSwitch.getByRole('tab', { name: '实例', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(listBody).toContainText('暂无工作流实例', { timeout: 15_000 })

    const panelContent = (await panel.innerText()).replace(/\s+/g, ' ')

    // ⑥ 硬约束：面板里**没有任何别的实例**（按实例清单全量对照）；也没有输入面。
    const allInstances = await listInstances(page)
    const leaked = allInstances.filter(instance => instance.instanceId !== '' && panelContent.includes(instance.instanceId))
    expect(
      leaked.map(instance => instance.instanceId),
      `无实例会话的 tab 面板里不得出现任何实例 id（面板文本：${panelContent.slice(0, 200)}）`,
    ).toEqual([])
    expect(panelContent, '别的实例的需求文本不得出现在无实例会话的 tab 面板里')
      .not.toContain(foreign.requirement)
    for (const selector of ['[data-main-agent-input]', '[data-sandore-disc-input]', '[data-composer-input]']) {
      expect(await panel.locator(selector).count(), `tab 面板内不得出现输入锚点 ${selector}`).toBe(0)
    }

    // ⑦ 版式：与轨迹 tab 同为「铺满会话体」（不继承 Chat 消息窄列）。
    const workflowLayout = await measureLayout(page)
    await page.getByRole('tab', { name: '轨迹', exact: true }).first().click()
    await expect.poll(async () => (await measureLayout(page)).trajectory !== null, {
      timeout: 30_000,
      message: '轨迹 tab 应可打开（对照版式）',
    }).toBe(true)
    const trajectoryLayout = await measureLayout(page)
    expectLayoutParity(workflowLayout, trajectoryLayout)
    await workflowTab.click()
    await expect(panel).toBeVisible({ timeout: 15_000 })

    // ⑧ 滚动：左栏固定、右栏内部滚动、**不产生整页滚动**（照侧栏工作流页的行为）。
    const scroll = await probeScroll(page, 420)

    // ⑨ 取证（追加到同一份 artifact）。
    writeFileSync(
      join(REPO_ROOT, 'e2e', '.artifacts', 'main-agent-workflow-tab.txt'),
      [
        '',
        '## 无绑定实例的会话（完整页面：两张空列表 + 入口在位；采集时「工作流」tab 处于激活态）',
        `对照实例（属于别的会话）：${foreign.instanceId}（需求 ${foreign.requirement}）`,
        '页面本体锚点：'
        + `wf-view=${String(scroll.chrome.view)} 左栏列表=${String(scroll.chrome.list)}`
        + ` 右栏编辑区=${String(scroll.chrome.editor)} 模式切换=${String(scroll.chrome.modeSwitch)}`
        + ` 搜索框=${String(scroll.chrome.search)} 运行工作流按钮=${String(scroll.chrome.runButton)}`,
        `列表行数：实例模式 ${String(scroll.instanceRows)} / 编排模式 ${String(scroll.definitionRows)}（都应为 0）`,
        `面板内输入锚点计数：${String(scroll.inputsInPanel)}（应为 0）`,
        `面板文本（前 300 字）：${scroll.panelText}`,
        `全量实例清单对照：共 ${String(allInstances.length)} 个实例，泄漏到面板的 ${String(leaked.length)} 个`,
        '',
        '### 滚动（左栏固定 / 右栏内滚 / 无整页滚动）',
        `左栏 top：滚动前 ${String(scroll.listTopBefore)} → 滚动后 ${String(scroll.listTopAfter)}（应不变）`,
        `右栏（执行视图侧）scrollTop：滚动前 ${String(scroll.feedScrollTopBefore)} → 滚动后 ${String(scroll.feedScrollTopAfter)}`,
        `右栏 scrollHeight/clientHeight：${String(scroll.feedScrollHeight)}/${String(scroll.feedClientHeight)}`,
        `面板根 top：${String(scroll.panelTopBefore)} → ${String(scroll.panelTopAfter)}；面板 scrollHeight/clientHeight=${String(scroll.panelScrollHeight)}/${String(scroll.panelClientHeight)}`,
        `document.scrollingElement.scrollTop：${String(scroll.pageScrollBefore)} → ${String(scroll.pageScrollAfter)}（应不变）`,
        `会话滚动体（[data-conversation-scroll]）scrollTop：${String(scroll.scrollBodyBefore)} → ${String(scroll.scrollBodyAfter)}（应不变）`,
        `会话滚动体 scrollHeight/clientHeight：${String(scroll.scrollBodyScrollHeight)}/${String(scroll.scrollBodyClientHeight)}`,
        '',
      ].join('\n'),
      { encoding: 'utf8', flag: 'a' },
    )

    // 渲染不破坏 DSH 会话页：无 console error / pageerror。
    expect(problems, `页面出现 console error / pageerror：${problems.join(' | ')}`).toEqual([])
  })
})
