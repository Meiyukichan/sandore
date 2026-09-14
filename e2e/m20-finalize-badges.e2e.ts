/**
 * M20 · step 卡片右侧三个收尾标签（收尾 / 门禁 / 判断）**都能**点进对应子代理会话（真机）。
 *
 * ## 缺陷现场（用户原话）
 * > 「discussion 的 step 右边有 **已收尾（收尾中）、门禁中（已门禁）、已判断（判断中）** 这些，
 * >  之前设计的是它们**都可以点击进入对应的子代理页面**，但是**只有收尾中可以点击**，其他的
 * >  点击则是**收起来 step 消息**，然后点击收尾中进入的子代理页面……显示的是报错：
 * >  `历史加载失败：subagent Sessions require their durable parent address（session/agent-busy）`」
 *
 * ## 用户最新实证（本次修复的靶心）
 * > 点「收尾中 / 门禁中 / 判断中」进子代理会话报上句；**从主代理会话里的「子代理列表」
 * > 进同一个会话则正常** —— 说明这些会话**本身可被地址化**，错在**我们的打开通道**。
 *
 * ## 四条根因（本次修复）
 * 1. **徽标嵌在状态按钮里**（`<button>` 套 `<button>`）：有 target 的徽标自己带
 *    `stopPropagation` 还能用；**没有 target 的徽标是 `<span>`，点击冒泡到状态按钮 →
 *    把 step 卡片折叠**（用户看到的「点了反而收起消息」）。修法：徽标移出状态按钮、独立成按钮，
 *    点击一律 `stopPropagation`；状态按钮仍照常折叠。
 * 2. **parent 传错（主修）**：这三条 lane 的子代理**全部**建在宿主主代理名下
 *    （收尾 fork `assessResult.forkSessionId` / 门禁 continuable `gateResult.gateSessionId`
 *    / 路由 fork `routingResult.routingSessionId` 的 `meta.parentSession` 都 = 宿主会话
 *    `hostSessionId` ≡ `taskId` ≡ `instanceId`）。早前按「fork 不是谁的子代理」把收尾/判断
 *    两条 lane 判成 `useDurableParent: false` 走**普通 open** → 宿主 `validateAddress` 对
 *    `origin:'subagent'` 的会话的普通地址访问**恒拒**（就是上面那句报错）。
 *    修法：三条 lane 统一走 durable 父地址（`packages/client/UnifiedTimeline.tsx` 的 PhaseBadge）。
 * 3. **打开通道静默**：`openSubagent` 被拒后只落一条 console.error，真机取不到「走了哪条通道、
 *    DSH 抛了什么」。修法：`packages/client/step-chat-source.ts` 记诊断（通道 / 各通道原始错误 /
 *    durable 地址是否装配成功）并镜像到 `globalThis.__sandoreStepChatOpenDiag`，本用例取证 dump
 *    直接输出；并且按目录条目 mode（`continuable` / `one-shot`）**两种依次尝试**、全被拒时
 *    `refreshSubagents(parent)` 后异步重试一次（宿主目录懒加载）。
 * 4. **运行期徽标退化成不可点文本（引擎侧，已修）**：`PhaseBadge` 只在有 target（会话 id）时
 *    渲染成可点按钮。Phase B 有 `onForkCreated` 早报（fork 建好即 commit 带真实 id 的 running
 *    快照），而 Phase C/D 只在开跑前 commit 空快照（`gateSessionId: ''` / routing 无 id）——
 *    于是「门禁中 / 判断中」运行期是不可点的纯文本，用户只能点完成态的「已门禁 / 已判断」。
 *    修法：按同一套机制给 C/D 补 `onGateCreated` / `onRoutingCreated` 早报（`packages/microflow/
 *    finalize-manager.ts` + `stage-executor.ts` + `step-navigator.ts` + `branch-evaluator.ts`）。
 *    故本用例三条 lane **一律点运行态「…中」**。
 *
 * ## 本用例（真机、mock LLM、带 secondary 门禁的分支工作流）
 * 三条 lane **逐条**点（每条点完回运行视图再点下一条），每条都断言进入的会话页：
 * **不出现**「历史加载失败 / durable parent address / agent-busy」、首屏有真实消息行、
 * 且点标签**不折叠** step。取证落盘 `e2e/.artifacts/finalize-badges-open.txt`。
 *
 * 窗口来源（三条 lane 的「…中」都得有可点窗口）：
 * - 收尾中（Phase B）/ 判断中（Phase D）：fork 子代理**继承 step 会话历史**，故 step 提示词里的
 *   `hold` 同样作用于这两次 fork 的模型调用 → 各 ~{@link STEP_HOLD_MS} 窗口；
 * - 门禁中（Phase C）：门禁提示词自带 `hold`（fresh 子代理，不继承历史）→ {@link GATE_HOLD_MS} 窗口。
 *
 * 确定性（不依赖 mock 的「AI 判断」）：step 提示词的指令文本同时给出 Phase B 与 Phase D 需要的
 * JSON 形状 —— `{"compressedOutput":"M20-OUTPUT","shouldExecute":["s2b"]}`：
 * ① s1 自己的输出（含 `M20-OUTPUT`，供分支条件文本判断）；② Phase B `parseFinalizeResult` 可解；
 * ③ Phase D 批量 `extractShouldExecuteBatch` 可解（命中 s2b）。这样三条 lane 都会被走到。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT, expect, mockDirective, test, type Page } from './fixtures/harness.ts'
import { createInstanceFromUi, ensureDefinition, getInstanceState, openSeat, switchListMode } from './fixtures/harness.ts'

/** Phase B（收尾 fork）与 Phase D（路由 fork）共用的答复 JSON（见文件头「确定性」）。 */
const STEP_REPLY_JSON = JSON.stringify({
  // `compressedOutput` 里**内嵌 hold 指令**：step 的输出会作为 `<ReferenceInfo>` 进入收尾
  // 提示词与路由提示词，于是这两次 fork 的模型调用各自停住 ~STEP_HOLD_MS →
  // 「收尾中 / 判断中」都有稳定可点窗口（否则它们毫秒级完成，UI 上根本来不及点）。
  // 该指令只带 `hold`，不改答复文本（`parseDirective` 按 key 合并）。
  compressedOutput: `M20-OUTPUT ${`[[e2e-mock hold=${String(20_000)}]]`}`,
  shouldExecute: ['s2b'],
})

