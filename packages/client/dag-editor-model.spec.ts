/**
 * dag-editor-model.ts 的编辑模型纯函数单元测试：
 * 最小合法定义骨架 round-trip、五类型 command 工厂。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/dag-editor-model.spec
 */
import { describe, expect, it } from 'vitest'

import { parseWorkflowYaml, serializeWorkflowYaml } from '../workflow/yaml-parser'

import {
  createBlankDefinition, createBranch, createCommand, createInputFromItem, createOutputToItem,
  createPassThroughVar, createStage, newId, parseOptionalNumber, trimToUndefined, updateCommandText, withDefinitionId,
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
