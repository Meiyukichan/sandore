/**
 * M15 · `## 参考信息` 只注入**直接上游**（v7 真机缺陷复现/回归）。
 *
 * ## 缺陷现场（用户 `test-workflow`）
 * `loop` 的提示词里塞进了 `sce1`、`parallel1`、`sce2`（3 份）、`修复问题`（4 份），而它在流程上
 * **唯一的入边来源是 `sce3`**；用户期望 loop 只拿到 sce3。根因三条（都已修）：
 * 1. 执行步丢 `inputFrom`：`stage.steps` 流控位的 `inputFrom` 没被合并进执行步（只取 branches），
 *    于是"声明了依赖"等于没声明；
 * 2. 未声明时的默认是"注入当前 Stage 所有已执行 step"（旧 `filterPreviousOutputs` 的全量回退）
 *    → 与 DAG 语义无关的一堆输出被整篇塞进去；`sce3` 反而因为走了另一条**条件分支**没执行而缺失；
 * 3. `state.previousOutputs` 每次段完成都 push（loop/重试多段累积）→ `sce2`×3、`修复问题`×4。
 *
 * ## 断言口径（v8，2026-09 全量 e2e 红灯后明确）
 * - **按上游 step 去重**：`filterPreviousOutputs` 以「命中的上游 step」为去重键（不是原始 id）——
 *   因为 `idMatches` 明确允许 `sce3-<后缀>` 这类**循环别名 id**
 *   （`actualId.startsWith(targetId + '-')`），按原始 id 去重会让**同一个上游**的两个别名各注入
 *   一份、块标题还都叫 `前置Step: sce3`（本轮全量跑出现的「得到 2」就是这条；
 *   确定性单测见 `packages/microflow/step-runner.spec.ts` 的「别名 id 只注入一次」）。
 * - **不同上游各一份**：真机 `test-workflow` 的 `loop` 上游 = `{sce3, 修复问题}`（v8 把循环边的
 *   `exitTo` 出口也算上游）→ 那是**两块**，符合新语义，不是重复。
 * - **多段按段计数**：重试/暂停续跑/循环会让同一步骤产生多个执行段，**每段各有一份提示词**
 *   ——本用例原先把所有段的消息拼在一起再数块数，段数 >1 时必然数出 2。故断言**逐段**判定
 *   「每段里同一上游恰好 1 块」，并另加跨段一致性断言（所有块的 id 都属于期望上游集合）。
 *
 * ## 本用例（真机、mock LLM）
 * 用**最小复刻**（保留 `test-workflow` 的拓扑：sce1 → {parallel1, sce3} → loop，loop 无 inputFrom）：
 * - `loop` 的 promptText 带 `[[e2e-mock echo=1]]` → mock 把**收到的 prompt 原样回显**成答复，
 *   答复落进子代理会话 → 经 `getInstanceState().executedSteps[].sessionMessages` 可读；
 * - 断言 loop 的 prompt **含 `前置Step: sce3`（每段恰好一次）**、**不含** sce1/parallel1 的输出；
 * - 取证落盘 `e2e/.artifacts/refinfo-loop.txt`（全量 prompt）与 `refinfo-loop-stats.txt`
 *   （**逐段**的段号/块 id 与出现次数/期望上游集合——定位「2」到底是哪一种）。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT, expect, getInstanceState, test } from './fixtures/harness.ts'
import { ensureDefinition, openSeat, switchListMode, createInstanceFromUi } from './fixtures/harness.ts'

/** 最小复刻：拓扑与真机 `test-workflow` 同形（loop 无 inputFrom，唯一入边 sce3）。 */
const REFINFO_YAML = `id: wfl-e2e-refinfo
name: e2e-refinfo
version: 1.0.0
stages:
  - id: stg-1
    name: demo1
    steps:
      - id: sce1
        branches:
          - next: parallel1
          - next: sce3
      - id: parallel1
      - id: sce3
        branches:
          - next: loop
      - id: loop
steps:
  - id: sce1
    name: sce1
    command:
      type: prompt
      value:
        promptText: "输出 sce1 内容 [[e2e-mock text=SCE1-OUTPUT]]"
  - id: parallel1
    name: parallel1
    command:
      type: prompt
      value:
        promptText: "输出 parallel1 内容 [[e2e-mock text=PARALLEL1-OUTPUT]]"
  - id: sce3
    name: sce3
    command:
      type: prompt
      value:
        promptText: "输出 sce3 内容 [[e2e-mock text=SCE3-OUTPUT]]"
    inputFrom:
      - id: ipt-1
        path: sce1
  - id: loop
    name: loop
    command:
      type: prompt
      value:
        promptText: "输出 loop 内容 [[e2e-mock echo=1]]"
`