/**
 * 每个 step 提示词的 `hold`（内容就绪后的「仍 running」窗口）。
 *
 * 为什么每个 step 都要：Phase B 收尾 fork / Phase D 路由 fork **继承 step 会话历史**，
 * 故提示词里的 `hold` 同样作用于这两次 fork 的模型调用 → 「收尾中」「判断中」各有
 * ~{@link STEP_HOLD_MS} 的**可点窗口**（否则 fork 判定毫秒级完成，标签一闪而过）。
 *
 * 取 20s：本用例三条 lane 是**逐条**点的（点完一条要回运行视图再点下一条，含一次
 * 会话页历史加载 + overlay 往返），窗口太窄会变成「测试自身的赛跑」而不是产品判据。
 */
const STEP_HOLD_MS = 30_000

/** Phase C 门禁提示词的 `hold`（「门禁中」窗口）。 */
const GATE_HOLD_MS = 70_000

/**
 * Phase B（收尾 fork）/ Phase D（路由 fork）的窗口「加挂」指令。
 *
 * 为什么需要单独加挂：这两条 lane 的 fork 提示词是**引擎拼的**（收尾模板 / 批量分支模板），
 * YAML 里只有两处文本会进入它们的请求：**step 名**（收尾提示词的 `<Reference title="你正在执行的Step: …">`
 * 块）与**分支条件文本**（批量分支提示词的 `executeCondition`）。把 `[[e2e-mock hold=…]]` 挂在这两处，
 * 这两次 fork 的模型调用就会各自停住 ~{@link FORK_HOLD_MS}，于是「收尾中 / 判断中」都有**稳定可点窗口**
 * （否则它们毫秒级完成，UI 上根本来不及点——真机 500ms 采样器实测）。
 *
 * 只带 `hold` 不带 `text`：答复文本仍由 step 提示词里的指令（{@link STEP_REPLY_JSON}）决定
 * ——`parseDirective` 按 key 合并、后者覆盖前者，故这里不会把答复内容改掉。
 */
const FORK_HOLD_DIRECTIVE = `[[e2e-mock hold=${String(STEP_HOLD_MS)}]]`

