/**
 * M17 · 主代理会话里的**空 turn 不渲染 turn-tail 行**（用户真机「一堆空白行 / 巨大空白」）。
 *
 * ## 缺陷现场（用户真机）
 * > 「主代理会话里一堆空白行」「20 个 turn 里 18 个是空白行」。
 *
 * ## 空 turn 的来源（引擎/DSH 侧，**无法在那边消除**）
 * 抑制 step 结算通知走的是 `agent/pre-step` 返回 `{kind:'reject'}`，而 DSH 在 await
 * pre-step **之前**就已 `append('turn/start')`（`core/agent-loop/src/agent.ts:264` 先写、
 * `:275` 才 await）→ 被丢弃的消息留下 `turn/start` + `turn/end{blocked}` 的**空壳 turn**
 * （`notifySettlement` 无条件投递、没有 quiet 开关）。因此只能由**渲染侧**兜住：
 * 该 turn 没有任何内容行时不渲染它的 `turn-tail`（见 `step-row-data.ts` 的
 * `stepChatTurnsWithContentOf` 与 `StepChatPanel.tsx` 的 turn-tail 分支）。
 *
 * ## 本用例（真机、mock LLM）
 * 造一个「多步 + 循环 + 门禁 + 收尾」的实例（拓扑照用户 `test-workflow` 的最小复刻：
 * `s1 → s2 → s3`，`s3` 带回边（`loop.maxIterations=2`，`exitTo=s4`）→ `s4`；`primary`
 * 代码门禁 + `s1` 的 `secondary` AI 门禁 + 每步 Phase A/B 收尾评估），跑完拿到终态。
 *
 * **两条独立真值对账**：
 * 1. **盘面**（`readHostTurns`：`session.jsonl.zstd` 按 `turn/start..turn/end` 切 turn，
 *    看该 turn 有没有内容事件）→ turn 总数、空 turn 数与被 park 的 `blocked` 原因；
 * 2. **DOM**（`[data-main-agent-chat]` 内逐行量高度/文本/kind/turn）→ 哪些行可见。
 *
 * 断言（判据不放宽）：
 * - **没有空白行**（可见行且文本为空）；
 * - **每条可见 turn-tail 所在 turn 都有可见内容行**，且 `可见 turn-tail 数 === 有内容 turn 数`；
 * - **盘面上的空 turn 一律没有可见 turn-tail**（空壳 tail 只允许作为 `display:none` 的空行壳
 *   留在 DOM 里，不占布局）；
 * - 正向对照：**有内容的 turn-tail 照常渲染**（可见 tail ≥ 1，且带动作/读数）；
 * - 防恒真：盘面必须真的有**多个 turn**且**至少 1 个空 turn**（否则本用例什么也没证明）。
 *
 * 取证落盘：`e2e/.artifacts/main-agent-empty-turn-tail.txt`（盘面逐 turn + 逐行 DOM 量测）。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT, expect, getInstanceState, mockDirective, test } from './fixtures/harness.ts'
import { createInstanceFromUi, ensureDefinition, openSeat, switchListMode } from './fixtures/harness.ts'
import { readHostTurns, renderHostTurns, type HostTurnFacts } from './fixtures/host-turns.ts'

/** 一个 mock 答复同时满足三个解析器（Phase A/B 评估 + secondary 门禁 + 路由兜底）。 */
const ANSWER_JSON = '{"hasAsk":false,"passThroughVars":{},"compressedOutput":"M17-OUT","gateStatus":"done","gateDetail":"ok"}'

/** 每步提示词（都带同一个 mock 答复指令；步骤名会让主代理会话出现多轮内容）。 */
function promptOf(text: string): string {
  return JSON.stringify(`${text} ${mockDirective({ text: ANSWER_JSON })}`)
}

