/**
 * 库条目引用扫描与摘要的共享纯函数（从 `remote.ts` 私有方法抽出，remote 与
 * `manager-tool.ts`（sandore_workflow 工具）共用，消除两份独立实现静默漂移）。
 *
 * 引用口径（与删除保护一致）：遍历 `definitions` 表全部记录、逐条
 * `parseWorkflowYaml`（坏记录跳过，不阻断统计），`stages[].id` 计入 microflowRefs、
 * `stages[].steps[].id` 与顶层 `steps[].id` 计入 stepRefs——「id 相同即视为引用」
 * （库表 key / yaml 内 id 三边同字符串，不识别内联 vs 展开快照来源）。
 * @module @meiyukichan/dsh-sandore/workflow/src/library-views
 */
import type { WorkflowDefinitionRecord } from './schema.ts'
import type { LibraryEntrySummary } from './wire.ts'
import { parseWorkflowYaml } from './yaml-parser.ts'

/** 库条目引用扫描的最小 definitions 视图（`sandorePersistence.definitions` 结构满足）。 */
export interface DefinitionsView {
  /** 全量键值迭代（key = workflowId）。 */
  entries(): Iterable<[string, WorkflowDefinitionRecord]>
}

/** 库条目引用关系（id → 引用方 workflowId 集合的两张映射）。 */
export interface LibraryReferences {
  /** Step 库（`steps` 表）条目 id → 引用方 workflowId 集合。 */
  readonly stepRefs: Map<string, Set<string>>
  /** Microflow 库（`microflows` 表）条目 id → 引用方 workflowId 集合。 */
  readonly microflowRefs: Map<string, Set<string>>
}

/**
 * 扫描 definitions 表全部记录，收集库条目引用关系（原 `remote.ts`
 * collectLibraryReferences，plan §5：读 YAML 收集 stages/steps id）。单条定义 YAML
 * 解析失败时跳过该记录（健壮性，坏记录不阻断引用统计）。Step 引用 = 顶层
 * `steps[].id` 或任一 `stages[].steps[].id` 命中；Microflow 引用 = 任一
 * `stages[].id` 命中。
 * @param definitions - definitions 表最小视图（entries 迭代）。
 * @returns 库条目 id → 引用方 workflowId 集合的两张映射。
 */
export function collectLibraryReferences(definitions: DefinitionsView): LibraryReferences {
  const stepRefs = new Map<string, Set<string>>()
  const microflowRefs = new Map<string, Set<string>>()
  const addRef = (map: Map<string, Set<string>>, target: string, workflowId: string): void => {
    const owners = map.get(target)
    if (owners !== undefined) owners.add(workflowId)
    else map.set(target, new Set([workflowId]))
  }
  for (const [workflowId, record] of definitions.entries()) {
    let definition
    try {
      definition = parseWorkflowYaml(record.yaml)
    } catch {
      continue
    }
    for (const stage of definition.stages) {
      // 不识别来源：id 相同即视为引用（库表 key / yaml 内 id 三边同字符串）。
      addRef(microflowRefs, stage.id, workflowId)
      for (const step of stage.steps) addRef(stepRefs, step.id, workflowId)
    }
    for (const step of definition.steps ?? []) addRef(stepRefs, step.id, workflowId)
  }
  return { stepRefs, microflowRefs }
}

/**
 * 组装库条目摘要（列表行：名称 / 版本 / 被引用数 / 更新时间；原 `remote.ts`
 * toSummary，`LibraryEntrySummary` 类型沿用 wire）。
 * @param id - 库条目 id。
 * @param record - 库记录（name 必填；version/updatedAt 参与摘要）。
 * @param refs - 对应库的引用映射（{@link LibraryReferences} 的其一）。
 * @returns 列表行摘要（referencedBy = 引用方 workflowId 数）。
 */
export function toLibrarySummary(
  id: string,
  record: { name: string; version?: string | undefined; updatedAt: string },
  refs: Map<string, Set<string>>,
): LibraryEntrySummary {
  return {
    id,
    name: record.name,
    ...(record.version === undefined ? {} : { version: record.version }),
    referencedBy: refs.get(id)?.size ?? 0,
    updatedAt: record.updatedAt,
  }
}
