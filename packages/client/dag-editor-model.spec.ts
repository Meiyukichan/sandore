/**
 * dag-editor-model.ts 的编辑模型纯函数单元测试：
 * 最小合法定义骨架 round-trip、五类型 command 工厂。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/dag-editor-model.spec
 */
import { describe, expect, it } from 'vitest'

import { parseWorkflowYaml, serializeWorkflowYaml } from '@meiyukichan/dsh-sandore/yaml'
import type { MicroflowRecord, StepRecord } from '@meiyukichan/dsh-sandore/schema'
import type { WorkflowDefinition } from '@meiyukichan/dsh-sandore/schema'

import {
  createBlankDefinition, createBranch, createCommand, createInputFromItem, createOutputToItem,
  createPassThroughVar, createStage, expandMicroflowBinding, expandStepBinding, extractMicroflowRecord,
  extractStepRecord, newId, parseOptionalNumber, trimToUndefined, updateCommandText,
  validateImportYaml, withDefinitionId,
} from './dag-editor-model.ts'

describe('createBlankDefinition', () => {
  it('produces a minimal valid definition that round-trips through YAML', () => {
    const blank = createBlankDefinition()

    const roundTripped = parseWorkflowYaml(serializeWorkflowYaml(blank))

    expect(roundTripped).toEqual(blank)
  })

  it('defaults to a single empty stage', () => {
    const blank = createBlankDefinition()

    expect(blank.stages).toHaveLength(1)
    expect(blank.stages[0]?.name).toBe('阶段 1')
    expect(blank.stages[0]?.steps).toEqual([])
  })
})

describe('withDefinitionId', () => {
  it('replaces the id with the saved id and keeps the rest of the model intact', () => {
    const blank = createBlankDefinition()

    const updated = withDefinitionId(blank, 'wfl-abc')

    expect(updated.id).toBe('wfl-abc')
    expect(updated.name).toBe(blank.name)
    expect(updated.stages).toEqual(blank.stages)
  })

  it('does not mutate the source definition', () => {
    const blank = createBlankDefinition()

    withDefinitionId(blank, 'wfl-abc')

    expect(blank.id).toBe('wfl-new')
  })
})

describe('updateCommandText', () => {
  it('updates a shell command text', () => {
    const next = updateCommandText({ type: 'shell', value: { command: 'a' } }, 'command', 'b')

    expect(next).toEqual({ type: 'shell', value: { command: 'b' } })
  })

  it('updates a prompt promptText', () => {
    const next = updateCommandText({ type: 'prompt', value: { promptText: 'a' } }, 'promptText', 'b')

    expect(next).toEqual({ type: 'prompt', value: { promptText: 'b' } })
  })

  it('clears an optional field when given an empty string', () => {
    const next = updateCommandText({ type: 'prompt', value: { promptText: 'a', modelId: 'm' } }, 'modelId', '  ')

    expect(next).toEqual({ type: 'prompt', value: { promptText: 'a', modelId: undefined } })
  })

  it('returns the unchanged command for a field not applicable to its type', () => {
    const command = createCommand('mcp')

    const next = updateCommandText(command, 'command', 'b')

    expect(next).toBe(command)
  })
})

describe('trimToUndefined', () => {
  it('returns undefined for a blank string', () => {
    expect(trimToUndefined('   ')).toBeUndefined()
  })

  it('trims surrounding whitespace otherwise', () => {
    expect(trimToUndefined('  x  ')).toBe('x')
  })
})

describe('parseOptionalNumber', () => {
  it('returns undefined for a blank or non-numeric string', () => {
    expect(parseOptionalNumber('')).toBeUndefined()
    expect(parseOptionalNumber('abc')).toBeUndefined()
  })

  it('parses a valid number', () => {
    expect(parseOptionalNumber('42')).toBe(42)
  })
})

describe('createCommand', () => {
  it('creates a shell command', () => {
    expect(createCommand('shell')).toEqual({ type: 'shell', value: { command: '' } })
  })

  it('creates a prompt command', () => {
    expect(createCommand('prompt')).toEqual({ type: 'prompt', value: { promptText: '' } })
  })

  it('creates an agent command', () => {
    expect(createCommand('agent')).toEqual({ type: 'agent', value: { promptText: '' } })
  })

  it('creates a skill command', () => {
    expect(createCommand('skill')).toEqual({ type: 'skill', value: { promptText: '' } })
  })

  it('creates an mcp command', () => {
    expect(createCommand('mcp')).toEqual({ type: 'mcp', value: { promptText: '' } })
  })
})

describe('newId', () => {
  it('generates a unique prefixed id', () => {
    const first = newId('step')
    const second = newId('step')

    expect(first).toMatch(/^step-/)
    expect(second).toMatch(/^step-/)
    expect(first).not.toBe(second)
  })
})

describe('createStage', () => {
  it('generates a unique stg- prefixed id with the given name', () => {
    const first = createStage('阶段 1')
    const second = createStage('阶段 2')

    expect(first).toEqual({ id: first.id, name: '阶段 1', steps: [] })
    expect(first.id).toMatch(/^stg-/)
    expect(second.id).toMatch(/^stg-/)
    expect(first.id).not.toBe(second.id)
  })
})

