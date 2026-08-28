/**
 * WorkflowPanel 列表派生纯逻辑（无 React 依赖，可单测）。
 *
 * 从 InstanceList / DefinitionList 抽出的共享纯函数：按工作区分组（`deriveGroups`）、
 * 关键词过滤（`matchesInstanceQuery` / `matchesDefinitionQuery`）与时间戳格式化
 * （`formatTimestamp`）。这些函数不触碰组件状态与 RPC，输入输出均为普通数据，
 * 故独立成模块便于单元测试与复用。错误消息归一化见 `describe-error.ts`。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/panel-model
 */
import type { WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { InstanceSummary, WorkflowDefinitionEntry } from 'dsh-sandore/remote'

/** 未分组桶的稳定键（空串，对齐 DSH 的 UNGROUPED_KEY 惯例）。 */
export const UNGROUPED_KEY = ''

/** 一个工作区分组（含成员实例）。 */
export interface InstanceGroup {
  readonly key: string
  readonly title: string
  readonly instances: readonly InstanceSummary[]
}

/** 把 ISO 时间戳格式化为 `YYYY-MM-DD HH:mm`（非法值原样返回）。 */
export function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 关键词过滤实例：大小写不敏感匹配 originalInput 或 workflowId。 */
export function matchesInstanceQuery(instance: InstanceSummary, query: string): boolean {
  if (query === '') return true
  const needle = query.toLowerCase()
  return instance.originalInput.toLowerCase().includes(needle) || instance.workflowId.toLowerCase().includes(needle)
}

/** 关键词过滤定义：大小写不敏感匹配 name 或 id。 */
export function matchesDefinitionQuery(definition: WorkflowDefinitionEntry, query: string): boolean {
  if (query === '') return true
  const needle = query.toLowerCase()
  return definition.name.toLowerCase().includes(needle) || definition.id.toLowerCase().includes(needle)
}

/**
 * 按工作区分组派生：每个工作区一个组（成员命中 `sessionIds`），未命中任何工作区的
 * 实例归「未分组」桶（置末）。空工作区不渲染组头。
 * @param instances - 实例摘要列表。
 * @param workspaces - 工作区成员表（Host 稳定顺序）。
 * @param ungroupedLabel - 未分组桶的本地化标题。
 * @returns 有序分组列表。
 */
export function deriveGroups(
  instances: readonly InstanceSummary[],
  workspaces: readonly WorkspaceView[],
  ungroupedLabel: string,
): readonly InstanceGroup[] {
  const groups: InstanceGroup[] = []
  const assigned = new Set<string>()
  for (const workspace of workspaces) {
    const sessionIds = new Set<string>(workspace.sessionIds)
    const members = instances.filter(instance => sessionIds.has(instance.instanceId))
    if (members.length === 0) continue
    for (const member of members) assigned.add(member.instanceId)
    groups.push({ key: workspace.workspaceId, title: workspace.title, instances: members })
  }
  const ungrouped = instances.filter(instance => !assigned.has(instance.instanceId))
  if (ungrouped.length > 0) {
    groups.push({ key: UNGROUPED_KEY, title: ungroupedLabel, instances: ungrouped })
  }
  return groups
}
