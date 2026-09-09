/**
 * NewInstanceDialog 的纯逻辑（无 React 依赖，可单测）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/new-instance-dialog-model
 */

/**
 * 权限策略默认值：full access。打开弹窗即选中 full access（触发器显示
 * Full access，且不弹风险确认卡）；仅当用户在菜单里重新选择 full access
 * 时才走 RiskConfirmation（choosePermission 现状逻辑）。
 */
export const DEFAULT_PERMISSION = 'danger-full-access'

/**
 * Modal 关闭守卫：提交中、或完全访问风险确认卡开着时，Escape/遮罩不得关闭
 * 底层弹窗——确认卡（DSH RiskConfirmation）自身是独立 Modal，Escape 只应关
 * 它自己；底层弹窗若同时关闭，用户的确认上下文会整个丢失。
 * @param submitting - 实例创建请求是否在途。
 * @param fullAccessConfirm - 风险确认卡是否开着。
 * @returns true = 允许关闭底层弹窗。
 */
export function dialogCloseAllowed(submitting: boolean, fullAccessConfirm: boolean): boolean {
  return !submitting && !fullAccessConfirm
}
