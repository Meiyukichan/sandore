/**
 * F 层用例 · 阶段 1：页面加载 / 侧栏席位 / 定义列表 / YAML 导入。
 *
 * F 层定义：**无 LLM**（纯 shell 步 / 纯 UI），全绿、秒级～十几秒。
 * 前置：隔离 3090 实例由 `dsh` fixture 拉起（见 fixtures/harness.ts）。
 */
import { ensureDefinition, expect, openSeat, switchListMode, sandoreRpc, test } from './fixtures/harness.ts'
import { FAST_WORKFLOW_NAME, FAST_WORKFLOW_YAML } from './fixtures/workflows.ts'

test.describe('F1 页面与定义', () => {
  test('① 页面无 console error 加载，侧栏席位入口可见', async ({ page, problems }) => {
    // 首屏水合已经完成到「侧栏入口可见」（page fixture 的就绪信号）。
    await expect(page.locator('[data-sandore-seat-entry]').first()).toBeVisible()
    // 页面确实渲染出了 DSH 壳（不是白屏 / 不是 401 页面）。
    const body = await page.locator('body').innerText()
    expect(body.length).toBeGreaterThan(0)
    // 401 页面的特征是只有一行鉴权文案；出现席位入口即已登录成功。
    expect(problems, `页面报错：\n${problems.join('\n')}`).toEqual([])
  })

  test('② 点击侧栏入口打开工作流席位视图', async ({ page, problems }) => {
    await openSeat(page)
    const seat = page.locator('[data-sandore-seat-view]').first()
    await expect(seat).toBeVisible()
    // 席内两模式 tab 存在；幂等再打开一次不应把视图切回去。
    await expect(page.locator('[data-sandore-wf-list] [role="tab"]', { hasText: '实例' }).first()).toBeVisible()
    await expect(page.locator('[data-sandore-wf-list] [role="tab"]', { hasText: '编排' }).first()).toBeVisible()
    await openSeat(page)
    await expect(seat).toBeVisible()
    expect(problems, `页面报错：\n${problems.join('\n')}`).toEqual([])
  })

  test('④ YAML 导入成功提示（UI 真实路径）', async ({ page }) => {
    await openSeat(page)
    await switchListMode(page, '编排')

    // 「新增工作流」→ DagEditor → 「导入」按钮 → 弹窗粘贴 YAML → 「导入」。
    await page.locator('[data-sandore-wf-list] button', { hasText: '新增工作流' }).first().click()
    const editor = page.locator('[data-sandore-dag-editor]').first()
    await expect(editor).toBeVisible({ timeout: 20_000 })
    await editor.locator('button', { hasText: '导入' }).first().click()

    const importDialog = page.locator('[role="dialog"]').filter({ hasText: '导入工作流定义' }).first()
    await expect(importDialog).toBeVisible()
    await importDialog.locator('textarea[placeholder*="粘贴"]').first().fill(FAST_WORKFLOW_YAML)

    // 成功提示是顶部 Toast（自动消失）——先挂监听再点，避免与动画抢时序。
    const toast = page.getByText(/已导入「/)
    const toastSeen = toast.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false)
    const importResponse = page.waitForResponse(
      response => response.url().includes('/api/sandore/importDefinitionFromYaml') && response.request().method() === 'POST',
      { timeout: 20_000 },
    )
    await importDialog.locator('button', { hasText: /^导入$/ }).last().click()

    // ① RPC 确实经 UI 发起且返回成功（帧格式：{type,rpcId,result:{ok,value}}）。
    const frame = await (await importResponse).json() as {
      result?: { ok?: boolean; value?: { status?: string; name?: string } }
    }
    expect(frame.result?.ok).not.toBe(false)
    expect(['created', 'updated', 'skipped']).toContain(frame.result?.value?.status)
    expect(frame.result?.value?.name).toBe(FAST_WORKFLOW_NAME)

    // ② 弹窗关闭 + 成功 Toast 出现（文案：已导入「<name>」（新建/更新/同版本已存在，跳过））。
    await expect(importDialog).toBeHidden({ timeout: 20_000 })
    expect(await toastSeen, '导入成功 Toast 应出现').toBe(true)

    // ③ 导入结果落库：定义列表出现该名称。
    await expect(page.locator('[data-sandore-wf-list]').getByText(FAST_WORKFLOW_NAME, { exact: true }))
      .toBeVisible({ timeout: 20_000 })
  })

  test('③ 定义列表渲染（名称 + 版本）', async ({ page, problems }) => {
    await openSeat(page)
    await switchListMode(page, '编排')
    const list = page.locator('[data-sandore-wf-list]').first()
    await expect(list).toBeVisible()
    // 前置：RPC 幂等确保定义存在（顺序无关；UI 导入路径已由 ④ 单独覆盖）。
    const definition = await ensureDefinition(page, FAST_WORKFLOW_YAML, FAST_WORKFLOW_NAME)
    expect(definition.version).toBe('1.0.0')

    // 列表项按 name 渲染，caption 形如 `v1.0.0 · <时间>`。
    await expect(list.getByText(FAST_WORKFLOW_NAME, { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(list.getByText(/^v1\.0\.0/).first()).toBeVisible()
    expect(problems, `页面报错：\n${problems.join('\n')}`).toEqual([])
  })

  test('⑤ 实例列表可见（空态或实例行二者之一，与 RPC 对账一致）', async ({ page }) => {
    await openSeat(page)
    await switchListMode(page, '实例')
    const list = page.locator('[data-sandore-wf-list]').first()
    // 「运行工作流」按钮是实例模式的稳定锚点。
    await expect(list.locator('button', { hasText: '运行工作流' }).first()).toBeVisible()

    const instances = await sandoreRpc<unknown[]>(page, 'listInstances', {})
    expect(Array.isArray(instances), `listInstances 应返回数组：${JSON.stringify(instances).slice(0, 200)}`).toBe(true)
    if (instances.length === 0) {
      // 空态：明确的空列表文案（不允许一直停在「加载中…」）。
      await expect(list.getByText('暂无工作流实例')).toBeVisible({ timeout: 20_000 })
    } else {
      await expect(list.locator('li').first()).toBeVisible({ timeout: 20_000 })
    }
  })
})