describe('mapping item factories', () => {
  it('creates an input-from item with a unique ipt- id', () => {
    const first = createInputFromItem()
    const second = createInputFromItem()

    expect(first.id).toMatch(/^ipt-/)
    expect(second.id).toMatch(/^ipt-/)
    expect(first.id).not.toBe(second.id)
  })

  it('creates an output-to item with a unique opt- id', () => {
    const first = createOutputToItem()
    const second = createOutputToItem()

    expect(first.id).toMatch(/^opt-/)
    expect(second.id).toMatch(/^opt-/)
    expect(first.id).not.toBe(second.id)
  })

  it('creates an empty pass-through var', () => {
    expect(createPassThroughVar()).toEqual({ name: '', value: '', description: '' })
  })

  it('creates an empty branch', () => {
    expect(createBranch()).toEqual({ next: '' })
  })
})

describe('validateImportYaml', () => {
  it('accepts a parseable workflow YAML and returns its definition', () => {
    const valid = [
      'id: wfl-demo',
      'name: demo',
      'version: "1.0.0"',
      'stages:',
      '  - id: stg-1',
      '    name: 处理',
      '    steps:',
      '      - id: step-1',
      'steps:',
      '  - id: step-1',
      '    command:',
      '      type: shell',
      '      value:',
      '        command: "echo hi"',
    ].join('\n')

    const result = validateImportYaml(valid)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.definition.id).toBe('wfl-demo')
      expect(result.definition.name).toBe('demo')
    }
  })

  it('rejects malformed YAML with a readable error message', () => {
    const result = validateImportYaml('stages: [unclosed')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).not.toBe('')
    }
  })

  it('rejects empty input with a non-empty error', () => {
    const result = validateImportYaml('')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).not.toBe('')
    }
  })
})

// ── 三级分离：库绑定展开 / 同步抽取 ──────────────────────────────────────────