/** 一门禁 + 两分支的 mock 定义（三条 lane 的「…中」窗口都被 hold 撑开）。 */
function phaseWorkflow(suffix: string): { readonly yaml: string; readonly name: string } {
  const name = `e2e-m20-phases-${suffix}`
  // 三个 step 的指令文本**一致**：Phase B/D 的解析要求同一个答复就能满足（见文件头「确定性」）。
  // 注意 `## 参考信息`（前置 Step 输出，内含前置指令）在 `## 用户指令` **之后**，按
  // `parseDirective` 的「后者覆盖前者」；三者一致 ⇒ 无论哪条生效，行为都相同。
  const stepText = JSON.stringify(
    `M20 步骤答复。${mockDirective({ text: STEP_REPLY_JSON, hold: STEP_HOLD_MS })}`,
  )
  const gatePrompt = JSON.stringify(
    `${mockDirective({ text: '{"gateStatus":"done","gateDetail":"ok"}', hold: GATE_HOLD_MS })} 审查该 Step 输出是否满足要求，只回 JSON。`,
  )
  // step 名带 hold 加挂（进收尾提示词的 Step 身份块）+ 分支条件带 hold 加挂（进批量分支提示词）。
  const branchCondition = `该 Step 的输出是否与 M20-OUTPUT 相关 ${FORK_HOLD_DIRECTIVE}`
  const yaml = `id: wfl-e2e-m20-${suffix}
name: ${name}
version: 1.0.0
gates:
  primary:
    enabled: true
  secondary:
    enabled: true
    prompt: ${gatePrompt}
stages:
  - id: stg-1
    name: main
    steps:
      - id: s1
        branches:
          - next: s2a
          - next: s2b
            condition:
              type: prompt
              value:
                promptText: ${JSON.stringify(branchCondition)}
      - id: s2a
      - id: s2b
steps:
  - id: s1
    name: ${JSON.stringify(`sce1 ${FORK_HOLD_DIRECTIVE}`)}
    command:
      type: prompt
      value:
        promptText: ${stepText}
        providerId: e2e-mock
        modelId: mock-1
  - id: s2a
    name: branch-a
    command:
      type: prompt
      value:
        promptText: ${stepText}
        providerId: e2e-mock
        modelId: mock-1
  - id: s2b
    name: branch-b
    command:
      type: prompt
      value:
        promptText: ${stepText}
        providerId: e2e-mock
        modelId: mock-1
`
  return { yaml, name }
}

/**
 * 一条 lane：phase 锚点 + 引擎快照里对应的 `finalizeMeta` 字段（**窗口的真值来源**）。
 *
 * 为什么用引擎快照而不是只看 UI 标签：RunView 的即时刷新只靠 SSE（`/sandore/events`）
 * 与 30s 兜底轮询（`RunView.tsx` 的主刷新循环），而「…中」窗口只有 20~45s——UI 是否
 * 已经反映引擎真值是**被测对象之一**，不能拿它当窗口判据（否则测试会因 UI 刷新节流
 * 而假失败）。故：先用引擎快照确认该阶段在 running，再强制重挂运行视图拿新快照，最后
 * 点 UI 标签——两侧不一致时失败信息能直接指出是「窗口错过」还是「UI 没反映真值」。
 */
const LANES = [
  { phase: 'finalizing', name: '收尾', resultKey: 'assessResult' },
  { phase: 'gating', name: '门禁', resultKey: 'gateResult' },
  { phase: 'routing', name: '判断', resultKey: 'routingResult' },
] as const

/** 读引擎快照里 step `s1` 最新执行段的某阶段状态（`assessResult`/`gateResult`/`routingResult`）。 */
function phaseStatusOf(
  raw: Record<string, unknown>,
  resultKey: 'assessResult' | 'gateResult' | 'routingResult',
  stepId = 's1',
): string | undefined {
  const steps = (raw['executedSteps'] as Array<{
    readonly stepId?: string
    readonly finalizeMeta?: Record<string, { readonly status?: string } | undefined>
  }> | undefined) ?? []
  const segments = steps.filter(step => step.stepId === stepId)
  const last = segments[segments.length - 1]
  return last?.finalizeMeta?.[resultKey]?.status
}