/** 该 step 的答复文本（mock `echo=1` 回显的即引擎实际喂进去的 prompt）。 */
function echoedPromptOf(state: Awaited<ReturnType<typeof getInstanceState>>, stepId: string): string {
  const segments = state.executedSteps.filter(step => step.stepId === stepId)
  const texts: string[] = []
  for (const segment of segments) {
    for (const message of segment.sessionMessages ?? []) {
      if (message.type === 'text' && typeof message.text === 'string') texts.push(message.text)
    }
  }
  return texts.join('\n')
}

/** 本用例 fixture 的期望上游集合（`sce1 → {parallel1, sce3} → loop`，loop 未声明 inputFrom）。 */
const EXPECTED_UPSTREAMS: readonly string[] = ['sce3']

/**
 * 逐**执行段**提取该 step 的 prompt + 参考信息块清单（取证用）。
 *
 * 为什么要按段：重试/暂停续跑/循环会给同一步骤产生多个执行段，**每段各有一份提示词**；
 * 把各段消息拼起来再数块数会把「多段」误judged成「同一上游注入了多次」。
 */
function refinfoSegmentsOf(
  state: Awaited<ReturnType<typeof getInstanceState>>,
  stepId: string,
): Array<{
  readonly attemptIndex: number
  /** 该段的身份字段（判断「多段」是重试/续跑还是真重复执行）。 */
  readonly identity: string
  readonly prompt: string
  readonly blocks: ReadonlyArray<{ readonly name: string; readonly id: string }>
  readonly hits: Readonly<Record<string, number>>
}> {
  const rawSegments = (state.raw['executedSteps'] as Array<Record<string, unknown>> | undefined) ?? []
  const segments = rawSegments.filter(segment => segment['stepId'] === stepId)
  return segments.map((segment, index) => {
    const messages = (segment['sessionMessages'] as Array<{ type?: string; text?: string }> | undefined) ?? []
    const prompt = messages
      .filter(message => message.type === 'text' && typeof message.text === 'string')
      .map(message => message.text as string)
      .join('\n')
    // `<Reference title="前置Step: <name> (id: <id>) 的输出和产物">` → 逐块解析 name/id。
    const blocks: Array<{ name: string; id: string }> = []
    const pattern = /<Reference title="前置Step: ([^"(]+?) \(id: ([^)]*)\) 的输出和产物">/gu
    for (const match of prompt.matchAll(pattern)) {
      blocks.push({ name: (match[1] ?? '').trim(), id: (match[2] ?? '').trim() })
    }
    const hits: Record<string, number> = {}
    for (const block of blocks) hits[block.id] = (hits[block.id] ?? 0) + 1
    const identity = [
      `id=${String(segment['id'])}`,
      `status=${String(segment['status'])}`,
      `attemptIndex=${String(segment['attemptIndex'] ?? index)}`,
      `visitCount=${String(segment['visitCount'] ?? '?')}`,
      `childId=${String((segment['sessionMeta'] as { childId?: string } | undefined)?.childId ?? '?')}`,
      `createdAt=${String(segment['createdAt'] ?? '?')}`,
    ].join(' ')
    return { attemptIndex: index, identity, prompt, blocks, hits }
  })
}

