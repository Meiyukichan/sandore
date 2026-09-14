/**
 * M16 · 子代理身份的**盘面真机对账**（「每个 step 下面多一个『会话记录损坏』」）。
 *
 * ## 缺陷现场（用户真机）
 * > 「每个 step 子代理下面都多出一个「会话记录损坏」的子条目。」
 * > 「`sce1` 显示 已完成/已收尾/已门禁/已判断，但列表里只有 `step sce1` 与 `gate sce1`
 * >   —— 收尾和判断的子代理呢？」
 *
 * ## 判定规则（DSH 源码为证）
 * DSH 的子代理列表（宿主主代理左上角下拉 / `list_agents` 工具）只枚举**会话头带
 * `origin:'subagent'`** 的会话（`subagent/src/list-children.ts:89-92`），再按**身份投影**
 * 渲染每一行；该投影来自 `subagent/descriptor` 这条会话事件。命中下列任一即判
 * `{kind:'diagnostic', reason:'corrupt'}` → UI 文案「会话记录损坏」：
 * 1. 身份投影缺失（`identity === undefined || null`）；
 * 2. `identity.seq < inheritedEventCount`（身份事件落在**继承前缀**里）。
 *
 * 所以盘面判据可以**离线**算出来：对每个 `origin==='subagent'` 的会话日志（header 行 +
 * 事件行）取 `subagent/descriptor` 事件的 `seq`，与 header 的 `seedLength`
 *（= `CreateAgentOptions.inheritedEventCount`）比较。
 *
 * ## 本用例覆盖的子代理创建路径
 * | 路径 | 创建方式 | 标题形态 |
 * |---|---|---|
 * | step 执行 | `subagents.startContinuable`（provider `spawn`） | `<Step 名称> · <uuid>` |
 * | 参数填充 | 同上 | `fillParams <名称> · <uuid>` |
 * | secondary 门禁 | 同上 | `gate <名称> · <uuid>` |
 * | 收尾评估（Phase B） | `forkStepSubagent`（裸 `agents.create` + seed） | `finalize <名称> · <uuid>` |
 * | 路由判断（Phase D） | `forkStepSubagent`（裸 `agents.create` + seed） | `route <名称> · <uuid>` |
 * | 重试重建 | recovery-manager（裸 `agents.create` + seed） | `retry <名称> · <uuid>` |
 *
 * 裸 `agents.create` 的三条（assess/route/retry）绕过 DSH subagent provider，其身份事件由
 * 引擎补写（`workflow/subagent-identity.ts` 的 `ensureSubagentDescriptor`）。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import {
  REPO_ROOT, createInstanceFromUi, ensureDefinition, expect, getInstanceState, mockDirective,
  openSeat, switchListMode, test,
} from './fixtures/harness.ts'
import { createMockTwoStepInstance } from './fixtures/mock-run.ts'

/** DSH `subagent/descriptor` 事件类型名。 */
const DESCRIPTOR_EVENT = 'subagent/descriptor'

/** 纯 UUID（无前缀）：引擎自建子代理的 childId 必须长这样。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 一个会话日志的盘面事实（离线可判定「损坏」与否的最小面）。 */
interface SessionFacts {
  /** 会话 id（取自 header）。 */
  readonly id: string
  /** 会话头 `origin`（`'subagent'` 才进子代理列表）。 */
  readonly origin: string | undefined
  /** 会话头 `parentSession`（列表挂在谁下面）。 */
  readonly parentSession: string | undefined
  /** 会话头 `seedLength`（= 继承前缀长度；上游 `inheritedEventCount`）。 */
  readonly seedLength: number | undefined
  /** 事件总行数。 */
  readonly eventCount: number
  /** `subagent/descriptor` 事件的 seq（缺失 = undefined；**取最后一条**，last-wins）。 */
  readonly descriptorSeq: number | undefined
  /** `subagent/descriptor` 事件条数（fork 会话会是 2：祖先 seed 1 条 + 自有 1 条）。 */
  readonly descriptorCount: number
  /** `subagent/descriptor` 的事件数据（label/mode/provider）。 */
  readonly descriptor: Record<string, unknown> | undefined
  /** 是否被 DSH 判定为「会话记录损坏」（规则见文件头）。 */
  readonly corrupt: boolean
}

