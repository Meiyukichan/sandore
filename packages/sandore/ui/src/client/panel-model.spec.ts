/**
 * panel-model.ts（列表派生纯函数）的单元测试：按工作区分组（命中归组 / 未命中
 * 归「未分组」/ 多 workspace / 空 workspace）、关键词过滤（命中 / 未命中 / 空 query
 * 全通过）与时间戳格式化。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/panel-model.spec
 */
import type { SessionId, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { InstanceSummary, WorkflowDefinitionEntry } from '@deepseek-ai/dsh-sandore-workflow/remote'
import { describe, expect, it } from 'vitest'

import {
  deriveGroups, formatTimestamp, matchesDefinitionQuery, matchesInstanceQuery, UNGROUPED_KEY,
} from './panel-model.ts'

/** 构造一个最小实例摘要。 */
function instance(id: string, workflowId: string, overrides: Partial<InstanceSummary> = {}): InstanceSummary {
  return {
    instanceId: id,
    workflowId,
    originalInput: `需求 ${id}`,
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** 构造一个最小定义条目。 */
function definition(id: string, overrides: Partial<WorkflowDefinitionEntry> = {}): WorkflowDefinitionEntry {
  return {
    id,
    yaml: `id: ${id}`,
    name: 'workflow',
    version: '1.0.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** 构造一个工作区视图（branded id 字段做字段级收窄）。 */
function workspace(id: string, title: string, sessionIds: readonly string[]): WorkspaceView {
  return {
    workspaceId: id as WorkspaceId,
    path: `/ws/${id}`,
    title,
    sessionIds: sessionIds as SessionId[],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('deriveGroups', () => {
  it('assigns an instance to the workspace whose sessionIds contain its instanceId', () => {
    const workspaces = [workspace('ws-1', 'Alpha', ['inst-a', 'inst-b'])]

    const groups = deriveGroups([instance('inst-a', 'wfl-a'), instance('inst-b', 'wfl-b')], workspaces, '未分组')

    expect(groups).toEqual([
      { key: 'ws-1', title: 'Alpha', instances: [instance('inst-a', 'wfl-a'), instance('inst-b', 'wfl-b')] },
    ])
  })

  it('puts instances matching no workspace into the ungrouped bucket last', () => {
    const workspaces = [workspace('ws-1', 'Alpha', ['inst-a'])]

    const groups = deriveGroups([instance('inst-a', 'wfl-a'), instance('inst-x', 'wfl-x')], workspaces, '未分组')

    expect(groups).toEqual([
      { key: 'ws-1', title: 'Alpha', instances: [instance('inst-a', 'wfl-a')] },
      { key: UNGROUPED_KEY, title: '未分组', instances: [instance('inst-x', 'wfl-x')] },
    ])
  })

  it('produces one group per workspace in host order', () => {
    const workspaces = [
      workspace('ws-1', 'Alpha', ['inst-a']),
      workspace('ws-2', 'Beta', ['inst-b']),
    ]

    const groups = deriveGroups([instance('inst-a', 'wfl-a'), instance('inst-b', 'wfl-b')], workspaces, '未分组')

    expect(groups.map(group => group.key)).toEqual(['ws-1', 'ws-2'])
  })

  it('omits the group header for a workspace with no matching instances', () => {
    const workspaces = [workspace('ws-empty', 'Empty', []), workspace('ws-1', 'Alpha', ['inst-a'])]

    const groups = deriveGroups([instance('inst-a', 'wfl-a')], workspaces, '未分组')

    expect(groups.map(group => group.key)).toEqual(['ws-1'])
  })

  it('returns only the ungrouped bucket when no instance matches any workspace', () => {
    const workspaces = [workspace('ws-1', 'Alpha', ['inst-a'])]

    const groups = deriveGroups([instance('inst-x', 'wfl-x')], workspaces, '未分组')

    expect(groups).toEqual([{ key: UNGROUPED_KEY, title: '未分组', instances: [instance('inst-x', 'wfl-x')] }])
  })

  it('returns an empty list when there are no instances', () => {
    expect(deriveGroups([], [workspace('ws-1', 'Alpha', ['inst-a'])], '未分组')).toEqual([])
  })
})

describe('matchesInstanceQuery', () => {
  it('passes everything through for an empty query', () => {
    expect(matchesInstanceQuery(instance('inst-a', 'wfl-a'), '')).toBe(true)
  })

  it('matches originalInput case-insensitively', () => {
    expect(matchesInstanceQuery(instance('inst-a', 'wfl-a', { originalInput: '整理报告' }), '报告')).toBe(true)
  })

  it('matches workflowId case-insensitively', () => {
    expect(matchesInstanceQuery(instance('inst-a', 'WFL-A'), 'wfl')).toBe(true)
  })

  it('returns false when neither field matches', () => {
    expect(matchesInstanceQuery(instance('inst-a', 'wfl-a'), 'nomatch')).toBe(false)
  })
})

describe('matchesDefinitionQuery', () => {
  it('passes everything through for an empty query', () => {
    expect(matchesDefinitionQuery(definition('wfl-1', { name: 'deploy' }), '')).toBe(true)
  })

  it('matches name case-insensitively', () => {
    expect(matchesDefinitionQuery(definition('wfl-1', { name: 'Deploy' }), 'deploy')).toBe(true)
  })

  it('matches id case-insensitively', () => {
    expect(matchesDefinitionQuery(definition('WFL-1', { name: 'deploy' }), 'wfl')).toBe(true)
  })

  it('returns false when neither field matches', () => {
    expect(matchesDefinitionQuery(definition('wfl-1', { name: 'deploy' }), 'nomatch')).toBe(false)
  })
})

describe('formatTimestamp', () => {
  it('formats an ISO timestamp as YYYY-MM-DD HH:mm', () => {
    // 无时区后缀的 ISO 串按本地时间解析，断言不依赖运行环境的时区偏移。
    expect(formatTimestamp('2026-01-02T03:04:05.000')).toBe('2026-01-02 03:04')
  })

  it('returns the original value for an invalid timestamp', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date')
  })
})