test.describe('M15 参考信息只注入直接上游（v7）', () => {
  test('loop 的参考信息只含直接上游 sce3；不含 sce1/parallel1；同一步骤只出现一次', async ({ page, workspace }) => {
    test.setTimeout(180_000)
    await ensureDefinition(page, REFINFO_YAML, 'e2e-refinfo')
    await openSeat(page)
    await switchListMode(page, '实例')
    const instanceId = await createInstanceFromUi(page, {
      workflowName: 'e2e-refinfo',
      requirement: 'e2e-refinfo-req',
      cwd: workspace,
    })

    // 等 loop 那一步真的完成（会话里有回显答复）。
    await expect.poll(async () => echoedPromptOf(await getInstanceState(page, instanceId), 'loop').length, {
      timeout: 120_000,
      message: 'loop step 应有回显的 prompt',
    }).toBeGreaterThan(0)

    const state = await getInstanceState(page, instanceId)
    const prompt = echoedPromptOf(state, 'loop')
    writeFileSync(join(REPO_ROOT, 'e2e', '.artifacts', 'refinfo-loop.txt'), prompt, 'utf8')

    // 逐段取证：段号 / 该段的参考信息块（name + id）/ 每个 id 的出现次数 + 期望上游集合。
    // 这一步是给「同一上游只注入一次」争执定型用的：先看是**同一段内同一上游两块**（去重坏了）
    // 还是**多段各一块**（重试/续跑，属正常）。
    const segments = refinfoSegmentsOf(state, 'loop')
    const expectedUpstreams = EXPECTED_UPSTREAMS.join(',')
    const stats = [
      `loop 执行段数=${segments.length}`,
      `期望上游集合（本 fixture DAG）=${expectedUpstreams}`,
      '',
      ...segments.flatMap(segment => [
        `## 段 #${String(segment.attemptIndex)}`,
        `身份：${segment.identity}`,
        `块数=${segment.blocks.length} 字符数=${segment.prompt.length}`,
        `每个上游 id 出现次数=${JSON.stringify(segment.hits)}`,
        ...segment.blocks.map(block => `  - name=${block.name} id=${block.id}`),
        '',
      ]),
      `跨段合计块数=${segments.reduce((total, segment) => total + segment.blocks.length, 0)}`,
      '',
    ].join('\n')
    writeFileSync(join(REPO_ROOT, 'e2e', '.artifacts', 'refinfo-loop-stats.txt'), stats, 'utf8')

    // ① 直接上游 sce3 必须出现，且**每段里只出现一次**（按上游 step 去重；别名 id 归并）。
    expect(prompt, 'loop 的参考信息应含直接上游 sce3').toContain('前置Step: sce3')
    expect(prompt, 'sce3 的输出应在其中').toContain('SCE3-OUTPUT')
    for (const segment of segments) {
      // 同一段内：每个上游 id 恰好 1 块（多段不在此列——每段一份提示词是设计如此）。
      for (const [id, count] of Object.entries(segment.hits)) {
        expect(count, `段 ${String(segment.attemptIndex)} 里上游 id=${id} 只应注入一次（实际 ${String(count)}）`).toBe(1)
      }
      // 该段里出现的上游 id 必须都属于本 fixture 的期望上游集合（不冒出别的东西）。
      for (const block of segment.blocks) {
        expect(
          EXPECTED_UPSTREAMS.includes(block.id) || EXPECTED_UPSTREAMS.some(upstream => block.id.startsWith(`${upstream}-`)),
          `段 ${String(segment.attemptIndex)} 出现了非期望上游 id=${block.id}（期望 ${expectedUpstreams}，含循环别名 id）`,
        ).toBe(true)
        // 每个块的**名字**也必须是期望上游之一（防止同一步骤的别名 id 各出一块而被误判成两个上游）。
        expect(EXPECTED_UPSTREAMS, `段 ${String(segment.attemptIndex)} 出现了非期望上游 name=${block.name}`)
          .toContain(block.name)
      }
    }
    // 跨段一致性：所有段加起来，**同一逻辑上游（按 name）只应有一个 id**（别名 id 不得同时出现）。
    const idsByName = new Map<string, Set<string>>()
    for (const segment of segments) {
      for (const block of segment.blocks) {
        const ids = idsByName.get(block.name) ?? new Set<string>()
        ids.add(block.id)
        idsByName.set(block.name, ids)
      }
    }
    for (const [name, ids] of idsByName) {
      expect([...ids], `上游 ${name} 出现多个 id（同一步骤的别名未归并）：${JSON.stringify([...ids])}`).toHaveLength(1)
    }

    // ② 非上游 step 一律不得出现（真机缺陷：sce1/parallel1 被整篇塞进来）。
    expect(prompt, 'sce1 不是 loop 的上游，不应出现').not.toContain('前置Step: sce1')
    expect(prompt, 'parallel1 不是 loop 的上游，不应出现').not.toContain('前置Step: parallel1')
    expect(prompt).not.toContain('SCE1-OUTPUT')
    expect(prompt).not.toContain('PARALLEL1-OUTPUT')

    // ③ 参考信息必须保留两个全局块（Step 身份 + 用户原始需求）。
    expect(prompt).toContain('<ReferenceInfo>')
    expect(prompt).toContain('用户原始需求')

    // ④ 声明了 inputFrom 的 sce3 也按声明过滤（它是 sce1 的直接上游：含 sce1，不含 parallel1）。
    const sce3Prompt = echoedPromptOf(state, 'sce3')
    if (sce3Prompt !== '') {
      expect(sce3Prompt).toContain('前置Step: sce1')
      expect(sce3Prompt).not.toContain('前置Step: parallel1')
    }
  })
})