/** 递归收集 `<root>` 下所有 `session.jsonl*`。 */
function findSessionLogs(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (/^session\.jsonl(\.zstd)?$/.test(entry.name)) found.push(path)
    }
  }
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory() === true) walk(root)
  return found
}

/**
 * 读一份会话日志（zstd 分帧之一或明文 `.jsonl`）→ 行数组。
 *
 * `session.jsonl.zstd` 是**多个 zstd 帧**（header 帧 + 追加帧），所以逐帧解再拼接
 * （与上游 `session-persistence-jsonl/src/index.ts:278-289` 同法）。
 */
function readSessionLines(path: string): string[] {
  const buffer = readFileSync(path)
  if (path.endsWith('.zstd')) {
    const parts: string[] = []
    for (const frame of splitZstdFrames(buffer)) parts.push(zstdDecompressSync(frame).toString('utf8'))
    return parts.join('').split('\n').filter(line => line.trim() !== '')
  }
  return buffer.toString('utf8').split('\n').filter(line => line.trim() !== '')
}

/** 按 zstd magic（`28 B5 2F FD`）切出**顶层帧**边界（与上游 `scanZstdFrames` 同法）。 */
function splitZstdFrames(buffer: Uint8Array): readonly Uint8Array[] {
  const magic = [0x28, 0xb5, 0x2f, 0xfd]
  const starts: number[] = []
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer[index] === magic[0] && buffer[index + 1] === magic[1]
      && buffer[index + 2] === magic[2] && buffer[index + 3] === magic[3]) {
      starts.push(index)
    }
  }
  if (starts.length === 0) throw new Error('zstd 会话日志无帧头')
  return starts.map((start, index) => buffer.subarray(start, starts[index + 1] ?? buffer.length))
}

