/**
 * M17 · state 字段落地与体积回归（`hostSessionId` 显式化 + `sessionMessages` 去持久化）。
 *
 * ## 背景（用户需求）
 * > 「state 字段要加上主代理会话 id，现在是不是没有？还有 state 里面有些字段现在是冗余的，
 * >  是不是应该去掉，比如 sessionMessages」
 *
 * ## 本用例真机断言（三条）
 * ① `getInstanceState` RPC 仍返回 `executedSteps[].sessionMessages`——**数据来源已换**：
 *    不再从持久化 state 读副本，而是引擎在读取时按需从该段的 step 子代理会话
 *    （`sessionMeta.childId`）经 `collectSessionMessages` 现算（每段尾部 10 条）。
 *    所以断言必须是非空且内容为**本次会话真实产出**（不是空壳、不是残留）。
 * ② state 顶层显式带 `hostSessionId`，且恒等于 `taskId`（旧快照读取回退 `?? taskId`）。
 * ③ 体积对账（由 `e2e/.artifacts/probe-volume.cjs` 读隔离实例 sqlite 完成）：
 *    实测同一实例「移除后 2,536 字节」vs「若仍持久化 sessionMessages 则 5,301 字节」（+109%）。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT, expect, getInstanceState, mockDirective, test } from './fixtures/harness.ts'
import { createMockTwoStepInstance } from './fixtures/mock-run.ts'

test.describe('M17 state 字段落地与体积回归', () => {
  test('sessionMessages 仍可从 RPC 读到（改由会话现算），hostSessionId 显式落地', async ({ page, dsh, workspace }) => {
    test.setTimeout(180_000)

    const instance = await createMockTwoStepInstance(page, {
      firstPromptText: `第一步：输出一句话。${mockDirective({ text: 'm17-step-a-ok' })}`,
      secondPromptText: `第二步：输出一句话。${mockDirective({ text: 'm17-step-b-ok' })}`,
      cwd: workspace,
      label: 'e2e-m17-state',
    })

    await expect
      .poll(async () => (await getInstanceState(page, instance.instanceId)).status, { timeout: 120_000 })
      .toBe('completed')

    const state = await getInstanceState(page, instance.instanceId)
    const segments = state.executedSteps.filter(step => step.sessionMeta?.synthetic === false)
    expect(segments.length).toBe(2)

    // ① RPC 面仍带 sessionMessages（读取期从会话现算；每条 step child 会话都在盘面上）。
    for (const segment of segments) {
      expect(
        segment.sessionMessages?.length ?? 0,
        `step ${segment.stepId} 的 RPC 面应有 sessionMessages（由会话现算）：${JSON.stringify(segment.sessionMessages ?? null)}`,
      ).toBeGreaterThan(0)
      expect(
        (segment.sessionMessages ?? []).some(message => typeof message.text === 'string' && message.text.includes('m17-step')),
        `step ${segment.stepId} 的消息行里应含本次 mock 答复`,
      ).toBe(true)
    }

    // ② hostSessionId 显式存在且等于实例 id（旧快照回退 taskId）。
    const raw = state.raw as { taskId?: string; hostSessionId?: string }
    expect(raw.hostSessionId, `state 应显式带 hostSessionId（实际 ${String(raw.hostSessionId)}）`).toBe(instance.instanceId)
    expect(raw.hostSessionId).toBe(raw.taskId)

    writeFileSync(
      join(REPO_ROOT, 'e2e', '.artifacts', 'm17-state.txt'),
      `# M17 实证\n实例=${instance.instanceId}\nhome=${dsh.home}\nhostSessionId=${String(raw.hostSessionId)}\n各段 sessionMessages 条数=${segments.map(step => String(step.sessionMessages?.length ?? 0)).join(',')}\n`,
      'utf8',
    )
    // 供外部脚本读 sqlite（配合 SANDBORE_E2E_KEEP_HOME=1）。
    console.log(`[m17] home=${dsh.home} instance=${instance.instanceId}`)
  })
})
