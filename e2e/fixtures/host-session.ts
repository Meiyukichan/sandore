/**
 * DSH 中心列（conversation column）辅助：把某个会话开在中心列里、读它自己的输入框状态。
 *
 * 为什么单独成文件：M5（暂停入口 = DSH 输入框自带的「停止生成」）与 M7（草稿隔离）都要
 * 「在中心列打开宿主会话」这一步，两处各写一份会漂移（选择器/等待策略必须一致）。
 * @module e2e/fixtures/host-session
 */
import { expect, type Page } from './harness.ts'

/**
 * DSH 中心列自己的输入框状态：取**不在** `[data-sandore-seat-view]` 子树里的
 * `[data-composer-input]`（运行页输入框是独立实现，本就不在 DSH 的锚点体系里）。
 * @param page - 被测页面。
 * @returns 计数 / 是否可编辑 / 文本。
 */
export async function dshColumnComposer(page: Page): Promise<{ count: number; editable: boolean; text: string }> {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[data-composer-input]')]
      .filter(node => node.closest('[data-sandore-seat-view]') === null)
    const first = nodes[0]
    return {
      count: nodes.length,
      editable: first?.getAttribute('contenteditable') === 'true',
      text: first?.textContent ?? '',
    }
  })
}

/**
 * 在 DSH 中心列打开某个会话（按标题文本 = 作业需求搜索）。
 *
 * 为什么走侧栏搜索：树形会话列表按 workspace 分组、需要先展开；搜索框是唯一稳定的
 * 可脚本化入口（输入需求文本 → 结果树里点该会话）。
 * @param page - 被测页面。
 * @param requirement - 会话标题（= 建实例时的 requirement 文本）。
 */
export async function openHostSessionInColumn(page: Page, requirement: string): Promise<void> {
  const searchButton = page.getByRole('button', { name: '搜索会话' }).first()
  await searchButton.click()
  const searchInput = page.locator('input[placeholder*="搜索"]').first()
  await searchInput.fill(requirement)
  const result = page.locator('[role="treeitem"]', { hasText: requirement }).first()
  await expect(result, `侧栏搜索结果里应能找到宿主会话（标题 = 作业需求 ${requirement}）`).toBeVisible({ timeout: 30_000 })
  await result.click()
  await expect.poll(async () => (await dshColumnComposer(page)).count, {
    timeout: 30_000,
    message: 'DSH 中心列应挂载宿主会话的输入框',
  }).toBeGreaterThanOrEqual(1)
}