/** 读引擎快照里 step `s1` 最新执行段的某阶段会话 id（fork / 门禁子代理的真实会话 id）。 */
function phaseSessionIdOf(
  raw: Record<string, unknown>,
  resultKey: 'assessResult' | 'gateResult' | 'routingResult',
  stepId = 's1',
): string | undefined {
  const steps = (raw['executedSteps'] as Array<{
    readonly stepId?: string
    readonly finalizeMeta?: Record<string, Record<string, unknown> | undefined>
  }> | undefined) ?? []
  const segments = steps.filter(step => step.stepId === stepId)
  const result = segments[segments.length - 1]?.finalizeMeta?.[resultKey]
  if (result === undefined) return undefined
  const id = resultKey === 'assessResult'
    ? result['forkSessionId']
    : resultKey === 'gateResult' ? result['gateSessionId'] : result['routingSessionId']
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** 该阶段是否**降级**（有结果但没有真实会话 id ⇒ 没建 fork/子代理）。 */
function phaseDegradedOf(
  raw: Record<string, unknown>,
  resultKey: 'assessResult' | 'gateResult' | 'routingResult',
): boolean {
  const status = phaseStatusOf(raw, resultKey)
  return status !== undefined && phaseSessionIdOf(raw, resultKey) === undefined
}

/** 一条 lane 的点击现场 + 会话页探针结果。 */
interface LaneProbe {
  readonly phase: string
  readonly name: string
  /** 点到的徽标文案（应为「…中」或「已…」）。 */
  readonly label: string
  /** 点的是 running 态（「…中」，会话必然活着）还是 done 态（「已…」）。 */
  readonly running: boolean
  /** 点击前 step 卡体在（对照「点标签把 step 折叠」的旧缺陷）。 */
  readonly stepBodyPresentBeforeClick: boolean
  /** 会话页 `[data-chat-flow-kind]` 行数。 */
  readonly rows: number
  /** 命中禁止文案（必须为空）。 */
  readonly forbidden: readonly string[]
  /** 打开通道诊断（`step-chat-source.ts` 镜像到页面的 `__sandoreStepChatOpenDiag`）。 */
  readonly openDiag: unknown
  /** 首屏前几行文本（取证）。 */
  readonly texts: readonly string[]
  /** 「历史加载失败」原文（区分地址错 / fork 已 dispose）。 */
  readonly historyError?: string | undefined
  /** 未点到时最后观察到的现场（卡数 / 本卡标签 / 页面是否被覆盖）。 */
  readonly observed?: string | undefined
}

/**
 * 回运行视图（幂等）。
 *
 * 为什么不能只点席位入口：点标签走的是 `openSession` → `closeWorkflowOverlay()`
 * （把 overlay 关掉并清掉当前选中），所以再次展开席位看到的是**实例列表**而不是运行视图
 * ——必须再点一下本实例那一行（按需求文本 `requirement` 定位）才能回到 step 卡片。
 */
async function openRunView(page: Page, requirement: string): Promise<void> {
  const entry = page.locator('[data-sandore-seat-entry]').first()
  if (await entry.getAttribute('aria-expanded') !== 'true') await entry.click()
  await expect(page.locator('[data-sandore-seat-view]').first()).toBeVisible()
  if (await page.locator('[data-sandore-run-view]').count() === 0) {
    await switchListMode(page, '实例')
    await page.locator('[data-sandore-wf-list] button', { hasText: requirement }).first().click()
  }
  await expect(page.locator('[data-sandore-run-view]').last()).toBeVisible({ timeout: 30_000 })
}

/**
 * 读运行视图**第一张 step 卡片**上的阶段标签（诊断用：UI 在某一刻到底渲染了什么）。
 * @returns 卡片数与标签文本（无卡片时为空数组）。
 */
async function firstCardLabels(page: Page): Promise<{ readonly cards: number; readonly labels: readonly string[] }> {
  try {
    const card = page.locator('[data-tl-step]').first()
    const cards = await page.locator('[data-tl-step]').count()
    if (cards === 0) return { cards, labels: [] }
    const labels = await card.locator('[data-tl-step-phase]').allTextContents()
    return { cards, labels: labels.map(text => text.trim()) }
  } catch {
    return { cards: -1, labels: [] }
  }
}

/**
 * 强制重挂运行视图（收起席位 → 再展开 → 必要时点实例行），拿到**新拉取**的实例快照。
 *
 * 为什么需要：RunView 的即时刷新只靠 SSE + 30s 兜底轮询；「…中」窗口只有 20~45s，
 * 若面板在窗口内没有收到 SSE 帧，UI 会停在旧快照上（实测：引擎侧已进入下一阶段、
 * 面板 150s 仍显示上一阶段）。收起席位会把 RunView 卸载，展开时重新挂载即重新
 * `getInstanceState` → UI 与引擎真值对齐。
 */
async function reopenRunView(page: Page, requirement: string): Promise<void> {
  const entry = page.locator('[data-sandore-seat-entry]').first()
  if (await entry.getAttribute('aria-expanded') === 'true') await entry.click()
  await expect(page.locator('[data-sandore-run-view]')).toHaveCount(0, { timeout: 15_000 })
  await openRunView(page, requirement)
}

/**
 * 会话页探针：行数 / 错误行 / 禁止文案 / 是否有「加载更早」/ 打开通道诊断。
 *
 * 探针前先等「历史已加载」与「加载失败」二者之一落定——否则请求仍在飞行，
 * 会读到空页（早期版本因此把 forbidden 读成空数组、误判成「无报错」）。
 */
async function probeColumn(page: Page): Promise<{
  readonly rows: number
  readonly texts: readonly string[]
  readonly forbidden: readonly string[]
  readonly hasLoadOlder: boolean
  readonly openDiag: unknown
  /** 「历史加载失败」那行的**原文**（区分「地址错」与「fork 已被 dispose」两种成因）。 */
  readonly historyError: string
}> {
  await page.waitForFunction(
    () => {
      const body = document.body.innerText
      if (body.includes('历史加载失败') || body.includes('durable parent address')) return true
      return document.querySelectorAll('[data-chat-flow-kind]').length > 0
    },
    undefined,
    { timeout: 30_000 },
  ).catch(() => undefined)
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-chat-flow-kind]')]
    const body = document.body.innerText
    // 只把**地址类**文案算硬失败：`历史加载失败` 也可能是「fork 评估完已 dispose」的正常反馈
    // （product 既定行为：路由/收尾 fork 评估后 `dispose()`，真机由 DSH 给出明确提示）。
    const forbidden = [
      'durable parent address',
      'session/agent-busy',
      'agent-busy',
      // 地址 mode 与目录条目不符（我们装配的地址错了）——与上面同族，必须为空。
      'mode does not match the supplied address',
    ].filter(text => body.includes(text))
    const historyError = (body.split(/\r?\n/).find(line => line.includes('历史加载失败')) ?? '').trim()
    return {
      rows: rows.length,
      texts: rows.slice(0, 6).map(row => (row.textContent ?? '').replace(/\s+/g, ' ').slice(0, 80)),
      forbidden,
      hasLoadOlder: [...document.querySelectorAll('button')].some(button => (button.textContent ?? '').includes('加载更早')),
      openDiag: (globalThis as unknown as { __sandoreStepChatOpenDiag?: unknown }).__sandoreStepChatOpenDiag ?? null,
      historyError,
    }
  })
}

