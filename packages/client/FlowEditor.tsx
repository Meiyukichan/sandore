/**
 * FlowEditor：Stage/Step 通用流控编辑器（分支是唯一出边单元）。
 *
 * 统一结构：`branches: [{ next, condition?, loop? }]`。
 * - 无 `condition` = 并行分支（始终走）；
 * - 有 `condition` = 条件分支（布尔判定命令，true 才走）；
 * - 有 `loop` = 循环回边分支（该分支 `next` 指向更早节点，`loop` 控制迭代/跳出）。
 * 每条分支独立编辑：目标 + 并行/条件切换 + 判断条件命令 + 循环参数（折叠）。
 * Stage 层不允许循环（回环连线被拒绝，分支不会带 loop）；Stage 层判断条件仅
 * shell/prompt（`conditionTypes` 限定）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/FlowEditor
 */
import { Button, IconPlusOutline16, IconTrashOutline16, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommandConfig, DagBranch } from 'dsh-sandore/schema'

import { CommandEditor } from './CommandEditor.tsx'
import { createCommand, isConditionalBranch, parseOptionalNumber, trimToUndefined, type CommandType, type MergedStep } from './dag-editor-model.ts'
import css from './DagEditor.module.css'

/** 流控目标节点（下拉选项）。 */
export interface FlowTarget {
  readonly id: string
  readonly name: string
}

/** 节点的流控字段集合（出边统一在 branches）。 */
export interface FlowFields {
  readonly branches?: readonly DagBranch[] | undefined
}

/** 折叠小节标题（复用 DagEditor 的样式）。 */
function SectionLabel({ children }: { readonly children: string }) {
  return <div className={css.sectionLabel}>{children}</div>
}

/** 目标节点下拉（分支 next）。 */
function TargetSelect({ value, targets, t, onChange }: {
  readonly value: string
  readonly targets: readonly FlowTarget[]
  readonly t: TranslateNS<'sandore'>
  readonly onChange: (id: string) => void
}) {
  return (
    <select className={css.select} value={value} onChange={event => { onChange(event.target.value) }}>
      <option value="">{t('flow.none')}</option>
      {targets.map(target => (
        <option key={target.id} value={target.id}>{target.name}</option>
      ))}
    </select>
  )
}

/**
 * 渲染 Stage/Step 流控编辑器（分支列表：每条 = 类型下拉 + 只读目标 + 判断条件 + 循环）。
 * 循环由画布回环连线自动产生（loop 必填），详情不做手动添加。
 * @param stageSteps - 当前 Stage 内全部合并 step（含 branches 流控），用于计算回环环上节点。
 * @param currentId - 当前编辑节点 id。
 * @param conditionTypes - 判断条件命令可选类型（缺省 = 全部五类型；Stage 层 shell/prompt）。
 */