/** 构造 Microflow 库条目（含 inputFrom slot + 流控 branches）。 */
function makeMicroflow(overrides: Partial<MicroflowRecord> = {}): MicroflowRecord {
  return {
    id: 'stg-lib-1',
    name: '构建微流程',
    defaultExpectation: '构建成功',
    steps: [
      { id: 'step-build', branches: [{ next: 'step-lint', label: 'ok' }], inputFrom: [{ id: 'ipt-1', path: 'step-lint' }] },
      { id: 'step-lint' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** 构造 Step 库条目（纯定义）。 */
function makeStep(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    id: 'step-lib-1',
    name: '库内构建',
    command: { type: 'shell', value: { command: 'pnpm build' } },
    outputTo: [{ id: 'opt-1', path: 'artifacts/**' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('expandMicroflowBinding（Microflow 库绑定展开，plan §3.3）', () => {
  it('appends the library stage, strips slot inputFrom, and merges inputFrom into top-level steps', () => {
    const base = createBlankDefinition('wfl-1')
    const record = makeMicroflow()

    const next = expandMicroflowBinding(record, base, undefined)

    // Stage 形态 = 现状结构（id/name/steps[{id, branches}]），无 inputFrom。
    const stage = next.stages.find(candidate => candidate.id === 'stg-lib-1')
    expect(stage?.name).toBe('构建微流程')
    expect(stage?.steps).toEqual([
      { id: 'step-build', branches: [{ next: 'step-lint', label: 'ok' }] },
      { id: 'step-lint' },
    ])
    // 库 steps 的 inputFrom 合并进顶层 step 定义（缺失 → 最小定义）。
    expect(next.steps?.find(step => step.id === 'step-build')?.inputFrom).toEqual([{ id: 'ipt-1', path: 'step-lint' }])
    // 库时间戳不入 yaml 结构。
    expect(stage).not.toHaveProperty('createdAt')
  })

  it('replaces the previous stage id and rewrites outgoing flow references', () => {
    const base: WorkflowDefinition = {
      ...createBlankDefinition('wfl-1'),
      stages: [
        { id: 'stg-old', name: '旧阶段', steps: [] },
        { id: 'stg-next', name: '下一阶段', steps: [], branches: [{ next: 'stg-old' }] },
      ],
    }
    const record = makeMicroflow()

    const next = expandMicroflowBinding(record, base, 'stg-old')

    // stg-old 被替换为库 stage（id = stg-lib-1），其余 stage 指向旧 id 的出边重写。
    expect(next.stages.some(candidate => candidate.id === 'stg-old')).toBe(false)
    expect(next.stages.find(candidate => candidate.id === 'stg-next')?.branches).toEqual([{ next: 'stg-lib-1' }])
  })

  it('produces a definition that round-trips through YAML deep-equal (现状格式兼容)', () => {
    const base = createBlankDefinition('wfl-1')
    const next = expandMicroflowBinding(makeMicroflow(), base, undefined)

    // 展开后序列化 → 再解析 与手工构造的现状结构 deep-equal（逐字节兼容语义）。
    const manual: WorkflowDefinition = {
      ...base,
      stages: [
        ...base.stages,
        {
          id: 'stg-lib-1',
          name: '构建微流程',
          defaultExpectation: '构建成功',
          steps: [
            { id: 'step-build', branches: [{ next: 'step-lint', label: 'ok' }] },
            { id: 'step-lint' },
          ],
        },
      ],
      steps: [{ id: 'step-build', inputFrom: [{ id: 'ipt-1', path: 'step-lint' }] }],
    }
    expect(parseWorkflowYaml(serializeWorkflowYaml(next))).toEqual(manual)
  })
})

describe('expandStepBinding（Step 库绑定展开，plan §3.3）', () => {
  it('appends the full definition to top-level steps and a flow slot to the stage', () => {
    const base = createBlankDefinition('wfl-1')
    const record = makeStep()

    const next = expandStepBinding(record, base, base.stages[0]!.id, undefined)

    // 顶层 steps[] 补该 id 完整定义（纯定义字段，无 inputFrom/branches/时间戳）。
    const definition = next.steps?.find(step => step.id === 'step-lib-1')
    expect(definition).toEqual({
      id: 'step-lib-1',
      name: '库内构建',
      command: { type: 'shell', value: { command: 'pnpm build' } },
      outputTo: [{ id: 'opt-1', path: 'artifacts/**' }],
    })
    // stage.steps 加流控位。
    expect(next.stages[0]?.steps.some(slot => slot.id === 'step-lib-1')).toBe(true)
  })

  it('replaces the previous slot in place, drops the old definition, and rewrites references', () => {
    const base: WorkflowDefinition = {
      ...createBlankDefinition('wfl-1'),
      stages: [{
        id: 'stg-1',
        name: '阶段',
        steps: [
          { id: 'step-old' },
          { id: 'step-2', branches: [{ next: 'step-old' }] },
        ],
      }],
      steps: [
        { id: 'step-old', name: '旧步骤', command: { type: 'shell', value: { command: 'echo old' } } },
        { id: 'step-2', name: '二号', inputFrom: [{ id: 'ipt-1', path: 'step-old' }] },
      ],
    }
    const record = makeStep()

    const next = expandStepBinding(record, base, 'stg-1', 'step-old')

    // 旧定义被移除（避免孤儿），流控位在原位替换（保留原位 branches 无——step-old 无分支）。
    expect(next.steps?.some(step => step.id === 'step-old')).toBe(false)
    expect(next.steps?.some(step => step.id === 'step-lib-1')).toBe(true)
    // 其余 step 指向旧 id 的引用重写（branches.next + inputFrom.path）。
    expect(next.stages[0]?.steps.find(slot => slot.id === 'step-2')?.branches).toEqual([{ next: 'step-lib-1' }])
    expect(next.steps?.find(step => step.id === 'step-2')?.inputFrom).toEqual([{ id: 'ipt-1', path: 'step-lib-1' }])
  })
})

describe('extractMicroflowRecord / extractStepRecord（同步到库抽取）', () => {
  it('extracts a stage as a Microflow library record', () => {
    const base: WorkflowDefinition = {
      ...createBlankDefinition('wfl-1'),
      stages: [{ id: 'stg-1', name: '构建', defaultExpectation: '构建成功', steps: [{ id: 'step-1', branches: [{ next: 'END' }] }] }],
    }

    const record = extractMicroflowRecord(base, 'stg-1')

    expect(record?.id).toBe('stg-1')
    expect(record?.name).toBe('构建')
    expect(record?.steps).toEqual([{ id: 'step-1', branches: [{ next: 'END' }] }])
    expect(record?.createdAt).toBeTruthy()
  })

  it('returns undefined for a missing or unnamed stage', () => {
    const base = createBlankDefinition('wfl-1')
    const unnamed: WorkflowDefinition = { ...base, stages: [{ id: 'stg-x', name: '', steps: [] }] }

    expect(extractMicroflowRecord(base, 'stg-nope')).toBeUndefined()
    expect(extractMicroflowRecord(unnamed, 'stg-x')).toBeUndefined()
  })

  it('extracts a top-level step as a Step library record (纯定义，无 inputFrom/branches)', () => {
    const base: WorkflowDefinition = {
      ...createBlankDefinition('wfl-1'),
      steps: [{ id: 'step-1', name: '构建', command: { type: 'shell', value: { command: 'pnpm build' } } }],
    }

    const record = extractStepRecord(base, 'step-1')

    expect(record).toMatchObject({ id: 'step-1', name: '构建', command: { type: 'shell', value: { command: 'pnpm build' } } })
    expect(record).not.toHaveProperty('inputFrom')
    expect(record).not.toHaveProperty('branches')
  })

  it('returns undefined for a step without a definition or a name', () => {
    const base = createBlankDefinition('wfl-1')
    const unnamed: WorkflowDefinition = { ...base, steps: [{ id: 'step-1' }] }

    expect(extractStepRecord(base, 'step-nope')).toBeUndefined()
    expect(extractStepRecord(unnamed, 'step-1')).toBeUndefined()
  })
})