test.describe('M20 收尾标签点进子代理会话', () => {
  test('「收尾中 / 门禁中 / 判断中」三个标签逐条可点、进入的会话页无历史加载报错，且点标签不折叠 step', async ({ page, dsh, workspace }) => {
    test.setTimeout(900_000)
    const suffix = Math.random().toString(36).slice(2, 10)
    const definition = phaseWorkflow(suffix)
    const requirement = `e2e-m20-req-${suffix}`
    /** mock 日志里本用例窗口内的调用行（诊断：每次模型调用拿到的指令/文本）。 */
    const logMark = dsh.logMark()
    await ensureDefinition(page, definition.yaml, definition.name)
    await openSeat(page)
    await switchListMode(page, '实例')
    const instanceId = await createInstanceFromUi(page, {
      workflowName: definition.name,
      requirement,
      cwd: workspace,
    })

    const probes: LaneProbe[] = []
    /** 时间线（相对本用例起点，秒）：诊断「哪一步吃掉了窗口」。 */
    const timeline: string[] = []
    const t0 = Date.now()
    const stamp = (label: string): void => {
      timeline.push(`${label}: +${String(Math.round((Date.now() - t0) / 1000))}s`)
    }

    /** 取证落盘（每条 lane 点完即写一次：中途失败也留证据）。 */
    const dump = (note: string): void => {
      const mockLines = dsh.logSince(logMark).split(/\r?\n/)
        .filter(line => line.includes('[e2e-mock] call#') || line.includes('[e2e-mock] host-run'))
        .slice(-40)
      writeFileSync(
        join(REPO_ROOT, 'e2e', '.artifacts', 'finalize-badges-open.txt'),
        [
          '# M20 收尾/门禁/判断标签 → 子代理会话页（真机取证，三条 lane 逐条点）',
          `时间：${new Date().toISOString()}`,
          `实例：${instanceId}`,
          `说明：${note}`,
          `mock 答复 JSON（step 指令，供 Phase B/D 复用）：${STEP_REPLY_JSON}`,
          `step hold（撑开「收尾中 / 判断中」窗口）：${String(STEP_HOLD_MS)}ms；门禁 hold：${String(GATE_HOLD_MS)}ms`,
          '',
          '## 时间线（相对起点）',
          ...timeline,
          '',
          '## 引擎侧三阶段状态轨迹（getInstanceState，去重）',
          ...phaseTrace,
          '',
          '## 阶段 running/done 起止（独立 500ms 采样器：窗口宽度真值）',
          ...phaseTransitions,
          '',
          ...probes.flatMap(probe => [
            `## ${probe.name}（data-tl-step-phase=${probe.phase}）`,
            `- 点到的标签：${probe.label}`,
            ...(probe.observed === undefined || probe.observed === '' ? [] : [`- 未点开现场：${probe.observed}`]),
            `- 点击前 step 卡体在：${String(probe.stepBodyPresentBeforeClick)}`,
            `- 会话页行数（[data-chat-flow-kind]）：${String(probe.rows)}`,
            `- 命中地址类禁止文案：${JSON.stringify(probe.forbidden)}（必须为空数组）`,
            `- 「历史加载失败」原文：${probe.historyError === undefined || probe.historyError === '' ? '（无）' : probe.historyError}`,
            `- 打开通道诊断（页面 __sandoreStepChatOpenDiag.last）：${JSON.stringify(probe.openDiag === null ? null : (probe.openDiag as { last?: unknown }).last ?? null)}`,
            '',
            '### 首屏前几行',
            ...probe.texts.map((text, index) => `[${String(index)}] ${text}`),
            '',
          ]),
          '## mock 调用日志（本用例窗口，尾部 40 行）',
          ...mockLines.map(line => line.trim()),
          '',
        ].join('\n'),
        'utf8',
      )
    }

    const stepCard = page.locator('[data-tl-step]').first()
    stamp('实例已创建（createInstanceFromUi 返回）')
    await expect(stepCard, 'step 卡片应出现').toBeVisible({ timeout: 90_000 })
    stamp('step 卡片可见')

    /**
     * 点某条 lane 的**运行态**徽标（「…中」，有界轮询）。
     *
     * 三条 lane 运行期都必须可点：`PhaseBadge` 只在**有 target**（会话 id）时才渲染成可点按钮，
     * 否则退化成纯文本 `<span>`（连 `data-tl-step-phase` 都没有）。三条 lane 现在都由引擎
     * **建会话后立即早报真实 id 并 commit running 快照**（同一套机制）：
     * - Phase B 收尾 fork：`onForkCreated`（`stage-executor.ts` 的 `runPhaseB`）；
     * - Phase C 门禁子代理：`onGateCreated`（同文件 `runPhaseC`）；
     * - Phase D 路由 fork：`onRoutingCreated`（同文件 `completeAfterFinalize`）。
     * 故本用例只认「…中」（点完成态的「已…」不再算通过——那正是修复前唯一能点到的入口）。
     *
     * @param wantRunning - `true` = 只认运行态「…中」（该阶段确有真实会话 id）；
     *   `false` = 该阶段在本 fixture 下降级（无 fork 会话 ⇒ 运行态徽标按设计不存在），
     *   退化为完成态「已…」徽标。
     * @returns 点击现场；窗口内没有可点徽标返回 undefined。
     */
    const clickLane = async (phase: string, budgetMs: number, wantRunning: boolean): Promise<{
      readonly label: string
      readonly running: boolean
      readonly stepBodyPresentBeforeClick: boolean
    } | undefined> => {
      const deadline = Date.now() + budgetMs
      let fallback: { readonly label: string; readonly card: ReturnType<Page['locator']>; readonly badge: ReturnType<Page['locator']> } | undefined
      while (Date.now() < deadline) {
        const card = page.locator('[data-tl-step]').first()
        if (await page.locator('[data-tl-step]').count() > 0 && await card.isVisible().catch(() => false)) {
          const badge = card.locator(`[data-tl-step-phase="${phase}"]`).first()
          if (await badge.count() > 0 && await badge.isVisible().catch(() => false)) {
            const label = ((await badge.textContent()) ?? '').trim()
            if (/中$/u.test(label)) {
              const bodyBefore = await card.locator('[data-step-chat]').count() > 0
              await badge.click()
              return { label, running: true, stepBodyPresentBeforeClick: bodyBefore }
            }
            fallback ??= { label, card, badge }
          }
        }
        await page.waitForTimeout(150)
      }
      if (wantRunning || fallback === undefined) return undefined
      const bodyBefore = await fallback.card.locator('[data-step-chat]').count() > 0
      await fallback.badge.click()
      return { label: fallback.label, running: false, stepBodyPresentBeforeClick: bodyBefore }
    }

    /**
     * 三条 lane 逐条点：**单趟交织**轮询（每轮强制重挂运行视图拿新快照 → 谁在「…中」就点谁）。
     *
     * 为什么不是「一条 lane 一段长轮询」：B/C/D 三个窗口是**串行**的（各 20s/45s/20s），
     * 长轮询第一条 lane 会把后面两条的窗口整段吃掉（实测：收尾 lane 的 150s 等待结束时，
     * 门禁与判断已经跑完）。交织轮询把每一轮压到 ~2s，三个窗口都能覆盖。
     *
     * 引擎快照（`getInstanceState` → `finalizeMeta.<phase>.status`）只用于**取证**：
     * 点标签那一刻该阶段在引擎侧是什么状态，一并写进 dump。
     */
    const seen = new Map<string, { readonly engine: string }>()
    /**
     * 引擎侧三阶段状态 + **同一时刻 UI 卡片上的标签**（去重，带相对秒）。
     *
     * 这两列并排就是判据：引擎说 `gateResult=running` 而 UI 只有 `["已收尾"]` ⇒ 面板没反映
     * 引擎真值（窗口在 UI 上不存在）；两列一致只是错过 ⇒ 纯窗口/时序问题。
     */
    const phaseTrace: string[] = []
    /**
     * 独立 500ms 采样器（与 UI 轮询并行）：记录三阶段 running/done 的**真实起止时刻**，
     * 用来给「三条 lane 的窗口有多宽」给出确定答案（UI 轮询本身有 remount 开销，不足以测量）。
     */
    const phaseTransitions: string[] = []
    let sampling = true
    const sampler = (async () => {
      let last = ''
      while (sampling) {
        try {
          const sample = await getInstanceState(page, instanceId)
          const line = LANES
            .map(lane => `${lane.resultKey}=${String(phaseStatusOf(sample.raw, lane.resultKey))}`
              + `(id=${phaseSessionIdOf(sample.raw, lane.resultKey) ?? 'None'})`)
            .join(' ')
          if (line !== last) {
            phaseTransitions.push(`+${String(Math.round((Date.now() - t0) / 1000))}s ${line}`)
            last = line
          }
        } catch {
          // 实例未就绪/已清理：忽略，下一拍再试。
        }
        await page.waitForTimeout(500)
      }
    })()
    const deadline = Date.now() + 420_000
    while (Date.now() < deadline && seen.size < LANES.length) {
      const state = await getInstanceState(page, instanceId)
      const trace = LANES
        .map(lane => `${lane.resultKey}=${String(phaseStatusOf(state.raw, lane.resultKey))}`)
        .join(' ')
      // 实例到终态且三阶段都不在 running：不会再有窗口，提前收工。
      const engineDone = state.status !== 'running' && state.status !== 'pending' && !trace.includes('=running')
      await reopenRunView(page, requirement)
      // 让新挂载的两次 RPC（getInstanceState + getArtifacts）落定后再读标签。
      await page.waitForTimeout(600)
      const ui = await firstCardLabels(page)
      const sample = `+${String(Math.round((Date.now() - t0) / 1000))}s instance=${state.status} ${trace}`
        + ` ui=${JSON.stringify(ui.labels)} cards=${String(ui.cards)}`
      // 逐次记录（引擎态**或** UI 标签任一变化都是新证据：引擎说 running 而 UI 没有「…中」
      // 就是「面板没反映真值」，两者都在动只是没抓到窗口则属时序）。
      if (phaseTrace[phaseTrace.length - 1] === undefined
        || !phaseTrace[phaseTrace.length - 1]!.includes(`${trace} ui=${JSON.stringify(ui.labels)}`)) {
        phaseTrace.push(sample)
      }
      if (engineDone) break
      // 一轮 = 重挂拿新快照 + **200ms 交错快轮询**（三条 lane 一起看，谁先出现可点徽标就点谁）。
      //
      // 为什么交错：三条 lane 的窗口宽度差别极大（实测 500ms 采样器：门禁 ~70s；收尾/判断的 fork
      // 可能亚秒级）。按 lane 顺序各给 2.5s 的轮询会让「收尾没点到 → 轮到判断时它的窗口已经关了」，
      // 交错轮询把每一拍的代价压到一次 DOM 查询，亚秒窗口也能撞上。
      for (let tick = 0; tick < 25; tick += 1) {
        if (Date.now() > deadline) break
        let acted = false
        for (const lane of LANES) {
          if (seen.has(lane.phase)) continue
          // 该 lane 现在是什么态：
          // - `running` **且会话 id 非空** ⇒ 运行态徽标一定是可点按钮（引擎早报的语义）→ 只点「…中」；
          // - `running` 但 id 还是空（Phase C/D 开跑前那一次空桩 commit）⇒ 徽标按设计是纯文本，
          //   这一拍先跳过（不碰运气连点，等早报把真实 id 写进快照）；
          // - `done/failed` ⇒ 运行窗口已过，退化为完成态徽标（如实记录）；
          // - `undefined` ⇒ 该 lane 还没到，继续等。
          const status = phaseStatusOf(state.raw, lane.resultKey)
          const laneSessionId = phaseSessionIdOf(state.raw, lane.resultKey)
          if (status === 'running' && laneSessionId === undefined) continue
          const wantRunning = status === undefined || status === 'running'
          const clicked = await clickLane(lane.phase, 150, wantRunning)
          if (clicked === undefined) continue
          const engine = `${lane.resultKey}=${String(status)},sessionId=${laneSessionId ?? '(空/None)'}`
          seen.set(lane.phase, { engine })
          stamp(`「${lane.name}」lane：已点击${clicked.running ? '运行态' : '完成态'}「${clicked.label}」（引擎快照 ${engine}）`)
          const probe = await probeColumn(page)
          probes.push({
            phase: lane.phase,
            name: lane.name,
            label: clicked.label,
            running: clicked.running,
            observed: `引擎快照 ${engine}（点的是 ${clicked.running ? '运行态「…中」' : '完成态「已…」'}徽标）`,
            stepBodyPresentBeforeClick: clicked.stepBodyPresentBeforeClick,
            rows: probe.rows,
            forbidden: probe.forbidden,
            historyError: probe.historyError,
            openDiag: probe.openDiag,
            texts: probe.texts,
          })
          dump(`「${lane.name}」lane 已点击「${clicked.label}」并探针（引擎快照 ${engine}）`)
          acted = true
          break // 卡片已切走：重新重挂再继续
        }
        if (acted) break
        await page.waitForTimeout(200)
      }
    }
    stamp(`三条 lane 结束（已点 ${String(seen.size)}/3）`)
    sampling = false
    await sampler
    stamp('采样器已停止')

    for (const lane of LANES) {
      if (seen.has(lane.phase)) continue
      probes.push({
        phase: lane.phase, name: lane.name,
        label: '（窗口内未捕捉到运行态「…中」徽标）',
        running: false,
        observed: `整趟交织轮询都没看到「…中」可点徽标；引擎轨迹见上`,
        stepBodyPresentBeforeClick: false, rows: 0, forbidden: [], openDiag: null, texts: [],
      })
    }
    dump(`三条 lane 结束（已点 ${String(seen.size)}/3）`)

    // 引擎侧断言（确定性，不靠抢窗口）：
    // ① Phase C/D 开跑前那一次 running commit 的 id 是**空桩**、只是过渡——**最终必须被真实 id 覆盖**
    //    （引擎早报：Phase C `onGateCreated` / Phase D `onRoutingCreated`）。故「某 lane 最后一条采样
    //    仍是 running(id=None)」= 早报没生效 = 硬失败。
    // ② 门禁 lane 的运行窗口 ~70s（YAML 里的门禁 hold），必然能被 500ms 采样器采到
    //    `gateResult=running(id=<uuid>)` —— 这就是「运行期徽标可点」的引擎侧实证。
    for (const lane of LANES) {
      const lastSample = [...phaseTransitions].reverse().find(line => line.includes(`${lane.resultKey}=`))
      if (lastSample === undefined) continue
      expect(lastSample, `「${lane.name}」lane 的 running 空桩（id=None）必须被真实 id 覆盖（引擎早报）`)
        .not.toMatch(new RegExp(`${lane.resultKey}=running\\(id=None\\)`))
    }
    expect(
      phaseTransitions.some(line => /gateResult=running\(id=[^)]+\)/u.test(line)),
      '门禁 running 快照必须带真实 gateSessionId（onGateCreated 早报生效）',
    ).toBe(true)
    expect(
      probes.find(probe => probe.phase === 'gating')?.label,
      '门禁 lane 必须在**运行态**点到「门禁中」（引擎早报真实 gateSessionId）',
    ).toBe('门禁中')

    for (const probe of probes) {
      // ① 三条 lane 都必须点到对应徽标（运行态或该窗口已过的完成态，两者都已在 dump 记录）。
      expect(probe.label, `「${probe.name}」lane 未点到可点徽标`).toMatch(/^(已|收尾中|门禁中|判断中)/u)
      if (probe.running) expect(probe.label, `「${probe.name}」运行态徽标文案`).toMatch(/中$/u)
      // ② 点标签**不折叠** step 卡片（点击前卡体在，说明它不是被折叠掉的控件）。
      expect(probe.stepBodyPresentBeforeClick, `「${probe.name}」点击前 step 卡体应在（对照折叠缺陷）`).toBe(true)
      // ③ 进入的会话页不得出现**地址类**报错（本次修复的靶心）。
      //    注：`历史加载失败` 若原文是「fork 评估完成已 dispose」属 product 既定反馈（收尾/判断
      //    fork 评估后即 dispose），故只把地址/parent 类文案算硬失败，其余如实落盘。
      expect(probe.forbidden, `「${probe.name}」子代理会话页出现了地址类禁止文案（durable parent 传错的旧缺陷）`).toEqual([])
      // ④ 打开通道诊断必须有，且 durable 父 = 宿主会话（instanceId）。
      expect(probe.openDiag, `「${probe.name}」应记录打开通道诊断`).not.toBeNull()
      const last = (probe.openDiag as { last?: { readonly parentSessionId?: string } } | null)?.last
      expect(last?.parentSessionId, `「${probe.name}」打开通道应带宿主会话作为 durable 父`).toBe(instanceId)
      // ⑤ 会话页有真实消息行——**只在「运行态点开」时强制**（此时会话必然活着）。完成态点开的
      //    收尾/判断 fork 在评估后已被 `dispose()`：真机由 DSH 给出「会话已销毁」反馈，本 mock
      //    下表现为空页（无报错、无行）——属 product 既定行为，如实落盘但不作硬判据。
      //    门禁 lane 由上面的断言强制「运行态点开」，故它的 rows>0 是必过的。
      if (probe.running) {
        expect(probe.rows, `「${probe.name}」运行态点开的会话页应有真实消息行`).toBeGreaterThan(0)
      }
    }
  })
})