export function FlowEditor({ t, flow, targets, onChange, stageSteps, currentId, conditionTypes }: {
  readonly t: TranslateNS<'sandore'>
  readonly flow: FlowFields
  readonly targets: readonly FlowTarget[]
  readonly onChange: (flow: FlowFields) => void
  /** 当前 Stage 内全部合并 step（含 branches）；缺省时不做环上节点过滤。 */
  readonly stageSteps?: readonly MergedStep[] | undefined
  /** 当前编辑节点 id（用于计算回环区间）。 */
  readonly currentId?: string | undefined
  /** 判断条件命令可选类型（缺省 = 全部五类型）。 */
  readonly conditionTypes?: readonly CommandType[] | undefined
}) {
  const branches = flow.branches ?? []

  const setBranch = (index: number, next: DagBranch): void => {
    onChange({ ...flow, branches: branches.map((b, i) => (i === index ? next : b)) })
  }

  /**
   * 计算回环环上节点集合：从回边目标出发沿出边（branches[].next + loop.next）做图搜索，
   * 若可回到当前节点，则**实际参与该回环的节点**（路径成员）都不能作为跳出目标
   * （否则跳出后仍会无限循环）。
   */
  const loopNodesOf = (branch: DagBranch): Set<string> => {
    const current = currentId
    if (stageSteps === undefined || current === undefined) return new Set()
    const back = branch.next
    const outgoing = new Map<string, string[]>()
    for (const step of stageSteps) {
      const targets: string[] = []
      for (const b of step.branches ?? []) {
        if (b.next !== undefined && b.next !== '') targets.push(b.next)
        if (b.loop?.next !== undefined && b.loop.next !== '') targets.push(b.loop.next)
      }
      outgoing.set(step.id, targets)
    }
    // 从回边目标 DFS，记录能到达当前节点的路径成员。
    const onPath = new Set<string>()
    const visited = new Set<string>()
    const dfs = (id: string, path: readonly string[]): boolean => {
      if (id === current) {
        for (const node of path) onPath.add(node)
        return true
      }
      if (visited.has(id)) return false
      visited.add(id)
      let found = false
      for (const next of outgoing.get(id) ?? []) {
        if (dfs(next, [...path, id])) found = true
      }
      return found
    }
    if (back !== undefined && back !== '') {
      dfs(back, [back])
    }
    return onPath
  }

  /** 目标节点名（读 targets 表；未知 id 显示原 id）。 */
  const targetName = (id: string): string => targets.find(target => target.id === id)?.name ?? id

  return (
    <div className={css.flow}>
      <SectionLabel>{t('flow.branches')}</SectionLabel>
      {branches.map((branch, index) => {
        const conditional = isConditionalBranch(branch)
        return (
          <div key={index} className={css.branchRow}>
            <div className={css.branchHead}>
              {/* 分支类型下拉：并行分支 / 条件分支。 */}
              <select
                className={css.branchKindSelect}
                value={conditional ? 'conditional' : 'parallel'}
                onChange={event => {
                  const kind = event.target.value
                  if (kind === 'conditional') {
                    setBranch(index, { ...branch, condition: branch.condition ?? createCommand('shell') })
                  } else {
                    setBranch(index, { ...branch, condition: undefined })
                  }
                }}
              >
                <option value="parallel">{t('flow.parallelBranch')}</option>
                <option value="conditional">{t('flow.conditionalBranch')}</option>
              </select>
              {/* 目标节点：连线产生，只读框展示名称（不提供下拉）。 */}
              <span className={css.branchTarget} title={branch.next === '' ? t('flow.none') : targetName(branch.next)}>
                {branch.next === '' ? t('flow.none') : targetName(branch.next)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                icon={<IconTrashOutline16 />}
                aria-label={t('editor.remove.item')}
                onClick={() => { onChange({ ...flow, branches: branches.filter((_, i) => i !== index) }) }}
              />
            </div>
            {/* 类型说明小字 */}
            <span className={css.branchHint}>
              {conditional ? t('flow.conditionalHint') : t('flow.parallelHint')}
            </span>

            {conditional && (
              <div className={css.command}>
                <SectionLabel>{t('flow.condition')}</SectionLabel>
                <div className={css.conditionCard}>
                  <CommandEditor
                    command={branch.condition!}
                    onChange={condition => { setBranch(index, { ...branch, condition }) }}
                    t={t}
                    types={conditionTypes}
                  />
                </div>
              </div>
            )}

            {branch.loop !== undefined && (
              <div className={css.loop}>
                <SectionLabel>{t('flow.loop')}</SectionLabel>
                <Input
                  type="number"
                  value={String(branch.loop.maxIterations ?? 1)}
                  onChange={event => { setBranch(index, { ...branch, loop: { ...branch.loop!, maxIterations: parseOptionalNumber(event.target.value) ?? 1 } }) }}
                  placeholder={t('editor.field.maxIterations')}
                  aria-label={t('editor.field.maxIterations')}
                />
                <TargetSelect
                  value={branch.loop.next ?? ''}
                  targets={targets}
                  t={t}
                  onChange={next => { setBranch(index, { ...branch, loop: { ...branch.loop!, next: next === '' ? undefined : next } }) }}
                />
                <SectionLabel>{t('editor.field.exitTo')}</SectionLabel>
                <select
                  className={css.select}
                  value={branch.loop.exitTo ?? '__end__'}
                  onChange={event => {
                    const value = event.target.value
                    // END 占位符（__end__）不写入 YAML：存 exitTo: undefined，引擎推进下一 Stage。
                    setBranch(index, { ...branch, loop: { ...branch.loop!, exitTo: value === '__end__' ? undefined : value } })
                  }}
                >
                  <option value="__end__">{t('flow.end')}</option>
                  {/* 跳出目标排除回环环上节点（当前/回边 step 及环间节点），否则跳出后仍会无限循环。 */}
                  {targets.filter(target => !loopNodesOf(branch).has(target.id)).map(target => (
                    <option key={target.id} value={target.id}>{target.name}</option>
                  ))}
                </select>
                <SectionLabel>{t('flow.breakCondition')}</SectionLabel>
                {branch.loop.breakCondition === undefined ? (
                  <Button variant="outline" size="sm" icon={<IconPlusOutline16 />} onClick={() => { setBranch(index, { ...branch, loop: { ...branch.loop!, breakCondition: createCommand('prompt') } }) }}>
                    {t('flow.addCondition')}
                  </Button>
                ) : (
                  <CommandEditor command={branch.loop.breakCondition} onChange={breakCondition => { setBranch(index, { ...branch, loop: { ...branch.loop!, breakCondition } }) }} t={t} />
                )}
              </div>
            )}
          </div>
        )
      })}
      <Button variant="ghost" size="sm" icon={<IconPlusOutline16 />} onClick={() => { onChange({ ...flow, branches: [...branches, { next: '' }] }) }}>
        {t('flow.addBranch')}
      </Button>
    </div>
  )
}
