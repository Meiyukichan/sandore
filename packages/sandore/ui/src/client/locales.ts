/** sandore 工作流 UI 字典。 */

/** 字典命名空间（与包名对应，注册进 LocaleNamespaceMap 以得到类型化 `t`）。 */
export const NS = 'sandore'

/** 简体中文文案。 */
export const zh = {
  'button.trigger': '工作流',
  'button.aria': '工作流',
  'panel.title': '工作流',
  'panel.orchestrate': '编排',
  'panel.add': '新增',
  'panel.list.heading': '工作流列表',
  'panel.state.ready': '就绪',
  'panel.state.running': '运行中',
  'panel.state.completed': '已完成',
  'panel.ping': '验证连接',
  'panel.ping.loading': '往返中…',
  'panel.ping.failed': '往返失败：{message}',
} satisfies Record<string, string>

/** sandore 字典键表。 */
export type SandoreKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** sandore 工作流 UI 文案。 */
    sandore: SandoreKey
  }
}

/** 英文文案（与 zh 逐键对齐，缺一即编译错）。 */
export const en = {
  'button.trigger': 'Workflow',
  'button.aria': 'Workflow',
  'panel.title': 'Workflow',
  'panel.orchestrate': 'Orchestrate',
  'panel.add': 'Add',
  'panel.list.heading': 'Workflows',
  'panel.state.ready': 'Ready',
  'panel.state.running': 'Running',
  'panel.state.completed': 'Done',
  'panel.ping': 'Verify connection',
  'panel.ping.loading': 'Checking…',
  'panel.ping.failed': 'Round trip failed: {message}',
} satisfies Record<SandoreKey, string>
