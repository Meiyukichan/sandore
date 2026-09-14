/**
 * M8 · 宿主主代理**唤醒取证**（口径修复的真机验收）。
 *
 * ## 为什么需要这个用例
 * 真机反馈：用户在工作流**仍在运行**时看到宿主主代理自行发了一条「进展更新（工作流仍在
 * 运行中）：当前阶段…Step sce1：running…」——按设计，宿主只应在两处被唤醒：
 * ① 启动注入（`injectHostContext`，去调 `sandore_workflow_run`）；② 终态收尾通知
 * （`notifyHostTerminal`）。中间每 Step 的结算通知必须被 park（零模型调用）。
 *
 * ## 取证手段
 * `SANDORE_WAKEUP_DIAG=1` 让插件把宿主会话每次 `agent/pre-step` 的
 * 「认领批次 → 归属判定 → 决定」打到 DSH 子进程 stderr（`[sandore-wakeup] {json}`，
 * 见 `packages/workflow/wakeup-diag.ts`）。本用例：
 * 1. 用一个**能产生辅助子代理**的两步定义（step-1 挂 secondary 门禁 → 门禁子代理；
 *    step-2 是 agent 步带 `agentParamsTemplate` → fillParams 子代理）——这两类子代理的
 *    childId **不落 `executedSteps`**，且 settle 时 live 会话即 dispose，正是漏网嫌疑来源；
 * 2. 跑完到 completed，收集窗口内的全部诊断行；
 * 3. 断言：**没有任何「来源属本实例子代理、却被放行」的唤醒**（`attribution === null`
 *    的 senderSessionId 条目出现在非 park 记录里即失败）；
 * 4. 把原始诊断落 `e2e/.artifacts/host-wakeups.txt` 供人工核对（唤醒次数 + 来源分类）。
 *
 * ## 计数口径
 * 每条记录 = 宿主会话的一次 `agent/pre-step`（同一 turn 内可能有多个 step）。**唤醒到模型**
 * 的记录 = decision ≠ park（`pass`/`enter`/`partial`）。期望：恰好 2 次唤醒，且两次都是
 * **我们自己的注入**（无 senderSessionId）。
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT, delay, expect, getInstanceState, mockDirective, test } from './fixtures/harness.ts'
import { createInstanceFromUi, ensureDefinition, openSeat, switchListMode } from './fixtures/harness.ts'
import { readHostTurns, renderHostTurns } from './fixtures/host-turns.ts'

/**
 * **本用例自带诊断开关**：`SANDORE_WAKEUP_DIAG=1` 必须存在于**被测 DSH 子进程**的环境里
 * （harness 的 `childEnv` 只在调用方进程设了该变量时才转发）。此前靠外部 `$env:` 前缀，
 * 一旦忘记设置，dump 就是空的、断言全崩——那属于用例自身的环境耦合，不是产品行为。
 * 这里在模块加载期（fixture spawn 之前）自行打开，使
 * `npx playwright test e2e/m8-host-wakeups.e2e.ts` 零开关即可复现。
 */
process.env.SANDORE_WAKEUP_DIAG = '1'

/** 诊断行前缀（与 `packages/workflow/wakeup-diag.ts` 的 `WAKEUP_DIAG_PREFIX` 一致）。 */
const DIAG_PREFIX = '[sandore-wakeup]'

/** 诊断记录（与 `HostWakeupRecord` 同形；此处只声明用例读到的字段）。 */
interface WakeupRecord {
  readonly hostSessionId: string
  readonly instanceStatus: string
  readonly turn: number
  readonly step: number
  readonly batch: ReadonlyArray<{ kind?: string; senderSessionId?: string; attribution: string | null }>
  readonly decision: 'park' | 'enter' | 'partial' | 'pass'
}

/** 从窗口日志里解析本实例的唤醒记录。 */
function wakeupRecordsOf(log: string, instanceId: string): WakeupRecord[] {
  const records: WakeupRecord[] = []
  for (const line of log.split('\n')) {
    const index = line.indexOf(DIAG_PREFIX)
    if (index < 0) continue
    try {
      const parsed = JSON.parse(line.slice(index + DIAG_PREFIX.length).trim()) as WakeupRecord
      if (parsed.hostSessionId === instanceId) records.push(parsed)
    } catch {
      // 非诊断 JSON（日志交错/截断）：忽略。
    }
  }
  return records
}

/**
 * 生成「两步 + 辅助子代理路径」的定义。
 *
 * - step-1：prompt 步（简单完成，作为对照）；
 * - step-2：agent 步 + `agentParamsTemplate` → step-runner 先建 **fillParams 子代理**
 *   （`subagents.startContinuable`，parent = 宿主会话）。
 *
 * fillParams 子代理的 childId **不会**写进 `executedSteps[].sessionMeta.childId`
 * （它只是参数填充的临时子代理），且 settle 时 live 会话即被 dispose —— 正是「辅助子代理」
 * 这条漏网嫌疑来源。
 *
 * 不用 secondary 门禁做辅助子代理：门禁子代理的输出要能被 `FinalizeManager` 解析成合法
 * 门禁 JSON，而 mock LLM 的应答由**step 提示词内嵌指令**驱动、门禁提示词里没有该指令 →
 * 门禁判失败会把实例落 failed（与本用例目的无关的噪声）。
 */
