import { describe, expect, it } from 'vitest'
import { isConditionalBranch, stageFlowEdges } from './dag-editor-model.ts'

describe('isConditionalBranch（有 condition = 条件分支）', () => {
  it('无 condition = 并行分支', () => {
    expect(isConditionalBranch({ next: 'b' })).toBe(false)
  })
  it('有 loop 无 condition = 循环回边分支（仍非条件）', () => {
    expect(isConditionalBranch({ next: 'a', loop: { maxIterations: 2, next: 'a' } })).toBe(false)
  })
  it('有 condition = 条件分支', () => {
    expect(isConditionalBranch({ next: 'b', condition: { type: 'prompt', value: { promptText: 'route' } } })).toBe(true)
  })
})

describe('stageFlowEdges 边种类', () => {
  it('无 condition 的 branch 渲染为 parallel（实线）', () => {
    const edges = stageFlowEdges([{
      id: 'a', name: 'A', steps: [],
      branches: [{ next: 'b' }],
    }])
    expect(edges).toHaveLength(1)
    expect(edges[0].kind).toBe('parallel')
    expect(edges[0].label).toBeUndefined()
  })
  it('有 condition 的 branch 渲染为 conditional（虚线+标签）', () => {
    const edges = stageFlowEdges([{
      id: 'a', name: 'A', steps: [],
      branches: [{ next: 'b', condition: { type: 'prompt', value: { promptText: 'route' } }, label: '修复分支' }],
    }])
    expect(edges[0].kind).toBe('conditional')
    expect(edges[0].label).toBe('修复分支')
  })
})