/** 「多步 + 循环 + 门禁 + 收尾」定义（拓扑 = 用户 test-workflow 的最小复刻）。 */
function m17Workflow(suffix: string): { readonly yaml: string; readonly name: string } {
  const name = `e2e-m17-emptyturn-${suffix}`
  const yaml = `id: wfl-e2e-m17-${suffix}
name: ${name}
version: 1.0.0
settings:
  defaultTimeout: 120
  maxConcurrentAgents: 4
gates:
  primary:
    enabled: true
stages:
  - id: stg-1
    name: demo1
    steps:
      - id: s1
        branches:
          - next: s2
      - id: s2
        branches:
          - next: s3
      - id: s3
        branches:
          - next: s2
            loop:
              next: s2
              maxIterations: 2
              exitTo: s4
      - id: s4
steps:
  - id: s1
    name: sce1
    command:
      type: prompt
      value:
        promptText: ${promptOf('输出 sce1 内容。')}
        providerId: e2e-mock
        modelId: mock-1
    gates:
      secondary:
        enabled: true
        prompt: ${JSON.stringify(`${mockDirective({ text: '{"gateStatus":"done","gateDetail":"ok"}' })} 判断该步骤输出是否满足要求，只回 JSON。`)}
  - id: s2
    name: sce2
    command:
      type: prompt
      value:
        promptText: ${promptOf('输出 sce2 内容。')}
        providerId: e2e-mock
        modelId: mock-1
  - id: s3
    name: sce3
    command:
      type: prompt
      value:
        promptText: ${promptOf('输出 sce3 内容。')}
        providerId: e2e-mock
        modelId: mock-1
  - id: s4
    name: loop-out
    command:
      type: prompt
      value:
        promptText: ${promptOf('输出收尾内容。')}
        providerId: e2e-mock
        modelId: mock-1
`
  return { yaml, name }
}

/** DOM 里一行（`[data-main-agent-chat] [data-chat-flow-kind]`）的量测面。 */
interface CardRow {
  readonly index: number
  readonly kind: string
  /** `data-chat-turn`（读不到时继承上一行的 turn：行序即时间序）。 */
  readonly turn: number | null
  /** turn-tail 被抑制的原因（`empty-turn` / `no-closing`；非 tail 行恒 null）。 */
  readonly suppressed: string | null
  readonly height: number
  readonly text: string
  readonly display: string
  readonly visible: boolean
}

/** 判定「内容行」时应排除的 kind（与 step-row-data.ts 的 TAIL_CONTENT_EXCLUDED_KINDS 同源）。 */
const NON_CONTENT_KINDS: ReadonlySet<string> = new Set(['turn-tail', 'turn-process', 'system-prompt'])