function auxChildWorkflow(name: string, id: string): { yaml: string; stepIds: readonly [string, string] } {
  const stepA = `stp-e2e-m8a-${id}`
  const stepB = `stp-e2e-m8b-${id}`
  const yaml = `id: wfl-e2e-m8-${id}
name: ${name}
version: "1.0.0"
stages:
  - id: stg-e2e-m8-${id}
    name: main
    steps:
      - id: ${stepA}
      - id: ${stepB}
steps:
  - id: ${stepA}
    name: prompt-simple
    command:
      type: prompt
      value:
        promptText: ${JSON.stringify(`一句话即可。${mockDirective({ text: 'm8-step-a-ok' })}`)}
        providerId: e2e-mock
        modelId: mock-1
  - id: ${stepB}
    name: agent-with-params
    command:
      type: agent
      value:
        promptText: ${JSON.stringify(`${mockDirective({ text: 'm8-step-b-ok' })} 按参数执行。`)}
        agentParamsTemplate: "参数模板：{n}"
        providerId: e2e-mock
        modelId: mock-1
`
  return { yaml, stepIds: [stepA, stepB] }
}

test.describe('M8 宿主主代理唤醒取证', () => {
  test('辅助子代理（门禁 / fillParams）的结算通知被 park：宿主只被我们自己的两次注入唤醒', async ({ page, dsh, workspace, problems }) => {
    test.setTimeout(150_000)

    // 同一个 worker 共享一个 DSH 实例（workers: 1）：计数必须取「本用例窗口」的差值。
    const mark = dsh.logMark()
    const suffix = Math.random().toString(36).slice(2, 10)
    const definitionName = `e2e-m8-wakeups-${suffix}`
    const { yaml } = auxChildWorkflow(definitionName, suffix)

    await ensureDefinition(page, yaml, definitionName)
    await openSeat(page)
    await switchListMode(page, '实例')
    const instanceId = await createInstanceFromUi(page, {
      workflowName: definitionName,
      requirement: `${definitionName}-req`,
      cwd: workspace,
    })

    // 等到终态（completed / failed / aborted 任一）：先落盘诊断，再断言 completed——
    // 这样即便实例失败，也能拿到唤醒记录用于排查（诊断优先于断言）。
    await expect
      .poll(async () => (await getInstanceState(page, instanceId)).status, { timeout: 120_000 })
      .toMatch(/completed|failed|aborted/)

    // 等到「终态唤醒」也落到诊断里：期望恰好 2 次**到达模型**的唤醒（启动注入 + 终态通知）。
    // 计数口径：decision ≠ park **且** 该批次非空（空批次的 enter 不花模型调用，见
    // DSH agent.ts:280-286 的「removed waking message」语义，不计为唤醒）。
    const modelWakes = (): WakeupRecord[] => wakeupRecordsOf(dsh.logSince(mark), instanceId)
      .filter(record => record.decision !== 'park' && record.batch.length > 0)
    // 收尾通知的唤醒是一次 followup，落在实例 completed 之后的一小段时间内——给足窗口，
    // 但**不**因为窗口没等到就丢证据：先 dump 再断言。
    await delay(15_000)

    const log = dsh.logSince(mark)
    const records = wakeupRecordsOf(log, instanceId)

    // 原始诊断落盘：唤醒次数 + 每条消息的来源分类（人工核对用）。
    const dump = [
      `# M8 宿主唤醒取证 · instance=${instanceId} · workflow=${definitionName}`,
      `# 记录数（宿主 pre-step 次数）=${records.length}`,
      `# 到达模型的唤醒次数=${modelWakes().length}`,
      '',
      ...records.map(record => JSON.stringify(record)),
    ].join('\n')
    mkdirSync(join(REPO_ROOT, 'e2e', '.artifacts'), { recursive: true })
    writeFileSync(join(REPO_ROOT, 'e2e', '.artifacts', 'host-wakeups.txt'), dump, 'utf8')

    expect(
      modelWakes().length,
      `到达模型的宿主唤醒次数应为 2（启动注入 + 终态通知）\n--- dump ---\n${dump}`,
    ).toBe(2)

    expect(
      (await getInstanceState(page, instanceId)).status,
      `实例应跑到 completed\n--- dump ---\n${dump}`,
    ).toBe('completed')

    // ── 核心断言 0：宿主会话的空 turn 与「park 记录」**一一对应**（根因对账） ────
    // 用户真机现场：主代理会话里 turn-tail2…19 全是空壳（各占一行 → 「巨大空白」）。
    // 本断言直接读**会话盘面**（隔离实例的会话日志），按 `turn/start`..`turn/end` 切 turn，
    // 逐 turn 判定有没有内容事件；再与 `[sandore-wakeup]` 的 `decision === 'park'` 记录
    // 对账 —— 二者相等即证明「空 turn = 被 park 的结算通知」，且**没有**其它来源的空 turn。
    // 空 turn 的 DSH 成因（源码为证）见 `e2e/fixtures/host-turns.ts` 的文件头：
    // `Agent.turn()` 先写 `turn/start`（`core/agent-loop/src/agent.ts:264`）再走 `preStep`
    // （`:275`），我们的 `agent/pre-step` 监听器返回 `{kind:'reject'}`（`:276-279`）时
    // turn 已经开出来了 → 留下 `turn/start` + `turn/end{reason:'blocked'}` 的空壳。
    const hostTurns = readHostTurns(dsh.home, instanceId)
    const emptyTurns = hostTurns.filter(turn => turn.empty)
    const parked = records.filter(record => record.decision === 'park')
    const turnDump = renderHostTurns(hostTurns)
    appendFileSync(
      join(REPO_ROOT, 'e2e', '.artifacts', 'host-wakeups.txt'),
      `\n\n${turnDump}\n## park 记录（= 被抑制的结算通知）\n`
      + `${records.map(record => `- turn#${record.turn} step#${record.step} decision=${record.decision} batch=${record.batch.map(entry => entry.kind ?? '?').join(',')}`).join('\n')}\n`,
      'utf8',
    )
    // ① 每个空 turn 的结束原因都必须是 `blocked`（pre-step reject 的语义），
    //    否则「空」另有来源（真缺陷）。
    expect(
      emptyTurns.filter(turn => turn.endReason !== 'blocked').map(turn => `turn#${turn.turn} end=${String(turn.endReason)}`),
      `存在非 park 造成的空 turn：\n${turnDump}`,
    ).toEqual([])
    // ② 空 turn 数 == park 记录数（一一对应；park 必然留一个空 turn）。
    expect(
      { emptyTurns: emptyTurns.length, parks: parked.length },
      `空 turn 应恰好等于 park 次数（被 park 的通知在 DSH 里已开了 turn）：\n${turnDump}`,
    ).toEqual({ emptyTurns: parked.length, parks: parked.length })

    // ── 核心断言 1：**没有任何漏网的子代理来源唤醒** ──────────────────────────
    // 只要出现「带 senderSessionId 但归属为 null」的条目落在非 park 记录里，就说明有
    // 一类子代理通知放行到了模型（真机缺陷）。
    const leaks = records.filter(record => record.decision !== 'park'
      && record.batch.some(entry => entry.senderSessionId !== undefined && entry.attribution === null))
    expect(
      leaks,
      `存在漏网的子代理来源唤醒（应全部 park）：\n${JSON.stringify(leaks, null, 2)}\n--- dump ---\n${dump}`,
    ).toEqual([])

    // ── 核心断言 2：到达模型的唤醒只有 2 次，且都不是子代理来源 ────────────────
    const wakes = modelWakes()
    expect(
      wakes.length,
      `宿主被唤醒 ${wakes.length} 次（期望 2 次：启动注入 + 终态通知）\n--- dump ---\n${dump}`,
    ).toBe(2)
    for (const record of wakes) {
      expect(record.batch.every(entry => entry.senderSessionId === undefined)).toBe(true)
      expect(record.batch.map(entry => entry.kind)).toEqual(['plugin'])
    }
    // 第一次唤醒时实例尚未终态（启动注入）、第二次时已终态（收尾通知）。
    expect(wakes.map(record => record.instanceStatus).sort()).toEqual(['completed', 'pending'])

    // ── 佐证：辅助子代理真的存在过、且其通知被 park（否则本用例什么也没证明） ────
    const parkedSenders = new Set(records
      .filter(record => record.decision === 'park')
      .flatMap(record => record.batch.map(entry => entry.senderSessionId))
      .filter((value): value is string => value !== undefined))
    expect(
      parkedSenders.size,
      `被 park 的子代理会话数应 ≥ 1（本用例至少要产生 fillParams 辅助子代理）\n--- dump ---\n${dump}`,
    ).toBeGreaterThanOrEqual(1)
    // 关键证据：**至少有一条被 park 的消息不是靠 executedSteps 判据**（而是靠子会话登记表
    // `registry` / 持久化 `persisted`）——这正是 2026-09 真机缺陷的漏网来源类别。
    const auxParked = records.some(record => record.decision === 'park'
      && record.batch.some(entry => entry.attribution === 'registry' || entry.attribution === 'persisted'))
    expect(
      auxParked,
      `应有至少一条辅助子代理（fillParams）通知靠 registry/persisted 判据被 park\n--- dump ---\n${dump}`,
    ).toBe(true)

    expect(problems, `页面出现 console error / pageerror：${problems.join(' | ')}`).toEqual([])
  })
})
