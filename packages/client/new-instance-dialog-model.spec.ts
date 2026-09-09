/**
 * new-instance-dialog-model.ts 的纯逻辑单元测试：Modal 关闭守卫（完全访问
 * 确认卡开着时 Escape 不得关闭底层弹窗）+ 权限默认值（full access）。
 *
 * 说明：仓库测试基建为 node 环境（无 jsdom/@testing-library），组件级渲染
 * 断言不可行（primitives barrel 在 node 下还会拉入 katex 的 .css），
 * 这里以纯守卫函数/常量覆盖任务 C/D 的可测决策点；RiskConfirmation 的复用
 * 契约由 typecheck（props 类型对齐 DSH RiskConfirmationProps）保证。
 * 「打开弹窗不弹风险确认卡」在纯逻辑侧的体现：setFullAccessConfirm(true)
 * 的唯一入口是 choosePermission（菜单里重新选择 full access），挂载路径
 * 不触碰它——组件内联，这里钉住默认常量与关闭守卫两处决策。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/new-instance-dialog-model.spec
 */
import { describe, expect, it } from 'vitest'

import { DEFAULT_PERMISSION, dialogCloseAllowed } from './new-instance-dialog-model.ts'

describe('dialogCloseAllowed', () => {
  it('blocks closing while the full-access confirmation card is open', () => {
    expect(dialogCloseAllowed(false, true)).toBe(false)
  })

  it('blocks closing while the instance request is submitting', () => {
    expect(dialogCloseAllowed(true, false)).toBe(false)
  })

  it('allows closing once idle and no confirmation card is open', () => {
    expect(dialogCloseAllowed(false, false)).toBe(true)
    expect(dialogCloseAllowed(true, true)).toBe(false)
  })
})

describe('DEFAULT_PERMISSION', () => {
  it('defaults the permission trigger to full access（任务 D：打开弹窗即 Full access）', () => {
    expect(DEFAULT_PERMISSION).toBe('danger-full-access')
  })
})