/** `JSON.parse` 但不抛。 */
function parseJson(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** 把一份会话日志解析成盘面事实。 */
function factsOf(path: string): SessionFacts | undefined {
  let lines: string[]
  try {
    lines = readSessionLines(path)
  } catch {
    return undefined
  }
  if (lines.length === 0) return undefined
  const header = parseJson(lines[0]!) as {
    type?: string
    id?: string
    origin?: string
    parentSession?: string
    seedLength?: number
  } | undefined
  if (header?.type !== 'session' || typeof header.id !== 'string') return undefined
  const events = lines.slice(1).map(parseJson).filter((value): value is Record<string, unknown> => value !== undefined)
  // **取最后一条** descriptor：DSH 身份投影是 last-wins fold（`subagent/projection.ts:158-177`），
  // fork 会话里可能同时存在「seed 带进来的祖先 descriptor（seq 0）」与「引擎补写的自有身份」。
  const descriptorEvents = events.filter(event => event['type'] === DESCRIPTOR_EVENT)
  const descriptorEvent = descriptorEvents.at(-1)
  const descriptorSeq = typeof descriptorEvent?.['seq'] === 'number' ? descriptorEvent['seq'] as number : undefined
  const seedLength = header.seedLength
  return {
    id: header.id,
    origin: header.origin,
    parentSession: header.parentSession,
    seedLength,
    eventCount: events.length,
    descriptorCount: descriptorEvents.length,
    descriptorSeq,
    descriptor: descriptorEvent?.['data'] as Record<string, unknown> | undefined,
    // 判定与 DSH `list-children.ts:354-358` 一致：无身份事件（含 `seq < 继承前缀`）即「损坏」。
    corrupt: descriptorSeq === undefined || (seedLength !== undefined && descriptorSeq < seedLength),
  }
}

/** 读整个 home 的会话盘面。 */
function readAllSessions(home: string): SessionFacts[] {
  return findSessionLogs(join(home, 'sessions'))
    .map(factsOf)
    .filter((value): value is SessionFacts => value !== undefined)
}

/** 生成取证报告文本。 */
function reportOf(title: string, home: string, facts: readonly SessionFacts[]): string {
  const subagents = facts.filter(fact => fact.origin === 'subagent')
  const corrupt = subagents.filter(fact => fact.corrupt)
  return [
    `# ${title}`,
    `时间：${new Date().toISOString()}`,
    `home：${home}`,
    `会话日志文件数：${facts.length}`,
    `origin=subagent 会话数：${subagents.length}`,
    `判定「会话记录损坏」的会话数：${corrupt.length}`,
    '',
    '## 每个 origin=subagent 会话（按 label 排序）',
    ...subagents
      .sort((left, right) => String(left.descriptor?.['label'] ?? '').localeCompare(String(right.descriptor?.['label'] ?? '')))
      .map(fact => [
        `- id=${fact.id}`,
        `parent=${fact.parentSession ?? '(无)'}`,
        `label=${String(fact.descriptor?.['label'] ?? '(无)')}`,
        `mode=${String(fact.descriptor?.['mode'] ?? '(无)')}`,
        `provider=${String(fact.descriptor?.['provider'] ?? '(无)')}`,
        `descriptorSeq=${String(fact.descriptorSeq ?? '(缺失)')}`,
        `descriptorCount=${fact.descriptorCount}`,
        `seedLength=${String(fact.seedLength ?? '(无)')}`,
        `events=${fact.eventCount}`,
        `corrupt=${String(fact.corrupt)}`,
      ].join(' ')),
    '',
    '## 全部会话（含非 subagent origin）',
    ...facts.map(fact => `- id=${fact.id} origin=${fact.origin ?? '(无)'} parent=${fact.parentSession ?? '(无)'} events=${fact.eventCount} descriptorSeq=${String(fact.descriptorSeq ?? '(缺失)')}`),
    '',
  ].join('\n')
}

/** 取值的 record 面（finalizeMeta 是宽对象，e2e 只读字段）。 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

test.describe('M16 子代理身份盘面对账（不再有「会话记录损坏」）', () => {
  test('① 两步 prompt：每个 step 子代理都带身份事件，标题 = `<名称> · <childId>` 且 childId 与 sessionMeta 一致', async ({ page, dsh, workspace }) => {
    test.setTimeout(180_000)

    const instance = await createMockTwoStepInstance(page, {
      firstPromptText: `第一步：输出一句话。${mockDirective({ text: 'm16-step-a-ok' })}`,
      secondPromptText: `第二步：输出一句话。${mockDirective({ text: 'm16-step-b-ok' })}`,
      cwd: workspace,
      label: 'e2e-m16-identity',
    })

    await expect
      .poll(async () => (await getInstanceState(page, instance.instanceId)).status, { timeout: 120_000 })
      .toBe('completed')

    const state = await getInstanceState(page, instance.instanceId)
    const segments = state.executedSteps.filter(step => step.sessionMeta?.synthetic === false)
    expect(segments.length, `应有 2 个真实子代理段：${JSON.stringify(state.executedSteps.map(s => [s.stepId, s.status]))}`).toBe(2)

    const facts = readAllSessions(dsh.home)
    expect(facts.length, '应读到会话日志').toBeGreaterThan(0)
    const subagents = facts.filter(fact => fact.origin === 'subagent')
    const corrupt = subagents.filter(fact => fact.corrupt)
    const report = reportOf('M16 ① 两步 prompt（step 执行路径）', dsh.home, facts)
    writeFileSync(join(REPO_ROOT, 'e2e', '.artifacts', 'subagent-identity.txt'), report, 'utf8')

    // ① 子代理列表里不得出现「会话记录损坏」。
    expect(
      corrupt.map(fact => `${fact.id}(seq=${String(fact.descriptorSeq)}/seed=${String(fact.seedLength)})`),
      `存在会被 DSH 判为「会话记录损坏」的子代理会话：\n${report}`,
    ).toEqual([])

    // ② 每个真实 step 段都有对应子代理会话，标题 = `<名称> · <childId>`。
    for (const segment of segments) {
      const childId = segment.sessionMeta?.childId
      expect(childId, `step ${segment.stepId} 段的 sessionMeta.childId 应存在`).toBeDefined()
      expect(childId, `step ${segment.stepId} 的 childId 必须是纯 UUID（无前缀）`).toMatch(UUID_RE)
      const child = subagents.find(fact => fact.id === childId)
      expect(child, `step ${segment.stepId} 的子代理会话 ${String(childId)} 应在盘面上存在`).toBeDefined()
      expect(child!.corrupt, `step ${segment.stepId} 的子代理身份事件不得缺失`).toBe(false)
      const label = child!.descriptor?.['label']
      expect(typeof label, `step ${segment.stepId} 的身份事件应带 label`).toBe('string')
      expect(label, `step ${segment.stepId} 的标题应等于「${segment.name} · ${String(childId)}」`).toBe(`${segment.name} · ${String(childId)}`)
      expect(String(label).startsWith('step '), '标题不得带 `step ` 前缀（真机缺陷形态）').toBe(false)
      // 用户硬要求：label 尾段 uuid **必须就是该条目自己的 childId**（不是 step 定义 id /
      // instanceId / 随手生成的 uuid）。
      const tail = String(label).split(' · ').at(-1) ?? ''
      expect(tail, `step ${segment.stepId} 的 label 尾段应等于它自己的 childId`).toBe(String(childId))
      expect(tail, 'label 尾段不得是实例 id（宿主会话 id）').not.toBe(instance.instanceId)
      for (const prefix of ['step-', 'stp-', 'stg-', 'wfl-']) {
        expect(tail.startsWith(prefix), `label 尾段不得是定义 id（${prefix}…）`).toBe(false)
      }
      expect(child!.descriptor?.['mode'], 'step 执行子代理是 continuable（可续接）').toBe('continuable')
    }
  })

  test('② 分支 + 双门禁：收尾(fork)/门禁(continuable)/判断(fork) 三类子代理都在盘面上带身份事件', async ({ page, dsh, workspace }) => {
    test.setTimeout(240_000)

    // 拓扑：head → {srcA, srcB} 条件分支（两条分支都指向 tail）→ tail。
    // 两条分支 ⇒ Phase D 必须真跑**路由判断子代理**（`route <名称> · <uuid>`）；
    // srcA 无 outputTo ⇒ primary 纯代码校验通过；secondary 门禁与 Phase A/B 评估都真跑 AI。
    //
    // mock 的答复取**一个同时满足三个解析器的 JSON**（不必区分调用方）：
    // - Phase A/B 评估：`hasAsk:false` + `compressedOutput` → 不需要提问 + 压缩摘要；
    // - secondary 门禁：`gateStatus:"done"` → 门禁通过；
    // - Phase D 路由判断：无 `shouldExecute` → 回落顺序兜底（不抛错）。
    const suffix = Math.random().toString(36).slice(2, 10)
    const definitionName = `e2e-m16-forks-${suffix}`
    const answerJson = '{"hasAsk":false,"passThroughVars":{},"compressedOutput":"M16-SRC-OUTPUT","gateStatus":"done","gateDetail":"ok"}'
    const yaml = `id: wfl-e2e-m16-${suffix}
name: ${definitionName}
version: 1.0.0
gates:
  primary:
    enabled: true
  secondary:
    enabled: true
    prompt: ${JSON.stringify(`${mockDirective({ text: '{"gateStatus":"done","gateDetail":"ok"}' })} 请审查该 Step 的输出是否满足要求，只回一个 JSON。`)}
stages:
  - id: stg-1
    name: main
    steps:
      - id: head
        branches:
          - next: srcA
            condition:
              type: prompt
              value:
                promptText: "该 Step 的输出是否与 M16-SRC-OUTPUT 相关"
          - next: srcB
      - id: srcA
        branches:
          - next: tail
      - id: srcB
        branches:
          - next: tail
      - id: tail
steps:
  - id: head
    name: head
    command:
      type: prompt
      value:
        promptText: ${JSON.stringify(`输出入口结论。${mockDirective({ text: answerJson })}`)}
        providerId: e2e-mock
        modelId: mock-1
  - id: srcA
    name: srcA
    command:
      type: prompt
      value:
        promptText: ${JSON.stringify(`输出源码结论。${mockDirective({ text: answerJson })}`)}
        providerId: e2e-mock
        modelId: mock-1
  - id: srcB
    name: srcB
    command:
      type: prompt
      value:
        promptText: ${JSON.stringify(`输出备份结论。${mockDirective({ text: answerJson })}`)}
        providerId: e2e-mock
        modelId: mock-1
  - id: tail
    name: tail
    command:
      type: prompt
      value:
        promptText: ${JSON.stringify(`输出收尾结论。${mockDirective({ text: answerJson })}`)}
        providerId: e2e-mock
        modelId: mock-1
`
    await ensureDefinition(page, yaml, definitionName)
    await openSeat(page)
    await switchListMode(page, '实例')
    const instanceId = await createInstanceFromUi(page, {
      workflowName: definitionName,
      requirement: `${definitionName}-req`,
      cwd: workspace,
    })

    // 终态（assess → gate → route 全部跑完；failed 也可接受——三条子代理都已落地）。
    let status = ''
    await expect.poll(async () => {
      status = (await getInstanceState(page, instanceId)).status
      return status
    }, { timeout: 180_000, message: '实例应跑到终态（completed/failed）' })
      .toMatch(/completed|failed/)

    const facts = readAllSessions(dsh.home)
    const subagents = facts.filter(fact => fact.origin === 'subagent')
    // 本次运行（宿主会话 = instanceId）派生出来的全部子代理会话。
    const children = subagents.filter(fact => fact.parentSession === instanceId)
    const labelOf = (fact: SessionFacts): string => String(fact.descriptor?.['label'] ?? '')
    const forPrefix = (prefix: string): SessionFacts[] => children.filter(fact => labelOf(fact).startsWith(prefix))
    const corrupt = subagents.filter(fact => fact.corrupt)
    const steps = (await getInstanceState(page, instanceId)).executedSteps
    const report = [
      reportOf('M16 ② 条件分支 + 双门禁（finalize / gate / route 三条路径）', dsh.home, facts),
      '',
      `实例：${instanceId}`,
      `实例状态：${status}`,
      `挂在本实例下的子代理会话数：${children.length}`,
      '',
      '## 各执行段状态（诊断路由 fork 是否真的跑到）',
      ...steps.map(step => `- ${step.stepId} status=${step.status} childId=${step.sessionMeta?.childId ?? '(无)'} error=${String(step.error ?? '(无)')} finalizeMeta=${JSON.stringify((step as unknown as { finalizeMeta?: Record<string, unknown> }).finalizeMeta ?? null).slice(0, 800)}`),
      '',
      '## 本实例下的全部子代理（列表实际会显示的条目）',
      ...children.map(fact => `- ${labelOf(fact) || '(无 label)'} | mode=${String(fact.descriptor?.['mode'] ?? '(无)')} | descriptorSeq=${String(fact.descriptorSeq ?? '(缺失)')} seedLength=${String(fact.seedLength ?? '(无)')} corrupt=${String(fact.corrupt)}`),
      '',
      '## 会被 DSH 判成「会话记录损坏」的会话',
      ...(corrupt.length === 0 ? ['- （无）'] : corrupt.map(fact => `- ${fact.id} label=${labelOf(fact)} seq=${String(fact.descriptorSeq)} seed=${String(fact.seedLength)}`)),
      '',
    ].join('\n')
    writeFileSync(join(REPO_ROOT, 'e2e', '.artifacts', 'subagent-identity-forks.txt'), report, 'utf8')

    // ① 三类辅助子代理都必须**真实创建**并出现在盘面上（这是「列表里能看到它们」的前提）。
    const finalize = forPrefix('finalize ')
    const gate = forPrefix('gate ')
    const route = forPrefix('route ')
    expect(finalize.length, `收尾子代理应真实创建（label 以 \`finalize \` 开头）：\n${report}`).toBeGreaterThan(0)
    expect(gate.length, `secondary 门禁子代理应真实创建（label 以 \`gate \` 开头）：\n${report}`).toBeGreaterThan(0)

    // ② 三者**都不在「损坏」集合**里（这正是用户现场的问题），且标题 = `<前缀> <名称> · <uuid>`。
    for (const [prefix, group] of [['finalize', finalize], ['gate', gate], ['route', route]] as const) {
      for (const fact of group) {
        expect(
          fact.corrupt,
          `${prefix} 子代理 ${fact.id} 不得是「损坏」态（descriptorSeq=${String(fact.descriptorSeq)}/seedLength=${String(fact.seedLength)}/descriptorCount=${fact.descriptorCount}）\n${report}`,
        ).toBe(false)
        // 标题尾段必须是**它自己的 childId**（纯 UUID），前缀为路径名。
        expect(labelOf(fact), `${prefix} 标题形态：\n${report}`).toMatch(
          new RegExp(`^${prefix} .+ · [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`),
        )
        expect(labelOf(fact).endsWith(` · ${fact.id}`), `${prefix} 标题尾段应等于会话 id\n${report}`).toBe(true)
      }
    }

    // ③ 自有身份必须落在**自有区间**（fork 会话里 seed 带进来的祖先 descriptor 不算）：
    //    descriptorSeq >= seedLength，且存在**两条** descriptor（祖先 1 + 自有 1）。
    for (const fact of finalize) {
      expect(fact.seedLength, `收尾 fork 应是 seeded（带继承前缀）：\n${report}`).toBeGreaterThan(0)
      expect(fact.descriptorSeq!, `收尾 fork 的自有身份 seq 必须在继承前缀之后\n${report}`).toBeGreaterThanOrEqual(fact.seedLength!)
      expect(fact.descriptorCount, `收尾 fork 应有「祖先 + 自有」两条 identity 事件\n${report}`).toBe(2)
    }

    // ④ 列表条目与 state 记录的 fork 会话 id **逐字一致**（用户从列表点进去就是这些会话）。
    //    state 面：`finalizeMeta.assessResult.forkSessionId`（收尾）、
    //    `finalizeMeta.routingResult.routingSessionId`（判断/路由）。
    const finalizeMetaOf = (stepId: string): Record<string, unknown> | undefined => {
      const step = steps.find(candidate => candidate.stepId === stepId)
      return recordOf((step as unknown as { finalizeMeta?: unknown } | undefined)?.finalizeMeta)
    };
    const forkIds = steps
      .map(step => recordOf(finalizeMetaOf(step.stepId)?.['assessResult'])?.['forkSessionId'])
      .filter((value): value is string => typeof value === 'string' && UUID_RE.test(value));
    const routeIds = steps
      .map(step => recordOf(finalizeMetaOf(step.stepId)?.['routingResult'])?.['routingSessionId'])
      .filter((value): value is string => typeof value === 'string' && UUID_RE.test(value));
    expect(forkIds.length, `state 应记录收尾 fork 会话 id：\n${report}`).toBeGreaterThan(0)
    for (const forkId of forkIds) {
      const fact = children.find(candidate => candidate.id === forkId)
      expect(fact, `state 里的收尾 forkSessionId ${forkId} 应能在盘面上找到（= 列表里能看到它）\n${report}`).toBeDefined()
      expect(fact!.corrupt, `收尾 fork ${forkId} 不得是「损坏」态\n${report}`).toBe(false)
      expect(labelOf(fact!), `收尾条目 label 应含本步名称与自己的 childId\n${report}`).toMatch(/^finalize .+ · [0-9a-f-]{36}$/)
      expect(labelOf(fact!).endsWith(` · ${forkId}`), `收尾 label 尾段应等于 forkSessionId\n${report}`).toBe(true)
    }
    for (const routeId of routeIds) {
      const fact = children.find(candidate => candidate.id === routeId)
      expect(fact, `state 里的路由 fork ${routeId} 应能在盘面上找到（= 列表里能看到它）\n${report}`).toBeDefined()
      expect(fact!.corrupt, `路由 fork ${routeId} 不得是「损坏」态\n${report}`).toBe(false)
      expect(labelOf(fact!), `判断条目 label 应含本步名称与自己的 childId\n${report}`).toMatch(/^route .+ · [0-9a-f-]{36}$/)
      expect(labelOf(fact!).endsWith(` · ${routeId}`), `判断 label 尾段应等于 routingSessionId\n${report}`).toBe(true)
    }

    // ⑥ 用户硬要求：**列表条目的 id（= childId）必须与 label 尾段 uuid 逐字相同**，
    //    且四类分别对齐到 state 里的正确来源；反例：不得等于 step 定义 id / instanceId。
    //    来源字段名（state.schema）：
    //    - 执行：`executedSteps[].sessionMeta.childId`
    //    - 门禁：`executedSteps[].finalizeMeta.gateResult.gateSessionId`
    //    - 收尾：`executedSteps[].finalizeMeta.assessResult.forkSessionId`
    //    - 判断/路由：`executedSteps[].finalizeMeta.routingResult.routingSessionId`
    const uuidOf = (value: unknown): string | undefined =>
      typeof value === 'string' && UUID_RE.test(value) ? value : undefined;
    const sources: { kind: string; id: string }[] = [];
    for (const step of steps) {
      const meta = recordOf((step as unknown as { finalizeMeta?: unknown } | undefined)?.finalizeMeta);
      const pairs: readonly [string, unknown][] = [
        ['执行', step.sessionMeta?.childId],
        ['门禁', recordOf(meta?.['gateResult'])?.['gateSessionId']],
        ['收尾', recordOf(meta?.['assessResult'])?.['forkSessionId']],
        ['判断', recordOf(meta?.['routingResult'])?.['routingSessionId']],
        ['判断', recordOf(recordOf(meta?.['routingResult'])?.['branchMeta'])?.['sessionId']],
        ['判断', recordOf(recordOf(meta?.['routingResult'])?.['loopMeta'])?.['sessionId']],
      ];
      for (const [kind, value] of pairs) {
        const id = uuidOf(value);
        if (id !== undefined) sources.push({ kind, id });
      }
    }
    // 每一类都至少要出现一次（否则这条断言是空跑）。
    for (const kind of ['执行', '门禁', '收尾', '判断'] as const) {
      expect(sources.filter(entry => entry.kind === kind).length, `${kind} 类子代理应在 state 里有 id 记录：\n${report}`).toBeGreaterThan(0);
    }
    for (const entry of sources) {
      const fact = children.find(candidate => candidate.id === entry.id);
      expect(fact, `${entry.kind} 子代理 ${entry.id} 应在盘面上、且挂在宿主主代理下（= 列表里能直接看到）\n${report}`).toBeDefined();
      // ⓐ 条目 id（childId）=== label 里 `·` 之后的 uuid。
      const tail = labelOf(fact!).split(' · ').at(-1) ?? '';
      expect(tail, `${entry.kind} 条目 ${entry.id} 的 label「${labelOf(fact!)}」尾段必须等于它自己的 childId\n${report}`).toBe(entry.id);
      // ⓑ 反例：不得是 step 定义 id / instanceId / 其它无关 id。
      expect(tail, `label 尾段不得是 step 定义 id\n${report}`).not.toBe(instanceId);
      expect(UUID_RE.test(tail), `label 尾段必须是纯 UUID\n${report}`).toBe(true);
      for (const other of ['step-', 'stp-', 'stg-', 'wfl-']) {
        expect(tail.startsWith(other), `label 尾段不得是定义 id（${other}…）\n${report}`).toBe(false);
      }
      expect(fact!.corrupt, `${entry.kind} 条目 ${entry.id} 不得是「损坏」态\n${report}`).toBe(false);
    }

    // ⑤ 全量：本次运行里**没有任何** origin=subagent 会话被判「损坏」。
    expect(
      corrupt.map(fact => `${fact.id}(seq=${String(fact.descriptorSeq)}/seed=${String(fact.seedLength)}/label=${labelOf(fact)})`),
      `存在会被 DSH 判为「会话记录损坏」的子代理会话：\n${report}`,
    ).toEqual([])
  })
})