test.describe('M17 空 turn 不渲染 turn-tail 行', () => {
  test('多步+循环+门禁+收尾：主代理会话没有空白行，空 turn 的 tail 不渲染、有内容的 tail 照常渲染', async ({ page, dsh, workspace }) => {
    test.setTimeout(300_000)
    const suffix = Math.random().toString(36).slice(2, 10)
    const definition = m17Workflow(suffix)
    await ensureDefinition(page, definition.yaml, definition.name)
    await openSeat(page)
    await switchListMode(page, '实例')
    const instanceId = await createInstanceFromUi(page, {
      workflowName: definition.name,
      requirement: 'e2e-m17-emptyturn-req',
      cwd: workspace,
    })

    // 等实例进终态（终态强制展开主代理卡片 → 卡体全量可见，才能量到所有行）。
    await expect.poll(async () => (await getInstanceState(page, instanceId)).status, {
      timeout: 240_000,
      message: '实例应跑到终态（多步 + 循环 + 门禁 + 收尾）',
    }).toMatch(/completed|failed|aborted/)

    const card = page.locator('[data-main-agent-chat]').first()
    await expect(card, '主代理卡片卡体应可见（终态强制展开）').toBeVisible({ timeout: 60_000 })
    // 行渲染落定（终态后不再有流式帧；给 markdown/用量药丸一帧时间）。
    await page.waitForTimeout(1_500)

    // ── 真值 ①：会话日志盘面（空 turn = 被 park 的结算通知）─────────────────────
    const turns: readonly HostTurnFacts[] = readHostTurns(dsh.home, instanceId)
    const emptyTurns = turns.filter(turn => turn.empty)
    const blockedTurns = turns.filter(turn => turn.endReason === 'blocked')

    // ── 真值 ②：DOM 逐行量测 ───────────────────────────────────────────────────
    const rows = await page.evaluate(() => {
      const root = document.querySelector('[data-main-agent-chat]')
      if (root === null) return [] as {
        index: number; kind: string; turn: string | null; suppressed: string | null
        height: number; text: string; display: string
      }[]
      return [...root.querySelectorAll('[data-chat-flow-kind]')].map((el, index) => {
        const rect = el.getBoundingClientRect()
        const raw = (el.textContent ?? '').trim().replace(/\s+/g, ' ')
        return {
          index,
          kind: el.getAttribute('data-chat-flow-kind') ?? '',
          turn: el.getAttribute('data-chat-turn'),
          // 抑制原因（只有 turn-tail 行会挂）：empty-turn / no-closing。
          suppressed: el.getAttribute('data-turn-tail-suppressed'),
          height: Math.round(rect.height * 10) / 10,
          text: raw,
          display: getComputedStyle(el).display,
        }
      })
    })
    let lastTurn: number | null = null
    const measured: CardRow[] = rows.map(row => {
      const parsed = row.turn === null || row.turn === '' ? Number.NaN : Number(row.turn)
      if (Number.isFinite(parsed)) lastTurn = parsed
      return {
        index: row.index,
        kind: row.kind,
        turn: Number.isFinite(parsed) ? parsed : lastTurn,
        suppressed: row.suppressed,
        height: row.height,
        text: row.text,
        display: row.display,
        visible: row.height > 0 && row.display !== 'none',
      }
    })

    const visible = measured.filter(row => row.visible)
    const blankRows = visible.filter(row => row.text.length === 0)
    const visibleTails = visible.filter(row => row.kind === 'turn-tail')
    const hiddenTails = measured.filter(row => row.kind === 'turn-tail' && !row.visible)
    const contentTurns = new Set(
      visible.filter(row => !NON_CONTENT_KINDS.has(row.kind))
        .map(row => row.turn)
        .filter((turn): turn is number => turn !== null),
    )
    const emptyTurnNumbers = new Set(emptyTurns.map(turn => turn.turn))
    const tailTurnsVisible = visibleTails
      .map(row => row.turn)
      .filter((turn): turn is number => turn !== null)
    const visibleTailsInEmptyTurns = tailTurnsVisible.filter(turn => emptyTurnNumbers.has(turn))

    // 取证（断言之前落盘：失败也要有现场）。
    writeFileSync(
      join(REPO_ROOT, 'e2e', '.artifacts', 'main-agent-empty-turn-tail.txt'),
      [
        '# M17 空 turn 与 turn-tail 行（真机取证）',
        `时间：${new Date().toISOString()}`,
        `实例：${instanceId}`,
        '',
        renderHostTurns(turns),
        '',
        `## 汇总`,
        `盘面 turn 总数=${String(turns.length)} 空 turn 数=${String(emptyTurns.length)}`
        + `（endReason=blocked 的 turn 数=${String(blockedTurns.length)}）`,
        `DOM 行总数=${String(measured.length)} 可见行=${String(visible.length)} 空白可见行=${String(blankRows.length)}`,
        `可见 turn-tail=${String(visibleTails.length)} 隐藏（display:none / h=0）turn-tail=${String(hiddenTails.length)}`,
        `DOM 有内容 turn=${String(contentTurns.size)}（${[...contentTurns].sort((a, b) => a - b).join(',')}）`,
        `可见 tail 所在 turn=${tailTurnsVisible.join(',') || '无'}`,
        `盘面空 turn=${[...emptyTurnNumbers].join(',') || '无'}`,
        '',
        '## 逐行 DOM 量测（kind / turn / 高度 / display / 抑制原因 / 文本前缀）',
        ...measured.map(row =>
          `[${String(row.index)}] kind=${row.kind} turn=${row.turn === null ? '?' : String(row.turn)}`
          + ` h=${row.height.toFixed(1)} display=${row.display}`
          + ` 抑制=${row.suppressed ?? '-'} 文本(${String(row.text.length)}字)：${row.text.slice(0, 60)}`),
        '',
      ].join('\n'),
      'utf8',
    )

    const dump = renderHostTurns(turns)
    const rowDump = measured.map(row => `[${String(row.index)}] ${row.kind} h=${row.height.toFixed(1)} display=${row.display} 文本=${String(row.text.length)}字`).join('\n')

    // ── 防恒真：场景必须真的产生多个 turn 与空 turn ────────────────────────────
    expect(turns.length, `宿主会话应有多个 turn（多步 + 循环 + 收尾）：\n${dump}`).toBeGreaterThanOrEqual(4)
    expect(
      emptyTurns.length,
      `应有被 park 的结算通知留下的空 turn（否则本用例没证明任何东西）：\n${dump}`,
    ).toBeGreaterThanOrEqual(1)

    // ── 用户报的「空白行」：一条都不许有 ──────────────────────────────────────
    expect(
      blankRows.map(row => `[${String(row.index)}] kind=${row.kind} h=${row.height}`),
      `主代理会话里不得有空白行（可见行且无文本）：\n${rowDump}`,
    ).toEqual([])

    // ── 空 turn 的 tail 一律不可见（空壳行只允许 display:none 留在 DOM 里）────
    expect(
      visibleTailsInEmptyTurns,
      `盘面空 turn ${[...emptyTurnNumbers].join(',')} 不应有可见的 turn-tail：\n${rowDump}\n${dump}`,
    ).toEqual([])

    // ── 抑制**归因**：空 turn 的 tail 必须是被「空 turn」规则挡下的（而不是恰好没 closing）
    //    这条把新增判据钉死——否则本用例在「正好都没有 closing」的场景下会恒真。
    const hiddenTailTurns = hiddenTails
      .map(row => row.turn)
      .filter((turn): turn is number => turn !== null)
    expect(
      hiddenTails.length,
      `空 turn 的 tail 应以 display:none 留在 DOM（可归因）：\n${rowDump}`,
    ).toBeGreaterThanOrEqual(emptyTurns.length)
    expect(
      hiddenTails.filter(row => row.suppressed !== 'empty-turn').map(row => `[${String(row.index)}] turn=${String(row.turn)} 抑制=${String(row.suppressed)}`),
      `每条隐藏的 tail 都应归因为「空 turn」：\n${rowDump}`,
    ).toEqual([])
    for (const turn of hiddenTailTurns) {
      expect(emptyTurnNumbers.has(turn), `隐藏的 tail 应落在盘面空 turn 上（turn#${String(turn)}）`).toBe(true)
    }
    // 盘面上每个空 turn 都恰好对应一条被抑制的 tail（空壳 turn 一一对应一条 turn-tail 节点）。
    expect(
      [...hiddenTailTurns].sort((a, b) => a - b),
      `隐藏 tail 的 turn 集合应等于盘面空 turn 集合：\n${dump}`,
    ).toEqual([...emptyTurnNumbers].sort((a, b) => a - b))

    // ── 有内容的 tail 照常渲染，且「可见 tail 数 === 有内容 turn 数」───────────
    expect(visibleTails.length, `有内容的 turn-tail 必须照常渲染（至少 1 条）：\n${rowDump}`).toBeGreaterThanOrEqual(1)
    expect(
      visibleTails.length,
      `可见 turn-tail 数应等于有内容 turn 数（${String(contentTurns.size)}）：\n${rowDump}`,
    ).toBe(contentTurns.size)
    for (const turn of tailTurnsVisible) {
      expect(contentTurns.has(turn), `turn#${String(turn)} 的 tail 可见，但该 turn 没有可见内容行`).toBe(true)
    }
    // 有内容的 tail 必须带真实读数/动作（不是空壳）。
    expect(
      visibleTails.some(row => row.text.length > 0),
      `可见 turn-tail 应有内容（复制/时钟/用量/用时读数）：\n${rowDump}`,
    ).toBe(true)
  })
})
